import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, Res, UploadedFile, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { AnyFilesInterceptor, FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { Type } from "class-transformer";
import type { Response } from "express";
import { IsArray, IsDateString, IsDecimal, IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateNested } from "class-validator";
import { CurrentUser } from "../../platform/audit/current-user.decorator";
import type { CurrentUser as CurrentUserType } from "../../platform/auth/auth.service";
import { AuthenticationGuard } from "../../platform/authorization/authentication.guard";
import { ModulePermissionGuard } from "../../platform/authorization/module-permission.guard";
import { RequireModules } from "../../platform/authorization/require-modules.decorator";
import { PaginationQueryDto } from "../../platform/http/pagination-query.dto";
import { EmptyStringToNull } from "../../platform/http/empty-string-to-null.decorator";
import { EmptyStringToUndefined } from "../../platform/http/empty-string-to-undefined.decorator";
import { MULTER_DOCUMENT_FILE_SIZE_LIMIT } from "../../platform/http/upload-limits";
import { SalesOrdersService, MATERIAL_EXTRA_CONTENT_MAX_LENGTH, MATERIAL_EXTRA_LABEL_MAX_LENGTH, MATERIAL_EXTRA_LIMIT, MAX_ROW_IMAGES, SPEC_MATERIAL_KEYS } from "./sales-orders.service";
// 行图片与物料图片共用同一个字节上限与同一个校验器（2026-11-04）：multer 层先按它拦，服务层再解容器核对。
import { MAX_MATERIAL_IMAGE_BYTES } from "../procurement/material-image";
import { SalesOrderExportService } from "./sales-order-export.service";
import { SalesOrderImportService } from "./sales-order-import.service";
import { FinishedGoodsOutboundNoticeService } from "./finished-goods-outbound-notice.service";
import { ITEM_NO_MAX_LENGTH } from "./item-no";

/** 金额类字段的非负校验：class-validator 的 @Min 对字符串不生效（会直接判不通过），这里用十进制正则。 */
const NON_NEGATIVE_DECIMAL = /^\d+(?:\.\d+)?$/;

/**
 * 工艺单导出 multipart 的 `files` 上限：18 个固定栏位 + 「其它」行上限 + **明细行图片 200**（2026-11-04）。
 *
 * 明细行（5 种伞布 / 11 种伞头那种）现在也能在图里出图，所以「能勾的格子数」不再只是 18 + 20。
 * 200 是一个**防呆上限**而不是业务上限（工艺单是一张 A4 纸，明细行再多也印不下）：
 * 真正的闸门仍是下游的单张 2MB + 合计 12MB；这里只是别让 multer 用 `LIMIT_FILE_COUNT`
 * 报一个用户看不懂的错误。
 *
 * 2026-11-05 起每个位置最多 3 张（导出的候选是**每张图一条**，字段名 `spec_key#2`/`#3`），
 * 所以 18 格与「其它」行那两段要各 × 3：不加的话「18 格全填满 3 张」这种正常请求会先被
 * multer 挡下，用户看到的是一个与图片大小无关的「文件数量太多」。
 */
const PRODUCTION_SHEET_IMAGE_FILE_LIMIT = (SPEC_MATERIAL_KEYS.length + MATERIAL_EXTRA_LIMIT) * MAX_ROW_IMAGES + 200;

/**
 * 行图片的外圈白名单（与 `procurement` 的物料图片同一条）：只放行 `.webp` / `image/webp`。
 *
 * 前端 canvas 一定产出 `image/webp`，所以这两种写法就够了。真正的判据是服务层的
 * `validateMaterialImage`（解开 RIFF 容器读真实尺寸）—— 名字与 Content-Type 都是客户端说了算的，
 * 这一层只负责把「明显不是图片的 PDF/Excel」挡在解析之前。
 */
function salesOrderImageFileFilter(_req: Express.Request, file: Express.Multer.File, callback: (error: Error | null, acceptFile: boolean) => void) {
  const name = (file.originalname ?? "").toLowerCase();
  callback(null, name.endsWith(".webp") || file.mimetype === "image/webp");
}

/**
 * `If-None-Match` 的弱比较：`*`、`W/"sha"`、逗号分隔的列表都认。
 *
 * 不引第三方包：这里只比一个我们自己发的 ETag（`"<sha256>"`），多一条依赖不值得；
 * `*` 与弱标签这两种写法是 HTTP 规范里客户端真的会发的（浏览器刷新、代理各有一种）。
 */
function ifNoneMatchHit(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  for (const raw of header.split(",")) {
    const candidate = raw.trim();
    if (!candidate) continue;
    if (candidate === "*") return true;
    if (candidate.replace(/^W\//, "") === etag) return true;
  }
  return false;
}

/** 结算方式固定枚举（前端下拉同源展示中文）。 */
export const SETTLEMENT_METHODS = ["tt", "letter_of_credit", "cash", "monthly", "other"] as const;

/** 与「物料导入 / 盘点导入 / 其他应付导入」同一套白名单：只放行 Excel。 */
const EXCEL_MIME = new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel"]);
function salesOrderImportFileFilter(_req: Express.Request, file: Express.Multer.File, callback: (error: Error | null, acceptFile: boolean) => void) {
  const name = (file.originalname ?? "").toLowerCase();
  const extensionOk = name.endsWith(".xlsx") || name.endsWith(".xls");
  callback(null, extensionOk || (EXCEL_MIME.has(file.mimetype) && file.mimetype !== "application/octet-stream"));
}

/** 细分明细行（一张通用表 + 分组名）。 */
class SpecDetailDto {
  @IsNotEmpty() @EmptyStringToUndefined() @IsString() @MaxLength(100) group_name!: string;
  @IsNotEmpty() @EmptyStringToUndefined() @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(100) color?: string;
  @IsOptional() @IsString() @MaxLength(100) barcode?: string;
  // 数量留空时前端可能提交 "null"/""：先归一成 undefined，否则 @IsOptional() 不跳过空串 → 400。
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "明细数量必须是不小于 0 的十进制数" }) @IsDecimal() quantity?: string;
  @IsOptional() @IsString() @MaxLength(30) unit?: string;
  @IsOptional() @IsInt() sort_order?: number;
  /**
   * 这一行自己的图（2026-11-04 每行一张 → 2026-11-05 每行最多 3 张，`sales_order_images.id`）：
   * 伞布明细 / 伞头配色每行最多 3 张，顺序 = 用户看到的顺序。
   * 可省略 = 这一行没有图（绝大多数历史行都是）；`[]` 与省略同义。
   *
   * 上限**故意不在这里判**（`@ArrayMaxSize`）：「超过 3 张」要回 422 `SALES_ORDER_IMAGE_LIMIT`
   * 并说清是哪一行，DTO 拦下来只会变成一句看不出哪行的 400（见服务层 `normalizeRowImageIds`）。
   * 这里只做形状校验：必须是 UUID 数组，否则一个乱写的 id 会拖到落库时才以外键错误出现。
   */
  @IsOptional() @IsArray() @IsUUID(undefined, { each: true }) image_ids?: string[];
  /** 旧形状（2026-11-04，一行一张）：等同 `image_ids: [id]`；两者同时出现时 `image_ids` 优先。 */
  @IsOptional() @IsUUID() image_id?: string;
}

/**
 * 一格材料明细对某个物料的引用。
 *
 * `spec_key` 只限「材料明细」那 18 个栏位，具体判定在服务层（`SPEC_MATERIAL_KEYS`）——
 * DTO 里只做长度与形状校验，因为「哪些栏位允许引用」是**业务清单**说了算的，
 * 把它抄成 18 个 `@IsIn` 只是一份会过期的副本。
 *
 * 声明在 `SalesOrderSpecDto` **之前**：`@Type(() => MaterialRefDto)` 虽然是惰性求值，
 * 但把被引用的类放在引用它的类之前，读的人不必去想「这个装饰器什么时候求值」。
 */
export class MaterialRefDto {
  @IsNotEmpty() @EmptyStringToUndefined() @IsString() @MaxLength(50) spec_key!: string;
  @IsUUID() material_id!: string;
}

/**
 * 「材料明细 → 其它」的一行（用户 2026-10-08：「材料明细最后还需要加一个『其它』，可以自行添加类目。
 * 有时候还需要别的物料。允许用户增删改」）。
 *
 * 这里只做形状与长度校验；「类目必填、内容与引用至少要有一个、最多几行」由服务层的
 * `normalizeMaterialExtras` 判 —— 与 `material_refs` 的 `spec_key` 同一条理由：
 * 「几条算多」是业务口径，抄进 DTO 就是一份会过期的副本（长度上限从服务层 import，不抄数字）。
 *
 * `content` 空串与省略是一回事（那一行只有引用）：与 37 个细化标量的「空串 = 清除这一格」不同 ——
 * 那些是整单固定的 37 格，逐格清空必须表达得出来；而「其它」是**整块数组**（整块替换），
 * 数组本身就是全量，没有"单独清一格"这回事。
 *
 * 与 `MaterialRefDto` 同样声明在 `SalesOrderSpecDto` **之前**（`@Type` 惰性求值，但读的人不必去想）。
 */
export class MaterialExtraDto {
  // 2026-10-29「同类目再加一款」：带 `spec_key` 时类目名由服务端按类目键填，`label` 可以不传；
  // 不带 `spec_key` 的原有「其它」行仍然必须写类目名（服务层 `normalizeMaterialExtras` 会拒）。
  @IsOptional() @EmptyStringToUndefined() @IsString() @MaxLength(MATERIAL_EXTRA_LABEL_MAX_LENGTH) label?: string;
  @IsOptional() @IsString() @MaxLength(MATERIAL_EXTRA_CONTENT_MAX_LENGTH) content?: string;
  @IsOptional() @IsUUID() material_id?: string;
  /**
   * 所属固定类目（18 个材料栏位之一的键）。只做形状与取值域校验：
   * 「类目名不采用请求里的字」那条规则在服务层，改不到这里。
   */
  @IsOptional() @IsString() @IsIn([...SPEC_MATERIAL_KEYS]) spec_key?: string;
  @IsOptional() @IsInt() sort_order?: number;
  /**
   * 这一行自己挂的图（2026-11-04 一张 → 2026-11-05 最多 3 张，`sales_order_images.id`）：
   * 「再加一款」/「其它」行自己的图；有引用物料时**优先用这几张**，没有才回退物料清单那张。
   * 上限同样在服务层判（422 `SALES_ORDER_IMAGE_LIMIT`），DTO 只保证形状。
   */
  @IsOptional() @IsArray() @IsUUID(undefined, { each: true }) image_ids?: string[];
  /** 旧形状（2026-11-04，一行一张）：等同 `image_ids: [id]`；两者同时出现时 `image_ids` 优先。 */
  @IsOptional() @IsUUID() image_id?: string;
}

/**
 * 「18 个材料格各自的图」的一条映射（2026-11-04，`sales_order_slot_images`）。
 *
 * 那 18 格是 `sales_orders` 上的标量列、没有行可挂外键，所以单独一张映射表按格存图。
 * 2026-11-05 起**一格最多 3 张**：`image_ids` 是按用户看到顺序排的数组，落库按
 * `(spec_key, slot_index)` 逐张对齐。`image_id` 是旧形状（一格一张）。
 * 这里只做形状校验；「哪 18 个栏位能挂图」由服务层 `normalizeSlotImages` 判
 * （与 `MaterialRefDto` 的 `spec_key` 同一条理由：业务清单不抄进 DTO）。
 */
export class SlotImageDto {
  @IsNotEmpty() @EmptyStringToUndefined() @IsString() @MaxLength(50) spec_key!: string;
  /** 这一格最多 3 张图（上限与 `details` 在服务层，理由见 `normalizeRowImageIds`）。 */
  @IsOptional() @IsArray() @IsUUID(undefined, { each: true }) image_ids?: string[];
  /** 旧形状（一格一张）：等同 `image_ids: [id]`；两者同时出现时 `image_ids` 优先。 */
  @IsOptional() @IsUUID() image_id?: string;
}

/**
 * 下单口径细化的固定字段（2026-09-16，按 example/销售单 的工艺单模板，两样本并集）。
 *
 * 抽成基类是因为创建与更新两边**这 37 个字段完全一样**（都是可选），抄两遍必然漏一处。
 * 这里**故意不加 `EmptyStringToUndefined`**：空串的语义是「清除这一格」（服务层的 `specScalars`
 * 把 "" 落成 NULL），而 `EmptyStringToUndefined` 会把它变成 undefined 也就是「不动」——
 * 两者写反的后果正好相反（「删了没保存上」 vs 「只改一格结果把别的清空了」）。
 *
 * ⚠️ 但**数值列（5 个布量）必须显式加 `EmptyStringToNull`**，否则「清除这一格」根本走不到服务层：
 * 文本列的 `@IsString()` 放行空串，而 `@IsOptional()` 只跳过 null/undefined，`""` 会走到
 * `@Matches` / `@IsDecimal` 上被判成「不是合法小数」→ 新建销售单必然 400。
 * 前端 `specPayload` 是**把 37 个键全带上**的（不带就永远清不掉一格），所以布量留空 = 每次必踩。
 * `EmptyStringToNull` 把空串变成 `null`：校验能过（`@IsOptional()` 跳过 null），
 * 服务层 `specScalars` 把 null 原样落库 —— 与文本列的空串**同一个语义**（清除），不是「不动」。
 */
export class SalesOrderSpecDto {
  // 表头补充
  @IsOptional() @IsString() @MaxLength(100) factory?: string;
  @IsOptional() @IsString() @MaxLength(100) completion_remark?: string;
  @IsOptional() @IsString() @MaxLength(2000) attention_note?: string;
  @IsOptional() @IsString() @MaxLength(2000) shipping_mark_front?: string;
  @IsOptional() @IsString() @MaxLength(2000) shipping_mark_side?: string;
  // 布量（伞面 / 伞带 / 木耳 / 天布 / 布套）
  // 这 5 个是上面 37 格里**仅有的数值格**，空串必须先归一成 null 才能过校验（见类注释）。
  @IsOptional() @EmptyStringToNull() @Matches(NON_NEGATIVE_DECIMAL, { message: "布量必须是不小于 0 的十进制数" }) @IsDecimal() fabric_usage_canopy?: string | null;
  @IsOptional() @EmptyStringToNull() @Matches(NON_NEGATIVE_DECIMAL, { message: "布量必须是不小于 0 的十进制数" }) @IsDecimal() fabric_usage_strap?: string | null;
  @IsOptional() @EmptyStringToNull() @Matches(NON_NEGATIVE_DECIMAL, { message: "布量必须是不小于 0 的十进制数" }) @IsDecimal() fabric_usage_wood_ear?: string | null;
  @IsOptional() @EmptyStringToNull() @Matches(NON_NEGATIVE_DECIMAL, { message: "布量必须是不小于 0 的十进制数" }) @IsDecimal() fabric_usage_top?: string | null;
  @IsOptional() @EmptyStringToNull() @Matches(NON_NEGATIVE_DECIMAL, { message: "布量必须是不小于 0 的十进制数" }) @IsDecimal() fabric_usage_bag?: string | null;
  // 材料明细（两样本并集 18 项）
  @IsOptional() @IsString() @MaxLength(1000) rib_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) canopy_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) handle_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) handle_strap_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) tail_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) runner_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) strap_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) strap_fastener_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) inner_label_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) woven_label_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) hang_tag_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) opp_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) bag_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) packaging_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) top_fabric_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) wood_ear_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) keychain_spec?: string;
  @IsOptional() @IsString() @MaxLength(1000) printing_spec?: string;
  // 工艺要求（两样本并集 9 项）
  @IsOptional() @IsString() @MaxLength(1000) sample_requirement?: string;
  @IsOptional() @IsString() @MaxLength(1000) cutting_requirement?: string;
  @IsOptional() @IsString() @MaxLength(1000) edge_requirement?: string;
  @IsOptional() @IsString() @MaxLength(1000) joining_requirement?: string;
  @IsOptional() @IsString() @MaxLength(1000) top_stitch_requirement?: string;
  @IsOptional() @IsString() @MaxLength(1000) sewing_requirement?: string;
  @IsOptional() @IsString() @MaxLength(1000) strap_requirement?: string;
  @IsOptional() @IsString() @MaxLength(1000) hang_tag_note?: string;
  @IsOptional() @IsString() @MaxLength(1000) qc_requirement?: string;
  /** 细分明细：传了就整块替换（空数组 = 清空），没传 = 不动。 */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SpecDetailDto) spec_details?: SpecDetailDto[];
  /**
   * 材料明细的物料引用（用户 2026-09-24：「每个部件，既支持填空，也支持从现有的物料清单中引用」）：
   * 传了就整块替换（空数组 = 全部取消引用），没传 = 不动。
   */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => MaterialRefDto) material_refs?: MaterialRefDto[];
  /**
   * 「材料明细」末尾的「其它」行（用户 2026-10-08）：用户自己起的类目 + 内容（可挂一个物料引用）。
   * 传了就整块替换（空数组 = 全部删掉），没传 = 不动 —— 与 `spec_details` / `material_refs` 同一语义。
   */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => MaterialExtraDto) material_extras?: MaterialExtraDto[];
  /**
   * 18 个材料格各自的图（2026-11-04）：传了就整块替换（`[]` = 把 18 格的图全清掉），没传 = 不动。
   * 与 `material_refs` / `material_extras` 同一语义；`spec_key` 的键域校验在服务层。
   */
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SlotImageDto) slot_images?: SlotImageDto[];
  /**
   * 细分明细的自定义列名（用户 2026-09-30：「细分明细那边，可以改成自定义字段名称」）：
   * `{ 列键: 列名 }`，键只能是 6 个明细列（`SPEC_DETAIL_LABELS`），空串 = 这一列用默认名。
   *
   * 这里只验"是个对象"（`@IsObject`）：**键与值长度由服务层的
   * `normalizeSpecDetailLabels` 判**，因为「哪 6 个列」是业务清单说了算的，
   * 抄进 DTO 就是一份会过期的副本（与 `material_refs` 的 `spec_key` 同一条理由）。
   * 传了就是**整块替换**（空对象 = 全部恢复默认列名）——"恢复默认"必须表达得出来。
   */
  @IsOptional() @IsObject() spec_detail_labels?: Record<string, string>;
}

// 导出以便契约测试直接用真实 ValidationPipe 校验前端请求体。
export class SalesOrderDto extends SalesOrderSpecDto {
  // 必填字段先归一空串再校验："" / "   " 会变成 undefined，被 @IsNotEmpty() 拦下（旧行为会写入空订单号/空币种）。
  @IsNotEmpty() @EmptyStringToUndefined() @IsString() @MaxLength(100) order_no!: string;
  @IsNotEmpty() @EmptyStringToUndefined() @IsString() customer_id!: string;
  @IsOptional() @IsString() contact_id?: string;
  @IsOptional() @IsString() @MaxLength(100) customer_po_no?: string;
  @IsOptional() @IsString() @MaxLength(100) external_contract_no?: string;
  @IsDateString() order_date!: string;
  @IsNotEmpty() @EmptyStringToUndefined() @IsString() @MaxLength(200) product_name!: string;
  @IsOptional() @IsString() @MaxLength(1000) product_spec?: string;
  @Matches(NON_NEGATIVE_DECIMAL, { message: "数量必须是不小于 0 的十进制数" }) @IsDecimal() quantity!: string;
  @IsNotEmpty() @EmptyStringToUndefined() @IsString() @MaxLength(30) unit!: string;
  @IsOptional() @IsDateString() delivery_date?: string;
  @IsNotEmpty() @EmptyStringToUndefined() @IsString() @MaxLength(10) currency!: string;
  // 单价/金额/税率留空时前端会提交 ""：先归一成 undefined，否则 @IsOptional() 不跳过空串 → 400。
  // 金额一律不允许负数（负应收会被原样带进财务应收来源）。
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() unit_price?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() total_amount?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() tax_rate?: string;
  // 结算口径：结算币价 / 应收金额 / 结算方式 / 本币金额。
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() settlement_unit_price?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() receivable_amount?: string;
  @IsOptional() @EmptyStringToUndefined() @IsIn(SETTLEMENT_METHODS) settlement_method?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() local_currency_amount?: string;
  @IsOptional() @IsObject() extension_data?: Record<string, unknown>;
  /**
   * 货号（老板 2026-09-26：「每个销售单多一个字段，叫做货号」）。
   *
   * **空串的语义是「清除货号」**（服务层的 `normalizeItemNo` 把它落成 `NULL`），与 37 个细化标量一致。
   * 所以这里**故意不加** `EmptyStringToUndefined`：那会把空串变成 undefined 也就是「不动」，
   * 两者写反的后果正好相反（「删了没保存上」 vs 「只改一格结果把货号清空了」）。
   *
   * 货号**不是必填**：历史单没有货号，强制会让「确认」这个既有动作变成破坏性变更。
   * 补录待办在【返单与总结 → 未填货号】。
   */
  @IsOptional() @IsString() @MaxLength(ITEM_NO_MAX_LENGTH) item_no?: string | null;
  /**
   * 返单来源销售单号：**只由「返单建单」写入**（服务层从来源单取值）。
   * 更新接口的 DTO 里没有这个键，服务层的 `SalesOrderUpdate` 也把它排除了 —— 两处都不接受改写。
   */
  @IsOptional() @IsString() @MaxLength(100) reorder_from_order_no?: string;
}
export class UpdateSalesOrderDto extends SalesOrderSpecDto {
  @IsOptional() @IsString() contact_id?: string;
  @IsOptional() @IsString() @MaxLength(100) customer_po_no?: string;
  @IsOptional() @IsString() @MaxLength(100) external_contract_no?: string;
  @IsOptional() @IsDateString() order_date?: string;
  @IsOptional() @EmptyStringToUndefined() @IsNotEmpty() @IsString() @MaxLength(200) product_name?: string;
  @IsOptional() @IsString() @MaxLength(1000) product_spec?: string;
  @IsOptional() @Matches(NON_NEGATIVE_DECIMAL, { message: "数量必须是不小于 0 的十进制数" }) @IsDecimal() quantity?: string;
  @IsOptional() @EmptyStringToUndefined() @IsNotEmpty() @IsString() @MaxLength(30) unit?: string;
  @IsOptional() @IsDateString() delivery_date?: string;
  @IsOptional() @EmptyStringToUndefined() @IsNotEmpty() @IsString() @MaxLength(10) currency?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() unit_price?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() total_amount?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() tax_rate?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() settlement_unit_price?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() receivable_amount?: string;
  @IsOptional() @EmptyStringToUndefined() @IsIn(SETTLEMENT_METHODS) settlement_method?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "金额必须是不小于 0 的十进制数" }) @IsDecimal() local_currency_amount?: string;
  @IsOptional() @IsObject() extension_data?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  /**
   * 订单号：**可改**（2026-09-30，用户：「创建销售单，订单号写错了要支持编辑和修改」）。
   *
   * 与货号不同，它不是一次普通的列写入：改号要过全链联动（38 张冗余 `order_no` 的表 + 别的单上的
   * 返单来源引用 + 本单历史版本快照），并且**必须填原因**，保存前要先看影响面
   * （`GET /sales-orders/:id/order-no-impact`）。但它**不进 `coreFields`**：改号不动任何一张下游单的
   * 数量与金额，所以已确认、已有 BOM/采购/生产的单可以直接改，不必先回退整条链。
   *
   * **故意不加 `EmptyStringToUndefined`**：那会把空串变成 undefined 也就是「不动」，
   * 而"改了却发现没生效"正是本轮要修的病。空串在这里走 `@IsNotEmpty()` → 400。
   */
  @IsOptional() @IsNotEmpty() @IsString() @MaxLength(100) order_no?: string;
  /**
   * 货号：可改（打错的货号要能修），已确认单改它走既有的「必须填原因」守卫。
   * **故意不放进 `coreFields`**：货号不锁下游 —— 否则下单后想改一个打错的货号，
   * 必须先回退 BOM/采购/生产，那是不可接受的。
   */
  @IsOptional() @IsString() @MaxLength(ITEM_NO_MAX_LENGTH) item_no?: string | null;
}
class SalesOrderQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() status?: string;
}
/** 返单预览的入参：来源**销售单号**（不是 id）——界面手上有的就是单号。 */
class ReorderPreviewQueryDto {
  @IsNotEmpty() @IsString() @MaxLength(100) order_no!: string;
}
/**
 * 改号影响面预览的入参（`GET /sales-orders/:id/order-no-impact?order_no=新号`）。
 * 新建单号是**候选值**而不是既有单号，所以这里不做"必须已存在"之类的判断 ——
 * 冲突由服务层按唯一索引口径回答（软删单占着的号也算冲突）。
 */
class OrderNoImpactQueryDto {
  @IsNotEmpty() @IsString() @MaxLength(100) order_no!: string;
}
class ReasonDto { @IsString() @MaxLength(1000) reason!: string; }
/**
 * 删除销售单的入参（2026-11-03）。
 *
 * **草稿可以不传**（保持 2026-10-08 的一键删）；已确认/已关闭必须填原因 ——
 * 删它带走的是整条链的「父单」，下游采购/生产/应收会变成孤立单据。
 * 空串与不传在服务层是同一件事（`.trim()` 后判空），所以这里不必另做空串归一。
 */
export class DeleteSalesOrderDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
// 销售「通知仓库出库」：不传 production_order_id 时对该订单所有可出库的生产单各建一张整批通知；
// 传 notice_quantity 时只通知这一部分（分批通知），此时必须同时指定 production_order_id。
// 导出以便单元测试直接用真实 ValidationPipe 校验（分级通知数量是本轮新增的入口）。
export class OutboundNoticeDto {
  @IsOptional() @IsUUID() production_order_id?: string;
  @IsOptional() @EmptyStringToUndefined() @Matches(NON_NEGATIVE_DECIMAL, { message: "通知数量必须是不小于 0 的十进制数" }) @IsDecimal() notice_quantity?: string;
  @IsOptional() @IsString() @MaxLength(1000) remark?: string;
  @IsOptional() @IsString() @MaxLength(160) idempotency_key?: string;
}

@Controller("sales-orders")
@UseGuards(AuthenticationGuard, ModulePermissionGuard)
@RequireModules("sales")
export class SalesOrdersController {
  constructor(private readonly orders: SalesOrdersService, private readonly outboundNotices: FinishedGoodsOutboundNoticeService, private readonly productionSheetExport: SalesOrderExportService, private readonly salesOrderImport: SalesOrderImportService) {}
  @Get() async list(@Query() query: SalesOrderQueryDto) { const result = await this.orders.list(query.page, query.page_size, query.search, query.status); return { data: result.data, meta: { page: query.page, page_size: query.page_size, total: result.total } }; }
  @Post() async create(@Body() body: SalesOrderDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.create(body, user), meta: {} }; }
  /**
   * Excel 补录的**第一步：只读解析**（2026-11-02）。
   *
   * 用户要的是「上传 → 系统读出字段 → 展示系统表单 → 改完再确认建单」，不是"上传即建单"。
   * 所以这个端点只把解析结果（请求键形状的预填载荷 + 逐格核对清单 + 待修正项）返回给前端，
   * **任何情况下都不写库**：编辑器看到的就是一会要提交的那张单，不存在「预览说 3 款、建出来 2 款」。
   * 建单仍走 `POST /sales-orders`，DTO / 归一 / 快照 / 审计一份都不另起。
   *
   * 路径单段（`import-preview`），POST 那边只有 `:id/confirm` 这类两段路由，不会冲突；
   * 权限沿用类级的 `sales` 模块守卫 —— 录单的人就是补录的人，不额外锁管理员。
   */
  @Post("import-preview")
  @UseInterceptors(FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: MULTER_DOCUMENT_FILE_SIZE_LIMIT }, fileFilter: salesOrderImportFileFilter }))
  async importPreview(@UploadedFile() file: Express.Multer.File) {
    return { data: await this.salesOrderImport.preview(file), meta: {} };
  }
  // 销售模块的成品出库总览（全部成品数 / 已出库数 / 未出库数，按产品+单位分行）。
  // 必须声明在 @Get(":id") 之前：Nest 按声明顺序匹配，否则 "finished-goods-summary"
  // 会被当成销售单 ID 去查库（与「其他应付导入模板」被 :id 吃掉是同一类问题）。
  @Get("finished-goods-summary") async finishedGoodsSummary() { return { data: await this.outboundNotices.overview(), meta: {} }; }
  /**
   * 货号候选（2026-09-26）：销售单编辑器里那个「可挑可输」的货号输入框的建议来源。
   *
   * **必须声明在 `@Get(":id")` 之前**：Nest 按声明顺序匹配，否则 "item-nos" 会被当成销售单 ID 去查库。
   * 这条与 `finished-goods-summary` 是同一类问题（那个注释里写着同样的教训）。
   *
   * 为什么不复用 `GET /sales-orders?page_size=200` 让前端自己推：那样只能看到前 200 张单的货号，
   * 老货号根本推荐不出来 —— 推荐不出来就等于没有。这里按列去重，不看翻页窗口。
   */
  @Get("item-nos") async itemNos(@Query("q") q?: string, @Query("limit") limit?: string) {
    return { data: await this.orders.itemNoOptions(q, limit === undefined ? undefined : Number(limit)), meta: {} };
  }
  /**
   * 孤立单据汇总（2026-11-03）：销售单被删后留下的下游单据。
   *
   * **必须声明在 `@Get(":id")` 之前**：Nest 按声明顺序匹配，否则 "orphans" 会被当成销售单 ID
   * 去查库（与 `finished-goods-summary` / `item-nos` / `reorder-preview` 是同一类问题）。
   */
  @Get("orphans") async orphans() { return { data: await this.orders.orphans(), meta: {} }; }
  /**
   * 返单预览（2026-09-26）：把「会带过来什么 / 必须重填什么」摆给编辑器，**不建单**。
   * 与上面那条同理，**必须声明在 `@Get(":id")` 之前**（"reorder-preview" 不是 UUID）。
   */
  @Get("reorder-preview") async reorderPreview(@Query() query: ReorderPreviewQueryDto) {
    return { data: await this.orders.reorderPreview(query.order_no), meta: {} };
  }
  /**
   * 工艺单导出（2026-09-16）：按 example/销售单 的模板版式，图片格留空。
   *
   * **不额外要求管理员**（与采购单/领料单导出的 `@RequireAdministrator()` 不同）：工艺单是销售
   * 每天要打给工厂的单据，只有管理员能打等于把这个功能锁死。权限沿用类级的 `sales` 模块要求。
   * 路径是两段（`:id/production-sheet.xlsx`），不会被单段的 `@Get(":id")` 吃掉。
   */
  @Get(":id/production-sheet.xlsx") async productionSheet(@Param("id") id: string, @Res() response: Response) {
    const { buffer, orderNo } = await this.productionSheetExport.exportOrder(id);
    return this.sendSheet(response, buffer, `迪礼ERP-工艺单-${orderNo}.xlsx`);
  }
  /**
   * 工艺单导出（带选中的物料图片）：用户 2026-09-24「导出销售单的时候，每个有图片的物料允许用户
   * 勾选是否 excel 中一并导出这个图片」。
   *
   * 为什么是 **multipart** 而不是 JSON：图片字节走 JSON 会撞上 Express 默认 100KB 的 body 上限，
   * 而放开全局上限是拿整站的攻击面换一个导出接口。multipart 本来就是为字节准备的：
   * 一个勾选的栏位 = 一个文件，**字段名就是 `spec_key`**（`AnyFilesInterceptor` 把 `fieldname`
   * 原样给我们），所以不必再发明一套「第几个文件对应哪一格」的约定。
   *
   * 没勾任何图片时不带文件即可（等于普通工艺单），所以界面只有这一条导出路径 —— 少一条路，
   * 就少一处「带图/不带图两份版式会慢慢分叉」的机会。
   *
   * ⚠️ `files` 上限 = 「18 个固定栏位 + 「其它」行上限 + 明细行图片」（2026-10-08 / 2026-11-04）：
   * 上限不跟着「能勾的格子数」走的话，钉住一个过小的数字会让 multer 用 `LIMIT_FILE_COUNT`
   * 报一个用户看不懂的错。真正的体积闸门仍在下游（单张 2MB + 合计 12MB，见 `sales-order-export.service.ts`）。
   */
  @Post(":id/production-sheet.xlsx")
  @UseInterceptors(AnyFilesInterceptor({ storage: memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: PRODUCTION_SHEET_IMAGE_FILE_LIMIT } }))
  async productionSheetWithImages(@Param("id") id: string, @UploadedFiles() files: Express.Multer.File[], @Res() response: Response) {
    const selected = (files ?? []).map((file) => ({ spec_key: file.fieldname, buffer: file.buffer }));
    const { buffer, orderNo } = await this.productionSheetExport.exportOrderWithImages(id, selected);
    return this.sendSheet(response, buffer, `迪礼ERP-工艺单-${orderNo}.xlsx`);
  }
  /**
   * 导出弹窗要列出的候选：这一单引用了哪些物料、各自有没有图。
   *
   * 两个 `:id/...` 段的路由都不会被单段的 `@Get(":id")` 吃掉（同 `:id/production-sheet.xlsx` 的说明）。
   */
  @Get(":id/export-images") async exportImages(@Param("id") id: string) { return { data: { images: await this.productionSheetExport.exportImageCandidates(id) }, meta: {} }; }
  @Get(":id/impact-preview") async impactPreview(@Param("id") id: string) { return { data: await this.orders.impactPreview(id), meta: {} }; }
  /**
   * 普通复制快照：把一张既有单的详情摆给新建页（`/sales/orders/new?copy_from_id=<id>`），**不建单**。
   *
   * 与「返单」并存，不是它的替代：返单记来源、要求已确认/已关闭且有货号；复制**任何状态都能用、
   * 不要求货号、新单不记来源**（不写 `reorder_from_order_no`，否则新单会被归进返单分组）。
   *
   * 参数是**销售单 id**（列表每行的操作区拿到的就是 id，复制不需要先有单号）；
   * 权限沿用类级的 `sales` 模块守卫 —— 与返单预览同一条，不额外锁管理员。
   *
   * 路径两段（`:id/copy-snapshot`），不会被单段的 `@Get(":id")` 吃掉；仍**声明在 `@Get(":id")` 之前**，
   * 与上面几条同一个约定（Nest 按声明顺序匹配）—— 将来谁把它挪到后面，至少这里写着为什么不能挪。
   */
  @Get(":id/copy-snapshot") async copySnapshot(@Param("id") id: string) { return { data: await this.orders.copySnapshot(id), meta: {} }; }
  /**
   * 改号的**影响面预览**（2026-09-30）：保存前把「会同步改哪几类单据、各多少条」摆给用户。
   *
   * 只读、不写。与执行共用同一份登记表（`ORDER_NO_RENAME_TARGETS`），所以预览说的与真改的不会分叉。
   * 路径两段（`:id/order-no-impact`），不会被单段的 `@Get(":id")` 吃掉。
   */
  @Get(":id/order-no-impact") async orderNoImpact(@Param("id") id: string, @Query() query: OrderNoImpactQueryDto) { return { data: await this.orders.orderNoImpact(id, query.order_no), meta: {} }; }
  // 成品入库/出库情况 + 出库通知（销售页「打开销售订单能看到成品入库情况」）。
  @Get(":id/finished-goods") async finishedGoods(@Param("id") id: string) { return { data: await this.outboundNotices.summary(id), meta: {} }; }
  @Post(":id/outbound-notices") async notifyOutbound(@Param("id") id: string, @Body() body: OutboundNoticeDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outboundNotices.createNotices(id, body, user), meta: {} }; }
  @Post(":id/outbound-notices/:noticeId/cancel") async cancelOutboundNotice(@Param("id") id: string, @Param("noticeId") noticeId: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outboundNotices.cancelNotice(id, noticeId, body.reason, user), meta: {} }; }
  /**
   * 删除前的**影响面预览**（2026-11-03）：删掉这张销售单会留下哪些下游单据、各几张。
   *
   * 只读、不写。与执行共用 `countOrphanDocuments`（同一张 11 类清单），
   * 所以「弹窗里说的」与「删完真的留下的」不会分叉。
   * 路径两段（`:id/delete-preview`），不会被单段的 `@Get(":id")` 吃掉。
   */
  @Get(":id/delete-preview") async deletePreview(@Param("id") id: string) { return { data: await this.orders.deletePreview(id), meta: {} }; }
  /**
   * 上传一张「这一单的行图片」（2026-11-04，用户：「销售订单要支持每个物料插入图片」）。
   *
   * multipart 字段名 `file`；浏览器压成 WebP 再传，服务端用与物料图片**同一个**
   * `validateMaterialImage` 解容器核对（不信 Content-Type）。multer 的 `fileSize` 与
   * `MAX_MATERIAL_IMAGE_BYTES` 对齐：超限的文件在 multer 层就拦下，不先读进内存再判。
   *
   * 路径两段（`:id/images`），不会被单段的 `@Get(":id")` 吃掉；但和下面那条 GET 一样
   * **声明在 `@Get(":id")` 之前**，省得下一个加路由的人去猜顺序有没有影响。
   */
  @Post(":id/images")
  @UseInterceptors(FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: MAX_MATERIAL_IMAGE_BYTES }, fileFilter: salesOrderImageFileFilter }))
  async uploadSalesOrderImage(@Param("id") id: string, @UploadedFile() file: Express.Multer.File, @CurrentUser() user: CurrentUserType) {
    return { data: await this.orders.setImage(id, file, user), meta: {} };
  }
  /**
   * 读一张行图片的字节（2026-11-04）：`ETag = sha256` + `private, max-age=0, must-revalidate`，
   * `If-None-Match` 命中回 **304 且无 body**（编辑页每次打开都会把这些图重新挂一遍，304 省的是下载）。
   *
   * **必须声明在 `@Get(":id")` 之前**（与 `:id/copy-snapshot` 等所有多段 GET 同一个约定）：
   * Nest 按声明顺序匹配。两段路由本来不会被单段吃掉，但顺序约定写在同处，不必下次再想一遍。
   *
   * 归属校验在服务层：不属于这张单 / 已软删 → 404 `SALES_ORDER_IMAGE_NOT_FOUND`（与不存在的 id 同一个响应，
   * 不给「这个 id 存在、只是不是你的」这种可枚举信息）。
   */
  @Get(":id/images/:imageId")
  async salesOrderImage(@Param("id") id: string, @Param("imageId") imageId: string, @Headers("if-none-match") ifNoneMatch: string | undefined, @Res() response: Response) {
    const image = await this.orders.image(id, imageId);
    const etag = `"${image.sha256}"`;
    // 缓存头与物料图片接口同一口径：私有（销售单图不该进共享缓存）+ 每次都要回源确认（图会被清理/重传）。
    response.setHeader("Content-Type", image.mimeType || "image/webp");
    response.setHeader("ETag", etag);
    response.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    if (ifNoneMatchHit(ifNoneMatch, etag)) return response.status(304).end();
    return response.send(image.data);
  }
  @Get(":id") async get(@Param("id") id: string) { return { data: await this.orders.get(id), meta: {} }; }
  @Patch(":id") async update(@Param("id") id: string, @Body() body: UpdateSalesOrderDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.update(id, body, user), meta: {} }; }
  @Post(":id/confirm") async confirm(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.confirm(id, user), meta: {} }; }
  @Post(":id/revert-draft") async revertDraft(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.revertToDraft(id, body.reason, user), meta: {} }; }
  @Post(":id/close") async close(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.close(id, user), meta: {} }; }
  /**
   * 删除销售单（2026-11-03 起**所有状态**都能删）。
   *
   * body 可选 `{ reason }`：草稿不填（2026-10-08 的一键删不变），已确认/已关闭必须填。
   * 下游采购/生产/应收**不删**，变成孤立单据（`GET /sales-orders/orphans` 可查）。
   * 守卫全在服务层：锁行复查、非草稿原因必填、影响面计数进审计。
   *
   * 与另外三个状态流转端点（confirm / revert-draft / close）一样只走模块权限，不额外锁管理员 ——
   * 用户 2026-11-03 选定「有销售模块权限的人都能删」。
   */
  @Delete(":id") async remove(@Param("id") id: string, @Body() body: DeleteSalesOrderDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.delete(id, user, body?.reason), meta: {} }; }

  /**
   * xlsx 下发的三件事一处写全：`Content-Type` + `filename*=UTF-8''`（中文文件名）+ `no-store`。
   * 两个导出路由共用它 —— 抄两遍必然有一处漏掉中文文件名或缓存头（别处的教训）。
   */
  private sendSheet(response: Response, buffer: Buffer, fileName: string) {
    response.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    response.setHeader("Cache-Control", "no-store");
    return response.send(buffer);
  }
}

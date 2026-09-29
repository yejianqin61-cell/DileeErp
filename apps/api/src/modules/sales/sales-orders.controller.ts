import { Body, Controller, Get, Param, Patch, Post, Query, Res, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { AnyFilesInterceptor } from "@nestjs/platform-express";
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
import { SalesOrdersService } from "./sales-orders.service";
import { SalesOrderExportService } from "./sales-order-export.service";
import { FinishedGoodsOutboundNoticeService } from "./finished-goods-outbound-notice.service";
import { ITEM_NO_MAX_LENGTH } from "./item-no";

/** 金额类字段的非负校验：class-validator 的 @Min 对字符串不生效（会直接判不通过），这里用十进制正则。 */
const NON_NEGATIVE_DECIMAL = /^\d+(?:\.\d+)?$/;

/** 结算方式固定枚举（前端下拉同源展示中文）。 */
export const SETTLEMENT_METHODS = ["tt", "letter_of_credit", "cash", "monthly", "other"] as const;

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
  @IsOptional() @IsString() @MaxLength(ITEM_NO_MAX_LENGTH) item_no?: string;
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
   * 货号：可改（打错的货号要能修），已确认单改它走既有的「必须填原因」守卫。
   * **故意不放进 `coreFields`**：货号不锁下游 —— 否则下单后想改一个打错的货号，
   * 必须先回退 BOM/采购/生产，那是不可接受的。
   */
  @IsOptional() @IsString() @MaxLength(ITEM_NO_MAX_LENGTH) item_no?: string;
}
class SalesOrderQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() status?: string;
}
class ReasonDto { @IsString() @MaxLength(1000) reason!: string; }
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
  constructor(private readonly orders: SalesOrdersService, private readonly outboundNotices: FinishedGoodsOutboundNoticeService, private readonly productionSheetExport: SalesOrderExportService) {}
  @Get() async list(@Query() query: SalesOrderQueryDto) { const result = await this.orders.list(query.page, query.page_size, query.search, query.status); return { data: result.data, meta: { page: query.page, page_size: query.page_size, total: result.total } }; }
  @Post() async create(@Body() body: SalesOrderDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.create(body, user), meta: {} }; }
  // 销售模块的成品出库总览（全部成品数 / 已出库数 / 未出库数，按产品+单位分行）。
  // 必须声明在 @Get(":id") 之前：Nest 按声明顺序匹配，否则 "finished-goods-summary"
  // 会被当成销售单 ID 去查库（与「其他应付导入模板」被 :id 吃掉是同一类问题）。
  @Get("finished-goods-summary") async finishedGoodsSummary() { return { data: await this.outboundNotices.overview(), meta: {} }; }
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
   */
  @Post(":id/production-sheet.xlsx")
  @UseInterceptors(AnyFilesInterceptor({ storage: memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 20 } }))
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
  // 成品入库/出库情况 + 出库通知（销售页「打开销售订单能看到成品入库情况」）。
  @Get(":id/finished-goods") async finishedGoods(@Param("id") id: string) { return { data: await this.outboundNotices.summary(id), meta: {} }; }
  @Post(":id/outbound-notices") async notifyOutbound(@Param("id") id: string, @Body() body: OutboundNoticeDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outboundNotices.createNotices(id, body, user), meta: {} }; }
  @Post(":id/outbound-notices/:noticeId/cancel") async cancelOutboundNotice(@Param("id") id: string, @Param("noticeId") noticeId: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.outboundNotices.cancelNotice(id, noticeId, body.reason, user), meta: {} }; }
  @Get(":id") async get(@Param("id") id: string) { return { data: await this.orders.get(id), meta: {} }; }
  @Patch(":id") async update(@Param("id") id: string, @Body() body: UpdateSalesOrderDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.update(id, body, user), meta: {} }; }
  @Post(":id/confirm") async confirm(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.confirm(id, user), meta: {} }; }
  @Post(":id/revert-draft") async revertDraft(@Param("id") id: string, @Body() body: ReasonDto, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.revertToDraft(id, body.reason, user), meta: {} }; }
  @Post(":id/close") async close(@Param("id") id: string, @CurrentUser() user: CurrentUserType) { return { data: await this.orders.close(id, user), meta: {} }; }

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

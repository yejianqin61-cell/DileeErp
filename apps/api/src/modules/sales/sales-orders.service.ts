import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { normalizeItemNo, itemNoKey } from "./item-no";
// 销售单行图片与物料图片用**同一个**校验器（2026-11-04）：字节口径必须一致（WebP / ≤2MB / 边长 ≤2000），
// 否则同一张图在物料清单能传、在销售单行上被拒，用户会以为是两个功能。
import { validateMaterialImage } from "../procurement/material-image";
// 材料类目名只有一份（导出服务与这里共用）：「同类目再加一款」的类目名由服务端定，不采用请求里的字。
import { isMaterialCategoryKey, materialCategoryLabel } from "./sales-material-labels";
import { countOrphanDocuments, summarizeOrphanDocuments } from "./orphan-documents";
// 「这张 BOM 有没有下游事实 / 是不是空壳」只有一份定义（`bom-facts.ts`）：BOM 删除与销售单保存
// 两条路径共用它，否则迟早出现「销售单说这张 BOM 是空的、删 BOM 却说被引用」的自相矛盾。
import { AUTO_RELEASE_EMPTY_BOM_REASON, bomBlockedReason, isEmptyShellBom, salesOrderBomFacts, type BomFacts } from "./bom-facts";
import { countVersionSnapshotsWithOrderNo, normalizeOrderNo, orderNoRenameImpact, renameSalesOrderNo, type OrderNoRenameReport } from "./sales-order-order-no";

/**
 * 下单口径细化的固定字段映射：请求键（snake_case）→ Prisma 列（camelCase）。
 *
 * 用**一张表驱动**（创建 / 更新 / 版本快照三处都从它推），而不是把 37 个字段各抄三遍——
 * 抄三遍必然漏一处，而漏掉的那一处只会在导出的 Excel 上变成一个空格子，很难被发现。
 * 前端 `apps/web/components/sales/sales-order-spec.ts` 有同一份清单（两个 workspace 之间没有
 * 共享包），两边用同一组测试向量钉住字段名与顺序。
 *
 * 字段顺序 = 模板上「材料明细」与「工艺要求」的印刷顺序，导出直接按它落格。
 */
export const SPEC_SCALAR_FIELDS = [
  // 表头补充
  ["factory", "factory"],
  ["completion_remark", "completionRemark"],
  ["attention_note", "attentionNote"],
  ["shipping_mark_front", "shippingMarkFront"],
  ["shipping_mark_side", "shippingMarkSide"],
  // 布量（伞面 / 伞带 / 木耳 / 天布 / 布套，单位 Y/DZ）
  ["fabric_usage_canopy", "fabricUsageCanopy"],
  ["fabric_usage_strap", "fabricUsageStrap"],
  ["fabric_usage_wood_ear", "fabricUsageWoodEar"],
  ["fabric_usage_top", "fabricUsageTop"],
  ["fabric_usage_bag", "fabricUsageBag"],
  // 材料明细（两样本并集）
  ["rib_spec", "ribSpec"],
  ["canopy_spec", "canopySpec"],
  ["handle_spec", "handleSpec"],
  ["handle_strap_spec", "handleStrapSpec"],
  ["tail_spec", "tailSpec"],
  ["runner_spec", "runnerSpec"],
  ["strap_spec", "strapSpec"],
  ["strap_fastener_spec", "strapFastenerSpec"],
  ["inner_label_spec", "innerLabelSpec"],
  ["woven_label_spec", "wovenLabelSpec"],
  ["hang_tag_spec", "hangTagSpec"],
  ["opp_spec", "oppSpec"],
  ["bag_spec", "bagSpec"],
  ["packaging_spec", "packagingSpec"],
  ["top_fabric_spec", "topFabricSpec"],
  ["wood_ear_spec", "woodEarSpec"],
  ["keychain_spec", "keychainSpec"],
  ["printing_spec", "printingSpec"],
  // 工艺要求（两样本并集）
  ["sample_requirement", "sampleRequirement"],
  ["cutting_requirement", "cuttingRequirement"],
  ["edge_requirement", "edgeRequirement"],
  ["joining_requirement", "joiningRequirement"],
  ["top_stitch_requirement", "topStitchRequirement"],
  ["sewing_requirement", "sewingRequirement"],
  ["strap_requirement", "strapRequirement"],
  ["hang_tag_note", "hangTagNote"],
  ["qc_requirement", "qcRequirement"],
] as const;

export type SpecScalarKey = (typeof SPEC_SCALAR_FIELDS)[number][0];

/**
 * 「材料明细」那 18 个栏位的请求键 —— 只有这些栏位**可以引用物料**（用户 2026-09-24：
 * 「在编辑销售单的时候，每个部件，既支持填空，也支持从现有的物料清单中引用」）。
 *
 * 为什么单列一份而不是用 `SPEC_SCALAR_FIELDS.slice(10, 28)`：切片的下标会随着「表头/布量那几项
 * 增删」而整体错位，而错位的后果是「引用被写到了一个不该有引用的栏位上」—— 那种错在界面上看不出来，
 * 直到导出时图片配错了行。显式列出来，配一条测试钉住「它就是 SPEC_SCALAR_FIELDS 里材料那一段」。
 * 前端 `apps/web/lib/sales-order-spec.ts` 的 `SPEC_MATERIAL_FIELDS` 是同一份清单（两个 workspace
 * 没有共享包，只能各有一份，靠同一组测试向量对齐）。
 */
export const SPEC_MATERIAL_KEYS = [
  "rib_spec",
  "canopy_spec",
  "handle_spec",
  "handle_strap_spec",
  "tail_spec",
  "runner_spec",
  "strap_spec",
  "strap_fastener_spec",
  "inner_label_spec",
  "woven_label_spec",
  "hang_tag_spec",
  "opp_spec",
  "bag_spec",
  "packaging_spec",
  "top_fabric_spec",
  "wood_ear_spec",
  "keychain_spec",
  "printing_spec",
] as const;
/**
 * 「细分明细」那 6 个列键与它们的默认中文名（用户 2026-09-30：「细分明细那边，可以改成自定义字段名称」）。
 *
 * 为什么默认名也写在后端：导出件是**服务端渲染**的（销售单导出/工艺单导出），它得知道
 * 「这一单没改过的列叫什么」。前端 `apps/web/lib/sales-order-spec.ts` 的 `SPEC_DETAIL_COLUMNS`
 * 是同一份清单（两个 workspace 没有共享包），两边用同一组测试向量钉住键名与默认名。
 *
 * 键名与 `SpecDetailDto` 的字段名一一对应 —— 自定义的只是**印出来的名字**，
 * 数据形状一个字都不许动（动了就是"改了列名，明细存不进去了"）。
 */
export const SPEC_DETAIL_LABELS = [
  ["group_name", "分组名"],
  ["name", "品番/品名"],
  ["color", "颜色/配色"],
  ["barcode", "条码"],
  ["quantity", "数量"],
  ["unit", "单位"],
] as const;
export type SpecDetailLabelKey = (typeof SPEC_DETAIL_LABELS)[number][0];
/** 列名长度上限：表头要印在一格里（A4 竖版），太长会把明细表挤变形。 */
export const SPEC_DETAIL_LABEL_MAX_LENGTH = 20;
export const SPEC_DETAIL_LABEL_KEYS: readonly string[] = SPEC_DETAIL_LABELS.map(([key]) => key);

/**
 * 自定义列名归一：只留 6 个已知列键、去掉两端空格、丢掉空值（空 = 这一列用默认名）。
 *
 * 为什么**不认识就报错**而不是静默忽略：静默忽略的表现是「在界面上改了名字、导出还是老名字」，
 * 而那种错没人能查（请求里明明有这个键）。一次点名说出是哪个键，比让人猜强。
 */
export function normalizeSpecDetailLabels(input: Record<string, unknown> | null | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!input) return labels;
  for (const [key, value] of Object.entries(input)) {
    if (!SPEC_DETAIL_LABEL_KEYS.includes(key)) {
      throw new UnprocessableEntityException({ code: "SPEC_DETAIL_LABEL_KEY_UNSUPPORTED", message: `「${key}」不是细分明细的列（可自定义的只有：${SPEC_DETAIL_LABELS.map(([, label]) => label).join("、")}）`, details: [{ key }] });
    }
    const text = String(value ?? "").trim();
    if (!text) continue;
    if (text.length > SPEC_DETAIL_LABEL_MAX_LENGTH) {
      throw new UnprocessableEntityException({ code: "SPEC_DETAIL_LABEL_TOO_LONG", message: `列名「${text}」超过 ${SPEC_DETAIL_LABEL_MAX_LENGTH} 字（表头要印在一格里）`, details: [{ key, max: SPEC_DETAIL_LABEL_MAX_LENGTH }] });
    }
    labels[key] = text;
  }
  return labels;
}

/** 默认列名 + 这一单的自定义覆盖（读侧统一走它，别在两处各写一遍回退逻辑）。 */
export function specDetailLabelsWithDefaults(overrides: Record<string, unknown> | null | undefined): Record<string, string> {
  const merged = Object.fromEntries(SPEC_DETAIL_LABELS.map(([key, label]) => [key, label])) as Record<string, string>;
  for (const key of SPEC_DETAIL_LABEL_KEYS) {
    const value = overrides?.[key];
    const text = typeof value === "string" ? value.trim() : "";
    if (text) merged[key] = text;
  }
  return merged;
}

/**
 * 细化标量字段（全部可选：历史销售单没有这些字）。
 *
 * 值允许 `null`：数值列（5 个布量）留空时前端提交空串，由 DTO 上的 `EmptyStringToNull`
 * 归一成 `null`（`@IsOptional()` 跳过 null 才能过校验），服务层把 null 原样落库 = 清空这一格。
 * 类型里不写 `null` 的话，控制器把 DTO 交给服务时 `string | null` 对不上 `string`，编译期就红。
 */
export type SpecScalarFields = Partial<Record<SpecScalarKey, string | null>>;
/** 细分明细行（一张通用表 + 分组名）。 */
export type SpecDetailInput = { group_name: string; name: string; color?: string; barcode?: string; quantity?: string; unit?: string; sort_order?: number; /** 这一行自己的图（`sales_order_images.id`），最多 3 张、顺序 = 用户看到的顺序（2026-11-05「一条物料支持导入 3 张」）；省略/空数组 = 这一行没有图。 */ image_ids?: string[]; /** 旧形状（2026-11-04「每行一张」）：等同 `image_ids: [id]`；两者同时出现时 `image_ids` 优先。 */ image_id?: string };
/**
 * 材料明细里「这一格引用的是哪个物料」（用户 2026-09-24）。
 *
 * 语义是**整块替换**（与 `spec_details` 一致）：请求带了这个键就按它对齐全部引用
 * （没提到的栏位 = 取消引用），没带就整块不动。
 */
export type MaterialRefInput = { spec_key: string; material_id: string };

/**
 * 销售单引用的物料（读侧形状）：物料摘要 + **有没有图**（含图的 sha 用于破缓存）。
 *
 * `image` 只取 `sha256`/`updatedAt`，绝不取 `data` —— 销售单详情是编辑页每次打开都拉的接口。
 */
export const MATERIAL_REF_INCLUDE = {
  where: { deletedAt: null },
  include: {
    material: {
      select: {
        id: true,
        materialCode: true,
        name: true,
        specificationModel: true,
        color: true,
        image: { select: { sha256: true, updatedAt: true } },
      },
    },
  },
} as const;

/**
 * 「材料明细」末尾的自定义类目行 —— 界面上那一块叫「其它」（用户 2026-10-08：
 * 「材料明细最后还需要加一个『其它』，可以自行添加类目。有时候还需要别的物料。允许用户增删改」）。
 *
 * 语义与 `spec_details` / `material_refs` 完全一致：**整块替换**（请求带了这个键就按它对齐全部行，
 * 没提到 = 整块不动，空数组 = 清空全部）。每一行可以挂一个物料引用 —— 与上面 18 格同一套引用
 * （选中填字 + 带缩略图 + 导出时可勾选带图），理由同 `sales_order_material_refs` 的模型注释。
 *
 * 为什么上限与长度上限写在服务层而不是只在 DTO：DTO 也要写一份 `@MaxLength`（拦下明显超长的请求），
 * 而「最多几行」是**业务口径**（工艺单是一张 A4 纸，行数再多就印不下），只有服务层说得清。
 */
export const MATERIAL_EXTRA_LIMIT = 20;
export const MATERIAL_EXTRA_LABEL_MAX_LENGTH = 50;
export const MATERIAL_EXTRA_CONTENT_MAX_LENGTH = 1000;
/**
 * 「同类目再加一款」（用户 2026-10-29）：「3 款伞头、2 款伞布」就是同一类目下多行。
 *
 * `spec_key` 非空 = 这一行是 18 个固定类目之一的追加款（类目名由**服务端**按类目键填，不信前端），
 * 空/省略 = 原有「其它」自由类目行。两套语义共用一个数组、一张表：
 * 「谁先印」这件事本来就只能有一处定义（见导出服务的 `MATERIAL_LABELS` 顺序）。
 */
export type MaterialExtraInput = { label?: string; content?: string | null; material_id?: string | null; sort_order?: number; spec_key?: string | null; /** 这一行自己挂的图（`sales_order_images.id`），最多 3 张（2026-11-05）；引用物料时优先用它，没有才回退物料图。 */ image_ids?: string[]; /** 旧形状（2026-11-04「每行一张」）：等同 `image_ids: [id]`；两者同时出现时 `image_ids` 优先。 */ image_id?: string | null };

/**
 * 销售单行图片的公开形状（**没有 `data`**，2026-11-04）。
 *
 * 五个字段就是界面需要的全部：`id`（指针目标）、`width`/`height`（占位，图没到之前不要跳版）、
 * `byteSize`（弹窗里显示大小）、`sha256`（`<img src="...?v=sha">` 破缓存 + 「换没换图」的唯一依据）。
 * **不带 `updatedAt`**：sha 已经能回答「换没换」，多一个键只会让每处 deepEqual 跟着变。
 *
 * 与 `MATERIAL_IMAGE_SUMMARY` 同一口径：编辑页每次打开都要拉详情，带上字节就是几百 KB × 每行一张图。
 * 页面靠 `image !== null` 判断有没有图，字节走 `GET /sales-orders/:id/images/:imageId`（可缓存、可 304）。
 */
export const SALES_ORDER_IMAGE_SUMMARY = { id: true, width: true, height: true, byteSize: true, sha256: true } as const;

/**
 * 一行/一格最多能挂几张图（2026-11-05）。
 *
 * 用户原话：「销售单那边，一条物料支持导入 3 张图片，现在只有 1 张。改一下」。
 * 三个位置（18 个材料格、「其它」/「再加一款」行、细分明细行）用**同一个**上限：用户拍板「界面与数据
 * 一致，不用记哪类行只能 1 张」，所以这个数字只在这里定义一次、三处归一都引用它。
 *
 * 为什么上限只在服务层判、不加进 DTO 的 `@ArrayMaxSize`：DTO 拦下来是 400（一个"请求参数不合法"），
 * 而这个越限是**业务口径**（一张工艺单的图片区就那么大），必须回 422 `SALES_ORDER_IMAGE_LIMIT`
 * 并带 `scope`/`key`/`count`，界面才能指出是**哪一行**放了 4 张。
 */
export const MAX_ROW_IMAGES = 3;

/**
 * 一行/一格上的图片 id —— **不校验上限的只读投影**；两种形状都认（与 `specScalarRow` 同一条理由：
 * 库里真实存在两种键名，认两种比逼调用方先转换安全）：
 *   * 请求/快照形状：`image_ids`（优先，数组）或旧的单张 `image_id`；
 *   * Prisma 行形状：`imageId` / `imageId2` / `imageId3`（详情、返单来源、复制来源取出来的就是它）。
 * 去空、保序，但**不去重**（去重与上限是 `normalizeRowImageIds` 的事）。
 *
 * 为什么要有这个"不校验"的版本：`imageIdsOf` / `touchesImages` 只回答「这次保存有没有碰图片」——
 * 它们要能在**归一之前**跑（否则超限的请求会从"要不要查库"这个判断里抛出一个与本意无关的 422）。
 */
export function rowImageIds(
  row: { image_ids?: readonly string[] | null; image_id?: string | null; imageId?: string | null; imageId2?: string | null; imageId3?: string | null } | null | undefined,
): string[] {
  const given = row?.image_ids;
  // 有 `image_ids` 就以它为准（§3.1:两者同时出现时数组优先）；否则按「第 1→3 张」的顺序收单值键。
  const raw: readonly unknown[] = Array.isArray(given) ? given : [row?.image_id, row?.imageId, row?.imageId2, row?.imageId3];
  return raw.map((value) => String(value ?? "").trim()).filter(Boolean);
}

/**
 * 图片 id 归一：`image_ids` 优先、兼容旧的单张 `image_id`；去空、去重、**保序**（顺序 = 用户看到的顺序）；
 * 超过 `MAX_ROW_IMAGES` → 422 `SALES_ORDER_IMAGE_LIMIT`。
 *
 * 为什么先并成数组再判上限（而不是直接数请求里的元素）：同一张图被重复提交是前端的正常可能
 * （同一页签刷新、双击上传），去重后 3 张就该放行 —— 让重复项把一次合法保存卡成 422 是无谓的。
 * 为什么去重后仍**保序**：3 张图的顺序是用户看到的顺序，也是工艺单上的印刷顺序，不能靠 Set 的插入序之外的
 * 任何逻辑重排（本节只做去重，不做排序）。
 *
 * `scope` / `key` 进 `details`：界面要能把这行标红。`scope` 用请求键的名字（`spec_details` 等），
 * `key` 是行内可读标识（明细的品名 / 「其它」的类目名 / 材料格的 `spec_key`）。
 */
export function normalizeRowImageIds(
  row: { image_ids?: readonly string[] | null; image_id?: string | null } | null | undefined,
  scope: "spec_details" | "material_extras" | "slot_images",
  key: string,
): string[] {
  const ids: string[] = [];
  for (const id of rowImageIds(row)) {
    if (ids.includes(id)) continue;
    ids.push(id);
  }
  if (ids.length > MAX_ROW_IMAGES) {
    throw new UnprocessableEntityException({
      code: "SALES_ORDER_IMAGE_LIMIT",
      message: `一行/一格最多 ${MAX_ROW_IMAGES} 张图片`,
      details: [{ scope, key, count: ids.length }],
    });
  }
  return ids;
}

/**
 * 「其它」行的读侧形状：行 + 引用物料的摘要（含 `image.sha256` 用于破缓存、`updatedAt` 用于缩略图，
 * **不含字节**）。与 `MATERIAL_REF_INCLUDE` 同一套 select：编辑器要显示缩略图，导出候选要尺寸。
 *
 * `orderBy` 必须有：这些行是**有序**的（用户排的先后就是工艺单上的先后），
 * 而 `material_refs` 是一格一行的映射、不靠顺序，所以那边没有 orderBy。
 *
 * `image`（2026-11-04）：这一行自己挂的图（客户临时样照），与物料图同时返回、由前端决定显示哪张
 * （行图优先）。同样只取摘要不取字节。
 *
 * `image2` / `image3`（2026-11-05「一条物料最多 3 张」）：同一行上的第 2/3 张，口径与 `image` 完全相同
 * （只取摘要、不取字节）—— 三个位置一起升级，老行没有第 2/3 张时这两个关系是 `null`。
 */
export const MATERIAL_EXTRA_INCLUDE = {
  where: { deletedAt: null },
  orderBy: { sortOrder: "asc" },
  include: {
    material: {
      select: {
        id: true,
        materialCode: true,
        name: true,
        specificationModel: true,
        color: true,
        image: { select: { sha256: true, updatedAt: true } },
      },
    },
    image: { select: SALES_ORDER_IMAGE_SUMMARY },
    image2: { select: SALES_ORDER_IMAGE_SUMMARY },
    image3: { select: SALES_ORDER_IMAGE_SUMMARY },
  },
} as const;

/**
 * 「返单预览 / 复制快照」里行图的字段（2026-11-04 单张 → 2026-11-05 数组）：
 * **只有真的挂了图才带键**，形状是「请求键」那一套 ——
 *
 * ```jsonc
 * { "image_ids": ["img-1", "img-2"], "images": [{ "id": "img-1", … }, …], "image_id": "img-1", "image": { … } }
 * ```
 *
 * 为什么数组为空时**一个键都不带**（而不是写 `image_ids: []`）：`copy` 的既有形状被既有单测逐字钉着
 * （「其它」行那条 deepEqual），凭空多一个空数组会让它们变红；而前端对「没有这个键」与 `[]`
 * 的处理本来就是同一件事。
 *
 * 为什么第 1 张还要镜像到旧的单值键 `image_id`/`image`：版本快照与老前端仍按「一行一张」读，
 * 不镜像的话「升级之后打开返单预览，一张图都看不到」。
 */
export type SalesOrderImageSummary = { id: string; width: number; height: number; byteSize: number; sha256: string };

export function imageCopyFields(
  imageIds: readonly string[] | null | undefined,
  images: ReadonlyArray<SalesOrderImageSummary | null | undefined> | null | undefined,
): { image_ids?: string[]; images?: SalesOrderImageSummary[]; image_id?: string; image?: SalesOrderImageSummary } {
  const ids = [...(imageIds ?? [])].filter(Boolean);
  if (!ids.length) return {};
  // 摘要是**按位置**对应的（`image`/`image2`/`image3` 与三列 id 同序），所以这里不能各自过滤一遍
  // 再对齐：调用方给的是同序的两个数组，空位各自跳过即可（真实数据里 id 与摘要一一对应）。
  const summaries = (images ?? []).filter((image): image is SalesOrderImageSummary => Boolean(image));
  return {
    image_ids: ids,
    ...(summaries.length ? { images: summaries } : {}),
    image_id: ids[0],
    ...(summaries[0] ? { image: summaries[0] } : {}),
  };
}

/** 一行上最多 3 张图的摘要（`image` / `image2` / `image3`，按第 1→3 张顺序，空位不占）。 */
export function rowImageSummaries(row: { image?: SalesOrderImageSummary | null; image2?: SalesOrderImageSummary | null; image3?: SalesOrderImageSummary | null } | null | undefined): SalesOrderImageSummary[] {
  return [row?.image, row?.image2, row?.image3].filter((image): image is SalesOrderImageSummary => Boolean(image));
}

/**
 * **保存载荷**里的行图片字段：只带 `image_ids`（§3.1 的请求键形状），没有图时一个键都不带。
 *
 * 为什么与 `imageCopyFields` 分开：那个是「返单预览 / 复制快照」的展示形状（要带摘要、要镜像旧键），
 * 而建单载荷只该有指针 —— 把摘要塞进 `spec_details` 再进版本快照，会让每次保存的快照都多存一份
 * 宽高/sha（它们本来就随时会变，快照只需要记得"当时挂的是哪几张"）。
 */
function rowImageIdsPayload(ids: readonly string[]): { image_ids?: string[] } {
  return ids.length ? { image_ids: [...ids] } : {};
}

/**
 * 「18 个材料格 → 这一格自己的图」（2026-11-04 一格一张；2026-11-05 一格最多 3 张）。
 *
 * 那 18 格是 `sales_orders` 上的标量列，**没有行**可以挂 `image_id`，所以单独一张
 * `sales_order_slot_images`（一行 = 一格的一张图，唯一键 `(sales_order_id, spec_key, slot_index)`，
 * `slot_index` = 这一格里的第几张）。
 * 语义与 `material_refs` 完全一致：**整块替换**（请求带了这个键就按它对齐全部格子，
 * 没提到的格子 = 取消这一格的图，空数组 = 全部取消；没带 = 整块不动）。
 */
export type SlotImageInput = { spec_key: string; /** 这一格最多 3 张图（2026-11-05），顺序 = 用户看到的顺序；空数组 = 这一格没有图。 */ image_ids?: string[]; /** 旧形状（2026-11-04，一格一张）：等同 `image_ids: [id]`；两者同时出现时 `image_ids` 优先。 */ image_id?: string };

/**
 * `slot_images` 的归一与校验：只留 18 个材料栏位、同一个栏位**后写覆盖先写**、格内最多 3 张。
 *
 * 输出一律是**数组形状** `[{ spec_key, image_ids }]`（请求键契约 §3.1）：落库方按
 * `(spec_key, slot_index)` 逐张对齐，不必再猜调用方给的是单值还是数组。
 *
 * 为什么「不认识的键要报错」而不是静默忽略：静默忽略的表现是「界面上传了图、保存后没了」，
 * 而请求里明明带着那个键 —— 一次点名说出是哪个键，比让人猜强（与 `MATERIAL_REF_KEY_UNSUPPORTED`
 * 同一条纪律：接口是公开的，前端键名写错不该变成一个查不出来的问题）。
 */
export function normalizeSlotImages(input: SlotImageInput[] | null | undefined): SlotImageInput[] {
  const wanted = new Map<string, string[]>();
  for (const row of input ?? []) {
    const specKey = String(row?.spec_key ?? "").trim();
    if (!specKey) throw new UnprocessableEntityException({ code: "SLOT_IMAGE_KEY_UNSUPPORTED", message: "材料格图片缺少 spec_key：图片要挂在材料明细的那一格上", details: [{ spec_key: specKey }] });
    if (!(SPEC_MATERIAL_KEYS as readonly string[]).includes(specKey)) throw new UnprocessableEntityException({ code: "SLOT_IMAGE_KEY_UNSUPPORTED", message: `「${specKey}」不是材料明细的栏位，不能挂图片`, details: [{ spec_key: specKey }] });
    // 空数组是**合法值**（这一格没有图），不再是 422：`slot_images` 是整块替换，"这一格清空"必须表达得出来
    // —— 旧形状里 `image_id: ""` 也按「没有图」认（宁可清掉，也不要把一个空 id 写进外键）。
    // 后写覆盖先写（前端不可能这么发，但接口是公开的）：报错要求调用方先去重只会多一种看不懂的 400。
    wanted.set(specKey, normalizeRowImageIds(row, "slot_images", specKey));
  }
  return [...wanted.entries()].map(([spec_key, image_ids]) => ({ spec_key, image_ids }));
}

/**
 * `slotImages` 行（**一格可能有多行**：一行的 `slotIndex` = 这一格里的第几张）→ 按格聚成数组。
 *
 * 为什么必须在这里聚合：`sales_order_slot_images` 是「一格一张图」的映射表，而返单预览/复制快照
 * 给前端的形状是**请求键**形状（`[{ spec_key, image_ids }]`，§3.3）。不聚合的话前端会看到
 * 同一格出现三条，各自只有一张图 —— 它没法知道这三个是同属一格。
 *
 * 格内按 `slotIndex` 排（不信任数据库返回顺序）：`slotIndex` 就是用户看到的顺序。
 */
function slotImageGroups(rows: ReadonlyArray<{ specKey: string; slotIndex?: number; imageId: string; image?: SalesOrderImageSummary | null }>): Array<{ spec_key: string; image_ids: string[]; images: SalesOrderImageSummary[] }> {
  const grouped = new Map<string, Array<{ slotIndex: number; imageId: string; image: SalesOrderImageSummary | null }>>();
  for (const row of rows) {
    const item = { slotIndex: row.slotIndex ?? 0, imageId: row.imageId, image: row.image ?? null };
    const items = grouped.get(row.specKey);
    if (items) items.push(item);
    else grouped.set(row.specKey, [item]);
  }
  return [...grouped.entries()].map(([spec_key, items]) => {
    const sorted = [...items].sort((left, right) => left.slotIndex - right.slotIndex);
    return { spec_key, image_ids: sorted.map((item) => item.imageId), images: sorted.map((item) => item.image).filter((image): image is SalesOrderImageSummary => Boolean(image)) };
  });
}

/**
 * 「其它」行的归一与校验：去空格、丢整行空、类目必填、内容与引用至少有一个、条数封顶。
 *
 * 为什么「内容与引用至少有一个」在这里挡，而不是让导出侧印一个空格子：工艺单是给工厂照做的，
 * 一行只有类目、右边一格空着，工人只会来问「这个类目到底要什么」。同理**整行空**（类目与内容都空、
 * 也没有引用、**也没有图**）的新增行是「加了行还没填」，提交前丢掉 —— 与 `isBlankSpecDetail` 同一条口径。
 * 2026-11-05 起「有图的行不算空行」（§3.1）：图也是用户填的内容，静默丢掉一张已上传的图比报错更难查。
 *
 * `imageIds`（2026-11-04 的单张 → 2026-11-05 的数组）**只在真的有图时才放进结果**：它不属于
 * 「这一行说了什么」，而既有调用方（返单/复制、导出候选、单测）拿到的形状里没有这个键时不该凭空多一个 `[]`。
 */
export function normalizeMaterialExtras(input: MaterialExtraInput[] | null | undefined): Array<{ label: string; content: string | null; materialId: string | null; specKey: string | null; imageIds?: string[]; sort_order: number }> {
  const rows: Array<{ label: string; content: string | null; materialId: string | null; specKey: string | null; imageIds?: string[]; sort_order: number }> = [];
  for (const [index, row] of (input ?? []).entries()) {
    // 注意顺序：`spec_key` 先解析，因为它决定「类目名」从哪里来。
    const specKey = row?.spec_key ? String(row.spec_key).trim() : null;
    const givenLabel = String(row?.label ?? "").trim();
    const content = String(row?.content ?? "").trim();
    const materialId = row?.material_id ? String(row.material_id) : null;
    const imageIds = normalizeRowImageIds(row, "material_extras", specKey ?? givenLabel);
    if (!givenLabel && !content && !materialId && !imageIds.length) continue;
    if (specKey && !isMaterialCategoryKey(specKey)) throw new UnprocessableEntityException({ code: "MATERIAL_EXTRA_SPEC_KEY_UNSUPPORTED", message: `「其它」第 ${index + 1} 行指定的固定类目「${specKey}」不存在：类目只能是材料明细那 18 项之一`, details: [{ row: index + 1, spec_key: specKey }] });
    // 「再加一款」的行：类目名是**系统常量**，不采用请求里的 label —— 否则纸上可能印着「伞布」，
    // 位置却排在「伞头」后面；那种错车间照做出来才发现，而单子已经下给工厂了。
    const label = specKey ? materialCategoryLabel(specKey) : givenLabel;
    if (!label) throw new UnprocessableEntityException({ code: "MATERIAL_EXTRA_LABEL_REQUIRED", message: `「其它」第 ${index + 1} 行没有类目名：类目印在工艺单的「材料」那一列，不能为空`, details: [{ row: index + 1 }] });
    if (!specKey && label.length > MATERIAL_EXTRA_LABEL_MAX_LENGTH) throw new UnprocessableEntityException({ code: "MATERIAL_EXTRA_LABEL_TOO_LONG", message: `「其它」第 ${index + 1} 行的类目名「${label}」超过 ${MATERIAL_EXTRA_LABEL_MAX_LENGTH} 字（材料那一列只有一格）`, details: [{ row: index + 1, max: MATERIAL_EXTRA_LABEL_MAX_LENGTH }] });
    if (content.length > MATERIAL_EXTRA_CONTENT_MAX_LENGTH) throw new UnprocessableEntityException({ code: "MATERIAL_EXTRA_CONTENT_TOO_LONG", message: `「其它」第 ${index + 1} 行的内容超过 ${MATERIAL_EXTRA_CONTENT_MAX_LENGTH} 字`, details: [{ row: index + 1, max: MATERIAL_EXTRA_CONTENT_MAX_LENGTH }] });
    if (!content && !materialId) throw new UnprocessableEntityException({ code: "MATERIAL_EXTRA_CONTENT_REQUIRED", message: `「其它」第 ${index + 1} 行（${label}）既没有内容也没有引用物料：请至少填一样`, details: [{ row: index + 1 }] });
    rows.push({ label, content: content || null, materialId, specKey, ...(imageIds.length ? { imageIds } : {}), sort_order: row.sort_order ?? rows.length });
  }
  if (rows.length > MATERIAL_EXTRA_LIMIT) throw new UnprocessableEntityException({ code: "MATERIAL_EXTRA_LIMIT_EXCEEDED", message: `「其它」最多 ${MATERIAL_EXTRA_LIMIT} 行（工艺单是一张 A4 纸，再多就印不下了）`, details: [{ max: MATERIAL_EXTRA_LIMIT, count: rows.length }] });
  return rows;
}

/**
 * Prisma 行（**列名** camelCase）→ 37 个细化标量的**请求键**（snake_case）取值。
 *
 * 为什么必须有这一步（2026-09-20 现场问题「材料明细写了、保存了，再打开就没了」）：
 * `SPEC_SCALAR_FIELDS` 是「请求键 → 列」的**单向**表，写入侧按它映射，读出来的一律是列名。
 * 而读取侧（前端表单回填、工艺单导出）是**按请求键取值**的。Prisma 整行直接按请求键读，
 * 除了 `factory`（键名与列名恰好相同）之外**全部拿到 undefined** —— 于是界面上一片空白，
 * 工艺单上「材料 / 明细 / 布量」整块消失。读侧一律先过这个函数，不要再直接吃 Prisma 行。
 *
 * 两种形状都认（先请求键、再列名）：版本快照 `sales_order_versions.snapshot` 存的就是请求键，
 * 而 `prisma.salesOrder` 给的是列名——两种都在这个库里真实存在，认两种比逼调用方先转换安全。
 */
export function specScalarRow(row: Record<string, unknown>): Record<SpecScalarKey, string | null> {
  const values = {} as Record<SpecScalarKey, string | null>;
  for (const [key, column] of SPEC_SCALAR_FIELDS) {
    const fromRequestKey = row[key];
    const raw = fromRequestKey === undefined || fromRequestKey === null ? row[column] : fromRequestKey;
    values[key] = raw === undefined || raw === null ? null : String(raw);
  }
  return values;
}

/**
 * 单位归一：把「同一个单位的几种写法」认成一种。
 *
 * 为什么必须有这一步：模板样本1 的表头是 `1960支`、伞布明细里写的是 `100pcs` —— 是同一个单位；
 * 不做归一，「明细数量合计 = 单头数量」这条真规则会被误判成「跨单位无法核对」，功能等于废掉。
 * 样本2 的表头与明细都是 `打`，本来就一致。
 *
 * 只归一并集明确的同义写法，**不做单位换算**（打 → 支 这种换算需要每款伞的装箱数，系统里没有，
 * 猜一个数去比只会给出一个看起来合理但错的提示）。
 */
const PIECE_UNITS = new Set(["pcs", "pc", "piece", "pieces", "支", "只", "个", "把"]);
const DOZEN_UNITS = new Set(["dz", "doz", "dozen", "打"]);

export function normalizeSpecUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  const key = unit.trim().toLowerCase().replace(/[.。]$/, "");
  if (!key) return null;
  if (PIECE_UNITS.has(key)) return "piece";
  if (DOZEN_UNITS.has(key)) return "dozen";
  return key;
}

type SalesOrderBaseInput = { order_no: string; customer_id: string; contact_id?: string; customer_po_no?: string; external_contract_no?: string; order_date: string; product_name: string; product_spec?: string; quantity: string; unit: string; delivery_date?: string; currency: string; unit_price?: string; total_amount?: string; tax_rate?: string; settlement_unit_price?: string; receivable_amount?: string; settlement_method?: string; local_currency_amount?: string; extension_data?: Record<string, unknown>; /** 货号：空串 = 清除（落 NULL），与 37 个细化标量同一语义。 */ item_no?: string | null; /** 返单来源销售单号：只在「返单建单」时写入，见 T05 的复制语义。 */ reorder_from_order_no?: string | null };
type SalesOrderInput = SalesOrderBaseInput & SpecScalarFields & { spec_details?: SpecDetailInput[]; material_refs?: MaterialRefInput[]; /** 「材料明细 → 其它」的自定义类目行（2026-10-08）：整块替换，见 `normalizeMaterialExtras`。 */ material_extras?: MaterialExtraInput[]; /** 18 个材料格各自的图（2026-11-04）：整块替换，见 `normalizeSlotImages`。 */ slot_images?: SlotImageInput[]; /** 细分明细的自定义列名（2026-09-30）：`{ 列键: 列名 }`，空串/空对象 = 用默认列名。 */ spec_detail_labels?: Record<string, string> };
/**
 * 更新载荷**排除** `reorder_from_order_no`：返单来源是既成事实，改它就是篡改返单链的出处
 * （「这张单是从哪张返来的」必须永远回答得出来）。控制器侧的 `UpdateSalesOrderDto` 也没有这个键，
 * 两处一起挡：类型层面挡住自己人，DTO 层面挡住外部请求。
 *
 * `order_no` 曾经也在这份排除名单里 —— 那是 2026-09-30 之前的口径，用户为此吃过一次静默丢数据：
 * 界面那一格可编辑、`save()` 却 `delete payload.order_no`（`sales-order-editor.tsx:374`），
 * 于是"改完点保存、提示已保存、号还是旧的"。现在**允许改**，但不是把它当普通字段写：
 * 它要经过 `renameSalesOrderNo` 全链联动（38 张表 + 返单来源引用 + 版本快照），
 * 理由见 `apps/api/src/modules/sales/sales-order-order-no.ts` 的文件头。
 *
 * `customer_id` 仍不可改（既有口径：客户快照一旦下给工厂就不能换头）。
 */
type SalesOrderUpdate = Partial<Omit<SalesOrderInput, "customer_id" | "reorder_from_order_no">> & { reason?: string };

/**
 * 一次保存里可能带图片的三处载荷（2026-11-04）：18 格映射、明细行、「其它」行。
 * 图片 id 的集合只从这三处取（见 `imageIdsOf`），所以「有没有图片」只有一个判定口径。
 */
type SalesOrderImagePayload = { slot_images?: SlotImageInput[]; spec_details?: SpecDetailInput[]; material_extras?: MaterialExtraInput[] };

// ------------------------------------------------------------------ 「核心字段锁」按实际改动判定（2026-11-05 第二轮）
//
// 用户原话：「建立了 BOM 表之后，还能编辑销售单中的图片」。
//
// 背景：编辑器每次保存都会把整份表单发上来（37 个细化标量 + 下面这 11 个核心字段），因为
// 「空串 = 清除这一格」必须表达得出来。而旧守卫只问「请求里带没带这个键」——
// 于是**只改了图片的保存也会被当成改核心字段**，被 BOM 挡住：换图/删图怎么点都存不上。
//
// 修法：比**值**，不比**键**。核心字段的真实值没变，就没有任何下游事实需要重算，
// BOM/采购/生产的锁不该被「整份回传」触发。反向也成立：真改了数量/单价，锁照旧生效。

/** 动了就要重算下游的核心字段（与控制器 DTO 无关；已关闭单的货号/订单号是例外，见 `update`）。 */
export const CORE_LOCK_FIELDS = ["product_name", "product_spec", "quantity", "unit", "currency", "unit_price", "total_amount", "tax_rate", "settlement_unit_price", "receivable_amount", "local_currency_amount"] as const;
export type CoreLockField = (typeof CORE_LOCK_FIELDS)[number];

/** 请求键 → `this.get()` 返回的 Prisma 列名。 */
const CORE_FIELD_COLUMN: Record<CoreLockField, string> = {
  product_name: "productName",
  product_spec: "productSpec",
  quantity: "quantity",
  unit: "unit",
  currency: "currency",
  unit_price: "unitPrice",
  total_amount: "totalAmount",
  tax_rate: "taxRate",
  settlement_unit_price: "settlementUnitPrice",
  receivable_amount: "receivableAmount",
  local_currency_amount: "localCurrencyAmount",
};

/** 这些核心字段是 Decimal 列：`"100"` 与 `"100.0000"` 是同一个数，不能因为写法不同就算改动。 */
const CORE_DECIMAL_FIELDS: ReadonlySet<CoreLockField> = new Set(["quantity", "unit_price", "total_amount", "tax_rate", "settlement_unit_price", "receivable_amount", "local_currency_amount"]);

/** 文本类核心字段的比较口径：null / undefined / 空串都等于「没有值」，首尾空白不算改动。 */
function coreText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

/** Decimal 的规范写法；空 = null；解析不了就退化成原文（不比出「相等」而漏拦，宁可当改动）。 */
function coreDecimal(value: unknown): string | null {
  const text = coreText(value);
  if (!text) return null;
  try {
    return new Prisma.Decimal(text).toString();
  } catch {
    return `invalid:${text}`;
  }
}

/**
 * 这次保存有没有**真的**改动核心字段（值变了，而不是请求里带了键）。
 *
 * 纯函数、单独导出：便于单测直接钉住两种数/空值的比较口径。
 */
export function coreFieldsActuallyChanged(current: Record<string, unknown>, input: Record<string, unknown>): boolean {
  return CORE_LOCK_FIELDS.some((field) => {
    const next = input[field];
    if (next === undefined) return false;
    const previous = current[CORE_FIELD_COLUMN[field]];
    return CORE_DECIMAL_FIELDS.has(field) ? coreDecimal(next) !== coreDecimal(previous) : coreText(next) !== coreText(previous);
  });
}

@Injectable()
export class SalesOrdersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Optional() private readonly currencies?: CurrencyService) {}

  async list(page = 1, pageSize = 20, search?: string, status?: string) {
    const where = { deletedAt: null, ...(status ? { status } : {}), ...(search ? { OR: [{ orderNo: { contains: search, mode: "insensitive" as const } }, { productName: { contains: search, mode: "insensitive" as const } }, { itemNo: { contains: search, mode: "insensitive" as const } }] } : {}) };
    const [data, total] = await this.prisma.$transaction([this.prisma.salesOrder.findMany({ where, orderBy: { updatedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize, include: { customer: true, contact: true, boms: { where: { deletedAt: null }, select: { id: true, version: true, status: true } } } }), this.prisma.salesOrder.count({ where })]);
    return { data, total };
  }

  /**
   * 货号候选（销售单编辑器的「可挑可输」输入框用）。
   *
   * 按 `itemNo` 列去重：`groupBy` 出来的行是**列值**分组的，所以 `27621` 与 `27621 ` 会各占一行 ——
   * 这里是**建议**用途，不做跨行归并（归并要读全部行，代价不成比例）；真正的分组归并在返单与总结模块。
   * 空货号（null）不进候选：它不是可选项，而是「还没填」。
   */
  async itemNoOptions(q?: string, limit = 50) {
    const take = Math.min(Math.max(limit || 50, 1), 200);
    const search = (q ?? "").trim();
    const rows = await this.prisma.salesOrder.groupBy({
      by: ["itemNo"],
      where: { deletedAt: null, itemNo: { not: null, ...(search ? { contains: search, mode: "insensitive" as const } : {}) } },
      _count: { _all: true },
    });
    return rows
      .filter((row): row is typeof row & { itemNo: string } => row.itemNo !== null)
      .map((row) => ({ item_no: row.itemNo, item_no_key: itemNoKey(row.itemNo), order_count: row._count._all }))
      .sort((left, right) => right.order_count - left.order_count || left.item_no.localeCompare(right.item_no))
      .slice(0, take);
  }

  async get(id: string) {
    const order = await this.prisma.salesOrder.findFirst({ where: { id, deletedAt: null }, include: { customer: true, contact: true, versions: { orderBy: { version: "desc" } }, boms: { where: { deletedAt: null }, orderBy: { version: "desc" } }, specDetails: { where: { deletedAt: null }, orderBy: { sortOrder: "asc" }, include: { image: { select: SALES_ORDER_IMAGE_SUMMARY }, image2: { select: SALES_ORDER_IMAGE_SUMMARY }, image3: { select: SALES_ORDER_IMAGE_SUMMARY } } }, materialRefs: MATERIAL_REF_INCLUDE, materialExtras: MATERIAL_EXTRA_INCLUDE,
      // 18 格各自的图 + 行上的图摘要（2026-11-04；2026-11-05 一格最多 3 张）：只取摘要、绝不取 `data`
      // （编辑页每次打开都拉这个接口）。关系名用 Prisma 列名 `slotImages`（与 `specDetails` 同一个口径，
      // 不另起 snake_case 别名）。
      // 排序必须带上 `slotIndex`：同一格有多张图时，界面与工艺单上的顺序就是 `slotIndex` 的顺序，
      // 只按 `specKey` 排的话同一格三张图之间的先后由数据库返回顺序决定 —— 那种"每次打开顺序都不一样"
      // 的错在界面上看起来像随机的。
      slotImages: { where: { deletedAt: null }, orderBy: [{ specKey: "asc" }, { slotIndex: "asc" }], include: { image: { select: SALES_ORDER_IMAGE_SUMMARY } } } } });
    if (!order) throw new NotFoundException({ code: "SALES_ORDER_NOT_FOUND", message: "销售单不存在", details: [] });
    // 引用走 `materialRefs`（列名，与 `specDetails` 同一个形状），**不另起一个 snake_case 别名**：
    // 37 个细化标量当年就是因为「读侧有两套键名」而丢过数据（见 specScalarRow 的注释），
    // 这里是嵌套关系不是标量，一种键名就够，多一份只会让下一个读的人再犯一次同样的错。
    return { ...order, spec_quantity_notice: this.specQuantityNotice(order) };
  }

  // ------------------------------------------------------------------
  // 行图片：上传 / 读取（2026-11-04，设计文档 §2.1–§2.2）
  // ------------------------------------------------------------------

  /**
   * 上传一张「这一单的行图片」（`POST /sales-orders/:id/images`，multipart 字段名 `file`）。
   *
   * 图片是**独立的库行**而不是挂在材料行/明细行上：那两处的替换语义是「软删旧的 + 建新的」，
   * 行 id 每次保存都会变（理由见 schema 的 `SalesOrderImage` 注释）。所以上传一次、保存只搬指针。
   *
   * 校验复用 `validateMaterialImage`：**不信 Content-Type / 扩展名**，解开 RIFF 容器读真实尺寸
   * （≤2MB、边长 ≤2000）。错误码沿用 `MATERIAL_IMAGE_*` —— 与物料清单上传同一套文案，用户不用学两套。
   *
   * 回执按设计文档给 **snake_case**（`byte_size` / `updated_at`）：它是「上传结果」而不是 Prisma 行，
   * 与前端 `uploadMaterialImage` 拿到的形状保持同一套读法。
   */
  async setImage(id: string, file: { buffer?: Buffer; originalname?: string; mimetype?: string } | undefined, user: CurrentUser) {
    // 前置：销售单存在且未删除。图片按单隔离，没有单就没有归属（新建单保存前不能传图，§4.1）。
    const order = await this.prisma.salesOrder.findFirst({ where: { id, deletedAt: null }, select: { id: true, orderNo: true } });
    if (!order) throw new NotFoundException({ code: "SALES_ORDER_NOT_FOUND", message: "销售单不存在", details: [] });
    const checked = validateMaterialImage(file?.buffer);
    if (!checked.ok) throw new UnprocessableEntityException({ code: checked.code, message: checked.message, details: [] });
    // 自己分配 `ArrayBuffer` 再 `set`：Prisma 的 `Bytes` 列要 `Uint8Array<ArrayBuffer>`，
    // 而 multer 给的 `Buffer` 是宽类型（与 procurement 的 setMaterialImage 同一条写法）。
    const source = file!.buffer!;
    const data = new Uint8Array(source.byteLength);
    data.set(source);
    const sha256 = createHash("sha256").update(data).digest("hex");
    // 上传回执要带 `updated_at`（§2.1），所以这里在共享摘要上多取一个 `updatedAt`；
    // 读侧（详情/返单/复制）仍然只用五个字段的摘要（少一个键就少一处 deepEqual 跟着变）。
    const saved = await this.prisma.salesOrderImage.create({ data: { salesOrderId: id, data, mimeType: "image/webp", width: checked.width, height: checked.height, byteSize: data.length, sha256, ...this.audit.create(user) }, select: { ...SALES_ORDER_IMAGE_SUMMARY, updatedAt: true } });
    // 审计只记元数据（宽高 / 字节数 / sha），**不记字节**：图片内容属于行数据，不是审计事件要存的东西。
    await this.audit.record("sales_order.image_uploaded", "sales_order", user.id, id, { order_no: order.orderNo, image_id: saved.id, width: checked.width, height: checked.height, byte_size: data.length, sha256: saved.sha256 });
    return { id: saved.id, width: saved.width, height: saved.height, byte_size: saved.byteSize, sha256: saved.sha256, updated_at: saved.updatedAt };
  }

  /**
   * 读一张行图片的字节（`GET /sales-orders/:id/images/:imageId`）。
   *
   * 归属校验在 SQL 里一起做（`salesOrderId` 是 where 的一部分）：不属于这张单的 image id
   * 与不存在的 id 得到**同一个 404** —— 不给「这个 id 存在、只是不是你的」这种可枚举信息。
   */
  async image(id: string, imageId: string) {
    const row = await this.prisma.salesOrderImage.findFirst({ where: { id: imageId, salesOrderId: id, deletedAt: null }, select: { data: true, sha256: true, mimeType: true } });
    if (!row) throw new NotFoundException({ code: "SALES_ORDER_IMAGE_NOT_FOUND", message: "图片不存在或不属于这张销售单", details: [{ sales_order_id: id, image_id: imageId }] });
    return { data: Buffer.from(row.data), sha256: row.sha256, mimeType: row.mimeType };
  }

  /**
   * 明细数量合计 vs 单头数量。
   *
   * 模板两张样本都成立（样本1：12 款花色合计 1960 = 表头 1960支；样本2：15 款伞头 × 167打 = 2505打），
   * 所以它是一条**真规则**，值得在下单时提示。但**不做硬校验**：数量单位在明细里可能是支/pcs、
   * 表头可能是打，跨单位相加没有意义（与全站「不跨单位合计」一致）。单位对不上时返回「无法核对」。
   */
  private specQuantityNotice(order: { quantity: Prisma.Decimal; unit: string; specDetails: { quantity: Prisma.Decimal | null; unit: string | null }[] }): string | null {
    const lines = order.specDetails.filter((line) => line.quantity !== null);
    if (!lines.length) return null;
    // 明细没写单位时按表头单位算（模板里明细的单位列常常留空，与表头同单位）。
    const headUnit = normalizeSpecUnit(order.unit);
    const comparable = lines.every((line) => { const unit = normalizeSpecUnit(line.unit); return unit === null || unit === headUnit; });
    if (!comparable) return `明细数量与单头数量无法核对：明细单位与单头单位（${order.unit}）不一致，跨单位不做合计。`;
    const total = lines.reduce((sum, line) => sum.plus(line.quantity ?? 0), new Prisma.Decimal(0));
    if (total.eq(order.quantity)) return null;
    return `明细数量合计 ${total.toString()} 与单头数量 ${order.quantity.toString()} ${order.unit} 不一致，请核对。`;
  }

  /**
   * 解析返单来源单并做三条守卫（老板 2026-09-26：「以后客户返单，从系统里面调取，返单客户货号不变」）。
   *
   * 三条守卫都是**业务不可能绕开**的：
   *   1. 来源必须存在且未删除 —— 否则「这张单从哪返来的」无从回答；
   *   2. 来源必须是**已确认或已关闭**：草稿单还没下给工厂，拿它返单等于复制一份没做过的东西；
   *   3. 来源必须**有货号** —— 老板要的是「返单货号不变」，来源没货号就变不出来，
   *      硬返出一张没货号的单会把「按货号调取历次批次」这条链断在这里。
   *      文案带上单号：现场一眼知道该去补哪张单。
   */
  async resolveReorderSource(orderNo: string) {
    const source = await this.prisma.salesOrder.findFirst({
      where: { orderNo, deletedAt: null },
      include: {
        // 行上的图摘要（2026-11-04；2026-11-05 每行最多 3 张）：返单预览要能在界面上显示「上一批这一行
        // 挂的是哪几张图」；建单时按这些 id 把字节**复制**成新单自己的图（见 `bindOrderImages`），
        // 所以这里只要摘要不要字节。
        specDetails: { where: { deletedAt: null }, orderBy: { sortOrder: "asc" }, include: { image: { select: SALES_ORDER_IMAGE_SUMMARY }, image2: { select: SALES_ORDER_IMAGE_SUMMARY }, image3: { select: SALES_ORDER_IMAGE_SUMMARY } } },
        // 引用带上物料摘要：返单预填要能在界面上把「引用的是哪个物料」显示出来（芯片/图片），
        // 只给一个 UUID 的话前端还得再查一次物料池，而物料池可能拉不到。
        materialRefs: { where: { deletedAt: null }, include: { material: { select: { id: true, materialCode: true, name: true, specificationModel: true, color: true, image: { select: { sha256: true, updatedAt: true } } } } } },
        // 「其它」行（2026-10-08）与引用带上同样的物料摘要：返单预填要能在界面上把「引用的哪个物料」
        // 直接显示出来（芯片/缩略图），不依赖物料池那一次请求成不成功。
        materialExtras: MATERIAL_EXTRA_INCLUDE,
        // 18 格各自的图（2026-11-04；2026-11-05 一格最多 3 张）：同一句话，预览带摘要、建单按 id 克隆字节。
        slotImages: { where: { deletedAt: null }, orderBy: [{ specKey: "asc" }, { slotIndex: "asc" }], include: { image: { select: SALES_ORDER_IMAGE_SUMMARY } } },
      },
    });
    if (!source) throw new NotFoundException({ code: "REORDER_SOURCE_NOT_FOUND", message: `返单来源销售单不存在：${orderNo}`, details: [{ order_no: orderNo }] });
    if (!["confirmed", "closed"].includes(source.status)) throw new UnprocessableEntityException({ code: "REORDER_SOURCE_NOT_CONFIRMED", message: `只有已确认或已关闭的销售单可以返单：${orderNo} 当前是「${source.status}」`, details: [{ order_no: orderNo, status: source.status }] });
    if (!source.itemNo) throw new UnprocessableEntityException({ code: "REORDER_SOURCE_ITEM_NO_MISSING", message: `来源单 ${orderNo} 没有货号：请先给它补货号，再返单`, details: [{ order_no: orderNo }] });
    return source;
  }

  /**
   * 返单预览：把「会带过来什么 / 必须重填什么」摆给编辑器，**不建单**。
   *
   * `must_fill` 与 `warnings` 由服务端给（前端只展示）：这样「必须重填哪几格」只有一处定义，
   * 前端自己拼条件必然与后端漂移（漂移的后果是按钮亮着、点了 422）。
   */
  async reorderPreview(orderNo: string) {
    const source = await this.resolveReorderSource(orderNo);
    const spec = specScalarRow(source as unknown as Record<string, unknown>);
    const warnings: string[] = [];
    if (source.unitPrice) warnings.push(`单价沿用上次（${source.unitPrice.toString()} ${source.currency}），请复核`);
    warnings.push("应收金额 / 本币金额不沿用（它们与数量绑定），保存后按新的数量重新计算");
    return {
      source_order_no: source.orderNo,
      source_order_id: source.id,
      item_no: source.itemNo,
      customer: source.customerSnapshot,
      customer_id: source.customerId,
      contact_id: source.contactId,
      copy: {
        product_name: source.productName,
        product_spec: source.productSpec,
        unit: source.unit,
        currency: source.currency,
        customer_po_no: source.customerPoNo,
        external_contract_no: source.externalContractNo,
        unit_price: source.unitPrice?.toString() ?? null,
        settlement_unit_price: source.settlementUnitPrice?.toString() ?? null,
        tax_rate: source.taxRate?.toString() ?? null,
        settlement_method: source.settlementMethod,
        ...spec,
        spec_details: source.specDetails.map((row) => ({ group_name: row.groupName, name: row.name, color: row.color, barcode: row.barcode, quantity: row.quantity?.toString() ?? null, unit: row.unit, sort_order: row.sortOrder, ...imageCopyFields(rowImageIds(row), rowImageSummaries(row)) })),
        material_refs: source.materialRefs.map((row) => ({ spec_key: row.specKey, material_id: row.materialId, material: row.material })),
        // 「其它」行照抄（含引用的物料摘要）：返单就是沿用上一批的完整材料口径。
        material_extras: source.materialExtras.map((row) => ({ label: row.label, content: row.content, material_id: row.materialId, ...(row.specKey ? { spec_key: row.specKey } : {}), sort_order: row.sortOrder, material: row.material, ...imageCopyFields(rowImageIds(row), rowImageSummaries(row)) })),
        // 18 格各自的图（2026-11-04；2026-11-05 一格最多 3 张）：预览给摘要（界面显示），
        // 建单时服务端把字节复制成新单的图。
        slot_images: slotImageGroups(source.slotImages ?? []).map((group) => ({ spec_key: group.spec_key, ...imageCopyFields(group.image_ids, group.images) })),
      },
      must_fill: ["order_no", "order_date", "quantity", "delivery_date"],
      warnings,
    };
  }

  /**
   * 普通复制快照（2026-10-11）：把一张既有单的「详情」整块摆给新建页，**不建单、不记来源**。
   *
   * 用户原话：「就是订单描述基本差不多，可以直接用原有的复制，然后我们改下单号和里面的细节就行了」。
   *
   * 复制清单与返单 `reorderPreview()` 是同一份（"这一单卖的是什么"照抄；"卖多少 / 什么时候交 /
   * 由数量派生的金额 / 走到哪了"一律不带），差别只有三处口径，都是用户拍板的：
   *   1. **不限状态**、草稿也能复制 —— 普通复制不是"拿一张下过工厂的单再返一批"，而是"照着上一张改细节"；
   *   2. **不要求货号** —— 返单分组的钥匙是货号，普通复制不归组，没有货号照样能复制；
   *   3. **不写 `reorder_from_order_no`** —— 写了新单就会被归进返单分组，销售会以为这是客户返单。
   *      这一格是复制这条路上最容易埋错的一处，所以两头一起挡：**这个方法的返回里没有来源键**，
   *      建单走的标准 `POST /sales-orders` 也只在请求显式带 `reorder_from_order_no` 时才记来源。
   *
   * 为什么是「快照」而不是 `createFromCopy()`：建单必须走标准 `create()`（理由见 `reorderInput`——
   * 另写一条建单路径会绕过币种校验、客户解析、物料存在性与唯一键冲突处理）。前端把 `copy` **一次性**
   * 预填进新建页，用户改完订单号与细节后按普通新建单保存。
   *
   * 引用过滤复用返单那两个函数（`usableMaterialRefs` / `usableMaterialExtras`）：一张旧单引用的物料
   * 可能已被删，不过滤的话新建页会在 `MATERIAL_NOT_FOUND` 上卡死，而复制这条路**没有"重选"这个动作**
   * （用户甚至不知道是哪一格）。剔掉什么放在 `dropped` 里回报，不静默吞。
   */
  async copySnapshot(id: string) {
    const source = await this.prisma.salesOrder.findFirst({
      where: { id, deletedAt: null },
      include: {
        // 行上的图摘要（2026-11-04；2026-11-05 每行最多 3 张）：复制快照要能显示「上一批这一行挂的是哪几张图」；
        // 新单保存时按这些 id 把字节**复制**成新单自己的图，所以这里只要摘要不要字节。
        specDetails: { where: { deletedAt: null }, orderBy: { sortOrder: "asc" }, include: { image: { select: SALES_ORDER_IMAGE_SUMMARY }, image2: { select: SALES_ORDER_IMAGE_SUMMARY }, image3: { select: SALES_ORDER_IMAGE_SUMMARY } } },
        // 引用带物料摘要（芯片 / 缩略图）：预填时要能在界面上把「引的是哪个物料」显示出来，
        // 只给 UUID 的话前端还得再查一次物料池，而物料池可能拉不到。与 `resolveReorderSource` 同一取舍。
        materialRefs: { where: { deletedAt: null }, include: { material: { select: { id: true, materialCode: true, name: true, specificationModel: true, color: true, image: { select: { sha256: true, updatedAt: true } } } } } },
        materialExtras: MATERIAL_EXTRA_INCLUDE,
        // 18 格各自的图（2026-11-04；2026-11-05 一格最多 3 张）：同一句话，快照带摘要、建单按 id 克隆字节。
        slotImages: { where: { deletedAt: null }, orderBy: [{ specKey: "asc" }, { slotIndex: "asc" }], include: { image: { select: SALES_ORDER_IMAGE_SUMMARY } } },
      },
    });
    // 文案带 id：这张单是用户从列表点进来的，说不清"哪一张"就无从排查（返单那边带的是单号）。
    if (!source) throw new NotFoundException({ code: "COPY_SOURCE_NOT_FOUND", message: "复制来源销售单不存在（可能已被删除）", details: [{ id }] });
    const spec = specScalarRow(source as unknown as Record<string, unknown>);
    // 先按请求键投影，再过滤（过滤函数只认 spec_key/material_id，返回的也只有这两个键）；
    // `material` 摘要随后按 material_id 回挂 —— 不回挂的话界面上的芯片与缩略图就没了，
    // 而那一刻前端还以为"这一格本来就没引用物料"。
    const refs = await this.usableMaterialRefs(source.materialRefs.map((row) => ({ spec_key: row.specKey, material_id: row.materialId })));
    const refMaterials = new Map(source.materialRefs.map((row) => [row.materialId, row.material]));
    const extras = await this.usableMaterialExtras(source.materialExtras.map((row) => ({ label: row.label, content: row.content, material_id: row.materialId, ...(row.specKey ? { spec_key: row.specKey } : {}), sort_order: row.sortOrder, ...imageCopyFields(rowImageIds(row), rowImageSummaries(row)) })));
    const extraMaterials = new Map(source.materialExtras.filter((row) => row.materialId).map((row) => [row.materialId as string, row.material]));
    const warnings: string[] = [];
    // 与返单同一句警告：单价属于"这一单卖的是什么"照抄，但新一批的成本口径可能已经变了，必须复核。
    if (source.unitPrice) warnings.push(`单价沿用上次（${source.unitPrice.toString()} ${source.currency}），请复核`);
    warnings.push("应收金额 / 本币金额不沿用（它们与数量绑定），保存后按新的数量重新计算");
    if (refs.dropped.length) warnings.push(`来源单引用的物料已不存在，复制时已跳过：${refs.dropped.join("、")}`);
    if (extras.dropped.length) warnings.push(`「其它」行引用的物料已不存在，复制时只保留了文字：${extras.dropped.join("、")}`);
    return {
      source_order_no: source.orderNo,
      source_order_id: source.id,
      // 来源状态回给前端只为横幅上说清"照的是哪一版"（草稿也能复制），不做任何门槛。
      source_status: source.status,
      customer: source.customerSnapshot,
      customer_id: source.customerId,
      contact_id: source.contactId,
      // `copy` 的键名一律用**请求键**（与版本快照、返单预览同形状）：前端 `specFromOrder` /
      // `materialRefsFromOrder` / `materialExtrasFromOrder` 三种形状都认，返单与复制于是共用同一套灌法。
      // 数量 / 下单日 / 交期 / 订单号 / 金额三兄弟**故意不在这里**：请求键"没有"比"给了个空值"更难被误用。
      copy: {
        item_no: source.itemNo,
        product_name: source.productName,
        product_spec: source.productSpec,
        unit: source.unit,
        currency: source.currency,
        customer_po_no: source.customerPoNo,
        external_contract_no: source.externalContractNo,
        unit_price: source.unitPrice?.toString() ?? null,
        settlement_unit_price: source.settlementUnitPrice?.toString() ?? null,
        tax_rate: source.taxRate?.toString() ?? null,
        settlement_method: source.settlementMethod,
        extension_data: source.extensionData,
        ...spec,
        spec_details: source.specDetails.map((row) => ({ group_name: row.groupName, name: row.name, color: row.color, barcode: row.barcode, quantity: row.quantity?.toString() ?? null, unit: row.unit, sort_order: row.sortOrder, ...imageCopyFields(rowImageIds(row), rowImageSummaries(row)) })),
        material_refs: refs.refs.map((row) => ({ ...row, material: refMaterials.get(row.material_id) ?? null })),
        // 「其它」行照抄；失效引用只摘引用、**保留那一行**（用户自己写的规格说明不该因为物料被删就丢掉）。
        // 行图（`image_ids`/`images`/镜像的 `image_id`+`image`）跟着行一起走：
        // `usableMaterialExtras` 只摘 `material_id`，不动图。
        material_extras: extras.extras.map((row) => ({ ...row, material: row.material_id ? extraMaterials.get(row.material_id) ?? null : null })),
        // 18 格各自的图（2026-11-04；2026-11-05 一格最多 3 张）：快照给摘要，新单保存时按 id 把字节
        // 复制成新单自己的图。
        slot_images: slotImageGroups(source.slotImages ?? []).map((group) => ({ spec_key: group.spec_key, ...imageCopyFields(group.image_ids, group.images) })),
        // 明细列名属于工艺口径的一部分，跟着来源单（与返单同一条）。
        spec_detail_labels: source.specDetailLabels ?? {},
      },
      must_fill: ["order_no", "order_date", "quantity", "delivery_date"],
      dropped: { material_refs: refs.dropped, material_extras: extras.dropped },
      warnings,
    };
  }

  /**
   * 返单的复制语义：**请求给了就用请求的，没给就沿用来源单**（`??` 逐键判定）。
   *
   * 复制什么、不复制什么是一张**逐条的清单**（见设计文档 §三.1），规律只有一条：
   *   * 「这一单卖的是什么」→ 复制（货号、客户、产品、工艺、明细、材料引用、结算口径）；
   *   * 「这一单卖多少、什么时候交」→ **不复制**（数量、下单日、交期）；
   *   * 「由数量派生的金额」→ **不复制**（总额、应收、本币金额）：抄过来必然与新的数量矛盾，
   *     而矛盾会一路传到应收来源；
   *   * 「这一单走到哪了」→ **不复制**（状态、版本号、BOM、下游事实）。
   *
   * 为什么走 `create()` 而不是另写一个 `createFromReorder()`：后者会绕过币种校验、
   * 客户/联系人解析、材料存在性校验与唯一键冲突处理（`ORDER_NO_CONFLICT`）。
   * 那类绕过不会当场报错，只会在几个月后以「返单能建出一张没有客户的单」的形式爆掉。
   */
  private reorderInput(source: Awaited<ReturnType<SalesOrdersService["resolveReorderSource"]>>, input: SalesOrderInput): SalesOrderInput {
    const requested = input as unknown as Record<string, unknown>;
    const copied: Record<string, unknown> = {};
    // 37 个细化标量：每个键单独判定（请求没带 = 沿用来源单的当前值）。
    for (const [key, column] of SPEC_SCALAR_FIELDS) copied[key] = requested[key] !== undefined ? requested[key] : (source as unknown as Record<string, unknown>)[column] ?? null;
    return {
      ...input,
      customer_id: input.customer_id ?? source.customerId,
      contact_id: input.contact_id ?? source.contactId ?? undefined,
      product_name: input.product_name ?? source.productName,
      product_spec: input.product_spec ?? source.productSpec ?? undefined,
      unit: input.unit ?? source.unit,
      currency: input.currency ?? source.currency,
      customer_po_no: input.customer_po_no ?? source.customerPoNo ?? undefined,
      external_contract_no: input.external_contract_no ?? source.externalContractNo ?? undefined,
      settlement_method: input.settlement_method ?? source.settlementMethod ?? undefined,
      unit_price: input.unit_price ?? source.unitPrice?.toString(),
      settlement_unit_price: input.settlement_unit_price ?? source.settlementUnitPrice?.toString(),
      tax_rate: input.tax_rate ?? source.taxRate?.toString(),
      extension_data: input.extension_data ?? (source.extensionData as Record<string, unknown>),
      item_no: input.item_no ?? source.itemNo,
      reorder_from_order_no: source.orderNo,
      // 行上的图（2026-11-05）：请求没带就照抄来源单的图 id **数组**（§3.1 的请求键形状）。
      // 只带 id、不带摘要：字节由 `create()` 里的 `bindOrderImages` 逐张复制成新单自己的图（不许跨单引用）。
      spec_details: input.spec_details ?? source.specDetails.map((row) => ({ group_name: row.groupName, name: row.name, color: row.color ?? undefined, barcode: row.barcode ?? undefined, quantity: row.quantity?.toString(), unit: row.unit ?? undefined, sort_order: row.sortOrder, ...rowImageIdsPayload(rowImageIds(row)) })),
      material_refs: input.material_refs ?? source.materialRefs.map((row) => ({ spec_key: row.specKey, material_id: row.materialId })),
      // 「其它」行同一条复制语义（请求给了就用请求的，没给就沿用来源单）。
      material_extras: input.material_extras ?? source.materialExtras.map((row) => ({ label: row.label, content: row.content, material_id: row.materialId, ...(row.specKey ? { spec_key: row.specKey } : {}), sort_order: row.sortOrder, ...rowImageIdsPayload(rowImageIds(row)) })),
      // 18 格各自的图（2026-11-04；2026-11-05 一格最多 3 张）：请求没带就照抄来源单，按格聚成数组
      // （同一格的 `slotIndex` 0/1/2 三行必须并回一条 `{ spec_key, image_ids }`，否则落库时会被当成三格）。
      // `?.` 是给单测里的旧夹具留的（它们没有这个关系字段）—— 真实 Prisma 查询一定带数组。
      slot_images: input.slot_images ?? (source.slotImages ? slotImageGroups(source.slotImages).map((group) => ({ spec_key: group.spec_key, image_ids: group.image_ids })) : undefined),
      // 返单沿用来源单的明细列名（返单就是把上一批的工艺口径带过来，列名属于这个口径的一部分）。
      spec_detail_labels: input.spec_detail_labels ?? (source.specDetailLabels as Record<string, string> | undefined),
      ...(copied as Record<string, never>),
    };
  }

  /**
   * 复制引用时把**已经不存在**的物料剔掉。
   *
   * 为什么必须有这一步：物料主数据是可以被删的，而一张几年前的来源单完全可能引用过它。
   * 不过滤的话，整张返单会被一个**用户在界面上看不见**的旧引用卡死
   * （`assertMaterialsExist` 抛 MATERIAL_NOT_FOUND，提示还叫人「刷新物料清单后重选」——
   * 而复制的这条路根本没有"重选"这个动作）。剔掉的栏位会回报给调用方，不静默吞掉。
   */
  private async usableMaterialRefs(refs: MaterialRefInput[]): Promise<{ refs: MaterialRefInput[]; dropped: string[] }> {
    if (!refs.length) return { refs, dropped: [] };
    const ids = [...new Set(refs.map((ref) => ref.material_id))];
    const found = await this.prisma.material.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } });
    const known = new Set(found.map((row) => row.id));
    return { refs: refs.filter((ref) => known.has(ref.material_id)), dropped: refs.filter((ref) => !known.has(ref.material_id)).map((ref) => ref.spec_key) };
  }

  /**
   * 复制「其它」行时把**已经不存在**的物料引用剔掉，但**保留那一行**（与 18 格的引用不同）。
   *
   * 差别是有意的：18 格的引用被剔掉后剩下的是一格文字（可能为空 → 整行不印），而「其它」行的
   * 内容是用户自己写的规格说明 —— 物料被删掉不该连字一起丢掉，只把那个引用去掉。
   * 剔掉的行回报给调用方（`dropped` 存类目名，用户才知道是哪一行），不静默吞掉。
   */
  private async usableMaterialExtras(extras: MaterialExtraInput[]): Promise<{ extras: MaterialExtraInput[]; dropped: string[] }> {
    const ids = [...new Set(extras.map((row) => row.material_id).filter((id): id is string => Boolean(id)))];
    if (!ids.length) return { extras, dropped: [] };
    const found = await this.prisma.material.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } });
    const known = new Set(found.map((row) => row.id));
    const dropped: string[] = [];
    const kept = extras.map((row) => {
      if (!row.material_id || known.has(row.material_id)) return row;
      dropped.push(row.label ?? row.spec_key ?? "");
      return { ...row, material_id: null };
    });
    return { extras: kept, dropped };
  }

  async create(input: SalesOrderInput, user: CurrentUser) {
    // 返单：先把来源单的值填进「请求没给的键」，再走与普通建单**完全同一条**校验与写入路径。
    const source = input.reorder_from_order_no ? await this.resolveReorderSource(input.reorder_from_order_no) : null;
    let effective = input;
    let droppedRefKeys: string[] = [];
    let droppedExtraLabels: string[] = [];
    if (source) {
      effective = this.reorderInput(source, input);
      // 只有「从来源单复制引用」这条路要过滤；请求自己带了 `material_refs` 就按请求的
      // （那是用户在界面上确认过的，缺物料就该当场报错让他重选）。
      if (input.material_refs === undefined) {
        const usable = await this.usableMaterialRefs(effective.material_refs ?? []);
        effective = { ...effective, material_refs: usable.refs };
        droppedRefKeys = usable.dropped;
      }
      // 「其它」行同一条规矩，但剔掉的只是引用（文字留着），见 `usableMaterialExtras`。
      if (input.material_extras === undefined) {
        const usable = await this.usableMaterialExtras(effective.material_extras ?? []);
        effective = { ...effective, material_extras: usable.extras };
        droppedExtraLabels = usable.dropped;
      }
    }
    await this.currencies?.assertSupported(effective.currency, "销售单币种");
    const refs = await this.resolveReferences(effective, user);
    /**
     * 图片载荷先归一（**在任何写之前**）：
     *   * `spec_key` 不是材料明细那 18 栏之一时当场 422 `SLOT_IMAGE_KEY_UNSUPPORTED`；
     *   * 任何一行/一格超过 3 张图当场 422 `SALES_ORDER_IMAGE_LIMIT`（§3.1）。
     * 不能出现「单已经建了、图没挂上」这种半截状态。`undefined` 与 `[]` 的区别照旧（不动 / 清空）。
     */
    const slotImages = effective.slot_images === undefined ? undefined : normalizeSlotImages(effective.slot_images);
    const imagePayload = { slot_images: slotImages, spec_details: effective.spec_details, material_extras: effective.material_extras };
    this.assertRowImageLimits(imagePayload);
    // 快照要能回答「v1 时下给工厂的是什么」：所以细化标量**每个键都进快照**（没填的记 null），
    // 而不是只记这次请求里出现的键。
    const snapshot = this.snapshot({ ...effective, ...this.specSnapshotSource({}, effective) }, refs.customer, refs.contact);
    try {
      const order = await this.prisma.$transaction(async (tx) => {
        const created = await tx.salesOrder.create({ data: { orderNo: effective.order_no, customerId: effective.customer_id, contactId: effective.contact_id, customerSnapshot: refs.customer as Prisma.InputJsonValue, contactSnapshot: refs.contact as Prisma.InputJsonValue, customerPoNo: effective.customer_po_no, externalContractNo: effective.external_contract_no, orderDate: new Date(effective.order_date), productName: effective.product_name, productSpec: effective.product_spec, quantity: effective.quantity, unit: effective.unit, deliveryDate: effective.delivery_date ? new Date(effective.delivery_date) : undefined, currency: effective.currency, unitPrice: effective.unit_price, totalAmount: effective.total_amount, taxRate: effective.tax_rate, settlementUnitPrice: effective.settlement_unit_price, receivableAmount: effective.receivable_amount, settlementMethod: effective.settlement_method, localCurrencyAmount: effective.local_currency_amount, extensionData: (effective.extension_data ?? {}) as Prisma.InputJsonValue, itemNo: normalizeItemNo(effective.item_no), reorderFromOrderNo: effective.reorder_from_order_no?.trim() || null, specDetailLabels: normalizeSpecDetailLabels(effective.spec_detail_labels) as Prisma.InputJsonValue, ...this.specScalars(effective), ...this.audit.create(user) } });
        await tx.salesOrderVersion.create({ data: { salesOrderId: created.id, version: 1, snapshot, ...this.audit.create(user) } });
        // 图片（2026-11-04）：属于本单的图片 id 直接复用；属于另一张单（返单/复制来源）的**克隆字节**
        // 成新单自己的行再指向它 —— 删一张单不会让另一张单变破图，也不存在跨单引用（见 `bindOrderImages`）。
        const bound = await this.bindOrderImages(tx, created.id, imagePayload, user);
        await this.replaceSpecDetails(tx, created.id, bound.spec_details, user);
        await this.replaceMaterialRefs(tx, created.id, effective.material_refs, user);
        await this.replaceMaterialExtras(tx, created.id, bound.material_extras, user);
        await this.replaceSlotImages(tx, created.id, bound.slot_images, user);
        // 建单**不做** `cleanupOrphanImages`：新单的图只有两种来源（本次请求自己传的、刚克隆的），
        // 在本次请求里都已被某个行引用 —— 孤儿清理只对「传了又取消」的更新路径有意义。
        return created;
      });
      // 返单来源进审计：这是唯一能回答「这张单是从哪张返来的」的业务事实（另一处是列本身）。
      await this.audit.record("sales_order.create", "sales_order", user.id, order.id, { order_no: order.orderNo, ...(effective.reorder_from_order_no ? { reorder_from_order_no: effective.reorder_from_order_no } : {}) });
      const created = await this.get(order.id);
      // 剔掉过引用就回报一次，不静默：用户得知道"这一格的图片没了"是为什么。
      const reorderWarnings = [
        ...(droppedRefKeys.length ? [`来源单引用的物料已不存在，返单时已跳过：${droppedRefKeys.join("、")}`] : []),
        ...(droppedExtraLabels.length ? [`「其它」行引用的物料已不存在，返单时只保留了文字：${droppedExtraLabels.join("、")}`] : []),
      ];
      return reorderWarnings.length ? { ...created, reorder_warnings: reorderWarnings } : created;
    } catch (error) {
      /**
       * 订单号冲突出错时说出「这个号在谁手里」。
       *
       * 自 2026-10-08 起软删会释放订单号（部分唯一索引，见 `throwOrderNoConflict`），
       * 所以能撞上 P2002 的只可能是**未删除**的另一张单 —— 报错要把那张单点出来，
       * 而不是笼统地说"订单号已存在"（用户手上没有任何线索去查是哪一张）。
       */
      await this.throwOrderNoConflict(error, effective.order_no);
      throw error;
    }
  }

  async update(id: string, input: SalesOrderUpdate, user: CurrentUser) {
    await this.currencies?.assertSupported(input.currency, "销售单币种");
    const current = await this.get(id);
    /**
     * 改号判定放在所有守卫之前：后面几条守卫的文案与豁免面都要看它。
     *
     * 空串**不当作"不动"**（那样又会变成一次静默丢弃）：`normalizeOrderNo("")` 为空 → 422 把它顶回来。
     * DTO 侧同样用 `@IsNotEmpty()` 而不是 `EmptyStringToUndefined`，两处口径一致。
     */
    const nextOrderNo = input.order_no === undefined ? undefined : normalizeOrderNo(input.order_no);
    if (nextOrderNo !== undefined && !nextOrderNo) throw new UnprocessableEntityException({ code: "ORDER_NO_REQUIRED", message: "订单号不能为空", details: [] });
    const renaming = nextOrderNo !== undefined && nextOrderNo !== current.orderNo;
    // 改号必须留原因：它是一种"正名"动作，事后要能回答「这张单什么时候从哪个号改成哪个号」。
    // 放在"已确认单修改必须填原因"之前，是为了让改号拿到**它自己**的文案（那一句说的是别的字段）。
    if (renaming && !input.reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: `改订单号必须填写原因（${current.orderNo} → ${nextOrderNo}）`, details: [{ from: current.orderNo, to: nextOrderNo }] });
    /**
     * 已关闭销售单不可编辑 —— **货号与订单号是仅有的两个例外**，而且都是必须的例外。
     *
     * 为什么放行货号：它是贴在这一单上的标签（不进 `coreFields`、不锁下游、不影响任何金额），
     * 而「给历史已关闭单补货号」正是返单链最需要的一步 —— 返单来源必须是**已确认或已关闭**，
     * 来源没有货号就不能返单，于是那些单会永远卡在"既不能返单、又不能补货号"里。
     *
     * 为什么放行订单号：它同样是"这一单的标识"而不是业务数据，改它不动任何一张下游单的数量与金额
     * （38 张表是**跟着一起改**，不是重新算）。打错的号在单关闭之后才发现，是常事；
     * 不放行的话这张单就会永久带着一个错号，而它同时是财务与客户对账时用的那个号。
     *
     * 放行的面**只有**「这次改动除了 item_no / order_no（与 reason）没有别的键」，其余字段照旧一律拒绝。
     */
    const onlyTagFields = (input.item_no !== undefined || nextOrderNo !== undefined) && Object.keys(input).every((key) => key === "item_no" || key === "order_no" || key === "reason");
    if (current.status === "closed" && !onlyTagFields) throw new UnprocessableEntityException({ code: "SALES_ORDER_CLOSED", message: "已关闭销售单不可编辑", details: [] });
    if (current.status === "confirmed" && !input.reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "已确认销售单修改必须填写原因", details: [] });
    // 已关闭单补货号同样要留痕：它是审计该记的事（改的是历史单据上的一个标识）。
    // （改号那条守卫在上面已经拦过，这里只剩货号这一路。）
    if (current.status === "closed" && onlyTagFields && !input.reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "已关闭销售单补货号必须填写原因", details: [] });
    // 结算金额类字段同样属于「动了就要重算下游」的核心字段；结算方式只是说明信息，允许后补。
    /**
     * 已确认单改核心字段的守卫（2026-11-05 重构，设计文档 `bom-delete-and-empty-shell-release` D6/D8）。
     *
     * 判定本身挪进事务（见事务里的 `releaseEmptyShellBoms`），这里只算「这次保存要不要过那道守卫」。
     * 为什么不能留在事务外：守卫现在不只是「挡」，还可能**写**（把空壳 BOM 软删掉放行）；
     * 判完是空壳、写之前有人补了采购单，就会把一张已经在下游用着的 BOM 清掉。
     * 草稿单与「核心字段实际没变」直接为假 —— 一次多的查询都不发（既有行为不变）。
     *
     * ⚠️ 必须按**实际值**判定，不能按「请求里有没有这个键」（2026-11-05 第二轮修的就是这个）：
     * 编辑器每次保存都会整份回传 11 个核心字段，按「键出现」判定会把**只改了图片**的保存
     * 也当成改核心字段 → 建了 BOM 之后换图/删图永远存不上。用户原话：
     * 「希望在建立 BOM 表之后，还能编辑销售单中的图片」。
     */
    const coreFieldsChanged = current.status === "confirmed" && coreFieldsActuallyChanged(current as unknown as Record<string, unknown>, input as unknown as Record<string, unknown>);
    /**
     * 新号的占用预检，**只查未删除的行**：订单号的唯一性是「未删除行上唯一」的部分唯一索引
     * （`sales_orders_order_no_active_key ... WHERE deleted_at IS NULL`，见
     * `20261008100000_sales_order_no_active_unique`），所以软删单占过的号可以再用 ——
     * 预检若把这些号也算成占用，就会拦下数据库本来允许的改号
     * （「删掉号写错的草稿 → 把另一张单改成那个号」正是要能走通的路）。
     */
    if (renaming) {
      const taken = await this.prisma.salesOrder.findFirst({ where: { orderNo: nextOrderNo, deletedAt: null }, select: { id: true, status: true } });
      if (taken) throw new ConflictException({ code: "ORDER_NO_CONFLICT", message: `订单号 ${nextOrderNo} 已被另一张销售单占用`, details: [{ order_id: taken.id, status: taken.status, deleted: false }] });
    }
    const refs = await this.resolveReferences({ customer_id: current.customerId, contact_id: input.contact_id ?? current.contactId ?? undefined }, user);
    /**
     * 图片（2026-11-04；2026-11-05 每处最多 3 张）：`slot_images` 先归一（键域校验在任何写之前），
     * 三处的图片上限也在这里先判 —— 一张图不合法或一行放了 4 张时，事务里一个写都不该发生。
     * `undefined` = 整块不动、`[]` = 清空，与其它整块替换的键同一语义。
     */
    const slotImages = input.slot_images === undefined ? undefined : normalizeSlotImages(input.slot_images);
    this.assertRowImageLimits({ slot_images: slotImages, spec_details: input.spec_details, material_extras: input.material_extras });
    const nextInput = { ...input, customer_id: current.customerId, contact_id: input.contact_id ?? current.contactId ?? undefined, order_no: renaming ? (nextOrderNo as string) : current.orderNo, order_date: input.order_date ?? current.orderDate.toISOString(), product_name: input.product_name ?? current.productName, quantity: input.quantity ?? current.quantity.toString(), unit: input.unit ?? current.unit, currency: input.currency ?? current.currency, extension_data: input.extension_data ?? (current.extensionData as Record<string, unknown>), item_no: input.item_no === undefined ? current.itemNo : input.item_no, // 返单来源不可改：快照里始终记当前值
      reorder_from_order_no: current.reorderFromOrderNo, ...this.specSnapshotSource(current as unknown as Record<string, unknown>, input) };
    const nextVersion = current.currentVersion + 1;
    const snapshot = this.snapshot(nextInput, refs.customer, refs.contact);
    const { updated, renameReport, releasedBoms } = await this.prisma.$transaction(async (tx) => {
      /**
       * 图片（2026-11-04）：更新只接受**本单**的图片 id（不存在/已删/不属于本单 → 422）。
       * 校验放在所有写之前：一张图不合法时一个字节都不写（与 assertMaterialsExist 同一口径）。
       * 只有请求真的带了图片时才查库 —— 否则每次保存都多三条查询，且既有单测的 Prisma 替身要跟着长。
       */
      await this.assertOrderImages(tx, id, { slot_images: slotImages, spec_details: input.spec_details, material_extras: input.material_extras });
      /**
       * 已确认单改核心字段：**先判采购/生产事实，再看 BOM**（D6/D8）。
       *
       * 空壳 BOM（0 明细 + 无采购计划 + 无采购单 + 无生产单）不含任何业务事实，
       * 在这里直接软删并放行保存；有内容/有计划/有下游的 BOM 仍然照旧挡住，但报错要说清在挡什么。
       * 只改非核心字段、草稿单都走不到这里（`coreFieldsChanged` 为假 → 一次 BOM 表都不查）。
       */
      let releasedBoms: Array<{ bom_id: string; version: number }> = [];
      if (coreFieldsChanged) releasedBoms = await this.releaseEmptyShellBoms(tx, id, current.boms.length, user, "update");
      /**
       * 改号：**先锁本单行**，再扫全链。
       *
       * 先锁是有意的：生产单/采购单/原料入库等建单路径在写之前也对同一行 `FOR UPDATE`
       * （例：`production-orders.service.ts:29`、`revertToDraft` 用的是同一条），先锁能把并发建单
       * 压到本次改名提交之后 —— 那时它们读到的是新号，天然一致。锁定挡不住的那部分由
       * `renameSalesOrderNo` 末尾的残留校验兜底（非零即整事务回滚）。
       */
      let report: OrderNoRenameReport | null = null;
      if (renaming) {
        await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${id}::uuid FOR UPDATE`;
        report = await renameSalesOrderNo(tx, { salesOrderId: id, from: current.orderNo, to: nextOrderNo as string });
      }
      const data: Prisma.SalesOrderUncheckedUpdateInput = { ...(input.contact_id === undefined ? {} : { contactId: input.contact_id }), ...(input.customer_po_no === undefined ? {} : { customerPoNo: input.customer_po_no }), ...(input.external_contract_no === undefined ? {} : { externalContractNo: input.external_contract_no }), ...(input.order_date === undefined ? {} : { orderDate: new Date(input.order_date) }), ...(input.product_name === undefined ? {} : { productName: input.product_name }), ...(input.product_spec === undefined ? {} : { productSpec: input.product_spec }), ...(input.quantity === undefined ? {} : { quantity: input.quantity }), ...(input.unit === undefined ? {} : { unit: input.unit }), ...(input.delivery_date === undefined ? {} : { deliveryDate: input.delivery_date ? new Date(input.delivery_date) : null }), ...(input.currency === undefined ? {} : { currency: input.currency }), ...(input.unit_price === undefined ? {} : { unitPrice: input.unit_price }), ...(input.total_amount === undefined ? {} : { totalAmount: input.total_amount }), ...(input.tax_rate === undefined ? {} : { taxRate: input.tax_rate }), ...(input.settlement_unit_price === undefined ? {} : { settlementUnitPrice: input.settlement_unit_price }), ...(input.receivable_amount === undefined ? {} : { receivableAmount: input.receivable_amount }), ...(input.settlement_method === undefined ? {} : { settlementMethod: input.settlement_method }), ...(input.local_currency_amount === undefined ? {} : { localCurrencyAmount: input.local_currency_amount }), ...(input.extension_data === undefined ? {} : { extensionData: input.extension_data as Prisma.InputJsonValue }), ...this.specScalars(input), // 货号：undefined = 不动（快照里仍记当前值）；空串 = 清除（落 NULL）
      ...(input.item_no === undefined ? {} : { itemNo: normalizeItemNo(input.item_no) }), ...(input.spec_detail_labels === undefined ? {} : { specDetailLabels: normalizeSpecDetailLabels(input.spec_detail_labels) as Prisma.InputJsonValue }), // 订单号：只有真的要改时才写（保持"没传 = 不动"的既有语义）
      ...(renaming ? { orderNo: nextOrderNo as string } : {}), customerSnapshot: refs.customer as Prisma.InputJsonValue, contactSnapshot: refs.contact as Prisma.InputJsonValue, currentVersion: nextVersion, ...this.audit.update(user) };
      const result = await tx.salesOrder.update({ where: { id }, data });
      await tx.salesOrderVersion.create({ data: { salesOrderId: id, version: nextVersion, snapshot, ...this.audit.create(user) } });
      await this.replaceSpecDetails(tx, id, input.spec_details, user);
      await this.replaceMaterialRefs(tx, id, input.material_refs, user);
      await this.replaceMaterialExtras(tx, id, input.material_extras, user);
      await this.replaceSlotImages(tx, id, slotImages, user);
      // 保存末尾清掉「这一单没有任何活行引用」的图（用户传了又取消/删了行的那种）。
      // 只在请求真的碰了图片时才扫 —— 见 `touchesImages` 的注释。
      if (this.touchesImages({ slot_images: slotImages, spec_details: input.spec_details, material_extras: input.material_extras })) await this.cleanupOrphanImages(tx, id, user);
      return { updated: result, renameReport: report, releasedBoms };
    }).catch((error: unknown) => {
      /**
       * 唯一索引是并发下的最后一道闸：两个请求同时改到同一个新号时，`salesOrder.update` 会抛 P2002。
       * 只在改号时才把它翻译成 `ORDER_NO_CONFLICT` —— 不改号时的 P2002 只可能是
       * `sales_order_versions(sales_order_id, version)` 的并发冲突，套上"订单号已存在"会把人带偏。
       */
      if (renaming) this.handleUnique(error);
      throw error;
    });
    await this.audit.record("sales_order.update", "sales_order", user.id, id, { order_no: renaming ? (nextOrderNo as string) : current.orderNo, ...(renaming ? { previous_order_no: current.orderNo } : {}), version: nextVersion, reason: input.reason, fields: Object.keys(input).filter((field) => field !== "reason") });
    // 改号另记一条事件：审计是"什么时候发生了什么"的事件流，旧号必须留在事件里（列上不回写，见 sales-order-order-no.ts）。
    if (renameReport) await this.audit.record("sales_order.rename_order_no", "sales_order", user.id, id, { from: renameReport.from, to: renameReport.to, reason: input.reason, targets: renameReport.targets, total: renameReport.total, version_snapshots: renameReport.version_snapshots, reorder_references: renameReport.reorder_references });
    /**
     * 自动清理的空壳 BOM 逐个写审计（D6：**不静默删表**）。
     *
     * 审计在**事务提交之后**写：它是附带记录，不该因为一次审计写失败把整次保存回滚掉
     * （与 `boms.service` 的删除路径同一套路）。`auto: true` + 固定理由把「这不是用户点的删除」
     * 钉在事件里 —— 事后查「这张 BOM 怎么没了」时能分清是谁的动作。
     */
    const finalOrderNo = renaming ? (nextOrderNo as string) : current.orderNo;
    for (const bom of releasedBoms) await this.audit.record("bom.delete", "bom", user.id, bom.bom_id, { order_no: finalOrderNo, version: bom.version, reason: AUTO_RELEASE_EMPTY_BOM_REASON, auto: true });
    const saved = await this.get(updated.id);
    return {
      ...saved,
      order_no_changed: renaming,
      previous_order_no: renaming ? current.orderNo : null,
      rename_report: renameReport,
      // 被自动清理的空壳 BOM（没有则为 `[]`）：前端在成功提示里说出来，用户才知道「刚才那一下顺手删了张空表」。
      released_empty_boms: releasedBoms,
      // 「还有没有 BOM」按**清理后**的实际情况算：只剩下的那一张空壳被清掉之后就不该再提醒物控复核。
      impact_warning: current.status === "confirmed" && saved.boms.length > 0 ? "销售单已有关联 BOM，请物控复核来源版本" : null,
    };
  }

  /**
   * 改号的**影响面预览**（`GET /sales-orders/:id/order-no-impact?order_no=新号`）：只读，不写任何东西。
   *
   * 为什么要有它：改号会同时改动几十张表里的行，这是一个**用户看不见后果**的动作。保存前先把
   * 「将同步更新哪几类单据、各多少条」摆出来，用户才知道自己在做什么；而"说会改的表"与"真的改了的表"
   * 用的是同一份登记表（`ORDER_NO_RENAME_TARGETS`），所以两边不可能不一致 ——
   * 与返单预览「预览过不了的单建不出来」是同一个套路。
   */
  async orderNoImpact(id: string, nextOrderNoInput: string) {
    const nextOrderNo = normalizeOrderNo(nextOrderNoInput);
    if (!nextOrderNo) throw new UnprocessableEntityException({ code: "ORDER_NO_REQUIRED", message: "新订单号不能为空", details: [] });
    const order = await this.prisma.salesOrder.findFirst({ where: { id, deletedAt: null }, select: { id: true, orderNo: true, status: true } });
    if (!order) throw new NotFoundException({ code: "SALES_ORDER_NOT_FOUND", message: "销售单不存在", details: [] });
    const changed = nextOrderNo !== order.orderNo;
    // 同 `update` 的占用预检：只认未删除的行（唯一性是部分唯一索引，软删单占过的号已释放）。
    const taken = changed ? await this.prisma.salesOrder.findFirst({ where: { orderNo: nextOrderNo, deletedAt: null }, select: { id: true, orderNo: true, status: true } }) : null;
    const impact = changed ? await orderNoRenameImpact(this.prisma, order.orderNo) : { targets: [] as Array<{ key: string; label: string; count: number }>, total: 0 };
    // 版本快照与"别的单上的返单来源"不在 `ORDER_NO_RENAME_TARGETS` 里（前者是 JSON、后者是同一张表的另一列），
    // 但它们一样会被改，所以预览与报告都各自算一份 —— 少说一项，用户就会以为那一项没被改。
    const [versionSnapshots, reorderReferences] = changed
      ? await Promise.all([countVersionSnapshotsWithOrderNo(this.prisma, id, order.orderNo), this.prisma.salesOrder.count({ where: { reorderFromOrderNo: order.orderNo } })])
      : [0, 0];
    return {
      sales_order_id: id,
      current_order_no: order.orderNo,
      next_order_no: nextOrderNo,
      changed,
      conflict: taken
        ? { order_no: taken.orderNo, order_id: taken.id, status: taken.status, deleted: false, message: `订单号 ${nextOrderNo} 已被另一张销售单占用（${taken.status}）` }
        : null,
      reason_required: true,
      targets: impact.targets,
      total: impact.total,
      version_snapshots: versionSnapshots,
      reorder_references: reorderReferences,
    };
  }

  async impactPreview(id: string) {
    const order = await this.get(id);
    return { sales_order_id: order.id, order_no: order.orderNo, current_version: order.currentVersion, status: order.status, bom_count: order.boms.length, warning: order.boms.length > 0 ? "已存在 BOM，销售单变更不会自动改写下游事实" : null };
  }

  async confirm(id: string, user: CurrentUser) {
    const order = await this.get(id);
    if (order.status !== "draft") throw new UnprocessableEntityException({ code: "INVALID_STATE_TRANSITION", message: "只有草稿销售单可以确认", details: [{ from: order.status, to: "confirmed" }] });
    const updated = await this.prisma.salesOrder.update({ where: { id }, data: { status: "confirmed", ...this.audit.update(user) } });
    await this.audit.record("sales_order.confirm", "sales_order", user.id, id, { order_no: order.orderNo, from: "draft", to: "confirmed" });
    return updated;
  }

  async revertToDraft(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "销售单回退草稿必须填写原因", details: [] });
    const current = await this.get(id);
    if (current.status !== "confirmed") throw new UnprocessableEntityException({ code: "SALES_ORDER_NOT_REVERTIBLE", message: "仅已确认销售单可以回退草稿", details: [] });
    const { updated, releasedBoms } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.salesOrder.findFirst({ where: { id, deletedAt: null }, select: { status: true } });
      if (!locked || locked.status !== "confirmed") throw new UnprocessableEntityException({ code: "SALES_ORDER_NOT_REVERTIBLE", message: "销售单状态已变化，请刷新后重试", details: [] });
      /**
       * 先清空壳 BOM（设计文档 D7）：与 `update` 用**同一条**判定。
       *
       * 不回退的话「回退草稿」还是那条被空壳堵死的死路，和 D6「保存时自动清理」自相矛盾 ——
       * 用户会发现「保存能过、回退不能过」，而这两件事被挡的理由本来是同一个。
       */
      const released = await this.releaseEmptyShellBoms(tx, id, current.boms.length, user, "revert");
      // 清理之后再数：这三项是「回退草稿」真正的下游事实，与旧守卫同一个口径与顺序（先锁行、再数）。
      // 清理后它们理论上必然为 0（非空 BOM / 采购 / 生产在 `releaseEmptyShellBoms` 里已经拦过），
      // 但保留这一遍是为了让「回退之前还有没有下游事实」始终由同一句判定回答 —— 判定以后改了也不会漏。
      const [bomCount, purchaseCount, productionCount] = await Promise.all([
        tx.bom.count({ where: { salesOrderId: id, deletedAt: null } }),
        tx.purchaseOrder.count({ where: { salesOrderId: id, deletedAt: null } }),
        tx.productionOrder.count({ where: { salesOrderId: id, deletedAt: null } }),
      ]);
      if (bomCount || purchaseCount || productionCount) throw new UnprocessableEntityException({ code: "SALES_ORDER_DOWNSTREAM_EXISTS", message: `销售单仍有 BOM ${bomCount} 张、采购单 ${purchaseCount} 张、生产单 ${productionCount} 张的下游事实，不能直接回退`, details: [{ bom_count: bomCount, purchase_order_count: purchaseCount, production_order_count: productionCount }] });
      const row = await tx.salesOrder.update({ where: { id }, data: { status: "draft", ...this.audit.update(user) } });
      return { updated: row, releasedBoms: released };
    });
    // 与 `update` 同一条口径：自动清理不是用户的删除动作，审计带 `auto: true` + 固定理由，响应里回报。
    for (const bom of releasedBoms) await this.audit.record("bom.delete", "bom", user.id, bom.bom_id, { order_no: current.orderNo, version: bom.version, reason: AUTO_RELEASE_EMPTY_BOM_REASON, auto: true });
    await this.audit.record("sales_order.revert_to_draft", "sales_order", user.id, id, { order_no: current.orderNo, reason: reason.trim(), from: "confirmed", to: "draft" });
    return { ...updated, released_empty_boms: releasedBoms };
  }

  /**
   * 已确认单改核心字段 / 回退草稿前的下游事实判定（2026-11-05，设计文档 D6/D7/D8）。
   *
   * 顺序是有意与旧守卫接续的：
   *   1. **先数采购单/生产单**（`salesOrderId + deletedAt: null`，与原来完全同口径）——
   *      已经采购/投产的事实不会因为「BOM 是空壳」而消失，所以有它就当场挡住，并说清是哪种单挡的；
   *   2. 再取该销售单名下的 BOM 事实（`bom-facts.ts`，与 BOM 删除共用一份判定）；
   *   3. **全部是空壳** → 事务内软删表头与明细行，让保存/回退继续；
   *      只要有一张不是空壳（有明细 / 有采购计划 / 有采购单 / 有生产单）→ 按 `mode` 抛对应错误码，
   *      `details` 逐张给出挡路的原因（D8：用户正是被「已有 BOM」这种笼统报错误导的）。
   *
   * 为什么 `knownBomCount === 0` 时直接返回：这一单在事务外读到的 BOM 数为 0 时，旧口径也只查采购/生产
   * （BOM 是后来才建的）；保持同样的查询面，既有单测的轻量 Prisma 替身也就不会因为这里多一次 `bom.findMany` 被打穿。
   */
  private async releaseEmptyShellBoms(tx: Prisma.TransactionClient, salesOrderId: string, knownBomCount: number, user: CurrentUser, mode: "update" | "revert"): Promise<Array<{ bom_id: string; version: number }>> {
    const [purchaseCount, productionCount] = await Promise.all([tx.purchaseOrder.count({ where: { salesOrderId, deletedAt: null } }), tx.productionOrder.count({ where: { salesOrderId, deletedAt: null } })]);
    if (purchaseCount || productionCount) {
      const summary = [purchaseCount ? `${purchaseCount} 张采购单` : "", productionCount ? `${productionCount} 张生产单` : ""].filter(Boolean).join("、");
      const details = [{ bom_count: knownBomCount, purchase_order_count: purchaseCount, production_order_count: productionCount }];
      if (mode === "update") throw new UnprocessableEntityException({ code: "SALES_ORDER_CORE_FIELDS_LOCKED", message: `销售单已有 ${summary}（下游事实），核心字段需先回退下游后才能改：采购单可「退回采购计划」或取消，草稿生产单可直接删除`, details });
      throw new UnprocessableEntityException({ code: "SALES_ORDER_DOWNSTREAM_EXISTS", message: `销售单已有 ${summary}（下游事实），不能直接回退草稿：请先处理这些下游单据`, details });
    }
    // 事务外读到的 BOM 数为 0 → 没有可清理的东西，也不查 BOM 表（见方法头注释最后一段）。
    if (!knownBomCount) return [];
    const facts = await salesOrderBomFacts(tx, salesOrderId);
    const blocked = facts.filter((fact) => !isEmptyShellBom(fact));
    if (blocked.length) {
      // 逐张说清在挡什么：明细几项 / 有没有采购计划 / 采购单 / 生产单各几张。
      const details = facts.map((fact) => ({
        bom_id: fact.id,
        version: fact.version,
        item_count: fact.item_count,
        has_purchase_plan: fact.purchase_plan !== null,
        purchase_plan_no: fact.purchase_plan?.plan_no ?? null,
        purchase_order_count: fact.purchase_order_count,
        production_order_count: fact.production_order_count,
        blocked_reason: bomBlockedReason(fact),
      }));
      const describe = (fact: BomFacts): string => {
        const parts: string[] = [];
        if (fact.item_count > 0) parts.push(`有 ${fact.item_count} 项明细`);
        if (fact.purchase_plan) parts.push(`已有采购计划 ${fact.purchase_plan.plan_no}`);
        if (fact.purchase_order_count) parts.push(`已被 ${fact.purchase_order_count} 张采购单引用`);
        if (fact.production_order_count) parts.push(`已被 ${fact.production_order_count} 张生产单引用`);
        return `v${fact.version} ${parts.join("、")}`;
      };
      const head = blocked.length === 1 ? `这张 BOM（${describe(blocked[0])}）` : `销售单名下这 ${blocked.length} 张 BOM 还有内容：${blocked.map(describe).join("；")}`;
      // D8：不再只说「已有 BOM」，而是说清挡路的内容与**下一步去哪**（采购 → BOM表）。
      const message = mode === "update" ? `${head}，核心字段不能直接修改：请先到【采购 → BOM表】删除${blocked.length === 1 ? "这张 BOM" : "这些 BOM"}（已下单/投产的需先回退下游）` : `销售单已有 BOM、采购或生产下游事实，不能直接回退：${head}。请先到【采购 → BOM表】删除${blocked.length === 1 ? "这张 BOM" : "这些 BOM"}后再回退`;
      if (mode === "update") throw new UnprocessableEntityException({ code: "SALES_ORDER_CORE_FIELDS_LOCKED", message, details });
      throw new UnprocessableEntityException({ code: "SALES_ORDER_DOWNSTREAM_EXISTS", message, details });
    }
    // 全空壳：表头与明细行一起软删（与 BOM 删除同一语义）；返回给调用方写审计与响应。
    const released: Array<{ bom_id: string; version: number }> = [];
    for (const fact of facts) {
      await tx.bomItem.updateMany({ where: { bomId: fact.id, deletedAt: null }, data: this.audit.softDelete(user) });
      await tx.bom.update({ where: { id: fact.id }, data: this.audit.softDelete(user) });
      released.push({ bom_id: fact.id, version: fact.version });
    }
    return released;
  }

  async close(id: string, user: CurrentUser) {
    const order = await this.get(id);
    if (order.status !== "confirmed") throw new UnprocessableEntityException({ code: "INVALID_STATE_TRANSITION", message: "只有已确认销售单可以关闭", details: [{ from: order.status, to: "closed" }] });
    const updated = await this.prisma.salesOrder.update({ where: { id }, data: { status: "closed", ...this.audit.update(user) } });
    await this.audit.record("sales_order.close", "sales_order", user.id, id, { order_no: order.orderNo, from: "confirmed", to: "closed" });
    return updated;
  }

  /**
   * 删除销售单前的**影响面预览**（2026-11-03）。
   *
   * 用户要的是「删之前先看清楚会留下什么」：下游单据不会被删，而是变成孤立单据。
   * 与 `delete()` 共用 `countOrphanDocuments`（同一张 11 类清单），预览说的与真删留下的不会分叉。
   *
   * `reason_required` 由状态决定：草稿仍是一键删（2026-10-08 的口径不变），
   * 已确认/已关闭的删除要写原因 —— 它带走的是整条链的「父单」，比删草稿重得多。
   */
  async deletePreview(id: string) {
    const order = await this.get(id);
    const { items, total } = await countOrphanDocuments(this.prisma, id);
    return { sales_order_id: order.id, order_no: order.orderNo, status: order.status, reason_required: order.status !== "draft", downstream: items, downstream_total: total };
  }

  /**
   * 删除销售单（2026-11-03 起对所有状态开放）。
   *
   * 为什么软删：整条销售链上**一个 `ON DELETE CASCADE` 都没有** —— 38 张子表的外键在迁移里
   * 一律落成 `RESTRICT`，硬删在有子行时必然被 Postgres 拒绝；何况单据本身带着版本快照、
   * 细分明细、物料引用。所以「删除」只能是软删 + 审计留痕（`audit.softDelete` 的既有口径）。
   *
   * 为什么不再因为「有下游事实」拒绝：用户 2026-11-03 拍板 —— 下游单据**不删、不解绑**，
   * 销售单软删后它们仍指向这张单（`sales_order_id` 不变），在列表上显示为「孤立单据」。
   * 「孤立」是读取时算出来的（见 `orphan-documents.ts`），不是写进下游表的标记；
   * 删错了把 `deleted_at` 清掉，下游单据自动接回。
   *
   * 锁行后再复查：`confirm` / `revertToDraft` 可能与删除并发，先读到的 draft 在锁内可能已经不是，
   * 而「非草稿必须填原因」这条守卫必须在锁内再判一次，否则并发下会绕过。
   *
   * 与 `revertToDraft` 用同一把锁、同一个顺序（先锁销售单行，再数下游）。
   */
  async delete(id: string, user: CurrentUser, reason?: string) {
    const order = await this.get(id);
    const trimmed = (reason ?? "").trim();
    this.assertDeleteReason(order.status, trimmed);
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.salesOrder.findFirst({ where: { id, deletedAt: null }, select: { status: true } });
      if (!locked) throw new UnprocessableEntityException({ code: "SALES_ORDER_NOT_DELETABLE", message: "销售单已删除或不存在，请刷新后重试", details: [] });
      this.assertDeleteReason(locked.status, trimmed);
      const orphans = await countOrphanDocuments(tx, id);
      const row = await tx.salesOrder.update({ where: { id }, data: this.audit.softDelete(user) });
      return { row, status: locked.status, orphans };
    });
    // 审计除了「谁删的、删的是哪张单」，还要记下「留下了哪些单据、各几张」——
    // 孤立单据是删单后的结果，事后想回答「这张单当初留下些什么」只有审计里有。
    await this.audit.record("sales_order.delete", "sales_order", user.id, id, {
      order_no: order.orderNo,
      status: result.status,
      ...(trimmed ? { reason: trimmed } : {}),
      orphan_documents: Object.fromEntries(result.orphans.items.map((item) => [item.key, item.count])),
      orphan_total: result.orphans.total,
    });
    return result.row;
  }

  /** 「非草稿必须填原因」的唯一判定：预览与执行共用，锁内锁外各判一次。 */
  private assertDeleteReason(status: string, reason: string) {
    if (status !== "draft" && !reason) throw new UnprocessableEntityException({ code: "SALES_ORDER_DELETE_REASON_REQUIRED", message: "删除已确认/已关闭的销售单必须填写原因", details: [{ status }] });
  }

  /**
   * 孤立单据汇总（2026-11-03）：被删的销售单 + 它们留下的下游单据。
   * 「孤立」的判定式与清单都收在 `orphan-documents.ts`，这里只负责把库交出去。
   */
  async orphans() {
    return summarizeOrphanDocuments(this.prisma);
  }

  /**
   * 版本快照里的细化字段：**当前值打底、请求值覆盖**，所以每个版本都能看到当时的完整工艺口径
   * （只记「这次改了哪几个」的快照，回看时会以为别的字段是空的）。
   * 明细只在这次请求带了 `spec_details` 时才进快照（明细是整体替换语义）。
   */
  private specSnapshotSource(current: Record<string, unknown>, input: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const [key, column] of SPEC_SCALAR_FIELDS) {
      const fromInput = input[key];
      merged[key] = fromInput !== undefined ? fromInput : current[column] ?? null;
    }
    if (input.spec_details !== undefined) merged.spec_details = input.spec_details;
    // 「其它」行（2026-10-08）与明细同一条规矩（只有这次请求带了才进快照）。进的是**整块**：
    // 它是「这一版下给工厂的材料口径」的一部分，只记变化量的话回看时会以为那一版没有这些行。
    if (input.material_extras !== undefined) merged.material_extras = input.material_extras;
    // 明细列名与标量同一条规矩（当前值打底、请求值覆盖）：只记"这次改了哪几个"的话，
    // 回看某个版本的工艺单口径会以为那一版没有自定义列名。
    const labels = input.spec_detail_labels !== undefined ? input.spec_detail_labels : current.specDetailLabels;
    if (labels !== undefined) merged.spec_detail_labels = labels;
    // 引用也进快照：回看某个版本时要能回答「当时这一格引用的是哪个物料」——
    // 物料主数据会被改名/换图，光看当前值答不了这个问题（与 spec_details 同一条理由）。
    if (input.material_refs !== undefined) merged.material_refs = input.material_refs;
    // 18 格各自的图（2026-11-04；2026-11-05 一格最多 3 张）同一条规矩：只记图片 id 指针、不存字节
    // （§3.4：`image_ids` 数组原样进快照）。
    if (input.slot_images !== undefined) merged.slot_images = input.slot_images;
    return merged;
  }

  /**
   * 细化标量：只取请求里**传了的**键（没传的列不动，传 null 才是清空），与既有 `update` 的
   * 「undefined = 不动」语义一致。
   */
  private specScalars(input: Record<string, unknown>): Record<string, string | null> {
    const data: Record<string, string | null> = {};
    for (const [key, column] of SPEC_SCALAR_FIELDS) {
      const value = input[key];
      if (value === undefined) continue;
      // 空串 = 「清除这一格」（表单里把一格删空就该清掉，而不是当成没填）；没传的键才是不动。
      data[column] = value === "" ? null : (value as string | null);
    }
    return data;
  }

  /**
   * 细分明细的替换语义：与采购单明细一致——老的软删 + 新的批量建，同一个事务。
   * `details === undefined` 表示这次请求没提到明细（整块不动）；传空数组才是「清空全部」。
   *
   * 行图（2026-11-04 每行一张 → 2026-11-05 每行最多 3 张）跟着这一行走：`image_id`/`image_id_2`/`image_id_3`
   * 是**指向 `sales_order_images` 的指针**，所以这里可以直接「软删 + 新建」而不丢字节（字节从来不在这一行上）。
   * 数组落成三列：第 n 张 → `imageId(n)`，空位落 NULL（只填 2 张的第二列有值、第三列 NULL，顺序不变）。
   *
   * 归一（去重/上限 422）在软删**之前**：一行放了 4 张图时这一整次保存要一个字节都不写。
   */
  private async replaceSpecDetails(tx: Prisma.TransactionClient, salesOrderId: string, details: SpecDetailInput[] | undefined, user: CurrentUser) {
    if (details === undefined) return;
    const rows = details.map((detail, index) => {
      const imageIds = normalizeRowImageIds(detail, "spec_details", String(detail.name ?? ""));
      return { salesOrderId, groupName: detail.group_name, name: detail.name, color: detail.color, barcode: detail.barcode, quantity: detail.quantity, unit: detail.unit, imageId: imageIds[0] ?? null, imageId2: imageIds[1] ?? null, imageId3: imageIds[2] ?? null, sortOrder: detail.sort_order ?? index, ...this.audit.create(user) };
    });
    await tx.salesOrderSpecDetail.updateMany({ where: { salesOrderId, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id } });
    if (!rows.length) return;
    await tx.salesOrderSpecDetail.createMany({ data: rows });
  }

  /**
   * 物料引用的替换语义：**整块替换**（`undefined` = 不动，`[]` = 全部取消），与 `spec_details` 一致。
   *
   * ⚠️ 为什么不是「软删旧的 + 建新的」（`replaceSpecDetails` 那种写法）：引用的唯一键是
   * `(salesOrderId, specKey)`，而**数据库的唯一索引不看 `deletedAt`** —— 删了再建必然撞唯一约束
   * （同一张单子改一次引用就会 500）。所以这里按栏位**逐行对齐**：
   * 值变了就改这一行（顺手把 `deletedAt` 清回来，等于「复活」）、请求里没提到的栏位软删、
   * 全新出现的栏位才插入。这样每一行始终是同一条记录，`createdAt` 也真的表示「这一格第一次引用
   * 是什么时候」。
   *
   * 同一个栏位在请求里出现两次时**后写覆盖先写**（前端不可能这么发，但接口是公开的）：
   * 报错要求调用方先去重，只会让「界面自己发重了」变成一个用户看不懂的 400。
   */
  private async replaceMaterialRefs(tx: Prisma.TransactionClient, salesOrderId: string, refs: MaterialRefInput[] | undefined, user: CurrentUser) {
    if (refs === undefined) return;
    const wanted = new Map<string, string>();
    for (const ref of refs) wanted.set(ref.spec_key, ref.material_id);
    // 只让「材料明细」那 18 个栏位能挂引用；其余键（工艺要求、布量、表头）一律拒绝 ——
    // 静默忽略会让前端的键名写错变成一个「点了没反应」的问题。
    for (const key of wanted.keys()) {
      if (!(SPEC_MATERIAL_KEYS as readonly string[]).includes(key)) {
        throw new UnprocessableEntityException({ code: "MATERIAL_REF_KEY_UNSUPPORTED", message: `「${key}」不是材料明细的栏位，不能引用物料`, details: [{ spec_key: key }] });
      }
    }
    await this.assertMaterialsExist(wanted.values());

    const existing = await tx.salesOrderMaterialRef.findMany({ where: { salesOrderId } });
    for (const row of existing) {
      const materialId = wanted.get(row.specKey);
      wanted.delete(row.specKey);
      if (!materialId) {
        if (row.deletedAt === null) await tx.salesOrderMaterialRef.update({ where: { id: row.id }, data: this.audit.softDelete(user) });
        continue;
      }
      if (row.materialId === materialId && row.deletedAt === null) continue;
      await tx.salesOrderMaterialRef.update({ where: { id: row.id }, data: { materialId, deletedAt: null, deletedBy: null, ...this.audit.update(user) } });
    }
    const fresh = [...wanted.entries()];
    if (fresh.length) await tx.salesOrderMaterialRef.createMany({ data: fresh.map(([specKey, materialId]) => ({ salesOrderId, specKey, materialId, ...this.audit.create(user) })) });
  }

  /**
   * 引用必须是**真实存在、未删除**的物料。
   *
   * 一条 SQL 查全部（而不是逐个查）：一次保存最多 18 个引用，逐个查是 18 次往返；
   * 而「哪些不存在」要**一次说清**（前端要能把缺的那几个栏位标出来）。
   */
  private async assertMaterialsExist(materialIds: Iterable<string>) {
    const ids = [...new Set(materialIds)];
    if (!ids.length) return;
    const found = await this.prisma.material.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true } });
    const known = new Set(found.map((row) => row.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) throw new NotFoundException({ code: "MATERIAL_NOT_FOUND", message: `引用的物料不存在或已删除（${missing.length} 个）：请刷新物料清单后重选`, details: missing.map((id) => ({ material_id: id })) });
  }

  /**
   * 「其它」行的替换语义：软删旧的 + 建新的，同一个事务（与 `replaceSpecDetails` 一致）。
   *
   * 为什么这里可以「软删 + 新建」、而 `replaceMaterialRefs` 必须逐行对齐：那张表上有
   * `(salesOrderId, specKey)` 的唯一键（唯一索引不看 `deletedAt`，删了再建必然撞），而这张表
   * 没有唯一键 —— 行的身份就是它自己，用户每次保存改的就是整块内容。代价是行 id 每次保存都会变，
   * 所以图片导出候选按 `extra:<行 id>` 标识、且每次导出都重新拉候选（见 schema 的模型注释）。
   *
   * 先校验（类目必填 / 内容或引用至少一个 / 条数封顶 / 图片最多 3 张 / 引用的物料真实存在）再写：
   * 一行不合法时**一个字节都不写** —— 半截数据比报错更难查。
   *
   * 行图（2026-11-05）：数组落成 `imageId` / `imageId2` / `imageId3` 三列，第 n 张 → 第 n 列，
   * 空位落 NULL。顺序 = 用户看到的顺序，所以不能排序、不能把空位挤掉。
   */
  private async replaceMaterialExtras(tx: Prisma.TransactionClient, salesOrderId: string, extras: MaterialExtraInput[] | undefined, user: CurrentUser) {
    if (extras === undefined) return;
    const rows = normalizeMaterialExtras(extras);
    await this.assertMaterialsExist(rows.map((row) => row.materialId).filter((id): id is string => Boolean(id)));
    await tx.salesOrderMaterialExtra.updateMany({ where: { salesOrderId, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id } });
    if (!rows.length) return;
    await tx.salesOrderMaterialExtra.createMany({ data: rows.map((row) => { const imageIds = row.imageIds ?? []; return { salesOrderId, label: row.label, content: row.content, materialId: row.materialId, specKey: row.specKey, imageId: imageIds[0] ?? null, imageId2: imageIds[1] ?? null, imageId3: imageIds[2] ?? null, sortOrder: row.sort_order, ...this.audit.create(user) }; }) });
  }

  // ------------------------------------------------------------------
  // 行图片（2026-11-04 每个位置一张 → 2026-11-05 每个位置最多 3 张）
  // 独立图片库 + 三处指针（18 格映射 / 明细行 / 「其它」行）
  // ------------------------------------------------------------------

  /**
   * 请求里出现的图片 id（三处合起来，**数组形状也要收全**）。
   *
   * 它是「要不要查库/做校验」的唯一开关：没带图片的保存**一次 `sales_order_images` 都不查** ——
   * 既省往返，也让既有单测的 Prisma 替身不必跟着长（它们只 mock 了走到的表）。
   */
  private imageIdsOf(input: SalesOrderImagePayload): string[] {
    const ids = new Set<string>();
    for (const row of input.slot_images ?? []) for (const id of rowImageIds(row)) ids.add(id);
    for (const row of input.spec_details ?? []) for (const id of rowImageIds(row)) ids.add(id);
    for (const row of input.material_extras ?? []) for (const id of rowImageIds(row)) ids.add(id);
    return [...ids];
  }

  /**
   * 保存前的图片上限预检（在任何写之前）：三处任何一行/一格超过 `MAX_ROW_IMAGES` 当场 422。
   *
   * 为什么要在事务外单独跑一遍：`replaceSpecDetails` / `replaceMaterialExtras` 自己也会归一（那是它们的
   * 最后一道），但它们跑在事务里、且在建单/更新行之后 —— 靠回滚兜底却让"非法请求"多走了一堆写。
   * 这里先点名拒绝，事务里那次归一就只是防御性重复。
   */
  private assertRowImageLimits(input: SalesOrderImagePayload) {
    for (const row of input.spec_details ?? []) normalizeRowImageIds(row, "spec_details", String(row?.name ?? ""));
    for (const row of input.material_extras ?? []) normalizeRowImageIds(row, "material_extras", String(row?.label ?? row?.spec_key ?? ""));
    for (const row of input.slot_images ?? []) normalizeRowImageIds(row, "slot_images", String(row?.spec_key ?? ""));
  }

  /**
   * 这次保存是否碰了图片 = 要不要做归属校验与孤儿清理。
   *
   * `slot_images` 只要**出现**就算（`[]` = 清空 18 格的图，必须清掉因此变成孤儿的图）；
   * 行上的图则要真的有 id 才算 —— 行里没有图的普通保存不该触发整单扫描。
   *
   * ⚠️ 已知边界（设计文档 §7.1）：把**最后一张**图从行上删掉、而且请求里不带 `slot_images` 时，
   * 这张图会留到下一次碰图片的保存才被软删。宁可晚删一次，也不给每次保存加三条查询。
   */
  private touchesImages(input: SalesOrderImagePayload): boolean {
    return input.slot_images !== undefined || this.imageIdsOf(input).length > 0;
  }

  /**
   * 更新时的图片归属校验：图片必须**存在、未删除、属于本单**，否则 422 `SALES_ORDER_IMAGE_NOT_FOUND`。
   *
   * 为什么更新不允许指向别的单（返单/复制可以，见 `bindOrderImages`）：更新是在一张既有单上挂图，
   * 跨单引用会让「删掉 A 单」把 B 单的图带走 —— 那正是按单隔离要防的事。
   */
  private async assertOrderImages(tx: Prisma.TransactionClient, salesOrderId: string, input: SalesOrderImagePayload) {
    const ids = this.imageIdsOf(input);
    if (!ids.length) return;
    const found = await tx.salesOrderImage.findMany({ where: { id: { in: ids }, salesOrderId, deletedAt: null }, select: { id: true } });
    const known = new Set(found.map((row) => row.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) throw new UnprocessableEntityException({ code: "SALES_ORDER_IMAGE_NOT_FOUND", message: `引用的图片不存在、已删除或不属于这张销售单（${missing.length} 张）：请重新上传后再保存`, details: missing.map((id) => ({ image_id: id, sales_order_id: salesOrderId })) });
  }

  /**
   * 建单时的图片绑定：本单的 id 直接复用；属于**另一张单**（返单/复制来源）的，把字节
   * **复制**成新单自己的 `sales_order_images` 行再指向它（设计文档 §2.5）。
   *
   * 为什么必须复制而不是直接引用来源单的 id：图片是按单隔离的，跨单引用会让「删掉来源单」
   * 把新单的图一起带走（`ON DELETE RESTRICT` 还会让删来源单直接失败），而且等于给了一条
   * 用别人的 image id 读字节的口子。同字节/宽高/sha 复制之后，两张单各自完整。
   *
   * 返回**重映射后的载荷**：`image_id` 全部换成新单自己的图片 id；没有任何图片时原样返回（零查询）。
   */
  private async bindOrderImages(tx: Prisma.TransactionClient, salesOrderId: string, input: SalesOrderImagePayload, user: CurrentUser): Promise<SalesOrderImagePayload> {
    const ids = this.imageIdsOf(input);
    if (!ids.length) return input;
    const rows = await tx.salesOrderImage.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, salesOrderId: true, data: true, mimeType: true, width: true, height: true, byteSize: true, sha256: true } });
    const found = new Map(rows.map((row) => [row.id, row]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new UnprocessableEntityException({ code: "SALES_ORDER_IMAGE_NOT_FOUND", message: `引用的图片不存在或已删除（${missing.length} 张）：请重新上传后再保存`, details: missing.map((id) => ({ image_id: id })) });
    const remapped = new Map<string, string>();
    for (const row of rows) {
      if (row.salesOrderId === salesOrderId) {
        remapped.set(row.id, row.id);
        continue;
      }
      // 自己分配 `ArrayBuffer` 再 `set`：Prisma 的 `Bytes` 列要 `Uint8Array<ArrayBuffer>`，
      // 而 Prisma 读回来的字节是宽类型（与 procurement 的 setMaterialImage 同一条写法）。
      const source = row.data;
      const data = new Uint8Array(source.byteLength);
      data.set(source);
      const cloned = await tx.salesOrderImage.create({ data: { salesOrderId, data, mimeType: row.mimeType, width: row.width, height: row.height, byteSize: row.byteSize, sha256: row.sha256, ...this.audit.create(user) }, select: { id: true } });
      remapped.set(row.id, cloned.id);
    }
    const mapId = (imageId: string): string => remapped.get(imageId) ?? imageId;
    /**
     * 一行/一格：把数组里的每个 id 都换成（必要时新建的）**本单**图片 id。
     * 没有图的行原样返回（不凭空加键：版本快照与既有单测的形状都是"没图就没有这个键"）。
     * 顺手把旧的单值键清成 `undefined`：数组与单值同时带时数组优先，留着一个来源单的 id 只会误导下一个读的人。
     */
    const remapRow = <T extends { image_id?: string | null; image_ids?: string[] | null }>(row: T): T => {
      const ids = rowImageIds(row);
      if (!ids.length) return row;
      return { ...row, image_ids: ids.map(mapId), image_id: undefined };
    };
    return {
      slot_images: input.slot_images?.map((row) => remapRow(row) as SlotImageInput),
      spec_details: input.spec_details?.map((row) => remapRow(row)),
      material_extras: input.material_extras?.map((row) => remapRow(row)),
    };
  }

  /**
   * 18 格图片的替换语义：**逐格逐张对齐**（`undefined` = 不动，`[]` = 全部取消）。
   *
   * ⚠️ 为什么不是「软删旧的 + 建新的」（`replaceMaterialExtras` 那种写法）：唯一键是
   * `(salesOrderId, specKey, slotIndex)` 而**唯一索引不看 `deletedAt`** —— 删了再建必撞 P2002。
   * 所以按 `(spec_key, slot_index)` 对齐：这一张变了改这一行（顺手清 `deletedAt` 复活）、
   * 请求里这一格没有这一张就软删、新出现的 `(spec_key, slot_index)` 才插入
   * （与 `replaceMaterialRefs` 同一条理由，见那里的注释）。
   *
   * 2026-11-05 的关键差别：**不能只软删整格**。一格从 3 张删成 1 张时，`slotIndex` 1/2 两行要软删、
   * 0 那行留着；删成 0 张才三行全软删。只软删整格会把"这一格还有第 1 张"也一起清掉。
   */
  private async replaceSlotImages(tx: Prisma.TransactionClient, salesOrderId: string, slotImages: SlotImageInput[] | undefined, user: CurrentUser) {
    if (slotImages === undefined) return;
    // 期望状态：`spec_key` → 这一格的图片数组（下标就是 `slot_index`）。
    const wanted = new Map<string, string[]>();
    for (const row of slotImages) wanted.set(row.spec_key, rowImageIds(row));
    const existing = await tx.salesOrderSlotImage.findMany({ where: { salesOrderId } });
    // 已经存在的 `(spec_key, slot_index)`：它决定了哪些是"改"、哪些是"新建"（软删的行也在内 ——
    // 唯一索引不看 `deletedAt`，软删行必须**复活**而不是再插一行）。
    const covered = new Set(existing.map((row) => `${row.specKey}\u0000${row.slotIndex}`));
    for (const row of existing) {
      const imageId = wanted.get(row.specKey)?.[row.slotIndex];
      if (!imageId) {
        // 请求里这一格没有这一张（或整格没提到）→ 软删这一行。
        if (row.deletedAt === null) await tx.salesOrderSlotImage.update({ where: { id: row.id }, data: this.audit.softDelete(user) });
        continue;
      }
      if (row.imageId === imageId && row.deletedAt === null) continue;
      await tx.salesOrderSlotImage.update({ where: { id: row.id }, data: { imageId, deletedAt: null, deletedBy: null, ...this.audit.update(user) } });
    }
    const fresh: Array<{ salesOrderId: string; specKey: string; slotIndex: number; imageId: string; createdBy: string; updatedBy: string }> = [];
    for (const [specKey, imageIds] of wanted) {
      imageIds.forEach((imageId, slotIndex) => {
        if (covered.has(`${specKey}\u0000${slotIndex}`)) return;
        fresh.push({ salesOrderId, specKey, slotIndex, imageId, ...this.audit.create(user) });
      });
    }
    if (fresh.length) await tx.salesOrderSlotImage.createMany({ data: fresh });
  }

  /**
   * 保存末尾的孤儿清理：本单里**没有任何活行引用**的图片软删（设计文档 §2.5 最后一条）。
   *
   * 只软删、不硬删：图片行还可能被版本快照里的图片 id 提到（快照只记 id 不记字节），
   * 硬删会让回看某个版本时对上一个不存在的 id；软删还留着「这里曾经有一张图」的事实。
   *
   * 三条引用来源一次查完：18 格映射、明细行、「其它」行。2026-11-05 起后两处各要查**三列**
   * （`image_id` / `image_id_2` / `image_id_3`）—— 只查第 1 列的话，第 2/3 张图会在下一次保存时
   * 被当成孤儿清掉（用户看到的是"上次明明传了 3 张，今天只剩 1 张"）。
   * 引用集合里只可能是本单的 id（上传/克隆都写本单，更新只接受本单的 id），所以不必再按单过滤引用行。
   */
  private async cleanupOrphanImages(tx: Prisma.TransactionClient, salesOrderId: string, user: CurrentUser) {
    const images = await tx.salesOrderImage.findMany({ where: { salesOrderId, deletedAt: null }, select: { id: true } });
    if (!images.length) return;
    const ids = images.map((row) => row.id);
    const rowImageRefWhere = (salesOrderId_: string) => ({ salesOrderId: salesOrderId_, deletedAt: null, OR: [{ imageId: { in: ids } }, { imageId2: { in: ids } }, { imageId3: { in: ids } }] });
    const slots = await tx.salesOrderSlotImage.findMany({ where: { salesOrderId, deletedAt: null, imageId: { in: ids } }, select: { imageId: true } });
    const details = await tx.salesOrderSpecDetail.findMany({ where: rowImageRefWhere(salesOrderId), select: { imageId: true, imageId2: true, imageId3: true } });
    const extras = await tx.salesOrderMaterialExtra.findMany({ where: rowImageRefWhere(salesOrderId), select: { imageId: true, imageId2: true, imageId3: true } });
    const referenced = new Set<string>();
    for (const row of [...slots, ...details, ...extras]) {
      for (const imageId of [row.imageId, (row as { imageId2?: string | null }).imageId2, (row as { imageId3?: string | null }).imageId3]) if (imageId) referenced.add(imageId);
    }
    const orphans = ids.filter((id) => !referenced.has(id));
    if (orphans.length) await tx.salesOrderImage.updateMany({ where: { id: { in: orphans } }, data: this.audit.softDelete(user) });
  }

  private async resolveReferences(input: { customer_id: string; contact_id?: string }, _user: CurrentUser) {
    const customer = await this.prisma.customer.findFirst({ where: { id: input.customer_id, deletedAt: null, isActive: true } });
    if (!customer) throw new NotFoundException({ code: "CUSTOMER_NOT_FOUND", message: "客户不存在或已停用", details: [] });
    let contact: object | null = null;
    if (input.contact_id) {
      contact = await this.prisma.customerContact.findFirst({ where: { id: input.contact_id, customerId: input.customer_id, deletedAt: null, isActive: true } });
      if (!contact) throw new NotFoundException({ code: "CUSTOMER_CONTACT_NOT_FOUND", message: "客户联系人不存在或不属于该客户", details: [] });
    }
    return { customer: this.compact(customer), contact: contact ? this.compact(contact) : null };
  }

  private snapshot(input: Record<string, unknown>, customer: object, contact: object | null) { return this.compact({ order_no: input.order_no, customer, contact, customer_po_no: input.customer_po_no, external_contract_no: input.external_contract_no, order_date: input.order_date, product_name: input.product_name, product_spec: input.product_spec, quantity: input.quantity, unit: input.unit, delivery_date: input.delivery_date, currency: input.currency, unit_price: input.unit_price, total_amount: input.total_amount, tax_rate: input.tax_rate, settlement_unit_price: input.settlement_unit_price, receivable_amount: input.receivable_amount, settlement_method: input.settlement_method, local_currency_amount: input.local_currency_amount, // 货号进快照前**先归一**，保证「快照里记的」与「库里存的」永远是同一个值
    item_no: normalizeItemNo(input.item_no as string | null | undefined), reorder_from_order_no: (input.reorder_from_order_no as string | null | undefined)?.trim() || null, extension_data: input.extension_data ?? {}, ...this.specSnapshotFields(input) }); }

  /**
   * 快照里的细化字段：**每个键都写**（没填记 null），而不是只写这次请求里出现的键——
   * 否则回看某个版本时会以为当时别的工艺栏位是空的。`snapshot()` 只拷固定键清单，
   * 所以这里必须显式把它并进去（这一条是被单测抓出来的：第一版漏了，快照里根本没有细化字段）。
   */
  private specSnapshotFields(input: Record<string, unknown>): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const [key] of SPEC_SCALAR_FIELDS) fields[key] = input[key] ?? null;
    if (input.spec_details !== undefined) fields.spec_details = input.spec_details;
    if (input.material_extras !== undefined) fields.material_extras = input.material_extras;
    if (input.material_refs !== undefined) fields.material_refs = input.material_refs;
    // 18 格各自的图（2026-11-04；2026-11-05 一格最多 3 张）：快照只记指针（`image_ids`，§3.4），不存字节。
    if (input.slot_images !== undefined) fields.slot_images = input.slot_images;
    return fields;
  }
  private compact(value: object) { return JSON.parse(JSON.stringify(value, (_key, item) => item === undefined ? undefined : item)); }
  private handleUnique(error: unknown) { if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "ORDER_NO_CONFLICT", message: "订单号已存在", details: [] }); }

  /**
   * 建单撞唯一键时把「号在谁手里」查出来再说。
   *
   * **只查未删除的行**：订单号唯一性是部分唯一索引（`... WHERE deleted_at IS NULL`，
   * `20261008100000_sales_order_no_active_unique`），软删单占过的号数据库已经放行，
   * 不可能再是 P2002 的原因。
   *
   * 只处理 P2002，其余错误原样放过（调用方 catch 里紧接着 `throw error`）。
   * 查不到占用行时退回与 `handleUnique` 同一句话 —— P2002 也可能来自别的唯一键，
   * 不能反过来断言"一定是订单号"。
   */
  private async throwOrderNoConflict(error: unknown, orderNo: string): Promise<void> {
    if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) return;
    const taken = await this.prisma.salesOrder.findFirst({ where: { orderNo, deletedAt: null }, select: { id: true, status: true } });
    if (!taken) throw new ConflictException({ code: "ORDER_NO_CONFLICT", message: "订单号已存在", details: [] });
    throw new ConflictException({ code: "ORDER_NO_CONFLICT", message: `订单号 ${orderNo} 已被另一张销售单占用`, details: [{ order_id: taken.id, status: taken.status, deleted: false }] });
  }
}

// 销售单「下单口径细化」的字段清单与纯函数。
//
// 字段清单与后端 `apps/api/src/modules/sales/sales-orders.service.ts` 的 `SPEC_SCALAR_FIELDS`
// **必须一致**（两个 workspace 之间没有共享包，只能两份）：后端那份驱动入库/快照，这份驱动表单与载荷。
// 两边用同一组测试向量钉住键名与顺序——分叉的后果是「界面填了、库里没存」这种最难查的错。
//
// 清单顺序 = 工艺单模板的印刷顺序（材料明细 18 项 → 工艺要求 9 项），导出直接按它落格。

/** 表头补充字段（模板表头与注意事项）。 */
export const SPEC_HEADER_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["factory", "工厂"],
  ["completion_remark", "完工日期备注"],
  ["attention_note", "注意事项"],
  ["shipping_mark_front", "正唛"],
  ["shipping_mark_side", "侧唛"],
];

/** 布量（模板「伞面/伞带/木耳/天布/布套（Y/DZ)」）。 */
export const SPEC_FABRIC_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["fabric_usage_canopy", "伞面"],
  ["fabric_usage_strap", "伞带"],
  ["fabric_usage_wood_ear", "木耳"],
  ["fabric_usage_top", "天布"],
  ["fabric_usage_bag", "布套"],
];

/** 材料明细（两样本并集 18 项，顺序照模板）。 */
export const SPEC_MATERIAL_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["rib_spec", "伞骨（孔对孔）"],
  ["canopy_spec", "伞布规格"],
  ["handle_spec", "伞头"],
  ["handle_strap_spec", "伞头带"],
  ["tail_spec", "伞尾、笠"],
  ["runner_spec", "伞束、珠"],
  ["strap_spec", "伞带"],
  ["strap_fastener_spec", "伞带粘扣"],
  ["inner_label_spec", "内标"],
  ["woven_label_spec", "织标"],
  ["hang_tag_spec", "吊牌"],
  ["opp_spec", "OPP"],
  ["bag_spec", "布套"],
  ["packaging_spec", "包装明细"],
  ["top_fabric_spec", "天布"],
  ["wood_ear_spec", "木耳"],
  ["keychain_spec", "钥匙扣"],
  ["printing_spec", "印刷"],
];

/** 工艺要求（两样本并集 9 项）。 */
export const SPEC_PROCESS_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["sample_requirement", "样品要求"],
  ["cutting_requirement", "裁布要求"],
  ["edge_requirement", "拉边要求"],
  ["joining_requirement", "合片要求"],
  ["top_stitch_requirement", "打顶要求"],
  ["sewing_requirement", "缝伞要求"],
  ["strap_requirement", "伞带要求"],
  ["hang_tag_note", "吊牌位置"],
  ["qc_requirement", "质检报告"],
];

/** 表单上要提交的全部细化标量键（顺序与后端一致：表头 → 布量 → 材料 → 工艺）。 */
export const SPEC_SCALAR_KEYS: readonly string[] = [
  ...SPEC_HEADER_FIELDS.map(([key]) => key),
  ...SPEC_FABRIC_FIELDS.map(([key]) => key),
  ...SPEC_MATERIAL_FIELDS.map(([key]) => key),
  ...SPEC_PROCESS_FIELDS.map(([key]) => key),
];

/**
 * 「材料明细」那 18 个栏位的请求键 —— 只有这些栏位**可以引用物料**（用户 2026-09-24：
 * 「在编辑销售单的时候，每个部件，既支持填空，也支持从现有的物料清单中引用」）。
 *
 * 与后端 `apps/api/src/modules/sales/sales-orders.service.ts` 的 `SPEC_MATERIAL_KEYS` 是同一份
 * （两个 workspace 没有共享包），后端那份有测试钉住「它就是 SPEC_SCALAR_FIELDS 里材料那一段」，
 * 这里直接**从同一张清单推**出来，连抄都不用抄。
 */
export const SPEC_MATERIAL_KEYS: readonly string[] = SPEC_MATERIAL_FIELDS.map(([key]) => key);

/** 物料清单里的一个物料（引用选择器与缩略图要用到的字段）。 */
export type MaterialOption = {
  id: string;
  materialCode?: string | null;
  name?: string | null;
  specificationModel?: string | null;
  color?: string | null;
  /** 图片摘要（**没有字节**）：`sha256` 用来破缓存，存在与否就是「有没有图」。 */
  image?: { sha256?: string | null; updatedAt?: string | null } | null;
};

/** 引用选择器的选项文字：`MAT-1 / 伞骨 50cm 黑`。 */
export function materialOptionLabel(material: MaterialOption): string {
  const code = (material.materialCode ?? "").trim();
  const text = materialSpecText(material);
  return [code, text].filter(Boolean).join(" / ") || material.id;
}

/**
 * 引用一个物料时写进那一格的文字：`名称 规格型号 颜色`。
 *
 * 为什么选中物料要顺手填文字，而不是只记一个引用：工艺单上印的是**文字**（工厂照字做伞），
 * 只存引用的话那一格在纸上是空的。填完之后那一格仍然可改（「既支持填空，也支持引用」——
 * 引用只是帮你省掉手打，不是把这一格锁死）。
 */
export function materialSpecText(material: Pick<MaterialOption, "name" | "specificationModel" | "color">): string {
  return [material.name, material.specificationModel, material.color].map((part) => (part ?? "").trim()).filter(Boolean).join(" ");
}

/** 某一格当前引用（`material` 为空表示「引用的物料查不到了」——界面要能说出这件事）。 */
export type MaterialRefState = Record<string, MaterialOption | null>;

/** 接口返回的引用行（Prisma 列名 + 嵌套的物料）。 */
type MaterialRefRow = { specKey?: unknown; material?: unknown };

/**
 * 从接口返回的销售单里取引用。
 *
 * ⚠️ 键名是 **`specKey`（列名）** 而不是 `spec_key`：详情接口给的是 Prisma 整行转 JSON。
 * 这与 37 个细化标量当年踩的坑是同一类（见 `specFromOrder` 的长注释）—— 所以这里也把
 * 「认两种形状」写进来：版本快照存的是请求键，接口给的是列名。
 */
export function materialRefsFromOrder(order: Record<string, unknown>): MaterialRefState {
  const refs: MaterialRefState = {};
  for (const key of SPEC_MATERIAL_KEYS) refs[key] = null;
  const rows = Array.isArray(order.materialRefs) ? (order.materialRefs as MaterialRefRow[]) : Array.isArray(order.material_refs) ? (order.material_refs as MaterialRefRow[]) : [];
  for (const row of rows) {
    const specKey = String(row?.specKey ?? (row as { spec_key?: unknown })?.spec_key ?? "");
    if (!specKey || !(specKey in refs)) continue;
    const material = row?.material as MaterialOption | null | undefined;
    // 物料被删掉时后端可能给了引用行但 `material` 为空：保留一个「引用了但找不到」的状态，
    // 而不是静默当成没引用 —— 否则用户下次保存就把这条引用悄悄丢了。
    refs[specKey] = material ?? null;
  }
  return refs;
}

/** 引用 → 提交载荷（只发真正引用了的栏位；顺序照材料明细清单，便于比对）。 */
export function materialRefsPayload(refs: MaterialRefState): Array<{ spec_key: string; material_id: string }> {
  return SPEC_MATERIAL_KEYS.filter((key) => refs[key]?.id).map((key) => ({ spec_key: key, material_id: refs[key]!.id }));
}

/** 每张销售单能引用的图片上限 = 材料明细栏位数（后端也是按栏位收的）。 */
export const MATERIAL_REF_LIMIT = SPEC_MATERIAL_KEYS.length;

// ------------------------------------------------------------------ 行级图片（2026-11-04「每种一张图」）
//
// 用户原话：「销售订单要支持每个物料插入图片……比如说一个生产单里有 5 种伞布，11 种伞头，
// 能在每种里插入图片」。图片是**独立库行**（`sales_order_images`，按销售单隔离），18 格与行上
// 只存 `image_id` 指针 —— 所以界面上的「一张图」= 摘要 + id，字节永远不进详情接口（详情每次打开都拉）。

/**
 * 行/格上挂的图（摘要，**不含字节**）。
 *
 * `id` 是 `sales_order_images.id`（不是行 id、也不是 `sales_order_slot_images.id`）：
 * 保存时交给后端的就是它。`sha256` 用来拼 `<img src>` 的 `?v=` 破缓存。
 */
export type RowImageMeta = {
  id: string;
  width: number;
  height: number;
  sha256: string;
  byteSize?: number;
};

/** 18 格各自的图：键 = 材料栏位请求键（`SPEC_MATERIAL_KEYS`），值 = 这一格自己的图。 */
export type SlotImages = Record<string, RowImageMeta | null>;

/** 接口里能是 null/undefined/各种标量的值 → 去掉首尾空白的文本。 */
function imageText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

/** 宽高/字节数这类数值字段：读不出数字就给 0（摘要永远不参与布局计算崩溃）。 */
function imageNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

/**
 * `image: { id, width, height, byteSize, sha256 }` 这种**嵌套摘要** → `RowImageMeta`。
 *
 * 形状不对 / 没有 id 时返回 null（宁可当成「这一行没有图」，也不要拿半个对象去拼地址）。
 */
export function imageSummaryFrom(value: unknown): RowImageMeta | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = imageText(raw.id);
  if (!id) return null;
  const byteSize = imageNumber(raw.byteSize ?? raw.byte_size);
  return {
    id,
    width: imageNumber(raw.width),
    height: imageNumber(raw.height),
    sha256: imageText(raw.sha256 ?? raw.sha),
    ...(byteSize ? { byteSize } : {}),
  };
}

/**
 * 从**一行**（明细行 / 「其它」行 / 18 格图行）取它自己的图。
 *
 * 优先认嵌套摘要（详情接口与返单/复制的 `copy` 都带摘要，界面要拿它拼缩略图地址）；
 * 只有 `imageId` / `image_id` 而没有摘要时**也保留这个 id** —— 返单/复制保存时要把这个 id
 * 原样交回后端去克隆字节，丢了它就等于静默丢图。两种键名形状都认，与 37 个标量同一条纪律。
 */
export function rowImageFrom(value: unknown): RowImageMeta | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const summary = imageSummaryFrom(row.image);
  if (summary) return summary;
  const id = imageText(row.imageId ?? row.image_id);
  return id ? { id, width: 0, height: 0, sha256: "" } : null;
}

/**
 * 从销售单里取 18 格各自的图。
 *
 * ⚠️ **两种键名形状都认**（与 37 个细化标量、明细行、明细列名同一条纪律）：
 * 详情接口给的是列名 `slotImages`（行里是 `specKey` / `imageId`），返单预览与复制快照给的是
 * 请求键 `slot_images`（行里是 `spec_key` / `image_id`）。只认一种的话，那条回填路就静默少图。
 */
export function slotImagesFromOrder(order: Record<string, unknown>): SlotImages {
  const images: SlotImages = {};
  for (const key of SPEC_MATERIAL_KEYS) images[key] = null;
  const raw = order.slotImages ?? order.slot_images;
  if (!Array.isArray(raw)) return images;
  for (const item of raw as Array<Record<string, unknown>>) {
    const row = (item ?? {}) as Record<string, unknown>;
    const specKey = imageText(row.specKey ?? row.spec_key);
    // 只认 18 个材料栏位：多出来的键没有格子可挂（后端也会 422），静默丢掉而不是造出一个野键。
    if (!specKey || !(specKey in images)) continue;
    images[specKey] = rowImageFrom(row);
  }
  return images;
}

/**
 * 18 格图 → 提交载荷：`[{ spec_key, image_id }]`，整块替换语义。
 *
 * 没图的格子不发（`undefined` = 不动 / `[]` = 清空，是后端约定好的两种语义；整块发才表达得出「删掉某一格的图」）。
 */
export function slotImagesPayload(slotImages: SlotImages | null | undefined): Array<{ spec_key: string; image_id: string }> {
  if (!slotImages) return [];
  return SPEC_MATERIAL_KEYS.filter((key) => slotImages[key]?.id).map((key) => ({ spec_key: key, image_id: slotImages[key]!.id }));
}

// ------------------------------------------------------------------ 「其它」自定义类目行（2026-10-08）
//
// 用户原话：「材料明细最后还需要加一个『其它』，可以自行添加类目。有时候还需要别的物料。
// 允许用户增删改」。
//
// 与后端 `apps/api/src/modules/sales/sales-orders.service.ts` 的 `MATERIAL_EXTRA_*` 与
// `normalizeMaterialExtras` 是同一套口径（两个 workspace 没有共享包，只能两份），
// 两边用同一组测试向量钉住上限、键名与错误口径 —— 分叉的后果是「界面放过去、后端 422」，
// 或者更糟：**界面拦下、后端其实允许**（用户以为功能坏了）。

/** 「其它」行的条数上限：工艺单是一张 A4 纸，行数再多就印不下了（与后端同一个数）。 */
export const MATERIAL_EXTRA_LIMIT = 20;
export const MATERIAL_EXTRA_LABEL_MAX_LENGTH = 50;
export const MATERIAL_EXTRA_CONTENT_MAX_LENGTH = 1000;

/**
 * 类目键 → 中文名（用户 2026-10-29「3 款伞头、2 款伞布」）：18 个固定类目的名字。
 * 就是 `SPEC_MATERIAL_FIELDS` 那张表，这里是查法 —— 类目名在界面上只该有一份。
 */
const MATERIAL_LABEL_BY_KEY = new Map<string, string>(SPEC_MATERIAL_FIELDS);
export const materialCategoryLabel = (key: string): string => MATERIAL_LABEL_BY_KEY.get(key) ?? key;

/**
 * 「其它」/「再加一款」行在表单里的形状：类目 + 内容 + 引用的物料（`null` = 只填文字）。
 *
 * `specKey`（2026-10-29）：非空 = 这一行是某个固定类目的**追加款**（3 款伞头就是 `handle_spec` 3 行），
 * 类目名由类目键推出来，不让用户重复打字；空 = 原有「其它」自由类目行（类目名用户自己起）。
 * 两种行共用一个数组：保存时整块替换，导出时按类目归位。
 */
export type MaterialExtraRow = { label: string; content: string; material: MaterialOption | null; specKey: string | null; /** 这一行自己的图（有引用物料时**优先用这张**，没有才回退物料图）。 */ image: RowImageMeta | null };

export const emptyMaterialExtraRow = (specKey: string | null = null): MaterialExtraRow => ({ label: specKey ? materialCategoryLabel(specKey) : "", content: "", material: null, specKey, image: null });

/**
 * 整行空：用户加了行还没填，提交前丢掉（与明细行同一条口径）。
 *
 * 「再加一款」的行类目名是系统给的，所以判空只看**内容与引用** —— 否则空行永远不算空，
 * 界面上会留下一排「伞头」空行，保存时还会被后端按「内容与引用至少要有一个」拒掉。
 *
 * **有图的行不算空**（2026-11-04）：用户往往是先传图再填字，判空把整行丢掉的话那张图就静默没了；
 * 至于「只有图、没有内容也没有引用」这种半成品，逐行校验会拦住（内容/引用仍是必填之一）。
 */
export const isBlankMaterialExtra = (row: MaterialExtraRow): boolean => row.specKey
  ? !row.content.trim() && !row.material && !row.image
  : !row.label.trim() && !row.content.trim() && !row.material && !row.image;

/**
 * 逐行校验（行号从 1 起，与后端 `normalizeMaterialExtras` 同一套口径）。
 *
 * 三条规则各自的理由：**类目必填**（它印在工艺单「材料」那一列）；**内容与引用至少有一个**
 * （只印一个类目、右边空着，工人只会来问"这个到底要什么"）；**内容长度**（一格印不下）。
 * 不整批丢弃、逐条给原因，与全站导入的提示口径一致。
 *
 * 「再加一款」的行没有「类目必填」这一条：类目名是系统按类目键填的，用户不需要也不该去改它。
 * 报错文字里带上类目名（「伞头：…」），因为这种行在界面上没有「类目」输入框，只说"第 2 行"
 * 用户找不到是哪一行。
 */
export function validateMaterialExtras(rows: MaterialExtraRow[]): Array<{ row: number; reason: string }> {
  const errors: Array<{ row: number; reason: string }> = [];
  const kept = rows.filter((row) => !isBlankMaterialExtra(row));
  kept.forEach((row, index) => {
    if (row.specKey) {
      const label = materialCategoryLabel(row.specKey);
      if (row.content.trim().length > MATERIAL_EXTRA_CONTENT_MAX_LENGTH) errors.push({ row: index + 1, reason: `${label}：内容超过 ${MATERIAL_EXTRA_CONTENT_MAX_LENGTH} 字` });
      if (!row.content.trim() && !row.material) errors.push({ row: index + 1, reason: `${label}：内容与引用的物料至少要有一个` });
      return;
    }
    if (!row.label.trim()) errors.push({ row: index + 1, reason: "类目不能为空（例如：弹簧 / 螺丝 / 胶袋）" });
    else if (row.label.trim().length > MATERIAL_EXTRA_LABEL_MAX_LENGTH) errors.push({ row: index + 1, reason: `类目名超过 ${MATERIAL_EXTRA_LABEL_MAX_LENGTH} 字` });
    if (row.content.trim().length > MATERIAL_EXTRA_CONTENT_MAX_LENGTH) errors.push({ row: index + 1, reason: `内容超过 ${MATERIAL_EXTRA_CONTENT_MAX_LENGTH} 字` });
    if (!row.content.trim() && !row.material) errors.push({ row: index + 1, reason: "内容与引用的物料至少要有一个" });
  });
  if (kept.length > MATERIAL_EXTRA_LIMIT) errors.push({ row: kept.length, reason: `最多 ${MATERIAL_EXTRA_LIMIT} 行（工艺单是一张 A4 纸），当前 ${kept.length} 行` });
  return errors;
}

/**
 * 从接口返回的销售单（或返单预览的 `copy`）里取「其它」行。
 *
 * ⚠️ **两种键名形状都认**：接口给的是 Prisma 列名 `materialExtras`，返单预览与版本快照里是请求键
 * `material_extras` —— 与 37 个细化标量、明细列名踩过的同一个坑（读侧只认一种，那条路就断一次，
 * 而表现是"填了、保存了、再打开又没了"）。行上带的物料摘要（`row.material`）也认：
 * 返单预览带了它，编辑器就不必依赖物料池那一次请求成功。
 */
export function materialExtrasFromOrder(order: Record<string, unknown>): MaterialExtraRow[] {
  const raw = order.materialExtras ?? order.material_extras;
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>)
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));
      // 2026-10-29「再加一款」：归属类目两种形状都认（列名 `specKey` / 请求键 `spec_key`），
      // 与 37 个细化标量、明细列名踩过的同一个坑同一条纪律：读侧只认一种，那条路就断一次。
      const specKeyText = text(row.specKey ?? row.spec_key).trim();
      const specKey = specKeyText || null;
      const label = text(row.label).trim() || (specKey ? materialCategoryLabel(specKey) : "");
      // 行自己的图（2026-11-04）：详情给 `image` 摘要，返单/复制的 copy 可能只给 `image_id` —— `rowImageFrom` 两种都认。
      return { label, content: text(row.content), material: (row.material ?? null) as MaterialOption | null, specKey, image: rowImageFrom(row) };
    })
    .filter((row) => !isBlankMaterialExtra(row));
}

/**
 * 「其它」/「再加一款」行 → 提交载荷（丢掉整行空的，其余按数组顺序补 `sort_order`）。
 *
 * 没引用物料时**不带 `material_id` 这个键**（而不是发 null）：整块替换语义下"没带"就是"这一行没有引用"，
 * 少发一个 null 少一处键名形状分叉的机会。带 `spec_key` 时 **label 由类目键推**：
 * 后端也按同一份清单覆盖它，两边写的是同一个名字 —— 这里发出来只是让接口自解释。
 */
export function materialExtrasPayload(rows: MaterialExtraRow[]): Array<Record<string, unknown>> {
  return rows
    .filter((row) => !isBlankMaterialExtra(row))
    .map((row, index) => ({
      ...(row.specKey ? { spec_key: row.specKey } : {}),
      label: row.specKey ? materialCategoryLabel(row.specKey) : row.label.trim(),
      content: row.content.trim(),
      ...(row.material ? { material_id: row.material.id } : {}),
      // 行自己的图（2026-11-04）：没图**不带这个键**（整块替换语义下「没带」就是「这一行没有自己的图」）。
      ...(row.image ? { image_id: row.image.id } : {}),
      sort_order: index,
    }));
}

/** 某一类目下的「再加一款」行（界面按类目分组渲染：3 款伞头就是伞头那一格的 3 行）。 */
export function materialExtrasOfCategory(rows: MaterialExtraRow[], specKey: string): Array<{ row: MaterialExtraRow; index: number }> {
  return rows.map((row, index) => ({ row, index })).filter((item) => item.row.specKey === specKey);
}

/** 自由类目的「其它」行（没有归属类目的那些）。 */
export function freeMaterialExtras(rows: MaterialExtraRow[]): Array<{ row: MaterialExtraRow; index: number }> {
  return rows.map((row, index) => ({ row, index })).filter((item) => !item.row.specKey);
}

/**
 * 请求键（snake_case）→ Prisma 列名（camelCase）。
 *
 * 为什么要机械转换而不是再抄一份映射表：后端 `SPEC_SCALAR_FIELDS` 已经是「请求键 → 列」的
 * 权威表，这里再抄 37 行就是第三份清单；机械转换只依赖「列名 = 请求键的驼峰」这一条假设，
 * 而这条假设由 `apps/api/test/unit/sales-order-dto.test.cjs` 逐键钉住（分叉立刻红）。
 */
export function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/**
 * 从**接口返回的销售单**里取 37 个细化字段，转成表单能直接用的 `{ 请求键: 文本 }`。
 *
 * 这里踩过一个把两个读侧一起打穿的坑（2026-09-20「材料明细写了、保存了，再打开就又没有了」）：
 * `GET /sales-orders/:id` 是把 Prisma 整行转 JSON 出去的，细化字段的键是**列名 camelCase**
 * （`ribSpec` / `fabricUsageCanopy`），而表单用的是**请求键 snake_case**。读的时候拿请求键去
 * 索引 camelCase 的行，除了 `factory`（键名与列名恰好相同）之外全部 `undefined` → 界面一片空白；
 * 更糟的是再点保存会把这 37 格当「空串」发回去，服务层按「空串 = 清除这一格」把库里真实存在的
 * 值**清成 NULL**（数据被擦掉，不只是没显示）。工艺单导出（`sales-order-export.service.ts`）
 * 也在读侧犯了同一个错，那一版导出的「材料 / 明细 / 布量」整块是空的。
 *
 * 两种形状都认（先请求键、再列名）：版本快照存的是请求键，接口返回的是列名。
 */
export function specFromOrder(order: Record<string, unknown>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of SPEC_SCALAR_KEYS) {
    const fromRequestKey = order[key];
    const raw = fromRequestKey === undefined || fromRequestKey === null ? order[snakeToCamel(key)] : fromRequestKey;
    values[key] = raw === undefined || raw === null ? "" : String(raw);
  }
  return values;
}

/** 细分明细的列（与后端 SpecDetailDto 的字段名一一对应）。 */
export const SPEC_DETAIL_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["group_name", "分组名"],
  ["name", "品番/品名"],
  ["color", "颜色/配色"],
  ["barcode", "条码"],
  ["quantity", "数量"],
  ["unit", "单位"],
];

// ------------------------------------------------------------------ 细分明细的自定义列名（2026-09-30）
//
// 用户原话：「细分明细那边，可以改成自定义字段名称。」
// 与后端 `apps/api/src/modules/sales/sales-orders.service.ts` 的 `SPEC_DETAIL_LABELS` 是同一份清单
// （两个 workspace 没有共享包，只能两份），两边用同一组测试向量钉住键名与默认名。
// **键名与顺序直接取自 `SPEC_DETAIL_COLUMNS`**，连抄都不用抄 —— 分叉的后果是
// 「界面上改了名字、导出还是老名字」这种查不出来的错。

/** 可自定义的 6 个列键（顺序 = 表格列序）。 */
export const SPEC_DETAIL_LABEL_KEYS: readonly string[] = SPEC_DETAIL_COLUMNS.map(([key]) => key);

/** 默认列名（用户没改过时印的名字）。 */
export const DEFAULT_SPEC_DETAIL_LABELS: Readonly<Record<string, string>> = Object.fromEntries(SPEC_DETAIL_COLUMNS);

/** 列名长度上限（与后端同一口径）：表头要印在一格里，太长会把明细表挤变形。 */
export const SPEC_DETAIL_LABEL_MAX_LENGTH = 20;

/**
 * 明细列名的**自定义覆盖**（只含用户改过的那些；没改 / 改回空的都不在这里）。
 *
 * ⚠️ 两种键名形状都认：接口返回的 Prisma 行是列名 `specDetailLabels`，
 * 而版本快照/返单预览里是请求键 `spec_detail_labels` —— 与 37 个细化标量当初
 * 「按请求键去索引 camelCase 行」那个坑同一条纪律（那次是整块空白）。
 */
export function specDetailLabelsFromOrder(order: Record<string, unknown>): Record<string, string> {
  const raw = order.specDetailLabels ?? order.spec_detail_labels;
  const overrides: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return overrides;
  for (const key of SPEC_DETAIL_LABEL_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    const text = typeof value === "string" ? value.trim() : "";
    if (text && text.length <= SPEC_DETAIL_LABEL_MAX_LENGTH) overrides[key] = text;
  }
  return overrides;
}

/** 默认列名 + 这一单的覆盖（界面上要显示、导出要用，两处都走它，别各写一遍回退）。 */
export function detailLabelsWithDefaults(overrides: Readonly<Record<string, string>> | null | undefined): Record<string, string> {
  const merged: Record<string, string> = { ...DEFAULT_SPEC_DETAIL_LABELS };
  for (const key of SPEC_DETAIL_LABEL_KEYS) {
    const text = (overrides?.[key] ?? "").trim();
    if (text) merged[key] = text;
  }
  return merged;
}

/**
 * 覆盖 → 提交载荷：只发**非空**的项（清空一格 = 不发这个键 = 后端把覆盖删掉 = 回到默认名）。
 * 总是整块发（与 `material_refs` 同一个「整块替换」语义）：只发变化的那几项表达不出"恢复默认"。
 */
export function specDetailLabelsPayload(overrides: Readonly<Record<string, string>> | null | undefined): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const key of SPEC_DETAIL_LABEL_KEYS) {
    const text = (overrides?.[key] ?? "").trim();
    if (text) payload[key] = text.slice(0, SPEC_DETAIL_LABEL_MAX_LENGTH);
  }
  return payload;
}

/** 提交前拦一刀：列名太长时给出人话（后端也会拒，但让用户当场看见更好）。 */
export function validateSpecDetailLabels(overrides: Readonly<Record<string, string>> | null | undefined): string | null {
  for (const key of SPEC_DETAIL_LABEL_KEYS) {
    const text = (overrides?.[key] ?? "").trim();
    if (text.length > SPEC_DETAIL_LABEL_MAX_LENGTH) return `列名「${text}」超过 ${SPEC_DETAIL_LABEL_MAX_LENGTH} 字，请改短一点（表头要印在一格里）`;
  }
  return null;
}

export type SpecDetailRow = { group_name: string; name: string; color: string; barcode: string; quantity: string; unit: string; /** 这一行自己的图（明细行不引用物料，所以没有兜底图）。 */ image: RowImageMeta | null };

export const emptySpecDetailRow = (): SpecDetailRow => ({ group_name: "", name: "", color: "", barcode: "", quantity: "", unit: "", image: null });

/**
 * 明细行是不是完全空的行（整行空 = 用户加了行又没填，提交前丢掉，不要写进库）。
 *
 * **有图的行不算空**（2026-11-04）：用户先传图再填字是常见顺序，判空把行丢掉的话那张图就静默没了。
 */
export const isBlankSpecDetail = (row: SpecDetailRow): boolean =>
  !row.group_name.trim() && !row.name.trim() && !row.color.trim() && !row.barcode.trim() && !row.quantity.trim() && !row.unit.trim() && !row.image;

/**
 * 校验明细行：分组名与品番/品名是必填（后端 DTO 也是这么要求的），数量必须是数字。
 * 返回逐行错误（行号从 1 起），供表单逐条显示——不整批丢弃，与全站导入的提示口径一致。
 */
export function validateSpecDetails(rows: SpecDetailRow[]): Array<{ row: number; reason: string }> {
  const errors: Array<{ row: number; reason: string }> = [];
  rows.forEach((row, index) => {
    if (isBlankSpecDetail(row)) return;
    if (!row.group_name.trim()) errors.push({ row: index + 1, reason: "分组名不能为空（例如：伞布明细 / 伞头配色）" });
    if (!row.name.trim()) errors.push({ row: index + 1, reason: "品番/品名不能为空" });
    if (row.quantity.trim() && !/^\d+(?:\.\d+)?$/.test(row.quantity.trim())) errors.push({ row: index + 1, reason: "数量必须是不小于 0 的数字" });
  });
  return errors;
}

/**
 * 提交载荷里的细化部分。
 *
 * 语义与后端一致：**空串 = 清除这一格**（表单里删空就该清掉），所以这里把每个键都带上
 * （没填的键给空串）。不这么做的话「清空一个格子」永远保存不上——用户会以为保存失败了。
 * 明细：丢掉整行空的，其余按数组顺序补 sort_order。
 *
 * `refs` 是材料明细的物料引用（用户 2026-09-24）。**总是整块发**（引用是整块替换语义：
 * 只发变化的那几个，会让「取消引用」变得表达不出来）。不传时载荷里不带这个键 ——
 * `undefined` = 不动，是后端约定好的第三种语义，测试也依赖它。
 *
 * `detailLabels` 是细分明细的自定义列名（用户 2026-09-30），同一条整块替换语义：
 * 不传 = 不动这一块，传 `{}` = 全部恢复默认列名（"恢复默认"必须表达得出来）。
 *
 * `extras` 是材料明细末尾的「其它」行（用户 2026-10-08），同一条整块替换语义：
 * 不传 = 不动这一块，传 `[]` = 全部删掉。
 *
 * `slotImages` 是 18 格各自的图（用户 2026-11-04「每种一张图」），同样是整块替换语义：
 * 不传 = 不动这一块，传 `{}`/全空 = 清空所有格的图。行上的图（明细行 / 「其它」行）跟在行里
 * 作为 `image_id` 发出 —— 没图的行不带那个键。
 */
export function specPayload(values: Record<string, string>, details: SpecDetailRow[], refs?: MaterialRefState, detailLabels?: Readonly<Record<string, string>>, extras?: MaterialExtraRow[], slotImages?: SlotImages): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of SPEC_SCALAR_KEYS) payload[key] = (values[key] ?? "").trim();
  const rows = details.filter((row) => !isBlankSpecDetail(row));
  payload.spec_details = rows.map((row, index) => ({
    group_name: row.group_name.trim(),
    name: row.name.trim(),
    color: row.color.trim(),
    barcode: row.barcode.trim(),
    quantity: row.quantity.trim(),
    unit: row.unit.trim(),
    ...(row.image ? { image_id: row.image.id } : {}),
    sort_order: index,
  }));
  if (refs) payload.material_refs = materialRefsPayload(refs);
  if (detailLabels) payload.spec_detail_labels = specDetailLabelsPayload(detailLabels);
  if (extras) payload.material_extras = materialExtrasPayload(extras);
  if (slotImages) payload.slot_images = slotImagesPayload(slotImages);
  return payload;
}

/**
 * 单位归一：把「同一个单位的几种写法」认成一种。
 *
 * 与后端 `normalizeSpecUnit` 同一张同义词表（两份实现，同一组测试向量）：模板样本1 的表头是
 * `1960支`、明细写的是 `100pcs`，不归一的话「明细合计 = 单头数量」这条真规则会被误判成
 * 「跨单位无法核对」，页面上就会一直提示核对。
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

/**
 * 明细数量合计 vs 单头数量（模板两张样本都成立：1960支 / 2505打）。
 * 返回 `null` 表示对得上或没什么可核对的；否则返回人话提示。**只在页面上提示，不拦提交。**
 */
export function specQuantityNotice(quantity: string, unit: string, details: SpecDetailRow[]): string | null {
  const rows = details
    .filter((row) => !isBlankSpecDetail(row))
    // 先看「填没填」，再解析：`Number("")` 是 **0** 而不是 NaN，直接解析会把「数量留空的行」
    // 当成数量 0 参与合计，于是页面一进来就报「合计 0 与单头数量不一致」。
    .filter((row) => row.quantity.trim() !== "")
    .map((row) => ({ value: Number(row.quantity), unit: row.unit }))
    .filter((row) => Number.isFinite(row.value));
  if (!rows.length) return null;
  const headUnit = normalizeSpecUnit(unit);
  if (!rows.every((row) => { const rowUnit = normalizeSpecUnit(row.unit); return rowUnit === null || rowUnit === headUnit; })) {
    return `明细单位与单头单位（${unit || "未填"}）不一致，跨单位不做合计。`;
  }
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const head = Number(quantity);
  if (!Number.isFinite(head)) return null;
  if (Math.abs(total - head) < 1e-9) return null;
  return `明细数量合计 ${trimNumber(total)} 与单头数量 ${trimNumber(head)}${unit} 不一致，请核对。`;
}

const trimNumber = (value: number): string => (Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4))));

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

/** 细分明细的列（与后端 SpecDetailDto 的字段名一一对应）。 */
export const SPEC_DETAIL_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["group_name", "分组名"],
  ["name", "品番/品名"],
  ["color", "颜色/配色"],
  ["barcode", "条码"],
  ["quantity", "数量"],
  ["unit", "单位"],
];

export type SpecDetailRow = { group_name: string; name: string; color: string; barcode: string; quantity: string; unit: string };

export const emptySpecDetailRow = (): SpecDetailRow => ({ group_name: "", name: "", color: "", barcode: "", quantity: "", unit: "" });

/** 明细行是不是完全空的行（整行空 = 用户加了行又没填，提交前丢掉，不要写进库）。 */
export const isBlankSpecDetail = (row: SpecDetailRow): boolean =>
  !row.group_name.trim() && !row.name.trim() && !row.color.trim() && !row.barcode.trim() && !row.quantity.trim() && !row.unit.trim();

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
 */
export function specPayload(values: Record<string, string>, details: SpecDetailRow[]): Record<string, unknown> {
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
    sort_order: index,
  }));
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

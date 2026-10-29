/**
 * 材料明细 18 个固定类目的**键 → 中文名**（顺序 = 工艺单「材料」那一列的印刷顺序）。
 *
 * 2026-10-29 起这份清单有三处要用：
 *   ① 导出件（`sales-order-export.service.ts` 印「材料」列）；
 *   ② 服务层（`normalizeMaterialExtras` 给「同类目再加一款」的行**服务端**定类目名 ——
 *      不信任前端传的 label，否则纸上可能印出「伞布」却挂在本该是「伞头」的位置上）；
 *   ③ 校验（`spec_key` 必须恰好是这 18 个之一）。
 *
 * 为什么单独成模块而不是留在导出服务里：服务层不能 import 导出服务（导出服务 import 服务层，会成环）。
 * 三处各抄一份必然漂移，而漂移的表现是「界面上的类目名与纸上的不一样」—— 那种错不会有人当场报，
 * 只会在车间拿着单子来问的时候才发现。所以收成一份，由导出服务 re-export。
 */
export const MATERIAL_CATEGORY_LABELS = [
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
] as const;

export type MaterialCategoryKey = (typeof MATERIAL_CATEGORY_LABELS)[number][0];

const LABEL_BY_KEY = new Map<string, string>(MATERIAL_CATEGORY_LABELS.map(([key, label]) => [key, label]));

/** `spec_key` 是不是那 18 个固定类目之一（导出的 `spec_key` 与「其它」行的类目名是两套东西）。 */
export const isMaterialCategoryKey = (key: string): key is MaterialCategoryKey => LABEL_BY_KEY.has(key);

/** 类目键 → 印刷/界面上的中文名。未知键原样返回：宁可纸上印出键名，也不要印一片空白。 */
export const materialCategoryLabel = (key: string): string => LABEL_BY_KEY.get(key) ?? key;

/** 18 个类目的键（顺序与印刷顺序一致）。 */
export const MATERIAL_CATEGORY_KEYS: readonly MaterialCategoryKey[] = MATERIAL_CATEGORY_LABELS.map(([key]) => key);

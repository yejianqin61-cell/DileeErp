// 原料仓储“余额行”合并。
//
// 曾经的缺陷：页面在 load() 里用 `unitMap`（一个 useMemo 派生的 Map）给没有库存记录的行填单位名，
// 但该 memo 在首次加载时还没被计算出来（同一轮渲染里 u.data 刚拿到），于是这些行的单位名恒为空。
// 单位名必须来自本次请求返回的单位数据本身，而不是任何渲染期派生状态。

export type UnitRef = { id: string; name: string };
export type MaterialRef = { id: string; defaultUnitId: string };
export type BalanceRef = { material_id: string; unit_id: string | null; unit_name: string; order_no: string | null; quantity: string };

/**
 * 合并接口返回的库存余额与物料主数据：没有余额记录的物料补一行 0 库存，
 * 且单位名一律由本次传入的单位数据解析。
 */
export function mergeMaterialBalances<M extends MaterialRef, B extends BalanceRef, R = B & { material: M }>(
  materials: M[],
  units: UnitRef[],
  balances: B[],
  attachMaterial: (row: BalanceRef, material: M) => R
): R[] {
  const materialMap = new Map(materials.map((material) => [material.id, material]));
  const unitMap = new Map(units.map((unit) => [unit.id, unit.name]));
  const rows: R[] = balances
    .filter((row) => materialMap.has(row.material_id))
    .map((row) => attachMaterial({ ...row, unit_name: row.unit_name || unitMap.get(row.unit_id ?? "") || "" }, materialMap.get(row.material_id) as M));
  const existing = new Set(rows.map((row) => `${(row as unknown as BalanceRef).material_id}|${(row as unknown as BalanceRef).unit_id}`));
  for (const material of materials) {
    if (existing.has(`${material.id}|${material.defaultUnitId}`)) continue;
    rows.push(attachMaterial({ material_id: material.id, unit_id: material.defaultUnitId, unit_name: unitMap.get(material.defaultUnitId) ?? "", order_no: null, quantity: "0" }, material));
  }
  return rows;
}

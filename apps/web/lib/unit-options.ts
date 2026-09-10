// 单位下拉选项：全站单位引用统一从单位池（GET /units）取值。
//
// 历史数据里销售单的“单位”是自由文本（SalesOrder.unit 是字符串列），
// 因此下拉必须兼容“库里存着一个单位池里没有的值”：把它作为历史值补进选项，
// 否则用户一打开编辑弹窗就会被迫改单位（甚至因为必填校验无法保存）。

export type UnitOption = { value: string; label: string };
export type UnitLike = { id: string; name: string; isActive?: boolean };

/** 只取启用单位，按名称去重并排序。 */
export function activeUnitOptions(units: UnitLike[]): UnitOption[] {
  const seen = new Set<string>();
  return units
    .filter((unit) => unit.isActive !== false && unit.name.trim() !== "")
    .filter((unit) => (seen.has(unit.name.trim()) ? false : (seen.add(unit.name.trim()), true)))
    .map((unit) => ({ value: unit.name.trim(), label: unit.name.trim() }))
    .sort((left, right) => left.label.localeCompare(right.label, "zh-Hans-CN"));
}

/**
 * 销售单等单位引用用的选项：单位池选项 + （必要时）当前历史值。
 * 历史值同时包括已停用单位：已停用单位不能再被新引用，但旧单据仍需正确回显。
 */
export function unitOptionsWithCurrent(units: UnitLike[], currentValue: string | undefined): UnitOption[] {
  const options = activeUnitOptions(units);
  const wanted = currentValue?.trim();
  if (!wanted || options.some((option) => option.value === wanted)) return options;
  const known = units.find((unit) => unit.name.trim() === wanted);
  return [{ value: wanted, label: known ? `${wanted}（已停用）` : `${wanted}（历史值）` }, ...options];
}

// 完成率展示口径（全站统一）：接口返回的是**比率**（实际 ÷ 计划，例如 "1.0030303030303030303"），
// 界面一律显示成「百分数 + 1 位小数」，例如 85.7%、100.3%、0.0%。
// 约束：只使用可擦除 TS 语法，便于 node:test 直接加载。

const EMPTY = "-";

/**
 * 比率 → 百分数文案（保留 1 位小数）。
 * - 空值 / 非数字 / 非有限数 → "-"（调用方也可用 fallback 覆盖）
 * - 0.857 → "85.7%"，1 → "100.0%"，1.0030303… → "100.3%"，0 → "0.0%"
 */
export function formatCompletionRate(value: string | number | null | undefined, fallback = EMPTY): string {
  if (value === null || value === undefined || value === "") return fallback;
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return fallback;
  return `${(ratio * 100).toFixed(1)}%`;
}

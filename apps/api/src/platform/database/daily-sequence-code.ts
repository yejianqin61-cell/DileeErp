/**
 * 主数据「自动编码」的公共规则：前缀 = 类别 + 当天日期（YYYYMMDD），序号 = 当天同类编码里
 * 数字后缀的最大值 + 1（4 位补零）。物料（MAT-）、供应商（SUP-）、客户（CUS-）共用。
 */

export function dailyCodePrefix(category: string, date: Date = new Date()): string {
  return `${category}-${date.toISOString().slice(0, 10).replaceAll("-", "")}-`;
}

/**
 * 只认纯数字后缀：
 * - 手工编码允许任意字符串（例如 CUS-20260912-ABC），若直接 Number(suffix) 会得到 NaN，
 *   旧实现回退成 0001，可能撞上已存在的 0001 → 用户什么也没做错却收到 409。
 * - 同时避免字符串排序下 "9999" > "10000" 导致序号卡住。
 */
export function nextSequenceCode(prefix: string, codes: Array<string | null | undefined>): string {
  const highest = codes.reduce((max, code) => {
    if (typeof code !== "string" || !code.startsWith(prefix)) return max;
    const suffix = code.slice(prefix.length);
    return /^\d+$/.test(suffix) ? Math.max(max, Number(suffix)) : max;
  }, 0);
  return `${prefix}${String(highest + 1).padStart(4, "0")}`;
}

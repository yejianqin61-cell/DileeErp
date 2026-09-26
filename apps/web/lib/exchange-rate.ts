// 期末汇率面板的纯逻辑（**不能**放进 "use client" 文件）。
//
// 财务 2026-09-24：「1,3,4 都要」的第 ④ 件 —— 期末汇率表 + 外币折算。
// 为什么需要它：凭证上有币种却没有汇率，三大报表是人民币报表；财务每月在这里维护一次
// 「1 外币 = ? 人民币」，报表取数时才能把外币分录折成人民币（汇率变动的影响进现金流量表行次 32）。
//
// 界面口径（与后端 `exchange-rate.service.ts` 逐条对应）：
//   - 按**期间 YYYY-MM** 维护（财务的心智是「9 月的汇率」，月底是 28/30/31 号不该影响取数）；
//   - **整批替换**：界面上这张表就是「这个月的汇率」，保存时整批发出去（不是逐行增删）；
//   - 本币 CNY **不录**（对自身恒为 1），界面直接挡住；
//   - 汇率精度 8 位小数（比金额的 4 位高：汇率是乘数，精度不够的偏差会被当成「汇率变动」）。

// ⚠️ 与 `lib/opening-balance.ts` 同一约定：被 `node:test` 直接跑的 lib 模块**保持自包含**
// （Node 的 ESM 解析器解析不了无扩展名的同级导入），所以这里自带一份 1e-8 的解析/格式化。

const RATE = /^(\d+)(?:\.(\d{1,8}))?$/;
const PERIOD = /^(\d{4})-(\d{2})$/;

/** 汇率文本 → 整数「1e-8」；非法、零一律 null（0 汇率会把整张报表乘成 0，是最坏的一种静默）。 */
export function parseRate(text: string): bigint | null {
  const match = RATE.exec((text ?? "").trim());
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  const units = BigInt(`${whole}${fraction.padEnd(8, "0")}`);
  return units > 0n ? units : null;
}

/** 整数「1e-8」→ 汇率字符串（去掉无意义的尾零）。 */
export function formatRate(units: bigint): string {
  const fraction = (units % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${units / 100_000_000n}.${fraction}` : `${units / 100_000_000n}`;
}

/** 期间是否合法（`YYYY-MM`，月份 01–12）。 */
export function isRatePeriod(text: string): boolean {
  const match = PERIOD.exec((text ?? "").trim());
  if (!match) return false;
  return Number(match[2]) >= 1 && Number(match[2]) <= 12;
}

/** 上一期（本年 1 月 → 上年 12 月）：界面「上一期」按钮与回退提示都用它。 */
export function previousRatePeriod(period: string): string {
  const [year, month] = period.split("-");
  const index = Number(month);
  return index <= 1 ? `${Number(year) - 1}-12` : `${year}-${String(index - 1).padStart(2, "0")}`;
}

/** 后端返回的一行汇率。 */
export type ExchangeRateRow = { currency: string; rate: string; remark?: string | null };

/** 编辑器里的一行（多一个 React key）：币种/汇率在界面上都是字符串，提交前只 trim。 */
export type ExchangeEditorRow = { key: string; currency: string; rate: string; remark: string };

/** 期末汇率接口路径（走 apiGet/apiRequest，前缀由 api-client 补）。 */
export const EXCHANGE_RATES_PATH = "/finance/exchange-rates";

/** 本币：不录汇率（服务层也会拒）。 */
export const LOCAL_CURRENCY = "CNY";

/** 常见外币（界面给出候选，币种本身仍是自由输入 —— 银行账户里可能有任何币种）。 */
export const RATE_CURRENCY_SUGGESTIONS = ["USD", "EUR", "HKD", "JPY", "GBP", "TWD", "SGD", "AUD"];

/** 稳定且不会撞的行 key。 */
let sequence = 0;
export function nextRateRowKey(): string {
  sequence += 1;
  return `rate-row-${sequence}`;
}

/** 新建一行：币种留空（不预设，省得财务把 USD 的汇率存成 EUR 的）。 */
export function emptyRateRow(key: string = nextRateRowKey()): ExchangeEditorRow {
  return { key, currency: "", rate: "", remark: "" };
}

/** 后端行 → 编辑器行。 */
export function rateRowsFromApi(rows: readonly ExchangeRateRow[]): ExchangeEditorRow[] {
  return rows.map((row) => ({ key: nextRateRowKey(), currency: row.currency, rate: row.rate, remark: row.remark ?? "" }));
}

/** 有内容的行（整行都没填的行丢掉，不挡保存 —— 与期初余额、凭证编辑器同一约定）。 */
export function rateRowsToSave(rows: readonly ExchangeEditorRow[]): ExchangeEditorRow[] {
  return rows.filter((row) => row.currency.trim() || row.rate.trim() || row.remark.trim());
}

/**
 * 编辑器状态 → `PUT /finance/exchange-rates` 的请求体。
 *
 * **整批提交**：界面上的这张表就是「这个月的汇率」，服务层整批替换（没出现的币种会被软删）——
 * 逐行提交会让「删掉一个币种」变成额外的删除动作，而财务的心智里没有这一步。
 */
export function ratePayload(period: string, rows: readonly ExchangeEditorRow[]) {
  return {
    period: period.trim(),
    rows: rateRowsToSave(rows).map((row) => ({
      currency: row.currency.trim().toUpperCase(),
      rate: row.rate.trim(),
      remark: row.remark.trim() || undefined,
    })),
  };
}

/** 保存前能拦住的问题（**返回全部原因**，一次说完）。 */
export function rateBlockers(rows: readonly ExchangeEditorRow[], period: string): string[] {
  const problems: string[] = [];
  if (!isRatePeriod(period)) problems.push("请选择汇率期间（YYYY-MM）");
  const seen = new Set<string>();
  rateRowsToSave(rows).forEach((row, index) => {
    const at = index + 1;
    const currency = row.currency.trim().toUpperCase();
    if (!currency) { problems.push(`第 ${at} 行请填写币种`); return; }
    if (currency === LOCAL_CURRENCY) { problems.push(`第 ${at} 行是本币 ${LOCAL_CURRENCY}：本币不需要汇率`); return; }
    if (seen.has(currency)) problems.push(`第 ${at} 行币种 ${currency} 重复了（一个期间一个币种只能有一条汇率）`);
    seen.add(currency);
    const text = row.rate.trim();
    if (!text) problems.push(`第 ${at} 行请填写汇率（1 ${currency} = ? ${LOCAL_CURRENCY}）`);
    else if (parseRate(text) === null) problems.push(`第 ${at} 行汇率必须是大于零的数字（最多 8 位小数）`);
  });
  return problems;
}

/** 界面上的小计：填了几个币种、有没有写错的（红字提示用）。 */
export function rateSummary(rows: readonly ExchangeEditorRow[]): { count: number; invalid: number } {
  const filled = rateRowsToSave(rows);
  return {
    count: filled.filter((row) => row.currency.trim() && parseRate(row.rate) !== null).length,
    invalid: filled.filter((row) => row.rate.trim() && parseRate(row.rate) === null).length,
  };
}

/**
 * 提示财务「这一期用的是哪个月的汇率」：本期没维护时，报表会**回退**到不晚于它的最近一个月。
 *
 * 说清楚这一点比拦住保存重要：报表不会因为某个月没维护就报错，而是拿上个月的汇率折算并在表尾写明
 * —— 界面必须提前告诉她，否则她会以为「没维护 = 没折算」。
 */
export function rateFallbackNote(period: string, maintainedPeriods: readonly string[]): string {
  if (!isRatePeriod(period)) return "";
  if (maintainedPeriods.includes(period)) return `${period} 的汇率已维护，报表用这一期折算`;
  const earlier = maintainedPeriods.filter((item) => item < period).sort();
  const latest = earlier[earlier.length - 1];
  if (!latest) return `${period} 还没有汇率：报表不会折算这个月的外币，会把缺的币种写在表尾`;
  return `${period} 还没维护：报表会回退用 ${latest} 的汇率折算，并在表尾写明`;
}

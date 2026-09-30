// 采购计划的金额口径（前端侧）：行总价、按币种合计、显示格式化。
//
// 为什么不用 `Number(q) * Number(p)`：金额是拿来对账的。`0.1 × 3` 在浮点下是
// 0.30000000000000004，而这一页的合计必须与后端 `sumPlanAmounts`（Prisma Decimal，
// 精确十进制）**逐字对上** —— "界面上的钱"和"采购单上的钱"不是同一个数，是没人能查的一类错。
// 所以这里按 1/10000 为单位做 **BigInt 整数运算**（与 `Decimal(18,4)` 同一个标度），
// 乘法的余数半进位。
//
// 显示口径：内部一律 4 位小数（落库与接口的口径），界面显示 2 位，
// 四舍五入**半进位** —— 与 decimal.js 的 `ROUND_HALF_UP` 一致。
// 不能用 JS 浮点的 `toFixed`：`(2.225).toFixed(2)` 是 "2.22"（2.225 的双精度表示其实略小），
// 后端会给出 "2.23"。这一条有专门的用例钉着（见 `purchase-plan-amount.test.mjs`）。
//
// 也不能用 `toLocaleString`：`lib/audit-columns-coverage.test.mjs` 盯着它 ——
// 它按运行宿主走，导出件与界面会不一致。这里自己插小数点。
export const DEFAULT_PLAN_CURRENCY = "CNY";

/** 内部标度：4 位小数，与 `purchase_plan_items.unit_price` 的 `Decimal(18,4)` 一致。 */
const SCALE = 4;
const SCALE_UNIT = 10n ** BigInt(SCALE);

export type PlanAmount = { currency: string; amount: string };
export type PlanAmountLine = { quantity: string | number | null | undefined; unitPrice: string | number | null | undefined; currency?: string | null };

/**
 * `"17.5"` / `17.5` / `""` → 以 1/10000 为单位的整数。
 *
 * 非数字与半途输入（用户刚敲了一个 `-`、或者清了格）一律当 0：**界面不该为半个输入框报错**，
 * 而这一格的钱最终由服务端校验（下单前要求单价 > 0）。
 */
function scaled(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  const text = String(value).trim();
  if (!text) return 0n;
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match) {
    // 输入框可能给出 `1e5` 这种写法（`<input type="number">` 的 value 允许）。
    // 超出安全范围就放弃：`toFixed` 在 1e21 以上会转成指数写法，递归下去不会收敛。
    const numeric = Number(text);
    if (!Number.isFinite(numeric) || Math.abs(numeric) >= 1e15) return 0n;
    return scaled(numeric.toFixed(SCALE));
  }
  const [, sign = "", whole = "", fraction = ""] = match;
  // 多出来的小数位在半进位下要顶到第 4 位（与落库口径一致）。
  const digits = fraction.padEnd(SCALE + 1, "0");
  let result = BigInt(`${whole || "0"}${digits.slice(0, SCALE)}`);
  if (Number(digits[SCALE]) >= 5) result += 1n;
  return sign === "-" ? -result : result;
}

/** `value / step`，余数半进位（负数对称处理）。 */
function halfUpDiv(value: bigint, step: bigint): bigint {
  const abs = value < 0n ? -value : value;
  const quotient = abs / step;
  const remainder = abs % step;
  const rounded = remainder * 2n >= step ? quotient + 1n : quotient;
  return value < 0n ? -rounded : rounded;
}

/** 把内部整数格式化成 `decimals` 位小数的字符串。 */
function formatScaled(value: bigint, decimals: number): string {
  const rounded = halfUpDiv(value, 10n ** BigInt(SCALE - decimals));
  const negative = rounded < 0n;
  const abs = negative ? -rounded : rounded;
  const unit = 10n ** BigInt(decimals);
  const fraction = (abs % unit).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${(abs / unit).toString()}${decimals ? `.${fraction}` : ""}`;
}

/** 行总价 = 数量 × 单价（4 位小数，与后端同一口径）。 */
export function lineAmount(quantity: PlanAmountLine["quantity"], unitPrice: PlanAmountLine["unitPrice"]): string {
  const product = scaled(quantity) * scaled(unitPrice);
  return formatScaled(halfUpDiv(product, SCALE_UNIT), SCALE);
}

/** 行总价，直接给界面显示（2 位小数）。 */
export function lineAmountText(quantity: PlanAmountLine["quantity"], unitPrice: PlanAmountLine["unitPrice"]): string {
  return amountText(lineAmount(quantity, unitPrice));
}

/**
 * 计划合计：**按币种分组**（仓库约定「金额不跨币种合计」），币种按字母序。
 *
 * 与后端 `purchase-plans.domain.ts` 的 `sumPlanAmounts` 同口径、同输出（4 位小数字符串），
 * 两边用同一组向量钉住（见本文件的测试与 `apps/api/test/unit/purchase-plans-service.test.cjs`）。
 */
export function sumPlanAmounts(lines: readonly PlanAmountLine[]): PlanAmount[] {
  const totals = new Map<string, bigint>();
  for (const line of lines) {
    const currency = line.currency?.trim() || DEFAULT_PLAN_CURRENCY;
    totals.set(currency, (totals.get(currency) ?? 0n) + scaled(lineAmount(line.quantity, line.unitPrice)));
  }
  return [...totals.entries()]
    .map(([currency, amount]) => ({ currency, amount: formatScaled(amount, SCALE) }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

/** 金额显示：4 位小数口径 → 2 位（半进位）。空值显示 0.00，不显示 `NaN`。 */
export function amountText(amount: string | number | null | undefined): string {
  return formatScaled(scaled(amount), 2);
}

/**
 * 「CNY 17.50 · USD 2.00」。**币种写在前面**：计划里同时有多个供应商时，
 * 一个没有币种的数看起来是对的，而它可能是错的。
 */
export function amountSummaryText(amounts: readonly PlanAmount[]): string {
  return amounts.map((row) => `${row.currency} ${amountText(row.amount)}`).join(" · ");
}

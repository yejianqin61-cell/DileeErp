/**
 * 金额的最小公分母：十进制字符串 ↔ 整数「1e-4」（与 DECIMAL(18,4) 同精度）。
 *
 * 为什么单独成模块：金额运算在财务模块里已经有三处用得到 —— 收/付款单的借贷合计
 * （`finance-slip.ts`）、凭证分录的平衡判定（`voucher.domain.ts`）、以及三大报表的
 * 余额与发生额聚合（`finance-three-statements.ts`）。三处各写一份「点分转整数」
 * 就会出现「同一个数字在一张单子上是 149.5、在报表上是 149.49999999」这种无法解释的偏差。
 *
 * 用 BigInt 而不是 `Number`：`0.1 + 0.2 = 0.30000000000000004` 会让「明明平了却不让导出」，
 * 而未分配利润要拿去和资产总计逐位比对（勾稽核对），差一分就是「✗ 不平衡」。
 *
 * 外币折算（`convertUnits`）也归这里：它是「金额 × 汇率 → 金额」的同一个精度问题，
 * 放在别处就会有人用 `Number(amount) * Number(rate)` 再 toFixed(2) —— 那正是上面那个坑的翻版。
 */

/** 合法金额：可选负号 + 整数 + 最多 4 位小数。与 `finance-slip.ts` 当年的 MONEY 正则同一形状，只多了符号。 */
const DECIMAL = /^(-?)(\d+)(?:\.(\d{1,4}))?$/;

/**
 * 十进制字符串 → 整数「1e-4」。**允许负号与零**（余额可以是负数：资产类科目出现贷方余额就是负的）。
 *
 * 非法值直接抛错而不是返回 null：这个函数的调用点拿到的都是库里的 DECIMAL 列或已校验过的界面输入，
 * 解析不了说明数据本身坏了 —— 把一笔坏账静默当成 0 会让报表「看起来平了」，那比报错严重得多。
 */
export function toUnits(text: string): bigint {
  const match = DECIMAL.exec((text ?? "").trim());
  if (!match) throw new Error(`INVALID_AMOUNT:${text}`);
  const [, sign, whole, fraction = ""] = match;
  const units = BigInt(`${whole}${fraction.padEnd(4, "0")}`);
  return sign === "-" ? -units : units;
}

/** 整数「1e-4」→ 十进制字符串（去掉无意义的尾零；负号保留）。 */
export function formatUnits(units: bigint): string {
  const sign = units < 0n ? "-" : "";
  const absolute = units < 0n ? -units : units;
  const fraction = (absolute % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${sign}${absolute / 10000n}.${fraction}` : `${sign}${absolute / 10000n}`;
}

/**
 * 正金额（> 0）→ 整数「1e-4」；非法、零、负数一律返回 `null`。
 *
 * 这是收/付款单要的语义（「一行金额必须是大于零的数字」），所以留在同一个模块里，
 * 与 `toUnits` 只差一条正数判断 —— 两者放在一起，才不会出现「单子说 0 不合法、报表说 0 合法」
 * 这种分叉（它们本来就该不同，但必须一眼看得出为什么不同）。
 */
export function toPositiveUnits(text: string | null | undefined): bigint | null {
  const trimmed = (text ?? "").trim();
  if (!DECIMAL.test(trimmed)) return null;
  const units = toUnits(trimmed);
  return units > 0n ? units : null;
}

/** 一组金额求和（空数组 = 0）。 */
export function sumUnits(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

/* ------------------------------------------------------------------ 期末汇率与折算 */

/**
 * 汇率的最小公分母：整数「1e-8」（与 `exchange_rates.rate` 的 DECIMAL(18,8) 同精度）。
 *
 * 为什么汇率的精度要比金额高：汇率是**乘数**。金额只留 4 位小数时，`1 USD = 7.1234`
 * 与 `7.12345678` 的差在单笔 10 万的凭证上就是 0.57 元；而折算是**逐行**做的，
 * 一张凭证几十行、一个月几百张 —— 精度不够时报表的「汇率变动影响」会变成一个
 * 谁也解释不了的数（明明是四舍五入造成的，却像是一笔业务）。
 */
export const RATE_SCALE = 100_000_000n;

/** 合法汇率：正数 + 最多 8 位小数（**不允许负号、不允许 0**）。 */
const RATE = /^(\d+)(?:\.(\d{1,8}))?$/;

/** 汇率字符串 → 整数「1e-8」；非法、零一律 `null`（0 汇率会把整张报表乘成 0，那是最坏的一种「静默」）。 */
export function toRateUnits(text: string | number | null | undefined): bigint | null {
  const match = RATE.exec(String(text ?? "").trim());
  if (!match) return null;
  const units = BigInt(`${match[1]}${(match[2] ?? "").padEnd(8, "0")}`);
  return units > 0n ? units : null;
}

/** 整数「1e-8」→ 汇率字符串（去掉无意义的尾零）。 */
export function formatRateUnits(units: bigint): string {
  const whole = units / RATE_SCALE;
  const fraction = (units % RATE_SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * 外币金额 × 汇率 → 本币金额（四舍五入到「1e-4」）。
 *
 * `units` 是 1e-4，`rateUnits` 是 1e-8，乘积落在 1e-12 上，所以要除回 1e8。
 * **对绝对值四舍五入**：红冲凭证的金额是负的，`(x + 5) / 10` 这种写法在负数上是「向零取整」，
 * 会让一笔红冲比原凭证少一分 —— 冲不平的凭证在财务眼里就是系统算错了。
 */
export function convertUnits(units: bigint, rateUnits: bigint): bigint {
  const product = units * rateUnits;
  if (product === 0n) return 0n;
  const negative = product < 0n;
  const absolute = negative ? -product : product;
  const rounded = (absolute + RATE_SCALE / 2n) / RATE_SCALE;
  return negative ? -rounded : rounded;
}

/** 本币对自身的汇率恒为 1（折算路径上不必分叉，直接乘也不变）。 */
export const LOCAL_RATE_UNITS = RATE_SCALE;

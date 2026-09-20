import { Prisma } from "@prisma/client";

/**
 * 月度管理费分摊的**纯口径**（无 Nest / Prisma 依赖，可直接用 node:test 跑）。
 *
 * 需求来源：财务 2026-09-20 原话「我这里的管理费是一个月的所以费用的总合平摊在本月生产的总数量中。
 * 比如这个月管理费是22万 生产了4000打货 管理费就是55元」，样本 `example/财务/核算表.xlsx`。
 *
 * 费率 = 月度管理费总额 ÷ 本月分摊数量；某张订单的管理费 = 该订单数量 × 费率。
 *
 * ## 三条必须写清楚的取舍
 *
 * 1. **费率不四舍五入**。老表里 22万/4000打 恰好是 55，所以看不出来；但 22万/3700打 = 59.4594…
 *    一旦先把费率修约成 2 位再乘数量，`单价 × 数量 ≠ 金额`，财务逐行验算时会对不上。
 *    这里的做法与 `finance-report.domain.ts` 的 `localUnitPriceFor` 一致：**金额是权威值，
 *    单价由金额 ÷ 数量反推**，所以恒等式在任何小数位上成立。
 *
 * 2. **单位是分摊的一部分，不是备注**。「55 元/打」与「55 元/支」差 12 倍，而老核算表**没有单位列**
 *    （这是老表的一个真实缺陷，不是我们要照抄的东西）。全站纪律是「不跨单位相加」，所以这里提供
 *    `allocationUnitMatches`：只有订单单位与登记单位归一后相同才套费率，不同的行留空并在表尾点名。
 *
 * 3. **分摊数量可以人工覆盖**。自动值是「本月计件日报（`employee_daily_reports`）的数量」，
 *    而计件日报是**按人按工序逐条**填报的 —— 同一件货经过三道工序会出现在三条日报里，
 *    跨工序合计会重复计件。自动值因此只是参考；财务在页面上覆盖成「本月实际生产数量」才是准的。
 */

/* ------------------------------------------------------------------ 单位归一 */

/**
 * 与 `sales-orders.service.ts` 的 `PIECE_UNITS` / `DOZEN_UNITS` **同一份同义词表**。
 *
 * 为什么在这里再写一份而不是 import 那个模块：`normalizeSpecUnit` 在 sales 服务文件里，
 * 从 finance 引它会把整个销售服务（含 Nest 装饰器与 Prisma 依赖）拖进这个纯口径模块。
 * 两份常量靠 `overhead-allocation-domain.test.cjs` 用同一组测试向量（含带末尾标点的写法）
 * 逐词比对两边结果，所以任何一边改了同义词或归一规则，测试立刻红 —— 这正是当年
 * 「收支项目字典」两处各写一份时缺的那道闸。
 */
const PIECE_UNITS = ["pcs", "pc", "piece", "pieces", "支", "只", "个", "把"];
const DOZEN_UNITS = ["dz", "doz", "dozen", "打"];

/** 归一后的单位标识：`piece` / `dozen` / 原样小写；空值返回 null。 */
export function normalizeAllocationUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  // 末尾的 `.` / `。` 不计入单位名（与 `normalizeSpecUnit` 逐字对齐 —— 两张表必须给出同一个结果，
  // 否则同一个原始值在销售侧算「打」、在核算表侧算另一个单位，费率会差 12 倍且看不出来）。
  const key = unit.trim().toLowerCase().replace(/[.。]$/, "");
  if (!key) return null;
  if (PIECE_UNITS.includes(key)) return "piece";
  if (DOZEN_UNITS.includes(key)) return "dozen";
  return key;
}

/**
 * 归一标识 → 该单位的全部原始写法（把筛选下推到 SQL 的 `IN`，避免把整月日报读回内存）。
 *
 * 除了同义词本身，还带上它们的**带末尾标点**写法（`打` / `打.` / `打。`）：
 * `normalizeAllocationUnit` 会把末尾标点去掉，所以这三者在业务上是同一个单位；
 * SQL 的 `IN` 不会做这个归一，不把它们列出来的话，
 * 「登记填「打」、日报的单位名是「打.」」这种数据会让自动分摊数量算成 0，而页面上只显示一个 0。
 */
export function allocationUnitCandidates(unit: string | null | undefined): string[] {
  const normalized = normalizeAllocationUnit(unit);
  if (!normalized) return [];
  const synonyms = normalized === "piece" ? PIECE_UNITS : normalized === "dozen" ? DOZEN_UNITS : [unit?.trim() ?? ""].filter(Boolean);
  return [...synonyms, ...synonyms.map((value) => `${value}.`), ...synonyms.map((value) => `${value}。`)];
}

/**
 * 两个单位是否**同一个单位**。任一为空 → false（空单位不能「碰巧相等」，
 * 否则一张没填单位的订单会跟任何登记单位套上费率）。
 */
export function allocationUnitMatches(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normalizeAllocationUnit(left);
  const b = normalizeAllocationUnit(right);
  return Boolean(a && b && a === b);
}

/* ------------------------------------------------------------------ 数量与费率 */

export type OverheadAllocationFacts = {
  /** 本月管理费总额。 */
  amount: Prisma.Decimal | string | number;
  /** 分摊单位（打 / 支…）。 */
  unit: string | null;
  /** 人工覆盖的分摊数量；留空表示用自动汇总值。 */
  quantityOverride?: Prisma.Decimal | string | number | null;
  /** 自动汇总值（本月计件日报数量，已按登记单位过滤），可以为 0 / null。 */
  autoQuantity?: Prisma.Decimal | string | number | null;
};

const decimalOf = (value: Prisma.Decimal | string | number | null | undefined): Prisma.Decimal | null => {
  if (value === null || value === undefined || value === "") return null;
  return new Prisma.Decimal(value);
};

/**
 * 实际参与分摊的数量。
 *
 * 覆盖值**只要填了就优先**（哪怕它是 0 —— 0 是「这个月没生产」这个事实，不能被自动值顶掉；
 * 自动值算出来是 0 才是「没有数据」）。覆盖值缺失（null/undefined）时才用自动值。
 */
export function allocationQuantity(facts: OverheadAllocationFacts): Prisma.Decimal | null {
  const override = decimalOf(facts.quantityOverride);
  if (override !== null) return override;
  return decimalOf(facts.autoQuantity);
}

/**
 * 费率 = 总额 ÷ 数量。数量缺失或 ≤ 0 时返回 **null**（不是 0，也不是 NaN）：
 * 「算不出费率」与「费率是 0」在表上是两件事 —— 前者要在表尾点名，后者是一张真表。
 */
export function allocationRate(facts: OverheadAllocationFacts): Prisma.Decimal | null {
  const quantity = allocationQuantity(facts);
  if (!quantity || quantity.lte(0)) return null;
  const amount = decimalOf(facts.amount);
  if (!amount) return null;
  return amount.div(quantity);
}

/** 某行的管理费金额 = 数量 × 费率；费率或数量缺失时返回 null（留空，不写 0）。 */
export function allocationAmountFor(
  rate: Prisma.Decimal | string | number | null | undefined,
  quantity: Prisma.Decimal | string | number | null | undefined,
): Prisma.Decimal | null {
  const rateValue = decimalOf(rate);
  const quantityValue = decimalOf(quantity);
  if (!rateValue || !quantityValue) return null;
  return rateValue.mul(quantityValue);
}

/** 金额 ÷ 数量（单价列的口径：由金额反推，保证 `单价 × 数量 = 金额`）。 */
export function unitAmountOf(
  amount: Prisma.Decimal | string | number | null | undefined,
  quantity: Prisma.Decimal | string | number | null | undefined,
): Prisma.Decimal | null {
  const total = decimalOf(amount);
  const count = decimalOf(quantity);
  if (!total || !count || count.lte(0)) return null;
  return total.div(count);
}

/** 占比 = 某段费用 ÷ 费用合计。合计缺失或为 0 时返回 null（老表这里是 `#DIV/0!`，我们不写那个）。 */
export function shareOf(
  part: Prisma.Decimal | string | number | null | undefined,
  total: Prisma.Decimal | string | number | null | undefined,
): Prisma.Decimal | null {
  const partValue = decimalOf(part) ?? new Prisma.Decimal(0);
  const totalValue = decimalOf(total);
  if (!totalValue || totalValue.eq(0)) return null;
  return partValue.div(totalValue);
}

/* ------------------------------------------------------------------ 期间 */

/** 期间字面量 `YYYY-MM` 是否合法。 */
export function isAllocationPeriod(value: string | null | undefined): boolean {
  return Boolean(value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value));
}

/** 期间的起止日（`YYYY-MM-01` / 月末），交给 `financeDayRange` 变成 Prisma 范围。 */
export function allocationPeriodDays(period: string): { from: string; to: string } {
  const [year, month] = period.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(lastDay).padStart(2, "0")}` };
}

/**
 * 报表筛选区间对应的分摊期间。
 *
 * 分摊是按月登记的，所以报表只看**一个月**：有起始日就用起始日所在的月份，
 * 否则用结束日所在的月份，两者都没有就返回 null（不套费率、不算管理费）。
 * 区间跨月时由 `allocationSpansMonths` 报出来，在表尾点名 —— 悄悄按起始月算费率
 * 会让 9 月 1 日到 10 月 31 日的报表把 10 月的订单也乘上 9 月的费率。
 */
export function allocationPeriodOf(from?: string | null, to?: string | null): string | null {
  const text = (from ?? to ?? "").slice(0, 7);
  return isAllocationPeriod(text) ? text : null;
}

/** 筛选区间是否跨月（两端都有值且月份不同）。 */
export function allocationSpansMonths(from?: string | null, to?: string | null): boolean {
  if (!from || !to) return false;
  return from.slice(0, 7) !== to.slice(0, 7);
}

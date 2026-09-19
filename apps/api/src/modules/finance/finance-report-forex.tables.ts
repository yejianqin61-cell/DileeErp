import { Prisma } from "@prisma/client";
import { NUMBER_FORMAT, currencyLabel, toDateText, toExportNumber } from "./finance-report.domain";
import type { ReportCell, ReportColumn, ReportTable } from "./finance-report.types";

/**
 * 外汇一览表的版式与行构造（纯函数，不碰数据库）。
 *
 * 需求来源：用户 2026-09-17 交付 `example/财务/外汇一览表.xlsx`，要求「这个表单导出……
 * 按照客户进行按照月份，年份或者任意时间跨度的收束统计」。
 *
 * 老表是**两张表拼一张 sheet** 的形态（一张明细 + 手写的分组），这里拆成**两个工作表**：
 *   - 「外汇一览」：一行 = 一次成品出库，含该出库归属到的收款；
 *   - 「客户汇总」：一行 = 客户 × 币种，把明细按客户收束起来。
 * 两张表来自同一份取数结果，因此不可能对不上帐。
 *
 * 与老表的**四处刻意偏离**（都是因为照抄会把错算术带进来，不是遗漏）：
 *   1. **加了「币种」列**，并按币种分段。老表把 `$6,200` 与 `￥1,005` 写在同一列里，
 *      照抄就等于承认「美元与人民币可以相加」——这在本仓库是明确的红线（见 R7）。
 *   2. **每笔收款只出现一次**。老表把同一个订单的定金抄在该订单的每一行出库上
 *      （样本 R5/R6 的定金都是 `$620`），按老表求和会把定金重复计算。
 *      这里把「没有核销到具体出库」的收款（典型是出货前收到的定金）归到该订单
 *      **出货日期最早的那次出库**上（同日按出库单号）。
 *   3. **加了「其他到账」列**。老表只有「定金 / 货款」两列，而系统的款项性质有四个取值，
 *      硬把「其他」「未标注」塞进货款列就是编数据。汇入总金额 = 定金 + 货款 + 其他到账，
 *      三列一定加得起来。
 *   4. **加了「订单号」维度到汇总表**（订单数 / 出库数 / 已完结 / 未完结），
 *      因为用户要的是「收束统计」，只有金额没有单量看不出这个客户这个月做了多少单。
 *
 * 「银行手续费」与「跟单」两列**恒为空**：系统里没有任何字段记录它们（用户 2026-09-17 确认
 * 「两列都留空 + 导出文件表尾写清」）。它们不出现在 `totalColumns` 里，也不参与任何计算。
 */

const numeric = (header: string, width: number): ReportColumn => ({ header, width, numFmt: NUMBER_FORMAT });

/** 一行外汇一览的取数结果（一次成品出库 + 归属到它的收款）。 */
export type ForexReceiptRow = {
  customerName: string;
  /** 出库/应收的币种：这一行的所有金额都是这个币种，跨币种的收款不会被归进来。 */
  currency: string;
  orderNo: string;
  /** 订单数量（销售订单上的计划量），与出货数量不是一回事。 */
  orderQuantity: Prisma.Decimal | null;
  shipmentDate: Date | null;
  outboundNo: string;
  quantity: Prisma.Decimal | null;
  unit: string | null;
  unitPrice: Prisma.Decimal | null;
  /** 货款金额 = 这次出库的应收金额。**这是整张出库单的金额，不是本期收到的钱。** */
  amount: Prisma.Decimal;
  /** 期间内的定金（款项性质 = 定金）。日期取期间内最后一笔的日期。 */
  depositDate: Date | null;
  depositAmount: Prisma.Decimal;
  /** 期间内的货款（款项性质 = 货款 或 尾款 —— 老表的「货款」列就是这两者合起来）。 */
  balanceDate: Date | null;
  balanceAmount: Prisma.Decimal;
  /** 期间内的其他到账（款项性质 = 其他，或没标注）。 */
  otherAmount: Prisma.Decimal;
  /** 期间内的到账合计 = 定金 + 货款 + 其他。 */
  receivedAmount: Prisma.Decimal;
  /** 截至期间末的累计已收（含期间外），用来算欠尾款。 */
  receivedToDate: Prisma.Decimal;
  /** 欠尾款 = 货款金额 − 累计已收。负数表示超收（不该发生，但报表不隐藏它）。 */
  outstanding: Prisma.Decimal;
  remark: string | null;
};

/** 出库应收 − 累计已收。与应收侧 `receivableOutstanding` 同一口径，只是没有调整单参与。 */
export function forexOutstanding(amount: Prisma.Decimal, receivedToDate: Prisma.Decimal): Prisma.Decimal {
  return amount.minus(receivedToDate);
}

/**
 * 「是否完结」。
 *
 * 老表只有「结清 / 完结」两种写法（还有大量空白）。这里给三种取值，因为**「一分钱没收到」
 * 与「收了一部分」是两种完全不同的催款动作**，合成一个「未结清」会让财务看不出该催谁。
 */
export function forexSettlement(outstanding: Prisma.Decimal, receivedToDate: Prisma.Decimal): string {
  if (receivedToDate.lte(0)) return "未收款";
  return outstanding.lte(0) ? "结清" : "未结清";
}

/** 外汇一览明细表的列定义：21 列（老表 19 列 + 币种 + 其他到账）。 */
export const FOREX_DETAIL_COLUMNS: ReportColumn[] = [
  { header: "客户", width: 18 },
  { header: "币种", width: 10 },
  { header: "订单号", width: 18 },
  numeric("订单数量", 12),
  // 跟单：系统无此字段（用户 2026-09-17 确认留空 + 表尾说明）。
  { header: "跟单", width: 10 },
  { header: "出货日期", width: 12 },
  { header: "单位", width: 8 },
  numeric("出货数量", 12),
  numeric("单价", 12),
  numeric("货款金额", 14),
  { header: "定金日期", width: 12 },
  numeric("定金金额", 14),
  { header: "货款日期", width: 12 },
  numeric("货款金额", 14),
  numeric("其他到账", 14),
  numeric("汇入总金额", 14),
  // 银行手续费：系统无此字段，恒空。
  numeric("银行手续费", 12),
  numeric("实到账金额", 14),
  numeric("欠尾款", 14),
  { header: "是否完结", width: 12 },
  { header: "备注", width: 30 },
];

export function buildForexDetailTable(
  rows: ForexReceiptRow[],
  options: { currencyLabels: ReadonlyMap<string, string>; footnotes?: string[] },
): ReportTable {
  return {
    sheetName: "外汇一览",
    columns: FOREX_DETAIL_COLUMNS,
    rows: rows.map((row): ReportCell[] => {
      // 银行手续费系统里没有字段：恒为 0，因此「实到账金额 = 汇入总金额 − 0 = 汇入总金额」。
      // 写成一条算式而不是直接把两列填成同一个值，是为了让「这里本该扣手续费、只是没有数据」
      // 这件事留在代码里 —— 将来加了这个字段，改的只有这一行。
      const bankFee = ZERO;
      const actual = row.receivedAmount.minus(bankFee);
      return [
        row.customerName, // 客户
        currencyLabel(row.currency, options.currencyLabels), // 币种
        row.orderNo, // 订单号
        toExportNumber(row.orderQuantity), // 订单数量
        null, // 跟单（系统无此字段）
        toDateText(row.shipmentDate), // 出货日期
        row.unit, // 单位
        toExportNumber(row.quantity), // 出货数量
        toExportNumber(row.unitPrice), // 单价
        toExportNumber(row.amount), // 货款金额（整张出库单的应收）
        toDateText(row.depositDate), // 定金日期（期间内最后一笔；期间内没有定金则空）
        row.depositAmount.lte(0) ? null : toExportNumber(row.depositAmount), // 定金金额
        toDateText(row.balanceDate), // 货款日期
        row.balanceAmount.lte(0) ? null : toExportNumber(row.balanceAmount), // 货款金额
        row.otherAmount.lte(0) ? null : toExportNumber(row.otherAmount), // 其他到账
        toExportNumber(row.receivedAmount), // 汇入总金额
        null, // 银行手续费（系统无此字段）
        toExportNumber(actual), // 实到账金额（未扣手续费，见表尾说明）
        toExportNumber(row.outstanding), // 欠尾款
        forexSettlement(row.outstanding, row.receivedToDate), // 是否完结
        row.remark, // 备注
      ];
    }),
    // **不设 totalColumns**：本表一行一个币种，跨币种相加没有意义（R7，与收支明细表同一处理）。
    // 需要合计时看「客户汇总」——那边按币种分段给合计。
    footnotes: [
      "本表按币种分行、不跨币种相加（同一客户既有美元又有人民币时会出现多行）。",
      "期间按**收款（实际到账）日期**筛选：一条出库出现在本表里，是因为它在期间内确实收到了钱。",
      "「货款金额」是**整张出库单的应收金额**，不是本期收到的钱；本期收到多少看「汇入总金额」。",
      "「汇入总金额」= 定金 + 货款 + 其他到账，三列一定加得起来；未标注款项性质的收款算进「其他到账」。",
      "「欠尾款」= 货款金额 − **截至期间末的累计已收**（含期间外的收款），所以它是一个时点余额，不能跨期间相加。",
      "「跟单」与「银行手续费」系统里没有字段记录，两列恒为空（财务报表导出不编数据）。",
      "「实到账金额」= 汇入总金额（未扣银行手续费）——手续费没有字段可用，所以这里给的就是汇入额本身。",
      ...(options.footnotes ?? []),
    ],
  };
}

/** 客户汇总的一行（一个客户 × 一个币种）。 */
export type ForexCustomerSummaryRow = {
  customerName: string;
  currency: string;
  orderCount: number;
  outboundCount: number;
  depositAmount: Prisma.Decimal;
  balanceAmount: Prisma.Decimal;
  otherAmount: Prisma.Decimal;
  receivedAmount: Prisma.Decimal;
  outstanding: Prisma.Decimal;
  settledOrderCount: number;
  openOrderCount: number;
};

/** 客户汇总表的列定义：13 列。 */
export const FOREX_SUMMARY_COLUMNS: ReportColumn[] = [
  { header: "客户", width: 20 },
  { header: "币种", width: 10 },
  numeric("订单数", 10),
  numeric("出库数", 10),
  numeric("定金合计", 14),
  numeric("货款合计", 14),
  numeric("其他到账", 14),
  numeric("汇入总金额", 14),
  // 与明细表同：系统无此字段，恒空。
  numeric("银行手续费", 12),
  numeric("实到账金额", 14),
  numeric("欠尾款", 14),
  numeric("已完结订单数", 14),
  numeric("未完结订单数", 14),
];

const ZERO = new Prisma.Decimal(0);

/**
 * 由明细行构造客户汇总（纯函数）：**按币种分段**，段内一行一个客户，段末给该币种的合计。
 *
 * 为什么按币种分段而不是一行一个客户：一个客户同时有美元和人民币时，一行一个客户就得给
 * 「汇入总金额」摆两个格，或者相加（错）；分段后每个数都只属于一个币种，段末的合计也只加同币种。
 *
 * 「已完结/未完结」按**订单**计数而不是按出库行：一个订单多次出库时，行数会让「未完结」虚高，
 * 而催款是按订单催的。判定口径与明细行一致（该订单所有出库行都结清才算完结）。
 */
export function buildForexCustomerSummaryTable(
  rows: ForexReceiptRow[],
  options: { currencyLabels: ReadonlyMap<string, string> },
): ReportTable {
  const currencies = [...new Set(rows.map((row) => row.currency))].sort();
  const tableRows: ReportCell[][] = [];

  for (const currency of currencies) {
    const label = currencyLabel(currency, options.currencyLabels);
    const inCurrency = rows.filter((row) => row.currency === currency);
    const byCustomer = new Map<string, ForexReceiptRow[]>();
    for (const row of inCurrency) {
      const list = byCustomer.get(row.customerName) ?? [];
      list.push(row);
      byCustomer.set(row.customerName, list);
    }

    let orders = 0;
    let outbounds = 0;
    let deposit = ZERO;
    let balance = ZERO;
    let other = ZERO;
    let received = ZERO;
    let outstanding = ZERO;
    let settled = 0;
    let open = 0;

    for (const [customerName, customerRows] of byCustomer) {
      const summary = summarizeCustomer(customerName, currency, customerRows);
      orders += summary.orderCount;
      outbounds += summary.outboundCount;
      deposit = deposit.plus(summary.depositAmount);
      balance = balance.plus(summary.balanceAmount);
      other = other.plus(summary.otherAmount);
      received = received.plus(summary.receivedAmount);
      outstanding = outstanding.plus(summary.outstanding);
      settled += summary.settledOrderCount;
      open += summary.openOrderCount;
      tableRows.push([
        customerName, label, summary.orderCount, summary.outboundCount,
        toExportNumber(summary.depositAmount), toExportNumber(summary.balanceAmount), toExportNumber(summary.otherAmount),
        toExportNumber(summary.receivedAmount), null, toExportNumber(summary.receivedAmount),
        toExportNumber(summary.outstanding), summary.settledOrderCount, summary.openOrderCount,
      ]);
    }
    // 段末合计：只在本币种内相加。
    tableRows.push([
      "合计", label, orders, outbounds,
      toExportNumber(deposit), toExportNumber(balance), toExportNumber(other),
      toExportNumber(received), null, toExportNumber(received),
      toExportNumber(outstanding), settled, open,
    ]);
  }

  return {
    sheetName: "客户汇总",
    columns: FOREX_SUMMARY_COLUMNS,
    rows: tableRows,
    // 不设 totalColumns：合计已经在每个币种段末按币种分别给出了。
    footnotes: [
      "本表按币种分段、不跨币种相加：每个币种一段，段末的「合计」只统计该币种。",
      "金额列都是**期间内实际到账**；「欠尾款」是截至期间末的余额（时点值，不能跨期间相加）。",
      "订单数 / 出库数按去重后的订单号与出库单号统计；一个订单分批出库只算一个订单。",
      "「已完结/未完结」按订单计数：该订单在期间内的所有出库行都结清才算已完结。",
      "「银行手续费」系统里没有字段记录，恒为空；「实到账金额」因此等于汇入总金额（未扣手续费）。",
    ],
  };
}

/** 一个客户的汇总（内部用；同一订单在多行出现时只按订单计一次）。 */
function summarizeCustomer(customerName: string, currency: string, rows: ForexReceiptRow[]): ForexCustomerSummaryRow {
  const byOrder = new Map<string, ForexReceiptRow[]>();
  for (const row of rows) {
    const list = byOrder.get(row.orderNo) ?? [];
    list.push(row);
    byOrder.set(row.orderNo, list);
  }
  let settledOrderCount = 0;
  for (const orderRows of byOrder.values()) {
    // 订单完结 = 该订单在表里的每一行都结清（欠尾款 ≤ 0）。任一行为负余额即未完结。
    if (orderRows.every((row) => row.outstanding.lte(0))) settledOrderCount += 1;
  }
  return {
    customerName,
    currency,
    orderCount: byOrder.size,
    outboundCount: rows.length,
    depositAmount: rows.reduce((sum, row) => sum.plus(row.depositAmount), ZERO),
    balanceAmount: rows.reduce((sum, row) => sum.plus(row.balanceAmount), ZERO),
    otherAmount: rows.reduce((sum, row) => sum.plus(row.otherAmount), ZERO),
    receivedAmount: rows.reduce((sum, row) => sum.plus(row.receivedAmount), ZERO),
    outstanding: rows.reduce((sum, row) => sum.plus(row.outstanding), ZERO),
    settledOrderCount,
    openOrderCount: byOrder.size - settledOrderCount,
  };
}

/* ------------------------------------------------------------------ 归属与「归不到」的说明 */

/**
 * 一笔待归属的收入流水。
 *
 * `inPeriod` 是**期间内的准入标记**：期间外的收款一样要参与「欠尾款」的计算（累计已收），
 * 但不该让一行出库出现在本期的表里 —— 否则 8 月收到的一笔定金会让那一行在之后每个月的
 * 报表里都冒出来，用户按月份看就再也分不清「这个月到底收了什么」。
 */
export type ForexReceiptEntry = {
  id: string;
  entryNo: string;
  entryDate: Date;
  amount: Prisma.Decimal;
  currency: string;
  paymentNature: string | null;
  orderNo: string | null;
  sourceType: string | null;
  sourceId: string | null;
  inPeriod: boolean;
};

/** 归属目标：一次**挂得出应收**的成品出库（应收来源的 `outbound_id` 是唯一的）。 */
export type ForexOutbound = {
  outboundId: string;
  outboundNo: string;
  orderNo: string;
  customerId: string | null;
  customerName: string;
  currency: string;
  amount: Prisma.Decimal;
  unitPrice: Prisma.Decimal | null;
  unit: string | null;
  quantity: Prisma.Decimal | null;
  shipmentDate: Date | null;
  orderQuantity: Prisma.Decimal | null;
  remark: string | null;
};

/** 归不到明细行的原因。每一种的处置办法不一样，所以分开列而不是笼统说「无法归属」。 */
export type ForexUnattributedReason = "reconciliation" | "no_outbound" | "no_order" | "currency_mismatch";

export type ForexUnattributed = {
  entryNo: string;
  entryDate: Date;
  amount: Prisma.Decimal;
  currency: string;
  orderNo: string | null;
};

const UNATTRIBUTED_TEXT: Record<ForexUnattributedReason, string> = {
  reconciliation: "来自「按对账单一键确认应收」：一笔流水覆盖多张出库单，拆不出每张各收了多少",
  no_outbound: "对应的订单还没有成品出库（多为出货前收到的定金）",
  no_order: "流水上没有订单号，归不到任何客户/订单",
  currency_mismatch: "收款币种与出库应收的币种不一致，不能加在同一行",
};

/** 表尾最多列几个标识符：列全了会把表尾盖过正文（与 `footnoteLines` 同一考虑）。 */
const MAX_LISTED = 10;

function sumDecimals(values: readonly Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((total, value) => total.plus(value), new Prisma.Decimal(0));
}

/** 按币种分组求和再拼成人能读的一段 —— 跨币种只并列、绝不相加。 */
function amountText(items: readonly ForexUnattributed[]): string {
  const byCurrency = new Map<string, Prisma.Decimal>();
  for (const item of items) byCurrency.set(item.currency, (byCurrency.get(item.currency) ?? new Prisma.Decimal(0)).plus(item.amount));
  return [...byCurrency.entries()].map(([currency, amount]) => `${amount.toFixed(2)} ${currency}`).join("、");
}

/**
 * 把「归不到的收款」写成表尾说明。
 *
 * 为什么不能干脆不提：这些钱**确实进账了**，只是没法摊到某一行出库上。静默丢掉会让
 * 「表里的汇入总金额」小于银行流水，财务对不上账却看不出少在哪；把它们硬塞进某一行
 * 又会把那一行的欠尾款做错。所以列出来，并写清每一类该怎么处理。
 */
export function forexUnattributedFootnotes(buckets: Record<ForexUnattributedReason, ForexUnattributed[]>): string[] {
  const lines: string[] = [];
  for (const reason of Object.keys(UNATTRIBUTED_TEXT) as ForexUnattributedReason[]) {
    const items = buckets[reason] ?? [];
    if (!items.length) continue;
    const labels = items.slice(0, MAX_LISTED).map((item) => item.orderNo ?? `流水 ${item.entryNo}`);
    const more = items.length > labels.length ? `，另有 ${items.length - labels.length} 笔未列出` : "";
    lines.push(`另有 ${items.length} 笔到账（合计 ${amountText(items)}）${UNATTRIBUTED_TEXT[reason]}，因此未列入明细（不含在汇入总金额里）：${labels.join("、")}${more}`);
  }
  return lines;
}

/** 字符串比较：用固定 locale + 数字敏感，保证同一份数据两次导出顺序一致。 */
export function compareText(left: string, right: string): number {
  return left.localeCompare(right, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
}

/** 一组日期里最晚的那个；空数组返回 null。 */
export function lastDate(values: readonly Date[]): Date | null {
  if (!values.length) return null;
  return values.reduce((latest, value) => (value.valueOf() > latest.valueOf() ? value : latest));
}

export { sumDecimals };


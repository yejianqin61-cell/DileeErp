import { Prisma } from "@prisma/client";
import {
  NUMBER_FORMAT,
  currencyLabel,
  localAmountFor,
  localUnitPriceFor,
  localRevenueOf,
  profitAmount,
  salesExchangeRate,
  toDateText,
  toDecimal,
  toExportNumber,
} from "./finance-report.domain";
import { settlementText } from "./cash-flow.domain";
import {
  allocationAmountFor,
  allocationUnitMatches,
  shareOf,
  unitAmountOf,
} from "./overhead-allocation.domain";
import type { ReportCell, ReportColumn, ReportTable } from "./finance-report.types";

/**
 * 报表版式与行构造（纯函数，不碰数据库）。
 *
 * **列名与列序照抄 `example/财务/` 下的老表**（用户 R1），sheet 名用规范中文
 * （老系统的 sheet 名有拼写错误：`SaleOrderAmout Management`、`Saleorder Management`，不照抄）。
 *
 * 三个口径（见 `docs/design/finance-example-forms-export-mapping-design-2026-09-14.md`）：
 * - R2：销售对账明细表缺字段的列（产品代码 / 含税单价 / 税额 / 调整金额 / 折扣 / 含税金额）**留空**；
 * - R3：采购「含税单价 = 单价、含税金额 = 金额」（系统采购单价即含税价）；
 * - 汇率与本币列由「本币金额 ÷ 原币金额」派生，不需要新字段。
 */

/** 数值列的格式统一为 `0.####`，逐格还原老表的显示（见 `NUMBER_FORMAT` 的说明）。 */
const numeric = (header: string, width: number): ReportColumn => ({ header, width, numFmt: NUMBER_FORMAT });

/**
 * 百分比列。
 *
 * 单元格里写的是**小数**（0.55 显示成 55%），由 Excel 自己渲染百分号 —— 在字符串里拼一个「%」
 * 会把它变成文本单元格，那一列就再也参与不了求和/排序（正是老表的毛病，见 `NUMBER_FORMAT`）。
 * 所以占比列仍然是数值列，只是格式不同；它不进 `totalColumns`，因为占比跨行相加没有意义。
 */
const percent = (header: string, width: number): ReportColumn => ({ header, width, numFmt: "0.00%" });

/* ------------------------------------------------------------------ 销售对账明细表 */

/** 销售对账明细表的列定义：23 列，列名与列序照抄 `销售对账明细表.xls`。 */
export const SALES_RECONCILIATION_DETAIL_COLUMNS: ReportColumn[] = [
  { header: "日期", width: 12 },
  { header: "销售单号", width: 20 },
  { header: "客户名称", width: 22 },
  { header: "产品名称", width: 30 },
  { header: "产品代码", width: 18 },
  { header: "规格型号", width: 24 },
  { header: "单位", width: 8 },
  { header: "币种", width: 10 },
  numeric("单价", 12),
  numeric("含税单价", 12),
  numeric("税额", 12),
  numeric("调整金额", 12),
  numeric("折扣", 10),
  numeric("数量", 10),
  numeric("金额", 14),
  numeric("含税金额", 14),
  numeric("汇率", 10),
  numeric("单价(本)", 12),
  numeric("含税单价(本)", 14),
  numeric("税额(本)", 12),
  numeric("调整金额(本)", 14),
  numeric("金额(本)", 14),
  numeric("含税金额(本)", 14),
];

/** 合计列：金额(14) 与 金额(本)(21)。数量跨单位相加没有意义，不参与合计。 */
const SALES_TOTAL_COLUMNS = [14, 21];

/** 一行销售对账明细的取数结果（直取字段 + 汇率/本币派生所需的销售单事实）。 */
export type SalesReconciliationDetailSource = {
  /**
   * 销售单日期（`sales_orders.order_date`）。
   * 老表「日期」列与销售单号内嵌的日期一致（`XSDD`**20260907** ↔ 2026-09-07），
   * 因此是销售单日期而不是出库日期（见设计文档 §1.4）。
   */
  date: Date | null;
  orderNo: string;
  customerName: string | null;
  productName: string | null;
  productSpecification: string | null;
  unit: string | null;
  currency: string | null;
  unitPrice: Prisma.Decimal | null;
  quantity: Prisma.Decimal | null;
  amount: Prisma.Decimal | null;
  /** 销售单上的换算依据（本币金额 ÷ 原币金额 = 汇率） */
  order: {
    currency: string | null;
    totalAmount: Prisma.Decimal | null;
    receivableAmount: Prisma.Decimal | null;
    localCurrencyAmount: Prisma.Decimal | null;
  } | null;
};

export function buildSalesReconciliationDetailTable(
  rows: SalesReconciliationDetailSource[],
  options: { currencyLabels: ReadonlyMap<string, string> },
): ReportTable {
  return {
    sheetName: "销售对账明细",
    columns: SALES_RECONCILIATION_DETAIL_COLUMNS,
    rows: rows.map((row): ReportCell[] => {
      // 外币的汇率/本币都从销售单的「本币金额」派生；销售单缺失时只剩币种可用于判断本位币。
      const order = row.order ?? { currency: row.currency, totalAmount: null, receivableAmount: null, localCurrencyAmount: null };
      const rate = salesExchangeRate(order);
      const localAmount = localAmountFor(row.amount, order);
      const localUnitPrice = localUnitPriceFor(localAmount, row.quantity);
      return [
        toDateText(row.date), // 日期
        row.orderNo, // 销售单号
        row.customerName, // 客户名称
        row.productName, // 产品名称
        null, // 产品代码：系统没有该字段（R2 留空）
        row.productSpecification, // 规格型号
        row.unit, // 单位
        currencyLabel(row.currency ?? order.currency, options.currencyLabels), // 币种
        toExportNumber(row.unitPrice), // 单价
        null, // 含税单价（R2 留空）
        null, // 税额（R2 留空）
        null, // 调整金额（R2 留空；系统里它是独立的调整单，不是应收来源上的字段）
        null, // 折扣（R2 留空）
        toExportNumber(row.quantity), // 数量
        toExportNumber(row.amount), // 金额
        null, // 含税金额（R2 留空）
        toExportNumber(rate), // 汇率
        toExportNumber(localUnitPrice), // 单价(本)
        null, // 含税单价(本)（R2 留空）
        null, // 税额(本)（R2 留空）
        null, // 调整金额(本)（R2 留空）
        toExportNumber(localAmount), // 金额(本)
        null, // 含税金额(本)（R2 留空）
      ];
    }),
    totalColumns: SALES_TOTAL_COLUMNS,
  };
}

/* ------------------------------------------------------------------ 采购对账明细表 */

/**
 * 采购对账明细表的列定义：17 列。
 *
 * 列名与列序**基本**照抄 `采购对账明细表.xls`，有两处按用户要求调整：
 * 2026-09-17 用户要求「产品名称放在采购单号前面」—— 因为这张表是**按物料**核对的
 * （财务拿它跟供应商逐项对料号与数量），先看到「是什么」再看到「哪张单」才顺；
 * 照抄老表反而要每次从左往右数过单号才能定位到物料。
 * 2026-09-20 用户要求加「订单号」（销售单号）列：采购单号只说得清「向谁买的」，
 * 说不清「为哪张销售订单买的」—— 缺了它，一张采购单的成本摊到哪个订单上只能靠人猜。
 * 该列紧挨在「采购单号」前面，与「应付管理」列表里两列的顺序一致（同一组字段在站内到哪都是一个先后）。
 * 其余 15 列与老表逐列一致，「金额 / 含税金额」仍在最后两列。
 */
export const PURCHASE_RECONCILIATION_DETAIL_COLUMNS: ReportColumn[] = [
  { header: "日期", width: 12 },
  { header: "产品名称", width: 30 },
  { header: "订单号", width: 20 },
  { header: "采购单号", width: 20 },
  { header: "供应商名称", width: 22 },
  { header: "产品代码", width: 18 },
  { header: "规格型号", width: 24 },
  { header: "单位", width: 8 },
  { header: "币种", width: 10 },
  numeric("单价", 12),
  numeric("含税单价", 12),
  numeric("数量", 10),
  numeric("折扣", 10),
  numeric("税额", 12),
  numeric("调整金额", 14),
  numeric("金额", 14),
  numeric("含税金额", 14),
];

/**
 * 合计列：金额(15) 与 含税金额(16)。
 *
 * 插入「订单号」后所有下标后移一位，所以这两个数**必须逐列数出来**而不是沿用旧值：
 * 沿用旧值会让合计悄悄落到「调整金额」与「金额」上，报表上完全看不出来（两者都是金额列、都右对齐）。
 */
const PURCHASE_TOTAL_COLUMNS = [15, 16];

/** 一行采购对账明细的取数结果。 */
export type PurchaseReconciliationDetailSource = {
  /** 采购日期；为空时回落应付条目的创建时间 */
  date: Date | null;
  /** 销售单号（`supplier_payable_entries.order_no`），不是采购单号 */
  orderNo: string | null;
  purchaseOrderNo: string | null;
  supplierName: string | null;
  productName: string | null;
  materialCode: string | null;
  specification: string | null;
  unit: string | null;
  currency: string | null;
  unitPrice: Prisma.Decimal | null;
  quantity: Prisma.Decimal | null;
  amount: Prisma.Decimal | null;
};

export function buildPurchaseReconciliationDetailTable(
  rows: PurchaseReconciliationDetailSource[],
  options: { currencyLabels: ReadonlyMap<string, string> },
): ReportTable {
  return {
    sheetName: "采购对账明细",
    columns: PURCHASE_RECONCILIATION_DETAIL_COLUMNS,
    rows: rows.map((row): ReportCell[] => [
      toDateText(row.date), // 日期
      // 产品名称在采购单号前面（用户 2026-09-17 要求，见列定义注释）。
      row.productName, // 产品名称
      // 订单号（销售单号）紧挨在采购单号前（用户 2026-09-20 要求，见列定义注释）。
      row.orderNo, // 订单号
      row.purchaseOrderNo, // 采购单号
      row.supplierName, // 供应商名称
      row.materialCode, // 产品代码（= 物料编码）
      row.specification, // 规格型号
      row.unit, // 单位
      currencyLabel(row.currency, options.currencyLabels), // 币种
      toExportNumber(row.unitPrice), // 单价
      // 含税单价 = 单价：系统约定采购单价即含税价（R3，与采购订单导出的既有约定一致）
      toExportNumber(row.unitPrice),
      toExportNumber(row.quantity), // 数量
      null, // 折扣（系统无字段，留空）
      null, // 税额（系统只有税率，没有税额，留空）
      null, // 调整金额（应付侧没有调整单据模型，留空）
      toExportNumber(row.amount), // 金额
      // 含税金额 = 金额（R3）
      toExportNumber(row.amount),
    ]),
    totalColumns: PURCHASE_TOTAL_COLUMNS,
  };
}

/* ------------------------------------------------------------------ 销售对账汇总表 */

/** 销售对账汇总表的列定义：10 列，列名与列序照抄 `销售对账汇总表.xls`（老表只有表头）。 */
export const SALES_RECONCILIATION_SUMMARY_COLUMNS: ReportColumn[] = [
  { header: "日期", width: 12 },
  { header: "客户名称", width: 22 },
  { header: "单号", width: 20 },
  { header: "币种", width: 10 },
  numeric("销售金额", 14),
  numeric("调整金额", 14),
  numeric("税额", 12),
  numeric("已收金额", 14),
  numeric("开票金额", 14),
  numeric("欠款", 14),
];

/** 合计列：销售金额(4)、调整金额(5)、已收金额(7)、欠款(9)。税额(6) 与 开票金额(8) 恒空，不合计。 */
const SALES_SUMMARY_TOTAL_COLUMNS = [4, 5, 7, 9];

/**
 * 一行销售对账汇总（一个销售单一行）。
 *
 * 口径（R4）：单号 = **销售单号**；欠款 = 应收合计 + 调整净额 − 已收合计（该销售单未收余额）。
 */
export type SalesReconciliationSummarySource = {
  date: Date | null;
  orderNo: string;
  customerName: string | null;
  currency: string | null;
  salesAmount: Prisma.Decimal | null;
  adjustmentNet: Prisma.Decimal | null;
  paidAmount: Prisma.Decimal | null;
  outstandingAmount: Prisma.Decimal | null;
};

export function buildSalesReconciliationSummaryTable(
  rows: SalesReconciliationSummarySource[],
  options: { currencyLabels: ReadonlyMap<string, string> },
): ReportTable {
  return {
    sheetName: "销售对账汇总",
    columns: SALES_RECONCILIATION_SUMMARY_COLUMNS,
    rows: rows.map((row): ReportCell[] => [
      toDateText(row.date), // 日期
      row.customerName, // 客户名称
      row.orderNo, // 单号 = 销售单号（R4）
      currencyLabel(row.currency, options.currencyLabels), // 币种
      toExportNumber(row.salesAmount), // 销售金额
      toExportNumber(row.adjustmentNet), // 调整金额（已过账调整的净额）
      null, // 税额：系统没有税额字段（只有税率），留空
      toExportNumber(row.paidAmount), // 已收金额
      null, // 开票金额：应收来源只有发票号/日期，没有发票金额，留空
      toExportNumber(row.outstandingAmount), // 欠款
    ]),
    totalColumns: SALES_SUMMARY_TOTAL_COLUMNS,
  };
}

/* ------------------------------------------------------------------ 销售利润报表(毛利) */

/** 销售利润报表的列定义：10 列，列名与列序照抄 `销售利润报表(毛利).xls`。 */
export const SALES_GROSS_PROFIT_COLUMNS: ReportColumn[] = [
  { header: "日期", width: 12 },
  { header: "单号", width: 20 },
  { header: "客户名称", width: 22 },
  { header: "币种", width: 10 },
  numeric("销售金额", 14),
  numeric("成本金额", 14),
  numeric("销售利润", 14),
  numeric("销售金额(本)", 16),
  numeric("成本金额(本)", 16),
  numeric("销售利润(本)", 16),
];

/** 合计列：六个金额列都可加（利润与成本按同一批订单相加是有意义的）。 */
const SALES_GROSS_PROFIT_TOTAL_COLUMNS = [4, 5, 6, 7, 8, 9];

export type SalesGrossProfitSource = {
  date: Date | null;
  orderNo: string;
  customerName: string | null;
  currency: string | null;
  /** 销售金额（原币）= 销售单总额，缺失时退应收金额 */
  salesAmount: Prisma.Decimal | null;
  /** 成本金额（原币）= BOM 原料成本；缺采购价的物料按 0 计入并在表尾列出 */
  costAmount: Prisma.Decimal | null;
  /** 销售单上的换算依据 */
  order: {
    currency: string | null;
    totalAmount: Prisma.Decimal | null;
    receivableAmount: Prisma.Decimal | null;
    localCurrencyAmount: Prisma.Decimal | null;
  } | null;
};

export function buildSalesGrossProfitTable(
  rows: SalesGrossProfitSource[],
  options: { currencyLabels: ReadonlyMap<string, string>; footnotes?: string[] },
): ReportTable {
  return {
    sheetName: "销售利润(毛利)",
    columns: SALES_GROSS_PROFIT_COLUMNS,
    rows: rows.map((row): ReportCell[] => {
      const order = row.order ?? { currency: row.currency, totalAmount: null, receivableAmount: null, localCurrencyAmount: null };
      const rate = salesExchangeRate(order);
      const salesAmount = toDecimal(row.salesAmount);
      const costAmount = toDecimal(row.costAmount) ?? new Prisma.Decimal(0);
      const profit = profitAmount(salesAmount, costAmount);
      // 本币口径与对账明细表一致：销售额取销售单上权威的本币金额（按比例分摊）；
      // 成本没有权威本币值，只能按汇率折算（汇率缺失则留空，不假装算得出来）。
      const salesLocal = localAmountFor(salesAmount, order);
      const costLocal = rate ? costAmount.mul(rate) : null;
      const profitLocal = salesLocal && costLocal ? salesLocal.minus(costLocal) : null;
      return [
        toDateText(row.date), // 日期
        row.orderNo, // 单号
        row.customerName, // 客户名称
        currencyLabel(row.currency ?? order.currency, options.currencyLabels), // 币种
        toExportNumber(salesAmount), // 销售金额
        toExportNumber(costAmount), // 成本金额（BOM 原料成本）
        toExportNumber(profit), // 销售利润
        toExportNumber(salesLocal), // 销售金额(本)
        toExportNumber(costLocal), // 成本金额(本)
        toExportNumber(profitLocal), // 销售利润(本)
      ];
    }),
    totalColumns: SALES_GROSS_PROFIT_TOTAL_COLUMNS,
    footnotes: options.footnotes,
  };
}

/* ------------------------------------------------------------------ 核算表 */

/**
 * 核算表的列定义：20 列。
 *
 * 需求来源：财务 2026-09-20 交付的 `example/财务/核算表.xlsx`（老表 `Sheet1` A1:S101，
 * 两行合并表头）。老表的表头是**两层**的（收入 / 原材料 / 计件人工 / 管理费用 四个大类各带
 * 单价 / 数量 / 金额 / 占比 子列），这里按全站报表的做法**摊平成单行表头**：
 * 两行表头在 Excel 里的筛选、排序、透视都要先做一次手工整理，而导出的每一张表都应该是能直接用的。
 *
 * 口径（财务原话「管理费是一个月的所以费用的总合平摊在本月生产的总数量中」）：
 *   收入金额 = 销售单的本币金额；成本三块 = 原材料（BOM 原料成本）+ 计件人工（日报）+ 管理费分摊；
 *   费用合计 = 后三块之和；利润 = 收入金额 − 费用合计。
 *
 * 三处与老表**故意不同**的地方：
 *   1. 加了「分摊单位」列。老表没有这一列，于是「55 元/打」和「55 元/支」在表上看不出区别，
 *      而两者差 12 倍 —— 单位是分摊的一部分，不是备注。
 *   2. 占比列是真数值（0.55 + `0.00%` 格式），老表那里的 `#DIV/0!` 一律留空；
 *      而且占比与金额**同进同出**（金额算不出来的列，占比也留空，见 `shareText`）。
 *   3. 金额列全是人民币本位币口径（老表没有币种列，见下方「备注」列的说明）。
 */
export const COST_ACCOUNTING_COLUMNS: ReportColumn[] = [
  { header: "日期", width: 12 },
  { header: "订单号", width: 20 },
  { header: "客户", width: 22 },
  { header: "规格", width: 24 },
  numeric("收入单价", 12),
  numeric("收入数量", 10),
  numeric("收入金额", 14),
  numeric("原材料单价", 12),
  numeric("原材料总价", 14),
  percent("原材料占比", 12),
  numeric("计件人工单价", 14),
  numeric("计件人工总价", 14),
  percent("计件人工占比", 12),
  { header: "分摊单位", width: 10 },
  numeric("管理费用", 12),
  numeric("管理费用金额", 14),
  percent("管理费用占比", 12),
  numeric("费用合计", 14),
  numeric("利润", 14),
  { header: "备注", width: 24 },
];

/**
 * 合计列：收入金额(6) / 原材料总价(8) / 计件人工总价(11) / 管理费用金额(15) / 费用合计(17) / 利润(18)。
 *
 * 数量(5) 不合计：一行一个单位，跨单位相加没有意义（全站纪律）。
 * 单价(4/7/10) 与费率(14) 不合计：均价与均费率要合计后另行计算，逐行相加得到的是一个没有会计意义的数。
 * 占比(9/12/16) 不合计：百分比相加恒不成立。
 */
const COST_ACCOUNTING_TOTAL_COLUMNS = [6, 8, 11, 15, 17, 18];

/** 一行核算表的取数结果（直取字段 + 三块费用的原始事实）。 */
export type CostAccountingSource = {
  date: Date | null;
  orderNo: string;
  customerName: string | null;
  productSpecification: string | null;
  /** 订单数量（老表「收入-数量」列） */
  quantity: Prisma.Decimal | null;
  /** 订单单位。与分摊单位归一后不一致的行不套管理费（见 `allocationUnitMatches`）。 */
  unit: string | null;
  /** BOM 原料成本（**原币**）；本币值由销售单汇率折算，汇率缺失时整块留空 */
  materialAmount: Prisma.Decimal | null;
  /** 计件人工合计（**已经是人民币**：计件工资按人民币计价，不参与汇率折算） */
  laborAmount: Prisma.Decimal | null;
  /**
   * 本期的分摊单位与月度费率 —— **期间级**事实，却放在行上而不是 `options` 里：
   * 它与每一行自己的单位一起决定这一行能不能套费率，两样东西挨着看最不容易接错
   * （分开传过一次的话，就很容易在某个调用点只更新其中一个）。
   */
  overheadUnit: string | null;
  overheadRate: Prisma.Decimal | null;
  /** 销售单上的换算依据（本币收入直接取销售单的权威本币金额，见 `localRevenueOf`） */
  order: {
    currency: string | null;
    totalAmount: Prisma.Decimal | null;
    receivableAmount: Prisma.Decimal | null;
    localCurrencyAmount: Prisma.Decimal | null;
  } | null;
};

export function buildCostAccountingTable(
  rows: CostAccountingSource[],
  options: { footnotes?: string[] },
): ReportTable {
  return {
    sheetName: "核算表",
    columns: COST_ACCOUNTING_COLUMNS,
    rows: rows.map((row): ReportCell[] => {
      const order = row.order ?? { currency: null, totalAmount: null, receivableAmount: null, localCurrencyAmount: null };
      const rate = salesExchangeRate(order);
      const quantity = toDecimal(row.quantity);
      // 收入取**整张销售单**的权威本币金额（不是按比例分摊 —— 一行就是整单）。
      const revenue = localRevenueOf(order);
      const materialAmount = toDecimal(row.materialAmount);
      // 原材料没有权威本币值，只能按汇率折算；汇率缺失（外币且没有本币金额）时留空，
      // 不假装算得出来 —— 这一条的清单在表尾点名。
      const materialLocal = rate && materialAmount ? materialAmount.mul(rate) : null;
      const laborLocal = toDecimal(row.laborAmount);
      // 单位不一致时**只留空管理费三列**，仍然把「分摊单位」列填上：读者要能看出这个月按什么单位分摊的，
      // 以及这一行为什么没套上费率。系统刻意没有「打 ↔ 支」的换算，所以这里也不替用户换算。
      const matched = allocationUnitMatches(row.unit, row.overheadUnit);
      const overheadAmount = matched ? allocationAmountFor(row.overheadRate, quantity) : null;
      // 费用合计：缺的那一块按 0 计入（否则「没有 BOM」会让整行费用消失），
      // 但三块全缺时整格留空 —— 那是「这个月什么费用都没有数据」，不是「费用为 0」。
      const parts = [materialLocal, laborLocal, overheadAmount];
      const expenseTotal = parts.every((part) => part === null)
        ? null
        : parts.reduce<Prisma.Decimal>((total, part) => total.plus(part ?? 0), new Prisma.Decimal(0));
      // 占比与金额**同进同出**，三列走同一条规则：这一块费用算不出来时金额留空，占比也必须留空。
      // 为什么不能只依赖 `shareOf`：`shareOf(null, 合计)` 返回的是 **0**（它把缺失的分子当 0 计入），
      // 于是空白金额旁边会出现一个 0.00% —— 那是在说「这块费用是 0 元」，而真相是「这块没算出来 /
      // 这一行没参与分摊」。三列里只给一列加这道闸才是真正的坑：读者会以为另外两列的口径不一样。
      const shareText = (part: Prisma.Decimal | null): number | null =>
        part === null ? null : toExportNumber(shareOf(part, expenseTotal));
      return [
        toDateText(row.date), // 日期
        row.orderNo, // 订单号
        row.customerName, // 客户
        row.productSpecification, // 规格
        toExportNumber(unitAmountOf(revenue, quantity)), // 收入单价（金额 ÷ 数量反推，保证单价 × 数量 = 金额）
        toExportNumber(quantity), // 收入数量
        toExportNumber(revenue), // 收入金额（本币）
        toExportNumber(unitAmountOf(materialLocal, quantity)), // 原材料单价
        toExportNumber(materialLocal), // 原材料总价（本币）
        // 占比的分母是**费用合计**（三块成本之和），不是收入：财务看这一列是要知道
        // 「这一单的费用里，原材料占多少」。合计为 0 时返回 null（老表这里是 #DIV/0!，不写那个）。
        shareText(materialLocal), // 原材料占比
        toExportNumber(unitAmountOf(laborLocal, quantity)), // 计件人工单价
        toExportNumber(laborLocal), // 计件人工总价
        shareText(laborLocal), // 计件人工占比
        row.overheadUnit, // 分摊单位（该期间登记的单位，同一列所有行相同）
        // 单位不一致的行费率也留空：只填单位而把费率填上，会让人以为这一行的金额只是「漏了」。
        toExportNumber(matched ? row.overheadRate : null), // 管理费用（月度费率）
        toExportNumber(overheadAmount), // 管理费用金额 = 数量 × 费率
        shareText(overheadAmount), // 管理费用占比
        toExportNumber(expenseTotal), // 费用合计
        // 沿用 `profitAmount` 的取舍：成本缺失按 0 计入，收入缺失则返回 null（留空）。
        toExportNumber(profitAmount(revenue, expenseTotal)), // 利润
        // 备注：`sales_orders` 上没有「备注」列，不编一个字段出来（硬凑 `completion_remark`
        // 那种工艺字段会把车间的话当成财务备注）。另外**老表没有币种列**，本表金额一律人民币本位币，
        // 币种口径写在表尾说明里，也不塞进这一列。
        null, // 备注
      ];
    }),
    totalColumns: COST_ACCOUNTING_TOTAL_COLUMNS,
    footnotes: options.footnotes,
  };
}

/* ------------------------------------------------------------------ 收支明细表 */

/**
 * 收支明细表的列定义。
 *
 * 老表是 6 列（日期 / 对方名称 / 币种 / 收入 / 支出 / 结算方式）。这里**加了「分类 / 项目」
 * 与「银行账户」三列**：
 *   - 「分类 / 项目」是用户 2026-09-17 的口径 —— 分类 = 科目类别，项目 = 科目名称，
 *     取自 `example/财务/科目表(2).xls`。明细表要能看出「这笔钱算什么科目、走的哪个账户」，
 *     否则汇总表按科目统计的数字在明细里根本对不上号；
 *   - 「银行账户」是钱实际落在哪张卡上（算余额的那一个）。
 * 列序保持从左到右「是什么 → 多少钱 → 怎么走的」。
 */
export const CASH_FLOW_DETAIL_COLUMNS: ReportColumn[] = [
  { header: "日期", width: 12 },
  { header: "对方名称", width: 26 },
  { header: "币种", width: 10 },
  { header: "分类", width: 14 },
  { header: "项目", width: 22 },
  numeric("收入", 14),
  numeric("支出", 14),
  { header: "银行账户", width: 26 },
  { header: "结算方式", width: 26 },
];

export type CashFlowDetailSource = {
  date: Date | null;
  counterpartyName: string;
  currency: string | null;
  direction: string;
  amount: Prisma.Decimal | null;
  /** 分类（科目类别）。老表没有这一列，见上方列定义注释。 */
  category?: string | null;
  /** 项目（科目名称）。 */
  subjectName?: string | null;
  /** 银行账户（`banks` 池）的「银行名 + 账号」。 */
  bankLabel?: string | null;
  settlementMethod: string | null;
  settlementAccountLabel: string | null;
};

export function buildCashFlowDetailTable(
  rows: CashFlowDetailSource[],
  options: { currencyLabels: ReadonlyMap<string, string> },
): ReportTable {
  return {
    sheetName: "收支明细",
    columns: CASH_FLOW_DETAIL_COLUMNS,
    rows: rows.map((row): ReportCell[] => [
      toDateText(row.date), // 日期
      row.counterpartyName, // 对方名称（老表是一个统一字段）
      currencyLabel(row.currency, options.currencyLabels), // 币种
      // 分类/项目缺失（理论上不可能 —— 科目是必填外键）时给空单元格而不是「-」：
      // 导出到 Excel 后空单元格可以被筛选、可以求和，一个横杠会被当成文本混进数值列里。
      row.category ?? "", // 分类（科目类别）
      row.subjectName ?? "", // 项目（科目名称）
      // 老表把「没有的那一边」写成 0（样本：收入 0 / 支出 2900），这里照抄。
      // 0 在这里是「确实为零」的事实，不是「没有数据」（缺字段才是空单元格）。
      row.direction === "income" ? toExportNumber(row.amount) ?? 0 : 0, // 收入
      row.direction === "expense" ? toExportNumber(row.amount) ?? 0 : 0, // 支出
      row.bankLabel ?? "", // 银行账户
      settlementText(row.settlementMethod, row.settlementAccountLabel), // 结算方式（方式--账户）
    ]),
    // **不设 totalColumns**：本表一行一个币种，跨币种相加没有意义（R7）。
    // 需要合计时看收支汇总表 —— 那边按币种分段给合计。
    footnotes: [
      "「分类 / 项目 / 银行账户」是本期为可核对性新增的三列（老表 6 列）：",
      "分类 = 科目类别，项目 = 科目名称，均取自「收支管理 → 会计科目」（来源：财务的科目表）。",
      "确认应收/应付、收付款过账自动写入的流水也按各自单据上的科目归类。",
      "银行账户为空表示这笔流水没指定具体账户（历史流水或建单时未选），它不进任何账户的余额。",
    ],
  };
}

/* ------------------------------------------------------------------ 收支汇总表 */

/**
 * 收支汇总表的列定义。
 *
 * 老表是 3 列（项目 / 收入 / 支出），但样本里把**美元 5428 与人民币 2900 加在了同一列**
 * （「货款」行）。按 R7 的确认，这里**加一列「币种」并把项目按币种分行**，
 * 每个币种一段、段末给该币种的合计，绝不跨币种相加。
 *
 * 2026-09-17 再加一列**「分类」**（= 科目类别）：用户要求「很多报表都要根据这个来统计」，
 * 只有「项目」一列就得靠人肉认科目属于哪一类。分类列 + 分类小计让这张表本身就能回答
 * 「这个月销售费用一共花了多少」。
 */
export const CASH_FLOW_SUMMARY_COLUMNS: ReportColumn[] = [
  { header: "分类", width: 14 },
  { header: "项目", width: 28 },
  { header: "币种", width: 10 },
  numeric("收入", 14),
  numeric("支出", 14),
];

export type CashFlowSummaryAmount = {
  subjectId: string;
  currency: string;
  income: Prisma.Decimal;
  expense: Prisma.Decimal;
};

/**
 * 收支汇总表。
 *
 * 行 = 「币种段 × 分类 × 科目」，分类段末追加「<分类> 小计」，币种段末追加「合计」。
 * 科目清单由调用方给全（含本期没有发生的科目，写 0）—— 老表就是「科目全列出来」的形态。
 *
 * **按分类分组，而不是靠「同一分类的科目恰好连续」**：后者要求调用方的排序永远正确，
 * 而「财务在早段分类下新增一个科目」这类操作随时会打破它 —— 那时同一币种段里会出现两个
 * 「资产类 小计」，算术没错但看着像重复计算。这里按**首次出现的顺序**分组，输入顺序再乱，
 * 每个分类也只会有一段、一个小计。
 */
export function buildCashFlowSummaryTable(
  items: ReadonlyArray<{ id: string; category: string; name: string }>,
  amounts: readonly CashFlowSummaryAmount[],
  currencies: readonly string[],
  options: { currencyLabels: ReadonlyMap<string, string> },
): ReportTable {
  const zero = new Prisma.Decimal(0);
  const index = new Map(amounts.map((row) => [`${row.subjectId}|${row.currency}`, row]));
  // 分类 → 该分类下的科目（保持输入顺序：调用方已经按科目表口径排过序）。
  const grouped = new Map<string, Array<{ id: string; category: string; name: string }>>();
  for (const item of items) {
    const list = grouped.get(item.category) ?? [];
    list.push(item);
    grouped.set(item.category, list);
  }
  const rows: ReportCell[][] = [];
  for (const currency of currencies) {
    const label = currencyLabel(currency, options.currencyLabels);
    let income = zero;
    let expense = zero;
    for (const [category, members] of grouped) {
      let categoryIncome = zero;
      let categoryExpense = zero;
      for (const item of members) {
        const row = index.get(`${item.id}|${currency}`);
        const itemIncome = row?.income ?? zero;
        const itemExpense = row?.expense ?? zero;
        income = income.plus(itemIncome);
        expense = expense.plus(itemExpense);
        categoryIncome = categoryIncome.plus(itemIncome);
        categoryExpense = categoryExpense.plus(itemExpense);
        rows.push([item.category, item.name, label, toExportNumber(itemIncome) ?? 0, toExportNumber(itemExpense) ?? 0]);
      }
      rows.push([category, "小计", label, toExportNumber(categoryIncome) ?? 0, toExportNumber(categoryExpense) ?? 0]);
    }
    // 段末合计：只在本币种内相加。跨币种相加会得到一个没有会计意义的数（R7）。
    rows.push(["合计", "合计", label, toExportNumber(income) ?? 0, toExportNumber(expense) ?? 0]);
  }
  return {
    sheetName: "收支汇总",
    columns: CASH_FLOW_SUMMARY_COLUMNS,
    rows,
    // 也不设 totalColumns：合计已经在每个币种段末按币种分别给出了。
    footnotes: [
      "本表按币种分行、不跨币种相加：每个币种一段，段末的「合计」只统计该币种。",
      "「分类」= 科目类别，「项目」= 科目名称，取自「收支管理 → 会计科目」（来源：财务的科目表）。",
      "每个分类段末给出该分类在本币种内的小计；科目全部列出，本期没有发生的科目为 0。",
    ],
  };
}

/* ------------------------------------------------------------------ 通用：合计行 */

/**
 * 合计行（页面预览用）。
 *
 * 与导出时写进工作簿的 `SUM(...)` 公式**同值**：导出写公式（用户在 Excel 里能看到求和范围），
 * 页面只能拿到算好的数。两处都只对 `totalColumns` 里声明的数值列求和。
 * 没有数据行或没有声明合计列时返回 `null`。
 */
export function reportTotalRow(table: ReportTable): ReportCell[] | null {
  if (!table.totalColumns?.length || !table.rows.length) return null;
  return table.columns.map((column, index): ReportCell => {
    if (index === 0) return "合计";
    if (!table.totalColumns?.includes(index) || !column.numFmt) return null;
    const sum = table.rows.reduce((total, row) => {
      const value = row[index];
      return typeof value === "number" ? total + value : total;
    }, 0);
    // 金额是 DECIMAL(18,4)：浮点求和后按 4 位收敛，避免出现 0.30000000000000004。
    return Number(sum.toFixed(4));
  });
}

/**
 * 表尾说明行（把「缺什么」写进导出文件，而不是只留在日志里）。
 *
 * 利润表最容易出的问题是：某个物料没有采购价 → 成本少算 → 利润虚高，而且从表上完全看不出来。
 * 所以缺价物料必须列进表尾。列表可能很长，因此按每行 `perLine` 项折行、
 * 最多 `maxLines` 行，超出部分只给条数 —— 表尾不该盖过正文。
 */
export function footnoteLines(label: string, values: readonly string[], perLine = 10, maxLines = 3): string[] {
  if (!values.length) return [];
  const lines: string[] = [];
  const shown = Math.min(values.length, perLine * maxLines);
  for (let index = 0; index < shown; index += perLine) {
    const end = Math.min(index + perLine, values.length);
    lines.push(`${label}（${index + 1}-${end}/${values.length}）：${values.slice(index, end).join("、")}`);
  }
  if (values.length > shown) lines.push(`${label}：另有 ${values.length - shown} 项未列出，请检查 BOM 与物料采购价维护情况`);
  return lines;
}

// 财务板块与子栏目清单（纯数据模块，**不能**放进 "use client" 文件）。
//
// 为什么单独成模块：/finance/<section> 是 Server Component，要用这份清单做 generateStaticParams
// 与参数白名单。若从 components/finance/*（"use client"）导入，跨 RSC 边界后拿到的是 client reference
// 代理而不是数组，`next build` 会以 `TypeError: FINANCE_SECTIONS.map is not a function` 直接失败
// —— typecheck 与 vitest 都发现不了（它们不施加 client boundary），只有真实构建会暴露。
// 同理，[section]/page.tsx 与各二级页都只从这里取常量，绝不从客户端组件取。

/** 财务一级板块。/finance 只展示这些入口，点进去才是二级页面。 */
export const FINANCE_BOARDS = [
  { key: "receivable", title: "应收管理" },
  { key: "payable", title: "应付管理" },
  { key: "salary", title: "工资管理" },
  { key: "banks", title: "银行账户" },
  { key: "bank-transfers", title: "银行余额互转" },
  { key: "cash-flow", title: "收支管理" },
  { key: "reports", title: "财务报表" },
  { key: "voucher", title: "凭证管理" },
] as const;

export type FinanceBoardKey = (typeof FINANCE_BOARDS)[number]["key"];

/** 应收管理子栏目。tab 同时是查询参数（/finance/receivable?tab=<key>）。 */
export const RECEIVABLE_TABS = [
  { key: "outbound-entries", title: "成品出库条目" },
  { key: "reconciliations", title: "应收对账" },
  { key: "confirmed", title: "确认应收" },
] as const;

/** 应付管理子栏目。 */
export const PAYABLE_TABS = [
  { key: "raw-inbound-entries", title: "原料入库条目" },
  { key: "outsource-entries", title: "外加工签收" },
  { key: "reconciliations", title: "应付对账" },
  { key: "confirmed", title: "确认应付" },
] as const;

export type ReceivableTabKey = (typeof RECEIVABLE_TABS)[number]["key"];
export type PayableTabKey = (typeof PAYABLE_TABS)[number]["key"];

/**
 * 财务报表子栏目：一张老表一个 tab。
 *
 * `key` 同时是接口的子路径（`/finance/reports/<key>` 取预览、`/finance/reports/<key>.xlsx` 取导出），
 * 因此 key 必须与后端 controller 的路由一致。
 *
 * `scope` 决定筛选条上出现哪些条件 —— 它是数据而不是 if 分支，加新表时不用再改组件：
 *   - `customer`：客户下拉 + 订单号 + 含草稿
 *   - `supplier`：供应商下拉 + 订单号 + 含草稿
 *   - `cash`：收支项目下拉 + 收支方向（收支流水没有订单号，也没有草稿态）
 *
 * 老系统那 6 份表到这里全部落地（收支明细/汇总属三期，需要新的「收支管理」模型与字典）。
 */
export const FINANCE_REPORT_TABS = [
  { key: "sales-reconciliation-detail", title: "销售对账明细表", scope: "customer" },
  { key: "sales-reconciliation-summary", title: "销售对账汇总表", scope: "customer" },
  { key: "purchase-reconciliation-detail", title: "采购对账明细表", scope: "supplier" },
  { key: "sales-gross-profit", title: "销售利润报表(毛利)", scope: "customer" },
  { key: "cash-flow-detail", title: "收支明细表", scope: "cash" },
  { key: "cash-flow-summary", title: "收支汇总表", scope: "cash" },
] as const;

export type FinanceReportTabKey = (typeof FINANCE_REPORT_TABS)[number]["key"];

/** 收支项目字典的 key（与后端 `cash-flow-catalog.ts` 一致）。 */
export const CASH_FLOW_ITEM_DICTIONARY_KEY = "cash_flow_item";
/** 结算账户字典的 key。 */
export const SETTLEMENT_ACCOUNT_DICTIONARY_KEY = "settlement_account";

/** 凭证管理子栏目（占位）。 */
export const VOUCHER_TABS = [] as const;

/**
 * 工资管理页的两个**功能入口**：工资管理页本身只做入口，功能全部在对应的二级页。
 *
 * 这里给的是真实路由（不是查询参数）：两个表格都要占满整屏，各自一个地址、可收藏。
 */
export const SALARY_SECTIONS = [
  { key: "ledger", title: "工资台账", href: "/finance/salary/ledger" },
  { key: "payments", title: "工资付款", href: "/finance/salary/payments" },
] as const;

export type SalarySectionKey = (typeof SALARY_SECTIONS)[number]["key"];

/** 每个板块的子栏目。凭证管理、银行账户与银行余额互转没有子栏目（都是单页满页表格）。 */
export const FINANCE_BOARD_TABS: Record<FinanceBoardKey, ReadonlyArray<{ key: string; title: string }>> = {
  receivable: RECEIVABLE_TABS,
  payable: PAYABLE_TABS,
  salary: SALARY_SECTIONS,
  banks: [],
  "bank-transfers": [],
  "cash-flow": [],
  reports: FINANCE_REPORT_TABS,
  voucher: VOUCHER_TABS,
};

/**
 * 2026-09-14 重构前的 7 个平铺板块地址 → 新二级页。
 *
 * 旧地址曾经是「进入独立页面」的收藏地址，直接 404 会让已经收藏的人摸不着头脑，
 * 因此保留一条重定向（见 app/finance/[section]/page.tsx）。
 */
export const FINANCE_LEGACY_REDIRECTS = [
  { key: "receivable-sources", target: "/finance/receivable?tab=outbound-entries" },
  { key: "reconciliations", target: "/finance/receivable?tab=reconciliations" },
  { key: "customer-payments", target: "/finance/receivable?tab=confirmed" },
  { key: "payable-sources", target: "/finance/payable?tab=raw-inbound-entries" },
  { key: "payable-entries", target: "/finance/payable?tab=confirmed" },
  { key: "supplier-payments", target: "/finance/payable?tab=confirmed" },
  { key: "supplier-reconciliations", target: "/finance/payable?tab=reconciliations" },
] as const;

export type FinanceLegacySectionKey = (typeof FINANCE_LEGACY_REDIRECTS)[number]["key"];

export function financeLegacyTarget(section: string): string | undefined {
  return FINANCE_LEGACY_REDIRECTS.find((item) => item.key === section)?.target;
}
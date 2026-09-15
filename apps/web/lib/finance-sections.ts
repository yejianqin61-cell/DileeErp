// 财务板块与子栏目清单（纯数据模块，**不能**放进 "use client" 文件）。
//
// 为什么单独成模块：/finance/<section> 是 Server Component，要用这份清单做 generateStaticParams
// 与参数白名单。若从 components/finance/*（"use client"）导入，跨 RSC 边界后拿到的是 client reference
// 代理而不是数组，`next build` 会以 `TypeError: FINANCE_SECTIONS.map is not a function` 直接失败
// —— typecheck 与 vitest 都发现不了（它们不施加 client boundary），只有真实构建会暴露。
// 同理，[section]/page.tsx 与各二级页都只从这里取常量，绝不从客户端组件取。

/** 财务一级板块。/finance 只展示这些入口，点进去才是二级页面。 */
export const FINANCE_BOARDS = [
  { key: "receivable", title: "应收管理", description: "成品出库过账自动形成应收来源：成品出库条目 → 应收对账 → 确认应收 → 收款核销" },
  { key: "payable", title: "应付管理", description: "原料入库过账 / 外加工签收形成应付来源：入库条目与签收 → 应付对账 → 确认应付 → 付款核销" },
  { key: "salary", title: "工资管理", description: "两个功能入口：工资台账（可编辑满页表格，车间生产工资自动汇总）与工资付款（当月台账只留总工资，行内付款/冲销）" },
  { key: "cash-flow", title: "收支管理", description: "手工录入资金收支流水（含统一「对方名称」与银行账户），按可配置的收支项目归类" },
  { key: "reports", title: "财务报表", description: "按老系统版式导出财务对账表：销售/采购对账、销售利润、收支明细与汇总；数字落数值型，可直接在 Excel 里求和" },
  { key: "voucher", title: "凭证管理", description: "针对已确认的应收/应付条目生成单据（本期占位）" },
] as const;

export type FinanceBoardKey = (typeof FINANCE_BOARDS)[number]["key"];

/** 应收管理子栏目。tab 同时是查询参数（/finance/receivable?tab=<key>）。 */
export const RECEIVABLE_TABS = [
  { key: "outbound-entries", title: "成品出库条目", description: "每次成品出库过账生成一条应收来源；一个订单分批出库就是多条，双击查看全部字段" },
  { key: "reconciliations", title: "应收对账", description: "按客户 + 期间创建对账单，系统自动汇总期间的出库条目为明细；对平后可一键确认应收" },
  { key: "confirmed", title: "确认应收", description: "应收台账：草稿条目在此逐条确认，已确认的在此登记收款、核销与冲销" },
] as const;

/** 应付管理子栏目。 */
export const PAYABLE_TABS = [
  { key: "raw-inbound-entries", title: "原料入库条目", description: "原料入库过账生成的待接收应付来源；接收后成为应付草稿" },
  { key: "outsource-entries", title: "外加工签收", description: "外加工实际签收生成的待接收应付来源（直发数量不形成应付）" },
  { key: "reconciliations", title: "应付对账", description: "按供应商 + 期间创建对账单；对平后到确认应付去确认" },
  { key: "confirmed", title: "确认应付", description: "应付台账：草稿逐条确认；已确认的登记付款、核销与冲销" },
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
  { key: "sales-reconciliation-detail", title: "销售对账明细表", description: "按销售单列示应收明细，23 列与老表一一对应", scope: "customer" },
  { key: "sales-reconciliation-summary", title: "销售对账汇总表", description: "按销售单汇总销售金额/调整/已收与欠款，10 列与老表一一对应", scope: "customer" },
  { key: "purchase-reconciliation-detail", title: "采购对账明细表", description: "按采购单列示应付明细，16 列与老表一一对应", scope: "supplier" },
  { key: "sales-gross-profit", title: "销售利润报表(毛利)", description: "按销售单给出销售金额、BOM 原料成本与销售利润（含本币列），10 列与老表一一对应", scope: "customer" },
  { key: "cash-flow-detail", title: "收支明细表", description: "资金收支流水（日期/对方名称/币种/收入/支出/结算方式），6 列与老表一一对应", scope: "cash" },
  { key: "cash-flow-summary", title: "收支汇总表", description: "按「项目 × 币种」汇总，每个币种段末给该币种合计（不跨币种相加）", scope: "cash" },
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
  { key: "ledger", title: "工资台账", description: "按月自动导入全部员工的可编辑满页表格：车间工人的计件/计时工资由生产日报自动汇总进「基本工资」，绩效/房补/迟到/旷工/早退逐格可改", href: "/finance/salary/ledger" },
  { key: "payments", title: "工资付款", description: "把当月工资台账搬过来付款：只保留「总工资」，付款与冲销都在表格行内完成", href: "/finance/salary/payments" },
] as const;

export type SalarySectionKey = (typeof SALARY_SECTIONS)[number]["key"];

/** 每个板块的子栏目。凭证管理没有子栏目。 */
export const FINANCE_BOARD_TABS: Record<FinanceBoardKey, ReadonlyArray<{ key: string; title: string; description: string }>> = {
  receivable: RECEIVABLE_TABS,
  payable: PAYABLE_TABS,
  salary: SALARY_SECTIONS,
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
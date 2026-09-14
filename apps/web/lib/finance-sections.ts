// 财务板块清单（纯数据模块，**不能**放进 "use client" 文件）。
//
// 为什么单独成模块：/finance/<section> 是 Server Component，要用这份清单做 generateStaticParams
// 与参数白名单。若从 components/finance/finance-workspace.tsx（"use client"）导入，
// 跨 RSC 边界后拿到的是 client reference 代理而不是数组，`next build` 会以
// `TypeError: FINANCE_SECTIONS.map is not a function` 直接失败——typecheck 与 vitest 都发现不了
// （它们不施加 client boundary），只有真实构建会暴露。
/** 板块 key 同时是子页面路由（/finance/<key>）。 */
export const FINANCE_SECTIONS = [
  { key: "receivable-sources", title: "应收来源", description: "客户应收（成品出库过账自动生成草稿）" },
  { key: "customer-payments", title: "收款", description: "客户收款登记与核销" },
  { key: "payable-sources", title: "原料入库 / 外加工应付来源", description: "待财务接收的应付来源（含原料名称）" },
  { key: "payable-entries", title: "应付条目", description: "供应商应付台账（含原料名称）" },
  { key: "supplier-payments", title: "付款", description: "供应商付款登记与核销" },
  { key: "reconciliations", title: "普通对账", description: "按订单号对账" },
  { key: "supplier-reconciliations", title: "供应商应付对账", description: "供应商应付差异处理" },
] as const;

export type FinanceSectionKey = (typeof FINANCE_SECTIONS)[number]["key"];

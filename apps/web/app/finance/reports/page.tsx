// 财务报表二级页：/finance/reports?tab=<销售对账明细表 | 采购对账明细表>。
//
// tab 走查询参数而不是路径段，与 /finance/receivable 一致（旧地址重定向能带上 tab，
// 且只在服务端读 searchParams，客户端不需要 useSearchParams，避免静态构建时的 Suspense 边界问题）。
import FinanceReportWorkspace from "../../../components/finance/finance-report-workspace";
import { FINANCE_REPORT_TABS, type FinanceReportTabKey } from "../../../lib/finance-sections";

export default async function FinanceReportsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const active = FINANCE_REPORT_TABS.find((item) => item.key === tab)?.key ?? FINANCE_REPORT_TABS[0].key;
  return <FinanceReportWorkspace tab={active as FinanceReportTabKey} testId="page-finance-reports" />;
}

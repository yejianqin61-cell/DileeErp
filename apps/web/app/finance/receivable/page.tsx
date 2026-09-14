// 应收管理二级页：/finance/receivable?tab=<成品出库条目 | 应收对账 | 确认应收>。
//
// tab 走查询参数而不是路径段：旧地址（/finance/receivable-sources 等）重定向时能直接带上 tab，
// 且只在服务端读 searchParams，客户端不需要 useSearchParams（避免静态构建时的 Suspense 边界问题）。
import ReceivableWorkspace from "../../../components/finance/receivable-workspace";
import { RECEIVABLE_TABS, type ReceivableTabKey } from "../../../lib/finance-sections";

export default async function FinanceReceivablePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const active = RECEIVABLE_TABS.find((item) => item.key === tab)?.key ?? RECEIVABLE_TABS[0].key;
  return <ReceivableWorkspace tab={active as ReceivableTabKey} testId="page-finance-receivable" />;
}

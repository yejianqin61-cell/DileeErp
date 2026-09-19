// 收支管理二级页：/finance/cash-flow?tab=<收支流水 | 会计科目>。
//
// tab 走查询参数而不是路径段：与应收/应付/报表一致，且只在服务端读 searchParams，
// 客户端不需要 useSearchParams（避免静态构建时的 Suspense 边界问题）。
//
// 用户 2026-09-17：「收支项目维护和会计科目要合并成会计科目！合并成一个」——
// 所以这里没有「收支项目维护」子栏目，只有会计科目维护（见 accounting-subject-workspace）。
import CashFlowWorkspace from "../../../components/finance/cash-flow-workspace";
import { CASH_FLOW_TABS, type CashFlowTabKey } from "../../../lib/finance-sections";

export default async function FinanceCashFlowPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const active = CASH_FLOW_TABS.find((item) => item.key === tab)?.key ?? CASH_FLOW_TABS[0].key;
  return <CashFlowWorkspace tab={active as CashFlowTabKey} testId="page-finance-cash-flow" />;
}

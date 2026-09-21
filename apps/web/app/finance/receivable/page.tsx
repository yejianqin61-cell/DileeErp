// 应收管理二级页：/finance/receivable?tab=<成品出库条目 | 应收对账与确认>。
//
// tab 走查询参数而不是路径段：旧地址（/finance/receivable-sources 等）重定向时能直接带上 tab，
// 且只在服务端读 searchParams，客户端不需要 useSearchParams（避免静态构建时的 Suspense 边界问题）。
//
// 2026-09-20（用户要求）：「应收对账」与「确认应收」合并成一个 tab，而旧的 `?tab=confirmed`
// 仍要能用 —— 别名表与解析集中在 `finance-sections.ts` 的 `resolveFinanceTab`。
import ReceivableWorkspace from "../../../components/finance/receivable-workspace";
import { RECEIVABLE_TABS, RECEIVABLE_TAB_ALIASES, resolveFinanceTab, type ReceivableTabKey } from "../../../lib/finance-sections";

export default async function FinanceReceivablePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const active = resolveFinanceTab(RECEIVABLE_TABS, RECEIVABLE_TAB_ALIASES, tab);
  return <ReceivableWorkspace tab={active as ReceivableTabKey} testId="page-finance-receivable" />;
}

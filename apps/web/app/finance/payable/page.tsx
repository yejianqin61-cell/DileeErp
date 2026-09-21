// 应付管理二级页：/finance/payable?tab=<原料入库条目 | 外加工签收 | 应付对账与确认>。
//
// tab 走查询参数而不是路径段：旧地址（/finance/payable-sources 等）重定向时能直接带上 tab，
// 且只在服务端读 searchParams，客户端不需要 useSearchParams（避免静态构建时的 Suspense 边界问题）。
//
// 2026-09-20（用户要求）：「应付对账」与「确认应付」合并成一个 tab，而旧的 `?tab=confirmed`
// 仍要能用 —— 别名表与解析集中在 `finance-sections.ts` 的 `resolveFinanceTab`，
// 页面这里不再各写一遍「先查清单、查不到回落第一个」的判断。
import PayableWorkspace from "../../../components/finance/payable-workspace";
import { PAYABLE_TABS, PAYABLE_TAB_ALIASES, resolveFinanceTab, type PayableTabParam } from "../../../lib/finance-sections";

export default async function FinancePayablePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const active = resolveFinanceTab(PAYABLE_TABS, PAYABLE_TAB_ALIASES, tab);
  return <PayableWorkspace tab={active as PayableTabParam} testId="page-finance-payable" />;
}

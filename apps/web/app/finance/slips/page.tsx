// 收付款单存档二级页：/finance/slips?kind=<payment | receipt>。
//
// 「保存键」（用户 2026-09-26）存下来的单子在这一页找回、再导出、作废。
// kind 走查询参数、只在服务端读 searchParams（与 /finance/receivable 同一写法，
// 客户端因此不需要 useSearchParams，也不会有静态构建的 Suspense 边界问题）。
import FinanceSlipsWorkspace from "../../../components/finance/finance-slips-workspace";
import type { FinanceSlipKind } from "../../../lib/finance-slip";

export default async function FinanceSlipsPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind } = await searchParams;
  // 白名单式解析：认不出来的 kind 一律回到付款单，不抛错（打错的地址不该看到一页报错）。
  const active: FinanceSlipKind = kind === "receipt" ? "receipt" : "payment";
  return <FinanceSlipsWorkspace kind={active} testId="page-finance-slips" />;
}

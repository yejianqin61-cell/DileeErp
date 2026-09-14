// 财务一级页：4 个板块入口（应收管理 / 应付管理 / 薪资台账 / 凭证管理）。
// 实现放在 components/finance/finance-board-index.tsx，这里只做路由装配。
import FinanceBoardIndex from "../../components/finance/finance-board-index";

export default function FinancePage() {
  return <FinanceBoardIndex testId="page-finance" />;
}

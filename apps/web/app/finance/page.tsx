// 财务页面：完整实现放在 components/finance/finance-workspace.tsx，这里只做路由装配。
// 页面根 testid 由工作台在数据加载完成后渲染（加载中不渲染根节点，避免加载态被当成页面根）。
import FinanceWorkspace from "../../components/finance/finance-workspace";

export default function FinancePage() {
  return <FinanceWorkspace testId="page-finance" />;
}

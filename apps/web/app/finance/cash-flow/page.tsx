// 收支管理二级页：/finance/cash-flow
//
// 老表（收支明细表 / 收支汇总表）的录入侧：手工流水 + 可配置收支项目字典。
import CashFlowWorkspace from "../../../components/finance/cash-flow-workspace";

export default function FinanceCashFlowPage() {
  return <CashFlowWorkspace testId="page-finance-cash-flow" />;
}

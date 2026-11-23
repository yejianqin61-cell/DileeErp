// 结算方式设置二级页：/finance/settlements。
//
// 维护的是收支流水上的「结算账户」字典（老表「结算方式」里的账户文本），
// 与 /finance/banks（银行账户主数据）不是同一件事，说明见组件文件头。
import SettlementAccountWorkspace from "../../../components/finance/settlement-account-workspace";

export default function FinanceSettlementsPage() {
  return <SettlementAccountWorkspace testId="page-finance-settlements" />;
}

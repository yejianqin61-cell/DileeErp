// 银行账户池二级页：/finance/banks（付款/对账里「支付银行」下拉的来源）。
import BankWorkspace from "../../../components/finance/bank-workspace";

export default function FinanceBanksPage() {
  return <BankWorkspace testId="page-finance-banks" />;
}

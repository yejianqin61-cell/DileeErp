// 银行余额互转二级页：/finance/bank-transfers（银行池内两个账户之间的划转）。
//
// 与 banks/page.tsx 同一套装配：页面文件只做路由，实现全在客户端工作台组件里。
import BankTransferWorkspace from "../../../components/finance/bank-transfer-workspace";

export default function FinanceBankTransfersPage() {
  return <BankTransferWorkspace testId="page-finance-bank-transfers" />;
}

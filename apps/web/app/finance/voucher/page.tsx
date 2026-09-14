// 凭证管理二级页（占位）：只展示待生成凭证的已确认应收/应付条目数，不提供写操作。
import VoucherWorkspace from "../../../components/finance/voucher-workspace";

export default function FinanceVoucherPage() {
  return <VoucherWorkspace testId="page-finance-voucher" />;
}

// 应付管理二级页：/finance/payable?tab=<原料入库条目 | 外加工签收 | 应付对账 | 确认应付>。
import PayableWorkspace from "../../../components/finance/payable-workspace";
import { PAYABLE_TABS, type PayableTabKey } from "../../../lib/finance-sections";

export default async function FinancePayablePage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const active = PAYABLE_TABS.find((item) => item.key === tab)?.key ?? PAYABLE_TABS[0].key;
  return <PayableWorkspace tab={active as PayableTabKey} testId="page-finance-payable" />;
}

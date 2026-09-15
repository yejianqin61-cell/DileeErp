// 工资管理二级页：/finance/salary?tab=ledger|payments。
//
// tab 走查询参数而不是路径段，与服务端 tab 约定一致（同应收/应付/报表二级页）：
// 只在服务端读 searchParams，客户端不需要 useSearchParams（避免静态构建时的 Suspense 边界问题）。
// 月份/部门/岗位也一起读进来，这样「切 tab」的链接能带上当前筛选，收藏地址也能直接落到筛好的视图。
import SalaryWorkspace from "../../../components/finance/salary-workspace";
import { SALARY_TABS, type SalaryTabKey } from "../../../lib/finance-sections";

export default async function FinanceSalaryPage({ searchParams }: { searchParams: Promise<{ tab?: string; month?: string; department_id?: string; position_id?: string }> }) {
  const { tab, month, department_id, position_id } = await searchParams;
  const active = SALARY_TABS.find((item) => item.key === tab)?.key ?? SALARY_TABS[0].key;
  return <SalaryWorkspace tab={active as SalaryTabKey} initialMonth={month ?? ""} initialDepartmentId={department_id ?? ""} initialPositionId={position_id ?? ""} testId="page-finance-salary" />;
}

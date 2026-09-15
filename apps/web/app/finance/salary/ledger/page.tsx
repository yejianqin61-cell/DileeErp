// 工资台账二级页：/finance/salary/ledger（按月自动导入全部员工的可编辑满页表格）。
//
// 月份/部门/岗位从查询参数带进来（服务端读 searchParams，客户端不需要 useSearchParams），
// 这样带筛选的地址可以直接收藏、也能从工资付款页互相跳转。
import SalaryWorkspace from "../../../../components/finance/salary-workspace";

export default async function FinanceSalaryLedgerPage({ searchParams }: { searchParams: Promise<{ month?: string; department_id?: string; position_id?: string }> }) {
  const { month, department_id, position_id } = await searchParams;
  return <SalaryWorkspace mode="ledger" testId="page-finance-salary-ledger" initialMonth={month ?? ""} initialDepartmentId={department_id ?? ""} initialPositionId={position_id ?? ""} />;
}

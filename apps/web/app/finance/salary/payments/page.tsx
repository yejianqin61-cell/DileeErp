// 工资付款二级页：/finance/salary/payments（把当月工资台账搬过来付款，只保留「总工资」）。
//
// 与工资台账页共用同一个工作区组件（mode="payments"）：同样的筛选、同样的按月自动导入，
// 区别只在列与行内操作 —— 类目明细收掉，只留总工资/已付/未付，付款与冲销都在行内完成。
import SalaryWorkspace from "../../../../components/finance/salary-workspace";

export default async function FinanceSalaryPaymentsPage({ searchParams }: { searchParams: Promise<{ month?: string; department_id?: string; position_id?: string }> }) {
  const { month, department_id, position_id } = await searchParams;
  return <SalaryWorkspace mode="payments" testId="page-finance-salary-payments" initialMonth={month ?? ""} initialDepartmentId={department_id ?? ""} initialPositionId={position_id ?? ""} />;
}

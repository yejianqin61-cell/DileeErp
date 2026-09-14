"use client";

// 工资管理（/finance/salary）：满页表格视图，按「月 + 部门 + 岗位」筛选。
//
// 与重构前的变化：
//   - 筛选条件从「员工关键字 + 期间起止」改成「月 + 部门 + 岗位（+ 关键字）」，
//     月/部门/岗位走服务端筛选参数（/hr/payroll-ledgers?month=&department_id=&position_id=），
//     否则员工多的时候会把整表都拉到前端再过滤；
//   - 不再拆成「车间 / 非车间」两张表，而是一张满页表格 + 部门/岗位列，避免同一份数据在两处重复渲染；
//   - 原有动作全部保留：新建台账、编辑、确认、删除、回到草稿、生成应付、确认应付、关闭、
//     新建工资付款、核销过账、冲销。
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { DataTable, statusCell } from "../../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../../lib/api-client";
import { currencyOptions, currencyOptionsWithCurrent, fetchCurrencyOptions, type CurrencyOption } from "../../../lib/currency-catalogue";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";
import { RecordDetailDialog, money, type DetailField } from "../../../components/finance/record-detail-dialog";

type Employee = { id: string; employeeNo: string; name: string; employeeType: string; department?: { id: string; name: string } | null; position?: { id: string; name: string } | null };
type Department = { id: string; name: string; code: string };
type Position = { id: string; name: string; code: string; departmentId: string };
type PayrollPayable = { id: string; ledgerId: string; payableNo: string; amount: string; currency: string; status: string };
type SalaryPayment = { id: string; paymentNo: string; paymentDate: string; amount: string; currency: string; status: string };
type Ledger = {
  id: string;
  ledgerNo: string;
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  baseSalary: string;
  productionSourceAmount: string;
  overtimeAmount: string;
  attendanceDeduction: string;
  performanceAmount: string;
  allowanceAmount: string;
  socialInsurance: string;
  individualTax: string;
  otherAdjustment: string;
  payableAmount: string;
  paidAmount: string;
  outstandingAmount: string;
  status: string;
  remark: string | null;
  sourceSnapshot?: Array<{ order_no?: string; wage_mode?: string; quantity?: string; duration_hours?: string; amount?: string }>;
  adjustments?: Array<{ id: string; adjustmentNo: string; adjustmentType: string; effect: string; amount: string; reason: string; status: string }>;
  allocations?: Array<{ id: string; amount: string; status: string; payment?: { paymentNo: string; status: string; paymentDate: string } | null }>;
  employee: Employee;
};
const statusLabels: Record<string, string> = { draft: "草稿", confirmed: "已确认", expired: "已过期", partially_paid: "部分支付", paid: "已支付", closed: "已关闭" };
const payableStatusLabels: Record<string, string> = { draft: "应付草稿", confirmed: "应付已确认", partially_paid: "应付部分支付", paid: "应付已支付", reversed: "应付已冲销", voided: "应付已作废" };
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : "-");

export default function SalaryPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [payables, setPayables] = useState<PayrollPayable[]>([]);
  const [payments, setPayments] = useState<SalaryPayment[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [detail, setDetail] = useState<Ledger | null>(null);
  const [employeeQuery, setEmployeeQuery] = useState("");
  // 「月 + 部门 + 岗位」是服务端筛选；员工关键字是本地过滤（保持在输入过程中即时响应，无需请求）。
  const [month, setMonth] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [positionId, setPositionId] = useState("");
  const [currencyCatalogue, setCurrencyCatalogue] = useState<CurrencyOption[]>([]);
  const currencyDefault = (preferred: string) => { const options = currencyOptions(currencyCatalogue); return options.some((option) => option.value === preferred) ? preferred : (options[0]?.value ?? preferred); };

  useEffect(() => { let cancelled = false; void fetchCurrencyOptions().then((options) => { if (!cancelled) setCurrencyCatalogue(options); }); return () => { cancelled = true; }; }, []);
  // 部门/岗位是静态主数据，只在挂载时拉一次；岗位按所选部门收窄。
  useEffect(() => {
    let cancelled = false;
    void Promise.all([apiGet<Department[]>("/production/departments"), apiGet<Position[]>(departmentId ? `/production/positions?department_id=${departmentId}` : "/production/positions")])
      .then(([d, p]) => { if (!cancelled) { setDepartments(d.data); setPositions(p.data); } })
      .catch(() => { if (!cancelled) { setDepartments([]); setPositions([]); } });
    return () => { cancelled = true; };
  }, [departmentId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (month) params.set("month", month);
      if (departmentId) params.set("department_id", departmentId);
      if (positionId) params.set("position_id", positionId);
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const [e, l, p, sp] = await Promise.all([
        apiGet<Employee[]>("/production/employees"),
        apiGet<Ledger[]>(`/hr/payroll-ledgers${suffix}`),
        apiGet<PayrollPayable[]>("/hr/payroll-payables"),
        apiGet<SalaryPayment[]>("/hr/salary-payments"),
      ]);
      setEmployees(e.data);
      setLedgers(l.data);
      setPayables(p.data);
      setPayments(sp.data);
    } catch (cause) {
      setError(messageOf(cause, "工资数据加载失败"));
    } finally {
      setLoading(false);
    }
  }, [departmentId, month, positionId]);

  useEffect(() => { void load(); }, [load]);

  async function run(action: Promise<unknown>, success: string) {
    setError("");
    try {
      await action;
      notifySuccess(success);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "操作失败"));
    }
  }

  function openCreate() {
    setDialog({
      title: "新建工资台账",
      fields: [
        { name: "employee_name", label: "员工姓名", type: "select", required: true, options: employees.map((item) => ({ value: item.name, label: `${item.employeeNo} / ${item.name} / ${item.employeeType === "workshop" ? "车间" : "非车间"}` })) },
        { name: "period_start", label: "周期开始", type: "date", required: true, defaultValue: month ? `${month}-01` : "" },
        { name: "period_end", label: "周期结束", type: "date", required: true, defaultValue: month ? new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10) : "" },
        { name: "currency", label: "币种", type: "select", required: true, options: currencyOptions(currencyCatalogue), defaultValue: currencyDefault("CNY") },
        { name: "base_salary", label: "基本工资", type: "number", defaultValue: "0" },
        { name: "overtime_amount", label: "加班工资", type: "number", defaultValue: "0" },
        { name: "attendance_deduction", label: "考勤扣款", type: "number", defaultValue: "0" },
        { name: "performance_amount", label: "绩效金额", type: "number", defaultValue: "0" },
        { name: "allowance_amount", label: "补贴金额", type: "number", defaultValue: "0" },
        { name: "social_insurance", label: "社保", type: "number", defaultValue: "0" },
        { name: "individual_tax", label: "个税", type: "number", defaultValue: "0" },
        { name: "other_adjustment", label: "其他调整", type: "number", defaultValue: "0" },
        { name: "remark", label: "备注", type: "textarea" },
      ],
      submit: (values) => void run(apiPost("/hr/payroll-ledgers/generate", { ...values }), "工资台账已创建"),
    });
  }

  function editLedger(ledger: Ledger) {
    setDialog({
      title: `编辑工资台账：${ledger.ledgerNo}`,
      fields: [
        { name: "employee_id", label: "员工", type: "select", required: true, defaultValue: ledger.employeeId, options: employees.map((item) => ({ value: item.id, label: `${item.employeeNo} / ${item.name}` })) },
        { name: "period_start", label: "周期开始", type: "date", required: true, defaultValue: ledger.periodStart.slice(0, 10) },
        { name: "period_end", label: "周期结束", type: "date", required: true, defaultValue: ledger.periodEnd.slice(0, 10) },
        { name: "currency", label: "币种", type: "select", required: true, options: currencyOptionsWithCurrent(currencyCatalogue, ledger.currency), defaultValue: ledger.currency },
        { name: "base_salary", label: "基本工资", type: "number", defaultValue: ledger.baseSalary },
        { name: "overtime_amount", label: "加班工资", type: "number", defaultValue: ledger.overtimeAmount },
        { name: "attendance_deduction", label: "考勤扣款", type: "number", defaultValue: ledger.attendanceDeduction },
        { name: "performance_amount", label: "绩效金额", type: "number", defaultValue: ledger.performanceAmount },
        { name: "allowance_amount", label: "补贴金额", type: "number", defaultValue: ledger.allowanceAmount },
        { name: "social_insurance", label: "社保", type: "number", defaultValue: ledger.socialInsurance },
        { name: "individual_tax", label: "个税", type: "number", defaultValue: ledger.individualTax },
        { name: "other_adjustment", label: "其他调整", type: "number", defaultValue: ledger.otherAdjustment },
        { name: "remark", label: "备注", type: "textarea", defaultValue: ledger.remark ?? "" },
        ...(ledger.status === "confirmed" ? [{ name: "reason", label: "修改原因", type: "textarea", required: true } as ActionField] : []),
      ],
      submit: (values) => void run(apiPatch(`/hr/payroll-ledgers/${ledger.id}`, { ...values }), "工资台账已更新"),
    });
  }

  function reopenLedger(ledger: Ledger) {
    setDialog({ title: `工资台账回退草稿：${ledger.ledgerNo}`, fields: [{ name: "reason", label: "回退原因", type: "textarea", required: true }], submit: (values) => void run(apiPost(`/hr/payroll-ledgers/${ledger.id}/reopen`, values), "工资台账已回到草稿") });
  }
  function createSalaryPayment() {
    setDialog({ title: "新建工资付款", fields: [{ name: "amount", label: "付款金额", type: "number", required: true }, { name: "payment_date", label: "付款日期", type: "date", required: true, defaultValue: new Date().toISOString().slice(0, 10) }, { name: "payment_method", label: "付款方式", required: true, defaultValue: "银行转账" }, { name: "currency", label: "币种", type: "select", required: true, options: currencyOptions(currencyCatalogue), defaultValue: currencyDefault("CNY") }], submit: (values) => void run(apiPost("/hr/salary-payments", { amount: values.amount, payment_date: values.payment_date, currency: values.currency, payment_method: values.payment_method }), "工资付款草稿已创建") });
  }
  function postSalaryPayment(payment: SalaryPayment) {
    const options = ledgers.filter((ledger) => ["confirmed", "partially_paid"].includes(ledger.status) && Number(ledger.outstandingAmount) > 0).map((ledger) => ({ value: ledger.id, label: `${ledger.employee.employeeNo} / ${ledger.employee.name} / 未付 ${ledger.outstandingAmount} ${ledger.currency}` }));
    setDialog({ title: `工资付款核销：${payment.paymentNo}`, fields: [{ name: "ledger_id", label: "工资台账", type: "select", required: true, options }, { name: "amount", label: "本次核销金额", type: "number", required: true, defaultValue: payment.amount }], submit: (values) => values.ledger_id ? void run(apiPost(`/hr/salary-payments/${payment.id}/post`, { allocations: [{ ledger_id: values.ledger_id, amount: values.amount }] }), "工资付款已过账") : undefined });
  }
  function reverseSalaryPayment(payment: SalaryPayment) {
    setDialog({ title: `冲销工资付款：${payment.paymentNo}`, fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }], submit: (values) => void run(apiPost(`/hr/salary-payments/${payment.id}/reverse`, values), "工资付款已冲销") });
  }

  const payableByLedger = useMemo(() => new Map(payables.map((item) => [item.ledgerId, item])), [payables]);

  const actionColumns = (ledger: Ledger) => {
    const payable = payableByLedger.get(ledger.id);
    return <div className="action-row" onClick={(event) => event.stopPropagation()}>
      {ledger.status === "draft" && <><Button size="sm" variant="secondary" onClick={() => void run(apiPost(`/hr/payroll-ledgers/${ledger.id}/confirm`), "工资台账已确认")}>确认</Button><Button size="sm" variant="secondary" onClick={() => editLedger(ledger)}>编辑</Button><Button size="sm" variant="destructive" onClick={() => void run(apiRequest(`/hr/payroll-ledgers/${ledger.id}`, { method: "DELETE" }), "工资台账已删除")}>删除</Button></>}
      {["confirmed", "expired"].includes(ledger.status) && <><Button size="sm" variant="secondary" onClick={() => reopenLedger(ledger)}>回到草稿</Button><Button size="sm" variant="secondary" onClick={() => editLedger(ledger)}>编辑</Button></>}
      {ledger.status === "confirmed" && !payable && <Button size="sm" variant="secondary" onClick={() => void run(apiPost(`/hr/payroll-ledgers/${ledger.id}/payable`, {}), "工资应付已生成")}>生成应付</Button>}
      {payable?.status === "draft" && <Button size="sm" variant="secondary" onClick={() => void run(apiPost(`/hr/payroll-payables/${payable.id}/confirm`), "工资应付已确认")}>确认应付</Button>}
      {payable && payable.status !== "draft" && <span>{payableStatusLabels[payable.status] ?? payable.status}</span>}
      {ledger.status === "paid" && <Button size="sm" variant="secondary" onClick={() => void run(apiPost(`/hr/payroll-ledgers/${ledger.id}/close`), "工资台账已关闭")}>关闭</Button>}
    </div>;
  };

  const columns: ColumnDef<Ledger>[] = [
    { id: "employee", header: "员工", cell: ({ row }) => `${row.original.employee.employeeNo} / ${row.original.employee.name}` },
    { id: "department", header: "部门", cell: ({ row }) => row.original.employee.department?.name ?? "-" },
    { id: "position", header: "岗位", cell: ({ row }) => row.original.employee.position?.name ?? "-" },
    { id: "type", header: "类型", cell: ({ row }) => row.original.employee.employeeType === "workshop" ? "车间" : "非车间" },
    { id: "period", header: "周期", cell: ({ row }) => `${row.original.periodStart.slice(0, 10)} 至 ${row.original.periodEnd.slice(0, 10)}` },
    { id: "base", header: "基本工资", cell: ({ row }) => row.original.baseSalary },
    { id: "source", header: "生产来源", cell: ({ row }) => row.original.productionSourceAmount },
    { id: "payable", header: "应发", cell: ({ row }) => money(row.original.payableAmount, row.original.currency) },
    { id: "paid", header: "已付", cell: ({ row }) => money(row.original.paidAmount, row.original.currency) },
    { id: "outstanding", header: "未付", cell: ({ row }) => money(row.original.outstandingAmount, row.original.currency) },
    { id: "payableStatus", header: "工资应付", cell: ({ row }) => { const payable = payableByLedger.get(row.original.id); return payable ? (payableStatusLabels[payable.status] ?? payable.status) : "未生成"; } },
    { id: "status", header: "状态", cell: ({ row }) => <span>{statusLabels[row.original.status] ?? row.original.status}{row.original.status === "expired" ? "（需重新结算）" : ""}</span> },
    { id: "actions", header: "操作", cell: ({ row }) => actionColumns(row.original) },
  ];
  const paymentColumns: ColumnDef<SalaryPayment>[] = [
    { accessorKey: "paymentNo", header: "支付单号" },
    { id: "date", header: "日期", cell: ({ row }) => day(row.original.paymentDate) },
    { id: "amount", header: "金额", cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { accessorKey: "status", header: "状态", cell: statusCell<SalaryPayment>() },
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">{row.original.status === "draft" && <Button size="sm" variant="secondary" onClick={() => postSalaryPayment(row.original)}>核销过账</Button>}{row.original.status === "posted" && <Button size="sm" variant="destructive" onClick={() => reverseSalaryPayment(row.original)}>冲销</Button>}</div> },
  ];

  const filteredLedgers = useMemo(() => {
    const text = employeeQuery.trim().toLowerCase();
    if (!text) return ledgers;
    return ledgers.filter((item) => `${item.employee.name} ${item.employee.employeeNo}`.toLowerCase().includes(text));
  }, [employeeQuery, ledgers]);

  const detailFields: DetailField[] = detail ? [
    { label: "台账编号", value: detail.ledgerNo }, { label: "状态", value: statusLabels[detail.status] ?? detail.status },
    { label: "员工", value: `${detail.employee.employeeNo} / ${detail.employee.name}` },
    { label: "部门", value: detail.employee.department?.name }, { label: "岗位", value: detail.employee.position?.name },
    { label: "员工类型", value: detail.employee.employeeType === "workshop" ? "车间" : "非车间" },
    { label: "周期", value: `${day(detail.periodStart)} 至 ${day(detail.periodEnd)}` }, { label: "币种", value: detail.currency },
    { label: "基本工资", value: detail.baseSalary }, { label: "生产来源", value: detail.productionSourceAmount },
    { label: "加班工资", value: detail.overtimeAmount }, { label: "考勤扣款", value: detail.attendanceDeduction },
    { label: "绩效金额", value: detail.performanceAmount }, { label: "补贴金额", value: detail.allowanceAmount },
    { label: "社保", value: detail.socialInsurance }, { label: "个税", value: detail.individualTax },
    { label: "其他调整", value: detail.otherAdjustment },
    { label: "应发", value: money(detail.payableAmount, detail.currency) }, { label: "已付", value: money(detail.paidAmount, detail.currency) },
    { label: "未付", value: money(detail.outstandingAmount, detail.currency) },
    { label: "备注", value: detail.remark, wide: true },
  ] : [];

  if (loading) return <><PageHeader title="工资管理" /><LoadingState /></>;

  return <div className="page-root" data-testid="page-finance-salary">
    <PageHeader title="工资管理" description="满页台账视图，按月、部门、岗位筛选。仅车间生产日报自动带入生产来源，其他收入和扣款人工填写。">
      <Button asChild variant="secondary"><Link href="/finance">返回财务</Link></Button>
      <Button onClick={openCreate}>新建工资台账</Button><Button variant="secondary" onClick={createSalaryPayment}>新建工资付款</Button>
    </PageHeader>
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { dialog?.submit(values); setDialog(null); }} />
    <RecordDetailDialog
      open={Boolean(detail)}
      onOpenChange={(open) => { if (!open) setDetail(null); }}
      title={`工资台账 ${detail?.ledgerNo ?? ""}`}
      description="双击台账行打开的详情：展示全部金额字段与来源/核销明细。"
      fields={detailFields}
      sections={detail ? [
        { title: `生产日报来源（${detail.sourceSnapshot?.length ?? 0} 条）`, note: "仅车间员工的工序日报自动形成生产来源；其他收入与扣款均为人工填写。", content: detail.sourceSnapshot?.length
          ? <DataTable pageSize={10} columns={[{ accessorKey: "order_no", header: "订单号" }, { accessorKey: "wage_mode", header: "计薪方式" }, { accessorKey: "quantity", header: "件数" }, { accessorKey: "duration_hours", header: "时长（小时）" }, { accessorKey: "amount", header: "金额" }] as ColumnDef<NonNullable<Ledger["sourceSnapshot"]>[number]>[]} data={detail.sourceSnapshot} /> : <p className="panel-note">没有自动生产来源（非车间员工或该期间无日报）</p> },
        { title: `工资调整（${detail.adjustments?.length ?? 0} 条）`, note: "只有已过账的调整参与应发计算。", content: detail.adjustments?.length
          ? <DataTable pageSize={10} columns={[{ accessorKey: "adjustmentNo", header: "调整单号" }, { accessorKey: "adjustmentType", header: "类型" }, { id: "effect", header: "方向", cell: ({ row }) => row.original.effect === "increase" ? "增加" : "减少" }, { accessorKey: "amount", header: "金额" }, { accessorKey: "reason", header: "原因" }, { accessorKey: "status", header: "状态" }] as ColumnDef<NonNullable<Ledger["adjustments"]>[number]>[]} data={detail.adjustments} /> : <p className="panel-note">暂无调整记录</p> },
        { title: `工资付款核销（${detail.allocations?.length ?? 0} 条）`, content: detail.allocations?.length
          ? <DataTable pageSize={10} columns={[{ id: "payment", header: "付款单号", cell: ({ row }) => row.original.payment?.paymentNo ?? "-" }, { id: "date", header: "付款日期", cell: ({ row }) => day(row.original.payment?.paymentDate) }, { id: "status", header: "状态", cell: ({ row }) => row.original.payment?.status ?? "-" }, { accessorKey: "amount", header: "核销金额" }] as ColumnDef<NonNullable<Ledger["allocations"]>[number]>[]} data={detail.allocations} /> : <p className="panel-note">暂无工资付款核销</p> },
      ] : []}
      actions={detail ? actionColumns(detail) : null}
    />
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    {!error && <>
      <section className="panel panel-body">
        <div className="filter-bar">
          <label>月份<Input data-testid="salary-month-filter" type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
          <label>部门
            <Select value={departmentId || "__all"} onValueChange={(value) => { setDepartmentId(value === "__all" ? "" : value); setPositionId(""); }}>
              <SelectTrigger data-testid="salary-department-filter"><SelectValue placeholder="全部部门" /></SelectTrigger>
              <SelectContent><SelectItem value="__all">全部部门</SelectItem>{departments.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <label>岗位
            <Select value={positionId || "__all"} onValueChange={(value) => setPositionId(value === "__all" ? "" : value)}>
              <SelectTrigger data-testid="salary-position-filter"><SelectValue placeholder="全部岗位" /></SelectTrigger>
              <SelectContent><SelectItem value="__all">全部岗位</SelectItem>{positions.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <label>员工姓名/工号<Input data-testid="salary-employee-filter" value={employeeQuery} onChange={(event) => setEmployeeQuery(event.target.value)} placeholder="本地过滤" /></label>
        </div>
        <p className="panel-note">月份、部门、岗位由服务端筛选（切部门会自动清空岗位）；员工关键字是本地过滤。已付和未付按有效已过账工资付款实时计算；未付为 0 时不应再次发放，已过期台账需重新结算或使用工资调整单。</p>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>工资台账</h2><span className="panel-note">共 {filteredLedgers.length} 条；双击任意一行查看全部字段</span></div>
        <div className="panel-body"><DataTable columns={columns} data={filteredLedgers} empty={<EmptyState title="暂无工资台账" />} pageSize={50} onRowDoubleClick={(row) => setDetail(row)} rowTitle="双击查看详情" /></div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>工资付款</h2></div>
        <div className="panel-body"><DataTable columns={paymentColumns} data={payments} empty={<EmptyState title="暂无工资付款" />} /></div>
      </section>
    </>}
  </div>;
}

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { DataTable, statusCell } from "../../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../../lib/api-client";
import { currencyOptions, currencyOptionsWithCurrent, fetchCurrencyOptions, type CurrencyOption } from "../../../lib/currency-catalogue";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";

type Employee = { id: string; employeeNo: string; name: string; employeeType: string };
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
  employee: Employee;
};
const statusLabels: Record<string, string> = { draft: "草稿", confirmed: "已确认", expired: "已过期", partially_paid: "部分支付", paid: "已支付", closed: "已关闭" };
const payableStatusLabels: Record<string, string> = { draft: "应付草稿", confirmed: "应付已确认", partially_paid: "应付部分支付", paid: "应付已支付", reversed: "应付已冲销", voided: "应付已作废" };
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

export default function SalaryPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [payables, setPayables] = useState<PayrollPayable[]>([]);
  const [payments, setPayments] = useState<SalaryPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [employeeQuery, setEmployeeQuery] = useState("");
  // 币种来自可配置字典（失败回落内置清单）：工资台账与工资付款都要能选币种。
  const [currencyCatalogue, setCurrencyCatalogue] = useState<CurrencyOption[]>([]);
  const currencyDefault = (preferred: string) => { const options = currencyOptions(currencyCatalogue); return options.some((option) => option.value === preferred) ? preferred : (options[0]?.value ?? preferred); };
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  // 币种是静态配置：独立 effect，期间筛选触发的重新加载不会重复拉取字典。
  useEffect(() => { let cancelled = false; void fetchCurrencyOptions().then((options) => { if (!cancelled) setCurrencyCatalogue(options); }); return () => { cancelled = true; }; }, []);
  const employeeOptions = employees.map((item) => ({ value: item.id, label: item.employeeNo + " / " + item.name + " / " + (item.employeeType === "workshop" ? "车间" : "非车间") }));

  async function load() {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (periodStart) params.set("from", periodStart);
      if (periodEnd) params.set("to", periodEnd);
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const [e, l, p, sp] = await Promise.all([apiGet<Employee[]>("/production/employees"), apiGet<Ledger[]>(`/hr/payroll-ledgers${suffix}`), apiGet<PayrollPayable[]>("/hr/payroll-payables"), apiGet<SalaryPayment[]>("/hr/salary-payments")]);
      setEmployees(e.data);
      setLedgers(l.data);
      setPayables(p.data);
      setPayments(sp.data);
    } catch (cause) {
      setError(messageOf(cause, "工资数据加载失败"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [periodStart, periodEnd]);

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
        { name: "employee_name", label: "员工姓名", type: "select", required: true, options: employees.map((item) => ({ value: item.name, label: item.employeeNo + " / " + item.name + " / " + (item.employeeType === "workshop" ? "车间" : "非车间") })) },
        { name: "period_start", label: "周期开始", type: "date", required: true },
        { name: "period_end", label: "周期结束", type: "date", required: true },
        { name: "currency", label: "币种", type: "select", required: true, options: currencyOptions(currencyCatalogue), defaultValue: currencyDefault("CNY") },
        { name: "base_salary", label: "基本工资", type: "number", defaultValue: "0" },
        { name: "overtime_amount", label: "加班工资", type: "number", defaultValue: "0" },
        { name: "attendance_deduction", label: "考勤扣款", type: "number", defaultValue: "0" },
        { name: "performance_amount", label: "绩效金额", type: "number", defaultValue: "0" },
        { name: "allowance_amount", label: "补贴金额", type: "number", defaultValue: "0" },
        { name: "social_insurance", label: "社保", type: "number", defaultValue: "0" },
        { name: "individual_tax", label: "个税", type: "number", defaultValue: "0" },
        { name: "other_adjustment", label: "其他调整", type: "number", defaultValue: "0" },
        { name: "remark", label: "备注", type: "textarea" }
      ],
      submit: (values) => void run(apiPost("/hr/payroll-ledgers/generate", { ...values, currency: values.currency }), "工资台账已创建")
    });
  }

  function editLedger(ledger: Ledger) {
    setDialog({
      title: "编辑工资台账",
      fields: [
        { name: "employee_id", label: "员工", type: "select", required: true, defaultValue: ledger.employeeId, options: employeeOptions },
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
        { name: "remark", label: "备注", type: "textarea" },
        ...(ledger.status === "confirmed" ? [{ name: "reason", label: "修改原因", type: "textarea", required: true } as ActionField] : [])
      ],
      submit: (values) => void run(apiPatch("/hr/payroll-ledgers/" + ledger.id, { ...values, currency: values.currency }), "工资台账已更新")
    });
  }

  function reopenLedger(ledger: Ledger) {
    setDialog({ title: "工资台账回退草稿", fields: [{ name: "reason", label: "回退原因", type: "textarea", required: true }], submit: (values) => void run(apiPost("/hr/payroll-ledgers/" + ledger.id + "/reopen", values), "工资台账已回到草稿") });
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
    return <div className="action-row">{ledger.status === "draft" && <><Button size="sm" variant="secondary" onClick={() => void run(apiPost("/hr/payroll-ledgers/" + ledger.id + "/confirm"), "工资台账已确认")}>确认</Button><Button size="sm" variant="secondary" onClick={() => editLedger(ledger)}>编辑</Button><Button size="sm" variant="destructive" onClick={() => void run(apiRequest("/hr/payroll-ledgers/" + ledger.id, { method: "DELETE" }), "工资台账已删除")}>删除</Button></>}{["confirmed", "expired"].includes(ledger.status) && <><Button size="sm" variant="secondary" onClick={() => reopenLedger(ledger)}>回到草稿</Button><Button size="sm" variant="secondary" onClick={() => editLedger(ledger)}>编辑</Button></>}{ledger.status === "confirmed" && !payable && <Button size="sm" variant="secondary" onClick={() => void run(apiPost("/hr/payroll-ledgers/" + ledger.id + "/payable", {}), "工资应付已生成")}>生成应付</Button>}{payable?.status === "draft" && <Button size="sm" variant="secondary" onClick={() => void run(apiPost("/hr/payroll-payables/" + payable.id + "/confirm"), "工资应付已确认")}>确认应付</Button>}{payable && payable.status !== "draft" && <span>{payableStatusLabels[payable.status] ?? payable.status}</span>}{ledger.status === "paid" && <Button size="sm" variant="secondary" onClick={() => void run(apiPost("/hr/payroll-ledgers/" + ledger.id + "/close"), "工资台账已关闭")}>关闭</Button>}</div>;
  };

  const columns: ColumnDef<Ledger>[] = [
    { id: "employee", header: "员工", cell: ({ row }) => row.original.employee.employeeNo + " / " + row.original.employee.name },
    { id: "type", header: "类型", cell: ({ row }) => row.original.employee.employeeType === "workshop" ? "车间" : "非车间" },
    { id: "period", header: "周期", cell: ({ row }) => row.original.periodStart.slice(0, 10) + " 至 " + row.original.periodEnd.slice(0, 10) },
    { id: "base", header: "基本工资", cell: ({ row }) => row.original.baseSalary },
    { id: "source", header: "生产来源", cell: ({ row }) => row.original.productionSourceAmount },
    { id: "payable", header: "应发", cell: ({ row }) => row.original.payableAmount + " " + row.original.currency },
    { id: "paid", header: "已付", cell: ({ row }) => row.original.paidAmount + " " + row.original.currency },
    { id: "outstanding", header: "未付", cell: ({ row }) => row.original.outstandingAmount + " " + row.original.currency },
    { id: "payableStatus", header: "工资应付", cell: ({ row }) => { const payable = payableByLedger.get(row.original.id); return payable ? (payableStatusLabels[payable.status] ?? payable.status) : "未生成"; } },
    { id: "status", header: "状态", cell: ({ row }) => <span>{statusLabels[row.original.status] ?? row.original.status}{row.original.status === "expired" ? "（需重新结算）" : ""}</span> },
    { id: "actions", header: "操作", cell: ({ row }) => actionColumns(row.original) }
  ];
  const paymentColumns: ColumnDef<SalaryPayment>[] = [
    { accessorKey: "paymentNo", header: "支付单号" },
    { id: "date", header: "日期", cell: ({ row }) => row.original.paymentDate.slice(0, 10) },
    { id: "amount", header: "金额", cell: ({ row }) => row.original.amount + " " + row.original.currency },
    { accessorKey: "status", header: "状态", cell: statusCell<SalaryPayment>() },
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">{row.original.status === "draft" && <Button size="sm" variant="secondary" onClick={() => postSalaryPayment(row.original)}>核销过账</Button>}{row.original.status === "posted" && <Button size="sm" variant="destructive" onClick={() => reverseSalaryPayment(row.original)}>冲销</Button>}</div> }
  ];


  const filteredLedgers = useMemo(() => ledgers.filter((item) => {
    const employeeText = `${item.employee.name} ${item.employee.employeeNo}`.toLowerCase();
    const matchesEmployee = !employeeQuery || employeeText.includes(employeeQuery.toLowerCase());
    const matchesStart = !periodStart || item.periodEnd.slice(0, 10) >= periodStart;
    const matchesEnd = !periodEnd || item.periodStart.slice(0, 10) <= periodEnd;
    return matchesEmployee && matchesStart && matchesEnd;
  }), [employeeQuery, ledgers, periodEnd, periodStart]);
  const workshop = useMemo(() => filteredLedgers.filter((item) => item.employee.employeeType === "workshop"), [filteredLedgers]);
  const office = useMemo(() => filteredLedgers.filter((item) => item.employee.employeeType !== "workshop"), [filteredLedgers]);

  if (loading) return <><PageHeader title="工资总览" description="按车间和非车间拆分展示。"><Button asChild variant="secondary"><Link href="/finance">返回财务</Link></Button></PageHeader><LoadingState /></>;

  return (
    <div className="page-root" data-testid="page-finance-salary">
      <PageHeader title="工资总览" description="仅车间生产日报自动带入生产来源，其他收入和扣款人工填写。">
        <Button asChild variant="secondary"><Link href="/finance">返回财务</Link></Button>
        <Button onClick={openCreate}>新建工资台账</Button><Button variant="secondary" onClick={createSalaryPayment}>新建工资付款</Button>
      </PageHeader>
      <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { dialog?.submit(values); setDialog(null); }} />
      {message && <section className="panel panel-body status-success" role="status">{message}</section>}
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
      <section className="panel panel-body"><div className="filter-bar"><label>员工姓名/工号<Input value={employeeQuery} onChange={(event) => setEmployeeQuery(event.target.value)} placeholder="搜索员工" /></label><label>期间开始<Input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} /></label><label>期间结束<Input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></label></div><p className="panel-note">已付和未付按有效已过账工资付款实时计算；未付为 0 时不应再次发放，已过期台账需重新结算或使用工资调整单。</p></section>
      {/* 拉取失败时不能把「没拿到数据」渲染成「正常空表」：加载失败只留错误态 + 重试入口。 */}
      {!error && <><section className="panel">
        <div className="panel-heading"><h2>车间</h2></div>
        <div className="panel-body"><DataTable columns={columns} data={workshop} empty={<EmptyState title="暂无车间工资台账" />} /></div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>非车间</h2></div>
        <div className="panel-body"><DataTable columns={columns} data={office} empty={<EmptyState title="暂无非车间工资台账" />} /></div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>工资付款</h2></div>
        <div className="panel-body"><DataTable columns={paymentColumns} data={payments} empty={<EmptyState title="暂无工资付款" />} /></div>
      </section></>}

    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { DataTable } from "../../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../../lib/api-client";

type Employee = { id: string; employeeNo: string; name: string; employeeType: string };
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
  status: string;
  employee: Employee;
};
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

export default function SalaryPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [employeeQuery, setEmployeeQuery] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const employeeOptions = employees.map((item) => ({ value: item.id, label: item.employeeNo + " / " + item.name + " / " + (item.employeeType === "workshop" ? "车间" : "非车间") }));

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [e, l] = await Promise.all([apiGet<Employee[]>("/production/employees"), apiGet<Ledger[]>("/hr/payroll-ledgers")]);
      setEmployees(e.data);
      setLedgers(l.data);
    } catch (cause) {
      setError(messageOf(cause, "工资数据加载失败"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function run(action: Promise<unknown>, success: string) {
    setError("");
    try {
      await action;
      setMessage(success);
      await load();
    } catch (cause) {
      setError(messageOf(cause, "操作失败"));
    }
  }

  function openCreate() {
    setDialog({
      title: "新建工资台账",
      fields: [
        { name: "employee_id", label: "员工", type: "select", required: true, options: employeeOptions },
        { name: "period_start", label: "周期开始", type: "date", required: true },
        { name: "period_end", label: "周期结束", type: "date", required: true },
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
      submit: (values) => void run(apiPost("/hr/payroll-ledgers/generate", { ...values, currency: "CNY" }), "工资台账已创建")
    });
  }

  function editLedger(ledger: Ledger) {
    setDialog({
      title: "编辑工资台账",
      fields: [
        { name: "employee_id", label: "员工", type: "select", required: true, defaultValue: ledger.employeeId, options: employeeOptions },
        { name: "period_start", label: "周期开始", type: "date", required: true, defaultValue: ledger.periodStart.slice(0, 10) },
        { name: "period_end", label: "周期结束", type: "date", required: true, defaultValue: ledger.periodEnd.slice(0, 10) },
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
      submit: (values) => void run(apiPatch("/hr/payroll-ledgers/" + ledger.id, { ...values, currency: "CNY" }), "工资台账已更新")
    });
  }

  function reopenLedger(ledger: Ledger) {
    setDialog({ title: "工资台账回退草稿", fields: [{ name: "reason", label: "回退原因", type: "textarea", required: true }], submit: (values) => void run(apiPost("/hr/payroll-ledgers/" + ledger.id + "/reopen", values), "工资台账已回到草稿") });
  }

  const actionColumns = (ledger: Ledger) => <div className="action-row">{ledger.status === "draft" && <><Button size="sm" variant="secondary" onClick={() => void run(apiPost("/hr/payroll-ledgers/" + ledger.id + "/confirm"), "工资台账已确认")}>确认</Button><Button size="sm" variant="secondary" onClick={() => editLedger(ledger)}>编辑</Button><Button size="sm" variant="destructive" onClick={() => void run(apiRequest("/hr/payroll-ledgers/" + ledger.id, { method: "DELETE" }), "工资台账已删除")}>删除</Button></>}{["confirmed", "expired"].includes(ledger.status) && <><Button size="sm" variant="secondary" onClick={() => reopenLedger(ledger)}>回到草稿</Button><Button size="sm" variant="secondary" onClick={() => editLedger(ledger)}>编辑</Button></>}{ledger.status === "paid" && <Button size="sm" variant="secondary" onClick={() => void run(apiPost("/hr/payroll-ledgers/" + ledger.id + "/close"), "工资台账已关闭")}>关闭</Button>}</div>;

  const columns: ColumnDef<Ledger>[] = [
    { id: "employee", header: "员工", cell: ({ row }) => row.original.employee.employeeNo + " / " + row.original.employee.name },
    { id: "type", header: "类型", cell: ({ row }) => row.original.employee.employeeType === "workshop" ? "车间" : "非车间" },
    { id: "period", header: "周期", cell: ({ row }) => row.original.periodStart.slice(0, 10) + " 至 " + row.original.periodEnd.slice(0, 10) },
    { id: "base", header: "基本工资", cell: ({ row }) => row.original.baseSalary },
    { id: "source", header: "生产来源", cell: ({ row }) => row.original.productionSourceAmount },
    { id: "payable", header: "应付", cell: ({ row }) => row.original.payableAmount + " " + row.original.currency },
    { accessorKey: "status", header: "状态" },
    { id: "actions", header: "操作", cell: ({ row }) => actionColumns(row.original) }
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
    <>
      <PageHeader title="工资总览" description="仅车间生产日报自动带入生产来源，其他收入和扣款人工填写。">
        <Button asChild variant="secondary"><Link href="/finance">返回财务</Link></Button>
        <Button onClick={openCreate}>新建工资台账</Button>
      </PageHeader>
      <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { dialog?.submit(values); setDialog(null); }} />
      {message && <section className="panel panel-body status-success" role="status">{message}</section>}
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
      <section className="panel panel-body"><div className="filter-bar"><label>员工姓名/工号<Input value={employeeQuery} onChange={(event) => setEmployeeQuery(event.target.value)} placeholder="搜索员工" /></label><label>期间开始<Input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} /></label><label>期间结束<Input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></label></div></section>
      <section className="panel">
        <div className="panel-heading"><h2>车间</h2></div>
        <div className="panel-body"><DataTable columns={columns} data={workshop} empty={<EmptyState title="暂无车间工资台账" />} /></div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>非车间</h2></div>
        <div className="panel-body"><DataTable columns={columns} data={office} empty={<EmptyState title="暂无非车间工资台账" />} /></div>
      </section>
    </>
  );
}

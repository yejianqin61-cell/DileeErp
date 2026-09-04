"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPost } from "../../lib/api-client";

type Operation = { id: string; operationNameSnapshot: string; targetQuantity: string; status: string };
type Order = { id: string; productionOrderNo: string; orderNo: string; executionMode: string; status: string; plannedQuantity: string; operations: Operation[] };
type Employee = { id: string; employeeNo: string; name: string; employmentStatus: string };
type Report = { id: string; employeeNameSnapshot: string; employeeId: string; reportDate: string; wageMode: string; quantity: string; durationMinutes?: string; calculatedAmount: string; unitPrice: string; productionOrderOperation: { id: string; targetQuantity: string } };
type OperationReport = { id: string; productionOrderOperationId: string; reportDate: string; completedQuantity: string };
type Draft = { employee_id: string; report_date: string; wage_mode: string; quantity: string; duration_minutes: string; unit_price: string };

const today = new Date().toISOString().slice(0, 10);
const errorText = (cause: unknown) => cause instanceof ApiClientError ? cause.message : "操作失败";
const idempotencyKey = () => `daily-${typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export function DailyReportsPanel() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [operationReports, setOperationReports] = useState<OperationReport[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [selectedOperation, setSelectedOperation] = useState<Operation | null>(null);
  const [selectedReportDate, setSelectedReportDate] = useState(today);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [employeePickerOpen, setEmployeePickerOpen] = useState(false);
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [operationQuantity, setOperationQuantity] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [o, e, r, operationRows] = await Promise.all([apiGet<Order[]>("/production/orders"), apiGet<Employee[]>("/production/employees"), apiGet<Report[]>("/production/employee-reports"), apiGet<OperationReport[]>("/production/operation-reports")]);
      // 日报只能登记正在生产的生产单；草稿单尚未启动工序，后端会拒绝保存。
      setOrders(o.data.filter((item) => item.executionMode === "in_house" && item.status === "in_progress"));
      setEmployees(e.data.filter((item) => item.employmentStatus === "active"));
      setReports(r.data);
      setOperationReports(operationRows.data);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => { const refresh = () => void load(); window.addEventListener("production-order-operation-updated", refresh); return () => window.removeEventListener("production-order-operation-updated", refresh); }, []);

  function openOperation(order: Order, operation: Operation) {
    setSelectedOrder(order);
    setSelectedOperation(operation);
    setSelectedReportDate(today);
    setDrafts([]);
    setSelectedEmployeeIds([]);
    setOperationQuantity("");
  }

  function addDraft() { setEmployeePickerOpen(true); }
  function applyEmployees() {
    setDrafts((rows) => [...rows, ...selectedEmployeeIds.filter((id) => !rows.some((row) => row.employee_id === id)).map((employee_id) => ({ employee_id, report_date: selectedReportDate, wage_mode: "piece_rate", quantity: "0", duration_minutes: "", unit_price: "" }))]);
    setEmployeePickerOpen(false);
  }

  function updateDraft(index: number, patch: Partial<Draft>) {
    setDrafts((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  function closeDialog() {
    setSelectedOrder(null);
    setSelectedOperation(null);
    setDrafts([]);
    setOperationQuantity("");
  }

  async function save() {
    if (!selectedOrder || !selectedOperation) return;
    for (const row of drafts) {
      if (!row.employee_id) {
        setError("请先选择员工");
        return;
      }
      if (row.wage_mode === "piece_rate" && (!Number(row.quantity) || Number(row.quantity) <= 0)) {
        setError("计件日报必须填写有效件数");
        return;
      }
      if (row.wage_mode === "time_rate" && (!row.duration_minutes || Number(row.duration_minutes) <= 0)) {
        setError("计时日报必须填写时长");
        return;
      }
      if (!row.unit_price || Number(row.unit_price) < 0) {
        setError("请填写当日人工单价");
        return;
      }
    }
    setError("");
    try {
      if (operationQuantity && Number(operationQuantity) > 0) await apiPost("/production/operation-reports", { production_order_id: selectedOrder.id, production_order_operation_id: selectedOperation.id, report_date: selectedReportDate, completed_quantity: operationQuantity, idempotency_key: idempotencyKey() });
      await Promise.all(drafts.map((row) => apiPost("/production/employee-reports", { production_order_id: selectedOrder.id, production_order_operation_id: selectedOperation.id, ...row, idempotency_key: idempotencyKey() })));
      setMessage("工序员工日报已保存");
      closeDialog();
      await load();
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  const visibleReports = useMemo(() => reports.filter((report) => report.productionOrderOperation.id === selectedOperation?.id && report.reportDate.slice(0, 10) === selectedReportDate), [reports, selectedOperation, selectedReportDate]);
  const dailyEmployeeTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const report of reports) {
      if (report.reportDate.slice(0, 10) !== selectedReportDate) continue;
      totals.set(report.employeeId, (totals.get(report.employeeId) ?? 0) + Number(report.calculatedAmount));
    }
    return totals;
  }, [reports, selectedReportDate]);
  const plannedQuantity = Number(selectedOperation?.targetQuantity ?? 0);
  const operationDayReports = operationReports.filter((report) => report.productionOrderOperationId === selectedOperation?.id && report.reportDate.slice(0, 10) === selectedReportDate);
  const operationCompletedQuantity = operationDayReports.reduce((sum, report) => sum + Number(report.completedQuantity), 0);
  const completedQuantity = operationDayReports.length > 0 ? operationCompletedQuantity : visibleReports.filter((report) => report.wageMode === "piece_rate").reduce((sum, report) => sum + Number(report.quantity), 0);
  const isOverOrder = plannedQuantity > 0 && completedQuantity > plannedQuantity;

  if (loading) return <section className="panel"><LoadingState /></section>;
  if (error && !orders.length) return <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>;

  return (
    <section className="panel daily-report-panel">
      <div className="panel-heading">
        <h2>工序员工日报</h2>
        <Button variant="ghost" onClick={() => void load()}>刷新</Button>
      </div>
      {message && <p className="status-success panel-body">{message}</p>}
      {error && <p className="status-error panel-body">{error}</p>}
      <div className="panel-body">
        <h3>未完成生产单</h3>
        {orders.length ? <div className="daily-order-list">{orders.map((order) => <section className="daily-order-item" key={order.id}><div className="daily-order-heading"><strong>{order.productionOrderNo}</strong><span>订单号：{order.orderNo}</span><span>状态：{order.status}</span></div><div className="page-actions">{order.operations.filter((operation) => operation.status === "active").map((operation) => <Button key={operation.id} variant="secondary" onClick={() => openOperation(order, operation)}>{operation.operationNameSnapshot}</Button>)}</div></section>)}</div> : <EmptyState title="暂无未完成生产单" />}
      </div>

      <Dialog open={Boolean(selectedOperation)} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="daily-report-dialog">
          <DialogHeader>
            <DialogTitle>{selectedOrder?.productionOrderNo} / {selectedOperation?.operationNameSnapshot}</DialogTitle>
            <DialogDescription>维护当前生产单当前工序的员工日报。</DialogDescription>
          </DialogHeader>
            <div className="page-actions">
            <label>查看日期<Input type="date" value={selectedReportDate} onChange={(event) => setSelectedReportDate(event.target.value)} /></label>
            <Button variant="secondary" onClick={addDraft}>批量选择员工</Button>
            <label>本次新增工序完成量<Input type="number" min="0" step="0.0001" value={operationQuantity} placeholder="可选" onChange={(event) => setOperationQuantity(event.target.value)} /></label>
            <Button onClick={() => void save()}>保存日报</Button>
          </div>
          <div className="table-wrap"><Table><TableHeader><TableRow><TableHead>员工</TableHead><TableHead>日期</TableHead><TableHead>计薪方式</TableHead><TableHead>件数</TableHead><TableHead>时长（分钟）</TableHead><TableHead>单价</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{drafts.map((row, index) => <TableRow key={row.employee_id}><TableCell>{employees.find((employee) => employee.id === row.employee_id)?.name ?? "-"}</TableCell><TableCell><Input type="date" value={row.report_date} onChange={(event) => updateDraft(index, { report_date: event.target.value })} /></TableCell><TableCell><Select value={row.wage_mode} onValueChange={(value) => updateDraft(index, { wage_mode: value, quantity: row.quantity, duration_minutes: row.duration_minutes })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="piece_rate">计件</SelectItem><SelectItem value="time_rate">计时</SelectItem></SelectContent></Select></TableCell><TableCell><Input type="number" min="0" value={row.quantity} placeholder="可选，用于统计" onChange={(event) => updateDraft(index, { quantity: event.target.value })} /></TableCell><TableCell><Input type="number" min="0" disabled={row.wage_mode === "piece_rate"} value={row.duration_minutes} placeholder={row.wage_mode === "piece_rate" ? "计件不填" : "必填"} onChange={(event) => updateDraft(index, { duration_minutes: event.target.value })} /></TableCell><TableCell><Input type="number" min="0" value={row.unit_price} placeholder="人工填写" onChange={(event) => updateDraft(index, { unit_price: event.target.value })} /></TableCell><TableCell><Button size="sm" variant="ghost" onClick={() => setDrafts((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}>删除</Button></TableCell></TableRow>)}</TableBody></Table></div>

          <div className="daily-report-summary"><span><small>查看日期</small><strong>{selectedReportDate}</strong></span><span><small>生产总数量</small><strong>{selectedOrder?.plannedQuantity ?? "-"}</strong></span><span><small>工序计划数量</small><strong>{selectedOperation?.targetQuantity ?? "-"}</strong></span><span><small>当日登记数量</small><strong>{completedQuantity}</strong></span><span className={isOverOrder ? "status-error" : "status-success"}><small>是否超单</small><strong>{isOverOrder ? "是" : "否"}</strong></span></div>
          <h3>已登记日报</h3>
          <div className="table-wrap"><Table><TableHeader><TableRow><TableHead>员工</TableHead><TableHead>计薪方式</TableHead><TableHead>件数</TableHead><TableHead>时长</TableHead><TableHead>单价</TableHead><TableHead>当日该员工总薪资</TableHead></TableRow></TableHeader><TableBody>{visibleReports.map((report) => <TableRow key={report.id}><TableCell>{report.employeeNameSnapshot}</TableCell><TableCell>{report.wageMode}</TableCell><TableCell>{report.quantity}</TableCell><TableCell>{report.durationMinutes ?? "-"}</TableCell><TableCell>{report.unitPrice}</TableCell><TableCell>{(dailyEmployeeTotals.get(report.employeeId) ?? 0).toFixed(2)}</TableCell></TableRow>)}</TableBody></Table></div>
        </DialogContent>
      </Dialog>
      <Dialog open={employeePickerOpen} onOpenChange={setEmployeePickerOpen}><DialogContent><DialogHeader><DialogTitle>批量选择员工</DialogTitle><DialogDescription>选择员工后一次生成日报行，重复员工会自动忽略。</DialogDescription></DialogHeader><div className="employee-picker-list">{employees.map((employee) => { const checked = selectedEmployeeIds.includes(employee.id); return <Button key={employee.id} type="button" variant={checked ? "default" : "secondary"} aria-pressed={checked} onClick={() => setSelectedEmployeeIds((ids) => checked ? ids.filter((id) => id !== employee.id) : [...ids, employee.id])}>{checked ? "已选 " : ""}{employee.employeeNo} / {employee.name}</Button>; })}</div><Button onClick={applyEmployees}>加入日报</Button></DialogContent></Dialog>
    </section>
  );
}


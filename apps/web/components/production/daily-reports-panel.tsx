"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPost } from "../../lib/api-client";

type Operation = { id: string; operationNameSnapshot: string; targetQuantity: string; status: string };
type Order = { id: string; productionOrderNo: string; orderNo: string; executionMode: string; status: string; operations: Operation[] };
type Employee = { id: string; employeeNo: string; name: string; employmentStatus: string };
type Report = { id: string; employeeNameSnapshot: string; reportDate: string; wageMode: string; quantity: string; durationMinutes?: string; calculatedAmount: string; unitPrice: string; productionOrderOperation: { targetQuantity: string } };
type Draft = { employee_id: string; report_date: string; wage_mode: string; quantity: string; duration_minutes: string; unit_price: string };

const today = new Date().toISOString().slice(0, 10);
const errorText = (cause: unknown) => cause instanceof ApiClientError ? cause.message : "操作失败";

export function DailyReportsPanel() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [selectedOperation, setSelectedOperation] = useState<Operation | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [o, e, r] = await Promise.all([apiGet<Order[]>("/production/orders"), apiGet<Employee[]>("/production/employees"), apiGet<Report[]>("/production/employee-reports")]);
      setOrders(o.data.filter((item) => item.executionMode === "in_house" && !["completed", "closed"].includes(item.status)));
      setEmployees(e.data.filter((item) => item.employmentStatus === "active"));
      setReports(r.data);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  function openOperation(order: Order, operation: Operation) {
    setSelectedOrder(order);
    setSelectedOperation(operation);
    setDrafts([{ employee_id: employees[0]?.id ?? "", report_date: today, wage_mode: "piece_rate", quantity: "0", duration_minutes: "", unit_price: "0" }]);
  }

  function addDraft() {
    setDrafts((rows) => [...rows, { employee_id: employees[0]?.id ?? "", report_date: today, wage_mode: "piece_rate", quantity: "0", duration_minutes: "", unit_price: "0" }]);
  }

  function updateDraft(index: number, patch: Partial<Draft>) {
    setDrafts((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  function closeDialog() {
    setSelectedOrder(null);
    setSelectedOperation(null);
    setDrafts([]);
  }

  async function save() {
    if (!selectedOrder || !selectedOperation) return;
    for (const row of drafts) {
      if (!row.employee_id) {
        setError("请先选择员工");
        return;
      }
      if (!Number(row.quantity) || Number(row.quantity) <= 0) {
        setError("请填写有效件数");
        return;
      }
      if (row.wage_mode === "time_rate" && (!row.duration_minutes || Number(row.duration_minutes) <= 0)) {
        setError("计时日报必须填写时长");
        return;
      }
    }
    setError("");
    try {
      await Promise.all(drafts.map((row) => apiPost("/production/employee-reports", { production_order_id: selectedOrder.id, production_order_operation_id: selectedOperation.id, ...row, idempotency_key: "daily-" + crypto.randomUUID() })));
      setMessage("工序员工日报已保存");
      closeDialog();
      await load();
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  const visibleReports = useMemo(() => reports.filter((report) => report.reportDate.slice(0, 10) === today), [reports]);

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
            <Button variant="secondary" onClick={addDraft}>添加员工</Button>
            <Button onClick={() => void save()}>保存日报</Button>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>员工</th><th>日期</th><th>计薪方式</th><th>件数</th><th>时长（分钟）</th><th>单价</th><th>操作</th></tr></thead>
              <tbody>
                {drafts.map((row, index) => <tr key={"draft-" + index}><td><Select value={row.employee_id || undefined} onValueChange={(value) => updateDraft(index, { employee_id: value })}><SelectTrigger><SelectValue placeholder="选择员工" /></SelectTrigger><SelectContent>{employees.map((employee) => <SelectItem key={employee.id} value={employee.id}>{employee.employeeNo} / {employee.name}</SelectItem>)}</SelectContent></Select></td><td><Input type="date" value={row.report_date} onChange={(event) => updateDraft(index, { report_date: event.target.value })} /></td><td><Select value={row.wage_mode} onValueChange={(value) => updateDraft(index, { wage_mode: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="piece_rate">计件</SelectItem><SelectItem value="time_rate">计时</SelectItem></SelectContent></Select></td><td><Input type="number" min="0" value={row.quantity} onChange={(event) => updateDraft(index, { quantity: event.target.value })} /></td><td><Input type="number" min="0" value={row.duration_minutes} placeholder={row.wage_mode === "piece_rate" ? "计件可不填" : "计时时必填"} onChange={(event) => updateDraft(index, { duration_minutes: event.target.value })} /></td><td><Input type="number" min="0" value={row.unit_price} onChange={(event) => updateDraft(index, { unit_price: event.target.value })} /></td><td><Button size="sm" variant="ghost" onClick={() => setDrafts((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}>删除</Button></td></tr>)}
              </tbody>
            </table>
          </div>

          <h3>已登记日报</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>日期</th><th>员工</th><th>计划数量</th><th>是否超单</th><th>计薪方式</th><th>件数</th><th>时长</th><th>单价</th></tr></thead>
              <tbody>
                {visibleReports.map((report) => { const planned = Number(report.productionOrderOperation?.targetQuantity ?? 0); const quantity = Number(report.quantity); const overOrder = planned > 0 && quantity > planned; return <tr key={report.id}><td>{report.reportDate.slice(0, 10)}</td><td>{report.employeeNameSnapshot}</td><td>{report.productionOrderOperation?.targetQuantity ?? "-"}</td><td className={overOrder ? "status-error" : "status-success"}>{overOrder ? "是" : "否"}</td><td>{report.wageMode}</td><td>{report.quantity}</td><td>{report.durationMinutes ?? "-"}</td><td>{report.unitPrice}</td></tr>; })}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../lib/api-client";
import { computeEmployeeDateTotals, employeeDateTotalKey, hoursText, hoursToMinutes, resolveBatchReportDate, resolveEntryDate, selectVisibleReports, viewDateLabel } from "../../lib/production/daily-report-view";
import { notifyError, notifySuccess } from "../ui/toaster";

type Operation = { id: string; operationNameSnapshot: string; targetQuantity: string; status: string };
type Order = { id: string; productionOrderNo: string; orderNo: string; executionMode: string; status: string; plannedQuantity: string; operations: Operation[] };
type Employee = { id: string; employeeNo: string; name: string; employmentStatus: string };
type Report = { id: string; version?: number; productionOrderId: string; employeeNameSnapshot: string; employeeId: string; reportDate: string; wageMode: string; quantity: string; durationMinutes?: string; calculatedAmount: string; unitPrice: string; remark?: string | null; productionOrderOperation: { id: string; targetQuantity: string } };
// 计时单位统一为“小时”（duration_hours，可填小数）；接口/数据库仍以分钟存储，由前端换算展示。
// draft_id：草稿行自身稳定的幂等标识，用来生成批量保存的 idempotency_key。
// 不能用行序号：网络超时后（服务端其实已提交）操作员删掉/调整某行再重试时，序号会整体前移，
// 导致旧幂等键被复用到别的员工身上——那一行会被静默丢弃。draft_id 不会随位置变化。
type Draft = { draft_id: string; employee_id: string; report_date: string; wage_mode: string; quantity: string; duration_hours: string; unit_price: string; remark: string };
type ReportEdit = { quantity: string; duration_hours: string; unit_price: string; remark: string };

const today = new Date().toISOString().slice(0, 10);
const errorText = (cause: unknown) => cause instanceof ApiClientError ? cause.message : "操作失败";
const idempotencyKey = () => `daily-${typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const wageModeLabel = (mode: string) => mode === "time_rate" ? "计时" : "计件";
const unitPriceLabel = (mode: string) => mode === "time_rate" ? "单价（元/小时）" : "单价（元/件）";
const emptyEdit = (report: Report): ReportEdit => ({ quantity: report.quantity, duration_hours: hoursText(report.durationMinutes), unit_price: report.unitPrice, remark: report.remark ?? "" });

export function DailyReportsPanel({ productionOrderId }: { productionOrderId?: string } = {}) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [selectedOperation, setSelectedOperation] = useState<Operation | null>(null);
  // 查看日期：空字符串表示不按日期过滤（展示当前工序所有日期、所有员工的每日条目），选择日期后才按日期筛选。
  const [selectedReportDate, setSelectedReportDate] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [employeePickerOpen, setEmployeePickerOpen] = useState(false);
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveKey, setSaveKey] = useState<string | null>(null);
  const [editDialog, setEditDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void } | null>(null);
    const [reportEdits, setReportEdits] = useState<Record<string, ReportEdit>>({});
    const [inlineReason, setInlineReason] = useState("");
    const [savingReportId, setSavingReportId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const scope = productionOrderId ? `?production_order_id=${encodeURIComponent(productionOrderId)}` : "";
      const [o, e, r] = await Promise.all([productionOrderId ? apiGet<Order>(`/production/orders/${productionOrderId}`) : apiGet<Order[]>("/production/orders"), apiGet<Employee[]>("/production/employees"), apiGet<Report[]>(`/production/employee-reports${scope}`)]);
      // 日报只能登记正在生产的生产单；草稿单尚未启动工序，后端会拒绝保存。
      const scopedOrders = productionOrderId ? [o.data as Order] : (o.data as Order[]);
      setOrders(scopedOrders.filter((item) => item.executionMode === "in_house" && ["in_progress", "completed"].includes(item.status)));
      setEmployees(e.data.filter((item) => item.employmentStatus === "active"));
      setReports(r.data);
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
    setSelectedReportDate("");
    setDrafts([]);
    setSelectedEmployeeIds([]);
      setReportEdits({});
      setInlineReason("");
      setSavingReportId(null);
    setSaveKey(idempotencyKey());
  }

  // 每次打开选择器都清空上次勾选：允许重复员工后，残留勾选会导致再次点击“加入日报”重复追加意料之外的行。
  function addDraft() { setSelectedEmployeeIds([]); setEmployeePickerOpen(true); }

  // 业务要求：同一天、同一生产单、同一工序、同一员工允许被多次选中（多条日报各自独立计薪），
  // 因此这里对已存在的员工不做去重过滤，选中的每个员工都追加一行；选完后清空勾选，避免重复点击误加。
  function applyEmployees() {
    setDrafts((rows) => [...rows, ...selectedEmployeeIds.map((employee_id) => ({ draft_id: idempotencyKey(), employee_id, report_date: resolveEntryDate(selectedReportDate, today), wage_mode: "piece_rate", quantity: "0", duration_hours: "", unit_price: "", remark: "" }))]);
    setSelectedEmployeeIds([]);
    setEmployeePickerOpen(false);
  }

  function updateDraft(index: number, patch: Partial<Draft>) {
    setDrafts((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  function closeDialog() {
    setSelectedOrder(null);
    setSelectedOperation(null);
    setDrafts([]);
      setReportEdits({});
      setInlineReason("");
      setSavingReportId(null);
    setSaveKey(null);
  }
    function updateReportField(report: Report, field: keyof ReportEdit, value: string) {
      setReportEdits((current) => ({ ...current, [report.id]: { ...(current[report.id] ?? emptyEdit(report)), [field]: value } }));
    }

    function reportEditDirty(report: Report) {
      const edit = reportEdits[report.id];
      if (!edit) return false;
      const original = emptyEdit(reports.find((item) => item.id === report.id) ?? report);
        return edit.quantity !== original.quantity || edit.duration_hours !== original.duration_hours || edit.unit_price !== original.unit_price || edit.remark !== original.remark;
    }

    async function saveReportEdit(report: Report) {
      const edit = reportEdits[report.id];
      if (!edit || !reportEditDirty(report)) return;
      if (!inlineReason.trim()) {
        setError("请填写更正原因后再保存日报修改");
        return;
      }
      if (report.wageMode === "piece_rate" && (!Number(edit.quantity) || Number(edit.quantity) <= 0)) {
        setError("计件日报必须填写有效件数");
        return;
      }
      if (report.wageMode === "time_rate" && (!edit.duration_hours || Number(edit.duration_hours) <= 0)) {
        setError("计时日报必须填写有效时长（小时）");
        return;
      }
      if (!edit.unit_price || Number(edit.unit_price) < 0) {
        setError("请填写有效人工单价");
        return;
      }
      setError("");
      setSavingReportId(report.id);
      try {
        // 只提交真正改动过的计价字段：后端按“生效值是否变化”决定是否重算金额快照，
        // 整体回传同值虽然也不会重算，但少传字段能让审计差异和误写风险都更小
        // （历史按分钟单价录入的日报，时长往返换算会差 0.001 分钟）。
        const original = emptyEdit(reports.find((item) => item.id === report.id) ?? report);
        const body: Record<string, string | number | undefined> = { reason: inlineReason.trim(), expected_version: report.version, remark: edit.remark.trim() };
        if (edit.quantity !== original.quantity) body.quantity = edit.quantity;
        if (edit.duration_hours !== original.duration_hours) body.duration_hours = edit.duration_hours;
        if (edit.unit_price !== original.unit_price) body.unit_price = edit.unit_price;
        await apiRequest(`/production/employee-reports/${report.id}`, { method: "PATCH", body: JSON.stringify(body) });
        notifySuccess("日报已更正，当日员工薪资和总薪资已联动更新");
        setReportEdits((current) => {
          const next = { ...current };
          delete next[report.id];
          return next;
        });
        setInlineReason("");
        await load();
      } catch (cause) {
        // 更正失败（典型为 DAILY_REPORT_VERSION_CONFLICT：本地 expected_version 已过期）。
        // 丢弃基于旧版本的行内编辑并整体刷新为服务端最新数据，避免残留旧版本号造成反复 422，
        // 并提示操作员按刷新后的版本重新修改。保存按钮的禁用仍只作用于本行自身提交期间（savingReportId）。
        const causeText = errorText(cause);
        setReportEdits((current) => {
          const next = { ...current };
          delete next[report.id];
          return next;
        });
        await load();
        notifyError(`${causeText}；已刷新为最新日报版本，请基于当前数据重新更正后保存`);
      } finally {
        setSavingReportId(null);
      }
    }

  function editReport(report: Report) {
    // 弹窗字段的默认值就是操作员看到的原值；提交时逐字段比对，只发送真正改动过的计价字段，
    // 这样“打开更正却什么都没改”不会让后端认为计价要素变化（历史日报的金额与时长保持原样）。
    const original = emptyEdit(report);
    setEditDialog({ title: `更正日报：${report.employeeNameSnapshot}`, fields: [
      { name: "quantity", label: "件数", type: "number", defaultValue: original.quantity },
      { name: "duration_hours", label: "时长（小时）", type: "number", defaultValue: original.duration_hours },
      { name: "unit_price", label: unitPriceLabel(report.wageMode), type: "number", required: true, defaultValue: original.unit_price },
      { name: "remark", label: "备注", type: "text", defaultValue: original.remark },
      { name: "reason", label: "更正原因", type: "textarea", required: true },
    ], submit: async (values) => {
      try {
        const body: Record<string, string | number | undefined> = { reason: values.reason, expected_version: report.version, remark: (values.remark ?? "").trim() };
        if ((values.quantity ?? "") !== original.quantity) body.quantity = values.quantity;
        if ((values.duration_hours ?? "") !== original.duration_hours) body.duration_hours = values.duration_hours;
        if ((values.unit_price ?? "") !== original.unit_price) body.unit_price = values.unit_price;
        await apiRequest(`/production/employee-reports/${report.id}`, { method: "PATCH", body: JSON.stringify(body) });
        notifySuccess("员工日报已更正");
        setEditDialog(null);
        await load();
      } catch (cause) { notifyError(errorText(cause)); }
    } });
  }

  function deleteReport(report: Report) {
    setEditDialog({ title: `删除日报：${report.employeeNameSnapshot}`, fields: [{ name: "reason", label: "删除原因", type: "textarea", required: true }], submit: async (values) => {
      try {
        await apiRequest(`/production/employee-reports/${report.id}`, { method: "DELETE", body: JSON.stringify({ reason: values.reason, expected_version: report.version }) });
        notifySuccess("员工日报已删除");
        setEditDialog(null);
        await load();
      } catch (cause) { notifyError(errorText(cause)); }
    } });
  }

  async function save() {
    if (!selectedOrder || !selectedOperation) return;
    if (saving) return;
    for (const row of drafts) {
      if (!row.employee_id) {
        setError("请先选择员工");
        return;
      }
      if (row.wage_mode === "piece_rate" && (!Number(row.quantity) || Number(row.quantity) <= 0)) {
        setError("计件日报必须填写有效件数");
        return;
      }
      if (row.wage_mode === "time_rate" && (!row.duration_hours || Number(row.duration_hours) <= 0)) {
        setError("计时日报必须填写时长（小时）");
        return;
      }
      if (!row.unit_price || Number(row.unit_price) < 0) {
        setError("请填写当日人工单价");
        return;
      }
    }
    setError("");
    setSaving(true);
    try {
      const batchKey = saveKey ?? idempotencyKey();
      // 批量接口以 body 的 report_date 覆盖行日期；未选查看日期时回落到草稿行日期或当天，保证与行展示一致。
      const batchReportDate = resolveBatchReportDate(selectedReportDate, drafts.map((row) => row.report_date), today);
      // 幂等键 = 本次会话批次 + 草稿行自身标识：同一员工多次复选也能区分，且重试时键不变（真正幂等）。
      // draft_id 不参与请求体，避免把前端内部字段写进接口契约。
      if (drafts.length) await apiPost("/production/employee-reports/batch", { production_order_id: selectedOrder.id, production_order_operation_id: selectedOperation.id, report_date: batchReportDate, rows: JSON.stringify(drafts.map(({ draft_id, ...row }) => ({ ...row, idempotency_key: `${batchKey}-${draft_id}` }))) });
      notifySuccess("工序员工日报已保存");
      closeDialog();
      await load();
    } catch (cause) {
      notifyError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }

  const effectiveReports = useMemo(() => reports.map((report) => {
      const edit = reportEdits[report.id];
      if (!edit) return report;
      // 行内预览与后端同口径：计时金额 = 时长（小时）× 单价；同时把分钟列换算回本地展示值。
      const amount = report.wageMode === "time_rate"
        ? Number(edit.duration_hours || 0) * Number(edit.unit_price || 0)
        : Number(edit.quantity || 0) * Number(edit.unit_price || 0);
      return { ...report, quantity: edit.quantity, durationMinutes: edit.duration_hours ? String(hoursToMinutes(edit.duration_hours)) : undefined, unitPrice: edit.unit_price, remark: edit.remark, calculatedAmount: Number.isFinite(amount) ? String(amount) : "0" };
    }), [reports, reportEdits]);
    // 查看日期为空时展示当前工序所有日期的日报条目；选择日期后才按日期过滤（scoped 到当前工序）。
    const visibleReports = useMemo(() => selectVisibleReports(effectiveReports, selectedOperation?.id, selectedReportDate), [effectiveReports, selectedOperation, selectedReportDate]);
    // 当日该员工总薪资按“员工 + 日期”聚合（跨工序，与历史口径一致）；
    // 未过滤日期时每行取该行自身日期的合计，选中日期时与历史行为完全一致。
    const dailyEmployeeTotals = useMemo(() => computeEmployeeDateTotals(effectiveReports), [effectiveReports]);
  const plannedQuantity = Number(selectedOperation?.targetQuantity ?? 0);
  const employeeReportsForCurrentOperation = effectiveReports.filter((report) => report.productionOrderId === selectedOrder?.id && report.productionOrderOperation.id === selectedOperation?.id && report.wageMode === "piece_rate" && report.quantity !== undefined);
  const hasCompletedQuantity = employeeReportsForCurrentOperation.length > 0;
  const completedQuantity = employeeReportsForCurrentOperation.reduce((sum, report) => sum + Number(report.quantity || 0), 0);
  const isOverOrder = hasCompletedQuantity && plannedQuantity > 0 && completedQuantity > plannedQuantity;

  if (loading) return <section className="panel"><LoadingState /></section>;
  if (error && !orders.length) return <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>;

  return (
    <section className="panel daily-report-panel">
      <div className="panel-heading">
        <h2>工序员工日报</h2>
        <Button variant="ghost" onClick={() => void load()}>刷新</Button>
      </div>
      {error && <p className="status-error panel-body">{error}</p>}
      <div className="panel-body">
        <h3>未完成生产单</h3>
        {orders.length ? <div className="daily-order-list">{orders.map((order) => <section className="daily-order-item" key={order.id}><div className="daily-order-heading"><strong>{order.productionOrderNo}</strong><span>订单号：{order.orderNo}</span><span>状态：{order.status}</span></div><div className="page-actions">{order.operations.filter((operation) => operation.status === "active").map((operation) => <Button key={operation.id} variant="secondary" onClick={() => openOperation(order, operation)}>{operation.operationNameSnapshot}</Button>)}</div></section>)}</div> : <EmptyState title="暂无未完成生产单" />}
      </div>

      <ActionDialog open={Boolean(editDialog)} onOpenChange={(open) => { if (!open) setEditDialog(null); }} title={editDialog?.title ?? "更正日报"} fields={editDialog?.fields ?? []} onSubmit={async (values) => { await editDialog?.submit(values); }} />
      <Dialog open={Boolean(selectedOperation)} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="daily-report-dialog">
          <DialogHeader>
            <DialogTitle>{selectedOrder?.productionOrderNo} / {selectedOperation?.operationNameSnapshot}</DialogTitle>
            <DialogDescription>维护当前生产单当前工序的员工日报；同一员工同一天可重复登记多条，计时单位统一为小时。</DialogDescription>
          </DialogHeader>
            <div className="page-actions">
            <label>查看日期（留空显示全部）<Input type="date" value={selectedReportDate} onChange={(event) => { const value = event.target.value; const entryDate = resolveEntryDate(value, today); setSelectedReportDate(value); setDrafts((rows) => rows.map((row) => ({ ...row, report_date: entryDate }))); setReportEdits({}); setInlineReason(""); }} /></label>
            <Button variant="secondary" onClick={addDraft}>批量选择员工</Button>
            <Button onClick={() => void save()} disabled={saving}>{saving ? "保存中..." : "保存日报"}</Button>
          </div>
          <div className="table-wrap"><Table><TableHeader><TableRow><TableHead>员工</TableHead><TableHead>日期</TableHead><TableHead>计薪方式</TableHead><TableHead>件数</TableHead><TableHead>时长（小时）</TableHead><TableHead>单价</TableHead><TableHead>备注</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{drafts.map((row, index) => <TableRow key={`${row.employee_id}-${index}`}><TableCell>{employees.find((employee) => employee.id === row.employee_id)?.name ?? "-"}</TableCell><TableCell>{row.report_date}</TableCell><TableCell><Select value={row.wage_mode} onValueChange={(value) => updateDraft(index, { wage_mode: value, quantity: row.quantity, duration_hours: row.duration_hours })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="piece_rate">计件</SelectItem><SelectItem value="time_rate">计时</SelectItem></SelectContent></Select></TableCell><TableCell><Input type="number" min="0" value={row.quantity} placeholder="可选，用于统计" onChange={(event) => updateDraft(index, { quantity: event.target.value })} /></TableCell><TableCell><Input type="number" min="0" step="0.0001" disabled={row.wage_mode === "piece_rate"} value={row.duration_hours} placeholder={row.wage_mode === "piece_rate" ? "计件不填" : "必填，如 1.5"} onChange={(event) => updateDraft(index, { duration_hours: event.target.value })} /></TableCell><TableCell><Input type="number" min="0" step="0.0001" value={row.unit_price} placeholder={row.wage_mode === "time_rate" ? "元/小时" : "元/件"} onChange={(event) => updateDraft(index, { unit_price: event.target.value })} /></TableCell><TableCell><Input value={row.remark} maxLength={1000} placeholder="可选" onChange={(event) => updateDraft(index, { remark: event.target.value })} /></TableCell><TableCell><Button size="sm" variant="ghost" onClick={() => setDrafts((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}>删除</Button></TableCell></TableRow>)}</TableBody></Table></div>

          <div className="daily-report-summary"><span><small>查看日期</small><strong>{viewDateLabel(selectedReportDate)}</strong></span><span><small>生产总数量</small><strong>{selectedOrder?.plannedQuantity ?? "-"}</strong></span><span><small>工序计划数量</small><strong>{selectedOperation?.targetQuantity ?? "-"}</strong></span><span><small>本工序已完成数量</small><strong>{hasCompletedQuantity ? completedQuantity : "-"}</strong></span><span className={isOverOrder ? "status-error" : "status-success"}><small>是否超单</small><strong>{isOverOrder ? "是" : "否"}</strong></span></div>
            <div className="inline-edit-bar"><Input value={inlineReason} placeholder="更正原因" onChange={(event) => setInlineReason(event.target.value)} /></div>
          <div className="table-wrap"><Table><TableHeader><TableRow><TableHead>员工</TableHead><TableHead>日期</TableHead><TableHead>计薪方式</TableHead><TableHead>件数</TableHead><TableHead>时长（小时）</TableHead><TableHead>单价</TableHead><TableHead>备注</TableHead><TableHead>本行薪资</TableHead><TableHead>当日该员工总薪资</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{visibleReports.map((report) => <TableRow key={report.id}><TableCell>{report.employeeNameSnapshot}</TableCell><TableCell>{report.reportDate.slice(0, 10)}</TableCell><TableCell>{wageModeLabel(report.wageMode)}</TableCell><TableCell><Input type="number" min="0" step="0.0001" value={reportEdits[report.id]?.quantity ?? report.quantity} onChange={(event) => updateReportField(report, "quantity", event.target.value)} /></TableCell><TableCell><Input type="number" min="0" step="0.0001" disabled={report.wageMode === "piece_rate"} value={reportEdits[report.id]?.duration_hours ?? hoursText(report.durationMinutes)} onChange={(event) => updateReportField(report, "duration_hours", event.target.value)} /></TableCell><TableCell><Input type="number" min="0" step="0.0001" title={unitPriceLabel(report.wageMode)} value={reportEdits[report.id]?.unit_price ?? report.unitPrice} onChange={(event) => updateReportField(report, "unit_price", event.target.value)} /></TableCell><TableCell><Input value={reportEdits[report.id]?.remark ?? report.remark ?? ""} maxLength={1000} placeholder="可选" onChange={(event) => updateReportField(report, "remark", event.target.value)} /></TableCell><TableCell>{Number(report.calculatedAmount).toFixed(2)}</TableCell><TableCell>{(dailyEmployeeTotals.get(employeeDateTotalKey(report.employeeId, report.reportDate)) ?? 0).toFixed(2)}</TableCell><TableCell><div className="action-row"><Button size="sm" variant="default" disabled={!reportEditDirty(report) || savingReportId === report.id} onClick={() => void saveReportEdit(report)}>{savingReportId === report.id ? "保存中..." : reportEditDirty(report) ? "保存" : "未修改"}</Button><Button size="sm" variant="ghost" onClick={() => editReport(report)}>更正</Button><Button size="sm" variant="ghost" onClick={() => deleteReport(report)}>删除</Button></div></TableCell></TableRow>)}</TableBody></Table></div>
        </DialogContent>
      </Dialog>
      <Dialog open={employeePickerOpen} onOpenChange={setEmployeePickerOpen}><DialogContent><DialogHeader><DialogTitle>批量选择员工</DialogTitle><DialogDescription>一次可勾选多名员工；同一员工需要多条日报时（例如上午、下午各一条），再次点“批量选择员工”并重新勾选即可，系统不会去重。</DialogDescription></DialogHeader><div className="employee-picker-list">{employees.map((employee) => { const checked = selectedEmployeeIds.includes(employee.id); return <Button key={employee.id} type="button" variant={checked ? "default" : "secondary"} aria-pressed={checked} onClick={() => setSelectedEmployeeIds((ids) => checked ? ids.filter((id) => id !== employee.id) : [...ids, employee.id])}>{checked ? "已选 " : ""}{employee.employeeNo} / {employee.name}</Button>; })}</div><Button onClick={applyEmployees}>加入日报</Button></DialogContent></Dialog>
    </section>
  );
}

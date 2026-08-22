"use client";

import { useEffect, useMemo, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { RefreshCw } from "lucide-react";
import { PageHeader } from "../components/layout/app-shell";
import { EmptyState, LoadingState } from "../components/feedback/states";
import { DataTable } from "../components/data/data-table";
import { StatusBadge } from "../components/data/status-badge";
import { Button } from "../components/ui/button";
import { ApiClientError, apiGet } from "../lib/api-client";

type BlockerDetail = { code: string; label: string; suggestion: string };
type Measurement = { operation_id: string | null; operation_name: string | null; source_type: string; source_ids: string[]; source_dates: string[]; unit: string; execution_mode: string; planned_quantity: string; actual_quantity: string; difference_quantity: string; over_order_quantity: string; completion_rate: string | null; status: string };
type ProductionSummary = { production_order_id: string; production_order_no: string; order_no: string; execution_mode: string; status: string; status_label: string; blockers: string[]; blocker_details: BlockerDetail[]; capability_not_implemented: string[]; measurements: Measurement[]; unit_summaries: Measurement[]; operation_count: number; completed_operation_count: number; outsource_receipt_risk_count: number };
type OrderStatus = { order_no: string; status: string; status_label: string; blockers: string[]; blocker_details: BlockerDetail[]; capability_not_implemented: string[]; production_orders: ProductionSummary[]; production_order_count: number; blocking_count: number };
type AuditEvent = { id: string; action: string; entityType: string; createdAt: string; details: Record<string, unknown> };

const orderColumns = createColumnHelper<OrderStatus>();
const productionColumns = createColumnHelper<ProductionSummary>();
const measurementColumns = createColumnHelper<Measurement>();

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  if (["production_completed", "ready_to_ship"].includes(status)) return "success";
  if (status === "blocked") return "danger";
  if (status === "in_production") return "info";
  return "warning";
}

function messageOf(cause: unknown) { return cause instanceof ApiClientError ? cause.message : "工作台数据加载失败"; }

export default function WorkbenchPage() {
  const [orders, setOrders] = useState<OrderStatus[]>([]); const [measurements, setMeasurements] = useState<Measurement[]>([]); const [timeline, setTimeline] = useState<AuditEvent[]>([]); const [selectedOrderNo, setSelectedOrderNo] = useState(""); const [filter, setFilter] = useState(""); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  async function load() {
    setLoading(true); setError("");
    try { const [statuses, measurementRows] = await Promise.all([apiGet<OrderStatus[]>("/production-progress/order-statuses?page_size=200"), apiGet<Measurement[]>("/production-progress/measurements?page_size=200")]); setOrders(statuses.data); setMeasurements(measurementRows.data); if (selectedOrderNo && !statuses.data.some((order) => order.order_no === selectedOrderNo)) { setSelectedOrderNo(""); setTimeline([]); } }
    catch (cause) { setError(messageOf(cause)); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function selectOrder(orderNo: string) { setSelectedOrderNo(orderNo); setError(""); try { const result = await apiGet<AuditEvent[]>(`/production-progress/order-statuses/${encodeURIComponent(orderNo)}/timeline`); setTimeline(result.data); } catch (cause) { setError(messageOf(cause)); setTimeline([]); } }
  const visibleOrders = useMemo(() => orders.filter((order) => `${order.order_no} ${order.status_label} ${order.blocker_details.map((item) => item.label).join(" ")}`.toLowerCase().includes(filter.toLowerCase())), [filter, orders]);
  const selected = orders.find((order) => order.order_no === selectedOrderNo);
  const selectedMeasurements = selected ? selected.production_orders.flatMap((production) => production.measurements) : measurements.filter(() => false);
  return <>
    <PageHeader title="工作台" description="按订单号查看生产计量、推进状态、阻塞原因和审计时间线"><Button variant="secondary" onClick={() => { void load(); }} title="刷新工作台"><RefreshCw size={15} />刷新</Button></PageHeader>
    {error && <section className="panel panel-body status-danger" role="alert">{error}</section>}
    {loading ? <LoadingState label="正在加载订单推进状态" /> : <>
      <section className="panel table-panel"><div className="panel-heading"><h2>订单推进状态</h2><span className="panel-note">服务端计算</span></div><div className="panel-body"><div className="filter-bar"><label htmlFor="workbench-order-filter">筛选订单</label><input id="workbench-order-filter" className="filter-input" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="订单号、状态或阻塞原因" /></div><DataTable columns={[orderColumns.accessor("order_no", { header: "订单号" }), orderColumns.accessor("status_label", { header: "当前状态", cell: (info) => <StatusBadge label={info.getValue()} tone={statusTone(info.row.original.status)} /> }), orderColumns.accessor("production_order_count", { header: "生产单" }), orderColumns.accessor("blocking_count", { header: "阻塞" }), orderColumns.display({ id: "actions", header: "操作", cell: (info) => <Button variant="ghost" onClick={() => { void selectOrder(info.row.original.order_no); }}>查看详情</Button> })]} data={visibleOrders} empty={<EmptyState title="暂无订单推进数据" description="生产单启动并产生来源事实后，这里会显示订单状态。" />} /></div></section>
      {selected && <section className="progress-detail-grid"><section className="panel"><div className="panel-heading"><h2>{selected.order_no} · {selected.status_label}</h2><span className="panel-note">{selected.production_order_count} 个生产单</span></div><div className="panel-body"><div className="blocker-list">{selected.blocker_details.length ? selected.blocker_details.map((item) => <div className="status-danger progress-warning" key={item.code}><strong>{item.label}</strong><span>{item.suggestion}</span></div>) : <p className="panel-note">当前没有待处理阻塞。</p>}</div>{selected.capability_not_implemented.length > 0 && <p className="panel-note progress-capability">后续能力尚未启用：{selected.capability_not_implemented.join("、")}</p>}</div></section><section className="panel"><div className="panel-heading"><h2>生产单进度</h2></div><div className="panel-body"><DataTable columns={[productionColumns.accessor("production_order_no", { header: "生产单号" }), productionColumns.accessor("execution_mode", { header: "方式", cell: (info) => info.getValue() === "in_house" ? "厂内" : "外加工" }), productionColumns.accessor("status_label", { header: "状态", cell: (info) => <StatusBadge label={info.getValue()} tone={statusTone(info.row.original.status)} /> }), productionColumns.accessor("operation_count", { header: "工序" }), productionColumns.accessor("completed_operation_count", { header: "已完成" })]} data={selected.production_orders} /></div></section><section className="panel" style={{ gridColumn: "1 / -1" }}><div className="panel-heading"><h2>生产计量</h2><span className="panel-note">只读来源汇总</span></div><div className="panel-body"><DataTable columns={[measurementColumns.accessor("operation_name", { header: "工序/来源", cell: (info) => info.getValue() ?? (info.row.original.source_type === "outsource_direct_shipment" ? "外加工直装柜" : "外加工成品回厂") }), measurementColumns.accessor("actual_quantity", { header: "完成数量" }), measurementColumns.accessor("planned_quantity", { header: "计划数量" }), measurementColumns.accessor("difference_quantity", { header: "差额" }), measurementColumns.accessor("over_order_quantity", { header: "超单量" }), measurementColumns.accessor("unit", { header: "单位" }), measurementColumns.accessor("status", { header: "计量状态" })]} data={selectedMeasurements} empty={<EmptyState title="暂无计量来源" />} /></div></section><section className="panel" style={{ gridColumn: "1 / -1" }}><div className="panel-heading"><h2>状态与来源审计</h2><span className="panel-note">最近 200 条</span></div><div className="panel-body">{timeline.length ? <ol className="audit-timeline">{timeline.map((event) => <li key={event.id}><strong>{event.action}</strong><time>{new Date(event.createdAt).toLocaleString("zh-CN")}</time><small>{typeof event.details?.status === "string" ? `状态：${event.details.status}` : "来源事实变更"}</small></li>)}</ol> : <EmptyState title="暂无审计记录" description="选择订单后查看状态变化与来源重算记录。" />}</div></section></section>}
    </>}
  </>;
}

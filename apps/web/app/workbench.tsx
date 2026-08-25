"use client";

import { useEffect, useMemo, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { RefreshCw } from "lucide-react";
import { PageHeader } from "../components/layout/app-shell";
import { EmptyState, LoadingState } from "../components/feedback/states";
import { DataTable } from "../components/data/data-table";
import { StatusBadge } from "../components/data/status-badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ApiClientError, apiGet } from "../lib/api-client";

type BlockerDetail = { code: string; label: string; suggestion: string };
type Measurement = { order_no?: string; operation_id: string | null; operation_name: string | null; source_type: string; source_ids: string[]; source_dates: string[]; unit: string; execution_mode: string; planned_quantity: string; actual_quantity: string; difference_quantity: string; over_order_quantity: string; completion_rate: string | null; status: string };
type ProductionSummary = { production_order_id: string; production_order_no: string; order_no: string; execution_mode: string; status: string; status_label: string; blockers: string[]; blocker_details: BlockerDetail[]; capability_not_implemented: string[]; measurements: Measurement[]; unit_summaries: Measurement[]; operation_count: number; completed_operation_count: number; outsource_receipt_risk_count: number };
type OrderStatus = { order_no: string; status: string; status_label: string; blockers: string[]; blocker_details: BlockerDetail[]; capability_not_implemented: string[]; production_orders: ProductionSummary[]; production_order_count: number; blocking_count: number };
type ModuleSummary = { status: string; label: string; counts: { records: number }; source_ids: string[]; missing: boolean; amounts?: { amount: string; currency: string }; quantity_delta?: string; rejected_quantity?: string };
type WorkbenchOrder = { order_no: string; customer: Record<string, unknown>; sales_status: string; bom_status: string; procurement_summary: ModuleSummary; raw_material_inventory_summary: ModuleSummary; production_summary: ModuleSummary; finished_goods_qc_summary: ModuleSummary; finished_goods_inventory_summary: ModuleSummary; shipping_summary: ModuleSummary; receivable_summary: ModuleSummary; payable_summary: ModuleSummary; overall_status: string; overall_status_label: string; blockers: BlockerDetail[]; updated_at: string };

const orderColumns = createColumnHelper<WorkbenchOrder>();
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
  const [orders, setOrders] = useState<WorkbenchOrder[]>([]); const [selectedOrder, setSelectedOrder] = useState<WorkbenchOrder | null>(null); const [measurements, setMeasurements] = useState<Measurement[]>([]); const [selectedOrderNo, setSelectedOrderNo] = useState(""); const [filter, setFilter] = useState(""); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  async function load() {
    setLoading(true); setError("");
    try { const [workbench, measurementRows] = await Promise.all([apiGet<WorkbenchOrder[]>("/order-workbench/orders?page_size=200"), apiGet<Measurement[]>("/production-progress/measurements?page_size=200")]); setOrders(workbench.data); setMeasurements(measurementRows.data); if (selectedOrderNo && !workbench.data.some((order) => order.order_no === selectedOrderNo)) { setSelectedOrderNo(""); setSelectedOrder(null); } }
    catch (cause) { setError(messageOf(cause)); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function selectOrder(orderNo: string) { setSelectedOrderNo(orderNo); setError(""); try { const detail = await apiGet<WorkbenchOrder>(`/order-workbench/orders/${encodeURIComponent(orderNo)}`); setSelectedOrder(detail.data); } catch (cause) { setError(messageOf(cause)); } }
  const visibleOrders = useMemo(() => orders.filter((order) => `${order.order_no} ${order.overall_status_label} ${order.blockers.map((item) => item.label).join(" ")}`.toLowerCase().includes(filter.toLowerCase())), [filter, orders]);
  const selected = selectedOrder;
  const selectedMeasurements = measurements.filter((item) => item.order_no === selectedOrderNo);
  const moduleCards: Array<[string, ModuleSummary]> = selected ? [["采购 / 应付", selected.procurement_summary], ["原料库存", selected.raw_material_inventory_summary], ["生产", selected.production_summary], ["成品质检", selected.finished_goods_qc_summary], ["成品库存", selected.finished_goods_inventory_summary], ["发货", selected.shipping_summary], ["应收", selected.receivable_summary], ["应付", selected.payable_summary]] : [];
  return <>
    <PageHeader title="工作台" description="按订单号查看采购、库存、生产、质检、发货和财务推进状态"><Button variant="secondary" onClick={() => { void load(); }} title="刷新工作台"><RefreshCw size={15} />刷新</Button></PageHeader>
    {error && <section className="panel panel-body status-danger" role="alert">{error}</section>}
    {loading ? <LoadingState label="正在加载订单推进状态" /> : <>
      <section className="panel table-panel"><div className="panel-heading"><h2>订单全链路</h2><span className="panel-note">按 order_no 汇总，只读</span></div><div className="panel-body"><div className="filter-bar"><label htmlFor="workbench-order-filter">筛选订单<Input id="workbench-order-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="订单号、状态或阻塞原因" /></label></div><DataTable columns={[orderColumns.accessor("order_no", { header: "订单号" }), orderColumns.accessor("overall_status_label", { header: "总体状态", cell: (info) => <StatusBadge label={info.getValue()} tone={statusTone(info.row.original.overall_status)} /> }), orderColumns.accessor("sales_status", { header: "销售" }), orderColumns.display({ id: "blockers", header: "阻塞", cell: (info) => info.row.original.blockers.length }), orderColumns.accessor("updated_at", { header: "更新时间", cell: (info) => new Date(info.getValue()).toLocaleString("zh-CN") }), orderColumns.display({ id: "actions", header: "操作", cell: (info) => <Button variant="ghost" onClick={() => { void selectOrder(info.row.original.order_no); }}>查看详情</Button> })]} data={visibleOrders} empty={<EmptyState title="暂无订单" description="建立销售单后，这里会显示订单全链路状态。" />} /></div></section>
      {selected && <section className="progress-detail-grid"><section className="panel"><div className="panel-heading"><h2>{selected.order_no} · {selected.overall_status_label}</h2><span className="panel-note">销售状态：{selected.sales_status}</span></div><div className="panel-body"><div className="blocker-list">{selected.blockers.length ? selected.blockers.map((item) => <div className="status-danger progress-warning" key={item.code}><strong>{item.label}</strong><span>{item.suggestion}</span></div>) : <p className="panel-note">当前没有待处理阻塞。</p>}</div></div></section><section className="panel"><div className="panel-heading"><h2>模块状态</h2></div><div className="panel-body module-summary-grid">{moduleCards.map(([label, summary]) => <div className="module-summary-card" key={label}><strong>{label}</strong><StatusBadge label={summary.label} tone={statusTone(summary.status)} /><span>{summary.missing ? "尚未建立事实" : `${summary.counts.records} 条记录`}</span>{summary.amounts && <span>{summary.amounts.amount} {summary.amounts.currency}</span>}{summary.quantity_delta && <span>库存变动 {summary.quantity_delta}</span>}{summary.rejected_quantity && <span>不合格 {summary.rejected_quantity}</span>}</div>)}</div></section><section className="panel" style={{ gridColumn: "1 / -1" }}><div className="panel-heading"><h2>生产计量</h2><span className="panel-note">只读来源汇总</span></div><div className="panel-body"><DataTable columns={[measurementColumns.accessor("operation_name", { header: "工序/来源", cell: (info) => info.getValue() ?? (info.row.original.source_type === "outsource_direct_shipment" ? "外加工直装柜" : "外加工成品回厂") }), measurementColumns.accessor("actual_quantity", { header: "完成数量" }), measurementColumns.accessor("planned_quantity", { header: "计划数量" }), measurementColumns.accessor("difference_quantity", { header: "差额" }), measurementColumns.accessor("over_order_quantity", { header: "超单量" }), measurementColumns.accessor("unit", { header: "单位" }), measurementColumns.accessor("status", { header: "计量状态" })]} data={selectedMeasurements} empty={<EmptyState title="暂无计量来源" />} /></div></section></section>}
    </>}
  </>;
}

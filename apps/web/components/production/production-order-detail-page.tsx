"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "../layout/app-shell";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { DataTable } from "../data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { StatusBadge } from "../data/status-badge";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../lib/api-client";
import { useCollapsiblePanel } from "../../lib/collapsible-panel";
import { formatCompletionRate } from "../../lib/format-rate";
import { DailyReportsPanel } from "./daily-reports-panel";
import { FinishedGoodsPanel } from "./finished-goods-panel";
import { OutsourceLogisticsPanel } from "./outsource-logistics-panel";
import { MaterialIssuesPanel } from "./material-issues-panel";
import { notifyError, notifySuccess } from "../ui/toaster";

type Operation = { id: string; operationNameSnapshot: string; sequenceNo?: number; targetQuantity: string; status: string; operationCatalogId?: string; unitId?: string; unit?: { id?: string; name?: string } };
type Order = { id: string; productionOrderNo: string; orderNo: string; bomId?: string | null; bom?: { id: string } | null; executionMode: "in_house" | "outsourced"; status: string; plannedQuantity: string; unit?: { name?: string }; executionLocation?: { name?: string }; operations: Operation[] };
type OperationCatalogItem = { id: string; operationName: string; isActive: boolean };
type Unit = { id: string; name: string; isActive?: boolean };
type Measurement = { operation_id?: string; operation_name?: string; source_type?: string; unit?: string; planned_quantity?: string; actual_quantity?: string; difference_quantity?: string; over_order_quantity?: string; completion_rate?: string; status?: string };
type Progress = { status?: string; status_label?: string; blockers?: string[]; blocker_details?: Array<{ code?: string; label?: string; suggestion?: string }>; measurements?: Measurement[]; production_orders?: Array<Progress & { production_order_id?: string }> };

const statusLabel: Record<string, string> = { draft: "草稿", in_progress: "生产中", paused: "已暂停", completed: "已完成", closed: "已关闭" };
const transitions: Record<string, Array<{ target: string; label: string }>> = { draft: [{ target: "in_progress", label: "启动生产" }], in_progress: [{ target: "paused", label: "暂停生产" }, { target: "completed", label: "标记完工" }], paused: [{ target: "in_progress", label: "恢复生产" }], completed: [{ target: "closed", label: "关闭生产单" }, { target: "in_progress", label: "重新打开" }] };
const errorText = (cause: unknown) => cause instanceof ApiClientError ? cause.message : "操作失败";

export function ProductionOrderDetailPage({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<Order | null>(null); const [progress, setProgress] = useState<Progress | null>(null); const [operations, setOperations] = useState<Operation[]>([]); const [operationPool, setOperationPool] = useState<OperationCatalogItem[]>([]); const [unitPool, setUnitPool] = useState<Unit[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> } | null>(null);
  // 「工序与进度」可收纳：工序多的时候很占屏幕，收起后看下面的日报/成品更方便；选择记在本机。
  const operationsPanel = useCollapsiblePanel("production-order-operations");
  // options.silent：操作后/事件触发的后台刷新不切整页 loading —— 整页 loading 会卸载下面各面板
  // （日报、成品、领料），把用户正在填的内容一起清掉。
  async function load(options: { silent?: boolean } = {}) { if (!options.silent) setLoading(true); setError(""); try { const [orderResult, poolResult, unitsResult] = await Promise.all([apiGet<Order>(`/production/orders/${orderId}`), apiGet<OperationCatalogItem[]>("/production/operations").catch(() => ({ data: [] as OperationCatalogItem[], meta: {} })), apiGet<Unit[]>("/units").catch(() => ({ data: [] as Unit[], meta: {} }))]); const [measurements, summaries] = await Promise.all([apiGet<Measurement[]>(`/production-progress/measurements?production_order_id=${encodeURIComponent(orderId)}&page=1&page_size=200`), apiGet<Progress[]>(`/production-progress/order-statuses?order_no=${encodeURIComponent(orderResult.data.orderNo)}&page=1&page_size=200`)]); setOrder(orderResult.data); setOperations(orderResult.data.operations ?? []); setOperationPool(poolResult.data.filter((item) => item.isActive)); setUnitPool(unitsResult.data.filter((item) => item.isActive !== false)); const currentSummary = summaries.data.flatMap((summary) => summary.production_orders ?? []).find((item: { production_order_id?: string }) => item.production_order_id === orderId) ?? summaries.data[0]; setProgress({ ...(currentSummary ?? {}), measurements: measurements.data }); } catch (cause) { setError(errorText(cause)); } finally { if (!options.silent) setLoading(false); } }
  useEffect(() => { void load(); }, [orderId]);
  // Daily-report saves (and any other operation-affecting panel) dispatch this
  // event; the detail page reloads measurements so progress stays current.
  useEffect(() => { const refresh = () => void load({ silent: true }); window.addEventListener("production-order-operation-updated", refresh); return () => window.removeEventListener("production-order-operation-updated", refresh); }, [orderId]);
  function notifyOperationChanged() { window.dispatchEvent(new Event("production-order-operation-updated")); }
  async function run(path: string, body: unknown, success: string) { setError(""); try { await apiPost(path, body); notifySuccess(success); await load(); notifyOperationChanged(); } catch (cause) { notifyError(errorText(cause)); } }
  async function patch(path: string, body: unknown, success: string) { setError(""); try { await apiRequest(path, { method: "PATCH", body: JSON.stringify(body) }); notifySuccess(success); await load(); notifyOperationChanged(); } catch (cause) { notifyError(errorText(cause)); } }
  function openEditOperation(operation: Operation) {
    const inProgress = order?.status === "in_progress";
    const fields: ActionField[] = [
      { name: "target_quantity", label: "目标数量", type: "number", required: true, defaultValue: operation.targetQuantity },
      { name: "unit_id", label: "单位（单位池自选）", type: "select", required: true, defaultValue: operation.unitId ?? "", options: unitPool.map((item) => ({ value: item.id, label: item.name })) },
    ];
    if (inProgress) fields.push({ name: "reason", label: "修改原因", type: "textarea", required: true, placeholder: "生产中修改目标数量或单位必须填写原因" });
    setDialog({ title: `编辑工序：${operation.operationNameSnapshot}`, fields, submit: (values) => {
      void patch(`/production/orders/${orderId}/operations/${operation.id}`, { target_quantity: values.target_quantity, unit_id: values.unit_id, ...(inProgress ? { reason: values.reason } : {}) }, "工序已更新");
    } });
  }
  function openTransition(target: string, label: string) { setDialog({ title: label, fields: [{ name: "reason", label: "操作原因", type: "textarea", required: true, placeholder: "请填写本次状态变更原因" }], submit: (values) => void run(`/production/orders/${orderId}/transition`, { target, reason: values.reason }, `${label}成功`) }); }
  function openAddOperation() {
    const pool = operationPool;
    const attachedCatalogIds = new Set(operations.filter((item) => item.status !== "cancelled" && item.operationCatalogId).map((item) => item.operationCatalogId as string));
    const options = pool.map((item) => ({ value: item.id, label: item.operationName }));
    const disabledValues = pool.filter((item) => attachedCatalogIds.has(item.id)).map((item) => item.id);
    setDialog({ title: "添加生产工序", fields: [
      { name: "operation_ids", label: "选择工序（可多选）", type: "multi-checkbox", required: true, options, disabledValues, placeholder: "搜索工序名称" },
      { name: "target_quantity", label: "目标数量（应用到所有所选工序）", type: "number", required: true, defaultValue: order?.plannedQuantity },
    ], submit: (values) => {
      const selectedIds = new Set(values.operation_ids.split(",").filter(Boolean));
      // Submit in pool order: the server assigns sequence numbers automatically,
      // ordering carries no user intent.
      const selected = pool.filter((item) => selectedIds.has(item.id));
      void run(`/production/orders/${orderId}/operations/batch`, { operations: selected.map((item) => ({ operation_id: item.id, target_quantity: values.target_quantity })) }, selected.length > 1 ? `已添加 ${selected.length} 道工序` : "工序已添加");
    } });
  }
  const transitionActions = useMemo(() => order ? transitions[order.status] ?? [] : [], [order]);
  const columns = [{ accessorKey: "sequenceNo", header: "顺序" }, { accessorKey: "operationNameSnapshot", header: "工序" }, { accessorKey: "targetQuantity", header: "目标数量" }, { id: "unit", header: "单位", cell: ({ row }: { row: { original: Operation } }) => row.original.unit?.name ?? "-" }, { accessorKey: "status", header: "状态", cell: ({ row }: { row: { original: Operation } }) => statusLabel[row.original.status] ?? row.original.status }, { id: "actions", header: "操作", cell: ({ row }: { row: { original: Operation } }) => ["draft", "in_progress", "paused"].includes(order?.status ?? "") && row.original.status !== "cancelled" ? <Button size="sm" variant="secondary" onClick={() => openEditOperation(row.original)}>编辑</Button> : null }];
  if (loading) return <LoadingState label="正在加载生产单详情" />;
  if (error && !order) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!order) return <EmptyState title="生产单不存在" />;
  return <><PageHeader title={`生产单 ${order.productionOrderNo}`}><Button asChild variant="secondary"><Link href="/production">返回生产单列表</Link></Button><Button variant="secondary" onClick={() => void load()}>刷新</Button>{transitionActions.map((action) => <Button key={action.target} onClick={() => openTransition(action.target, action.label)}>{action.label}</Button>)}</PageHeader>{error && <section className="panel panel-body status-error">{error}</section>}<ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { dialog?.submit(values); setDialog(null); }} /><section className="panel"><div className="panel-heading"><h2>生产单概览</h2></div><div className="panel-body detail-list"><p>销售订单：{order.orderNo}</p><p>执行方式：{order.executionMode === "in_house" ? "厂内生产" : "外加工"}</p><p>执行地点：{order.executionLocation?.name ?? "-"}</p><p>计划数量：{order.plannedQuantity} {order.unit?.name ?? ""}</p><p>状态：<StatusBadge label={statusLabel[order.status] ?? order.status} tone={order.status === "completed" ? "success" : order.status === "paused" ? "warning" : "neutral"} /></p><p>进度：{progress?.status_label ?? progress?.status ?? "-"}</p></div>{progress?.blocker_details?.length ? <div className="panel-body status-error"><strong>当前阻塞</strong>{progress.blocker_details.map((item, index) => <p key={`${item.code ?? "blocker"}-${index}`}>{item.label ?? item.code}：{item.suggestion ?? "请处理后重试"}</p>)}</div> : null}</section><MaterialIssuesPanel productionOrderId={order.id} bomId={order.bomId ?? order.bom?.id ?? null} issuable={order.executionMode === "in_house" && order.status === "in_progress"} onChanged={() => void load()} /><section className="panel"><div className="panel-heading"><h2>工序与进度</h2><div className="page-actions"><Button variant="secondary" size="sm" aria-expanded={operationsPanel.open} title={operationsPanel.open ? "收起工序与进度" : "展开工序与进度"} onClick={operationsPanel.toggle}>{operationsPanel.open ? "收起" : "展开"}</Button><Button variant="secondary" onClick={openAddOperation}>添加工序</Button></div></div>{operationsPanel.open && <div className="panel-body"><DataTable columns={columns} data={operations} empty={<EmptyState title="暂无工序" />} />{progress?.measurements?.length ? <div className="table-wrap"><table className="ui-table"><thead><tr><th className="ui-table-head">工序/来源</th><th className="ui-table-head">计划</th><th className="ui-table-head">实际</th><th className="ui-table-head">差额</th><th className="ui-table-head">完成率</th></tr></thead><tbody>{progress.measurements.map((row, index) => <tr className="ui-table-row" key={`${row.operation_id ?? row.source_type ?? "measurement"}-${index}`}><td className="ui-table-cell">{row.operation_name ?? row.source_type ?? "-"}</td><td className="ui-table-cell">{row.planned_quantity ?? "-"}</td><td className="ui-table-cell">{row.actual_quantity ?? "-"}</td><td className="ui-table-cell">{row.difference_quantity ?? "-"}</td><td className="ui-table-cell">{formatCompletionRate(row.completion_rate)}</td></tr>)}</tbody></table></div> : null}</div>}</section><section className="panel"><div className="panel-heading"><h2>生产单下级详情</h2></div><div className="panel-body"><div className="page-actions"><Button asChild variant="secondary"><Link href={`/production/material-issues/new?production_order_id=${order.id}`}>新建领料单</Link></Button><Button asChild variant="secondary"><Link href={`/production/material-issues/new?type=replenishment&production_order_id=${order.id}`}>新建补料单</Link></Button><Button asChild variant="ghost"><Link href={`/production/material-issues?production_order_id=${order.id}`}>查看领料/补料单</Link></Button></div></div></section>{order.executionMode === "in_house" ? <DailyReportsPanel productionOrderId={order.id} /> : <OutsourceLogisticsPanel scope={{ orderNo: order.orderNo, productionOrderId: order.id }} />}<FinishedGoodsPanel productionOrderId={order.id} executionMode={order.executionMode} orderStatus={order.status} onChanged={() => void load()} /></>;
}

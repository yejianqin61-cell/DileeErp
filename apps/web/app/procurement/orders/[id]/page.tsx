"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageHeader } from "../../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../../components/ui/action-dialog";
import { Button } from "../../../../components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "../../../../components/feedback/states";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../../../lib/api-client";
import { notifyError, notifySuccess } from "../../../../components/ui/toaster";

type InspectionBatch = { id: string; status: string; inspectedQuantity: string; acceptedQuantity: string; conditionalQuantity: string; rejectedQuantity: string };
type InboundBatch = { id: string; inboundNo: string; quantity: string; status: string };
type Receipt = { id: string; receiptNo: string; quantity: string; status?: string; remark?: string | null; receivedDate?: string; batchSequence?: number; inspections?: InspectionBatch[]; rawMaterialInbounds?: InboundBatch[] };
type PurchaseItem = { id: string; materialId: string; unitId: string; supplierId?: string | null; expectedDate?: string | null; model?: string | null; quantity: string; material?: { materialCode?: string; name?: string }; unit?: { name?: string }; supplier?: { name?: string | null } | null; receipts: Receipt[]; batchWorkflows?: Array<{ receiptId: string; receiptNo: string; batchSequence: number; receivedQuantity: string; inspections: InspectionBatch[]; inbounds: InboundBatch[] }> };
type PurchaseOrder = { id: string; purchaseOrderNo: string; orderNo: string; status: string; currency: string | null; totalAmount: string; extensionData?: { arrival_closed?: boolean }; supplier?: { name: string } | null; items: PurchaseItem[] };
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const inspectionStatusLabel: Record<string, string> = { pending: "待质检", inspecting: "质检中", completed: "已登记", accepted: "全部入库", conditionally_accepted: "全部入库", partially_accepted: "部分入库", rejected: "拒收", cancelled: "已取消" };
const inboundStatusLabel: Record<string, string> = { draft: "草稿", posted: "已过账", reversed: "已冲销" };
const statusMap: Record<string, string> = { draft: "草稿", ordered: "已下单", partially_arrived: "部分到货", arrived_complete: "到货完成" };

export default function PurchaseOrderDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [order, setOrder] = useState<PurchaseOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);

  async function load() {
    setLoading(true); setError("");
    try { const r = await apiGet<PurchaseOrder>(`/purchase-orders/${id}`); setOrder(r.data); }
    catch (c) { setError(messageOf(c, "采购单详情加载失败")); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [id]);

  async function action(path: string, body?: unknown, success = "操作已完成", method: "POST" | "PATCH" = "POST") {
    setError("");
    try { if (method === "PATCH") await apiRequest(path, { method, body: JSON.stringify(body) }); else await apiPost(path, body); notifySuccess(success); await load(); }
    catch (c) { notifyError(messageOf(c, "操作失败")); }
  }

  function receive(item?: PurchaseItem) {
    if (!order) return;
    const t = item ?? order.items.find(c => Number(c.quantity) > c.receipts.reduce((s: number, r) => s + Number(r.quantity), 0)) ?? order.items[0];
    if (!t) return;
    setDialog({ title: `登记到货：${order.purchaseOrderNo} / ${t.material?.name ?? "物料"}（第 ${t.receipts.length + 1} 批）`, fields: [
      { name: "quantity", label: "本批到货数量", type: "number", required: true, defaultValue: "1" },
      { name: "reference_no", label: "到货参考号" }, { name: "over_receipt_reason", label: "超收原因" },
      { name: "remark", label: "备注", type: "textarea" }
    ], submit: v => void action(`/purchase-orders/${order.id}/items/${t.id}/receipts`, { quantity: v.quantity, received_date: new Date().toISOString(), reference_no: v.reference_no || undefined, over_receipt_reason: v.over_receipt_reason || undefined, idempotency_key: `web-receipt-${Date.now()}-${Math.random().toString(36).slice(2)}`, remark: v.remark || undefined }, "到货记录已登记") });
  }

  function editReceipt(r: Receipt) {
    setDialog({ title: `编辑到货批次：${r.receiptNo}`, fields: [
      { name: "quantity", label: "到货数量", type: "number", required: true, defaultValue: r.quantity },
      { name: "reference_no", label: "到货参考号" }, { name: "remark", label: "备注", type: "textarea", defaultValue: r.remark ?? undefined },
      { name: "reason", label: "修改原因", type: "textarea", required: true }
    ], submit: v => void action(`/purchase-orders/receipts/${r.id}`, { quantity: v.quantity, reference_no: v.reference_no || undefined, remark: v.remark || undefined, reason: v.reason }, "到货批次已更新", "PATCH") });
  }

  function cancelReceipt(r: Receipt) {
    setDialog({ title: `撤销到货批次：${r.receiptNo}`, fields: [{ name: "reason", label: "撤销原因", type: "textarea", required: true }], submit: v => void action(`/purchase-orders/receipts/${r.id}/cancel`, { reason: v.reason }, "到货批次已撤销") });
  }

  function rows(item: PurchaseItem) {
    return item.batchWorkflows ?? item.receipts.map((r, i) => ({ receiptId: r.id, receiptNo: r.receiptNo, batchSequence: r.batchSequence ?? i + 1, receivedQuantity: r.quantity, inspections: r.inspections ?? [], inbounds: r.rawMaterialInbounds ?? [] }));
  }

  if (loading) return <><PageHeader title="采购单详情" breadcrumb={["采购", "采购单", "详情"]} /><LoadingState /></>;
  if (error) return <><PageHeader title="采购单详情" breadcrumb={["采购", "采购单", "详情"]} /><ErrorState message={error} onRetry={() => void load()} /></>;
  if (!order) return <><PageHeader title="采购单详情" breadcrumb={["采购", "采购单", "详情"]} /><EmptyState title="采购单不存在" /></>;

  return <div className="page-root" data-testid="page-procurement-orders-detail">
    <PageHeader title="采购单详情" breadcrumb={["采购", "采购单", "详情"]}>
      <div className="page-actions"><Button variant="secondary" asChild><Link href="/procurement/orders">返回采购单列表</Link></Button><Button variant="secondary" onClick={() => void load()}>刷新</Button></div>
    </PageHeader>
    <ActionDialog open={Boolean(dialog)} onOpenChange={o => { if (!o) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={v => { dialog?.submit(v); setDialog(null); }} />
    {message && <section className="panel panel-body status-success" role="status">{message}</section>}
    <section className="panel">
      <div className="panel-heading"><h2>{order.purchaseOrderNo}</h2></div>
      <div className="panel-body">
        <div className="order-info-bar"><span className="header-chip">订单号 {order.orderNo}</span><span className="header-chip">供应商 {order.supplier?.name ?? "-"}</span><span className="header-chip">状态 {statusMap[order.status] ?? order.status}</span><span className="header-chip">金额 {order.totalAmount} {order.currency}</span></div>
        <div className="purchase-item-blocks">{order.items.map(item => {
          const rws = rows(item);
          const ml = `${item.material?.materialCode ?? ""} / ${item.material?.name ?? "物料"}${item.model ? ` / ${item.model}` : ""}`;
          const batches = rws.map(b => {
            const rc = item.receipts.find(c => c.id === b.receiptId);
            const insp = rc?.inspections?.[0];
            const canI = Boolean(rc) && rc!.status !== "cancelled" && (!insp || insp.status === "pending" || (insp.status === "partially_accepted" && !rc!.rawMaterialInbounds?.length));
            const canB = Boolean(insp) && ["accepted","conditionally_accepted","partially_accepted","completed"].includes(insp!.status);
            return <tr key={b.receiptId}><td className="cell-material" title={ml}>{ml}</td><td>第 {b.batchSequence} 批</td><td>{rc?.status === "cancelled" ? <span className="status-error">已撤销</span> : <>{b.receivedQuantity}{rc?.receivedDate ? <span className="batch-date"> · {rc.receivedDate.slice(0,10)}</span> : null}</>}</td><td>{insp ? <>{inspectionStatusLabel[insp.status] ?? insp.status}<div className="batch-badges"><span className="batch-badge-pass">{insp.acceptedQuantity} 合格</span><span className="batch-badge-cond">{insp.conditionalQuantity} 条件</span><span className="batch-badge-fail">{insp.rejectedQuantity} 不合格</span></div></> : <span className="batch-empty">待质检</span>}</td><td>{b.inbounds.length ? b.inbounds.map(r => `${r.quantity}（${inboundStatusLabel[r.status] ?? r.status}）`).join("、") : <span className="batch-empty">待入库</span>}</td><td><div className="action-row">{rc && rc.status !== "cancelled" && <><Button size="sm" variant="ghost" onClick={() => editReceipt(rc)}>编辑到货</Button><Button size="sm" variant="ghost" onClick={() => cancelReceipt(rc)}>撤销批次</Button></>}{canI && <Button size="sm" variant="secondary" asChild><Link href={`/qc/incoming?receipt_id=${rc!.id}`}>登记质检</Link></Button>}{canB && <Button size="sm" variant="ghost" asChild><Link href="/qc/inbound">去质检处理入库</Link></Button>}</div></td></tr>;
          });
          return <div key={item.id} className="purchase-item-block"><div className="purchase-item-block-header"><span className="header-chip header-chip-material" title={ml}>{ml}</span><span className="header-chip">采购数量 {item.quantity}{item.unit?.name ? ` ${item.unit.name}` : ""}</span><span className="header-chip">供应商 {item.supplier?.name ?? "-"}</span><span className="header-chip">预计到货 {item.expectedDate ? item.expectedDate.slice(0,10) : "-"}</span><Button size="sm" variant="secondary" onClick={() => receive(item)}>登记下一批到货</Button></div><div className="table-wrap"><table className="ui-table batch-table"><thead><tr><th className="ui-table-head">物料</th><th className="ui-table-head">批次</th><th className="ui-table-head">到货</th><th className="ui-table-head">质检</th><th className="ui-table-head">入库</th><th className="ui-table-head">操作</th></tr></thead><tbody>{batches.length ? batches : <tr><td className="cell-material" title={ml}>{ml}</td><td>-</td><td><span className="batch-empty">尚未登记</span></td><td><span className="batch-empty">-</span></td><td><span className="batch-empty">-</span></td><td><Button size="sm" variant="secondary" onClick={() => receive(item)}>登记到货</Button></td></tr>}</tbody></table></div></div>;
        })}</div>
      </div>
    </section>
  </div>;
}
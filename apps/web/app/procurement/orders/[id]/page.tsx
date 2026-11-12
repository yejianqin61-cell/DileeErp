"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageHeader } from "../../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../../components/ui/action-dialog";
import { Button } from "../../../../components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "../../../../components/feedback/states";
import { OrphanBadge } from "../../../../components/data/orphan-badge";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../../../lib/api-client";
import { notifyError, notifySuccess } from "../../../../components/ui/toaster";

type InspectionBatch = { id: string; status: string; inspectedQuantity: string; acceptedQuantity: string; conditionalQuantity: string; rejectedQuantity: string };
type InboundBatch = { id: string; inboundNo: string; quantity: string; status: string };
type Receipt = { id: string; receiptNo: string; quantity: string; status?: string; remark?: string | null; receivedDate?: string; batchSequence?: number; extensionData?: { over_receipt?: boolean; over_receipt_reason?: string | null } | null; inspections?: InspectionBatch[]; rawMaterialInbounds?: InboundBatch[] };
type PurchaseItem = { id: string; materialId: string; unitId: string; supplierId?: string | null; expectedDate?: string | null; model?: string | null; quantity: string; material?: { materialCode?: string; name?: string }; unit?: { name?: string }; supplier?: { name?: string | null } | null; receipts: Receipt[]; batchWorkflows?: Array<{ receiptId: string; receiptNo: string; batchSequence: number; receivedQuantity: string; inspections: InspectionBatch[]; inbounds: InboundBatch[] }> };
type PurchaseOrder = { id: string; purchaseOrderNo: string; orderNo: string; status: string; currency: string | null; totalAmount: string; extensionData?: { arrival_closed?: boolean }; /** 所属销售单已被软删（2026-11-03）：拓扑不变，只标成「孤立」。 */ orphaned?: boolean; supplier?: { name: string } | null; items: PurchaseItem[] };
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
      { name: "reference_no", label: "到货参考号" },
      // 供应商多送是常态：超收不再拦单，原因选填（填了原样保存，批次上会标「超收」）。
      { name: "over_receipt_reason", label: "超收原因（到货超过采购数量时填写，选填）" },
      { name: "remark", label: "备注", type: "textarea" }
    ], submit: v => void action(`/purchase-orders/${order.id}/items/${t.id}/receipts`, { quantity: v.quantity, received_date: new Date().toISOString(), reference_no: v.reference_no || undefined, over_receipt_reason: v.over_receipt_reason || undefined, idempotency_key: `web-receipt-${Date.now()}-${Math.random().toString(36).slice(2)}`, remark: v.remark || undefined }, "到货记录已登记") });
  }

  function editReceipt(r: Receipt) {
    setDialog({ title: `编辑到货批次：${r.receiptNo}`, fields: [
      { name: "quantity", label: "到货数量", type: "number", required: true, defaultValue: r.quantity },
      { name: "reference_no", label: "到货参考号" },
      // 到货登记后才发现实收更多时，靠这里把批次改大；后端允许超收，原因选填。
      { name: "over_receipt_reason", label: "超收原因（到货超过采购数量时填写，选填）", defaultValue: r.extensionData?.over_receipt_reason ?? undefined },
      { name: "remark", label: "备注", type: "textarea", defaultValue: r.remark ?? undefined },
      { name: "reason", label: "修改原因", type: "textarea", required: true }
    ], submit: v => void action(`/purchase-orders/receipts/${r.id}`, { quantity: v.quantity, reference_no: v.reference_no || undefined, over_receipt_reason: v.over_receipt_reason || undefined, remark: v.remark || undefined, reason: v.reason }, "到货批次已更新", "PATCH") });
  }

  function cancelReceipt(r: Receipt) {
    setDialog({ title: `撤销到货批次：${r.receiptNo}`, fields: [{ name: "reason", label: "撤销原因", type: "textarea", required: true }], submit: v => void action(`/purchase-orders/receipts/${r.id}/cancel`, { reason: v.reason }, "到货批次已撤销") });
  }

  /**
   * 行级退回（2026-11-12）：只把这一行退回采购计划，其余行与采购单号都不动。
   *
   * 用户原话：「下了采购单之后，如果需要临时修改BOM表的一些信息，需要整批采购单全部回退再修改，
   * 再下单。说明我们系统的拆分性，回溯性不够灵活。」
   *
   * 与列表页的「退回采购计划」是两个粒度、两个名字：那个退整张单（单号会变），
   * 这个只退一行（单号不变，重新收束时会并回同一张单）。
   *
   * 只在该行**零到货**时给入口（判据与服务端同一条线）：有到货的行按下去必然被拒，
   * 让用户点一次撞一次墙是最差的可发现性。
   */
  function revertLine(targetItem: PurchaseItem) {
    if (!order) return;
    setDialog({
      title: `退回这一行到采购计划：${targetItem.material?.name ?? "物料"}`,
      fields: [
        { name: "info", type: "info", label: "只退这一行：其余明细与采购单号都不动。退回去之后在这一批的计划里改数量/供应商，再收束下单会并回同一张采购单。" },
        { name: "reason", label: "退回原因", type: "textarea", required: true },
      ],
      submit: v => void action(`/purchase-orders/${order.id}/items/${targetItem.id}/revert-to-plan`, { reason: v.reason }, "这一行已退回采购计划"),
    });
  }

  /**
   * 这一行现在能不能退：零到货 + 单状态在「已下单/部分到货」。
   * 到货批次被撤销（`status === "cancelled"`）的不算到货事实 —— 与服务端按 `deleted_at IS NULL` 取到货的口径对齐。
   */
  function revertibleLine(targetItem: PurchaseItem) {
    if (!order) return false;
    if (!["ordered", "partially_arrived"].includes(order.status)) return false;
    return targetItem.receipts.filter(r => r.status !== "cancelled").length === 0;
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
    {/*
      孤立单据提示（2026-11-03）：详情页是「跟这张单」的入口，如果只看顶部的订单号，
      用户会以为这张采购单还挂在一张在途的销售单上。这里说明两件事：父单没了；
      但到货 / 质检 / 入库 / 付款这些流程**照旧可以继续办**（下游单据一行都没动）。
    */}
    {order.orphaned ? <section className="panel panel-body panel-note" role="status" data-testid="purchase-order-orphan-hint">
      <p>该采购单所属销售单 <strong>{order.orderNo}</strong> 已被删除，这张采购单原样保留为「孤立单据」。</p>
      <p>到货跟踪、质检与入库仍然可以继续办理；如需把销售单接回来，请找管理员处理（删除是软删，数据没有丢）。</p>
    </section> : null}
    <section className="panel">
      <div className="panel-heading"><h2>{order.purchaseOrderNo}</h2></div>
      <div className="panel-body">
        <div className="order-info-bar"><span className="header-chip">订单号 {order.orderNo}</span>{order.orphaned ? <OrphanBadge /> : null}<span className="header-chip">供应商 {order.supplier?.name ?? "-"}</span><span className="header-chip">状态 {statusMap[order.status] ?? order.status}</span><span className="header-chip">金额 {order.totalAmount} {order.currency}</span></div>
        <div className="purchase-item-blocks">{order.items.map(item => {
          const rws = rows(item);
          const ml = `${item.material?.materialCode ?? ""} / ${item.material?.name ?? "物料"}${item.model ? ` / ${item.model}` : ""}`;
          const batches = rws.map(b => {
            const rc = item.receipts.find(c => c.id === b.receiptId);
            const insp = rc?.inspections?.[0];
            const canI = Boolean(rc) && rc!.status !== "cancelled" && (!insp || insp.status === "pending" || (insp.status === "partially_accepted" && !rc!.rawMaterialInbounds?.length));
            const canB = Boolean(insp) && ["accepted","conditionally_accepted","partially_accepted","completed"].includes(insp!.status);
            return <tr key={b.receiptId}><td className="ui-table-cell cell-material cell-ellipsis" title={ml}>{ml}</td><td className="ui-table-cell cell-ellipsis" title={`第 ${b.batchSequence} 批`}>第 {b.batchSequence} 批</td><td className="ui-table-cell cell-ellipsis" title={`${b.receivedQuantity}${rc?.extensionData?.over_receipt ? `（超收${rc.extensionData.over_receipt_reason ? `：${rc.extensionData.over_receipt_reason}` : ""}）` : ""}${rc?.receivedDate ? ` · ${rc.receivedDate.slice(0,10)}` : ""}`}>{rc?.status === "cancelled" ? <span className="status-error">已撤销</span> : <>{b.receivedQuantity}{rc?.extensionData?.over_receipt ? <span className="status-warning"> · 超收</span> : null}{rc?.receivedDate ? <span className="batch-date"> · {rc.receivedDate.slice(0,10)}</span> : null}</>}</td><td className="ui-table-cell" style={{ whiteSpace: "normal" }}>{insp ? <>{inspectionStatusLabel[insp.status] ?? insp.status}<div className="batch-badges"><span className="batch-badge-pass">{insp.acceptedQuantity} 合格</span><span className="batch-badge-cond">{insp.conditionalQuantity} 条件</span><span className="batch-badge-fail">{insp.rejectedQuantity} 不合格</span></div></> : <span className="batch-empty">待质检</span>}</td><td className="ui-table-cell cell-ellipsis" title={b.inbounds.length ? b.inbounds.map(r => `${r.quantity}（${inboundStatusLabel[r.status] ?? r.status}）`).join("、") : "待入库"}>{b.inbounds.length ? b.inbounds.map(r => `${r.quantity}（${inboundStatusLabel[r.status] ?? r.status}）`).join("、") : <span className="batch-empty">待入库</span>}</td><td className="ui-table-cell"><div className="action-row">{rc && rc.status !== "cancelled" && <><Button size="sm" variant="ghost" onClick={() => editReceipt(rc)}>编辑到货</Button><Button size="sm" variant="ghost" onClick={() => cancelReceipt(rc)}>撤销批次</Button></>}{canI && <Button size="sm" variant="secondary" asChild><Link href={`/qc/incoming?receipt_id=${rc!.id}`}>登记质检</Link></Button>}{canB && <Button size="sm" variant="ghost" asChild><Link href="/qc/inbound">去质检处理入库</Link></Button>}</div></td></tr>;
          });
          {/* 到货批次小表（手写 `<table>`）：`.table-bounded` 拿到固定布局（见 globals.css），
              列宽总和 100%：物料 24% / 批次 10% / 到货 16% / 质检 20% / 入库 16% / 操作 14%。
              「物料」与「入库」是两串长度无界的中文（物料 = 编码/名称/型号；入库 = 多条「数量（状态）」拼接），
              它们拿大头并带省略号 + title；「质检」格里是三行徽章，用 `whiteSpace: normal` 让它换行而不是被裁。
              这些 <td> 原来大多没有 className，连 `.ui-table-cell` 的内边距都没有，同一次治理一并补上。 */}
          return <div key={item.id} className="purchase-item-block"><div className="purchase-item-block-header"><span className="header-chip header-chip-material" title={ml}>{ml}</span><span className="header-chip">采购数量 {item.quantity}{item.unit?.name ? ` ${item.unit.name}` : ""}</span><span className="header-chip">供应商 {item.supplier?.name ?? "-"}</span><span className="header-chip">预计到货 {item.expectedDate ? item.expectedDate.slice(0,10) : "-"}</span><Button size="sm" variant="secondary" onClick={() => receive(item)}>登记下一批到货</Button>{revertibleLine(item) ? <Button size="sm" variant="ghost" onClick={() => revertLine(item)}>退回这一行</Button> : null}</div><div className="table-wrap"><table className="ui-table batch-table table-bounded"><thead><tr><th className="ui-table-head cell-ellipsis" style={{ width: "24%" }} title="物料">物料</th><th className="ui-table-head cell-ellipsis" style={{ width: "10%" }} title="批次">批次</th><th className="ui-table-head cell-ellipsis" style={{ width: "16%" }} title="到货">到货</th><th className="ui-table-head cell-ellipsis" style={{ width: "20%" }} title="质检">质检</th><th className="ui-table-head cell-ellipsis" style={{ width: "16%" }} title="入库">入库</th><th className="ui-table-head cell-ellipsis" style={{ width: "14%" }} title="操作">操作</th></tr></thead><tbody>{batches.length ? batches : <tr><td className="ui-table-cell cell-material cell-ellipsis" title={ml}>{ml}</td><td className="ui-table-cell cell-ellipsis" title="-">-</td><td className="ui-table-cell"><span className="batch-empty">尚未登记</span></td><td className="ui-table-cell"><span className="batch-empty">-</span></td><td className="ui-table-cell"><span className="batch-empty">-</span></td><td className="ui-table-cell"><Button size="sm" variant="secondary" onClick={() => receive(item)}>登记到货</Button></td></tr>}</tbody></table></div></div>;
        })}</div>
      </div>
    </section>
  </div>;
}
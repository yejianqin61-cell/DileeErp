"use client";

// 生产模块 - 领料单 / 补料单
//
// 层级：订单号 → 生产单 → 单据。领料单与补料单都只绑定生产单（领料单一个生产单可有多张），
// 因此页面把三层作为列展示，并支持两种导出：
//   单张：每行「导出领料单」→ 一个工作表，与用户给定的模板一致；
//   批量：按当前筛选一次导出多张 → 每张领料单一个工作表。
// 导出接口与现有生产导出一致，仅管理员可用（非管理员会收到后端 403 提示）。

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { DataTable } from "../../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../../lib/api-client";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { downloadFile } from "../../../lib/download";
import { movementEditorHref, postMovementPath } from "../../../lib/material-slip-api";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";

type MovementLine = { id: string; materialId: string; quantity: string; unit?: { name: string }; material?: { materialCode?: string; name: string } };
type Issue = {
  id: string;
  movementNo: string;
  documentType: string;
  status: string;
  orderNo: string;
  productionOrderId: string;
  productionOrderOperationId?: string | null;
  productionOrder?: { productionOrderNo: string; orderNo: string } | null;
  productionOrderOperation?: { operationNameSnapshot: string } | null;
  businessDate?: string;
  createdAt: string;
  lines: MovementLine[];
};
type ProductionOrder = { id: string; productionOrderNo: string; orderNo: string; operations?: Array<{ id: string; operationNameSnapshot: string; status: string }> };

const statusLabels: Record<string, string> = { draft: "草稿", posted: "已过账", reversed: "已冲销" };
// 领料单与补料单都是挂在生产单下的原料出库单据，版式不同但层级一致。
const typeLabels: Record<string, string> = { issue: "领料单", replenishment: "补料单", return: "退料单", scrap: "报废单", reversal: "冲销单" };
const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const idempotencyKey = () => `web-movement-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export default function MaterialIssuesPage() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [orderNo, setOrderNo] = useState("");
  const [productionOrderId, setProductionOrderId] = useState("all");
  const [status, setStatus] = useState("all");
  const [documentType, setDocumentType] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> } | null>(null);

  // 草稿 → 出库：过账即扣减原料库存（服务端要求生产单为「生产中」的厂内单）。
  // 补料单走 post-replenishment：本页同时列出领料单与补料单，写死 /post 会让补料单过账 422。
  async function post(slip: Issue) {
    setBusy(slip.id);
    try { await apiPost(postMovementPath(slip.documentType, slip.id), { idempotency_key: idempotencyKey() }); notifySuccess(`${typeLabels[slip.documentType] ?? "单据"} 已过账出库`); await load(); onChanged(); }
    catch (cause) { notifyError(messageOf(cause, "过账失败")); }
    finally { setBusy(""); }
  }
  async function removeDraft(slip: Issue) {
    setBusy(slip.id);
    try { await apiRequest(`/production/material-movements/${slip.id}`, { method: "DELETE" }); notifySuccess("草稿已删除"); await load(); onChanged(); }
    catch (cause) { notifyError(messageOf(cause, "删除失败")); }
    finally { setBusy(""); }
  }
  function reopen(slip: Issue) { setDialog({ title: `重新打开：${slip.movementNo}`, fields: [{ name: "reason", label: "重新打开原因", type: "textarea", required: true }], submit: (values) => void act(`/production/material-movements/${slip.id}/reopen`, { reason: values.reason }, "已重新打开为草稿") }); }
  function reverse(slip: Issue) { setDialog({ title: `冲销：${slip.movementNo}`, fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }], submit: (values) => void act(`/production/material-movements/${slip.id}/reverse`, { reason: values.reason, idempotency_key: idempotencyKey() }, "已冲销") }); }
  async function act(path: string, body: unknown, success: string) {
    setBusy("action");
    try { await apiPost(path, body); notifySuccess(success); setDialog(null); await load(); onChanged(); }
    catch (cause) { notifyError(messageOf(cause, "操作失败")); }
    finally { setBusy(""); }
  }
  function onChanged() {
    // 领料出库会改变库存与生产进度：通知已打开该生产单的页面重新拉取。
    if (typeof window !== "undefined") window.dispatchEvent(new Event("dilee:material-movement-changed"));
  }

  async function load() {
    setLoading(true); setError("");
    try {
      const [movements, production] = await Promise.all([
        apiGet<Issue[]>("/production/material-movements"),
        apiGet<ProductionOrder[]>("/production/orders")
      ]);
      setIssues(movements.data.filter((item) => ["issue", "replenishment"].includes(item.documentType)));
      setOrders(production.data);
    } catch (cause) { setError(messageOf(cause, "领料单加载失败")); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    // 深链：生产单详情点「查看领料/补料单」带着 production_order_id 过来时直接按该生产单过滤。
    const target = new URLSearchParams(window.location.search).get("production_order_id");
    if (target) setProductionOrderId(target);
  }, []);

  const visible = useMemo(() => issues.filter((item) => {
    if (orderNo && !item.orderNo.toLowerCase().includes(orderNo.toLowerCase())) return false;
    if (productionOrderId !== "all" && item.productionOrderId !== productionOrderId) return false;
    if (status !== "all" && item.status !== status) return false;
    if (documentType !== "all" && item.documentType !== documentType) return false;
    const businessDate = (item.businessDate ?? item.createdAt ?? "").slice(0, 10);
    if (from && businessDate < from) return false;
    if (to && businessDate > to) return false;
    return true;
  }).sort((left, right) => `${left.orderNo}|${left.productionOrder?.productionOrderNo ?? ""}|${left.createdAt}`
    .localeCompare(`${right.orderNo}|${right.productionOrder?.productionOrderNo ?? ""}|${right.createdAt}`)), [issues, orderNo, productionOrderId, status, documentType, from, to]);

  // 导出参数与页面筛选完全一致，避免"看到的"和"导出的"不是同一批。
  function exportQuery() {
    const params = new URLSearchParams();
    if (documentType !== "all") params.set("document_type", documentType);
    if (orderNo) params.set("order_no", orderNo);
    if (productionOrderId !== "all") params.set("production_order_id", productionOrderId);
    if (status !== "all") params.set("status", status);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }
  // 单张导出：后端按单据类型自动套用领料单/补料单模板。
  async function exportOne(slip: Issue) {
    setBusy(slip.id);
    const label = typeLabels[slip.documentType] ?? "单据";
    try { await downloadFile(`/api/v1/production/reports/material-issue.xlsx?movement_id=${encodeURIComponent(slip.id)}`, `${label}-${slip.movementNo}.xlsx`); notifySuccess(`已导出 ${slip.movementNo}`); }
    catch (cause) { notifyError(messageOf(cause, "导出失败")); }
    finally { setBusy(""); }
  }
  async function exportAll() {
    if (!visible.length) { setError("当前筛选没有可导出的单据"); return; }
    setBusy("all");
    try { await downloadFile(`/api/v1/production/reports/material-slips.xlsx?${exportQuery()}`, "领料补料单汇总.xlsx"); notifySuccess(`已导出 ${visible.length} 张单据`); }
    catch (cause) { notifyError(messageOf(cause, "批量导出失败")); }
    finally { setBusy(""); }
  }

  const columns: ColumnDef<Issue>[] = [
    { accessorKey: "orderNo", header: "订单号" },
    { id: "productionOrder", header: "生产单号", cell: ({ row }) => row.original.productionOrder?.productionOrderNo ?? "-" },
    { id: "documentType", header: "类型", cell: ({ row }) => typeLabels[row.original.documentType] ?? row.original.documentType },
    { accessorKey: "movementNo", header: "单据号" },
    { id: "status", header: "状态", cell: ({ row }) => statusLabels[row.original.status] ?? row.original.status },
    { id: "lines", header: "物料明细", cell: ({ row }) => row.original.lines.map((line) => `${line.material?.name ?? line.materialId} × ${line.quantity}${line.unit?.name ?? ""}`).join("、") || "-" },
    { id: "total", header: "数量合计", cell: ({ row }) => row.original.lines.reduce((sum, line) => sum + Number(line.quantity), 0) },
    { accessorKey: "createdAt", header: "登记时间", cell: ({ row }) => new Date(row.original.createdAt).toLocaleString("zh-CN", { hour12: false }) },
    { id: "actions", header: "操作", cell: ({ row }) => { const slip = row.original; const busyRow = busy === slip.id; return <div className="page-actions"><Button size="sm" variant="secondary" disabled={busyRow} onClick={() => void exportOne(slip)}>{busyRow ? "导出中..." : "导出"}</Button>{slip.status === "draft" && <><Button size="sm" asChild variant="secondary"><Link href={movementEditorHref(slip.documentType, { movementId: slip.id })}>编辑</Link></Button><Button size="sm" disabled={busyRow} onClick={() => void post(slip)}>过账出库</Button><Button size="sm" variant="ghost" disabled={busyRow} onClick={() => void removeDraft(slip)}>删除</Button></>}{slip.status === "posted" && <><Button size="sm" variant="secondary" disabled={busy === "action"} onClick={() => reopen(slip)}>重新打开</Button><Button size="sm" variant="ghost" disabled={busy === "action"} onClick={() => reverse(slip)}>冲销</Button></>}<Button size="sm" asChild variant="ghost"><Link href={movementEditorHref("issue", { productionOrderId: slip.productionOrderId })} title="同一生产单可以开多张领料单">再建领料单</Link></Button><Button size="sm" asChild variant="ghost"><Link href={movementEditorHref("replenishment", { productionOrderId: slip.productionOrderId })} title="同一生产单可以开多张补料单">再建补料单</Link></Button></div>; } }
  ];

  if (loading) return <><PageHeader title="领料单 / 补料单" /><LoadingState /></>;

  return <div className="page-root" data-testid="page-production-material-issues">
    <PageHeader title="领料单 / 补料单" description="两者都只绑定生产单（一个生产单可有多张领料单）。点「新建领料单 / 新建补料单」进入全屏编辑页选择该生产单订单 BOM 里的物料；草稿可直接「过账出库」扣减原料库存（需生产单为生产中），已过账可重新打开或冲销；各自套用对应打印模板。">
      <Button asChild variant="secondary"><Link href="/production">返回生产单</Link></Button>
      <Button asChild><Link href={movementEditorHref("issue")}>新建领料单</Link></Button>
      <Button asChild variant="secondary"><Link href={movementEditorHref("replenishment")}>新建补料单</Link></Button>
      <Button onClick={() => void exportAll()} disabled={busy === "all" || !visible.length}>{busy === "all" ? "导出中..." : `批量导出（${visible.length} 张）`}</Button>
    </PageHeader>
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { void dialog?.submit(values); }} />
    <section className="panel">
      <div className="panel-heading"><h2>筛选</h2></div>
      <div className="panel-body"><div className="filter-bar">
        <label>订单号<Input value={orderNo} onChange={(event) => setOrderNo(event.target.value)} placeholder="输入订单号" /></label>
        <label>生产单<Select value={productionOrderId} onValueChange={setProductionOrderId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部生产单</SelectItem>{orders.map((order) => <SelectItem key={order.id} value={order.id}>{order.productionOrderNo} / {order.orderNo}</SelectItem>)}</SelectContent></Select></label>
        <label>类型<Select value={documentType} onValueChange={setDocumentType}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部类型</SelectItem><SelectItem value="issue">领料单</SelectItem><SelectItem value="replenishment">补料单</SelectItem></SelectContent></Select></label>
        <label>状态<Select value={status} onValueChange={setStatus}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="draft">草稿</SelectItem><SelectItem value="posted">已过账</SelectItem></SelectContent></Select></label>
        <label>起始日期<Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>结束日期<Input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      </div></div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>领料单 / 补料单</h2><span className="panel-note">共 {visible.length} 张（同一生产单可开多张领料单与补料单，行内「再建领料单/再建补料单」可直接续开）</span></div>
      <div className="panel-body"><DataTable columns={columns} data={visible} empty={<EmptyState title="暂无单据" description="点右上角「新建领料单 / 新建补料单」进入全屏编辑页创建；两者都只需要选择生产单，物料从该订单 BOM 明细中选。" />} /></div>
    </section>
  </div>;
}

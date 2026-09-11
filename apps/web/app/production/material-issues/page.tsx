"use client";

// 生产模块 - 领料单（按工序）
//
// 层级：订单号 → 生产单 → 工序 → 领料单。领料单必须归属到一个工序，
// 因此页面把四层都作为列展示，并支持两种导出：
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
import { ApiClientError, apiGet } from "../../../lib/api-client";
import { downloadFile } from "../../../lib/download";
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
const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

export default function MaterialIssuesPage() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [orderNo, setOrderNo] = useState("");
  const [productionOrderId, setProductionOrderId] = useState("all");
  const [operationId, setOperationId] = useState("all");
  const [status, setStatus] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  async function load() {
    setLoading(true); setError("");
    try {
      const [movements, production] = await Promise.all([
        apiGet<Issue[]>("/production/material-movements"),
        apiGet<ProductionOrder[]>("/production/orders")
      ]);
      setIssues(movements.data.filter((item) => item.documentType === "issue"));
      setOrders(production.data);
    } catch (cause) { setError(messageOf(cause, "领料单加载失败")); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const operationsOf = (id: string) => (orders.find((item) => item.id === id)?.operations ?? []).filter((operation) => operation.status !== "cancelled");
  const visible = useMemo(() => issues.filter((item) => {
    if (orderNo && !item.orderNo.toLowerCase().includes(orderNo.toLowerCase())) return false;
    if (productionOrderId !== "all" && item.productionOrderId !== productionOrderId) return false;
    if (operationId !== "all" && item.productionOrderOperationId !== operationId) return false;
    if (status !== "all" && item.status !== status) return false;
    const businessDate = (item.businessDate ?? item.createdAt ?? "").slice(0, 10);
    if (from && businessDate < from) return false;
    if (to && businessDate > to) return false;
    return true;
  }).sort((left, right) => `${left.orderNo}|${left.productionOrder?.productionOrderNo ?? ""}|${left.productionOrderOperation?.operationNameSnapshot ?? ""}|${left.createdAt}`
    .localeCompare(`${right.orderNo}|${right.productionOrder?.productionOrderNo ?? ""}|${right.productionOrderOperation?.operationNameSnapshot ?? ""}|${right.createdAt}`)), [issues, orderNo, productionOrderId, operationId, status, from, to]);

  // 导出参数与页面筛选完全一致，避免"看到的"和"导出的"不是同一批。
  function exportQuery() {
    const params = new URLSearchParams();
    if (orderNo) params.set("order_no", orderNo);
    if (productionOrderId !== "all") params.set("production_order_id", productionOrderId);
    if (operationId !== "all") params.set("production_order_operation_id", operationId);
    if (status !== "all") params.set("status", status);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }
  async function exportOne(issue: Issue) {
    setBusy(issue.id);
    try { await downloadFile(`/api/v1/production/reports/material-issue.xlsx?movement_id=${encodeURIComponent(issue.id)}`, `领料单-${issue.movementNo}.xlsx`); notifySuccess(`已导出 ${issue.movementNo}`); }
    catch (cause) { notifyError(messageOf(cause, "导出失败")); }
    finally { setBusy(""); }
  }
  async function exportAll() {
    if (!visible.length) { setError("当前筛选没有可导出的领料单"); return; }
    setBusy("all");
    try { await downloadFile(`/api/v1/production/reports/material-issues.xlsx?${exportQuery()}`, "领料单汇总.xlsx"); notifySuccess(`已导出 ${visible.length} 张领料单`); }
    catch (cause) { notifyError(messageOf(cause, "批量导出失败")); }
    finally { setBusy(""); }
  }

  const columns: ColumnDef<Issue>[] = [
    { accessorKey: "orderNo", header: "订单号" },
    { id: "productionOrder", header: "生产单号", cell: ({ row }) => row.original.productionOrder?.productionOrderNo ?? "-" },
    { id: "operation", header: "工序", cell: ({ row }) => row.original.productionOrderOperation?.operationNameSnapshot ?? <span className="status-warning">未指定工序</span> },
    { accessorKey: "movementNo", header: "领料单号" },
    { id: "status", header: "状态", cell: ({ row }) => statusLabels[row.original.status] ?? row.original.status },
    { id: "lines", header: "物料明细", cell: ({ row }) => row.original.lines.map((line) => `${line.material?.name ?? line.materialId} × ${line.quantity}${line.unit?.name ?? ""}`).join("、") || "-" },
    { id: "total", header: "本次领料合计", cell: ({ row }) => row.original.lines.reduce((sum, line) => sum + Number(line.quantity), 0) },
    { accessorKey: "createdAt", header: "登记时间", cell: ({ row }) => new Date(row.original.createdAt).toLocaleString("zh-CN", { hour12: false }) },
    { id: "actions", header: "操作", cell: ({ row }) => <Button size="sm" variant="secondary" disabled={busy === row.original.id} onClick={() => void exportOne(row.original)}>{busy === row.original.id ? "导出中..." : "导出领料单"}</Button> }
  ];

  if (loading) return <><PageHeader title="领料单" /><LoadingState /></>;

  return <>
    <PageHeader title="领料单" description="层级：订单号 → 生产单 → 工序 → 领料单。导出为打印用 Excel（仅管理员）。">
      <Button asChild variant="secondary"><Link href="/production">返回生产单</Link></Button>
      <Button onClick={() => void exportAll()} disabled={busy === "all" || !visible.length}>{busy === "all" ? "导出中..." : `批量导出（${visible.length} 张）`}</Button>
    </PageHeader>
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    <section className="panel">
      <div className="panel-heading"><h2>筛选</h2></div>
      <div className="panel-body"><div className="filter-bar">
        <label>订单号<Input value={orderNo} onChange={(event) => setOrderNo(event.target.value)} placeholder="输入订单号" /></label>
        <label>生产单<Select value={productionOrderId} onValueChange={(value) => { setProductionOrderId(value); setOperationId("all"); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部生产单</SelectItem>{orders.map((order) => <SelectItem key={order.id} value={order.id}>{order.productionOrderNo} / {order.orderNo}</SelectItem>)}</SelectContent></Select></label>
        <label>工序<Select value={operationId} onValueChange={setOperationId} disabled={productionOrderId === "all"}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部工序</SelectItem>{operationsOf(productionOrderId).map((operation) => <SelectItem key={operation.id} value={operation.id}>{operation.operationNameSnapshot}</SelectItem>)}</SelectContent></Select></label>
        <label>状态<Select value={status} onValueChange={setStatus}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="draft">草稿</SelectItem><SelectItem value="posted">已过账</SelectItem></SelectContent></Select></label>
        <label>起始日期<Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>结束日期<Input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      </div></div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>领料单（按工序）</h2><span className="panel-note">共 {visible.length} 张</span></div>
      <div className="panel-body"><DataTable columns={columns} data={visible} empty={<EmptyState title="暂无领料单" description="领料单在【仓库 → 原料出库（生产领料）】创建，创建时必须选择工序。" />} /></div>
    </section>
  </>;
}

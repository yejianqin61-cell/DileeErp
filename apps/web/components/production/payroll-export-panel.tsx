"use client";

import { useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

type Operation = { id: string; operationNameSnapshot?: string; operationName?: string };
type ProductionOrder = { id: string; orderNo: string; productionOrderNo: string; operations: Operation[] };

export function PayrollExportPanel({ orders, operations }: { orders: ProductionOrder[]; operations: Operation[] }) {
  const [open, setOpen] = useState<"operation" | "order" | null>(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [operationId, setOperationId] = useState("");
  const [orderNo, setOrderNo] = useState("");
  const [orderOperationId, setOrderOperationId] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedOrder = useMemo(() => orders.find((item) => item.orderNo === orderNo), [orders, orderNo]);
  const orderOperations = selectedOrder?.operations ?? [];
  async function download(path: string, fileName: string) {
    setBusy(true); setError("");
    try { const response = await fetch(`/api/v1${path}`, { credentials: "include", cache: "no-store" }); if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error?.message ?? `导出失败（HTTP ${response.status}）`); } const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement("a"); anchor.href = url; anchor.download = fileName; anchor.click(); URL.revokeObjectURL(url); setOpen(null); } catch (cause) { setError(cause instanceof Error ? cause.message : "导出失败"); } finally { setBusy(false); }
  }
  function exportOperation() { if (!operationId || !/^\d{4}-\d{2}$/.test(month)) { setError("请选择工序并填写有效月份"); return; } void download(`/production/reports/operation-payroll.xlsx?operation_id=${encodeURIComponent(operationId)}&month=${encodeURIComponent(month)}`, "迪礼ERP-工序盘点表.xlsx"); }
  function exportOrder() { if (!orderNo) { setError("请选择订单号"); return; } const query = new URLSearchParams({ order_no: orderNo }); if (orderOperationId !== "all") query.set("operation_id", orderOperationId); void download(`/production/reports/order-operation-payroll.xlsx?${query.toString()}`, "迪礼ERP-订单号盘点表.xlsx"); }
  return <section className="panel"><div className="panel-heading"><h2>生产工序导出表</h2><div className="page-actions"><Button variant="secondary" onClick={() => { setError(""); setOpen("operation"); }}>工序盘点表</Button><Button variant="secondary" onClick={() => { setError(""); setOpen("order"); }}>订单号盘点表</Button></div></div>{error && <p className="status-error panel-body" role="alert">{error}</p>}<Dialog open={open === "operation"} onOpenChange={(value) => { if (!value && !busy) setOpen(null); }}><DialogContent><DialogHeader><DialogTitle>导出工序盘点表</DialogTitle><DialogDescription>按月份盘点所选工序的全部有效工序员工日报，不区分订单号。</DialogDescription></DialogHeader><DialogBody><label>月份<Input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label><label>工序<Select value={operationId} onValueChange={setOperationId}><SelectTrigger><SelectValue placeholder="请选择工序" /></SelectTrigger><SelectContent>{operations.map((item) => <SelectItem key={item.id} value={item.id}>{item.operationName ?? item.operationNameSnapshot}</SelectItem>)}</SelectContent></Select></label></DialogBody><DialogFooter><Button variant="secondary" onClick={() => setOpen(null)} disabled={busy}>取消</Button><Button onClick={exportOperation} disabled={busy}>{busy ? "导出中..." : "导出 XLSX"}</Button></DialogFooter></DialogContent></Dialog><Dialog open={open === "order"} onOpenChange={(value) => { if (!value && !busy) setOpen(null); }}><DialogContent><DialogHeader><DialogTitle>导出订单号盘点表</DialogTitle><DialogDescription>按订单号盘点员工日报；不选择工序时导出该订单号下全部工序。</DialogDescription></DialogHeader><DialogBody><label>订单号<Select value={orderNo} onValueChange={(value) => { setOrderNo(value); setOrderOperationId("all"); }}><SelectTrigger><SelectValue placeholder="请选择订单号" /></SelectTrigger><SelectContent>{orders.map((item) => <SelectItem key={item.id} value={item.orderNo}>{item.orderNo} / {item.productionOrderNo}</SelectItem>)}</SelectContent></Select></label><label>工序（可选）<Select value={orderOperationId} onValueChange={setOrderOperationId}><SelectTrigger><SelectValue placeholder="全部工序" /></SelectTrigger><SelectContent><SelectItem value="all">全部工序</SelectItem>{orderOperations.map((item) => <SelectItem key={item.id} value={item.id}>{item.operationNameSnapshot ?? item.operationName}</SelectItem>)}</SelectContent></Select></label></DialogBody><DialogFooter><Button variant="secondary" onClick={() => setOpen(null)} disabled={busy}>取消</Button><Button onClick={exportOrder} disabled={busy}>{busy ? "导出中..." : "导出 XLSX"}</Button></DialogFooter></DialogContent></Dialog></section>;
}

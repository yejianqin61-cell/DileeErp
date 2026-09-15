"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { notifyError } from "../ui/toaster";
import { ProgressColumnOrderEditor } from "./progress-column-order-editor";
import { isDefaultColumnOrder, parseStoredColumnOrder, progressColumnOrderKey, serializeColumnOrder } from "../../lib/progress-column-order";

type Operation = { id: string; operationNameSnapshot?: string; operationName?: string };
type ProductionOrder = { id: string; orderNo: string; productionOrderNo: string; operations: Operation[] };

export function PayrollExportPanel({ orders, operations }: { orders: ProductionOrder[]; operations: Operation[] }) {
  const [open, setOpen] = useState<"operation" | "order" | "monthly" | "material" | "progress" | null>(null);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [operationId, setOperationId] = useState("");
  const [orderNo, setOrderNo] = useState("");
  const [orderOperationId, setOrderOperationId] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedOrder = useMemo(() => orders.find((item) => item.orderNo === orderNo), [orders, orderNo]);
  const orderOperations = selectedOrder?.operations ?? [];
  // 生产进度表的工序列顺序：用户在弹窗里拖出来的顺序。按订单号记在本机（与面板折叠状态同一套做法），
  // 免得每次导出都重拖一遍；顺序本身**不写回生产工序**（那是车间实际生产顺序）。
  const [progressOrder, setProgressOrder] = useState<string[]>([]);
  const progressColumns = useMemo(() => orderOperations.map((item) => ({ id: item.id, name: item.operationName ?? item.operationNameSnapshot ?? "" })), [orderOperations]);
  useEffect(() => {
    if (open !== "progress" || !orderNo) { setProgressOrder([]); return; }
    if (typeof window === "undefined") return;
    setProgressOrder(parseStoredColumnOrder(window.localStorage.getItem(progressColumnOrderKey(orderNo))));
  }, [open, orderNo]);
  function changeProgressOrder(ids: string[]) {
    setProgressOrder(ids);
    if (typeof window === "undefined" || !orderNo) return;
    try {
      if (ids.length) window.localStorage.setItem(progressColumnOrderKey(orderNo), serializeColumnOrder(ids));
      else window.localStorage.removeItem(progressColumnOrderKey(orderNo));
    } catch { /* 隐私模式下写不了，忽略即可（顺序本次导出仍然生效） */ }
  }
  async function download(path: string, fileName: string) {
    setBusy(true); setError("");
    try { const response = await fetch(`/api/v1${path}`, { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(120000) }); if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error?.message ?? `导出失败（HTTP ${response.status}）`); } const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement("a"); anchor.href = url; anchor.download = fileName; anchor.click(); URL.revokeObjectURL(url); setOpen(null); } catch (cause) { notifyError(cause instanceof DOMException && cause.name === "TimeoutError" ? "导出超时，请缩小范围后重试" : cause instanceof Error ? cause.message : "导出失败"); } finally { setBusy(false); }
  }
  function exportOperation() { if (!operationId || !/^\d{4}-\d{2}$/.test(month)) { setError("请选择工序并填写有效月份"); return; } void download(`/production/reports/operation-payroll.xlsx?operation_id=${encodeURIComponent(operationId)}&month=${encodeURIComponent(month)}`, "迪礼ERP-工序盘点表.xlsx"); }
  function exportOrder() { if (!orderNo) { setError("请选择订单号"); return; } const query = new URLSearchParams({ order_no: orderNo }); if (orderOperationId !== "all") query.set("operation_id", orderOperationId); void download(`/production/reports/order-operation-payroll.xlsx?${query.toString()}`, "迪礼ERP-订单号盘点表.xlsx"); }
  function exportMonthly() { if (!/^\d{4}-\d{2}$/.test(month)) { setError("请填写有效月份"); return; } void download(`/production/reports/monthly-operations-payroll.xlsx?month=${encodeURIComponent(month)}`, "迪礼ERP-当月工序明细总表.xlsx"); }
  // 拆表：上表=原料对应表，下表=生产进度表，各自独立导出（旧的合并导出接口保留但不再从这里调用）。
  function exportMaterial() { if (!orderNo) { setError("请选择订单号"); return; } void download(`/production/reports/material-reference.xlsx?order_no=${encodeURIComponent(orderNo)}`, "迪礼ERP-原料对应表.xlsx"); }
  function exportProgress() { if (!orderNo) { setError("请选择订单号"); return; } const query = new URLSearchParams({ order_no: orderNo }); if (!isDefaultColumnOrder(progressColumns, progressOrder)) query.set("operation_order", progressOrder.join(",")); void download(`/production/reports/production-progress.xlsx?${query.toString()}`, "迪礼ERP-生产进度表.xlsx"); }
  return <section className="panel"><div className="panel-heading"><h2>生产工序导出表</h2><div className="page-actions"><Button variant="secondary" onClick={() => { setError(""); setOpen("operation"); }}>工序盘点表</Button><Button variant="secondary" onClick={() => { setError(""); setOpen("order"); }}>订单号盘点表</Button><Button variant="secondary" onClick={() => { setError(""); setOpen("monthly"); }}>当月工序明细总表</Button><Button variant="secondary" onClick={() => { setError(""); setOpen("material"); }}>原料对应表</Button><Button variant="secondary" onClick={() => { setError(""); setOpen("progress"); }}>生产进度表</Button></div></div>{error && <p className="status-error panel-body" role="alert">{error}</p>}<Dialog open={open === "operation"} onOpenChange={(value) => { if (!value && !busy) setOpen(null); }}><DialogContent><DialogHeader><DialogTitle>导出工序盘点表</DialogTitle><DialogDescription>按月份盘点所选工序的全部有效工序员工日报，不区分订单号。</DialogDescription></DialogHeader><DialogBody><label>月份<Input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label><label>工序<Select value={operationId} onValueChange={setOperationId}><SelectTrigger><SelectValue placeholder="请选择工序" /></SelectTrigger><SelectContent>{operations.map((item) => <SelectItem key={item.id} value={item.id}>{item.operationName ?? item.operationNameSnapshot}</SelectItem>)}</SelectContent></Select></label></DialogBody><DialogFooter><Button variant="secondary" onClick={() => setOpen(null)} disabled={busy}>取消</Button><Button onClick={exportOperation} disabled={busy}>{busy ? "导出中..." : "导出 XLSX"}</Button></DialogFooter></DialogContent></Dialog><Dialog open={open === "order"} onOpenChange={(value) => { if (!value && !busy) setOpen(null); }}><DialogContent><DialogHeader><DialogTitle>导出订单号盘点表</DialogTitle><DialogDescription>按订单号盘点员工日报；不选择工序时导出该订单号下全部工序。</DialogDescription></DialogHeader><DialogBody><label>订单号<Select value={orderNo} onValueChange={(value) => { setOrderNo(value); setOrderOperationId("all"); }}><SelectTrigger><SelectValue placeholder="请选择订单号" /></SelectTrigger><SelectContent>{orders.map((item) => <SelectItem key={item.id} value={item.orderNo}>{item.orderNo} / {item.productionOrderNo}</SelectItem>)}</SelectContent></Select></label><label>工序（可选）<Select value={orderOperationId} onValueChange={setOrderOperationId}><SelectTrigger><SelectValue placeholder="全部工序" /></SelectTrigger><SelectContent><SelectItem value="all">全部工序</SelectItem>{orderOperations.map((item) => <SelectItem key={item.id} value={item.id}>{item.operationNameSnapshot ?? item.operationName}</SelectItem>)}</SelectContent></Select></label></DialogBody><DialogFooter><Button variant="secondary" onClick={() => setOpen(null)} disabled={busy}>取消</Button><Button onClick={exportOrder} disabled={busy}>{busy ? "导出中..." : "导出 XLSX"}</Button></DialogFooter></DialogContent></Dialog><Dialog open={open === "monthly"} onOpenChange={(value) => { if (!value && !busy) setOpen(null); }}><DialogContent><DialogHeader><DialogTitle>导出当月工序明细总表</DialogTitle><DialogDescription>按生产日期划分当月，导出所有订单、所有工序的有效员工日报明细，并附各工序汇总。</DialogDescription></DialogHeader><DialogBody><label>月份<Input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label></DialogBody><DialogFooter><Button variant="secondary" onClick={() => setOpen(null)} disabled={busy}>取消</Button><Button onClick={exportMonthly} disabled={busy}>{busy ? "导出中..." : "导出 XLSX"}</Button></DialogFooter></DialogContent></Dialog><Dialog open={open === "material"} onOpenChange={(value) => { if (!value && !busy) setOpen(null); }}><DialogContent><DialogHeader><DialogTitle>导出原料对应表</DialogTitle><DialogDescription>该订单号的采购单明细（原「材料与车间生产对应表」的上表，现已拆成独立表）。</DialogDescription></DialogHeader><DialogBody><label>订单号<Select value={orderNo} onValueChange={setOrderNo}><SelectTrigger><SelectValue placeholder="请选择订单号" /></SelectTrigger><SelectContent>{orders.map((item) => <SelectItem key={item.id} value={item.orderNo}>{item.orderNo} / {item.productionOrderNo}</SelectItem>)}</SelectContent></Select></label></DialogBody><DialogFooter><Button variant="secondary" onClick={() => setOpen(null)} disabled={busy}>取消</Button><Button onClick={exportMaterial} disabled={busy}>{busy ? "导出中..." : "导出 XLSX"}</Button></DialogFooter></DialogContent></Dialog><Dialog open={open === "progress"} onOpenChange={(value) => { if (!value && !busy) setOpen(null); }}><DialogContent><DialogHeader><DialogTitle>导出生产进度表</DialogTitle><DialogDescription>各工序按生产日期的产量二维进度表（每列一个生产日期，含汇总与出货）。</DialogDescription></DialogHeader><DialogBody><label>订单号<Select value={orderNo} onValueChange={setOrderNo}><SelectTrigger><SelectValue placeholder="请选择订单号" /></SelectTrigger><SelectContent>{orders.map((item) => <SelectItem key={item.id} value={item.orderNo}>{item.orderNo} / {item.productionOrderNo}</SelectItem>)}</SelectContent></Select></label><ProgressColumnOrderEditor operations={progressColumns} order={progressOrder} onChange={changeProgressOrder} /></DialogBody><DialogFooter><Button variant="secondary" onClick={() => setOpen(null)} disabled={busy}>取消</Button><Button onClick={exportProgress} disabled={busy}>{busy ? "导出中..." : "导出 XLSX"}</Button></DialogFooter></DialogContent></Dialog></section>;
}

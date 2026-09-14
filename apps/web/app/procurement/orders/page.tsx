"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { Trash2 } from "lucide-react";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../../components/ui/sheet";
import { DataTable } from "../../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../../lib/api-client";
import { BomWorkbench } from "../../../components/bom/bom-workbench";
import { currencyOptionsWithCurrent, fetchCurrencyOptions, type CurrencyOption } from "../../../lib/currency-catalogue";
import { downloadFile } from "../../../lib/download";
import { shouldRefreshOnVisibility } from "../../../lib/refresh-policy";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";

type InspectionBatch = { id: string; status: string; qcResult?: string | null; inspectedQuantity: string; acceptedQuantity: string; conditionalQuantity: string; rejectedQuantity: string };
type InboundBatch = { id: string; inboundNo: string; quantity: string; status: string };
type Receipt = { id: string; receiptNo: string; quantity: string; status?: string; remark?: string | null; receivedDate?: string; batchSequence?: number; inspections?: InspectionBatch[]; rawMaterialInbounds?: InboundBatch[] };
type PurchaseItem = { id: string; materialId: string; unitId: string; bomItemId?: string | null; supplierId?: string | null; expectedDate?: string | null; model?: string | null; quantity: string; unitPrice?: string; material?: { materialCode?: string; name?: string }; unit?: { name?: string }; supplier?: { name?: string | null } | null; receipts: Receipt[]; batchWorkflows?: Array<{ receiptId: string; receiptNo: string; batchSequence: number; receivedQuantity: string; inspections: InspectionBatch[]; inbounds: InboundBatch[] }> };
type PurchaseOrder = { id: string; purchaseOrderNo: string; orderNo: string; bomId: string | null; supplierId: string | null; purchaseDate?: string | null; expectedDate?: string | null; status: string; currency: string | null; totalAmount: string; extensionData?: { arrival_closed?: boolean; over_order?: boolean }; supplier?: { name: string } | null; items: PurchaseItem[] };
type Reference = { id: string; name?: string; orderNo?: string; materialCode?: string; supplierCode?: string; code?: string; isActive?: boolean; defaultUnitId?: string; salesOrderId?: string; status?: string; specificationModel?: string | null; color?: string | null };
type BomItem = { id?: string; materialId: string; materialName: string; model?: string | null; specificationModel?: string | null; color?: string | null; requiredQuantity: string; unit: string; unitId?: string | null; materialSnapshot: Record<string, unknown> };
type Bom = { id: string; orderNo: string; salesOrderId: string; status: string; version: number; items: BomItem[] };
type PurchaseDraftItem = { materialId: string; model: string; quantity: string; unitId: string; unitPrice: string; supplierId: string; expectedDate: string; bomItemId?: string; currentStock?: string };
type PurchaseDraft = { id?: string; orderNo: string; bomId: string; currency: string; importBomItems: boolean; items: PurchaseDraftItem[] };
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const inspectionStatusLabel: Record<string, string> = { pending: "待质检", inspecting: "质检中", completed: "已登记", accepted: "全部入库", conditionally_accepted: "全部入库", partially_accepted: "部分入库", rejected: "拒收", cancelled: "已取消" };
const inboundStatusLabel: Record<string, string> = { draft: "草稿", posted: "已过账", reversed: "已冲销" };

export default function PurchaseOrdersPage() {
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [materials, setMaterials] = useState<Reference[]>([]);
  const [units, setUnits] = useState<Reference[]>([]);
  const [suppliers, setSuppliers] = useState<Reference[]>([]);
  const [boms, setBoms] = useState<Reference[]>([]);
  const [salesOrders, setSalesOrders] = useState<Reference[]>([]);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [purchaseDraft, setPurchaseDraft] = useState<PurchaseDraft | null>(null);
  const [stockByMaterial, setStockByMaterial] = useState<Record<string, string>>({});
  const [selectedDraftRows, setSelectedDraftRows] = useState<number[]>([]);
  const [bomWorkbench, setBomWorkbench] = useState<{ id: string; label?: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [currencyCatalogue, setCurrencyCatalogue] = useState<CurrencyOption[]>([]);
  const [exportBusy, setExportBusy] = useState("");

  async function load(options: { silent?: boolean } = {}) {
    if (!options.silent) setLoading(true);
    setError("");
    try {
      const [po, ms, us, ss, bs, so] = await Promise.all([
        apiGet<PurchaseOrder[]>("/purchase-orders"),
        apiGet<Reference[]>("/materials"),
        apiGet<Reference[]>("/units"),
        apiGet<Reference[]>("/suppliers"),
        apiGet<Reference[]>("/boms"),
        apiGet<Reference[]>("/sales-orders"),
      ]);
      setOrders(po.data); setMaterials(ms.data); setUnits(us.data);
      setSuppliers(ss.data); setBoms(bs.data); setSalesOrders(so.data);
    } catch (cause) { setError(messageOf(cause, "采购单数据加载失败")); }
    finally { if (!options.silent) setLoading(false); }
  }

  useEffect(() => { let cancelled = false; void fetchCurrencyOptions().then((opts) => { if (!cancelled) setCurrencyCatalogue(opts); }); return () => { cancelled = true; }; }, []);
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const refresh = () => { if (shouldRefreshOnVisibility(document.visibilityState)) void load({ silent: true }); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);

  const visible = useMemo(() => orders.filter((item) => {
    if (query && !`${item.purchaseOrderNo} ${item.orderNo} ${item.status}`.toLowerCase().includes(query.toLowerCase())) return false;
    if (statusFilter === "all") return true;
    const totals = item.items.reduce((s, i) => { s.planned += Number(i.quantity); s.received += i.receipts.reduce((sum, r) => sum + Number(r.quantity), 0); return s; }, { planned: 0, received: 0 });
    if (statusFilter === "over") return totals.received > totals.planned;
    if (statusFilter === "complete") return totals.received === totals.planned && totals.planned > 0 && item.status !== "draft";
    return item.status === statusFilter;
  }), [orders, query, statusFilter]);

  const activeMaterials = useMemo(() => materials.filter((item) => item.isActive !== false), [materials]);
  const materialOptions = activeMaterials.map((item) => ({ value: item.id, label: `${item.materialCode ?? item.code ?? ""} / ${item.name ?? "物料"}` }));
  const unitOptions = units.filter((item) => item.isActive !== false).map((item) => ({ value: item.id, label: item.name ?? item.id }));
  const supplierOptions = suppliers.filter((item) => item.isActive !== false).map((item) => ({ value: item.id, label: `${item.supplierCode ?? item.code ?? ""} / ${item.name ?? "供应商"}` }));

  async function action(path: string, body?: unknown, success = "操作已完成", method: "POST" | "PATCH" = "POST") {
    setError("");
    try {
      if (method === "PATCH") await apiRequest(path, { method, body: JSON.stringify(body) });
      else await apiPost(path, body);
      notifySuccess(success);
      await load();
    } catch (cause) { notifyError(messageOf(cause, "操作失败")); }
  }

  async function exportPurchaseOrder(order: PurchaseOrder) {
    setExportBusy(order.id);
    try { await downloadFile(`/api/v1/procurement/reports/purchase-order.xlsx?purchase_order_id=${encodeURIComponent(order.id)}`, `采购订单-${order.purchaseOrderNo}.xlsx`); notifySuccess(`已导出 ${order.purchaseOrderNo}`); }
    catch (cause) { notifyError(messageOf(cause, "导出失败")); }
    finally { setExportBusy(""); }
  }

  async function exportPurchaseOrders() {
    if (!visible.length) { setError("当前筛选没有可导出的采购单"); return; }
    setExportBusy("all");
    try {
      const params = new URLSearchParams();
      if (query) params.set("order_no", query);
      await downloadFile(`/api/v1/procurement/reports/purchase-orders.xlsx${params.toString() ? `?${params.toString()}` : ""}`, "采购订单汇总.xlsx");
      notifySuccess(`已导出 ${visible.length} 张采购订单`);
    } catch (cause) { notifyError(messageOf(cause, "批量导出失败")); }
    finally { setExportBusy(""); }
  }

  function createPurchaseOrder() {
    setSelectedDraftRows([]);
    setPurchaseDraft({ orderNo: "", bomId: "", currency: currencyCatalogue.some((o) => o.value === "CNY") ? "CNY" : (currencyCatalogue[0]?.value ?? "CNY"), importBomItems: true, items: [] });
    void refreshMaterialStock(materials.map((item) => item.id));
  }

  function stockFor(materialId: string, unitId: string) { return stockByMaterial[`${materialId}|${unitId}`] ?? "0"; }
  function addPurchaseItem() { const material = materials.find((item) => item.isActive !== false); const unitId = material?.defaultUnitId ?? ""; setPurchaseDraft((draft) => draft ? { ...draft, items: [...draft.items, { materialId: material?.id ?? "", model: "", quantity: "1", unitId, unitPrice: "0", supplierId: "", expectedDate: "", currentStock: stockFor(material?.id ?? "", unitId) }] } : draft); }
  function updatePurchaseItem(index: number, patch: Partial<PurchaseDraftItem>) { setPurchaseDraft((draft) => draft ? { ...draft, items: draft.items.map((item, i) => i === index ? { ...item, ...patch } : item) } : draft); }
  function toggleDraftRow(index: number) { setSelectedDraftRows((rows) => rows.includes(index) ? rows.filter((r) => r !== index) : [...rows, index]); }
  function toggleAllDraftRows(checked: boolean) { setSelectedDraftRows(checked && purchaseDraft ? purchaseDraft.items.map((_, i) => i) : []); }
  function removeSelectedDraftRows() {
    if (!selectedDraftRows.length) { setError("请先勾选要移除的采购明细行"); return; }
    setPurchaseDraft((draft) => draft ? { ...draft, importBomItems: false, items: draft.items.filter((_, i) => !selectedDraftRows.includes(i)) } : draft);
    setSelectedDraftRows([]);
    notifySuccess(`已从采购单草稿移除 ${selectedDraftRows.length} 行（BOM 表未改动）`);
  }

  const draftGroups = useMemo(() => {
    if (!purchaseDraft) return [] as Array<{ supplierId: string; supplierName: string; items: PurchaseDraftItem[]; amount: number }>;
    const map = new Map<string, { supplierId: string; supplierName: string; items: PurchaseDraftItem[]; amount: number }>();
    for (const item of purchaseDraft.items) {
      const key = item.supplierId || "";
      const group = map.get(key) ?? { supplierId: key, supplierName: suppliers.find((s) => s.id === key)?.name ?? "未选择供应商", items: [], amount: 0 };
      group.items.push(item);
      group.amount += Number(item.quantity || 0) * Number(item.unitPrice || 0);
      map.set(key, group);
    }
    return [...map.values()];
  }, [purchaseDraft, suppliers]);

  function splitPayload(placeOrder: boolean) {
    if (!purchaseDraft) return null;
    const groups = draftGroups.filter((g) => g.supplierId);
    return { order_no: purchaseDraft.orderNo, bom_id: purchaseDraft.bomId || undefined, purchase_date: new Date().toISOString(), currency: purchaseDraft.currency, place_order: placeOrder, extension_data: { split_by_supplier: true }, groups: groups.map((g) => ({ supplier_id: g.supplierId, currency: purchaseDraft.currency, expected_date: g.items.find((item) => item.expectedDate)?.expectedDate ? new Date(g.items.find((item) => item.expectedDate)!.expectedDate).toISOString() : undefined, items: g.items.map((item) => ({ material_id: item.materialId, model: item.model || undefined, unit_id: item.unitId, bom_item_id: item.bomItemId, supplier_id: g.supplierId, expected_date: item.expectedDate ? new Date(item.expectedDate).toISOString() : undefined, quantity: item.quantity, unit_price: item.unitPrice })) })) };
  }

  function validateDraftForOrder() {
    if (!purchaseDraft) return false;
    if (!purchaseDraft.orderNo) { setError("请先选择销售单"); return false; }
    const incomplete = purchaseDraft.items.findIndex((item) => !item.materialId || !item.unitId || !item.quantity || item.unitPrice === "" || !item.supplierId);
    if (incomplete >= 0) { setError(`第 ${incomplete + 1} 行明细请补齐物料/单位/数量/单价/供应商`); return false; }
    if (!purchaseDraft.items.length) { setError("下单前请至少添加一行明细"); return false; }
    const missingDate = purchaseDraft.items.findIndex((item) => !item.expectedDate);
    if (missingDate >= 0) { setError(`第 ${missingDate + 1} 行明细请填写预计到货日期`); return false; }
    return true;
  }

  async function splitPurchaseOrder(placeOrder: boolean) {
    if (!purchaseDraft) return;
    if (purchaseDraft.id) { setError("已保存的采购单不能再拆分；请新建采购单后按供应商拆分下单"); return; }
    if (!validateDraftForOrder()) return;
    if (!purchaseDraft.bomId) { setError("下单前请选择 BOM 表"); return; }
    const groups = draftGroups.filter((g) => g.supplierId);
    const unassigned = purchaseDraft.items.length - groups.reduce((sum, g) => sum + g.items.length, 0);
    if (unassigned > 0 || !groups.length) { setError("拆分下单要求每一行明细都已选择供应商"); return; }
    const payload = splitPayload(placeOrder);
    if (!payload) return;
    setError("");
    try {
      const result = await apiPost<PurchaseOrder[]>("/purchase-orders/split", payload);
      const created = result.data ?? [];
      notifySuccess(`${placeOrder ? "已按供应商拆分下单" : "已按供应商拆分保存草稿"}：${created.length} 张采购单（${created.map((o) => o?.purchaseOrderNo).filter(Boolean).join("、")}）`);
      setPurchaseDraft(null); setSelectedDraftRows([]); await load();
    } catch (cause) { setError(messageOf(cause, placeOrder ? "按供应商拆分下单失败" : "按供应商拆分保存草稿失败")); }
  }

  function changePurchaseMaterial(index: number, materialId: string) { const material = materials.find((item) => item.id === materialId); updatePurchaseItem(index, { materialId, unitId: material?.defaultUnitId ?? "" }); }

  async function importBomItems(bomId: string) {
    const bom = await apiGet<Bom>(`/boms/${bomId}`);
    const stock = await apiGet<Array<{ material_id: string; unit_id: string; quantity: string }>>(`/inventory/raw-material-balances?material_ids=${bom.data.items.map((item) => item.materialId).join(",")}`);
    const stockMap = stock.data.reduce<Record<string, string>>((acc, item) => { acc[`${item.material_id}|${item.unit_id}`] = item.quantity; acc[item.material_id] = (Number(acc[item.material_id] ?? 0) + Number(item.quantity)).toString(); return acc; }, {});
    setStockByMaterial((current) => ({ ...current, ...stockMap }));
    setSelectedDraftRows([]);
    setPurchaseDraft((draft) => draft ? { ...draft, items: bom.data.items.map((item) => { const unitId = item.unitId ?? units.find((u) => u.name === item.unit)?.id ?? ""; return { materialId: item.materialId, model: item.model || item.specificationModel || "", quantity: item.requiredQuantity, unitId, unitPrice: "0", supplierId: "", expectedDate: "", bomItemId: item.id, currentStock: stockMap[`${item.materialId}|${unitId}`] ?? "0" }; }) } : draft);
  }

  async function selectPurchaseBom(bomId: string) { setPurchaseDraft((draft) => draft ? { ...draft, bomId } : draft); if (purchaseDraft?.importBomItems && bomId) { try { await importBomItems(bomId); } catch (cause) { notifyError(messageOf(cause, "BOM表明细带入失败")); } } }

  async function toggleBomImport(enabled: boolean) { setPurchaseDraft((draft) => draft ? { ...draft, importBomItems: enabled, items: enabled ? draft.items : [] } : draft); if (enabled && purchaseDraft?.bomId) { try { await importBomItems(purchaseDraft.bomId); } catch (cause) { notifyError(messageOf(cause, "BOM表明细带入失败")); } } }

  async function editPurchaseOrder(id: string) {
    setError("");
    try {
      const result = await apiGet<PurchaseOrder>(`/purchase-orders/${id}`);
      const order = result.data;
      setSelectedDraftRows([]);
      setPurchaseDraft({ id: order.id, orderNo: order.orderNo, bomId: order.bomId ?? "", currency: order.currency ?? "CNY", importBomItems: false, items: order.items.map((item) => ({ materialId: item.materialId, model: item.model ?? "", quantity: item.quantity, unitId: item.unitId, unitPrice: item.unitPrice ?? "0", supplierId: item.supplierId ?? order.supplierId ?? "", expectedDate: item.expectedDate?.slice(0, 10) ?? order.expectedDate?.slice(0, 10) ?? "", bomItemId: item.bomItemId ?? undefined })) });
    } catch (cause) { setError(messageOf(cause, "采购单加载失败")); }
  }

  async function savePurchaseOrder(mode: "draft" | "order" = "draft") {
    if (!purchaseDraft) return;
    if (!purchaseDraft.orderNo) { setError("请先选择销售单"); return; }
    const incomplete = purchaseDraft.items.findIndex((item) => !item.materialId || !item.unitId || !item.quantity || item.unitPrice === "" || !item.supplierId);
    if (incomplete >= 0) { setError(`第 ${incomplete + 1} 行明细请补齐物料/单位/数量/单价/供应商`); return; }
    if (mode === "order") {
      if (!purchaseDraft.bomId) { setError("下单前请选择 BOM 表"); return; }
      if (!purchaseDraft.items.length) { setError("下单前请至少添加一行明细"); return; }
      const missingDate = purchaseDraft.items.findIndex((item) => !item.expectedDate);
      if (missingDate >= 0) { setError(`第 ${missingDate + 1} 行明细请填写预计到货日期`); return; }
    }
    setError("");
    try {
      const payload = { order_no: purchaseDraft.orderNo, bom_id: purchaseDraft.bomId || undefined, purchase_date: new Date().toISOString(), currency: purchaseDraft.currency, items: purchaseDraft.items.map((item) => ({ material_id: item.materialId, model: item.model || undefined, unit_id: item.unitId, bom_item_id: item.bomItemId, supplier_id: item.supplierId, expected_date: item.expectedDate ? new Date(item.expectedDate).toISOString() : undefined, quantity: item.quantity, unit_price: item.unitPrice })) };
      const saved = purchaseDraft.id ? await apiRequest<PurchaseOrder>(`/purchase-orders/${purchaseDraft.id}`, { method: "PATCH", body: JSON.stringify(payload) }) : await apiPost<PurchaseOrder>("/purchase-orders", payload);
      if (mode === "order") {
        const savedId = saved.data?.id ?? purchaseDraft.id;
        if (!savedId) throw new Error("采购单保存后未返回单号，无法下单");
        await apiPost(`/purchase-orders/${savedId}/order`, {});
      }
      setPurchaseDraft(null); setSelectedDraftRows([]);
      notifySuccess(mode === "order" ? "采购单已下单" : purchaseDraft.id ? "采购草稿已更新" : "采购草稿已创建");
      await load();
    } catch (cause) { setError(messageOf(cause, mode === "order" ? "采购单下单失败" : purchaseDraft.id ? "采购草稿更新失败" : "采购草稿创建失败")); }
  }

  async function refreshMaterialStock(ids: string[]) { if (!ids.length) return; try { const result = await apiGet<Array<{ material_id: string; unit_id: string; quantity: string }>>(`/inventory/raw-material-balances?material_ids=${ids.join(",")}`); const stock = result.data.reduce<Record<string, string>>((acc, item) => { const key = `${item.material_id}|${item.unit_id}`; acc[key] = item.quantity; acc[item.material_id] = (Number(acc[item.material_id] ?? 0) + Number(item.quantity)).toString(); return acc; }, {}); setStockByMaterial(stock); } catch { /* inventory access is optional */ } }

  function revertPurchaseOrder(order: PurchaseOrder) { setDialog({ title: `采购单回退草稿：${order.purchaseOrderNo}`, fields: [{ name: "reason", label: "回退原因", required: true, type: "textarea" }], submit: (v) => void action(`/purchase-orders/${order.id}/revert-draft`, { reason: v.reason }, "采购单已回到草稿") }); }

  function openBom(id: string, label?: string) { setError(""); setBomWorkbench({ id, label }); }

  const statusMap: Record<string, string> = { draft: "草稿", ordered: "已下单", partially_arrived: "部分到货", arrived_complete: "到货完成" };

  const orderColumns: ColumnDef<PurchaseOrder>[] = [
    { accessorKey: "purchaseOrderNo", header: "采购单号" },
    { id: "orderNo", header: "订单号", cell: ({ row }) => <Button variant="link" asChild><Link href={`/procurement/orders/${row.original.id}`}>{row.original.orderNo}</Link></Button> },
    { id: "supplier", header: "供应商", cell: ({ row }) => row.original.supplier?.name ?? "-" },
    { id: "status", header: "状态", cell: ({ row }) => { const totals = row.original.items.reduce((s, i) => { s.planned += Number(i.quantity); s.received += i.receipts.reduce((sum, r) => sum + Number(r.quantity), 0); return s; }, { planned: 0, received: 0 }); return totals.received > totals.planned ? <span className="status-error">超单</span> : totals.received === totals.planned && totals.planned > 0 ? <span className="status-success">到货完成</span> : <span className="status-label">{statusMap[row.original.status] ?? row.original.status}</span>; } },
    { id: "amount", header: "金额", cell: ({ row }) => `${row.original.totalAmount} ${row.original.currency}` },
    { id: "actions", header: "操作", cell: ({ row }) => { const complete = row.original.items.length > 0 && row.original.items.every((item) => item.receipts.reduce((sum, r) => sum + Number(r.quantity), 0) >= Number(item.quantity)); const closed = row.original.extensionData?.arrival_closed; const isDraft = row.original.status === "draft"; const isOrdered = row.original.status === "ordered"; const noReceipts = row.original.items.every((item) => item.receipts.length === 0); const canReceive = ["ordered", "partially_arrived", "arrived_complete"].includes(row.original.status) && !closed; return <div className="action-row">{isDraft && <><Button size="sm" variant="secondary" onClick={() => void editPurchaseOrder(row.original.id)}>编辑</Button><Button size="sm" onClick={() => void action(`/purchase-orders/${row.original.id}/order`, undefined, "采购单已下单")}>下单</Button></>}{isOrdered && noReceipts && <Button size="sm" variant="ghost" onClick={() => revertPurchaseOrder(row.original)}>回到草稿</Button>}{canReceive && <Button size="sm" variant="secondary" asChild><Link href={`/procurement/orders/${row.original.id}`}>到货跟踪</Link></Button>}{complete && !closed && <Button size="sm" variant="secondary" onClick={() => void action(`/purchase-orders/${row.original.id}/close-arrivals`, undefined, "到货已关闭，批次已进入来料质检")}>关闭到货</Button>}{closed && <span className="status-label status-success">已关闭</span>}</div>; } },
  ];

  if (loading) return <><PageHeader title="采购单" breadcrumb={["采购", "采购单"]} /><LoadingState /></>;
  if (bomWorkbench) return <><PageHeader title="采购单" breadcrumb={["采购", "采购单"]} /><BomWorkbench bomId={bomWorkbench.id} title={bomWorkbench.label} materials={materials} units={units} onCreateMaterial={() => {}} onClose={() => setBomWorkbench(null)} onSaved={() => void load()} /></>;

  return (
    <div className="page-root" data-testid="page-procurement-orders">
      <PageHeader title="采购单" breadcrumb={["采购", "采购单"]}>
        <div className="page-actions">
          <Button onClick={createPurchaseOrder}>新建采购单</Button>
          <Button variant="secondary" onClick={() => void load()}>刷新</Button>
        </div>
      </PageHeader>
      <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />
      {message && <section className="panel panel-body status-success" role="status">{message}</section>}
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}

      <section className="panel">
        <div className="panel-heading">
          <h2>采购单列表</h2>
          <div className="page-actions">
            <Button size="sm" variant="secondary" disabled={exportBusy === "all" || !visible.length} onClick={() => void exportPurchaseOrders()}>{exportBusy === "all" ? "导出中..." : `批量导出（${visible.length} 张）`}</Button>
          </div>
        </div>
        <div className="panel-body">
          <div className="filter-bar">
            <label>按订单号搜索<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入订单号" /></label>
          </div>
          <div className="filter-tabs">
            {[{ value: "all", label: "全部" }, { value: "draft", label: "草稿" }, { value: "ordered", label: "已下单" }, { value: "arrived", label: "已到货" }, { value: "over", label: "超单" }, { value: "complete", label: "已完成" }].map((tab) => <Button key={tab.value} size="sm" variant={statusFilter === tab.value ? "secondary" : "ghost"} data-active={statusFilter === tab.value} onClick={() => setStatusFilter(tab.value)}>{tab.label}</Button>)}
            <span className="panel-note">{visible.length} / {orders.length} 张采购单</span>
          </div>
          <DataTable columns={orderColumns} data={visible} empty={<EmptyState title={statusFilter === "all" && !query ? "暂无采购单" : "没有匹配的采购单"} description={statusFilter !== "all" || query ? "换个筛选条件试试。" : undefined} />} />
        </div>
      </section>

      <Sheet open={Boolean(purchaseDraft)} onOpenChange={(open) => { if (!open) setPurchaseDraft(null); }}>
        <SheetContent className="material-issue-sheet purchase-workspace">
          <SheetHeader>
            <SheetTitle>{purchaseDraft?.id ? "编辑采购单" : "新建采购单"}</SheetTitle>
            <SheetDescription>可先保存草稿：选定销售单即可，BOM 表与预计到货日期可稍后补；下单前必须补齐 BOM 与每行明细。</SheetDescription>
          </SheetHeader>
          {purchaseDraft && (
            <div className="detail-list">
              <label>销售单<Select value={purchaseDraft.orderNo || undefined} onValueChange={(value) => setPurchaseDraft({ ...purchaseDraft, orderNo: value, bomId: "", items: [] })}><SelectTrigger><SelectValue placeholder="请选择销售单" /></SelectTrigger><SelectContent>{salesOrders.filter((item) => item.status === "confirmed").map((item) => <SelectItem key={item.id} value={item.orderNo ?? item.id}>{item.orderNo ?? item.id}</SelectItem>)}</SelectContent></Select></label>
              <label>BOM表<Select value={purchaseDraft.bomId || undefined} disabled={!purchaseDraft.orderNo} onValueChange={(value) => void selectPurchaseBom(value)}><SelectTrigger><SelectValue placeholder="请选择BOM表" /></SelectTrigger><SelectContent>{boms.filter((item) => item.orderNo === purchaseDraft.orderNo).map((item) => <SelectItem key={item.id} value={item.id}>{item.orderNo}</SelectItem>)}</SelectContent></Select></label>
              <label>币种<Select value={purchaseDraft.currency || undefined} onValueChange={(value) => setPurchaseDraft({ ...purchaseDraft, currency: value })}><SelectTrigger><SelectValue placeholder="请选择币种" /></SelectTrigger><SelectContent>{currencyOptionsWithCurrent(currencyCatalogue, purchaseDraft.currency).map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}</SelectContent></Select></label>
              <label><Button type="button" aria-label="带入 BOM表明细" variant={purchaseDraft.importBomItems ? "secondary" : "ghost"} aria-pressed={purchaseDraft.importBomItems} onClick={() => void toggleBomImport(!purchaseDraft.importBomItems)}>带入 BOM表明细：{purchaseDraft.importBomItems ? "是" : "否"}</Button></label>
              <div className="page-actions">
                <Button size="sm" variant="secondary" onClick={addPurchaseItem}>添加行</Button>
                <Button size="sm" variant="destructive" disabled={!selectedDraftRows.length} onClick={removeSelectedDraftRows}>{selectedDraftRows.length ? `移除选中 ${selectedDraftRows.length} 行` : "移除选中行"}</Button>
                <Button size="sm" variant="secondary" onClick={() => void savePurchaseOrder("draft")}>保存草稿</Button>
                <Button size="sm" onClick={() => void savePurchaseOrder("order")}>下单</Button>
              </div>
              {draftGroups.length > 1 && (
                <div className="panel panel-body" data-testid="purchase-split-preview">
                  <p className="panel-note">按供应商分组（同供应商合并成一张采购单，共 {draftGroups.length} 张）：</p>
                  <ul className="draft-split-list">{draftGroups.map((g) => <li key={g.supplierId || "unassigned"}>{(g.supplierName || "未选择供应商")} · {g.items.length} 行 · 金额合计 {g.amount.toFixed(2)} {purchaseDraft.currency}</li>)}</ul>
                  <div className="page-actions">
                    <Button size="sm" variant="secondary" onClick={() => void splitPurchaseOrder(false)}>按供应商拆分保存 {draftGroups.length} 张草稿</Button>
                    <Button size="sm" onClick={() => void splitPurchaseOrder(true)}>按供应商拆分下单（{draftGroups.length} 张）</Button>
                  </div>
                </div>
              )}
              <div className="table-wrap"><table className="data-table"><thead><tr><th className="draft-select-cell"><input type="checkbox" aria-label="全选采购明细" checked={purchaseDraft.items.length > 0 && selectedDraftRows.length === purchaseDraft.items.length} onChange={(event) => toggleAllDraftRows(event.target.checked)} /></th><th>名称</th><th>型号</th><th>需求量</th><th>当前库存量</th><th>单位</th><th>单价</th><th>供应商</th><th>预计到货</th><th className="sr-only">操作</th></tr></thead><tbody>{purchaseDraft.items.map((item, index) => <tr key={`${item.materialId}-${index}`}><td className="draft-select-cell"><input type="checkbox" aria-label={`选择第 ${index + 1} 行采购明细`} checked={selectedDraftRows.includes(index)} onChange={() => toggleDraftRow(index)} /></td><td><Select value={item.materialId || undefined} onValueChange={(value) => changePurchaseMaterial(index, value)}><SelectTrigger><SelectValue placeholder="请选择物料" /></SelectTrigger><SelectContent>{materialOptions.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}</SelectContent></Select></td><td><Input value={item.model} onChange={(event) => updatePurchaseItem(index, { model: event.target.value })} /></td><td><Input type="number" min="0" step="0.0001" value={item.quantity} onChange={(event) => updatePurchaseItem(index, { quantity: event.target.value })} /></td><td className={Number(stockByMaterial[item.materialId] ?? 0) >= Number(item.quantity) ? "stock-ok" : "stock-low"}>{stockByMaterial[item.materialId] ?? "0"}</td><td><Select value={item.unitId || undefined} onValueChange={(value) => updatePurchaseItem(index, { unitId: value })}><SelectTrigger><SelectValue placeholder="请选择单位" /></SelectTrigger><SelectContent>{unitOptions.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}</SelectContent></Select></td><td><Input type="number" min="0" step="0.0001" value={item.unitPrice} onChange={(event) => updatePurchaseItem(index, { unitPrice: event.target.value })} /></td><td><Select value={item.supplierId || undefined} onValueChange={(value) => updatePurchaseItem(index, { supplierId: value })}><SelectTrigger><SelectValue placeholder="请选择供应商" /></SelectTrigger><SelectContent>{supplierOptions.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}</SelectContent></Select></td><td><Input type="date" value={item.expectedDate} onChange={(event) => updatePurchaseItem(index, { expectedDate: event.target.value })} aria-label="预计到货日期" /></td><td><Button size="icon" variant="ghost" title="删除行" aria-label="删除行" onClick={() => setPurchaseDraft({ ...purchaseDraft, items: purchaseDraft.items.filter((_, i) => i !== index) })}><Trash2 size={16} /></Button></td></tr>)}</tbody></table></div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
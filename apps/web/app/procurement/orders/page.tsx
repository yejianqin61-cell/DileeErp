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
import { BomWorkbench, type BomMaterialRef } from "../../../components/bom/bom-workbench";
import { MaterialCreateDialog } from "../../../components/bom/material-create-dialog";
import { currencyOptionsWithCurrent, fetchCurrencyOptions, type CurrencyOption } from "../../../lib/currency-catalogue";
import { downloadFile } from "../../../lib/download";
import { auditColumns, type AuditRow } from "../../../components/data/audit-columns";
import { paymentTermOptions, printFieldsDefaults, printFieldsPayload } from "../../../lib/purchase-order-print";
import { shouldRefreshOnVisibility } from "../../../lib/refresh-policy";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";

type InspectionBatch = { id: string; status: string; qcResult?: string | null; inspectedQuantity: string; acceptedQuantity: string; conditionalQuantity: string; rejectedQuantity: string };
type InboundBatch = { id: string; inboundNo: string; quantity: string; status: string };
type Receipt = { id: string; receiptNo: string; quantity: string; status?: string; remark?: string | null; receivedDate?: string; batchSequence?: number; inspections?: InspectionBatch[]; rawMaterialInbounds?: InboundBatch[] };
type PurchaseItem = { id: string; materialId: string; unitId: string; bomItemId?: string | null; supplierId?: string | null; expectedDate?: string | null; model?: string | null; quantity: string; unitPrice?: string; extensionData?: { outside_bom_reason?: string } | null; material?: { materialCode?: string; name?: string }; unit?: { name?: string }; supplier?: { name?: string | null } | null; receipts: Receipt[]; batchWorkflows?: Array<{ receiptId: string; receiptNo: string; batchSequence: number; receivedQuantity: string; inspections: InspectionBatch[]; inbounds: InboundBatch[] }> };
type PurchaseOrder = AuditRow & {
  id: string; purchaseOrderNo: string; orderNo: string; bomId: string | null; supplierId: string | null;
  purchaseDate?: string | null; expectedDate?: string | null; status: string; currency: string | null; totalAmount: string;
  extensionData?: { arrival_closed?: boolean; over_order?: boolean };
  /** 打印信息（2026-09-16）：付款方式 / 交期条款 / 交货地址 / 厂家回签意见 / 厂家回签 / 主管签字 */
  paymentTerms?: string | null; deliveryTerms?: string | null; deliveryAddress?: string | null;
  supplierReply?: string | null; supplierSigned?: string | null; supervisorSignature?: string | null; remark?: string | null;
  supplier?: { name: string } | null; items: PurchaseItem[];
};
type Reference = { id: string; name?: string; orderNo?: string; materialCode?: string; supplierCode?: string; code?: string; isActive?: boolean; defaultUnitId?: string; salesOrderId?: string; status?: string; specificationModel?: string | null; color?: string | null };
type BomItem = { id?: string; materialId: string; materialName: string; model?: string | null; specificationModel?: string | null; color?: string | null; requiredQuantity: string; unit: string; unitId?: string | null; materialSnapshot: Record<string, unknown> };
type Bom = { id: string; orderNo: string; salesOrderId: string; status: string; version: number; items: BomItem[] };
/**
 * 一行 BOM 明细的累计下单情况（`GET /purchase-orders/bom-item-status`）。
 *
 * 四态来自后端：`ordered` 已下单足量 / `partial` 部分下单 / `draft` 草稿中 / `none` 未下单。
 * 草稿**不算**已下单，但要单独标出来 —— 已经有草稿覆盖的行同样不该再开一张。
 */
type BomItemOrderStatus = { bom_item_id: string; required_quantity: string; ordered_quantity: string; draft_quantity: string; state: "none" | "draft" | "partial" | "ordered"; ordered_purchase_order_nos: string[]; draft_purchase_order_nos: string[] };
/**
 * 草稿工作区的一行。
 *
 * `bomMaterialId` 是这一行在 BOM 表上对应的物料：采购员如果把物料改成别的东西，
 * 这一行就不再是 BOM 上那一行，`bomItemId` 必须一起清掉 —— 否则后端会以
 * `PURCHASE_BOM_ITEM_MISMATCH` 拒绝整张单（「采购明细必须引用当前 BOM 表中的对应物料」）。
 */
type PurchaseDraftItem = { materialId: string; model: string; quantity: string; unitId: string; unitPrice: string; supplierId: string; expectedDate: string; bomItemId?: string; bomMaterialId?: string; currentStock?: string };
type PurchaseDraft = { id?: string; purchaseOrderNo?: string; orderNo: string; bomId: string; currency: string; importBomItems: boolean; items: PurchaseDraftItem[] };
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
/**
 * 下载类失败（lib/download 抛普通 Error，消息已经是可读原因：超时 / HTTP 码 / 服务端 message）。
 * 不能套 `messageOf` 的兜底 —— 那会把「导出失败：服务端异常」压成光秃秃的「导出失败」，用户无从下手。
 */
const downloadErrorOf = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);
/** 后端把数量统一成四位小数（Decimal 口径），界面上不必显示 `5.0000`。 */
const trimQuantity = (value: string) => { const trimmed = String(value ?? "").replace(/0+$/, "").replace(/\.$/, ""); return trimmed === "" ? "0" : trimmed; };
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
  /** 当前 BOM 每一行的累计下单情况（按 bom_item_id 索引），用于草稿表里的「下单状态」列。 */
  const [bomOrderStatus, setBomOrderStatus] = useState<Record<string, BomItemOrderStatus>>({});
  /** BOM 外新增行（补料/替代料）必须填的原因：后端要求每行都给 `outside_bom_reason`。 */
  const [outsideBomReason, setOutsideBomReason] = useState("");
  /** 编辑**已下单**采购单时必须填的改动原因（宪法：已下单后变更要留前后值与原因）。 */
  const [editReason, setEditReason] = useState("");
  /** 正在编辑的这张采购单原本的状态：`ordered` 时保存要填原因、且保存后不能退回草稿。 */
  const [editingStatus, setEditingStatus] = useState("");
  const [bomWorkbench, setBomWorkbench] = useState<{ id: string; label?: string } | null>(null);
  // BOM 工作区里点「新建物料」时，把它的回填函数存下来（2026-09-16 之前这里是空函数，按钮点了没反应）。
  const [materialApply, setMaterialApply] = useState<((material: BomMaterialRef) => void) | null>(null);
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
    catch (cause) { notifyError(downloadErrorOf(cause, "导出失败")); }
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
    } catch (cause) { notifyError(downloadErrorOf(cause, "批量导出失败")); }
    finally { setExportBusy(""); }
  }

  /**
   * 采购单「打印信息」（用户 2026-09-16：付款方式 / 交期条款 / 交货地址 / 交货日期 /
   * 厂家回签意见 / 厂家回签 / 主管签字 / 备注 —— 「系统中采购单也要支持对这些字段进行填写和设置」）。
   *
   * 为什么它单独一个入口、不在草稿编辑工作区里：厂家回签本来就是**下单之后**才发生的事，
   * 而草稿工作区只在草稿上可用。这一组字段与明细/金额无关，所以任何状态（草稿/已下单/到货中/
   * 到货完成）都能填 —— 后端也是这么放行的（PATCH /purchase-orders/:id/print-fields）。
   * 初值直接取列表行（列表返回整行），不再多打一次详情接口。
   */
  function openPrintInfo(order: PurchaseOrder) {
    setDialog({
      title: `打印信息：${order.purchaseOrderNo}`,
      fields: [
        { name: "payment_terms", label: "付款方式", type: "select", options: paymentTermOptions(order.paymentTerms), defaultValue: printFieldsDefaults(order).payment_terms },
        { name: "expected_date", label: "交货日期（打印在表头；留空则按明细行日期）", type: "date", defaultValue: printFieldsDefaults(order).expected_date },
        { name: "delivery_terms", label: "交期条款", type: "textarea", defaultValue: printFieldsDefaults(order).delivery_terms },
        { name: "delivery_address", label: "交货地址", defaultValue: printFieldsDefaults(order).delivery_address },
        { name: "supplier_reply", label: "厂家回签意见（存系统；导出仍留空供手写）", type: "textarea", defaultValue: printFieldsDefaults(order).supplier_reply },
        { name: "supplier_signed", label: "厂家回签（经办人 / 日期）", defaultValue: printFieldsDefaults(order).supplier_signed },
        { name: "supervisor_signature", label: "主管签字", defaultValue: printFieldsDefaults(order).supervisor_signature },
        { name: "remark", label: "备注", type: "textarea", defaultValue: printFieldsDefaults(order).remark },
      ],
      // 必须把 Promise 交回 ActionDialog（不要写成 `void savePrintInfo(...)`）：
      // 它靠 onSubmit 抛错来决定「保持弹窗打开 + 显示原因」，被 void 吞掉就会关窗、用户填的几行字全丢。
      submit: (values) => savePrintInfo(order, values),
    });
  }

  async function savePrintInfo(order: PurchaseOrder, values: Record<string, string>) {
    setError("");
    try {
      await apiRequest(`/purchase-orders/${order.id}/print-fields`, { method: "PATCH", body: JSON.stringify(printFieldsPayload(values)) });
      notifySuccess(`${order.purchaseOrderNo} 打印信息已保存`);
      await load({ silent: true });
    } catch (cause) {
      // 抛出去：ActionDialog 会保持弹窗打开并显示原因，用户填的几行字不会丢
      notifyError(messageOf(cause, "打印信息保存失败"));
      throw cause;
    }
  }

  function createPurchaseOrder() {
    setSelectedDraftRows([]);
    setBomOrderStatus({});
    setOutsideBomReason("");
    setEditReason("");
    setEditingStatus("");
    setPurchaseDraft({ orderNo: "", bomId: "", currency: currencyCatalogue.some((o) => o.value === "CNY") ? "CNY" : (currencyCatalogue[0]?.value ?? "CNY"), importBomItems: true, items: [] });
    void refreshMaterialStock(materials.map((item) => item.id));
  }

  function stockFor(materialId: string, unitId: string) { return stockByMaterial[`${materialId}|${unitId}`] ?? "0"; }
  /**
   * 同一物料在**其它单位**上的余额（同一物料既有「米」又有「卷」是常态）。
   *
   * 为什么单独列出来而不相加：单位不同，数量不可相加。「当前库存量」只能按本行单位显示；
   * 其它单位的余额作为提示文字给出，读者知道「不是没有货，是单位不同」。
   */
  function otherUnitStock(materialId: string, unitId: string) {
    const prefix = `${materialId}|`;
    return Object.entries(stockByMaterial)
      .filter(([key, quantity]) => key.startsWith(prefix) && key !== `${materialId}|${unitId}` && Number(quantity) !== 0)
      .map(([key, quantity]) => `${quantity} ${unitName(key.slice(prefix.length))}`)
      .join("、");
  }
  function unitName(unitId: string) { return units.find((item) => item.id === unitId)?.name ?? "其它单位"; }
  /**
   * 草稿表里「下单状态」这一格。
   *
   * 用户 2026-09-17：「已经选中并下单的 BOM 物料，再新建采购单中要显示已下单。因此要多一个 column」。
   * 四态由后端按 `bom_item_id` 归集累计下单量给出：已下单足量 / 部分下单 / 草稿中 / 未下单。
   * 草稿**不算**已下单，但一样要看得见 —— 已经有草稿盖住的行同样不该再开一张。
   */
  function bomOrderCell(item: PurchaseDraftItem) {
    if (!item.bomItemId) return <span className="panel-note">BOM 外新增</span>;
    const status = bomOrderStatus[item.bomItemId];
    if (!status || status.state === "none") return <span className="panel-note">未下单</span>;
    if (status.state === "draft") return <span className="bom-order-draft" title={status.draft_purchase_order_nos.join("、")}>草稿中 {trimQuantity(status.draft_quantity)}{status.draft_purchase_order_nos.length ? `（${status.draft_purchase_order_nos.join("、")}）` : ""}</span>;
    if (status.state === "partial") return <span className="bom-order-partial" title={status.ordered_purchase_order_nos.join("、")}>部分下单 {trimQuantity(status.ordered_quantity)} / 需求 {trimQuantity(status.required_quantity)}</span>;
    return <span className="status-success" title={status.ordered_purchase_order_nos.join("、")}>已下单 {trimQuantity(status.ordered_quantity)}{status.ordered_purchase_order_nos.length ? `（${status.ordered_purchase_order_nos.join("、")}）` : ""}</span>;
  }
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
  /** 收束后会真正落成采购单的分组；「未选择供应商」那一组只在**保存草稿**时落单，下单前必须补齐。 */
  const assignedGroups = useMemo(() => draftGroups.filter((group) => group.supplierId), [draftGroups]);
  /** 还没选供应商的那一组（导入 BOM 之后就是这个状态）。 */
  const unassignedGroup = useMemo(() => draftGroups.find((group) => !group.supplierId), [draftGroups]);
  /** 不在 BOM 表上的行（补料/替代料）：必须填新增原因，否则保存会被后端拒绝。 */
  const outsideBomRows = useMemo(() => (purchaseDraft?.items ?? []).filter((item) => !item.bomItemId), [purchaseDraft]);
  /** 正在编辑一张**已下单**的单：此时保存要填原因，而且保存后不能退回草稿。 */
  const editingOrdered = editingStatus === "ordered";
  const needsOutsideBomReason = Boolean(purchaseDraft?.bomId) && outsideBomRows.length > 0;

  /**
   * 收束请求体：把当前草稿按供应商分组，交给 `POST /purchase-orders/split`
   * （新建）或 `POST /purchase-orders/:id/split`（收束一张已经存在的采购单）。
   *
   * 两条路径只差一个端点，请求体完全一样。`reason` 只在收束**已存在**的单时才带 ——
   * 新建接口的 DTO 里没有这个字段，而 ValidationPipe 开了 forbidNonWhitelisted，
   * 多带一个键会直接 400。
   *
   * 还没选供应商的行合成一组、`supplier_id` 留空：草稿要能把「刚导入 BOM」这个中间状态存下来
   * （用户 2026-09-17）。`""` 必须转成 `undefined` —— DTO 上是 `@IsOptional() @IsUUID()`，
   * 空串过不了 UUID 校验，而 `undefined` 会被 JSON.stringify 丢掉。
   */
  function collapsePayload(placeOrder: boolean) {
    if (!purchaseDraft) return null;
    const groups = draftGroups;
    const payload: Record<string, unknown> = {
      order_no: purchaseDraft.orderNo,
      bom_id: purchaseDraft.bomId || undefined,
      purchase_date: new Date().toISOString(),
      currency: purchaseDraft.currency,
      place_order: placeOrder,
      extension_data: { collapsed_by_supplier: true },
      groups: groups.map((group) => ({
        supplier_id: group.supplierId || undefined,
        currency: purchaseDraft.currency,
        expected_date: group.items.find((item) => item.expectedDate)?.expectedDate ? new Date(group.items.find((item) => item.expectedDate)!.expectedDate).toISOString() : undefined,
        items: group.items.map((item) => ({
          material_id: item.materialId,
          model: item.model || undefined,
          unit_id: item.unitId,
          bom_item_id: item.bomItemId,
          supplier_id: group.supplierId || undefined,
          expected_date: item.expectedDate ? new Date(item.expectedDate).toISOString() : undefined,
          quantity: item.quantity,
          unit_price: item.unitPrice,
          // 不在 BOM 表上的行（补料/替代料）必须带新增原因，否则后端以 PURCHASE_OUTSIDE_BOM_REASON_REQUIRED 拒绝整张单。
          extension_data: item.bomItemId ? undefined : { outside_bom_reason: outsideBomReason.trim() },
        })),
      })),
    };
    if (purchaseDraft.id) payload.reason = editReason.trim() || undefined;
    return payload;
  }

  /**
   * 保存 / 收束前的必填校验。
   *
   * 草稿与正式单的差别只有**完整性**：
   *   草稿允许没选供应商 —— 刚导入 BOM 明细时每一行都没供应商，这个中间状态必须存得下来
   *   （用户 2026-09-17：「导入 BOM 明细，也视为对采购单的编辑，允许保存」）；
   *   收束下单要求每行都有供应商 —— 一个供应商一张单，没收束的行没有落脚处。
   * `placeOrder` 不只是 `mode`：编辑一张**已下单**的单时保存的语义也是「下单态」，同样必须完整。
   */
  function validateDraft(mode: "draft" | "order") {
    if (!purchaseDraft) return false;
    const placeOrder = mode === "order" || editingOrdered;
    if (!purchaseDraft.orderNo) { setError("请先选择销售单"); return false; }
    if (placeOrder && !purchaseDraft.items.length) { setError("下单前请至少添加一行明细"); return false; }
    if (placeOrder) {
      const missingSupplier = purchaseDraft.items.findIndex((item) => !item.supplierId);
      if (missingSupplier >= 0) { setError(`第 ${missingSupplier + 1} 行明细还没选供应商，不能下单（一个供应商一张采购单）`); return false; }
    }
    const incomplete = purchaseDraft.items.findIndex((item) => !item.materialId || !item.unitId || !item.quantity || item.unitPrice === "");
    if (incomplete >= 0) { setError(`第 ${incomplete + 1} 行明细请补齐物料/单位/数量/单价`); return false; }
    if (purchaseDraft.bomId && outsideBomRows.length && !outsideBomReason.trim()) { setError(`有 ${outsideBomRows.length} 行不在 BOM 表中（补料/替代料），请填写「BOM 外新增原因」`); return false; }
    if (purchaseDraft.id && editingOrdered && !editReason.trim()) { setError("修改已下单的采购单必须填写原因"); return false; }
    if (placeOrder) {
      if (!purchaseDraft.bomId) { setError("下单前请选择 BOM 表"); return false; }
      const missingDate = purchaseDraft.items.findIndex((item) => !item.expectedDate);
      if (missingDate >= 0) { setError(`第 ${missingDate + 1} 行明细请填写预计到货日期`); return false; }
    }
    return true;
  }

  /**
   * 换物料。
   *
   * 如果这一行本来来自 BOM 表，换掉物料之后它就不再是 BOM 上那一行：必须把 `bom_item_id` 一起清掉。
   * 留着它后端会以 `PURCHASE_BOM_ITEM_MISMATCH` 拒绝**整张单**（「采购明细必须引用当前 BOM 表中的对应物料」），
   * 而界面上的报错完全看不出是哪一行——这是「保存草稿总失败」最难查的一种。
   */
  function changePurchaseMaterial(index: number, materialId: string) {
    const material = materials.find((item) => item.id === materialId);
    const row = purchaseDraft?.items[index];
    const patch: Partial<PurchaseDraftItem> = { materialId, unitId: material?.defaultUnitId ?? "" };
    if (row?.bomItemId && row.bomMaterialId !== materialId) { patch.bomItemId = undefined; patch.bomMaterialId = undefined; }
    updatePurchaseItem(index, patch);
  }

  /** 拉当前 BOM 每一行的累计下单情况（草稿表里的「下单状态」列）。取不到就不显示状态，不阻断导入。 */
  async function refreshBomOrderStatus(bomId: string) {
    try {
      const result = await apiGet<BomItemOrderStatus[]>(`/purchase-orders/bom-item-status?bom_id=${encodeURIComponent(bomId)}`);
      setBomOrderStatus(Object.fromEntries(result.data.map((row) => [row.bom_item_id, row])));
    } catch { setBomOrderStatus({}); }
  }

  async function importBomItems(bomId: string) {
    const bom = await apiGet<Bom>(`/boms/${bomId}`);
    const stock = await apiGet<Array<{ material_id: string; unit_id: string; quantity: string }>>(`/inventory/raw-material-balances?material_ids=${bom.data.items.map((item) => item.materialId).join(",")}`);
    const stockMap = stock.data.reduce<Record<string, string>>((acc, item) => { acc[`${item.material_id}|${item.unit_id}`] = item.quantity; acc[item.material_id] = (Number(acc[item.material_id] ?? 0) + Number(item.quantity)).toString(); return acc; }, {});
    setStockByMaterial((current) => ({ ...current, ...stockMap }));
    setSelectedDraftRows([]);
    // 刚导入 BOM，草稿里已经没有 BOM 外的行了：把上一次的原因清掉，否则会张冠李戴
    setOutsideBomReason("");
    await refreshBomOrderStatus(bomId);
    setPurchaseDraft((draft) => draft ? { ...draft, items: bom.data.items.map((item) => { const unitId = item.unitId ?? units.find((u) => u.name === item.unit)?.id ?? ""; return { materialId: item.materialId, model: item.model || item.specificationModel || "", quantity: item.requiredQuantity, unitId, unitPrice: "0", supplierId: "", expectedDate: "", bomItemId: item.id, bomMaterialId: item.materialId, currentStock: stockMap[`${item.materialId}|${unitId}`] ?? "0" }; }) } : draft);
  }

  async function selectPurchaseBom(bomId: string) { setPurchaseDraft((draft) => draft ? { ...draft, bomId } : draft); if (purchaseDraft?.importBomItems && bomId) { try { await importBomItems(bomId); } catch (cause) { notifyError(messageOf(cause, "BOM表明细带入失败")); } } }

  async function toggleBomImport(enabled: boolean) { setPurchaseDraft((draft) => draft ? { ...draft, importBomItems: enabled, items: enabled ? draft.items : [] } : draft); if (enabled && purchaseDraft?.bomId) { try { await importBomItems(purchaseDraft.bomId); } catch (cause) { notifyError(messageOf(cause, "BOM表明细带入失败")); } } }

  async function editPurchaseOrder(id: string) {
    setError("");
    try {
      const result = await apiGet<PurchaseOrder>(`/purchase-orders/${id}`);
      const order = result.data;
      setSelectedDraftRows([]);
      setEditReason("");
      setEditingStatus(order.status);
      // 已经存在的 BOM 外行本来就带着原因：带出来，用户不用重打一遍
      setOutsideBomReason(order.items.find((item) => item.extensionData?.outside_bom_reason)?.extensionData?.outside_bom_reason ?? "");
      if (order.bomId) await refreshBomOrderStatus(order.bomId); else setBomOrderStatus({});
      setPurchaseDraft({ id: order.id, purchaseOrderNo: order.purchaseOrderNo, orderNo: order.orderNo, bomId: order.bomId ?? "", currency: order.currency ?? "CNY", importBomItems: false, items: order.items.map((item) => ({ materialId: item.materialId, model: item.model ?? "", quantity: item.quantity, unitId: item.unitId, unitPrice: item.unitPrice ?? "0", supplierId: item.supplierId ?? order.supplierId ?? "", expectedDate: item.expectedDate?.slice(0, 10) ?? order.expectedDate?.slice(0, 10) ?? "", bomItemId: item.bomItemId ?? undefined })) });
    } catch (cause) { setError(messageOf(cause, "采购单加载失败")); }
  }

  /**
   * 保存 / 收束下单。
   *
   * 用户 2026-09-17：「导入 BOM 物料之后，用户对采购单进行编辑，填写供应商等等 column。
   * 支持保存草稿。然后再根据供应商收束下单。一个采购单内，一个供应商下一个单。」
   *
   * 所以保存与下单**都**按供应商收束，走的是同一个请求体，只差 `place_order`：
   *   - 新建 → `POST /purchase-orders/split`
   *   - 收束一张已经建好的单 → `POST /purchase-orders/:id/split`（第一组沿用原单，单号不变）
   * 两个端点都在一个事务里落全部组，所以「按供应商收束」不会出现「一半建好一半失败」。
   *
   * 已经下单的单：保存后仍是已下单，不能靠「保存草稿」把它悄悄退回草稿
   * （那张单已经发给供应商了，系统里退回草稿等于假装没下过单）。
   *
   * 一张明细都没有的空草稿走**普通建/存单接口**：没有供应商可分组，收束接口会以
   * 「至少需要一个分组」拒绝，而「选定销售单即可保存」是 2026-09-17 之前就有的行为。
   */
  async function savePurchaseOrder(mode: "draft" | "order" = "draft") {
    if (!purchaseDraft) return;
    if (!validateDraft(mode)) return;
    const placeOrder = mode === "order" || editingOrdered;
    setError("");
    try {
      if (!purchaseDraft.items.length) {
        const body = { order_no: purchaseDraft.orderNo, bom_id: purchaseDraft.bomId || undefined, purchase_date: new Date().toISOString(), currency: purchaseDraft.currency, items: [] as unknown[], ...(purchaseDraft.id ? { reason: editReason.trim() || undefined } : {}) };
        const result = purchaseDraft.id
          ? await apiRequest<PurchaseOrder>(`/purchase-orders/${purchaseDraft.id}`, { method: "PATCH", body: JSON.stringify(body) })
          : await apiPost<PurchaseOrder>("/purchase-orders", body);
        notifySuccess(`${purchaseDraft.id ? "采购草稿已更新" : "采购草稿已创建"}：${result.data?.purchaseOrderNo ?? ""}`);
      } else {
        const payload = collapsePayload(placeOrder);
        if (!payload) return;
        const result = purchaseDraft.id
          ? await apiPost<PurchaseOrder[]>(`/purchase-orders/${purchaseDraft.id}/split`, payload)
          : await apiPost<PurchaseOrder[]>("/purchase-orders/split", payload);
        const saved = result.data ?? [];
        const numbers = saved.map((order) => order?.purchaseOrderNo).filter(Boolean).join("、");
        const verb = placeOrder ? "已按供应商收束下单" : "已按供应商收束保存草稿";
        notifySuccess(saved.length > 1 ? `${verb}：${saved.length} 张采购单（${numbers}）` : `${verb}：${numbers}`);
      }
      setPurchaseDraft(null); setSelectedDraftRows([]); setEditingStatus(""); setEditReason("");
      await load();
    } catch (cause) { setError(messageOf(cause, placeOrder ? "按供应商收束下单失败" : "按供应商收束保存草稿失败")); }
  }

  async function refreshMaterialStock(ids: string[]) {
    if (!ids.length) return;
    try {
      const result = await apiGet<Array<{ material_id: string; unit_id: string; quantity: string }>>(`/inventory/raw-material-balances?material_ids=${ids.join(",")}`);
      // 只按「物料 + 单位」存：同一物料的米与卷不可相加，因此不再额外写一个物料级汇总键
      // （历史上「当前库存量」列读的就是那个跨单位汇总，等于把米和卷加在一起比）。
      const stock = result.data.reduce<Record<string, string>>((acc, item) => { acc[`${item.material_id}|${item.unit_id}`] = item.quantity; return acc; }, {});
      setStockByMaterial(stock);
    } catch { /* inventory access is optional */ }
  }

  function revertPurchaseOrder(order: PurchaseOrder) { setDialog({ title: `采购单回退草稿：${order.purchaseOrderNo}`, fields: [{ name: "reason", label: "回退原因", required: true, type: "textarea" }], submit: (v) => void action(`/purchase-orders/${order.id}/revert-draft`, { reason: v.reason }, "采购单已回到草稿") }); }

  function openBom(id: string, label?: string) { setError(""); setBomWorkbench({ id, label }); }

  const statusMap: Record<string, string> = { draft: "草稿", ordered: "已下单", partially_arrived: "部分到货", arrived_complete: "到货完成" };

  const orderColumns: ColumnDef<PurchaseOrder>[] = [
    { accessorKey: "purchaseOrderNo", header: "采购单号" },
    { id: "orderNo", header: "订单号", cell: ({ row }) => <Button variant="link" asChild><Link href={`/procurement/orders/${row.original.id}`}>{row.original.orderNo}</Link></Button> },
    { id: "supplier", header: "供应商", cell: ({ row }) => row.original.supplier?.name ?? "-" },
    { id: "status", header: "状态", cell: ({ row }) => { const totals = row.original.items.reduce((s, i) => { s.planned += Number(i.quantity); s.received += i.receipts.reduce((sum, r) => sum + Number(r.quantity), 0); return s; }, { planned: 0, received: 0 }); return totals.received > totals.planned ? <span className="status-error">超单</span> : totals.received === totals.planned && totals.planned > 0 ? <span className="status-success">到货完成</span> : <span className="status-label">{statusMap[row.original.status] ?? row.original.status}</span>; } },
    { id: "amount", header: "金额", cell: ({ row }) => `${row.original.totalAmount} ${row.original.currency}` },
    ...auditColumns<PurchaseOrder>(),
    { id: "actions", header: "操作", cell: ({ row }) => { const complete = row.original.items.length > 0 && row.original.items.every((item) => item.receipts.reduce((sum, r) => sum + Number(r.quantity), 0) >= Number(item.quantity)); const closed = row.original.extensionData?.arrival_closed; const isDraft = row.original.status === "draft"; const isOrdered = row.original.status === "ordered"; const noReceipts = row.original.items.every((item) => item.receipts.length === 0); const canReceive = ["ordered", "partially_arrived", "arrived_complete"].includes(row.original.status) && !closed; /**
       * 可编辑范围（用户 2026-09-17：「已经建好的采购单也要能编辑」）：
       * 草稿随时改；已下单但还没有任何到货的也能直接改明细（保存时要填原因）——
       * 那张单已经发给供应商了，逼用户先「回到草稿」等于在系统里假装没下过单。
       * 有到货之后明细只读（质检/入库/应付都挂在到货上），只能改打印信息。
       */
      const editable = isDraft || (isOrdered && noReceipts);
      return <div className="action-row">{editable && <Button size="sm" variant="secondary" data-testid={`order-edit-${row.original.purchaseOrderNo}`} onClick={() => void editPurchaseOrder(row.original.id)}>编辑</Button>}{isDraft && <Button size="sm" onClick={() => void action(`/purchase-orders/${row.original.id}/order`, undefined, "采购单已下单")}>下单</Button>}{isOrdered && noReceipts && <Button size="sm" variant="ghost" onClick={() => revertPurchaseOrder(row.original)}>回到草稿</Button>}{canReceive && <Button size="sm" variant="secondary" asChild><Link href={`/procurement/orders/${row.original.id}`}>到货跟踪</Link></Button>}{complete && !closed && <Button size="sm" variant="secondary" onClick={() => void action(`/purchase-orders/${row.original.id}/close-arrivals`, undefined, "到货已关闭，批次已进入来料质检")}>关闭到货</Button>}
        {/* 打印信息（付款方式/交期条款/交货地址/交货日期/回签三格）：任何状态都能填，含已下单 */}
        <Button size="sm" variant="secondary" data-testid={`order-print-info-${row.original.purchaseOrderNo}`} onClick={() => openPrintInfo(row.original)}>打印信息</Button>
        {/* 导出这一张采购订单的 Excel（2026-09-16 之前这个函数定义了却没有入口，页面上找不到） */}
        <Button size="sm" variant="secondary" data-testid={`order-export-${row.original.purchaseOrderNo}`} disabled={exportBusy === row.original.id} onClick={() => void exportPurchaseOrder(row.original)}>{exportBusy === row.original.id ? "导出中..." : "导出"}</Button>
        {closed && <span className="status-label status-success">已关闭</span>}</div>; } },
  ];

  if (loading) return <><PageHeader title="采购单" breadcrumb={["采购", "采购单"]} /><LoadingState /></>;
  if (bomWorkbench) return <>
    <PageHeader title="采购单" breadcrumb={["采购", "采购单"]} />
    <BomWorkbench bomId={bomWorkbench.id} title={bomWorkbench.label} materials={materials} units={units} onCreateMaterial={(apply) => setMaterialApply(() => apply)} onClose={() => setBomWorkbench(null)} onSaved={() => void load()} />
    <MaterialCreateDialog
      open={Boolean(materialApply)}
      units={units}
      onOpenChange={(open) => { if (!open) setMaterialApply(null); }}
      onUnitCreated={(unit) => setUnits((items) => [...items, unit])}
      onCreated={(material) => {
        // 新物料先进物料池：BOM 行的物料下拉靠 options 渲染名字，只填 id 会让那一格变空白。
        setMaterials((items) => [...items.filter((item) => item.id !== material.id), material]);
        materialApply?.(material);
        setMaterialApply(null);
      }}
    />
  </>;

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
            <SheetTitle>{purchaseDraft?.id ? `编辑采购单：${purchaseDraft.purchaseOrderNo ?? ""}` : "新建采购单"}</SheetTitle>
            <SheetDescription>导入 BOM 物料后逐行填供应商、单价与预计到货，然后保存草稿或收束下单。保存与下单都按供应商收束：几个供应商就落几张采购单，一张采购单只有一个供应商，到货、应付、对账的口径才唯一。草稿允许先不选供应商（没选的行会先存进一张还没有供应商的草稿），收束下单前必须补齐。</SheetDescription>
          </SheetHeader>
          {purchaseDraft && (
            <div className="detail-list">
              <label>销售单<Select value={purchaseDraft.orderNo || undefined} onValueChange={(value) => setPurchaseDraft({ ...purchaseDraft, orderNo: value, bomId: "", items: [] })}><SelectTrigger><SelectValue placeholder="请选择销售单" /></SelectTrigger><SelectContent>{salesOrders.filter((item) => item.status === "confirmed").map((item) => <SelectItem key={item.id} value={item.orderNo ?? item.id}>{item.orderNo ?? item.id}</SelectItem>)}</SelectContent></Select></label>
              <label>BOM表<Select value={purchaseDraft.bomId || undefined} disabled={!purchaseDraft.orderNo} onValueChange={(value) => void selectPurchaseBom(value)}><SelectTrigger><SelectValue placeholder="请选择BOM表" /></SelectTrigger><SelectContent>{boms.filter((item) => item.orderNo === purchaseDraft.orderNo).map((item) => <SelectItem key={item.id} value={item.id}>{item.orderNo}</SelectItem>)}</SelectContent></Select></label>
              {/* 就地下单时常常要顺手改 BOM（用量、单位、少一个物料）：这里给出编辑入口。
                  2026-09-14 拆分成枢纽页时这个入口丢了 —— openBom() 还在，但没有任何按钮调用它，
                  于是 BOM 工作区（连同里面的「新建物料」）在采购单页彻底不可达。 */}
              <label><Button type="button" size="sm" variant="secondary" data-testid="purchase-edit-bom" disabled={!purchaseDraft.bomId} onClick={() => openBom(purchaseDraft.bomId, purchaseDraft.orderNo)}>编辑BOM表</Button></label>
              <label>币种<Select value={purchaseDraft.currency || undefined} onValueChange={(value) => setPurchaseDraft({ ...purchaseDraft, currency: value })}><SelectTrigger><SelectValue placeholder="请选择币种" /></SelectTrigger><SelectContent>{currencyOptionsWithCurrent(currencyCatalogue, purchaseDraft.currency).map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}</SelectContent></Select></label>
              <label><Button type="button" aria-label="带入 BOM表明细" variant={purchaseDraft.importBomItems ? "secondary" : "ghost"} aria-pressed={purchaseDraft.importBomItems} onClick={() => void toggleBomImport(!purchaseDraft.importBomItems)}>带入 BOM表明细：{purchaseDraft.importBomItems ? "是" : "否"}</Button></label>
              {/* BOM 外的行（补料/替代料）后端要求逐行给 `outside_bom_reason`，界面原来根本给不出这个值，
                  于是「添加行 → 保存草稿」在选了 BOM 的情况下必然失败（PURCHASE_OUTSIDE_BOM_REASON_REQUIRED）。 */}
              {needsOutsideBomReason && (
                <label>BOM 外新增原因（{outsideBomRows.length} 行不在 BOM 表上，补料/替代料必填）
                  <Input value={outsideBomReason} onChange={(event) => setOutsideBomReason(event.target.value)} aria-label="BOM 外新增原因" placeholder="例如：原 BOM 物料缺货，改用替代料" />
                </label>
              )}
              <div className="page-actions">
                <Button size="sm" variant="secondary" onClick={addPurchaseItem}>添加行</Button>
                <Button size="sm" variant="destructive" disabled={!selectedDraftRows.length} onClick={removeSelectedDraftRows}>{selectedDraftRows.length ? `移除选中 ${selectedDraftRows.length} 行` : "移除选中行"}</Button>
                {editingOrdered ? <>
                  <label className="purchase-edit-reason">修改原因（必填）
                    <Input value={editReason} onChange={(event) => setEditReason(event.target.value)} aria-label="修改原因" placeholder="例如：单价录错，供应商报价 3.5" />
                  </label>
                  <Button size="sm" data-testid="purchase-save" onClick={() => void savePurchaseOrder("draft")}>保存修改</Button>
                </> : <>
                  <Button size="sm" variant="secondary" data-testid="purchase-save-draft" onClick={() => void savePurchaseOrder("draft")}>保存草稿{draftGroups.length > 1 ? `（${draftGroups.length} 张）` : ""}</Button>
                  <Button size="sm" data-testid="purchase-save-order" onClick={() => void savePurchaseOrder("order")}>收束下单{assignedGroups.length > 1 ? `（${assignedGroups.length} 张）` : ""}</Button>
                </>}
              </div>
              {(draftGroups.length > 1 || unassignedGroup) && (
                <div className="panel panel-body" data-testid="purchase-split-preview">
                  <p className="panel-note">{assignedGroups.length ? `按供应商收束（同供应商合并成一张采购单，共 ${assignedGroups.length} 张）：` : "按供应商收束：还没有任何一行选了供应商。"}</p>
                  <ul className="draft-split-list">{draftGroups.map((g) => <li key={g.supplierId || "unassigned"}>{g.supplierName || "未选择供应商"} · {g.items.length} 行 · 金额合计 {g.amount.toFixed(2)} {purchaseDraft.currency}{g.supplierId ? "" : "（还没选供应商）"}</li>)}</ul>
                  {unassignedGroup && <p className="panel-note">没选供应商的行不会被下单：保存草稿会把它们先存进一张「还没有供应商」的草稿，收束下单前必须补齐。</p>}
                  {purchaseDraft.id && assignedGroups.length > 0 && <p className="panel-note">第 1 组（{draftGroups[0]?.supplierName ?? "未选择供应商"}）沿用本单单号 {purchaseDraft.purchaseOrderNo}，其余组新建采购单。</p>}
                </div>
              )}
              {/* 列宽全部由 .draft-col-* 显式指定：这一页的 Sheet 复用了 .material-issue-sheet，
                  而那里写着 nth-child(1)=24%（给领料单的物料列用的），不覆盖就会把行首复选框撑成 24% 宽。 */}
              <div className="table-wrap">
                <table className="data-table purchase-draft-table">
                  <thead>
                    <tr>
                      <th className="draft-col-select"><input type="checkbox" aria-label="全选采购明细" checked={purchaseDraft.items.length > 0 && selectedDraftRows.length === purchaseDraft.items.length} onChange={(event) => toggleAllDraftRows(event.target.checked)} /></th>
                      <th className="draft-col-material">名称</th>
                      <th className="draft-col-model">型号</th>
                      <th className="draft-col-order">下单状态</th>
                      <th className="draft-col-qty">需求量</th>
                      <th className="draft-col-stock">当前库存量</th>
                      <th className="draft-col-unit">单位</th>
                      <th className="draft-col-price">单价</th>
                      <th className="draft-col-supplier">供应商</th>
                      <th className="draft-col-expected">预计到货</th>
                      <th className="draft-col-action">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchaseDraft.items.map((item, index) => (
                      <tr key={`${item.materialId}-${index}`}>
                        <td className="draft-col-select"><input type="checkbox" aria-label={`选择第 ${index + 1} 行采购明细`} checked={selectedDraftRows.includes(index)} onChange={() => toggleDraftRow(index)} /></td>
                        <td className="draft-col-material"><Select value={item.materialId || undefined} onValueChange={(value) => changePurchaseMaterial(index, value)}><SelectTrigger><SelectValue placeholder="请选择物料" /></SelectTrigger><SelectContent>{materialOptions.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}</SelectContent></Select></td>
                        <td className="draft-col-model"><Input value={item.model} onChange={(event) => updatePurchaseItem(index, { model: event.target.value })} /></td>
                        <td className="draft-col-order">{bomOrderCell(item)}</td>
                        <td className="draft-col-qty"><Input type="number" min="0" step="0.0001" value={item.quantity} onChange={(event) => updatePurchaseItem(index, { quantity: event.target.value })} /></td>
                        <td className={`draft-col-stock ${Number(stockFor(item.materialId, item.unitId)) >= Number(item.quantity) ? "stock-ok" : "stock-low"}`} title={otherUnitStock(item.materialId, item.unitId) ? `本行单位库存 ${stockFor(item.materialId, item.unitId)}；另有 ${otherUnitStock(item.materialId, item.unitId)}（单位不同，未相加）` : undefined}>{stockFor(item.materialId, item.unitId)}{otherUnitStock(item.materialId, item.unitId) ? <span className="panel-note">（另有 {otherUnitStock(item.materialId, item.unitId)}）</span> : null}</td>
                        <td className="draft-col-unit"><Select value={item.unitId || undefined} onValueChange={(value) => updatePurchaseItem(index, { unitId: value })}><SelectTrigger><SelectValue placeholder="请选择单位" /></SelectTrigger><SelectContent>{unitOptions.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}</SelectContent></Select></td>
                        <td className="draft-col-price"><Input type="number" min="0" step="0.0001" value={item.unitPrice} onChange={(event) => updatePurchaseItem(index, { unitPrice: event.target.value })} /></td>
                        <td className="draft-col-supplier"><Select value={item.supplierId || undefined} onValueChange={(value) => updatePurchaseItem(index, { supplierId: value })}><SelectTrigger><SelectValue placeholder="请选择供应商" /></SelectTrigger><SelectContent>{supplierOptions.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}</SelectContent></Select></td>
                        <td className="draft-col-expected"><Input type="date" value={item.expectedDate} onChange={(event) => updatePurchaseItem(index, { expectedDate: event.target.value })} aria-label="预计到货日期" /></td>
                        <td className="draft-col-action"><Button size="icon" variant="ghost" title="删除行" aria-label="删除行" onClick={() => setPurchaseDraft({ ...purchaseDraft, items: purchaseDraft.items.filter((_, i) => i !== index) })}><Trash2 size={16} /></Button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
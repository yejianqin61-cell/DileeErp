"use client";

// 来料质检（QC 模块）：到货批次的送检登记、判定流转、入库通知与退货。
//
// 这里原来是「采购 → 来料质检」区块。拆成独立模块后：
//   * 采购页只负责到货登记与原料入库，质检入口改为跳转到 /qc/incoming?receipt_id=<到货批次>；
//   * 全部质检动作（登记/编辑/开始/完成/回退/通知入库/入库/退货）都收在本面板里，
//     避免同一业务在两个页面各写一套、状态口径不一致。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { DataTable } from "../data/data-table";
import { auditColumns, type AuditRow } from "../data/audit-columns";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../lib/api-client";
import { shouldRefreshOnVisibility } from "../../lib/refresh-policy";
import { emitQcDataChanged, subscribeQcDataChanged } from "./qc-refresh";
import { notifyError, notifySuccess } from "../ui/toaster";

type InspectionBatch = { id: string; status: string; qcResult?: "all_inbound" | "rejected" | "partial_inbound" | null; inspectedQuantity: string; acceptedQuantity: string; conditionalQuantity: string; rejectedQuantity: string };
type InboundBatch = { id: string; inboundNo: string; quantity: string; status: string };
type Receipt = { id: string; receiptNo: string; quantity: string; status?: string; batchSequence?: number; inspections?: InspectionBatch[] };
type PurchaseItem = { id: string; quantity: string; material?: { materialCode?: string; name?: string }; unit?: { name?: string }; receipts: Receipt[] };
type PurchaseOrder = { id: string; purchaseOrderNo: string; orderNo: string; status: string; items: PurchaseItem[] };
type InboundNotice = { id: string; noticeNo: string; incomingInspectionId: string; status: string; notifiedQuantity: string };
type Inspection = AuditRow & { id: string; orderNo: string; purchase_order_no?: string; material_name?: string | null; status: string; qcResult?: "all_inbound" | "rejected" | "partial_inbound" | null; batchSequence?: number; inspectedQuantity: string; acceptedQuantity: string; conditionalQuantity: string; rejectedQuantity: string; downstream_exists?: boolean; purchaseReceipt?: Receipt };
type Inbound = { id: string; inboundNo: string; quantity: string; status: string; incomingInspectionId?: string | null };
type ReceiptOption = Receipt & { orderNo: string; purchaseOrderNo: string; materialName: string; unitName: string; batchSequence: number; inspectedQuantity: number };
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const QC_RESULT_OPTIONS = [{ value: "all_inbound", label: "全部入库" }, { value: "rejected", label: "拒收" }, { value: "partial_inbound", label: "部分入库" }];
const qcResultLabel = (value: Inspection["qcResult"]) => value === "rejected" ? "拒收" : value === "partial_inbound" ? "部分入库" : value === "all_inbound" ? "全部入库" : "待判定";
const inspectionStatusLabel: Record<string, string> = { pending: "待质检", inspecting: "质检中", completed: "已登记", accepted: "全部入库", conditionally_accepted: "全部入库", partially_accepted: "部分入库", rejected: "拒收", cancelled: "已取消" };
const inboundStatusLabel: Record<string, string> = { draft: "草稿", posted: "已过账", reversed: "已冲销" };
const noticeStatusLabel: Record<string, string> = { pending: "待仓库接收", acknowledged: "已接收", processing: "入库中", completed: "已完成", cancelled: "已取消" };
/** 入库草稿由「仓库接收入库通知」时自动生成，所以只有接收后才有可入库额度。 */
const INBOUND_READY_NOTICE_STATUSES = ["acknowledged", "processing"];
/** 可回退重判的状态：与后端允许回退到 pending 的集合一致。 */
const ROLLBACKABLE_STATUSES = ["accepted", "conditionally_accepted", "partially_accepted", "completed", "rejected"];

export function IncomingInspectionsPanel({ receiptId }: { receiptId?: string }) {
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [inbounds, setInbounds] = useState<Inbound[]>([]);
  const [notices, setNotices] = useState<InboundNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 提示与错误分开：提示（深链批次不存在/已撤销/已送检完毕）不该被静默刷新或一次操作清掉，
  // 错误则要能被重试/刷新复位。
  const [hint, setHint] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  // 深链（/qc?receipt_id=…）每个到货批次只自动打开一次：用户关掉后不再被刷新重弹，
  // 但同一个页面里 receipt_id 换成另一个批次（history 前进/后退）时应当为新批次再打开一次，
  // 所以记的是「已处理过的 receipt_id」而不是一个布尔。
  const deepLinkHandled = useRef<string | null>(null);

  async function load(options: { silent?: boolean } = {}) {
    if (!options.silent) setLoading(true);
    setError("");
    try {
      const [po, qc, ib, notices] = await Promise.all([
        apiGet<PurchaseOrder[]>("/purchase-orders"),
        apiGet<Inspection[]>("/incoming-inspections"),
        apiGet<Inbound[]>("/raw-material-inbounds"),
        apiGet<InboundNotice[]>("/raw-material-inbound-notices"),
      ]);
      setOrders(po.data); setInspections(qc.data); setInbounds(ib.data); setNotices(notices.data);
    } catch (cause) { setError(messageOf(cause, "来料质检数据加载失败")); }
    finally { if (!options.silent) setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  // 同页其它面板（成品质检 / 质检合格待入库）写入后，这里的判定与入库状态也要跟着刷新。
  useEffect(() => subscribeQcDataChanged("incoming-inspections", () => void load({ silent: true })), []);
  // 仓库在**另一个页面**接收入库通知，本面板不刷新就看不到「已接收」，也就不会出现建草稿入口。
  useEffect(() => {
    const refresh = () => { if (shouldRefreshOnVisibility(document.visibilityState)) void load({ silent: true }); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);

  /** 某个到货批次已累计送检的数量。
   *  注意：`GET /purchase-orders`（列表）的 receipts **不含** inspections，只有详情才带；
   *  所以这里以 `/incoming-inspections` 列表为准（它带 purchaseReceipt.id），否则深链默认值会
   *  恒等于整批到货量，已部分送检的批次一提交就 422。 */
  const inspectedQuantityOf = useCallback((receipt: Receipt) => {
    const fromApi = inspections.filter((row) => row.purchaseReceipt?.id === receipt.id).reduce((sum, row) => sum + Number(row.inspectedQuantity), 0);
    if (fromApi > 0) return fromApi;
    const fromDetail = (receipt.inspections ?? []).reduce((sum, row) => sum + Number(row.inspectedQuantity), 0);
    return fromDetail;
  }, [inspections]);

  /** 全部到货批次（含已撤销、已送检完毕）：深链要靠它区分「批次不存在」「已撤销」「已送检完毕」。 */
  const allReceiptOptions = useMemo<ReceiptOption[]>(() => orders.flatMap((order) => order.items.flatMap((item) => item.receipts.map((receipt, index) => ({
    ...receipt,
    orderNo: order.orderNo,
    purchaseOrderNo: order.purchaseOrderNo,
    materialName: item.material?.name ?? "物料",
    unitName: item.unit?.name ?? "",
    batchSequence: receipt.batchSequence ?? index + 1,
    inspectedQuantity: inspectedQuantityOf(receipt),
  })))), [orders, inspectedQuantityOf]);
  // 送检下拉只列还能送的：已撤销的批次后端不接受；已送检完毕的批次点进去只会拿到
  // 「累计检验数量不能超过到货数量」的 422，不该让用户白填一次。
  const receiptOptions = useMemo(() => allReceiptOptions.filter((receipt) => receipt.status !== "cancelled" && receipt.inspectedQuantity < Number(receipt.quantity)), [allReceiptOptions]);

  /** 该质检条目对应的**到货批次总数量**（用户 2026-09-16：「每个条目都要带上该批物料的总数量」）。
   *
   *  为什么不是直接取 `inspection.inspectedQuantity`：那一列是「已送检」，一个到货 100 的批次
   *  只送了 40 时，列表上看不出整批到底有多少，也就判断不出还剩多少没送检。
   *  数量与单位优先从 `/purchase-orders` 里那个批次取（它带单位名），
   *  拿不到（批次没进采购单列表、或列表还没回来）就退回质检记录里的 `purchaseReceipt.quantity`。 */
  const batchTotalOf = (item: Inspection) => {
    const receiptId = item.purchaseReceipt?.id;
    const fromOrders = receiptId ? allReceiptOptions.find((option) => option.id === receiptId) : undefined;
    const quantity = fromOrders?.quantity ?? item.purchaseReceipt?.quantity;
    if (quantity === undefined || quantity === null || quantity === "") return "-";
    const unit = fromOrders?.unitName;
    return unit ? `${quantity} ${unit}` : String(quantity);
  };

  function run(action: () => Promise<unknown>, success: string) {
    setError("");
    return action()
      .then(async () => { notifySuccess(success); setMessage(success); setDialog(null); await load({ silent: true }); emitQcDataChanged("incoming-inspections"); })
      .catch((cause) => { const text = messageOf(cause, "操作失败"); setError(text); notifyError(text); });
  }

  const inboundUsedByInspection = useCallback((inspectionId: string) => inbounds.filter((row) => row.incomingInspectionId === inspectionId && ["draft", "posted"].includes(row.status)).reduce((sum, row) => sum + Number(row.quantity), 0), [inbounds]);  const inboundRemainingFor = (item: Inspection) => Math.max(0, Number(item.acceptedQuantity) + Number(item.conditionalQuantity) - inboundUsedByInspection(item.id));
  const draftInboundFor = (inspectionId: string) => inbounds.find((row) => row.incomingInspectionId === inspectionId && row.status === "draft");
  const inspectionInboundCapable = (item: Inspection) => ["accepted", "conditionally_accepted", "partially_accepted", "completed"].includes(item.status);
  const noticeFor = (inspectionId: string) => notices.find((row) => row.incomingInspectionId === inspectionId);
  const canRollback = (item: Inspection) => ROLLBACKABLE_STATUSES.includes(item.status) && !item.downstream_exists;
  /** 能否自己建入库草稿：后端要求该质检单的入库通知已被仓库接收（否则 422 INBOUND_NOTICE_NOT_ACKNOWLEDGED），
   *  而仓库接收时会自动建出全额草稿 —— 所以真正可建的情形只有「已接收且草稿被删/用尽」。
   *  通知不区分状态（保留已取消的）：当前系统没有取消原料入库通知的路径，
   *  而且一张质检单在库里最多只能有一张未删除的通知单，界面按同一口径判断避免出现「看起来能重发、实际 409」。 */
  const inboundReady = (item: Inspection) => { const notice = noticeFor(item.id); return Boolean(notice) && INBOUND_READY_NOTICE_STATUSES.includes(notice!.status) && inboundRemainingFor(item) > 0; };

  /**
   * 送检登记的请求体。
   * 后端要求「合格 + 条件接收 + 不合格 = 送检数量」，并且 qc_result 必须与这份拆分推导出的状态一致
   * （incoming-inspections.service.ts:36 与 :50）。拒收的正确拆分是 合格 0 / 条件 0 / 不合格 = 送检量；
   * 若把送检量同时写进合格与不合格，拆分合计变成 2 倍送检量，后端直接 422 INSPECTION_QUANTITY_MISMATCH。
   */
  const inspectionBody = (v: Record<string, string>) => v.qc_result === "rejected"
    ? { inspected_quantity: v.quantity, qc_result: "rejected", accepted_quantity: "0", conditional_quantity: "0", rejected_quantity: v.quantity }
    : { inspected_quantity: v.quantity, qc_result: v.qc_result, accepted_quantity: v.accepted_quantity, conditional_quantity: v.conditional_quantity, rejected_quantity: v.rejected_quantity };

  /**
   * 与后端同一套配平校验，提前在弹窗里拦下。
   * 抛错而不是 setError：ActionDialog 会把异常显示在弹窗内并**保留用户已填的值**，
   * 而 setError 只能显示在弹窗背后的页面上、且弹窗已经被关闭。
   */
  const assertBalanced = (v: Record<string, string>) => {
    if (v.qc_result === "rejected") return;
    const round = (value: number) => Math.round(value * 10000) / 10000;
    const count = (value: string | undefined) => value?.trim() ? Number(value) : 0;
    const inspected = Number(v.quantity);
    const accepted = count(v.accepted_quantity); const conditional = count(v.conditional_quantity); const rejected = count(v.rejected_quantity);
    if (!Number.isFinite(inspected) || inspected <= 0) throw new Error("「送检数量」必须是大于 0 的数字");
    if ([accepted, conditional, rejected].some((value) => !Number.isFinite(value) || value < 0)) throw new Error("合格 / 条件接收 / 不合格数量必须是不小于 0 的数字");
    const split = round(accepted + conditional + rejected);
    if (round(inspected) !== split) throw new Error(`数量不配平：送检 ${round(inspected)} ≠ 合格 ${round(accepted)} + 条件接收 ${round(conditional)} + 不合格 ${round(rejected)}（合计 ${split}）`);
  };

  function inspectReceipt(receipt: ReceiptOption) {
    const remaining = Math.max(0, Number(receipt.quantity) - receipt.inspectedQuantity);
    setDialog({ title: `登记来料质检：${receipt.purchaseOrderNo} / 第 ${receipt.batchSequence} 批`, fields: [
      { name: "quantity", label: `本次送检数量（已送检 ${receipt.inspectedQuantity} / 到货 ${receipt.quantity}）`, type: "number", required: true, defaultValue: remaining > 0 ? String(remaining) : "1" },
      { name: "qc_result", label: "最终 QC 结果", type: "select", required: true, defaultValue: "all_inbound", options: QC_RESULT_OPTIONS },
      { name: "accepted_quantity", label: "本次合格数量", type: "number", required: true, defaultValue: remaining > 0 ? String(remaining) : "0" },
      { name: "conditional_quantity", label: "本次条件接收", type: "number", required: true, defaultValue: "0" },
      { name: "rejected_quantity", label: "本次不合格数量", type: "number", required: true, defaultValue: "0" },
    ], submit: (v) => { assertBalanced(v); void run(() => apiPost("/incoming-inspections", { purchase_receipt_id: receipt.id, ...inspectionBody(v) }), `第 ${receipt.batchSequence} 批质检已记录`); } });
  }

  function inspect() {
    if (!receiptOptions.length) {
      // 区分「还没登记到货」与「都已送检完」：后者给去采购登记到货的提示会让人白跑一趟。
      setHint(allReceiptOptions.some((item) => item.status !== "cancelled" && item.inspectedQuantity >= Number(item.quantity))
        ? "所有到货批次都已送检完毕：如需更正请在下方质检记录里用「编辑」或「回退重判」"
        : "暂无可送检的到货批次：请先在采购模块登记到货");
      return;
    }
    setHint("");
    setDialog({ title: "登记来料质检", fields: [
      { name: "receipt_id", label: "到货记录", type: "select", required: true, options: receiptOptions.map((item) => ({ value: item.id, label: `${item.purchaseOrderNo} / 订单号 ${item.orderNo} / 第 ${item.batchSequence} 批 / 到货 ${item.quantity}${item.unitName ? ` ${item.unitName}` : ""}（已送检 ${item.inspectedQuantity}）` })) },
      { name: "quantity", label: "送检数量", type: "number", required: true, defaultValue: "1" },
      { name: "qc_result", label: "最终 QC 结果", type: "select", required: true, defaultValue: "all_inbound", options: QC_RESULT_OPTIONS },
      { name: "accepted_quantity", label: "合格数量", type: "number", required: true, defaultValue: "1" },
      { name: "conditional_quantity", label: "条件接收", type: "number", required: true, defaultValue: "0" },
      { name: "rejected_quantity", label: "不合格数量", type: "number", required: true, defaultValue: "0" },
    ], submit: (v) => { assertBalanced(v); void run(() => apiPost("/incoming-inspections", { purchase_receipt_id: v.receipt_id, ...inspectionBody(v) }), "来料质检已记录"); } });
  }

  // 深链：采购页「登记质检」按到货批次跳到这里时，直接打开该批次的送检登记。
  // 用「最近处理过的 receipt_id」挡住重复弹出（手动关掉后不再重弹）；切换到另一个批次会为新批次再开一次；
  // 批次不存在 / 已撤销 / 已送检完毕都给出明确文案，不再静默什么都不做。
  useEffect(() => {
    if (!receiptId || !allReceiptOptions.length || deepLinkHandled.current === receiptId) return;
    const receipt = allReceiptOptions.find((item) => item.id === receiptId);
    deepLinkHandled.current = receiptId;
    if (!receipt) { setHint("未找到该到货批次（可能已被撤销）：请在下方列表里重新选择要送检的批次"); return; }
    if (receipt.status === "cancelled") { setHint("该到货批次已撤销，不能送检"); return; }
    if (receipt.inspectedQuantity >= Number(receipt.quantity)) {
      // 整批退货会把质检记录置为 cancelled，那条记录既不能编辑也不能回退，文案不能说「去编辑/回退」。
      const returned = inspections.some((row) => row.purchaseReceipt?.id === receipt.id && row.status === "cancelled");
      setHint(returned
        ? `该到货批次已整批退货（到货 ${receipt.quantity} / 已送检 ${receipt.inspectedQuantity}）：如需重新进货请在采购模块登记新的到货批次`
        : `该到货批次已送检完毕（到货 ${receipt.quantity} / 已送检 ${receipt.inspectedQuantity}）：如需更正请在下方质检记录里用「编辑」或「回退重判」`);
      return;
    }
    inspectReceipt(receipt);
    // inspectReceipt 是每次渲染重建的普通函数，这里只依赖到货批次与深链参数。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptId, allReceiptOptions]);

  function editInspection(item: Inspection) {
    setDialog({ title: `编辑来料质检：${item.purchase_order_no ?? item.orderNo}`, fields: [
      // 改数量时要能看到整批总量，否则没法判断「送检数量」上限该是多少。
      { name: "batch_total", label: `本批到货总量：${batchTotalOf(item)}`, type: "info" },
      { name: "inspected_quantity", label: "送检数量", type: "number", required: true, defaultValue: item.inspectedQuantity },
      { name: "accepted_quantity", label: "合格数量", type: "number", required: true, defaultValue: item.acceptedQuantity },
      { name: "conditional_quantity", label: "条件接收", type: "number", required: true, defaultValue: item.conditionalQuantity },
      { name: "rejected_quantity", label: "不合格数量", type: "number", required: true, defaultValue: item.rejectedQuantity },
      { name: "remark", label: "备注", type: "textarea" },
      { name: "reason", label: "更正原因", type: "textarea", required: true },
    ], submit: (v) => void run(() => apiRequest(`/incoming-inspections/${item.id}`, { method: "PATCH", body: JSON.stringify({ inspected_quantity: v.inspected_quantity, accepted_quantity: v.accepted_quantity, conditional_quantity: v.conditional_quantity, rejected_quantity: v.rejected_quantity, remark: v.remark || undefined, reason: v.reason }) }), "来料质检已更新") });
  }

  function transitionInspection(item: Inspection, target: string) {
    if (target === "pending" || target === "cancelled") {
      setDialog({ title: "回退来料质检", fields: [{ name: "reason", label: "回退原因", required: true, type: "textarea" }], submit: (v) => void run(() => apiRequest(`/incoming-inspections/${item.id}/status`, { method: "PATCH", body: JSON.stringify({ target, reason: v.reason }) }), "来料质检状态已更新") });
      return;
    }
    void run(() => apiRequest(`/incoming-inspections/${item.id}/status`, { method: "PATCH", body: JSON.stringify({ target }) }), "来料质检状态已更新");
  }

  function notifyInbound(item: Inspection) { void run(() => apiPost("/raw-material-inbound-notices", { inspection_id: item.id }), "入库通知已发送"); }

  function inboundAll(item: Inspection) {
    const remaining = inboundRemainingFor(item);
    if (remaining <= 0) { setError("该质检批次没有可入库的剩余数量（合格 + 条件接收 − 已建入库单）"); return; }
    void run(() => apiPost("/raw-material-inbounds", { incoming_inspection_id: item.id, quantity: String(remaining), inventory_category: "raw_material" }), `已按剩余量 ${remaining} 创建原料入库草稿`);
  }

  function inboundPartial(item: Inspection) {
    const remaining = inboundRemainingFor(item);
    setDialog({ title: `部分入库：${item.purchase_order_no ?? item.orderNo} / 第 ${item.batchSequence ?? "-"} 批`, fields: [
      { name: "quantity", label: `本次入库数量（剩余可入 ${remaining}）`, type: "number", required: true, defaultValue: remaining > 0 ? String(remaining) : "1" },
      { name: "settlement_unit_price", label: "结算单价", type: "number", required: true },
      { name: "settlement_total_amount", label: "结算总价", type: "number", required: true },
      { name: "settlement_amount_reason", label: "金额差异原因", type: "textarea", required: true },
      { name: "remark", label: "备注", type: "textarea" },
    ], submit: (v) => {
      const quantity = Number(v.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) { setError("入库数量必须是大于零的数字"); return; }
      if (quantity > remaining) { setError(`入库数量不能超过剩余可入数量 ${remaining}`); return; }
      void run(() => apiPost("/raw-material-inbounds", { incoming_inspection_id: item.id, quantity: v.quantity, settlement_unit_price: v.settlement_unit_price, settlement_total_amount: v.settlement_total_amount, settlement_amount_reason: v.settlement_amount_reason, inventory_category: "raw_material", remark: v.remark || undefined }), "原料入库草稿已创建");
    } });
  }

  function returnInspection(item: Inspection) {
    setDialog({ title: `整批退货：${item.purchase_order_no ?? item.orderNo} / 第 ${item.batchSequence ?? "-"} 批`, fields: [{ name: "reason", label: "退货原因", required: true, type: "textarea" }], submit: (v) => void run(() => apiPost(`/incoming-inspections/${item.id}/return`, { reason: v.reason }), "质检批次已退货") });
  }

  const columns: ColumnDef<Inspection>[] = [
    { accessorKey: "orderNo", header: "订单号" },
    { accessorKey: "purchase_order_no", header: "采购单号", cell: ({ row }) => row.original.purchase_order_no ?? "-" },
    { accessorKey: "material_name", header: "物料", cell: ({ row }) => row.original.material_name ?? "-" },
    { id: "batch", header: "质检批次", cell: ({ row }) => `第 ${row.original.batchSequence ?? row.original.purchaseReceipt?.batchSequence ?? "-"} 批` },
    // 本批总数量放在「送检」前面：先看到整批多少，再看送检/合格/不合格各多少。
    { id: "batchTotal", header: "本批总数量", cell: ({ row }) => batchTotalOf(row.original) },
    { id: "qcResult", header: "最终结果", cell: ({ row }) => qcResultLabel(row.original.qcResult) },
    { id: "status", header: "状态", cell: ({ row }) => inspectionStatusLabel[row.original.status] ?? row.original.status },
    { accessorKey: "inspectedQuantity", header: "送检" },
    { accessorKey: "acceptedQuantity", header: "合格" },
    { accessorKey: "conditionalQuantity", header: "条件接收" },
    { accessorKey: "rejectedQuantity", header: "不合格" },
    { id: "inbound", header: "入库情况", cell: ({ row }) => { const used = inboundUsedByInspection(row.original.id); const remaining = inboundRemainingFor(row.original); const draft = draftInboundFor(row.original.id); const notice = noticeFor(row.original.id); return <span>{`已建单 ${used} · 剩余可入 ${remaining}`}{draft ? <span className="status-warning"> · 有草稿待过账</span> : null}{notice?.status === "pending" ? <span className="panel-note"> · 待仓库接收通知（接收时自动生成入库草稿）</span> : null}</span>; } },
    { id: "notice", header: "入库通知", cell: ({ row }) => { const notice = noticeFor(row.original.id); return notice ? <span className="status-success">{notice.noticeNo}（{noticeStatusLabel[notice.status] ?? notice.status}）</span> : <span className="batch-empty">未通知</span>; } },
    ...auditColumns<Inspection>(),
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">
      {!row.original.downstream_exists && row.original.status !== "cancelled" && <Button size="sm" variant="secondary" onClick={() => editInspection(row.original)}>编辑</Button>}
      {row.original.status === "pending" && <Button size="sm" variant="secondary" onClick={() => transitionInspection(row.original, "inspecting")}>开始质检</Button>}
      {row.original.status === "inspecting" && <Button size="sm" variant="secondary" onClick={() => transitionInspection(row.original, "completed")}>完成质检</Button>}
      {canRollback(row.original) && <Button size="sm" variant="ghost" onClick={() => transitionInspection(row.original, "pending")}>回退重判</Button>}
      {inspectionInboundCapable(row.original) && <>
        {noticeFor(row.original.id) ? null : <Button size="sm" variant="secondary" onClick={() => notifyInbound(row.original)}>通知入库</Button>}
        {/* 只有「仓库已接收入库通知且仍有可入额度」时才给建草稿入口：
            未接收时后端会 422 INBOUND_NOTICE_NOT_ACKNOWLEDGED，接收时仓库已自动建出全额草稿。 */}
        {inboundReady(row.original) && <>
          <Button size="sm" variant="ghost" onClick={() => inboundPartial(row.original)}>部分入库</Button>
          <Button size="sm" variant="ghost" onClick={() => inboundAll(row.original)}>按剩余量入库</Button>
        </>}
        {!row.original.downstream_exists && <Button size="sm" variant="ghost" onClick={() => returnInspection(row.original)}>退货</Button>}
      </>}
    </div> },
  ];

  return <section className="panel" style={{ gridColumn: "1 / -1" }}>
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { const current = dialog; void current?.submit(values); }} />
    <div className="panel-heading">
      <h2>来料质检</h2>
      <div className="page-actions">
        <Button variant="secondary" onClick={inspect}>登记来料质检</Button>
        <Button variant="ghost" onClick={() => void load()}>刷新</Button>
      </div>
    </div>
    <div className="panel-body">
      <p className="panel-note">到货批次在这里送检 → 判定（全部入库 / 部分入库 / 拒收）→ 通知仓库入库。判错可以「回退重判」；入库草稿由仓库接收入库通知时自动生成，过账与冲销在【仓库 → 原料仓储情况】完成。</p>
      <div className="action-row">
        <Button size="sm" variant="secondary" asChild><Link href="/procurement">去采购登记到货</Link></Button>
        <Button size="sm" variant="secondary" asChild><Link href="/warehouse">去仓库接收/过账入库</Link></Button>
        <Button size="sm" variant="secondary" asChild><Link href="/warehouse/raw-material-storage">去原料仓储情况过账入库</Link></Button>
      </div>
    </div>
    {message && <p className="status-success panel-body" role="status">{message}</p>}
    {hint && <p className="panel-note panel-body" role="status" data-testid="qc-hint">{hint}</p>}
    {error && <div className="panel-body" role="alert"><ErrorState message={error} onRetry={() => void load()} /></div>}
    <div className="panel-body">{loading ? <LoadingState /> : <DataTable columns={columns} data={inspections} empty={<EmptyState title="暂无来料质检记录" description="采购登记到货后，在这里点「登记来料质检」送检。" />} />}</div>
  </section>;
}
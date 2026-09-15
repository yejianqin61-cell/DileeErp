"use client";

// 应付管理二级页（/finance/payable?tab=...）。
//
// 规范化流程：「先有入库/签收、再对账、最后确认应付与付款」：
//   1. 原料入库条目：原料入库过账生成的待接收应付来源，财务在这里人工接收成应付草稿；
//   2. 外加工签收：外加工实际签收生成的待接收应付来源（直发数量不形成应付）；
//   3. 应付对账：对账创建 + 对账单列表合并在同一视图；创建后去「确认应付」确认；
//   4. 确认应付：应付台账 + 付款合并在同一视图；动作集中在表格行内操作按钮。
// 双击任意行弹出详情页。
//
// 「采购到货」不单独成栏：后端明确禁用到货单作为可接收应付来源
// （supplier-payable.service.ts 的 PURCHASE_RECEIPT_PAYABLE_DISABLED），应付来源只由原料入库过账产生。
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../layout/app-shell";
import { DataTable } from "../data/data-table";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost } from "../../lib/api-client";
import { currencyOptions, currencyOptionsWithCurrent, fetchCurrencyOptions, type CurrencyOption } from "../../lib/currency-catalogue";
import { PAYABLE_TABS, type PayableTabKey } from "../../lib/finance-sections";
import { notifyError, notifySuccess } from "../ui/toaster";
import { FinanceTabs } from "./finance-tabs";
import { RecordDetailDialog, money, type DetailField } from "./record-detail-dialog";
import { financeStatus } from "./finance-status";

/** 付款建单的幂等键：打开弹窗时生成并固定，同一次弹窗内的重试/双击只会落一张草稿。 */
const paymentIdempotencyKey = () => `web-payment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

type Reference = { id: string; name: string; supplierCode?: string; orderNo?: string };
type SupplierRef = { id: string; name: string; supplierCode: string | null };
type BankRef = { id: string; bankCode: string; bankName: string; accountName: string; accountNumber: string; currency: string; isActive: boolean; swiftCode: string | null; remark: string | null };
type PayableSource = {
  id: string; orderNo: string; quantity: string; unitPrice: string; taxRate: string | null; amount: string; currency: string; status: string;
  qcResult: string | null; actualInboundQuantity: string | null; acceptedQuantity: string | null; conditionalQuantity: string | null; rejectedQuantity: string | null;
  settlementUnitPrice: string | null; settlementTotalAmount: string | null; settlementAmountReason: string | null;
  createdAt: string;
  purchase_order_no?: string | null; batch_sequence?: number | null;
  material_name?: string | null; material_code?: string | null; material_specification?: string | null; material_color?: string | null; unit_name?: string | null;
  rawMaterialInbound?: { inboundNo: string; status?: string } | null;
  purchaseReceipt?: { receiptNo: string } | null;
  purchaseOrder?: { purchaseOrderNo: string } | null;
  supplier?: SupplierRef | null;
};
type OutsourcePayableSource = {
  id: string; orderNo: string; quantity: string; unitPrice: string; taxRate: string | null; amount: string; currency: string; status: string; createdAt: string;
  material_name?: string | null; material_code?: string | null; material_specification?: string | null; material_color?: string | null; unit_name?: string | null;
  purchaseOrder?: { purchaseOrderNo: string } | null;
  logisticsBatch?: { batchNo: string } | null;
  outsourceReceipt?: { id: string; quantity?: string; receivedAt?: string } | null;
  supplier?: SupplierRef | null;
};
type PayableEntry = {
  id: string; payableNo: string; orderNo: string | null; supplierId: string; sourceType: string; sourceNoSnapshot: string;
  quantity: string; unitPrice: string; taxRate: string | null; amount: string; currency: string; confirmationDate: string; status: string; remark: string | null; createdAt: string;
  source_no?: string | null; purchase_order_no?: string | null; batch_sequence?: number | null;
  material_name?: string | null; material_code?: string | null; material_specification?: string | null; material_color?: string | null; unit_name?: string | null;
  supplier_name?: string | null; supplier_code?: string | null;
  paid_amount?: string; outstanding_amount?: string;
  supplier?: SupplierRef | null;
  allocations?: Array<{ id: string; amount: string; status: string; payment?: { id: string; paymentNo: string; status: string; paymentDate: string; currency?: string } | null }>;
};
type SupplierPayment = {
  id: string; paymentNo: string; supplierId: string; orderNo: string | null; paymentDate: string; amount: string; currency: string;
  paymentMethod: string; bankReference: string | null; payeeName: string | null; status: string; remark: string | null;
  supplier_name: string | null; supplier_code: string | null; allocated_amount: string;
  supplier?: SupplierRef | null;
  bank?: BankRef | null;
  allocations: Array<{ id: string; amount: string; status: string; payableEntry?: { id: string; payableNo: string; orderNo: string; amount: string; currency: string; status: string } | null }>;
};
type SupplierReconciliation = {
  id: string; reconciliationNo: string; orderNo: string | null; supplierId: string; periodStart: string; periodEnd: string;
  payableAmountSnapshot: string; paymentAmountSnapshot: string; adjustmentAmountSnapshot: string; systemBalance: string;
  externalBalance: string; difference: string; currency: string; status: string; resolutionRemark: string | null; remark: string | null; createdAt: string;
  supplier?: SupplierRef | null; purchaseOrder?: { purchaseOrderNo: string } | null;
  bank?: BankRef | null;
  details?: {
    payable_entries: Array<{ id: string; payableNo: string; sourceType: string; sourceNoSnapshot: string; orderNo: string; quantity: string; amount: string; currency: string; status: string; confirmationDate: string }>;
    draft_entries: Array<{ id: string; payableNo: string; amount: string; currency: string; status: string }>;
    entry_count: number; draft_count: number; draft_amount: string; can_confirm_payables: boolean;
    pending_sources: Array<{ id: string; orderNo: string; quantity: string; amount: string; currency: string; source_type: string; source_no: string }>;
  };
};
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void };
type DetailKind = "source" | "entry" | "payment" | "reconciliation";

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : "-");
const monthOf = (value: string | null | undefined) => (value ? value.slice(0, 7) : "-");
const monthRange = (month: string) => ({ start: `${month}-01`, end: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10) });
const materialText = (item: { material_name?: string | null; material_code?: string | null; material_specification?: string | null; material_color?: string | null }) => {
  const name = item.material_name ?? item.material_code;
  if (!name) return "-";
  const spec = [item.material_specification, item.material_color].filter(Boolean).join(" / ");
  return spec ? `${name}（${spec}）` : name;
};
const SOURCE_TYPE_LABELS: Record<string, string> = { raw_material_inbound: "原料入库", purchase_receipt: "采购到货", outsource_receipt: "外加工签收", other: "其他应付" };

export default function PayableWorkspace({ tab, testId }: { tab: PayableTabKey; testId: string }) {
  const [inboundSources, setInboundSources] = useState<PayableSource[]>([]);
  const [outsourceSources, setOutsourceSources] = useState<OutsourcePayableSource[]>([]);
  const [entries, setEntries] = useState<PayableEntry[]>([]);
  const [payments, setPayments] = useState<SupplierPayment[]>([]);
  const [reconciliations, setReconciliations] = useState<SupplierReconciliation[]>([]);
  const [suppliers, setSuppliers] = useState<Reference[]>([]);
  const [orders, setOrders] = useState<Reference[]>([]);
  const [banks, setBanks] = useState<BankRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [detail, setDetail] = useState<{ kind: DetailKind; id: string; row?: unknown } | null>(null);
  const [detailData, setDetailData] = useState<unknown>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailNonce, setDetailNonce] = useState(0);
  const [categoryDialog, setCategoryDialog] = useState<DialogState | null>(null);
  const [pendingDialog, setPendingDialog] = useState<DialogState | null>(null);
  const [currencyCatalogue, setCurrencyCatalogue] = useState<CurrencyOption[]>([]);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [inbound, outsource, e, p, r, s, o, b] = await Promise.all([
        apiGet<PayableSource[]>("/payable-sources"),
        apiGet<OutsourcePayableSource[]>("/production/outsource-logistics-batches/payable-sources"),
        apiGet<PayableEntry[]>("/finance/payable-entries"),
        apiGet<SupplierPayment[]>("/finance/supplier-payments"),
        apiGet<SupplierReconciliation[]>("/finance/supplier-payable-reconciliations"),
        apiGet<Reference[]>("/suppliers").catch(() => ({ data: [] as Reference[], meta: {} })),
        apiGet<Reference[]>("/sales-orders").catch(() => ({ data: [] as Reference[], meta: {} })),
        apiGet<BankRef[]>("/finance/banks").catch(() => ({ data: [] as BankRef[], meta: {} })),
      ]);
      setInboundSources(inbound.data); setOutsourceSources(outsource.data); setEntries(e.data);
      setPayments(p.data); setReconciliations(r.data); setSuppliers(s.data); setOrders(o.data); setBanks(b.data);
    } catch (cause) {
      setError(messageOf(cause, "应付数据加载失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { let cancelled = false; void fetchCurrencyOptions().then((options) => { if (!cancelled) setCurrencyCatalogue(options); }); return () => { cancelled = true; }; }, []);

  async function action(path: string, body: unknown, success: string, method: "post" | "patch" = "post") {
    try {
      await (method === "patch" ? apiPatch(path, body ?? {}) : apiPost(path, body));
      notifySuccess(success);
      setDialog(null);
      setDetail(null);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "操作失败"));
    }
  }

  const detailKind = detail?.kind;
  const detailId = detail?.id;
  const detailRow = detail?.row;
  useEffect(() => {
    if (!detailKind) { setDetailData(null); return; }
    if (detailKind === "source") { setDetailData(detailRow ?? null); setDetailLoading(false); setDetailError(""); return; }
    if (!detailId) { setDetailData(null); return; }
    let cancelled = false;
    const path = detailKind === "entry" ? `/finance/payable-entries/${detailId}` : detailKind === "payment" ? `/finance/supplier-payments/${detailId}` : `/finance/supplier-payable-reconciliations/${detailId}`;
    setDetailLoading(true); setDetailError("");
    apiGet<unknown>(path).then((result) => { if (!cancelled) setDetailData(result.data); })
      .catch((cause) => { if (!cancelled) setDetailError(messageOf(cause, "详情加载失败")); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [detailKind, detailId, detailRow, detailNonce]);

  function createSupplier(values: Record<string, string>) {
    void apiPost<Reference>("/suppliers", {
      supplier_code: values.supplier_code, name: values.name, contact_name: values.contact_name || undefined,
      phone: values.phone || undefined, remark: values.remark || undefined,
    }).then((result) => {
      const created = result.data;
      setSuppliers((items) => [...items, created]);
      const pending = pendingDialog;
      setPendingDialog(null);
      setCategoryDialog(null);
      if (pending) setDialog({ ...pending, fields: pending.fields.map((field) => field.name === "supplier_id" ? { ...field, defaultValue: created.id, options: [...(field.options ?? []), { value: created.id, label: `${created.supplierCode ?? ""} / ${created.name}` }] } : field) });
      notifySuccess("供应商已创建");
    }).catch((cause) => notifyError(messageOf(cause, "供应商创建失败")));
  }

  const supplierOptions = suppliers.map((item) => ({ value: item.id, label: `${item.supplierCode ?? ""} / ${item.name}` }));
  const orderOptions = orders.map((item) => ({ value: item.orderNo ?? item.id, label: item.orderNo ?? item.name }));
  const bankOptions = useMemo(() => banks.filter((b) => b.isActive).map((b) => ({ value: b.id, label: `${b.bankName} / ${b.accountNumber}（${b.accountName}）` })), [banks]);
  const currencyDefault = (preferred: string) => { const options = currencyOptions(currencyCatalogue); return options.some((option) => option.value === preferred) ? preferred : (options[0]?.value ?? preferred); };
  const allocatableEntries = entries.filter((entry) => ["confirmed", "partially_paid"].includes(entry.status) && Number(entry.outstanding_amount ?? entry.amount) > 0);
  const outstandingText = entries.reduce((sum, entry) => sum + Number(entry.outstanding_amount ?? 0), 0);

  // ---------------------------------------------------------------- 操作（全部在表格行内触发，不在页头放按钮）

  function receiveSource(kind: "raw_material_inbound" | "outsource_receipt", source: { id: string; amount: string; currency: string }) {
    setDialog({ title: "接收应付", fields: [
      { name: "amount", label: "应付金额", type: "number", required: true, defaultValue: source.amount },
      { name: "amount_reason", label: "金额差异原因（金额与来源不一致时必填）", type: "textarea" },
      { name: "confirmation_date", label: "确认日期", type: "date", defaultValue: new Date().toISOString().slice(0, 10) },
      { name: "remark", label: "备注", type: "textarea" },
    ], submit: (v) => void action("/finance/payable-entries/from-source", { source_type: kind, source_id: source.id, amount: v.amount, amount_reason: v.amount_reason || undefined, confirmation_date: v.confirmation_date || undefined, remark: v.remark || undefined }, "应付已接收") });
  }
  function editEntry(item: PayableEntry) {
    setDialog({ title: `编辑应付草稿：${item.payableNo}`, fields: [
      { name: "amount", label: "应付金额", type: "number", required: true, defaultValue: item.amount },
      { name: "confirmation_date", label: "确认日期", type: "date", required: true, defaultValue: item.confirmationDate.slice(0, 10) },
      { name: "remark", label: "备注", type: "textarea", defaultValue: item.remark ?? "" },
    ], submit: (v) => void action(`/finance/payable-entries/${item.id}`, { amount: v.amount, confirmation_date: v.confirmation_date, remark: v.remark || undefined }, "应付草稿已更新", "patch") });
  }
  function reopenEntry(item: PayableEntry) {
    setDialog({ title: `应付回退草稿：${item.payableNo}`, fields: [{ name: "reason", label: "回退原因", type: "textarea", required: true }], submit: (v) => void action(`/finance/payable-entries/${item.id}/reopen`, { reason: v.reason }, "应付已回退草稿") });
  }
  function reverseEntry(item: PayableEntry) {
    setDialog({ title: `冲销应付：${item.payableNo}`, fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }], submit: (v) => void action(`/finance/payable-entries/${item.id}/reverse`, { reason: v.reason }, "应付已冲销") });
  }
  function confirmEntry(item: PayableEntry) { void action(`/finance/payable-entries/${item.id}/confirm`, undefined, `应付 ${item.payableNo} 已确认`); }

  function createPaymentForEntry(entry: PayableEntry) {
    const idempotency_key = paymentIdempotencyKey();
    setDialog({ title: `登记付款（对应 ${entry.payableNo}）`, fields: [
      { name: "supplier_id", label: "供应商", type: "select", required: true, canAddCategory: true, options: supplierOptions, defaultValue: entry.supplierId },
      { name: "amount", label: "付款金额", type: "number", required: true, defaultValue: entry.outstanding_amount ?? entry.amount },
      { name: "payment_date", label: "付款日期", type: "date", required: true, defaultValue: new Date().toISOString().slice(0, 10) },
      { name: "payment_method", label: "付款方式", required: true, defaultValue: "银行转账" },
      { name: "currency", label: "币种", type: "select", required: true, options: currencyOptionsWithCurrent(currencyCatalogue, entry.currency ?? "CNY"), defaultValue: entry.currency ?? currencyDefault("CNY") },
      { name: "bank_id", label: "支付银行（可选）", type: "select", options: bankOptions },
      { name: "remark", label: "备注", type: "textarea" },
    ], submit: (v) => void action("/finance/supplier-payments", { supplier_id: v.supplier_id, amount: v.amount, payment_date: v.payment_date, currency: v.currency, payment_method: v.payment_method, bank_id: v.bank_id || undefined, idempotency_key, remark: v.remark || undefined }, "付款草稿已创建") });
  }
  function editPayment(item: SupplierPayment) {
    setDialog({ title: `编辑付款草稿：${item.paymentNo}`, fields: [
      { name: "amount", label: "金额", type: "number", required: true, defaultValue: item.amount },
      { name: "payment_date", label: "日期", type: "date", required: true, defaultValue: item.paymentDate.slice(0, 10) },
      { name: "payment_method", label: "方式", required: true, defaultValue: item.paymentMethod },
      { name: "remark", label: "备注", type: "textarea", defaultValue: item.remark ?? "" },
    ], submit: (v) => void action(`/finance/supplier-payments/${item.id}`, { amount: v.amount, payment_date: v.payment_date, payment_method: v.payment_method, remark: v.remark || undefined }, "付款草稿已更新", "patch") });
  }
  function postPayment(item: SupplierPayment, preset?: PayableEntry) {
    const options = allocatableEntries.map((entry) => ({ value: entry.id, label: `${entry.payableNo} / ${entry.orderNo} / ${entry.supplier_name ?? entry.supplierId} / 未付 ${entry.outstanding_amount ?? entry.amount} ${entry.currency}` }));
    setDialog({ title: `付款核销：${item.paymentNo}`, fields: [
      { name: "entry_id", label: "应付条目", type: "select", required: true, options, defaultValue: preset?.id },
      { name: "amount", label: "本次核销金额", type: "number", required: true, defaultValue: preset?.outstanding_amount ?? item.amount },
    ], submit: (v) => v.entry_id ? void action(`/finance/supplier-payments/${item.id}/post`, { allocations: [{ payable_entry_id: v.entry_id, amount: v.amount }] }, "付款已过账并核销") : undefined });
  }
  function reversePayment(item: SupplierPayment) {
    setDialog({ title: `冲销付款：${item.paymentNo}`, fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }], submit: (v) => void action(`/finance/supplier-payments/${item.id}/reverse`, { reason: v.reason }, "付款已冲销") });
  }

  function createOtherPayable() {
    setDialog({ title: "新建其他应付（非订单支出）", fields: [
      { name: "supplier_id", label: "供应商", type: "select", required: true, canAddCategory: true, options: supplierOptions },
      { name: "amount", label: "应付金额", type: "number", required: true },
      { name: "currency", label: "币种", type: "select", required: true, options: currencyOptions(currencyCatalogue), defaultValue: currencyDefault("CNY") },
      { name: "description", label: "支出说明（如差旅费、办公费等）", required: true },
      { name: "confirmation_date", label: "确认日期", type: "date", defaultValue: new Date().toISOString().slice(0, 10) },
      { name: "remark", label: "备注", type: "textarea" },
    ], submit: (v) => void action("/finance/payable-entries/other", { supplier_id: v.supplier_id, amount: v.amount, currency: v.currency, description: v.description, confirmation_date: v.confirmation_date || undefined, remark: v.remark || undefined }, "其他应付已创建") });
  }

  function createReconciliation(preset?: { supplierId: string; month: string }) {
    const range = preset ? monthRange(preset.month) : undefined;
    setDialog({ title: "创建应付对账", fields: [
      { name: "supplier_id", label: "供应商", type: "select", required: true, canAddCategory: true, options: supplierOptions, defaultValue: preset?.supplierId },
      { name: "order_no", label: "订单号（可选）", type: "select", options: orderOptions },
      { name: "period_start", label: "期间开始", type: "date", required: true, defaultValue: range?.start },
      { name: "period_end", label: "期间结束", type: "date", required: true, defaultValue: range?.end },
      { name: "external_balance", label: "外部应付余额（供应商对账单金额）", type: "number", required: true },
      { name: "currency", label: "币种", type: "select", required: true, options: currencyOptions(currencyCatalogue), defaultValue: currencyDefault("CNY") },
      { name: "bank_id", label: "支付银行（可选）", type: "select", options: bankOptions },
      { name: "remark", label: "备注", type: "textarea" },
    ], submit: (v) => void action("/finance/supplier-payable-reconciliations", { supplier_id: v.supplier_id, order_no: v.order_no || undefined, period_start: v.period_start, period_end: v.period_end, external_balance: v.external_balance, currency: v.currency, bank_id: v.bank_id || undefined, remark: v.remark || undefined }, "应付对账单已创建") });
  }
  function resolveReconciliation(item: SupplierReconciliation) {
    setDialog({ title: `处理应付对账差异：${item.reconciliationNo}`, fields: [{ name: "remark", label: "处理说明", type: "textarea", required: true, defaultValue: "已核对" }], submit: (v) => void action(`/finance/supplier-payable-reconciliations/${item.id}/resolve`, { resolution_remark: v.remark }, "应付对账差异已处理") });
  }

  // ---------------------------------------------------------------- 列表

  const inboundList = useMemo(() => inboundSources.filter((item) => item.rawMaterialInbound), [inboundSources]);
  const match = useCallback((values: Array<string | null | undefined>) => {
    const text = filter.trim().toLowerCase();
    if (!text) return true;
    return values.some((value) => (value ?? "").toLowerCase().includes(text));
  }, [filter]);
  const filteredInbound = useMemo(() => inboundList.filter((item) => match([item.rawMaterialInbound?.inboundNo, item.orderNo, item.purchase_order_no, item.supplier?.name, item.material_name])), [inboundList, match]);
  const filteredOutsource = useMemo(() => outsourceSources.filter((item) => match([item.logisticsBatch?.batchNo, item.orderNo, item.supplier?.name, item.material_name])), [outsourceSources, match]);
  const filteredEntries = useMemo(() => entries.filter((item) => match([item.payableNo, item.orderNo, item.supplier_name, item.material_name, item.purchase_order_no])), [entries, match]);
  const filteredPayments = useMemo(() => payments.filter((item) => match([item.paymentNo, item.orderNo, item.supplier_name])), [payments, match]);

  const pendingGroups = useMemo(() => {
    const map = new Map<string, { supplierId: string; supplierName: string; month: string; count: number; amount: number }>();
    for (const entry of entries) {
      if (entry.status !== "draft") continue;
      const month = monthOf(entry.confirmationDate ?? entry.createdAt);
      const key = `${entry.supplierId}|${month}`;
      const group = map.get(key) ?? { supplierId: entry.supplierId, supplierName: entry.supplier_name ?? entry.supplierId, month, count: 0, amount: 0 };
      group.count += 1;
      group.amount += Number(entry.amount);
      map.set(key, group);
    }
    return [...map.values()].sort((a, b) => (a.month === b.month ? a.supplierName.localeCompare(b.supplierName) : b.month.localeCompare(a.month)));
  }, [entries]);

  const inboundColumns: ColumnDef<PayableSource>[] = [
    { id: "source", header: "入库单号", cell: ({ row }) => row.original.rawMaterialInbound?.inboundNo ?? row.original.id.slice(0, 8) },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "purchaseOrder", header: "采购单号", cell: ({ row }) => row.original.purchase_order_no ?? row.original.purchaseOrder?.purchaseOrderNo ?? "-" },
    { id: "batch", header: "批次", cell: ({ row }) => row.original.batch_sequence ? `第 ${row.original.batch_sequence} 批` : "-" },
    { id: "supplier", header: "供应商", cell: ({ row }) => row.original.supplier?.name ?? "-" },
    { id: "material", header: "原料", cell: ({ row }) => materialText(row.original) },
    { id: "quantity", header: "入库数量", cell: ({ row }) => `${row.original.quantity}${row.original.unit_name ? ` ${row.original.unit_name}` : ""}` },
    { id: "unitPrice", header: "单价", cell: ({ row }) => row.original.settlementUnitPrice ?? row.original.unitPrice },
    { id: "amount", header: "应付金额", cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "status", header: "来源状态", cell: ({ row }) => financeStatus(row.original.status, "source") },
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">{row.original.status === "pending_finance" ? <Button size="sm" variant="secondary" onClick={() => receiveSource("raw_material_inbound", row.original)}>接收应付</Button> : <span className="panel-note">已接收</span>}</div> },
  ];
  const outsourceColumns: ColumnDef<OutsourcePayableSource>[] = [
    { id: "batch", header: "外加工批次", cell: ({ row }) => row.original.logisticsBatch?.batchNo ?? "-" },
    { id: "receipt", header: "签收单", cell: ({ row }) => row.original.outsourceReceipt?.id?.slice(0, 8) ?? "-" },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "purchaseOrder", header: "采购单号", cell: ({ row }) => row.original.purchaseOrder?.purchaseOrderNo ?? "-" },
    { id: "supplier", header: "供应商", cell: ({ row }) => row.original.supplier?.name ?? "-" },
    { id: "material", header: "原料", cell: ({ row }) => materialText(row.original) },
    { id: "quantity", header: "签收数量", cell: ({ row }) => `${row.original.quantity}${row.original.unit_name ? ` ${row.original.unit_name}` : ""}` },
    { id: "unitPrice", header: "单价", cell: ({ row }) => row.original.unitPrice },
    { id: "amount", header: "应付金额", cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "status", header: "来源状态", cell: ({ row }) => financeStatus(row.original.status, "source") },
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">{row.original.status === "pending_finance" ? <Button size="sm" variant="secondary" onClick={() => receiveSource("outsource_receipt", row.original)}>接收应付</Button> : <span className="panel-note">已接收</span>}</div> },
  ];
  const entryColumns: ColumnDef<PayableEntry>[] = [
    { accessorKey: "payableNo", header: "应付单号" },
    { id: "sourceNo", header: "来源批次", cell: ({ row }) => row.original.source_no ?? row.original.sourceNoSnapshot },
    { id: "sourceType", header: "来源", cell: ({ row }) => SOURCE_TYPE_LABELS[row.original.sourceType] ?? row.original.sourceType },
    { id: "orderNo", header: "订单号", cell: ({ row }) => row.original.orderNo ?? (row.original.sourceType === "other" ? "无" : "-") },
    { id: "supplier", header: "供应商", cell: ({ row }) => row.original.supplier_name ?? row.original.supplier?.name ?? "-" },
    { id: "material", header: "原料 / 说明", cell: ({ row }) => row.original.sourceType === "other" ? row.original.sourceNoSnapshot : materialText(row.original) },
    { id: "amount", header: "应付金额", cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "paid", header: "已付", cell: ({ row }) => money(row.original.paid_amount, row.original.currency) },
    { id: "outstanding", header: "未付", cell: ({ row }) => money(row.original.outstanding_amount, row.original.currency) },
    { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "payable") },
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">
      {row.original.status === "draft" && <><Button size="sm" variant="secondary" onClick={() => confirmEntry(row.original)}>确认应付</Button><Button size="sm" variant="ghost" onClick={() => editEntry(row.original)}>编辑</Button></>}
      {row.original.status === "confirmed" && <><Button size="sm" variant="secondary" onClick={() => createPaymentForEntry(row.original)}>登记付款</Button><Button size="sm" variant="ghost" onClick={() => reopenEntry(row.original)}>回退</Button></>}
      {["partially_paid"].includes(row.original.status) && <Button size="sm" variant="secondary" onClick={() => createPaymentForEntry(row.original)}>登记付款</Button>}
    </div> },
  ];
  const paymentColumns: ColumnDef<SupplierPayment>[] = [
    { accessorKey: "paymentNo", header: "付款单号" },
    { id: "date", header: "日期", cell: ({ row }) => day(row.original.paymentDate) },
    { id: "supplier", header: "供应商", cell: ({ row }) => row.original.supplier_name ?? "-" },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "amount", header: "金额", cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "allocated", header: "已核销", cell: ({ row }) => money(row.original.allocated_amount, row.original.currency) },
    { accessorKey: "paymentMethod", header: "方式" },
    { id: "bank", header: "支付银行", cell: ({ row }) => row.original.bank ? `${row.original.bank.bankName}（${row.original.bank.accountNumber}）` : "-" },
    { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "payable") },
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">
      {row.original.status === "draft" && <><Button size="sm" variant="secondary" onClick={() => postPayment(row.original)}>过账/核销</Button><Button size="sm" variant="ghost" onClick={() => editPayment(row.original)}>编辑</Button></>}
      {row.original.status === "posted" && <Button size="sm" variant="destructive" onClick={() => reversePayment(row.original)}>冲销</Button>}
    </div> },
  ];
  const reconciliationColumns: ColumnDef<SupplierReconciliation>[] = [
    { accessorKey: "reconciliationNo", header: "对账单号" },
    { id: "supplier", header: "供应商", cell: ({ row }) => row.original.supplier?.name ?? "-" },
    { id: "order", header: "订单号", cell: ({ row }) => row.original.orderNo ?? "全部订单" },
    { id: "period", header: "期间", cell: ({ row }) => `${day(row.original.periodStart)} 至 ${day(row.original.periodEnd)}` },
    { id: "payable", header: "应付快照", cell: ({ row }) => money(row.original.payableAmountSnapshot, row.original.currency) },
    { id: "paid", header: "已付快照", cell: ({ row }) => money(row.original.paymentAmountSnapshot, row.original.currency) },
    { id: "system", header: "系统余额", cell: ({ row }) => money(row.original.systemBalance, row.original.currency) },
    { id: "external", header: "外部余额", cell: ({ row }) => money(row.original.externalBalance, row.original.currency) },
    { id: "difference", header: "差异", cell: ({ row }) => money(row.original.difference, row.original.currency) },
    { id: "bank", header: "支付银行", cell: ({ row }) => row.original.bank ? `${row.original.bank.bankName}（${row.original.bank.accountNumber}）` : "-" },
    { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "reconciliation") },
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">
      {row.original.status === "difference" && <Button size="sm" variant="secondary" onClick={() => resolveReconciliation(row.original)}>处理差异</Button>}
      {["matched", "resolved"].includes(row.original.status) && row.original.details?.draft_count ? <span className="panel-note">到「确认应付」确认 {row.original.details.draft_count} 条</span> : null}
    </div> },
  ];
  const pendingGroupColumns: ColumnDef<{ supplierId: string; supplierName: string; month: string; count: number; amount: number }>[] = [
    { id: "supplier", header: "供应商", cell: ({ row }) => row.original.supplierName },
    { id: "month", header: "待对账月份", cell: ({ row }) => row.original.month },
    { id: "count", header: "待确认应付条目", cell: ({ row }) => `${row.original.count} 条` },
    { id: "amount", header: "待确认金额", cell: ({ row }) => row.original.amount.toFixed(2) },
    { id: "actions", header: "操作", cell: ({ row }) => <Button size="sm" variant="secondary" onClick={() => createReconciliation({ supplierId: row.original.supplierId, month: row.original.month })}>创建对账</Button> },
  ];

  // ---------------------------------------------------------------- 详情

  function sourceFields(item: PayableSource | OutsourcePayableSource, kind: "inbound" | "outsource"): DetailField[] {
    const common: DetailField[] = [
      { label: "来源类型", value: kind === "inbound" ? "原料入库" : "外加工签收" },
      { label: "来源状态", value: financeStatus(item.status, "source") },
      { label: "订单号", value: item.orderNo },
      { label: "采购单号", value: item.purchaseOrder?.purchaseOrderNo ?? ("purchase_order_no" in item ? item.purchase_order_no : null) },
      { label: "供应商", value: item.supplier?.name ?? item.supplier?.supplierCode },
      { label: "原料", value: materialText(item) },
      { label: "数量", value: `${item.quantity}${item.unit_name ? ` ${item.unit_name}` : ""}` },
      { label: "单价", value: ("settlementUnitPrice" in item ? item.settlementUnitPrice : null) ?? item.unitPrice },
      { label: "税率", value: item.taxRate },
      { label: "应付金额", value: money(item.amount, item.currency) },
      { label: "创建时间", value: day(item.createdAt) },
    ];
    if (kind === "inbound") {
      const inbound = item as PayableSource;
      return [...common,
        { label: "入库单号", value: inbound.rawMaterialInbound?.inboundNo },
        { label: "入库单状态", value: financeStatus(inbound.rawMaterialInbound?.status) },
        { label: "采购批次", value: inbound.batch_sequence ? `第 ${inbound.batch_sequence} 批` : "-" },
        { label: "质检结论", value: inbound.qcResult },
        { label: "实际入库数量", value: inbound.actualInboundQuantity },
        { label: "合格数量", value: inbound.acceptedQuantity },
        { label: "让步接收数量", value: inbound.conditionalQuantity },
        { label: "不合格数量", value: inbound.rejectedQuantity },
        { label: "结算单价", value: inbound.settlementUnitPrice },
        { label: "结算总价", value: inbound.settlementTotalAmount },
        { label: "结算金额原因", value: inbound.settlementAmountReason, wide: true },
      ];
    }
    const outsource = item as OutsourcePayableSource;
    return [...common,
      { label: "外加工批次", value: outsource.logisticsBatch?.batchNo },
      { label: "签收单号", value: outsource.outsourceReceipt?.id },
      { label: "签收时间", value: day(outsource.outsourceReceipt?.receivedAt) },
    ];
  }

  function detailFields(): DetailField[] {
    if (detail?.kind === "source" && detailData) return sourceFields(detailData as PayableSource | OutsourcePayableSource, (detailData as PayableSource).rawMaterialInbound ? "inbound" : "outsource");
    if (detail?.kind === "entry" && detailData) {
      const item = detailData as PayableEntry;
      return [
        { label: "应付单号", value: item.payableNo }, { label: "状态", value: financeStatus(item.status, "payable") },
        { label: "来源类型", value: SOURCE_TYPE_LABELS[item.sourceType] ?? item.sourceType }, { label: "来源批次", value: item.source_no ?? item.sourceNoSnapshot },
        { label: "订单号", value: item.orderNo }, { label: "供应商", value: item.supplier?.name ?? item.supplier_name ?? item.supplierId },
        { label: "采购单号", value: item.purchase_order_no }, { label: "原料", value: materialText(item) },
        { label: "数量", value: `${item.quantity}${item.unit_name ? ` ${item.unit_name}` : ""}` },
        { label: "单价", value: item.unitPrice }, { label: "税率", value: item.taxRate },
        { label: "应付金额", value: money(item.amount, item.currency) },
        { label: "已付金额", value: money(item.paid_amount, item.currency) }, { label: "未付金额", value: money(item.outstanding_amount, item.currency) },
        { label: "确认日期", value: day(item.confirmationDate) }, { label: "创建时间", value: day(item.createdAt) },
        { label: "备注", value: item.remark, wide: true },
      ];
    }
    if (detail?.kind === "payment" && detailData) {
      const item = detailData as SupplierPayment;
      return [
        { label: "付款单号", value: item.paymentNo }, { label: "状态", value: financeStatus(item.status, "payable") },
        { label: "供应商", value: item.supplier?.name ?? item.supplier_name ?? item.supplierId }, { label: "订单号", value: item.orderNo },
        { label: "付款日期", value: day(item.paymentDate) }, { label: "付款金额", value: money(item.amount, item.currency) },
        { label: "已核销金额", value: money(item.allocated_amount, item.currency) }, { label: "付款方式", value: item.paymentMethod },
        { label: "银行流水号", value: item.bankReference }, { label: "收款人", value: item.payeeName },
        { label: "支付银行", value: item.bank ? `${item.bank.bankName} / ${item.bank.accountNumber}（${item.bank.accountName}）` : "-" },
        { label: "备注", value: item.remark, wide: true },
      ];
    }
    if (detail?.kind === "reconciliation" && detailData) {
      const item = detailData as SupplierReconciliation;
      return [
        { label: "对账单号", value: item.reconciliationNo }, { label: "状态", value: financeStatus(item.status, "reconciliation") },
        { label: "供应商", value: item.supplier?.name ?? item.supplierId }, { label: "订单号", value: item.orderNo ?? "全部订单" },
        { label: "采购单号", value: item.purchaseOrder?.purchaseOrderNo },
        { label: "期间", value: `${day(item.periodStart)} 至 ${day(item.periodEnd)}` },
        { label: "应付快照", value: money(item.payableAmountSnapshot, item.currency) },
        { label: "已付快照", value: money(item.paymentAmountSnapshot, item.currency) },
        { label: "系统余额", value: money(item.systemBalance, item.currency) },
        { label: "外部余额", value: money(item.externalBalance, item.currency) },
        { label: "差异", value: money(item.difference, item.currency) },
        { label: "支付银行", value: item.bank ? `${item.bank.bankName} / ${item.bank.accountNumber}（${item.bank.accountName}）` : "-" },
        { label: "纳入条目数", value: item.details ? `${item.details.entry_count} 条（待确认 ${item.details.draft_count} 条 / ${item.details.draft_amount}）` : "-" },
        { label: "差异处理说明", value: item.resolutionRemark, wide: true },
        { label: "创建时间", value: day(item.createdAt) }, { label: "备注", value: item.remark, wide: true },
      ];
    }
    return [];
  }

  function detailSections() {
    if (detail?.kind === "entry" && detailData) {
      const item = detailData as PayableEntry;
      const allocations = item.allocations ?? [];
      return [{ title: `付款核销记录（${allocations.length} 条）`, note: "只统计有效核销；已冲销付款的核销不计入未付余额。", content: allocations.length
        ? <DataTable pageSize={10} columns={[{ id: "payment", header: "付款单号", cell: ({ row }) => row.original.payment?.paymentNo ?? "-" }, { id: "date", header: "付款日期", cell: ({ row }) => day(row.original.payment?.paymentDate) }, { id: "status", header: "付款状态", cell: ({ row }) => financeStatus(row.original.payment?.status, "payable") }, { id: "amount", header: "核销金额", cell: ({ row }) => money(row.original.amount, row.original.payment?.currency ?? item.currency) }] as ColumnDef<NonNullable<PayableEntry["allocations"]>[number]>[]} data={allocations} /> : <p className="panel-note">暂无付款核销</p> }];
    }
    if (detail?.kind === "payment" && detailData) {
      const item = detailData as SupplierPayment;
      const allocations = item.allocations ?? [];
      return [{ title: `核销明细（${allocations.length} 条）`, content: allocations.length
        ? <DataTable pageSize={10} columns={[{ id: "entry", header: "应付单号", cell: ({ row }) => row.original.payableEntry?.payableNo ?? "-" }, { id: "order", header: "订单号", cell: ({ row }) => row.original.payableEntry?.orderNo ?? "-" }, { id: "entryStatus", header: "应付状态", cell: ({ row }) => financeStatus(row.original.payableEntry?.status, "payable") }, { id: "status", header: "核销状态", cell: ({ row }) => financeStatus(row.original.status) }, { id: "amount", header: "核销金额", cell: ({ row }) => money(row.original.amount, row.original.payableEntry?.currency ?? item.currency) }] as ColumnDef<SupplierPayment["allocations"][number]>[]} data={allocations} /> : <p className="panel-note">该付款尚未核销任何应付</p> }];
    }
    if (detail?.kind === "reconciliation" && detailData) {
      const item = detailData as SupplierReconciliation;
      const ents = item.details?.payable_entries ?? [];
      const pending = item.details?.pending_sources ?? [];
      return [
        { title: `纳入对账的应付条目（${ents.length} 条）`, note: "对平（或差异已处理）后，到「确认应付」逐条或批量确认其中的草稿应付。", content: ents.length
          ? <DataTable pageSize={10} columns={[{ accessorKey: "payableNo", header: "应付单号" }, { accessorKey: "sourceNoSnapshot", header: "来源批次" }, { accessorKey: "orderNo", header: "订单号" }, { id: "amount", header: "金额", cell: ({ row }) => money(row.original.amount, row.original.currency) }, { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "payable") }] as ColumnDef<NonNullable<SupplierReconciliation["details"]>["payable_entries"][number]>[]} data={ents} /> : <p className="panel-note">该期间没有纳入对账的应付条目</p> },
        { title: `仍待接收的来源（${pending.length} 条）`, note: "这些业务事实还没有被财务接收为应付，不计入系统余额。", content: pending.length
          ? <DataTable pageSize={10} columns={[{ accessorKey: "source_no", header: "来源批次" }, { accessorKey: "orderNo", header: "订单号" }, { accessorKey: "quantity", header: "数量" }, { id: "amount", header: "金额", cell: ({ row }) => money(row.original.amount, row.original.currency) }] as ColumnDef<NonNullable<SupplierReconciliation["details"]>["pending_sources"][number]>[]} data={pending} /> : <p className="panel-note">该期间没有待接收来源</p> },
      ];
    }
    return [];
  }

  function detailActions() {
    if (!detailData) return null;
    if (detail?.kind === "source") {
      const item = detailData as PayableSource | OutsourcePayableSource;
      if (item.status !== "pending_finance") return null;
      const kind = (detailData as PayableSource).rawMaterialInbound ? "raw_material_inbound" : "outsource_receipt";
      return <Button onClick={() => receiveSource(kind, item)}>接收应付</Button>;
    }
    if (detail?.kind === "entry") {
      const item = detailData as PayableEntry;
      return <>
        {item.status === "draft" && <><Button onClick={() => confirmEntry(item)}>确认应付</Button><Button variant="secondary" onClick={() => editEntry(item)}>编辑草稿</Button></>}
        {item.status === "confirmed" && <><Button onClick={() => createPaymentForEntry(item)}>登记付款</Button><Button variant="secondary" onClick={() => reopenEntry(item)}>回退草稿</Button></>}
        {item.status === "partially_paid" && <Button onClick={() => createPaymentForEntry(item)}>登记付款</Button>}
        {["confirmed", "partially_paid", "paid"].includes(item.status) && <Button variant="destructive" onClick={() => reverseEntry(item)}>冲销应付</Button>}
      </>;
    }
    if (detail?.kind === "payment") {
      const item = detailData as SupplierPayment;
      return <>
        {item.status === "draft" && <><Button onClick={() => postPayment(item)}>过账/核销</Button><Button variant="secondary" onClick={() => editPayment(item)}>编辑草稿</Button></>}
        {item.status === "posted" && <Button variant="destructive" onClick={() => reversePayment(item)}>冲销付款</Button>}
      </>;
    }
    if (detail?.kind === "reconciliation") {
      const item = detailData as SupplierReconciliation;
      return <>
        {item.status === "difference" && <Button onClick={() => resolveReconciliation(item)}>处理差异</Button>}
      </>;
    }
    return null;
  }

  const detailTitle = detail?.kind === "source" ? "应付来源详情" : detail?.kind === "entry" ? `应付条目 ${(detailData as PayableEntry | null)?.payableNo ?? ""}` : detail?.kind === "payment" ? `供应商付款 ${(detailData as SupplierPayment | null)?.paymentNo ?? ""}` : `应付对账 ${(detailData as SupplierReconciliation | null)?.reconciliationNo ?? ""}`;
  const activeTab = PAYABLE_TABS.find((item) => item.key === tab) ?? PAYABLE_TABS[0];

  if (loading) return <><PageHeader title="应付管理" /><LoadingState /></>;

  return <div className="page-root" data-testid={testId}>
    <PageHeader title="应付管理" description={activeTab.description}>
      <Button asChild variant="secondary"><Link href="/finance">返回财务</Link></Button>
    </PageHeader>
    <FinanceTabs basePath="/finance/payable" tabs={PAYABLE_TABS} active={activeTab.key} />
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []}
      onAddCategory={(field) => { if (field.name !== "supplier_id") return; setPendingDialog(dialog); setDialog(null); setCategoryDialog({ title: "新建供应商", fields: [
        { name: "supplier_code", label: "供应商编码", required: true }, { name: "name", label: "供应商名称", required: true },
        { name: "contact_name", label: "联系人" }, { name: "phone", label: "联系电话" }, { name: "remark", label: "备注", type: "textarea" },
      ], submit: createSupplier }); }}
      onSubmit={(values) => { dialog?.submit(values); }} />
    <ActionDialog open={Boolean(categoryDialog)} onOpenChange={(open) => { if (!open) { setCategoryDialog(null); setPendingDialog(null); } }} title={categoryDialog?.title ?? "新建供应商"} fields={categoryDialog?.fields ?? []} onSubmit={(values) => { categoryDialog?.submit(values); }} />
    <RecordDetailDialog
      open={Boolean(detail)}
      onOpenChange={(open) => { if (!open) setDetail(null); }}
      title={detailTitle}
      description="双击列表行打开的详情：展示该条目的全部字段与当前可执行操作。"
      fields={detailFields()}
      sections={detailSections()}
      actions={detailActions()}
      loading={detailLoading}
      error={detailError}
      onRetry={() => setDetailNonce((value) => value + 1)}
    />
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    {!error && <section className="panel panel-body">
      <div className="filter-bar"><label>搜索<Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="单号 / 订单号 / 供应商 / 原料" /></label></div>
      <p className="panel-note">待接收来源 {inboundList.filter((item) => item.status === "pending_finance").length + outsourceSources.filter((item) => item.status === "pending_finance").length} 条；已确认未付 {outstandingText.toFixed(2)}。双击任意一行查看全部字段。</p>
    </section>}
    {!error && activeTab.key === "raw-inbound-entries" && <section className="panel">
      <div className="panel-heading"><h2>原料入库条目</h2><span className="panel-note">原料入库过账自动生成；接收后成为应付草稿，确认后才允许付款核销</span></div>
      <div className="panel-body"><DataTable columns={inboundColumns} data={filteredInbound} empty={<EmptyState title="暂无原料入库形成的应付来源" />} onRowDoubleClick={(row) => setDetail({ kind: "source", id: row.id, row })} rowTitle="双击查看详情" /></div>
    </section>}
    {!error && activeTab.key === "outsource-entries" && <section className="panel">
      <div className="panel-heading"><h2>外加工签收</h2><span className="panel-note">按实际签收数量形成应付来源；直发数量本身不形成应付</span></div>
      <div className="panel-body"><DataTable columns={outsourceColumns} data={filteredOutsource} empty={<EmptyState title="暂无外加工签收形成的应付来源" />} onRowDoubleClick={(row) => setDetail({ kind: "source", id: row.id, row })} rowTitle="双击查看详情" /></div>
    </section>}
    {!error && activeTab.key === "reconciliations" && <section className="panel">
      <div className="panel-heading"><h2>应付对账</h2><span className="panel-note">按供应商 + 月份汇总待确认的应付草稿创建对账；对平后到「确认应付」去确认</span></div>
      <div className="panel-body">
        <h3>待创建对账</h3>
        <DataTable columns={pendingGroupColumns} data={pendingGroups} empty={<EmptyState title="没有待创建对账的条目" description="接收应付来源后，草稿条目汇总在这里。按供应商 + 月份创建对账。" />} />
        <h3>已创建对账单</h3>
        <DataTable columns={reconciliationColumns} data={reconciliations} empty={<EmptyState title="暂无应付对账单" />} onRowDoubleClick={(row) => setDetail({ kind: "reconciliation", id: row.id })} rowTitle="双击查看详情" />
      </div>
    </section>}
    {!error && activeTab.key === "confirmed" && <section className="panel">
      <div className="panel-heading"><h2>确认应付</h2><span className="panel-note">应付台账 + 付款在同一视图；草稿逐条确认，确认后登记付款、核销与冲销。所有操作在行内完成。</span></div>
      <div className="panel-body">
        <div style={{ marginBottom: "0.5rem", display: "flex", gap: "0.5rem" }}>
          <Button size="sm" variant="secondary" onClick={createOtherPayable}>新建其他应付</Button>
        </div>
        <h3>应付台账</h3>
        <DataTable columns={entryColumns} data={filteredEntries} empty={<EmptyState title="暂无应付条目" />} onRowDoubleClick={(row) => setDetail({ kind: "entry", id: row.id })} rowTitle="双击查看详情" />
        <h3>付款</h3>
        <DataTable columns={paymentColumns} data={filteredPayments} empty={<EmptyState title="暂无付款记录" />} onRowDoubleClick={(row) => setDetail({ kind: "payment", id: row.id })} rowTitle="双击查看详情" />
      </div>
    </section>}
  </div>;
}
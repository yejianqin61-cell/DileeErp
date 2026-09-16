"use client";

// 应付管理二级页（/finance/payable?tab=...）。
//
// 四个子栏目：
//   1. 原料入库条目：原料入库过账生成的**待接收**应付来源；
//   2. 外加工签收：外加工实际签收生成的**待接收**应付来源；
//   3. 应付对账：对账创建 + 对账单列表合并在同一视图；
//   4. 确认应付：应付台账，**勾选多条一次确认**（确认即记账，金额从所选银行账户支出）。
// 双击任意行弹出居中详情（展示全部字段与当前可执行操作）。
//
// 2026-09-16（用户要求，三条）：
//   ① 说明性语句全部去掉，界面只留数据；
//   ② **已接收**的来源不再出现在两个「待接收」列表里（它已经是应付草稿了，看草稿就行）；
//   ③ 不再有「登记付款 → 过账核销」这第二遍流程 —— 确认应付已经把金额从账户上支出了，
//      再登记一次付款等于同一笔钱扣两次；所以确认这边只保留「勾选 + 批量确认」。
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
import { PAYABLE_TABS, CASH_FLOW_ITEM_DICTIONARY_KEY, type PayableTabKey } from "../../lib/finance-sections";
import { notifyError, notifySuccess } from "../ui/toaster";
import { FinanceTabs } from "./finance-tabs";
import { RecordDetailDialog, money, type DetailField } from "./record-detail-dialog";
import { financeStatus } from "./finance-status";

/** 银行下拉的「清空」哨兵值（见 bankField / bankValue）：Radix Select 不接受空串 value。 */
const BANK_CLEAR = "__no_bank__";
/**
 * 收支项目下拉的「清空」哨兵值（同银行的理由）：已有单据上的项目要能去掉 PATCH 送 null，
 * 但未改动时必须送 undefined，否则每次编辑都会把单据上已有的项目一并抹掉。
 */
const CASH_FLOW_ITEM_CLEAR = "__no_cash_flow_item__";

type Reference = { id: string; name: string; supplierCode?: string; orderNo?: string };
type SupplierRef = { id: string; name: string; supplierCode: string | null };
type BankRef = { id: string; bankCode: string; bankName: string; accountName: string; accountNumber: string; currency: string; isActive: boolean; swiftCode: string | null; remark: string | null };
/** 来源已经接收成的那张应付单（列表接口的 payable_entry）：有它就说明这条来源不需要再接收。 */
type SourcePayableLink = { id: string; payableNo: string; status: string };
type PayableSource = {
  id: string; orderNo: string; quantity: string; unitPrice: string; taxRate: string | null; amount: string; currency: string; status: string;
  qcResult: string | null; actualInboundQuantity: string | null; acceptedQuantity: string | null; conditionalQuantity: string | null; rejectedQuantity: string | null;
  settlementUnitPrice: string | null; settlementTotalAmount: string | null; settlementAmountReason: string | null;
  createdAt: string;
  purchase_order_no?: string | null; batch_sequence?: number | null;
  material_name?: string | null; material_code?: string | null; material_specification?: string | null; material_color?: string | null; unit_name?: string | null;
  payable_entry?: SourcePayableLink | null;
  rawMaterialInbound?: { inboundNo: string; status?: string } | null;
  purchaseReceipt?: { receiptNo: string } | null;
  purchaseOrder?: { purchaseOrderNo: string } | null;
  supplier?: SupplierRef | null;
};
type OutsourcePayableSource = {
  id: string; orderNo: string; quantity: string; unitPrice: string; taxRate: string | null; amount: string; currency: string; status: string; createdAt: string;
  material_name?: string | null; material_code?: string | null; material_specification?: string | null; material_color?: string | null; unit_name?: string | null;
  payable_entry?: SourcePayableLink | null;
  purchaseOrder?: { purchaseOrderNo: string } | null;
  logisticsBatch?: { batchNo: string } | null;
  outsourceReceipt?: { id: string; quantity?: string; receivedAt?: string } | null;
  supplier?: SupplierRef | null;
};
/** 覆盖这条应付的对账单（列表接口算好给前端：对账范围含 purchaseOrderId，前端推不出来）。 */
type ReconciliationRef = { id: string; reconciliation_no: string; status: string; period_start: string; period_end: string };
type PayableEntry = {
  id: string; payableNo: string; orderNo: string | null; supplierId: string; sourceType: string; sourceNoSnapshot: string;
  quantity: string; unitPrice: string; taxRate: string | null; amount: string; currency: string; confirmationDate: string; status: string; remark: string | null; createdAt: string;
  source_no?: string | null; purchase_order_no?: string | null; batch_sequence?: number | null;
  material_name?: string | null; material_code?: string | null; material_specification?: string | null; material_color?: string | null; unit_name?: string | null;
  supplier_name?: string | null; supplier_code?: string | null;
  paid_amount?: string; outstanding_amount?: string;
  reconciliation?: ReconciliationRef | null;
  supplier?: SupplierRef | null;
  allocations?: Array<{ id: string; amount: string; status: string; payment?: { id: string; paymentNo: string; status: string; paymentDate: string; currency?: string } | null }>;
};
/** 收支项目字典项（财务 → 收支管理 → 收支项目）。 */
type DictionaryItem = { id: string; key: string; label: string; isActive: boolean };
type SupplierReconciliation = {
  id: string; reconciliationNo: string; orderNo: string | null; supplierId: string; periodStart: string; periodEnd: string;
  payableAmountSnapshot: string; paymentAmountSnapshot: string; adjustmentAmountSnapshot: string; systemBalance: string;
  externalBalance: string; difference: string; currency: string; status: string; resolutionRemark: string | null; remark: string | null; createdAt: string;
  supplier?: SupplierRef | null; purchaseOrder?: { purchaseOrderNo: string } | null;
  bank?: BankRef | null;
  /** 建单/确认时人工选定的收支项目（确认应付记流水时用它，除非确认接口再覆盖）。 */
  cashFlowItemId?: string | null;
  /** 流转摘要（列表接口就给，不必再点开详情）：覆盖多少条应付、其中多少条待确认。 */
  flow?: {
    entry_count: number; draft_count: number; draft_amount: string; can_confirm_payables: boolean;
    order_nos: string[]; purchase_order_nos: string[]; material_names: string[]; material_specifications: string[];
  };
  details?: {
    payable_entries: Array<{ id: string; payableNo: string; sourceType: string; sourceNoSnapshot: string; orderNo: string; quantity: string; amount: string; currency: string; status: string; confirmationDate: string; material_name?: string | null; material_specification?: string | null; unit_name?: string | null; purchase_order_no?: string | null }>;
    draft_entries: Array<{ id: string; payableNo: string; amount: string; currency: string; status: string }>;
    entry_count: number; draft_count: number; draft_amount: string; can_confirm_payables: boolean;
    pending_sources: Array<{ id: string; orderNo: string; quantity: string; amount: string; currency: string; source_type: string; source_no: string }>;
  };
};
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> };
/**
 * 「确认应付」三个入口（逐条 / 勾选批量 / 按对账单）共用的响应字段（见 submitConfirm）。
 * `bank_missing` 表示钱记进了收支流水、但不属于任何银行账户（不进任何银行余额）。
 */
type ConfirmResult = {
  bank_missing?: boolean; amount?: string; currency?: string;
  confirmed_amount?: string; confirmed_count?: number; skipped_count?: number;
  /** 勾选批量确认的按币种合计（跨币种不相加）。 */
  amounts?: Array<{ currency: string; amount: string }>;
};
type DetailKind = "source" | "entry" | "reconciliation";

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
/** 「待接收」判定：没有应付单关联、且来源状态还没被接收过（历史数据的 status 可能停在 pending_finance）。 */
const awaitingReceipt = (item: { payable_entry?: SourcePayableLink | null; status: string }) => !item.payable_entry && item.status === "pending_finance";
const isDraft = (entry: PayableEntry) => entry.status === "draft";

export default function PayableWorkspace({ tab, testId }: { tab: PayableTabKey; testId: string }) {
  const [inboundSources, setInboundSources] = useState<PayableSource[]>([]);
  const [outsourceSources, setOutsourceSources] = useState<OutsourcePayableSource[]>([]);
  const [entries, setEntries] = useState<PayableEntry[]>([]);
  const [reconciliations, setReconciliations] = useState<SupplierReconciliation[]>([]);
  const [suppliers, setSuppliers] = useState<Reference[]>([]);
  const [orders, setOrders] = useState<Reference[]>([]);
  const [banks, setBanks] = useState<BankRef[]>([]);
  const [cashFlowItems, setCashFlowItems] = useState<DictionaryItem[]>([]);
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
  /** 勾选出来待确认的应付条目 id（「确认应付」页的批量确认用）。 */
  const [selected, setSelected] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [inbound, outsource, e, r, s, o, b, i] = await Promise.all([
        apiGet<PayableSource[]>("/payable-sources"),
        apiGet<OutsourcePayableSource[]>("/production/outsource-logistics-batches/payable-sources"),
        apiGet<PayableEntry[]>("/finance/payable-entries"),
        apiGet<SupplierReconciliation[]>("/finance/supplier-payable-reconciliations"),
        apiGet<Reference[]>("/suppliers").catch(() => ({ data: [] as Reference[], meta: {} })),
        apiGet<Reference[]>("/sales-orders").catch(() => ({ data: [] as Reference[], meta: {} })),
        apiGet<BankRef[]>("/finance/banks").catch(() => ({ data: [] as BankRef[], meta: {} })),
        apiGet<DictionaryItem[]>(`/dictionaries/${CASH_FLOW_ITEM_DICTIONARY_KEY}/items`).catch(() => ({ data: [] as DictionaryItem[], meta: {} })),
      ]);
      setInboundSources(inbound.data); setOutsourceSources(outsource.data); setEntries(e.data);
      setReconciliations(r.data); setSuppliers(s.data); setOrders(o.data); setBanks(b.data); setCashFlowItems(i.data);
      // 勾选状态跟着数据走：已被确认/冲销的条目自动退出勾选（界面上再也点不到它们，
      // 留着 id 会让「批量确认 N 条」里的 N 与实际能确认的条数对不上）。
      setSelected((ids) => ids.filter((id) => e.data.some((entry) => entry.id === id && isDraft(entry))));
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

  /**
   * 弹窗里的动作：失败必须把错误**抛回去**，ActionDialog 才会留在弹窗里把原因显示出来。
   *
   * 原来一律写 `void action(...)`：action 自己 catch 并 toast，返回的 Promise 正常 resolve，
   * ActionDialog 便认为保存成功而关闭弹窗 —— 用户只看到「点了没反应」（与工资页修过的是同一类缺陷）。
   *
   * `success` 支持传函数：接收应付这类「幂等」动作必须按返回的条目说清楚**到底发生了什么**
   * （新建了草稿 / 该来源早已接收），否则「点了没反应」的观感会一直存在。
   */
  async function submitAction<T = unknown>(path: string, body: unknown, success: string | ((data: T) => string), method: "post" | "patch" = "post"): Promise<T> {
    try {
      const result = await (method === "patch" ? apiPatch<T>(path, body ?? {}) : apiPost<T>(path, body));
      notifySuccess(typeof success === "function" ? success(result.data) : success);
      setDialog(null);
      setDetail(null);
      await load();
      return result.data;
    } catch (cause) {
      const message = messageOf(cause, "操作失败");
      notifyError(message);
      throw new Error(message);
    }
  }

  /**
   * 「确认应付」三个入口（逐条 / 勾选批量 / 按对账单）共用的提交与提示。
   *
   * 三条路径都是**确认即记账**（用户要求「一旦确认应付，金额就要转出对应的账户」），
   * 所以不能再用 submitAction 一句「已确认」了事：响应里的 `bank_missing` 表示钱已经记进收支流水、
   * 但不属于任何银行账户 —— 这时报成功会让财务以为账户里已经少了这笔钱，必须改成警告。
   */
  async function submitConfirm(path: string, body: Record<string, unknown>, describe: (data: ConfirmResult) => { success: string; warning: string }, failure: string) {
    try {
      const result = await apiPost<ConfirmResult>(path, body);
      const text = describe(result.data);
      if (result.data.bank_missing) notifyError(text.warning, "确认完成，但未入账银行");
      else notifySuccess(text.success);
      setDialog(null);
      setDetail(null);
      await load();
    } catch (cause) {
      const message = messageOf(cause, failure);
      notifyError(message);
      throw new Error(message);
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
    const path = detailKind === "entry" ? `/finance/payable-entries/${detailId}` : `/finance/supplier-payable-reconciliations/${detailId}`;
    setDetailLoading(true); setDetailError("");
    apiGet<unknown>(path).then((result) => { if (!cancelled) setDetailData(result.data); })
      .catch((cause) => { if (!cancelled) setDetailError(messageOf(cause, "详情加载失败")); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [detailKind, detailId, detailRow, detailNonce]);

  /**
   * 财务在应付页顺手新建供应商（供应商下拉旁的「新增类目」）。
   *
   * 编码支持「自动生成 / 手动填写」，与采购的供应商页同一套后端约定（`code_mode`）：
   * 自动时留空、由服务端按 SUP 前缀顺延；手动时必须自己填（空值由前端先拦一次，服务端也会 422）。
   */
  function createSupplier(values: Record<string, string>) {
    const mode = values.code_mode || "auto";
    // 校验失败要**抛回** ActionDialog（它靠 onSubmit 是否 reject 决定关不关弹窗），返回空会静默关闭。
    if (mode === "manual" && !values.supplier_code?.trim()) { const message = "手动编码模式必须填写供应商编码"; notifyError(message); return Promise.reject(new Error(message)); }
    return apiPost<Reference>("/suppliers", {
      code_mode: mode,
      supplier_code: values.supplier_code?.trim() || undefined,
      name: values.name, contact_name: values.contact_name || undefined,
      phone: values.phone || undefined, remark: values.remark || undefined,
    }).then((result) => {
      const created = result.data;
      setSuppliers((items) => [...items, created]);
      const pending = pendingDialog;
      setPendingDialog(null);
      setCategoryDialog(null);
      if (pending) setDialog({ ...pending, fields: pending.fields.map((field) => field.name === "supplier_id" ? { ...field, defaultValue: created.id, options: [...(field.options ?? []), { value: created.id, label: `${created.supplierCode ?? ""} / ${created.name}` }] } : field) });
      notifySuccess(mode === "manual" ? "供应商已创建" : `供应商已创建（编码 ${created.supplierCode ?? "自动生成"}）`);
    }).catch((cause) => {
      // 抛回 ActionDialog：失败时留在弹窗里显示原因，而不是静默关闭（同 submitAction 的理由）。
      const message = messageOf(cause, "供应商创建失败");
      notifyError(message);
      throw new Error(message);
    });
  }

  const supplierOptions = suppliers.map((item) => ({ value: item.id, label: `${item.supplierCode ?? ""} / ${item.name}` }));
  const orderOptions = orders.map((item) => ({ value: item.orderNo ?? item.id, label: item.orderNo ?? item.name }));
  const bankOptions = useMemo(() => banks.filter((b) => b.isActive).map((b) => ({ value: b.id, label: `${b.bankName} / ${b.accountNumber}（${b.accountName}）` })), [banks]);
  // 银行是可选字段且选错要能去掉；Radix Select 不接受空串 value，所以用哨兵值表示「不指定银行」，
  // 提交时翻译成 null（后端 DTO 的 @IsOptional 放过 null，Service 按「清空」处理）。
  const bankField = (label: string, current?: string | null): ActionField => ({
    name: "bank_id", label: `${label}（可选）`, type: "select",
    options: [{ value: BANK_CLEAR, label: "（不指定银行）" }, ...bankOptions],
    defaultValue: current || BANK_CLEAR,
  });
  const bankValue = (value: string | undefined) => (value === BANK_CLEAR ? null : (value || undefined));
  const currencyDefault = (preferred: string) => { const options = currencyOptions(currencyCatalogue); return options.some((option) => option.value === preferred) ? preferred : (options[0]?.value ?? preferred); };
  /** 可人工指定的收支项目：只给启用项。 */
  const cashFlowItemOptions = cashFlowItems.filter((item) => item.isActive).map((item) => ({ value: item.id, label: item.label }));
  /** 收支项目 id → 显示名：列表/详情只给 cashFlowItemId，标签用字典还原；查不到显示 -，不让整页崩。 */
  const cashFlowItemLabel = (id: string | null | undefined) => cashFlowItems.find((item) => item.id === id)?.label ?? "-";
  /** 建单弹窗的收支项目：可选，留空表示不管这个字段（新建单据上没有项目可清，所以不摆「清空」哨兵）。 */
  const cashFlowItemCreateField = (label: string): ActionField => ({ name: "cash_flow_item_id", label, type: "select", options: cashFlowItemOptions });
  /**
   * 已有单据上的收支项目：默认带出当前值；选「（不指定收支项目）」送 null。
   * 默认值用 `current ?? ""` 而非哨兵：未改动必须送 undefined，后端 PATCH 才完全不动这个字段。
   */
  const cashFlowItemEditField = (label: string, current?: string | null): ActionField => ({
    name: "cash_flow_item_id", label, type: "select",
    options: [{ value: CASH_FLOW_ITEM_CLEAR, label: "（不指定收支项目）" }, ...cashFlowItemOptions],
    defaultValue: current ?? "",
  });
  /** 哨兵/空值 → 提交值：明确清空送 null，未改动送 undefined（后端不更新该字段）。 */
  const cashFlowItemValue = (value: string | undefined) => (value === CASH_FLOW_ITEM_CLEAR ? null : (value || undefined));

  // ---------------------------------------------------------------- 操作（全部在表格行内触发，不在页头放按钮）

  /**
   * 接收应付之后该说什么。
   *
   * 接收是幂等的（一条来源只对应一张应付单）。若台账里已经有返回的这个 id，说明这条来源此前
   * 就接收过，必须如实说明「没有新建」并给出它现在在哪一步 —— 否则用户会以为「点了没反应、
   * 也没流转过去」（历史反馈）。
   */
  function receiveMessage(created: PayableEntry) {
    const existing = entries.find((entry) => entry.id === created.id);
    if (!existing) return `已接收为应付草稿 ${created.payableNo}；下一步：到「应付对账」按供应商 + 月份创建对账`;
    const where = existing.reconciliation ? `已纳入对账单 ${existing.reconciliation.reconciliation_no}` : "尚未纳入对账单，在「应付对账 → 待创建对账」里";
    return `该来源此前已接收（${existing.payableNo} / ${financeStatus(existing.status, "payable")}），未重复创建；${where}`;
  }

  function receiveSource(kind: "raw_material_inbound" | "outsource_receipt", source: { id: string; amount: string; currency: string }) {
    setDialog({ title: "接收应付", fields: [
      { name: "amount", label: "应付金额", type: "number", required: true, defaultValue: source.amount },
      { name: "amount_reason", label: "金额差异原因（金额与来源不一致时必填）", type: "textarea" },
      { name: "confirmation_date", label: "确认日期", type: "date", defaultValue: new Date().toISOString().slice(0, 10) },
      { name: "remark", label: "备注", type: "textarea" },
      // `.then(() => undefined)`：ActionDialog 只接受 void | Promise<void>，但失败仍必须**以 reject
      // 的形式**传回弹窗（否则它会当作保存成功直接关闭，用户只看到「点了没反应」）。
    ], submit: (v) => submitAction<PayableEntry>("/finance/payable-entries/from-source", { source_type: kind, source_id: source.id, amount: v.amount, amount_reason: v.amount_reason || undefined, confirmation_date: v.confirmation_date || undefined, remark: v.remark || undefined }, receiveMessage).then(() => undefined) });
  }
  function editEntry(item: PayableEntry) {
    setDialog({ title: `编辑应付草稿：${item.payableNo}`, fields: [
      { name: "amount", label: "应付金额", type: "number", required: true, defaultValue: item.amount },
      { name: "currency", label: "币种", type: "select", required: true, options: currencyOptionsWithCurrent(currencyCatalogue, item.currency), defaultValue: item.currency },
      { name: "confirmation_date", label: "确认日期", type: "date", required: true, defaultValue: item.confirmationDate.slice(0, 10) },
      { name: "remark", label: "备注", type: "textarea", defaultValue: item.remark ?? "" },
    ], submit: (v) => submitAction(`/finance/payable-entries/${item.id}`, { amount: v.amount, currency: v.currency, confirmation_date: v.confirmation_date, remark: v.remark || undefined }, "应付草稿已更新", "patch") });
  }
  function reopenEntry(item: PayableEntry) {
    setDialog({ title: `应付回退草稿：${item.payableNo}`, fields: [{ name: "reason", label: "回退原因", type: "textarea", required: true }], submit: (v) => submitAction(`/finance/payable-entries/${item.id}/reopen`, { reason: v.reason }, "应付已回退草稿") });
  }
  function reverseEntry(item: PayableEntry) {
    setDialog({ title: `冲销应付：${item.payableNo}`, fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }], submit: (v) => submitAction(`/finance/payable-entries/${item.id}/reverse`, { reason: v.reason }, "应付已冲销") });
  }
  /**
   * 逐条确认应付 —— 与「勾选批量确认」「按对账单确认」是同一件事的三条入口，都**确认即记账**。
   *
   * 应付条目本身不挂银行账户（它来自入库 / 签收来源），所以这里必须问清「钱从哪个账户出」：
   * 不指定就只能在收支流水里留一笔无归属的钱（后端回 bank_missing，上面会警告）。
   */
  function confirmEntry(item: PayableEntry) {
    setDialog({ title: `确认应付：${item.payableNo}`, fields: [
      { name: "confirm", label: `确认应付 ${item.payableNo}：${item.amount} ${item.currency}`, type: "info" as const },
      bankField("支付银行"),
      cashFlowItemEditField("收支项目"),
    ], submit: (v) => submitConfirm(`/finance/payable-entries/${item.id}/confirm`, { bank_id: bankValue(v.bank_id), cash_flow_item_id: cashFlowItemValue(v.cash_flow_item_id) }, (data) => ({
      success: `应付 ${item.payableNo} 已确认（${data.amount ?? item.amount} ${data.currency ?? item.currency}），金额已记入所选银行账户`,
      warning: `未指定支付银行：${data.amount ?? item.amount} ${data.currency ?? item.currency} 已记入收支流水，但不会体现在任何银行账户余额里`,
    }), "确认应付失败") });
  }
  /**
   * 勾选批量确认 —— 用户要求「不要又是登记付款又是确认应付，直接就是支持勾选，批量确认」。
   *
   * 整批共用一个支付银行与一个收支项目（后端仍是**每条应付写一条流水**，所以每条都追得回来源单号）；
   * 合计**按币种分组**显示，跨币种不相加。勾选里混进已被别人确认掉的条目时，后端会跳过并回报条数。
   */
  function batchConfirm() {
    const drafts = entries.filter((entry) => isDraft(entry) && selected.includes(entry.id));
    const totals = new Map<string, number>();
    for (const draft of drafts) totals.set(draft.currency, (totals.get(draft.currency) ?? 0) + Number(draft.amount));
    setDialog({ title: `批量确认应付（${drafts.length} 条）`, fields: [
      { name: "confirm", label: `确认 ${drafts.length} 条草稿应付（合计 ${[...totals.entries()].map(([currency, amount]) => `${amount.toFixed(4)} ${currency}`).join("、")}）`, type: "info" as const },
      bankField("支付银行"),
      cashFlowItemEditField("收支项目"),
    ], submit: (v) => submitConfirm("/finance/payable-entries/batch-confirm", { ids: drafts.map((draft) => draft.id), bank_id: bankValue(v.bank_id), cash_flow_item_id: cashFlowItemValue(v.cash_flow_item_id) }, (data) => {
      const amount = data.amounts?.length ? data.amounts.map((item) => `${item.amount} ${item.currency}`).join("、") : "-";
      const skipped = data.skipped_count ? `；跳过 ${data.skipped_count} 条` : "";
      return {
        success: `已确认 ${data.confirmed_count ?? drafts.length} 条应付（${amount}）${skipped}，金额已记入所选银行账户`,
        warning: `未指定支付银行：${amount} 已记入收支流水，但不会体现在任何银行账户余额里`,
      };
    }, "批量确认应付失败") });
  }

  function createOtherPayable() {
    setDialog({ title: "新建其他应付（非订单支出）", fields: [
      { name: "supplier_id", label: "供应商", type: "select", required: true, canAddCategory: true, options: supplierOptions },
      { name: "amount", label: "应付金额", type: "number", required: true },
      { name: "currency", label: "币种", type: "select", required: true, options: currencyOptions(currencyCatalogue), defaultValue: currencyDefault("CNY") },
      { name: "description", label: "支出说明", required: true },
      { name: "confirmation_date", label: "确认日期", type: "date", defaultValue: new Date().toISOString().slice(0, 10) },
      { name: "remark", label: "备注", type: "textarea" },
    ], submit: (v) => submitAction("/finance/payable-entries/other", { supplier_id: v.supplier_id, amount: v.amount, currency: v.currency, description: v.description, confirmation_date: v.confirmation_date || undefined, remark: v.remark || undefined }, "其他应付已创建") });
  }

  function createReconciliation(preset?: { supplierId: string; month: string }) {
    const range = preset ? monthRange(preset.month) : undefined;
    setDialog({ title: "创建应付对账", fields: [
      { name: "supplier_id", label: "供应商", type: "select", required: true, canAddCategory: true, options: supplierOptions, defaultValue: preset?.supplierId },
      { name: "order_no", label: "订单号（可选）", type: "select", options: orderOptions },
      { name: "period_start", label: "期间开始", type: "date", required: true, defaultValue: range?.start },
      { name: "period_end", label: "期间结束", type: "date", required: true, defaultValue: range?.end },
      { name: "external_balance", label: "外部应付余额", type: "number", required: true },
      { name: "currency", label: "币种", type: "select", required: true, options: currencyOptions(currencyCatalogue), defaultValue: currencyDefault("CNY") },
      bankField("支付银行"),
      cashFlowItemCreateField("收支项目"),
      { name: "remark", label: "备注", type: "textarea" },
    ], submit: (v) => submitAction("/finance/supplier-payable-reconciliations", { supplier_id: v.supplier_id, order_no: v.order_no || undefined, period_start: v.period_start, period_end: v.period_end, external_balance: v.external_balance, currency: v.currency, bank_id: bankValue(v.bank_id), cash_flow_item_id: v.cash_flow_item_id || undefined, remark: v.remark || undefined }, "应付对账单已创建") });
  }
  function resolveReconciliation(item: SupplierReconciliation) {
    setDialog({ title: `处理应付对账差异：${item.reconciliationNo}`, fields: [{ name: "remark", label: "处理说明", type: "textarea", required: true, defaultValue: "已核对" }], submit: (v) => submitAction(`/finance/supplier-payable-reconciliations/${item.id}/resolve`, { resolution_remark: v.remark }, "应付对账差异已处理") });
  }
  /**
   * 对账完成后一键确认范围内的草稿应付。
   *
   * 确认应付现在**同时记账** —— 确认金额作为一笔支出写进收支流水，落到对账单的银行账户上。
   * 所以不能无 body 直接打：历史对账单常常既没银行也没项目，必须先把「记到哪个账户、归哪个项目」
   * 问清楚（与应收侧同一套弹窗）。
   */
  function confirmReconciliationPayables(item: SupplierReconciliation) {
    const count = item.details?.draft_count ?? item.flow?.draft_count ?? 0;
    const amount = item.details?.draft_amount ?? item.flow?.draft_amount;
    setDialog({ title: `确认应付：${item.reconciliationNo}`, fields: [
      { name: "confirm", label: `确认 ${count} 条草稿应付${amount ? `（合计 ${amount} ${item.currency}）` : ""}`, type: "info" as const },
      bankField("支付银行", item.bank?.id),
      cashFlowItemEditField("收支项目", item.cashFlowItemId),
    ], submit: (v) => submitConfirmPayables(item, v) });
  }
  /** 确认应付的提交：与逐条 / 勾选批量共用 submitConfirm（三条路径都会记账，都要处理 bank_missing）。 */
  async function submitConfirmPayables(item: SupplierReconciliation, v: Record<string, string>) {
    return submitConfirm(`/finance/supplier-payable-reconciliations/${item.id}/confirm-payables`, { bank_id: bankValue(v.bank_id), cash_flow_item_id: cashFlowItemValue(v.cash_flow_item_id) }, (data) => {
      const amount = data.confirmed_amount ?? data.amount ?? "-";
      const currency = data.currency ?? item.currency;
      const skipped = data.skipped_count ? `；跳过 ${data.skipped_count} 条` : "";
      return {
        success: `${item.reconciliationNo} 已确认 ${data.confirmed_count ?? 0} 条应付（${amount}）${skipped}，金额已记入所选银行账户`,
        warning: `未指定支付银行：${amount} ${currency} 已记入收支流水，但不会体现在任何银行账户余额里`,
      };
    }, "批量确认应付失败");
  }

  // ---------------------------------------------------------------- 列表

  // 已接收的来源不再出现在「待接收」列表里：它已经变成应付草稿（在「应付对账 / 确认应付」里），
  // 留在这里只会让人重复点「接收应付」。计数仍然显示「已接收 N 条」，不让它不声不响地消失。
  const pendingInbound = useMemo(() => inboundSources.filter((item) => item.rawMaterialInbound && awaitingReceipt(item)), [inboundSources]);
  const pendingOutsource = useMemo(() => outsourceSources.filter(awaitingReceipt), [outsourceSources]);
  const receivedInboundCount = useMemo(() => inboundSources.filter((item) => item.rawMaterialInbound && !awaitingReceipt(item)).length, [inboundSources]);
  const receivedOutsourceCount = useMemo(() => outsourceSources.filter((item) => !awaitingReceipt(item)).length, [outsourceSources]);
  const match = useCallback((values: Array<string | null | undefined>) => {
    const text = filter.trim().toLowerCase();
    if (!text) return true;
    return values.some((value) => (value ?? "").toLowerCase().includes(text));
  }, [filter]);
  const filteredInbound = useMemo(() => pendingInbound.filter((item) => match([item.rawMaterialInbound?.inboundNo, item.orderNo, item.purchase_order_no, item.supplier?.name, item.material_name])), [pendingInbound, match]);
  const filteredOutsource = useMemo(() => pendingOutsource.filter((item) => match([item.logisticsBatch?.batchNo, item.orderNo, item.supplier?.name, item.material_name])), [pendingOutsource, match]);
  const filteredEntries = useMemo(() => entries.filter((item) => match([item.payableNo, item.orderNo, item.supplier_name, item.material_name, item.purchase_order_no])), [entries, match]);

  const pendingSourceCount = pendingInbound.length + pendingOutsource.length;
  const draftEntries = entries.filter(isDraft);
  const draftTotal = draftEntries.reduce((sum, entry) => sum + Number(entry.amount), 0);
  const confirmedCount = entries.filter((entry) => ["confirmed", "partially_paid", "paid"].includes(entry.status)).length;
  const readyToConfirm = reconciliations.reduce((sum, item) => sum + (item.flow?.can_confirm_payables ? item.flow.draft_count : 0), 0);

  const pendingEntries = useMemo(() => entries.filter((entry) => entry.status === "draft" && !entry.reconciliation), [entries]);
  const coveredDrafts = useMemo(() => entries.filter((entry) => entry.status === "draft" && entry.reconciliation), [entries]);
  const pendingTotal = pendingEntries.reduce((sum, entry) => sum + Number(entry.amount), 0);

  // 勾选只对草稿开放：已确认/冲销的条目没有「再确认一次」这回事。
  const selectableIds = useMemo(() => filteredEntries.filter(isDraft).map((entry) => entry.id), [filteredEntries]);
  const selectedDrafts = useMemo(() => entries.filter((entry) => isDraft(entry) && selected.includes(entry.id)), [entries, selected]);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.includes(id));
  const toggleOne = (id: string) => setSelected((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
  const toggleAll = () => setSelected((ids) => allSelected ? ids.filter((id) => !selectableIds.includes(id)) : [...new Set([...ids, ...selectableIds])]);

  const selectionColumn: ColumnDef<PayableEntry> = {
    id: "select",
    header: () => <input type="checkbox" aria-label="全选待确认应付" data-testid="payable-select-all" checked={allSelected} disabled={!selectableIds.length} onChange={toggleAll} />,
    cell: ({ row }) => isDraft(row.original)
      ? <input type="checkbox" aria-label={`选择 ${row.original.payableNo}`} data-testid={`payable-select-${row.original.id}`} checked={selected.includes(row.original.id)} onChange={() => toggleOne(row.original.id)} />
      : null,
  };
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
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row"><Button size="sm" variant="secondary" onClick={() => receiveSource("raw_material_inbound", row.original)}>接收应付</Button></div> },
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
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row"><Button size="sm" variant="secondary" onClick={() => receiveSource("outsource_receipt", row.original)}>接收应付</Button></div> },
  ];
  // 台账不再列「已付 / 未付」：这两列来自**付款单核销**，而本轮已经把「登记付款 → 过账核销」从确认流程里去掉了
  // （确认应付本身就把钱从账户支出去了）。留着它们只会让每条已确认的应付都显示「未付 = 全额」，
  // 与「钱已经出去了」自相矛盾。核销明细仍在双击后的详情里。
  const entryColumns: ColumnDef<PayableEntry>[] = [
    selectionColumn,
    { accessorKey: "payableNo", header: "应付单号" },
    { id: "sourceNo", header: "来源批次", cell: ({ row }) => row.original.source_no ?? row.original.sourceNoSnapshot },
    { id: "sourceType", header: "来源", cell: ({ row }) => SOURCE_TYPE_LABELS[row.original.sourceType] ?? row.original.sourceType },
    { id: "orderNo", header: "订单号", cell: ({ row }) => row.original.orderNo ?? (row.original.sourceType === "other" ? "无" : "-") },
    { id: "supplier", header: "供应商", cell: ({ row }) => row.original.supplier_name ?? row.original.supplier?.name ?? "-" },
    { id: "material", header: "原料 / 说明", cell: ({ row }) => row.original.sourceType === "other" ? row.original.sourceNoSnapshot : materialText(row.original) },
    { id: "amount", header: "应付金额", cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "confirmationDate", header: "确认日期", cell: ({ row }) => day(row.original.confirmationDate) },
    { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "payable") },
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">
      {row.original.status === "draft" && <><Button size="sm" variant="secondary" onClick={() => confirmEntry(row.original)}>确认应付</Button><Button size="sm" variant="ghost" onClick={() => editEntry(row.original)}>编辑</Button></>}
      {row.original.status === "confirmed" && <Button size="sm" variant="ghost" onClick={() => reopenEntry(row.original)}>回退</Button>}
    </div> },
  ];
  const reconciliationColumns: ColumnDef<SupplierReconciliation>[] = [
    { accessorKey: "reconciliationNo", header: "对账单号" },
    { id: "supplier", header: "供应商", cell: ({ row }) => row.original.supplier?.name ?? "-" },
    { id: "order", header: "订单号", cell: ({ row }) => row.original.orderNo ?? (row.original.flow?.order_nos.length ? row.original.flow.order_nos.join("、") : "全部订单") },
    { id: "purchaseOrder", header: "采购单号", cell: ({ row }) => row.original.flow?.purchase_order_nos.join("、") || row.original.purchaseOrder?.purchaseOrderNo || "-" },
    { id: "material", header: "采购物料", cell: ({ row }) => row.original.flow?.material_names.join("、") || "-" },
    { id: "specification", header: "规格型号", cell: ({ row }) => row.original.flow?.material_specifications?.join("、") || "-" },
    { id: "period", header: "期间", cell: ({ row }) => `${day(row.original.periodStart)} 至 ${day(row.original.periodEnd)}` },
    { id: "entries", header: "待确认应付", cell: ({ row }) => row.original.flow && row.original.flow.draft_count > 0 ? `${row.original.flow.draft_count} 条 / ${row.original.flow.draft_amount}` : "-" },
    { id: "payable", header: "应付快照", cell: ({ row }) => money(row.original.payableAmountSnapshot, row.original.currency) },
    { id: "paid", header: "已付快照", cell: ({ row }) => money(row.original.paymentAmountSnapshot, row.original.currency) },
    { id: "system", header: "系统余额", cell: ({ row }) => money(row.original.systemBalance, row.original.currency) },
    { id: "external", header: "外部余额", cell: ({ row }) => money(row.original.externalBalance, row.original.currency) },
    { id: "difference", header: "差异", cell: ({ row }) => money(row.original.difference, row.original.currency) },
    { id: "bank", header: "支付银行", cell: ({ row }) => row.original.bank ? `${row.original.bank.bankName}（${row.original.bank.accountNumber}）` : "-" },
    { id: "cashFlowItem", header: "收支项目", cell: ({ row }) => cashFlowItemLabel(row.original.cashFlowItemId) },
    { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "reconciliation") },
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row" data-testid={`reconciliation-actions-${row.original.id}`}>
      {row.original.status === "difference" && <Button size="sm" variant="secondary" onClick={() => resolveReconciliation(row.original)}>处理差异</Button>}
      {row.original.flow?.can_confirm_payables ? <Button size="sm" data-testid={`reconciliation-confirm-${row.original.id}`} onClick={() => confirmReconciliationPayables(row.original)}>确认 {row.original.flow.draft_count} 条应付</Button> : null}
      {["matched", "resolved"].includes(row.original.status) && row.original.flow && row.original.flow.draft_count === 0 ? <span className="panel-note">范围内没有待确认应付</span> : null}
    </div> },
  ];
  /** 「待创建对账」= **逐条**列出还没有被任何对账单覆盖的草稿应付（汇总行看不出「这条在不在」）。 */
  const pendingEntryColumns: ColumnDef<PayableEntry>[] = [
    { id: "supplier", header: "供应商", cell: ({ row }) => row.original.supplier_name ?? row.original.supplier?.name ?? row.original.supplierId },
    { accessorKey: "payableNo", header: "应付单号" },
    { id: "month", header: "待对账月份", cell: ({ row }) => monthOf(row.original.confirmationDate ?? row.original.createdAt) },
    { id: "sourceNo", header: "来源批次", cell: ({ row }) => row.original.source_no ?? row.original.sourceNoSnapshot },
    { id: "orderNo", header: "订单号", cell: ({ row }) => row.original.orderNo ?? (row.original.sourceType === "other" ? "无" : "-") },
    { id: "purchaseOrder", header: "采购单号", cell: ({ row }) => row.original.purchase_order_no ?? "-" },
    { id: "material", header: "采购物料", cell: ({ row }) => row.original.sourceType === "other" ? row.original.sourceNoSnapshot : (row.original.material_name ?? row.original.material_code ?? "-") },
    { id: "specification", header: "规格型号", cell: ({ row }) => row.original.material_specification || "-" },
    { id: "amount", header: "应付金额", cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "confirmationDate", header: "确认日期", cell: ({ row }) => day(row.original.confirmationDate) },
    { id: "actions", header: "操作", cell: ({ row }) => <Button size="sm" variant="secondary" title="按这条的供应商 + 月份创建：一张对账单覆盖该供应商该月全部待确认应付" onClick={() => createReconciliation({ supplierId: row.original.supplierId, month: monthOf(row.original.confirmationDate ?? row.original.createdAt) })}>创建对账</Button> },
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
      { label: "已生成的应付单", value: (item as PayableSource).payable_entry ? `${(item as PayableSource).payable_entry?.payableNo}（${financeStatus((item as PayableSource).payable_entry?.status, "payable")}）` : "尚未接收" },
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
    if (detail?.kind === "reconciliation" && detailData) {
      const item = detailData as SupplierReconciliation;
      return [
        { label: "对账单号", value: item.reconciliationNo }, { label: "状态", value: financeStatus(item.status, "reconciliation") },
        { label: "供应商", value: item.supplier?.name ?? item.supplierId }, { label: "订单号", value: item.orderNo ?? "全部订单" },
        { label: "采购单号", value: item.purchaseOrder?.purchaseOrderNo ?? (item.flow?.purchase_order_nos?.join("、") || null) },
        { label: "采购物料", value: item.flow?.material_names?.join("、"), wide: true },
        { label: "规格型号", value: item.flow?.material_specifications?.join("、"), wide: true },
        { label: "期间", value: `${day(item.periodStart)} 至 ${day(item.periodEnd)}` },
        { label: "应付快照", value: money(item.payableAmountSnapshot, item.currency) },
        { label: "已付快照", value: money(item.paymentAmountSnapshot, item.currency) },
        { label: "系统余额", value: money(item.systemBalance, item.currency) },
        { label: "外部余额", value: money(item.externalBalance, item.currency) },
        { label: "差异", value: money(item.difference, item.currency) },
        { label: "支付银行", value: item.bank ? `${item.bank.bankName} / ${item.bank.accountNumber}（${item.bank.accountName}）` : "-" },
        { label: "收支项目", value: cashFlowItemLabel(item.cashFlowItemId) },
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
      return [{ title: `付款核销记录（${allocations.length} 条）`, content: allocations.length
        ? <DataTable pageSize={10} columns={[{ id: "payment", header: "付款单号", cell: ({ row }) => row.original.payment?.paymentNo ?? "-" }, { id: "date", header: "付款日期", cell: ({ row }) => day(row.original.payment?.paymentDate) }, { id: "status", header: "付款状态", cell: ({ row }) => financeStatus(row.original.payment?.status, "payable") }, { id: "amount", header: "核销金额", cell: ({ row }) => money(row.original.amount, row.original.payment?.currency ?? item.currency) }] as ColumnDef<NonNullable<PayableEntry["allocations"]>[number]>[]} data={allocations} /> : <p className="panel-note">暂无付款核销</p> }];
    }
    if (detail?.kind === "reconciliation" && detailData) {
      const item = detailData as SupplierReconciliation;
      const ents = item.details?.payable_entries ?? [];
      const pending = item.details?.pending_sources ?? [];
      return [
        { title: `纳入对账的应付条目（${ents.length} 条）`, content: ents.length
          ? <DataTable pageSize={10} columns={[{ accessorKey: "payableNo", header: "应付单号" }, { id: "material", header: "采购物料", cell: ({ row }) => row.original.material_name ?? "-" }, { id: "specification", header: "规格型号", cell: ({ row }) => row.original.material_specification || "-" }, { id: "purchaseOrder", header: "采购单号", cell: ({ row }) => row.original.purchase_order_no ?? "-" }, { accessorKey: "sourceNoSnapshot", header: "来源批次" }, { accessorKey: "orderNo", header: "订单号" }, { id: "amount", header: "金额", cell: ({ row }) => money(row.original.amount, row.original.currency) }, { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "payable") }] as ColumnDef<NonNullable<SupplierReconciliation["details"]>["payable_entries"][number]>[]} data={ents} /> : <p className="panel-note">该期间没有纳入对账的应付条目</p> },
        { title: `仍待接收的来源（${pending.length} 条）`, content: pending.length
          ? <DataTable pageSize={10} columns={[{ accessorKey: "source_no", header: "来源批次" }, { accessorKey: "orderNo", header: "订单号" }, { accessorKey: "quantity", header: "数量" }, { id: "amount", header: "金额", cell: ({ row }) => money(row.original.amount, row.original.currency) }] as ColumnDef<NonNullable<SupplierReconciliation["details"]>["pending_sources"][number]>[]} data={pending} /> : <p className="panel-note">该期间没有待接收来源</p> },
      ];
    }
    return [];
  }

  function detailActions() {
    if (!detailData) return null;
    if (detail?.kind === "source") {
      const item = detailData as PayableSource | OutsourcePayableSource;
      if (!awaitingReceipt(item)) return null;
      const kind = (detailData as PayableSource).rawMaterialInbound ? "raw_material_inbound" : "outsource_receipt";
      return <Button onClick={() => receiveSource(kind, item)}>接收应付</Button>;
    }
    if (detail?.kind === "entry") {
      const item = detailData as PayableEntry;
      return <>
        {item.status === "draft" && <><Button onClick={() => confirmEntry(item)}>确认应付</Button><Button variant="secondary" onClick={() => editEntry(item)}>编辑草稿</Button></>}
        {item.status === "confirmed" && <Button variant="secondary" onClick={() => reopenEntry(item)}>回退草稿</Button>}
        {["confirmed", "partially_paid", "paid"].includes(item.status) && <Button variant="destructive" onClick={() => reverseEntry(item)}>冲销应付</Button>}
      </>;
    }
    if (detail?.kind === "reconciliation") {
      const item = detailData as SupplierReconciliation;
      return <>
        {item.status === "difference" && <Button onClick={() => resolveReconciliation(item)}>处理差异</Button>}
        {item.details?.can_confirm_payables ? <Button onClick={() => confirmReconciliationPayables(item)}>确认应付（{item.details.draft_count} 条）</Button> : null}
      </>;
    }
    return null;
  }

  const detailTitle = detail?.kind === "source" ? "应付来源详情" : detail?.kind === "entry" ? `应付条目 ${(detailData as PayableEntry | null)?.payableNo ?? ""}` : `应付对账 ${(detailData as SupplierReconciliation | null)?.reconciliationNo ?? ""}`;
  const activeTab = PAYABLE_TABS.find((item) => item.key === tab) ?? PAYABLE_TABS[0];

  if (loading) return <><PageHeader title="应付管理" /><LoadingState /></>;

  return <div className="page-root finance-page" data-testid={testId}>
    <PageHeader title="应付管理">
      <Button asChild variant="secondary"><Link href="/finance">返回财务</Link></Button>
    </PageHeader>
    <FinanceTabs basePath="/finance/payable" tabs={PAYABLE_TABS} active={activeTab.key} />
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []}
      onAddCategory={(field) => { if (field.name !== "supplier_id") return; setPendingDialog(dialog); setDialog(null); setCategoryDialog({ title: "新建供应商", fields: [
        { name: "code_mode", label: "编码方式", type: "select", required: true, defaultValue: "auto", options: [{ value: "auto", label: "自动生成" }, { value: "manual", label: "手动填写" }] },
        { name: "supplier_code", label: "供应商编码", placeholder: "自动生成时留空" }, { name: "name", label: "供应商名称", required: true },
        { name: "contact_name", label: "联系人" }, { name: "phone", label: "联系电话" }, { name: "remark", label: "备注", type: "textarea" },
      ], submit: createSupplier }); }}
      onSubmit={(values) => dialog?.submit(values)} />
    <ActionDialog open={Boolean(categoryDialog)} onOpenChange={(open) => { if (!open) { setCategoryDialog(null); setPendingDialog(null); } }} title={categoryDialog?.title ?? "新建供应商"} fields={categoryDialog?.fields ?? []} onSubmit={(values) => categoryDialog?.submit(values)} />
    <RecordDetailDialog
      open={Boolean(detail)}
      onOpenChange={(open) => { if (!open) setDetail(null); }}
      title={detailTitle}
      fields={detailFields()}
      sections={detailSections()}
      actions={detailActions()}
      loading={detailLoading}
      error={detailError}
      onRetry={() => setDetailNonce((value) => value + 1)}
    />
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    {!error && <section className="panel panel-body" data-testid="payable-flow">
      <div className="panel-heading"><h2>应付流转</h2></div>
      <ol className="flow-steps">
        <li data-testid="payable-flow-receive">
          <strong>① 待接收来源 {pendingSourceCount} 条</strong>
          <Link href="/finance/payable?tab=raw-inbound-entries">去接收 →</Link>
        </li>
        <li data-testid="payable-flow-reconcile" className={draftEntries.length ? "flow-step-active" : undefined}>
          <strong>② 待确认应付草稿 {draftEntries.length} 条（{draftTotal.toFixed(2)}）</strong>
          <Link href="/finance/payable?tab=reconciliations">去对账 →</Link>
        </li>
        <li data-testid="payable-flow-confirm" className={readyToConfirm ? "flow-step-active" : undefined}>
          <strong>③ 已对平待确认 {readyToConfirm} 条</strong>
          <Link href="/finance/payable?tab=reconciliations">去确认 →</Link>
        </li>
        <li data-testid="payable-flow-pay">
          <strong>④ 已确认 {confirmedCount} 条</strong>
          <Link href="/finance/payable?tab=confirmed">去确认 →</Link>
        </li>
      </ol>
    </section>}
    {!error && <section className="panel panel-body">
      <div className="filter-bar"><label>搜索<Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="单号 / 订单号 / 供应商 / 原料" /></label></div>
    </section>}
    {!error && activeTab.key === "raw-inbound-entries" && <section className="panel">
      <div className="panel-heading"><h2>原料入库条目</h2><span className="panel-note">待接收 {pendingInbound.length} 条 · 已接收 {receivedInboundCount} 条</span></div>
      <div className="panel-body"><DataTable columns={inboundColumns} data={filteredInbound} empty={<EmptyState title="暂无待接收的原料入库来源" />} onRowDoubleClick={(row) => setDetail({ kind: "source", id: row.id, row })} rowTitle="双击查看详情" /></div>
    </section>}
    {!error && activeTab.key === "outsource-entries" && <section className="panel">
      <div className="panel-heading"><h2>外加工签收</h2><span className="panel-note">待接收 {pendingOutsource.length} 条 · 已接收 {receivedOutsourceCount} 条</span></div>
      <div className="panel-body"><DataTable columns={outsourceColumns} data={filteredOutsource} empty={<EmptyState title="暂无待接收的外加工签收来源" />} onRowDoubleClick={(row) => setDetail({ kind: "source", id: row.id, row })} rowTitle="双击查看详情" /></div>
    </section>}
    {!error && activeTab.key === "reconciliations" && <section className="panel">
      <div className="panel-heading"><h2>应付对账</h2><span className="panel-note">待创建 {pendingEntries.length} 条 · 对账单 {reconciliations.length} 张</span></div>
      <div className="panel-body">
        {/* 条数放在 h3 外面：标题保持「待创建对账」，按标题定位这个面板的脚本/测试才不会被条数干扰。 */}
        <div className="subsection-heading">
          <h3>待创建对账</h3>
          <span className="panel-note" data-testid="payable-pending-summary">{pendingEntries.length} 条 / 合计 {pendingTotal.toFixed(2)}</span>
        </div>
        <div data-testid="payable-pending-entries">
          <DataTable columns={pendingEntryColumns} data={pendingEntries} empty={<EmptyState title="没有待创建对账的条目" />} onRowDoubleClick={(row) => setDetail({ kind: "entry", id: row.id })} rowTitle="双击查看详情" />
        </div>
        {/* 已被对账单覆盖的草稿必须点名，否则用户会以为「这条应付没流转过去」（用户反馈）。 */}
        {coveredDrafts.length ? <p className="panel-note" data-testid="payable-covered-drafts">
          另有 {coveredDrafts.length} 条草稿已纳入对账单、不在此重复对账：{coveredDrafts.map((entry) => `${entry.payableNo}（${entry.reconciliation?.reconciliation_no}）`).join("、")}
        </p> : null}
        <h3>已创建对账单</h3>
        <DataTable columns={reconciliationColumns} data={reconciliations} empty={<EmptyState title="暂无应付对账单" />} onRowDoubleClick={(row) => setDetail({ kind: "reconciliation", id: row.id })} rowTitle="双击查看详情" />
      </div>
    </section>}
    {!error && activeTab.key === "confirmed" && <section className="panel">
      <div className="panel-heading"><h2>确认应付</h2><span className="panel-note">共 {filteredEntries.length} 条 · 草稿 {draftEntries.length} 条</span></div>
      <div className="panel-body">
        <div style={{ marginBottom: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem" }} data-testid="payable-batch-bar">
          <Button size="sm" variant="secondary" onClick={createOtherPayable}>新建其他应付</Button>
          <span className="panel-note" data-testid="payable-selected-count">已选 {selectedDrafts.length} 条</span>
          <Button size="sm" data-testid="payable-batch-confirm" disabled={!selectedDrafts.length} onClick={batchConfirm}>批量确认（{selectedDrafts.length} 条）</Button>
        </div>
        <DataTable columns={entryColumns} data={filteredEntries} empty={<EmptyState title="暂无应付条目" />} onRowDoubleClick={(row) => setDetail({ kind: "entry", id: row.id })} rowTitle="双击查看详情" />
      </div>
    </section>}
  </div>;
}

"use client";

// 应收管理二级页（/finance/receivable?tab=...）。
//
// 子栏目按业务顺序排列，对应「先有出库、再对账、最后确认应收与收款」：
//   1. 成品出库条目：成品出库过账自动生成的应收来源（一个订单分批出库 = 多条），草稿可编辑/确认/取消；
//   2. 应收对账：按客户 + 期间创建对账单（自动汇总该期间的出库条目为明细），对平后可一键批量确认应收；
//   3. 确认应收：已确认的应收台账 + 收款登记/核销/冲销。
// 双击任意行都会弹出居中详情页（展示全部字段与可用操作），详情数据来自对应的 :id 接口。
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
import { RECEIVABLE_TABS, type ReceivableTabKey } from "../../lib/finance-sections";
import { notifyError, notifySuccess } from "../ui/toaster";
import { FinanceTabs } from "./finance-tabs";
import { RecordDetailDialog, money, type DetailField } from "./record-detail-dialog";
import { financeStatus } from "./finance-status";

/** 收款建单的幂等键：打开弹窗时生成并固定，同一次弹窗内的重试/双击只会落一张草稿。 */
const paymentIdempotencyKey = () => `web-receipt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
/**
 * 银行下拉的「清空」哨兵值。
 *
 * 银行是可选字段，选错了必须能去掉；而 Radix Select 不接受空串 value，所以用一个显式哨兵值表示「不指定银行」，
 * 提交时再翻译成 null（后端 DTO 的 @IsOptional 会放过 null 并按「清空」处理）。
 */
const BANK_CLEAR = "__no_bank__";

type Reference = { id: string; name: string; customerCode?: string; orderNo?: string };
type CustomerRef = { id: string; name: string; customerCode: string | null };
/** 银行账户池条目（财务 → 银行账户）。收款的「到账银行」只能从这里选，不在这里手输账户。 */
type BankRef = { id: string; bankCode: string; bankName: string; accountName: string; accountNumber: string; currency: string; isActive: boolean };
type BankLink = { id: string; bankName: string; accountNumber: string } | null;
type SourceAllocation = { id: string; amount: string; status: string; payment?: { id: string; paymentNo: string; status: string; paymentDate: string; amount?: string; currency?: string } | null };
type ReceivableSource = {
  id: string; sourceNo: string; orderNo: string; customerId: string; outboundId: string;
  quantity: string; unit: string; unitPrice: string | null; taxRate: string | null; amount: string; currency: string;
  amountReason: string | null; status: string; dueDate: string | null; invoiceNo: string | null; invoiceDate: string | null;
  signedAtSnapshot: string | null; remark: string | null; createdAt: string;
  customer_name: string | null; customer_code: string | null; outbound_no: string | null;
  product_name: string | null; product_specification: string | null;
  allocated_amount: string; outstanding_amount: string;
  customer?: CustomerRef | null;
  outbound?: { outboundNo: string; status: string; productNameSnapshot: string | null; productSpecificationSnapshot: string | null; signedAt: string | null; shipmentDate: string | null } | null;
  allocations?: SourceAllocation[];
};
type CustomerPayment = {
  id: string; paymentNo: string; customerId: string; orderNo: string | null; paymentDate: string; amount: string;
  currency: string; paymentMethod: string; bankReference: string | null; payerName: string | null; status: string; remark: string | null;
  bankId?: string | null; bank?: BankLink;
  customer_name: string | null; customer_code: string | null; allocated_amount: string;
  customer?: CustomerRef | null;
  allocations: Array<{ id: string; amount: string; status: string; receivableSource?: { id: string; sourceNo: string; orderNo: string; amount: string; currency: string; status: string } | null }>;
};
type ReconciliationEntry = ReceivableSource;
type Reconciliation = {
  id: string; reconciliationNo: string; orderNo: string | null; customerId: string;
  periodStart: string; periodEnd: string; receivableAmountSnapshot: string; paymentAmountSnapshot: string;
  adjustmentAmountSnapshot: string; systemBalance: string; externalBalance: string; difference: string;
  currency: string; status: string; resolutionRemark: string | null; remark: string | null; createdAt: string;
  bankId?: string | null; bank?: BankLink;
  customer?: CustomerRef | null;
  status_label?: string;
  details?: { entries: ReconciliationEntry[]; draft_entries: ReconciliationEntry[]; entry_count: number; draft_count: number; draft_amount: string; can_confirm_receivables: boolean };
};
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void };
type DetailKind = "source" | "payment" | "reconciliation";

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : "-");
const monthOf = (value: string | null | undefined) => (value ? value.slice(0, 7) : "-");
const monthRange = (month: string) => ({ start: `${month}-01`, end: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10) });

export default function ReceivableWorkspace({ tab, testId }: { tab: ReceivableTabKey; testId: string }) {
  const [sources, setSources] = useState<ReceivableSource[]>([]);
  const [payments, setPayments] = useState<CustomerPayment[]>([]);
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([]);
  const [customers, setCustomers] = useState<Reference[]>([]);
  const [orders, setOrders] = useState<Reference[]>([]);
  const [banks, setBanks] = useState<BankRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [detail, setDetail] = useState<{ kind: DetailKind; id: string } | null>(null);
  const [detailData, setDetailData] = useState<unknown>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailNonce, setDetailNonce] = useState(0);
  const [categoryDialog, setCategoryDialog] = useState<DialogState | null>(null);
  const [pendingDialog, setPendingDialog] = useState<DialogState | null>(null);
  const [currencyCatalogue, setCurrencyCatalogue] = useState<CurrencyOption[]>([]);
  const [sourceFilter, setSourceFilter] = useState("");
  const [paymentFilter, setPaymentFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // 客户/销售单走 sales 权限：只有财务权限的账号拉不到它们，但不应因此整页报错（选项留空即可）。
      // 银行账户池同理（走 finance 权限，正常能拿到）。
      const [s, p, r, c, o, b] = await Promise.all([
        apiGet<ReceivableSource[]>("/finance/receivable-sources"),
        apiGet<CustomerPayment[]>("/finance/customer-payments"),
        apiGet<Reconciliation[]>("/finance/reconciliations"),
        apiGet<Reference[]>("/customers").catch(() => ({ data: [] as Reference[], meta: {} })),
        apiGet<Reference[]>("/sales-orders").catch(() => ({ data: [] as Reference[], meta: {} })),
        apiGet<BankRef[]>("/finance/banks").catch(() => ({ data: [] as BankRef[], meta: {} })),
      ]);
      setSources(s.data); setPayments(p.data); setReconciliations(r.data); setCustomers(c.data); setOrders(o.data); setBanks(b.data);
    } catch (cause) {
      setError(messageOf(cause, "应收数据加载失败"));
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

  // 详情弹窗打开时按 :id 拉详情：列表接口给不出全部字段（来源追踪、核销明细、对账纳入条目等）。
  const detailKind = detail?.kind;
  const detailId = detail?.id;
  useEffect(() => {
    if (!detailKind || !detailId) { setDetailData(null); return; }
    let cancelled = false;
    const path = detailKind === "source" ? `/finance/receivable-sources/${detailId}` : detailKind === "payment" ? `/finance/customer-payments/${detailId}` : `/finance/reconciliations/${detailId}`;
    setDetailLoading(true); setDetailError("");
    apiGet<unknown>(path).then((result) => { if (!cancelled) setDetailData(result.data); })
      .catch((cause) => { if (!cancelled) setDetailError(messageOf(cause, "详情加载失败")); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [detailKind, detailId, detailNonce]);

  // 「新增客户」走二级弹窗：ActionDialog 的 onAddCategory 只回传字段与当前值，
  // 这里按老财务页的既有交互实现：关闭主弹窗 → 建客户 → 重开主弹窗并预选新客户。
  function createCustomer(values: Record<string, string>) {
    void apiPost<Reference>("/customers", {
      customer_code: values.customer_code, name: values.name, country_region: values.country_region || undefined,
      address: values.address || undefined, payment_terms: values.payment_terms || undefined,
      currency: values.currency || undefined, remark: values.remark || undefined,
    }).then((result) => {
      const created = result.data;
      setCustomers((items) => [...items, created]);
      const pending = pendingDialog;
      setPendingDialog(null);
      setCategoryDialog(null);
      if (pending) setDialog({ ...pending, fields: pending.fields.map((field) => field.name === "customer_id" ? { ...field, defaultValue: created.id, options: [...(field.options ?? []), { value: created.id, label: `${created.customerCode ?? ""} / ${created.name}` }] } : field) });
      notifySuccess("客户已创建");
    }).catch((cause) => notifyError(messageOf(cause, "客户创建失败")));
  }

  const customerOptions = customers.map((item) => ({ value: item.id, label: `${item.customerCode ?? ""} / ${item.name}` }));
  const orderOptions = orders.map((item) => ({ value: item.orderNo ?? item.id, label: item.orderNo ?? item.name }));
  const currencyDefault = (preferred: string) => { const options = currencyOptions(currencyCatalogue); return options.some((option) => option.value === preferred) ? preferred : (options[0]?.value ?? preferred); };
  // 到账/回款银行只能从银行账户池里选（停用的不出现）；账户在「财务 → 银行账户」维护。
  const bankOptions = useMemo(() => banks.filter((bank) => bank.isActive).map((bank) => ({ value: bank.id, label: `${bank.bankName} / ${bank.accountNumber}（${bank.accountName}）` })), [banks]);
  const bankField = (label: string, current?: string | null): ActionField => ({
    name: "bank_id", label: `${label}（可选；账户在「财务 → 银行账户」里维护）`, type: "select",
    options: [{ value: BANK_CLEAR, label: "（不指定银行）" }, ...bankOptions],
    defaultValue: current || BANK_CLEAR,
  });
  /** 哨兵值 → 提交值：清空要显式送 null，未改动则送 undefined（后端不更新该字段）。 */
  const bankValue = (value: string | undefined) => (value === BANK_CLEAR ? null : (value || undefined));
  const allocatableSources = sources.filter((item) => ["confirmed", "partially_paid"].includes(item.status) && Number(item.outstanding_amount) > 0);

  // ---------------------------------------------------------------- 操作

  function editSource(item: ReceivableSource) {
    setDialog({ title: `编辑应收草稿：${item.sourceNo}`, fields: [
      { name: "amount", label: "应收金额", type: "number", required: true, defaultValue: item.amount },
      { name: "currency", label: "币种", type: "select", required: true, options: currencyOptionsWithCurrent(currencyCatalogue, item.currency), defaultValue: item.currency },
      { name: "due_date", label: "到期日期", type: "date", defaultValue: item.dueDate ? item.dueDate.slice(0, 10) : "" },
      { name: "amount_reason", label: "金额原因", type: "textarea", defaultValue: item.amountReason ?? "" },
      { name: "remark", label: "备注", type: "textarea", defaultValue: item.remark ?? "" },
    ], submit: (v) => void action(`/finance/receivable-sources/${item.id}`, { amount: v.amount, currency: v.currency, due_date: v.due_date || undefined, amount_reason: v.amount_reason || undefined, remark: v.remark || undefined }, "应收草稿已更新", "patch") });
  }
  function cancelSource(item: ReceivableSource) {
    setDialog({ title: `取消应收：${item.sourceNo}`, fields: [{ name: "reason", label: "取消原因", type: "textarea", required: true }], submit: (v) => void action(`/finance/receivable-sources/${item.id}/cancel`, { reason: v.reason }, "应收已取消") });
  }
  function reopenSource(item: ReceivableSource) {
    setDialog({ title: `应收回退草稿：${item.sourceNo}`, fields: [{ name: "reason", label: "回退原因", type: "textarea", required: true }], submit: (v) => void action(`/finance/receivable-sources/${item.id}/reopen`, { reason: v.reason }, "应收已回退草稿") });
  }
  function confirmSource(item: ReceivableSource) { void action(`/finance/receivable-sources/${item.id}/confirm`, undefined, `应收 ${item.sourceNo} 已确认`); }
  function batchConfirmByOrder(orderNo: string, count: number) {
    setDialog({ title: `批量确认应收：${orderNo}`, fields: [{ name: "confirm", label: `确认将订单 ${orderNo} 的全部 ${count} 条草稿应收一次性确认为已确认。不可逆。`, type: "info" as const }], submit: () => void action("/finance/receivable-sources/batch-confirm-by-order", { order_no: orderNo }, `订单 ${orderNo} 已批量确认 ${count} 条应收`) });
  }

  function createPayment(source?: ReceivableSource) {
    // 幂等键在打开弹窗时固定：同一次弹窗里重复提交只建一张草稿；
    // 换一次弹窗是新键，此时由后端的「重复草稿守卫」兜底。
    const idempotency_key = paymentIdempotencyKey();
    setDialog({ title: source ? `登记收款（对应 ${source.sourceNo}）` : "登记收款", fields: [
      { name: "customer_id", label: "客户", type: "select", required: true, canAddCategory: true, options: customerOptions, defaultValue: source?.customerId },
      { name: "order_no", label: "订单号", type: "select", options: orderOptions, defaultValue: source?.orderNo },
      { name: "amount", label: "收款金额", type: "number", required: true, defaultValue: source?.outstanding_amount },
      { name: "payment_date", label: "收款日期", type: "date", required: true, defaultValue: new Date().toISOString().slice(0, 10) },
      { name: "payment_method", label: "收款方式", required: true, defaultValue: "银行转账" },
      { name: "currency", label: "币种", type: "select", required: true, options: currencyOptionsWithCurrent(currencyCatalogue, source?.currency ?? "CNY"), defaultValue: source?.currency ?? currencyDefault("CNY") },
      bankField("到账银行"),
      { name: "remark", label: "备注", type: "textarea" },
    ], submit: (v) => void action("/finance/customer-payments", { customer_id: v.customer_id, order_no: v.order_no || undefined, payment_date: v.payment_date, amount: v.amount, currency: v.currency, payment_method: v.payment_method, bank_id: bankValue(v.bank_id), idempotency_key, remark: v.remark || undefined }, "收款草稿已创建") });
  }
  function editPayment(item: CustomerPayment) {
    setDialog({ title: `编辑收款草稿：${item.paymentNo}`, fields: [
      { name: "amount", label: "金额", type: "number", required: true, defaultValue: item.amount },
      { name: "payment_date", label: "日期", type: "date", required: true, defaultValue: item.paymentDate.slice(0, 10) },
      { name: "payment_method", label: "方式", required: true, defaultValue: item.paymentMethod },
      { name: "currency", label: "币种", type: "select", required: true, options: currencyOptionsWithCurrent(currencyCatalogue, item.currency), defaultValue: item.currency },
      bankField("到账银行", item.bankId),
      { name: "remark", label: "备注", type: "textarea", defaultValue: item.remark ?? "" },
    ], submit: (v) => void action(`/finance/customer-payments/${item.id}`, { amount: v.amount, payment_date: v.payment_date, payment_method: v.payment_method, currency: v.currency, bank_id: bankValue(v.bank_id), remark: v.remark || undefined }, "收款草稿已更新", "patch") });
  }
  function postPayment(item: CustomerPayment, preset?: ReceivableSource) {
    const options = allocatableSources.map((source) => ({ value: source.id, label: `${source.sourceNo} / ${source.orderNo} / ${source.customer_name ?? source.customerId} / 未收 ${source.outstanding_amount} ${source.currency}` }));
    setDialog({ title: `收款核销：${item.paymentNo}`, fields: [
      { name: "source_id", label: "应收来源", type: "select", required: true, options, defaultValue: preset?.id },
      { name: "amount", label: "本次核销金额", type: "number", required: true, defaultValue: preset?.outstanding_amount ?? item.amount },
    ], submit: (v) => v.source_id ? void action(`/finance/customer-payments/${item.id}/post`, { allocations: [{ receivable_source_id: v.source_id, amount: v.amount }] }, "收款已过账并核销") : undefined });
  }
  function reversePayment(item: CustomerPayment) {
    setDialog({ title: `冲销收款：${item.paymentNo}`, fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }], submit: (v) => void action(`/finance/customer-payments/${item.id}/reverse`, { reason: v.reason }, "收款已冲销") });
  }

  function createReconciliation(preset?: { customerId: string; month: string }) {
    const range = preset ? monthRange(preset.month) : undefined;
    setDialog({ title: "创建应收对账", fields: [
      { name: "customer_id", label: "客户", type: "select", required: true, canAddCategory: true, options: customerOptions, defaultValue: preset?.customerId },
      { name: "order_no", label: "订单号（可选，留空则对客户全部订单）", type: "select", options: orderOptions },
      { name: "period_start", label: "期间开始", type: "date", required: true, defaultValue: range?.start },
      { name: "period_end", label: "期间结束", type: "date", required: true, defaultValue: range?.end },
      { name: "external_balance", label: "外部余额（客户对账单金额）", type: "number", required: true },
      { name: "currency", label: "币种", type: "select", required: true, options: currencyOptions(currencyCatalogue), defaultValue: currencyDefault("CNY") },
      bankField("回款银行"),
      { name: "remark", label: "备注", type: "textarea" },
    ], submit: (v) => void action("/finance/reconciliations", { customer_id: v.customer_id, order_no: v.order_no || undefined, period_start: v.period_start, period_end: v.period_end, external_balance: v.external_balance, currency: v.currency, bank_id: bankValue(v.bank_id), remark: v.remark || undefined }, "对账单已创建") });
  }
  function resolveReconciliation(item: Reconciliation) {
    setDialog({ title: `处理对账差异：${item.reconciliationNo}`, fields: [{ name: "remark", label: "处理说明", type: "textarea", required: true, defaultValue: "已核对" }], submit: (v) => void action(`/finance/reconciliations/${item.id}/resolve`, { resolution_remark: v.remark }, "对账差异已处理") });
  }
  function confirmReconciliation(item: Reconciliation) {
    void action(`/finance/reconciliations/${item.id}/confirm-receivables`, undefined, `已批量确认 ${item.reconciliationNo} 的待确认应收`);
  }

  // ---------------------------------------------------------------- 待创建对账分组

  const pendingGroups = useMemo(() => {
    const map = new Map<string, { customerId: string; customerName: string; month: string; count: number; amount: number }>();
    for (const source of sources) {
      if (source.status !== "draft") continue;
      const month = monthOf(source.createdAt);
      const key = `${source.customerId}|${month}`;
      const group = map.get(key) ?? { customerId: source.customerId, customerName: source.customer_name ?? source.customerId, month, count: 0, amount: 0 };
      group.count += 1;
      group.amount += Number(source.amount);
      map.set(key, group);
    }
    return [...map.values()].sort((a, b) => (a.month === b.month ? a.customerName.localeCompare(b.customerName) : b.month.localeCompare(a.month)));
  }, [sources]);

  // ---------------------------------------------------------------- 列表

  const outboundSources = useMemo(() => {
    const text = sourceFilter.trim().toLowerCase();
    if (!text) return sources;
    return sources.filter((item) => [item.sourceNo, item.orderNo, item.customer_name, item.outbound_no, item.product_name].some((value) => (value ?? "").toLowerCase().includes(text)));
  }, [sourceFilter, sources]);
  // 待确认收款提醒：成品出库过账会自动生成应收来源草稿（通知财务收款），这里把待确认的笔数与金额显示出来。
  const pendingSources = useMemo(() => sources.filter((item) => item.status === "draft"), [sources]);
  const pendingAmount = pendingSources.reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
  // 应收台账 = 全部应收来源（含草稿）。草稿在「确认应收」里逐条确认，已确认的在这里登记收款与核销；
  // 只列已确认会让「接收后可确认」这条路径没有任何可达入口。
  const ledgerSources = useMemo(() => {
    const text = sourceFilter.trim().toLowerCase();
    if (!text) return sources;
    return sources.filter((item) => [item.sourceNo, item.orderNo, item.customer_name].some((value) => (value ?? "").toLowerCase().includes(text)));
  }, [sourceFilter, sources]);
  const filteredPayments = useMemo(() => {
    const text = paymentFilter.trim().toLowerCase();
    if (!text) return payments;
    return payments.filter((item) => [item.paymentNo, item.orderNo, item.customer_name].some((value) => (value ?? "").toLowerCase().includes(text)));
  }, [paymentFilter, payments]);
  // 应收来源行的操作：成品出库条目与确认应收两张表共用同一套动作，避免两边行为漂移。
  const sourceActions = (item: ReceivableSource) => <div className="action-row">
    {item.status === "draft" && <><Button size="sm" variant="secondary" onClick={() => confirmSource(item)}>确认应收</Button><Button size="sm" variant="ghost" onClick={() => editSource(item)}>编辑</Button><Button size="sm" variant="ghost" onClick={() => cancelSource(item)}>取消</Button></>}
    {item.status === "confirmed" && <Button size="sm" variant="ghost" onClick={() => reopenSource(item)}>回退草稿</Button>}
    {["confirmed", "partially_paid"].includes(item.status) && Number(item.outstanding_amount) > 0 && <Button size="sm" variant="ghost" onClick={() => createPayment(item)}>登记收款</Button>}
  </div>;

  const sourceColumns: ColumnDef<ReceivableSource>[] = [
    { accessorKey: "sourceNo", header: "应收来源" },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "customer", header: "客户", cell: ({ row }) => row.original.customer_name ?? row.original.customer_code ?? "-" },
    { id: "outbound", header: "出库单", cell: ({ row }) => row.original.outbound_no ?? "-" },
    { id: "product", header: "产品", cell: ({ row }) => { const item = row.original; const spec = item.product_specification ? `（${item.product_specification}）` : ""; return item.product_name ? `${item.product_name}${spec}` : "-"; } },
    { id: "quantity", header: "数量", cell: ({ row }) => `${row.original.quantity}${row.original.unit ? ` ${row.original.unit}` : ""}` },
    { id: "amount", header: "应收金额", cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "outstanding", header: "未收", cell: ({ row }) => money(row.original.outstanding_amount, row.original.currency) },
    { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "receivable") },
    { id: "actions", header: "操作", cell: ({ row }) => sourceActions(row.original) },
  ];
  // 「确认应收」用台账视角的列：不带出库单/产品，而是到期日与已收/未收。
  const ledgerColumns: ColumnDef<ReceivableSource>[] = [
    { accessorKey: "sourceNo", header: "应收来源" },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "customer", header: "客户", cell: ({ row }) => row.original.customer_name ?? row.original.customer_code ?? "-" },
    { id: "amount", header: "应收金额", cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "allocated", header: "已收", cell: ({ row }) => money(row.original.allocated_amount, row.original.currency) },
    { id: "outstanding", header: "未收", cell: ({ row }) => money(row.original.outstanding_amount, row.original.currency) },
    { id: "due", header: "到期日", cell: ({ row }) => day(row.original.dueDate) },
    { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "receivable") },
    { id: "actions", header: "操作", cell: ({ row }) => sourceActions(row.original) },
  ];
  const paymentColumns: ColumnDef<CustomerPayment>[] = [
    { accessorKey: "paymentNo", header: "收款单号" },
    { id: "date", header: "日期", cell: ({ row }) => day(row.original.paymentDate) },
    { id: "customer", header: "客户", cell: ({ row }) => row.original.customer_name ?? "-" },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "amount", header: "金额", cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "allocated", header: "已核销", cell: ({ row }) => money(row.original.allocated_amount, row.original.currency) },
    { accessorKey: "paymentMethod", header: "方式" },
    { id: "bank", header: "到账银行", cell: ({ row }) => row.original.bank ? `${row.original.bank.bankName}（${row.original.bank.accountNumber}）` : "-" },
    { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "receivable") },
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">
      {row.original.status === "draft" && <><Button size="sm" variant="secondary" onClick={() => postPayment(row.original)}>过账/核销</Button><Button size="sm" variant="ghost" onClick={() => editPayment(row.original)}>编辑</Button></>}
      {row.original.status === "posted" && <Button size="sm" variant="destructive" onClick={() => reversePayment(row.original)}>冲销</Button>}
    </div> },
  ];
  const reconciliationColumns: ColumnDef<Reconciliation>[] = [
    { accessorKey: "reconciliationNo", header: "对账单号" },
    { id: "customer", header: "客户", cell: ({ row }) => row.original.customer?.name ?? "-" },
    { id: "order", header: "订单号", cell: ({ row }) => row.original.orderNo ?? "全部订单" },
    { id: "period", header: "期间", cell: ({ row }) => `${day(row.original.periodStart)} 至 ${day(row.original.periodEnd)}` },
    { id: "receivable", header: "应收快照", cell: ({ row }) => money(row.original.receivableAmountSnapshot, row.original.currency) },
    { id: "paid", header: "已收快照", cell: ({ row }) => money(row.original.paymentAmountSnapshot, row.original.currency) },
    { id: "system", header: "系统余额", cell: ({ row }) => money(row.original.systemBalance, row.original.currency) },
    { id: "external", header: "外部余额", cell: ({ row }) => money(row.original.externalBalance, row.original.currency) },
    { id: "difference", header: "差异", cell: ({ row }) => money(row.original.difference, row.original.currency) },
    { id: "bank", header: "回款银行", cell: ({ row }) => row.original.bank ? `${row.original.bank.bankName}（${row.original.bank.accountNumber}）` : "-" },
    { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "reconciliation") },
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">
      {row.original.status === "difference" && <Button size="sm" variant="secondary" onClick={() => resolveReconciliation(row.original)}>处理差异</Button>}
      {["matched", "resolved"].includes(row.original.status) && <Button size="sm" variant="secondary" onClick={() => confirmReconciliation(row.original)}>一键确认应收</Button>}
    </div> },
  ];
  const pendingGroupColumns: ColumnDef<{ customerId: string; customerName: string; month: string; count: number; amount: number }>[] = [
    { id: "customer", header: "客户", cell: ({ row }) => row.original.customerName },
    { id: "month", header: "待对账月份", cell: ({ row }) => row.original.month },
    { id: "count", header: "待确认出库条目", cell: ({ row }) => `${row.original.count} 条` },
    { id: "amount", header: "待确认金额", cell: ({ row }) => row.original.amount.toFixed(2) },
    { id: "actions", header: "操作", cell: ({ row }) => <Button size="sm" variant="secondary" onClick={() => createReconciliation({ customerId: row.original.customerId, month: row.original.month })}>创建对账</Button> },
  ];

  // ---------------------------------------------------------------- 详情弹窗内容

  function detailFields(): DetailField[] {
    if (detail?.kind === "source" && detailData) {
      const item = detailData as ReceivableSource;
      return [
        { label: "应收来源编号", value: item.sourceNo }, { label: "状态", value: financeStatus(item.status, "receivable") },
        { label: "订单号", value: item.orderNo }, { label: "客户", value: item.customer?.name ?? item.customer_name ?? item.customerId },
        { label: "出库单号", value: item.outbound?.outboundNo ?? item.outbound_no }, { label: "出库状态", value: financeStatus(item.outbound?.status) },
        { label: "产品", value: item.outbound?.productNameSnapshot ?? item.product_name },
        { label: "规格", value: item.outbound?.productSpecificationSnapshot ?? item.product_specification },
        { label: "数量", value: `${item.quantity}${item.unit ? ` ${item.unit}` : ""}` },
        { label: "单价", value: item.unitPrice }, { label: "税率", value: item.taxRate },
        { label: "应收金额", value: money(item.amount, item.currency) },
        { label: "已收金额", value: money(item.allocated_amount, item.currency) },
        { label: "未收金额", value: money(item.outstanding_amount, item.currency) },
        { label: "金额原因", value: item.amountReason, wide: true },
        { label: "到期日期", value: day(item.dueDate) }, { label: "签收时间快照", value: day(item.signedAtSnapshot) },
        { label: "发票号", value: item.invoiceNo }, { label: "开票日期", value: day(item.invoiceDate) },
        { label: "创建时间", value: day(item.createdAt) }, { label: "备注", value: item.remark, wide: true },
      ];
    }
    if (detail?.kind === "payment" && detailData) {
      const item = detailData as CustomerPayment;
      return [
        { label: "收款单号", value: item.paymentNo }, { label: "状态", value: financeStatus(item.status, "receivable") },
        { label: "客户", value: item.customer?.name ?? item.customer_name ?? item.customerId }, { label: "订单号", value: item.orderNo },
        { label: "收款日期", value: day(item.paymentDate) }, { label: "收款金额", value: money(item.amount, item.currency) },
        { label: "已核销金额", value: money(item.allocated_amount, item.currency) }, { label: "收款方式", value: item.paymentMethod },
        { label: "到账银行", value: item.bank ? `${item.bank.bankName} / ${item.bank.accountNumber}` : "-" },
        { label: "银行流水号", value: item.bankReference }, { label: "付款人", value: item.payerName },
        { label: "备注", value: item.remark, wide: true },
      ];
    }
    if (detail?.kind === "reconciliation" && detailData) {
      const item = detailData as Reconciliation;
      return [
        { label: "对账单号", value: item.reconciliationNo }, { label: "状态", value: financeStatus(item.status, "reconciliation") },
        { label: "客户", value: item.customer?.name ?? item.customerId }, { label: "订单号", value: item.orderNo ?? "全部订单" },
        { label: "期间", value: `${day(item.periodStart)} 至 ${day(item.periodEnd)}` },
        { label: "应收快照", value: money(item.receivableAmountSnapshot, item.currency) },
        { label: "已收快照", value: money(item.paymentAmountSnapshot, item.currency) },
        { label: "调整净额快照", value: money(item.adjustmentAmountSnapshot, item.currency) },
        { label: "系统余额", value: money(item.systemBalance, item.currency) },
        { label: "外部余额", value: money(item.externalBalance, item.currency) },
        { label: "差异", value: money(item.difference, item.currency) },
        { label: "回款银行", value: item.bank ? `${item.bank.bankName} / ${item.bank.accountNumber}` : "-" },
        { label: "纳入条目数", value: item.details ? `${item.details.entry_count} 条（待确认 ${item.details.draft_count} 条 / ${item.details.draft_amount}）` : "-" },
        { label: "差异处理说明", value: item.resolutionRemark, wide: true },
        { label: "创建时间", value: day(item.createdAt) }, { label: "备注", value: item.remark, wide: true },
      ];
    }
    return [];
  }

  function detailSections() {
    if (detail?.kind === "source" && detailData) {
      const item = detailData as ReceivableSource;
      const allocations = item.allocations ?? [];
      return [{ title: `收款核销记录（${allocations.length} 条）`, note: "只统计有效核销；已冲销收款的核销不计入未收余额。", content: allocations.length
        ? <DataTable pageSize={10} columns={[{ accessorKey: "id", header: "核销 ID" }, { id: "payment", header: "收款单号", cell: ({ row }) => row.original.payment?.paymentNo ?? "-" }, { id: "date", header: "收款日期", cell: ({ row }) => day(row.original.payment?.paymentDate) }, { id: "status", header: "收款状态", cell: ({ row }) => financeStatus(row.original.payment?.status, "receivable") }, { id: "amount", header: "核销金额", cell: ({ row }) => money(row.original.amount, row.original.payment?.currency ?? item.currency) }] as ColumnDef<SourceAllocation>[]} data={allocations} /> : <p className="panel-note">暂无收款核销</p> }];
    }
    if (detail?.kind === "payment" && detailData) {
      const item = detailData as CustomerPayment;
      const allocations = item.allocations ?? [];
      return [{ title: `核销明细（${allocations.length} 条）`, content: allocations.length
        ? <DataTable pageSize={10} columns={[{ id: "source", header: "应收来源", cell: ({ row }) => row.original.receivableSource?.sourceNo ?? "-" }, { id: "order", header: "订单号", cell: ({ row }) => row.original.receivableSource?.orderNo ?? "-" }, { id: "sourceStatus", header: "应收状态", cell: ({ row }) => financeStatus(row.original.receivableSource?.status, "receivable") }, { id: "status", header: "核销状态", cell: ({ row }) => financeStatus(row.original.status) }, { id: "amount", header: "核销金额", cell: ({ row }) => money(row.original.amount, row.original.receivableSource?.currency ?? item.currency) }] as ColumnDef<CustomerPayment["allocations"][number]>[]} data={allocations} /> : <p className="panel-note">该收款尚未核销任何应收</p> }];
    }
    if (detail?.kind === "reconciliation" && detailData) {
      const item = detailData as Reconciliation;
      const entries = item.details?.entries ?? [];
      return [{ title: `纳入对账的应收条目（${entries.length} 条）`, note: "对平（或差异已处理）后可一键批量确认其中的草稿应收。", content: entries.length
        ? <DataTable pageSize={10} columns={[{ accessorKey: "sourceNo", header: "应收来源" }, { accessorKey: "orderNo", header: "订单号" }, { id: "customer", header: "客户", cell: ({ row }) => row.original.customer_name ?? "-" }, { id: "amount", header: "金额", cell: ({ row }) => money(row.original.amount, row.original.currency) }, { id: "outstanding", header: "未收", cell: ({ row }) => money(row.original.outstanding_amount, row.original.currency) }, { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "receivable") }] as ColumnDef<ReconciliationEntry>[]} data={entries} /> : <p className="panel-note">该期间没有纳入对账的应收条目</p> }];
    }
    return [];
  }

  function detailActions() {
    if (!detailData) return null;
    if (detail?.kind === "source") {
      const item = detailData as ReceivableSource;
      return <>
        {item.status === "draft" && <><Button onClick={() => confirmSource(item)}>确认应收</Button><Button variant="secondary" onClick={() => editSource(item)}>编辑草稿</Button><Button variant="destructive" onClick={() => cancelSource(item)}>取消应收</Button></>}
        {item.status === "confirmed" && <><Button variant="secondary" onClick={() => reopenSource(item)}>回退草稿</Button></>}
        {["confirmed", "partially_paid"].includes(item.status) && Number(item.outstanding_amount) > 0 && <Button onClick={() => createPayment(item)}>登记收款</Button>}
      </>;
    }
    if (detail?.kind === "payment") {
      const item = detailData as CustomerPayment;
      return <>
        {item.status === "draft" && <><Button onClick={() => postPayment(item)}>过账/核销</Button><Button variant="secondary" onClick={() => editPayment(item)}>编辑草稿</Button></>}
        {item.status === "posted" && <Button variant="destructive" onClick={() => reversePayment(item)}>冲销收款</Button>}
      </>;
    }
    if (detail?.kind === "reconciliation") {
      const item = detailData as Reconciliation;
      return <>
        {item.status === "difference" && <Button onClick={() => resolveReconciliation(item)}>处理差异</Button>}
        {["matched", "resolved"].includes(item.status) && <Button onClick={() => confirmReconciliation(item)}>一键确认应收（{item.details?.draft_count ?? 0} 条）</Button>}
      </>;
    }
    return null;
  }

  const detailTitle = detail?.kind === "source" ? `应收来源 ${(detailData as ReceivableSource | null)?.sourceNo ?? ""}` : detail?.kind === "payment" ? `收款 ${(detailData as CustomerPayment | null)?.paymentNo ?? ""}` : `应收对账 ${(detailData as Reconciliation | null)?.reconciliationNo ?? ""}`;
  const activeTab = RECEIVABLE_TABS.find((item) => item.key === tab) ?? RECEIVABLE_TABS[0];

  if (loading) return <><PageHeader title="应收管理" /><LoadingState /></>;

  return <div className="page-root" data-testid={testId}>
    <PageHeader title="应收管理" description={activeTab.description}>
      <Button asChild variant="secondary"><Link href="/finance">返回财务</Link></Button>
      <Button onClick={() => createPayment()}>登记收款</Button>
      <Button variant="secondary" onClick={() => createReconciliation()}>创建对账</Button>
    </PageHeader>
    <FinanceTabs basePath="/finance/receivable" tabs={RECEIVABLE_TABS} active={activeTab.key} />
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []}
      onAddCategory={(field) => { if (field.name !== "customer_id") return; setPendingDialog(dialog); setDialog(null); setCategoryDialog({ title: "新建客户", fields: [
        { name: "customer_code", label: "客户编码", required: true }, { name: "name", label: "客户名称", required: true },
        { name: "country_region", label: "国家/地区" }, { name: "address", label: "地址", type: "textarea" },
        { name: "payment_terms", label: "付款条件" },
        { name: "currency", label: "币种", type: "select", options: currencyOptions(currencyCatalogue), defaultValue: currencyDefault("CNY") },
        { name: "remark", label: "备注", type: "textarea" },
      ], submit: createCustomer }); }}
      onSubmit={(values) => { dialog?.submit(values); }} />
    <ActionDialog open={Boolean(categoryDialog)} onOpenChange={(open) => { if (!open) { setCategoryDialog(null); setPendingDialog(null); } }} title={categoryDialog?.title ?? "新建客户"} fields={categoryDialog?.fields ?? []} onSubmit={(values) => { categoryDialog?.submit(values); }} />
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
    {!error && activeTab.key === "outbound-entries" && <>
      <section className="panel panel-body">
        <div className="filter-bar"><label>搜索<Input value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} placeholder="来源编号 / 订单号 / 客户 / 出库单 / 产品" /></label></div>
        <p className="panel-note">待确认应收 {pendingSources.length} 笔 / 合计 {pendingAmount.toFixed(2)}（成品出库过账自动生成，确认后才进入「确认应收」并允许收款核销）。双击任意一行查看全部字段。</p>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>成品出库条目</h2><span className="panel-note">共 {outboundSources.length} 条</span></div>
        <div className="panel-body"><DataTable columns={sourceColumns} data={outboundSources} empty={<EmptyState title="暂无成品出库形成的应收来源" />} onRowDoubleClick={(row) => setDetail({ kind: "source", id: row.id })} rowTitle="双击查看详情" /></div>
      </section>
    </>}
    {!error && activeTab.key === "reconciliations" && <>
      <section className="panel">
        <div className="panel-heading"><h2>待创建对账的条目</h2><span className="panel-note">按客户 + 月份汇总尚未确认的成品出库条目；点「创建对账」会把客户与期间自动带入表单</span></div>
        <div className="panel-body"><DataTable columns={pendingGroupColumns} data={pendingGroups} empty={<EmptyState title="没有待创建对账的条目" />} /></div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>应收对账单</h2><span className="panel-note">对平（或差异已处理）后可一键批量确认该对账范围内的草稿应收；对账单上的回款银行同样来自银行账户池</span></div>
        <div className="panel-body"><DataTable columns={reconciliationColumns} data={reconciliations} empty={<EmptyState title="暂无应收对账单" />} onRowDoubleClick={(row) => setDetail({ kind: "reconciliation", id: row.id })} rowTitle="双击查看详情" /></div>
      </section>
    </>}
    {!error && activeTab.key === "confirmed" && <>
      <BulkConfirmSection sources={ledgerSources} onBatchConfirm={batchConfirmByOrder} />
      <section className="panel">
        <div className="panel-heading"><h2>确认应收</h2><span className="panel-note">应收台账：草稿在此逐条确认；已确认的在此登记收款、核销与回退。同一订单有多条草稿时可批量确认</span></div>
        <div className="panel-body"><DataTable columns={ledgerColumns} data={ledgerSources} empty={<EmptyState title="暂无应收台账" />} onRowDoubleClick={(row) => setDetail({ kind: "source", id: row.id })} rowTitle="双击查看详情" /></div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>收款</h2><span className="panel-note">草稿收款先过账核销，核销后可冲销并恢复应收余额；到账银行从「财务 → 银行账户」的银行池里选（编辑草稿时可改币种与银行）</span></div>
        <div className="panel-body">
          <div className="filter-bar"><label>搜索<Input value={paymentFilter} onChange={(event) => setPaymentFilter(event.target.value)} placeholder="收款单号 / 订单号 / 客户" /></label></div>
          <DataTable columns={paymentColumns} data={filteredPayments} empty={<EmptyState title="暂无收款记录" />} onRowDoubleClick={(row) => setDetail({ kind: "payment", id: row.id })} rowTitle="双击查看详情" />
        </div>
      </section>
    </>}
  </div>;
}

function BulkConfirmSection({ sources, onBatchConfirm }: { sources: ReceivableSource[]; onBatchConfirm: (orderNo: string, count: number) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, { orderNo: string; customerName: string; customerId: string; draftCount: number; draftAmount: number }>();
    for (const source of sources) {
      if (source.status !== "draft") continue;
      const key = source.orderNo;
      const group = map.get(key) ?? { orderNo: source.orderNo, customerName: source.customer_name ?? source.customerId, customerId: source.customerId, draftCount: 0, draftAmount: 0 };
      group.draftCount += 1;
      group.draftAmount += Number(source.amount);
      map.set(key, group);
    }
    return [...map.values()].filter((group) => group.draftCount > 0).sort((a, b) => b.draftAmount - a.draftAmount);
  }, [sources]);

  if (!groups.length) return null;
  return <section className="panel">
    <div className="panel-heading"><h2>按订单批量确认</h2><span className="panel-note">相同订单有多条出库 → 一键批量确认全部草稿应收，无需逐条操作。只确认草稿条目，已确认的自动跳过。</span></div>
    <div className="panel-body">
      <DataTable
        columns={[
          { accessorKey: "orderNo", header: "订单号" },
          { accessorKey: "customerName", header: "客户" },
          { id: "draftCount", header: "草稿条数", cell: ({ row }) => `${row.original.draftCount} 条` },
          { id: "draftAmount", header: "草稿合计", cell: ({ row }) => row.original.draftAmount.toFixed(2) },
          { id: "action", header: "操作", cell: ({ row }) => <Button size="sm" variant="secondary" onClick={() => onBatchConfirm(row.original.orderNo, row.original.draftCount)}>批量确认 ({row.original.draftCount} 条)</Button> },
        ] as ColumnDef<{ orderNo: string; customerName: string; customerId: string; draftCount: number; draftAmount: number }>[]}
        data={groups}
        empty={<EmptyState title="所有订单均无草稿应收" />}
      />
    </div>
  </section>;
}
"use client";

// 应收管理二级页（/finance/receivable?tab=...）。
//
// 三个子栏目按业务顺序排列，对应「先有出库、再对账、最后确认应收」：
//   1. 成品出库条目：成品出库过账自动生成的应收来源（一个订单分批出库 = 多条），草稿可编辑/确认/取消；
//   2. 应收对账：按客户 + 期间创建对账单（自动汇总该期间的出库条目为明细），对平后可一键确认一批；
//   3. 确认应收：应收台账，**勾选多条一次确认**（确认即记账，金额记入所选银行账户）。
// 双击任意行都会弹出居中详情页（展示全部字段与可用操作），详情数据来自对应的 :id 接口。
//
// 2026-09-16（用户要求「应收侧也改成勾选 + 批量确认」）：确认应收本身就会记一笔收入，
// 而「登记收款 → 过账核销」会**再记一笔**收入 —— 同一笔货款进两次账户。所以收款子表与
// 行内「登记收款」下线，确认这边只保留「勾选 + 批量确认」（与应付侧完全对称）。
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
import { RECEIVABLE_TABS, CASH_FLOW_ITEM_DICTIONARY_KEY, type ReceivableTabKey } from "../../lib/finance-sections";
import { notifyError, notifySuccess } from "../ui/toaster";
import { FinanceTabs } from "./finance-tabs";
import { RecordDetailDialog, money, type DetailField } from "./record-detail-dialog";
import { financeStatus } from "./finance-status";

/**
 * 银行下拉的「清空」哨兵值。
 *
 * 银行是可选字段，选错了必须能去掉；而 Radix Select 不接受空串 value，所以用一个显式哨兵值表示「不指定银行」，
 * 提交时再翻译成 null（后端 DTO 的 @IsOptional 会放过 null 并按「清空」处理）。
 */
const BANK_CLEAR = "__no_bank__";
/**
 * 收支项目下拉的「清空」哨兵值。
 *
 * 收支项目也是可选的，而已有单据上的项目要能去掉（后端 PATCH 收 null 表示清空）；
 * 但**未改动**时必须送 undefined，否则每次「只改金额」都会把单据上已有的项目一并抹掉。
 * Radix Select 不接受空串 value，所以空值代表「不改动」、哨兵值代表「明确清空」。
 */
const CASH_FLOW_ITEM_CLEAR = "__no_cash_flow_item__";

type Reference = { id: string; name: string; customerCode?: string; orderNo?: string };
type CustomerRef = { id: string; name: string; customerCode: string | null };
/** 银行账户池条目（财务 → 银行账户）。收款的「到账银行」只能从这里选，不在这里手输账户。 */
type BankRef = { id: string; bankCode: string; bankName: string; accountName: string; accountNumber: string; currency: string; isActive: boolean };
type BankLink = { id: string; bankName: string; accountNumber: string } | null;
/** 收支项目字典项（财务 → 收支管理 → 收支项目）。 */
type DictionaryItem = { id: string; key: string; label: string; isActive: boolean };
type SourceAllocation = { id: string; amount: string; status: string; payment?: { id: string; paymentNo: string; status: string; paymentDate: string; amount?: string; currency?: string } | null };
/** 覆盖这条应收的对账单（列表接口算好给前端：对账范围是「订单号或客户 + 币种 + 期间」，前端推不出来）。 */
type ReconciliationRef = { id: string; reconciliation_no: string; status: string; period_start: string; period_end: string };
type ReceivableSource = {
  id: string; sourceNo: string; orderNo: string; customerId: string; outboundId: string;
  quantity: string; unit: string; unitPrice: string | null; taxRate: string | null; amount: string; currency: string;
  amountReason: string | null; status: string; dueDate: string | null; invoiceNo: string | null; invoiceDate: string | null;
  signedAtSnapshot: string | null; remark: string | null; createdAt: string;
  customer_name: string | null; customer_code: string | null; outbound_no: string | null;
  product_name: string | null; product_specification: string | null;
  allocated_amount: string; outstanding_amount: string;
  reconciliation?: ReconciliationRef | null;
  customer?: CustomerRef | null;
  outbound?: { outboundNo: string; status: string; productNameSnapshot: string | null; productSpecificationSnapshot: string | null; signedAt: string | null; shipmentDate: string | null } | null;
  allocations?: SourceAllocation[];
};
type ReconciliationEntry = ReceivableSource;
type Reconciliation = {
  id: string; reconciliationNo: string; orderNo: string | null; customerId: string;
  periodStart: string; periodEnd: string; receivableAmountSnapshot: string; paymentAmountSnapshot: string;
  adjustmentAmountSnapshot: string; systemBalance: string; externalBalance: string; difference: string;
  currency: string; status: string; resolutionRemark: string | null; remark: string | null; createdAt: string;
  bankId?: string | null; bank?: BankLink;
  /** 建单/确认时人工选定的收支项目（确认应收时用它，除非确认接口再覆盖）。 */
  cashFlowItemId?: string | null;
  customer?: CustomerRef | null;
  status_label?: string;
  /** 流转摘要（列表接口就给，与应付对账的 flow 对称）：覆盖多少条、多少条待确认、哪些订单与产品。 */
  flow?: {
    entry_count: number; draft_count: number; draft_amount: string; can_confirm_receivables: boolean;
    order_nos: string[]; product_names: string[]; product_specifications: string[];
  };
  details?: { entries: ReconciliationEntry[]; draft_entries: ReconciliationEntry[]; entry_count: number; draft_count: number; draft_amount: string; can_confirm_receivables: boolean };
};
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> };
/**
 * 「确认应收」三个入口（逐条 / 勾选批量 / 按对账单）共用的响应字段（见 submitConfirm）。
 * 逐条与按对账单回金额，批量回条数与按币种合计；`bank_missing` 表示钱记了但没落到任何银行账户。
 */
type ConfirmResult = {
  bank_missing?: boolean; amount?: string; currency?: string; count?: number;
  confirmed_amount?: string; confirmed_count?: number; skipped_count?: number;
  /** 勾选批量确认的按币种合计（跨币种不相加）。 */
  amounts?: Array<{ currency: string; amount: string }>;
};
type DetailKind = "source" | "reconciliation";

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : "-");
const monthOf = (value: string | null | undefined) => (value ? value.slice(0, 7) : "-");
const monthRange = (month: string) => ({ start: `${month}-01`, end: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10) });

export default function ReceivableWorkspace({ tab, testId }: { tab: ReceivableTabKey; testId: string }) {
  const [sources, setSources] = useState<ReceivableSource[]>([]);
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([]);
  const [customers, setCustomers] = useState<Reference[]>([]);
  const [orders, setOrders] = useState<Reference[]>([]);
  const [banks, setBanks] = useState<BankRef[]>([]);
  const [cashFlowItems, setCashFlowItems] = useState<DictionaryItem[]>([]);
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
  /** 勾选出来待确认的应收条目 id（「确认应收」页的批量确认用）。 */
  const [selected, setSelected] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // 客户/销售单走 sales 权限：只有财务权限的账号拉不到它们，但不应因此整页报错（选项留空即可）。
      // 银行账户池同理（走 finance 权限，正常能拿到）。
      // 收支项目同样走字典接口；过账时要给财务一个「人工选项目」的出口，拉不到就退回后端自动归类。
      const [s, r, c, o, b, i] = await Promise.all([
        apiGet<ReceivableSource[]>("/finance/receivable-sources"),
        apiGet<Reconciliation[]>("/finance/reconciliations"),
        apiGet<Reference[]>("/customers").catch(() => ({ data: [] as Reference[], meta: {} })),
        apiGet<Reference[]>("/sales-orders").catch(() => ({ data: [] as Reference[], meta: {} })),
        apiGet<BankRef[]>("/finance/banks").catch(() => ({ data: [] as BankRef[], meta: {} })),
        apiGet<DictionaryItem[]>(`/dictionaries/${CASH_FLOW_ITEM_DICTIONARY_KEY}/items`).catch(() => ({ data: [] as DictionaryItem[], meta: {} })),
      ]);
      setSources(s.data); setReconciliations(r.data); setCustomers(c.data); setOrders(o.data); setBanks(b.data); setCashFlowItems(i.data);
      // 勾选状态跟着数据走：已被确认/取消的条目自动退出勾选（界面上再也点不到它们，
      // 留着 id 会让「批量确认 N 条」里的 N 与实际能确认的条数对不上）。
      setSelected((ids) => ids.filter((id) => s.data.some((source) => source.id === id && source.status === "draft")));
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

  /**
   * 「确认应收」三个入口（逐条 / 勾选批量 / 按对账单）共用的提交与提示。
   *
   * 这三条路径现在都是**确认即记账**（用户要求「一旦确认应收，金额就要进入对应的账户」），
   * 所以不能再用 action() 一句「已确认」了事：响应里的 `bank_missing` 表示钱已经记进收支流水、
   * 但不属于任何银行账户 —— 这时报成功会让财务以为银行里已经多了这笔钱，必须改成警告。
   *
   * 失败时把错误**抛回** ActionDialog（它靠 onSubmit 是否 reject 决定关不关弹窗），
   * 与应付页 submitAction 同一理由：失败不能静默关闭。
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

  // 详情弹窗打开时按 :id 拉详情：列表接口给不出全部字段（来源追踪、核销明细、对账纳入条目等）。
  const detailKind = detail?.kind;
  const detailId = detail?.id;
  useEffect(() => {
    if (!detailKind || !detailId) { setDetailData(null); return; }
    let cancelled = false;
    const path = detailKind === "source" ? `/finance/receivable-sources/${detailId}` : `/finance/reconciliations/${detailId}`;
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
    name: "bank_id", label: `${label}（可选）`, type: "select",
    options: [{ value: BANK_CLEAR, label: "（不指定银行）" }, ...bankOptions],
    defaultValue: current || BANK_CLEAR,
  });
  /** 哨兵值 → 提交值：清空要显式送 null，未改动则送 undefined（后端不更新该字段）。 */
  const bankValue = (value: string | undefined) => (value === BANK_CLEAR ? null : (value || undefined));
  /** 可人工指定的收支项目：只给启用项，留空则由后端按来源自动归类。 */
  const cashFlowItemOptions = cashFlowItems.filter((item) => item.isActive).map((item) => ({ value: item.id, label: item.label }));
  /**
   * 收支项目 id → 显示名。
   *
   * 列表/详情接口只给 `cashFlowItemId`（Prisma 不外带字典对象），标签得在前端拿字典项还原；
   * 字典里查不到（项目被删/停用，或权限不够没拉到字典）就显示 `-`，不能让整页崩在这里。
   */
  const cashFlowItemLabel = (id: string | null | undefined) => cashFlowItems.find((item) => item.id === id)?.label ?? "-";
  /**
   * 建单弹窗的收支项目：可选，留空即交给后端按来源自动归类（应收默认「货款」）；
   * 新建单据上本来就没有项目可清，所以不摆「清空」哨兵（避免多出一个必然选不中的选项）。
   */
  const cashFlowItemCreateField = (label: string): ActionField => ({ name: "cash_flow_item_id", label, type: "select", options: cashFlowItemOptions });
  /**
   * 已有单据上的收支项目：默认带出当前值；选「（不指定收支项目）」送 null。
   *
   * 默认值用 `current ?? ""`（而不是银行那种「当前值否则哨兵」）是刻意的：未改动时必须送 undefined，
   * 后端 PATCH 才完全不动这个字段；若默认成哨兵，以后端「将来给这类单据补默认值」为例，
   * 用户只改金额就会把默认值一起抹成 null。
   */
  const cashFlowItemEditField = (label: string, current?: string | null): ActionField => ({
    name: "cash_flow_item_id", label, type: "select",
    options: [{ value: CASH_FLOW_ITEM_CLEAR, label: "（不指定收支项目）" }, ...cashFlowItemOptions],
    defaultValue: current ?? "",
  });
  /** 哨兵/空值 → 提交值：明确清空送 null，未改动送 undefined（后端不更新该字段）。 */
  const cashFlowItemValue = (value: string | undefined) => (value === CASH_FLOW_ITEM_CLEAR ? null : (value || undefined));

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
  /**
   * 逐条确认应收 —— 与「勾选批量确认」「一键确认应收」（按对账单）是同一件事的三条入口，都**确认即记账**。
   *
   * 应收来源本身不挂银行账户（它来自出库单），所以这里必须问清「钱进哪个账户」：
   * 不指定就只能在收支流水里留一笔无归属的钱（后端回 bank_missing，上面会警告）。
   */
  function confirmSource(item: ReceivableSource) {
    setDialog({ title: `确认应收：${item.sourceNo}`, fields: [
      { name: "confirm", label: `确认应收 ${item.sourceNo}：${item.amount} ${item.currency}`, type: "info" as const },
      bankField("入账银行"),
      cashFlowItemEditField("收支项目"),
    ], submit: (v) => submitConfirm(`/finance/receivable-sources/${item.id}/confirm`, { bank_id: bankValue(v.bank_id), cash_flow_item_id: cashFlowItemValue(v.cash_flow_item_id) }, (data) => ({
      success: `应收 ${item.sourceNo} 已确认（${data.amount ?? item.amount} ${data.currency ?? item.currency}），金额已记入所选银行账户`,
      warning: `未指定入账银行：${data.amount ?? item.amount} ${data.currency ?? item.currency} 已记入收支流水，但不会体现在任何银行账户余额里`,
    }), "确认应收失败") });
  }
  /**
   * 勾选批量确认 —— 用户要求「应收侧也改成勾选 + 批量确认」（与应付侧完全对称）。
   *
   * 整批共用一个入账银行与一个收支项目（后端仍是**每条应收写一条流水**，所以每条都追得回来源编号）；
   * 合计**按币种分组**显示，跨币种不相加。勾选里混进已被别人确认掉的条目时，后端会跳过并回报条数。
   */
  function batchConfirm() {
    const drafts = sources.filter((source) => source.status === "draft" && selected.includes(source.id));
    const totals = new Map<string, number>();
    for (const draft of drafts) totals.set(draft.currency, (totals.get(draft.currency) ?? 0) + Number(draft.amount));
    setDialog({ title: `批量确认应收（${drafts.length} 条）`, fields: [
      { name: "confirm", label: `确认 ${drafts.length} 条草稿应收（合计 ${[...totals.entries()].map(([currency, amount]) => `${amount.toFixed(4)} ${currency}`).join("、")}）`, type: "info" as const },
      bankField("入账银行"),
      cashFlowItemEditField("收支项目"),
    ], submit: (v) => submitConfirm("/finance/receivable-sources/batch-confirm", { ids: drafts.map((draft) => draft.id), bank_id: bankValue(v.bank_id), cash_flow_item_id: cashFlowItemValue(v.cash_flow_item_id) }, (data) => {
      const amount = data.amounts?.length ? data.amounts.map((item) => `${item.amount} ${item.currency}`).join("、") : "-";
      const skipped = data.skipped_count ? `；跳过 ${data.skipped_count} 条` : "";
      return {
        success: `已确认 ${data.confirmed_count ?? drafts.length} 条应收（${amount}）${skipped}，金额已记入所选银行账户`,
        warning: `未指定入账银行：${amount} 已记入收支流水，但不会体现在任何银行账户余额里`,
      };
    }, "批量确认应收失败") });
  }

  function createReconciliation(preset?: { customerId: string; month: string }) {
    const range = preset ? monthRange(preset.month) : undefined;
    setDialog({ title: "创建应收对账", fields: [
      { name: "customer_id", label: "客户", type: "select", required: true, canAddCategory: true, options: customerOptions, defaultValue: preset?.customerId },
      { name: "order_no", label: "订单号（可选）", type: "select", options: orderOptions },
      { name: "period_start", label: "期间开始", type: "date", required: true, defaultValue: range?.start },
      { name: "period_end", label: "期间结束", type: "date", required: true, defaultValue: range?.end },
      { name: "external_balance", label: "外部余额", type: "number", required: true },
      { name: "currency", label: "币种", type: "select", required: true, options: currencyOptions(currencyCatalogue), defaultValue: currencyDefault("CNY") },
      bankField("回款银行"),
      cashFlowItemCreateField("收支项目"),
      { name: "remark", label: "备注", type: "textarea" },
    ], submit: (v) => void action("/finance/reconciliations", { customer_id: v.customer_id, order_no: v.order_no || undefined, period_start: v.period_start, period_end: v.period_end, external_balance: v.external_balance, currency: v.currency, bank_id: bankValue(v.bank_id), cash_flow_item_id: v.cash_flow_item_id || undefined, remark: v.remark || undefined }, "对账单已创建") });
  }
  function resolveReconciliation(item: Reconciliation) {
    setDialog({ title: `处理对账差异：${item.reconciliationNo}`, fields: [{ name: "remark", label: "处理说明", type: "textarea", required: true, defaultValue: "已核对" }], submit: (v) => void action(`/finance/reconciliations/${item.id}/resolve`, { resolution_remark: v.remark }, "对账差异已处理") });
  }
  /**
   * 确认应收 —— 先问清入账信息。
   *
   * 这个接口不只是改状态：确认的金额会作为一笔收入写进收支流水，并落到对账单的银行账户上。
   * 历史对账单（尤其是这次改动之前建的）常常既没有银行也没有收支项目，直接打过去就是「钱记了、
   * 但哪个账户都没有」，事后对账根本查不出这笔钱去哪了；所以把「记到哪个银行、归哪个项目」摆到台面上。
   */
  function confirmReconciliation(item: Reconciliation) {
    const count = item.details?.draft_count ?? item.flow?.draft_count ?? 0;
    const amount = item.details?.draft_amount ?? item.flow?.draft_amount;
    setDialog({ title: `确认应收：${item.reconciliationNo}`, fields: [
      { name: "confirm", label: `确认 ${count} 条草稿应收${amount ? `（合计 ${amount} ${item.currency}）` : ""}`, type: "info" as const },
      bankField("入账银行", item.bankId),
      cashFlowItemEditField("收支项目", item.cashFlowItemId),
    ], submit: (v) => submitConfirmReconciliation(item, v) });
  }
  /**
   * 确认应收的提交：与逐条 / 批量确认共用 submitConfirm（三条路径都会记账，都要处理 bank_missing）。
   */
  async function submitConfirmReconciliation(item: Reconciliation, v: Record<string, string>) {
    return submitConfirm(`/finance/reconciliations/${item.id}/confirm-receivables`, { bank_id: bankValue(v.bank_id), cash_flow_item_id: cashFlowItemValue(v.cash_flow_item_id) }, (data) => {
      const count = data.confirmed_count ?? data.count ?? 0;
      const amount = data.confirmed_amount ?? data.amount ?? "-";
      const currency = data.currency ?? item.currency;
      return {
        success: `${item.reconciliationNo} 已确认 ${count} 条应收（${amount} ${currency}），金额已记入所选银行账户`,
        warning: `未指定入账银行：${amount} ${currency} 已记入收支流水，但不会体现在任何银行账户余额里`,
      };
    }, "批量确认应收失败");
  }

  // ---------------------------------------------------------------- 待创建对账

  /**
   * 「待创建对账的条目」= **逐条**列出还没有被任何对账单覆盖的草稿应收（与应付侧同一套写法）。
   *
   * 为什么不再按客户 + 月份汇总：汇总行只显示「N 条」，新生成的出库条目被折叠进计数里，
   * 用户看不出「这条到底在不在表里」；已经纳入过对账单的草稿由列表接口标记（`reconciliation`）
   * 从本表移出，并在下面点名说明它进了哪张对账单（不能让它不声不响地消失）。
   */
  const pendingReconcile = useMemo(() => sources.filter((source) => source.status === "draft" && !source.reconciliation), [sources]);
  const coveredDrafts = useMemo(() => sources.filter((source) => source.status === "draft" && source.reconciliation), [sources]);
  const pendingReconcileTotal = pendingReconcile.reduce((sum, source) => sum + Number(source.amount), 0);

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
  // 应收来源行的操作：成品出库条目与确认应收两张表共用同一套动作，避免两边行为漂移。
  // 没有「登记收款」：确认应收已经把钱记进账户，再登记一次收款就是把同一笔款进两次。
  const sourceActions = (item: ReceivableSource) => <div className="action-row">
    {item.status === "draft" && <><Button size="sm" variant="secondary" onClick={() => confirmSource(item)}>确认应收</Button><Button size="sm" variant="ghost" onClick={() => editSource(item)}>编辑</Button><Button size="sm" variant="ghost" onClick={() => cancelSource(item)}>取消</Button></>}
    {item.status === "confirmed" && <Button size="sm" variant="ghost" onClick={() => reopenSource(item)}>回退草稿</Button>}
  </div>;

  // 勾选只对草稿开放：已确认/取消的条目没有「再确认一次」这回事。
  const selectableIds = useMemo(() => ledgerSources.filter((item) => item.status === "draft").map((item) => item.id), [ledgerSources]);
  const selectedDrafts = useMemo(() => sources.filter((item) => item.status === "draft" && selected.includes(item.id)), [sources, selected]);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.includes(id));
  const toggleOne = (id: string) => setSelected((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
  const toggleAll = () => setSelected((ids) => allSelected ? ids.filter((id) => !selectableIds.includes(id)) : [...new Set([...ids, ...selectableIds])]);
  const selectionColumn: ColumnDef<ReceivableSource> = {
    id: "select",
    header: () => <input type="checkbox" aria-label="全选待确认应收" data-testid="receivable-select-all" checked={allSelected} disabled={!selectableIds.length} onChange={toggleAll} />,
    cell: ({ row }) => row.original.status === "draft"
      ? <input type="checkbox" aria-label={`选择 ${row.original.sourceNo}`} data-testid={`receivable-select-${row.original.id}`} checked={selected.includes(row.original.id)} onChange={() => toggleOne(row.original.id)} />
      : null,
  };

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
  // 「确认应收」用台账视角的列：带勾选框、到期日与状态。
  // 不再列「已收 / 未收」：这两列来自**收款单核销**，而本轮已经把「登记收款 → 过账核销」从确认流程去掉
  // （确认应收本身就把钱记进了账户）。留着只会让每条已确认的应收显示「未收 = 全额」，与事实相反。
  // 核销明细仍在双击后的详情里。
  const ledgerColumns: ColumnDef<ReceivableSource>[] = [
    selectionColumn,
    { accessorKey: "sourceNo", header: "应收来源" },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "customer", header: "客户", cell: ({ row }) => row.original.customer_name ?? row.original.customer_code ?? "-" },
    { id: "amount", header: "应收金额", cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "due", header: "到期日", cell: ({ row }) => day(row.original.dueDate) },
    { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "receivable") },
    { id: "actions", header: "操作", cell: ({ row }) => sourceActions(row.original) },
  ];
  const reconciliationColumns: ColumnDef<Reconciliation>[] = [
    { accessorKey: "reconciliationNo", header: "对账单号" },
    { id: "customer", header: "客户", cell: ({ row }) => row.original.customer?.name ?? "-" },
    { id: "order", header: "订单号", cell: ({ row }) => row.original.orderNo ?? (row.original.flow?.order_nos.length ? row.original.flow.order_nos.join("、") : "全部订单") },
    // 用户要求（应付侧同款）：对账要能看出「这批货是什么、什么规格」。
    { id: "product", header: "产品", cell: ({ row }) => row.original.flow?.product_names?.join("、") || "-" },
    { id: "specification", header: "规格型号", cell: ({ row }) => row.original.flow?.product_specifications?.join("、") || "-" },
    { id: "period", header: "期间", cell: ({ row }) => `${day(row.original.periodStart)} 至 ${day(row.original.periodEnd)}` },
    { id: "entries", header: "待确认应收", cell: ({ row }) => row.original.flow && row.original.flow.draft_count > 0 ? `${row.original.flow.draft_count} 条 / ${row.original.flow.draft_amount}` : "-" },
    { id: "receivable", header: "应收快照", cell: ({ row }) => money(row.original.receivableAmountSnapshot, row.original.currency) },
    { id: "paid", header: "已收快照", cell: ({ row }) => money(row.original.paymentAmountSnapshot, row.original.currency) },
    { id: "system", header: "系统余额", cell: ({ row }) => money(row.original.systemBalance, row.original.currency) },
    { id: "external", header: "外部余额", cell: ({ row }) => money(row.original.externalBalance, row.original.currency) },
    { id: "difference", header: "差异", cell: ({ row }) => money(row.original.difference, row.original.currency) },
    { id: "bank", header: "回款银行", cell: ({ row }) => row.original.bank ? `${row.original.bank.bankName}（${row.original.bank.accountNumber}）` : "-" },
    // 建单时人工选的收支项目（确认应收记流水时用它）；只拿到 id，标签在前端用字典还原。
    { id: "cashFlowItem", header: "收支项目", cell: ({ row }) => cashFlowItemLabel(row.original.cashFlowItemId) },
    { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "reconciliation") },
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row" data-testid={`reconciliation-actions-${row.original.id}`}>
      {row.original.status === "difference" && <Button size="sm" variant="secondary" onClick={() => resolveReconciliation(row.original)}>处理差异</Button>}
      {/* 范围里确实还有草稿才给「一键确认」：点一个只会空转 0 条的按钮比没有按钮更误导 */}
      {row.original.flow?.can_confirm_receivables ? <Button size="sm" data-testid={`reconciliation-confirm-${row.original.id}`} onClick={() => confirmReconciliation(row.original)}>一键确认应收（{row.original.flow.draft_count} 条）</Button> : null}
      {["matched", "resolved"].includes(row.original.status) && row.original.flow && row.original.flow.draft_count === 0 ? <span className="panel-note">范围内没有待确认应收</span> : null}
    </div> },
  ];
  /**
   * 「待创建对账的条目」逐条列：一行一条草稿应收，能看到客户 / 来源编号 / 出库单 / 订单号 /
   * 产品与规格型号 / 金额。行内「创建对账」按该条的客户 + 月份建单（一张对账单覆盖该客户该月全部待确认应收）。
   */
  const pendingSourceColumns: ColumnDef<ReceivableSource>[] = [
    { id: "customer", header: "客户", cell: ({ row }) => row.original.customer_name ?? row.original.customer_code ?? row.original.customerId },
    { accessorKey: "sourceNo", header: "应收来源" },
    { id: "month", header: "待对账月份", cell: ({ row }) => monthOf(row.original.createdAt) },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "outbound", header: "出库单", cell: ({ row }) => row.original.outbound_no ?? "-" },
    { id: "product", header: "产品", cell: ({ row }) => row.original.product_name ?? "-" },
    { id: "specification", header: "规格型号", cell: ({ row }) => row.original.product_specification ?? "-" },
    { id: "amount", header: "应收金额", cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "created", header: "出库日期", cell: ({ row }) => day(row.original.createdAt) },
    { id: "actions", header: "操作", cell: ({ row }) => <Button size="sm" variant="secondary" title="按这条的客户 + 月份创建：一张对账单覆盖该客户该月全部待确认应收" onClick={() => createReconciliation({ customerId: row.original.customerId, month: monthOf(row.original.createdAt) })}>创建对账</Button> },
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
    if (detail?.kind === "reconciliation" && detailData) {
      const item = detailData as Reconciliation;
      return [
        { label: "对账单号", value: item.reconciliationNo }, { label: "状态", value: financeStatus(item.status, "reconciliation") },
        { label: "客户", value: item.customer?.name ?? item.customerId }, { label: "订单号", value: item.orderNo ?? "全部订单" },
        // 用户要求（应付侧同款）：双击已创建对账单，弹窗里要能直接看到这批货的名称与规格型号。
        { label: "产品", value: item.flow?.product_names?.join("、"), wide: true },
        { label: "规格型号", value: item.flow?.product_specifications?.join("、"), wide: true },
        { label: "期间", value: `${day(item.periodStart)} 至 ${day(item.periodEnd)}` },
        { label: "应收快照", value: money(item.receivableAmountSnapshot, item.currency) },
        { label: "已收快照", value: money(item.paymentAmountSnapshot, item.currency) },
        { label: "调整净额快照", value: money(item.adjustmentAmountSnapshot, item.currency) },
        { label: "系统余额", value: money(item.systemBalance, item.currency) },
        { label: "外部余额", value: money(item.externalBalance, item.currency) },
        { label: "差异", value: money(item.difference, item.currency) },
        { label: "回款银行", value: item.bank ? `${item.bank.bankName} / ${item.bank.accountNumber}` : "-" },
        { label: "收支项目", value: cashFlowItemLabel(item.cashFlowItemId) },
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
      return [{ title: `收款核销记录（${allocations.length} 条）`, content: allocations.length
        ? <DataTable pageSize={10} columns={[{ accessorKey: "id", header: "核销 ID" }, { id: "payment", header: "收款单号", cell: ({ row }) => row.original.payment?.paymentNo ?? "-" }, { id: "date", header: "收款日期", cell: ({ row }) => day(row.original.payment?.paymentDate) }, { id: "status", header: "收款状态", cell: ({ row }) => financeStatus(row.original.payment?.status, "receivable") }, { id: "amount", header: "核销金额", cell: ({ row }) => money(row.original.amount, row.original.payment?.currency ?? item.currency) }] as ColumnDef<SourceAllocation>[]} data={allocations} /> : <p className="panel-note">暂无收款核销</p> }];
    }
    if (detail?.kind === "reconciliation" && detailData) {
      const item = detailData as Reconciliation;
      const entries = item.details?.entries ?? [];
      return [{ title: `纳入对账的应收条目（${entries.length} 条）`, content: entries.length
        ? <DataTable pageSize={10} columns={[{ accessorKey: "sourceNo", header: "应收来源" }, { accessorKey: "orderNo", header: "订单号" }, { id: "customer", header: "客户", cell: ({ row }) => row.original.customer_name ?? "-" }, { id: "product", header: "产品", cell: ({ row }) => row.original.product_name ?? "-" }, { id: "specification", header: "规格型号", cell: ({ row }) => row.original.product_specification ?? "-" }, { id: "amount", header: "金额", cell: ({ row }) => money(row.original.amount, row.original.currency) }, { id: "outstanding", header: "未收", cell: ({ row }) => money(row.original.outstanding_amount, row.original.currency) }, { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "receivable") }] as ColumnDef<ReconciliationEntry>[]} data={entries} /> : <p className="panel-note">该期间没有纳入对账的应收条目</p> }];
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
      </>;
    }
    if (detail?.kind === "reconciliation") {
      const item = detailData as Reconciliation;
      return <>
        {item.status === "difference" && <Button onClick={() => resolveReconciliation(item)}>处理差异</Button>}
        {/* 与列表同一口径：范围内确实还有草稿才给一键确认；点开的是「确认应收」弹窗（问清入账银行与收支项目） */}
        {item.details?.can_confirm_receivables ? <Button onClick={() => confirmReconciliation(item)}>一键确认应收（{item.details.draft_count} 条）</Button> : null}
      </>;
    }
    return null;
  }

  const detailTitle = detail?.kind === "source" ? `应收来源 ${(detailData as ReceivableSource | null)?.sourceNo ?? ""}` : `应收对账 ${(detailData as Reconciliation | null)?.reconciliationNo ?? ""}`;
  const activeTab = RECEIVABLE_TABS.find((item) => item.key === tab) ?? RECEIVABLE_TABS[0];

  if (loading) return <><PageHeader title="应收管理" /><LoadingState /></>;

  return <div className="page-root" data-testid={testId}>
    <PageHeader title="应收管理">
      <Button asChild variant="secondary"><Link href="/finance">返回财务</Link></Button>
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
      // 把 submit 的返回值交给 ActionDialog（而不是丢掉）：确认应收这类请求失败时要**留在弹窗里**
      // 显示原因，ActionDialog 靠 onSubmit 是否 reject 决定关不关（与应付页同一理由）。
      onSubmit={(values) => dialog?.submit(values)} />
    <ActionDialog open={Boolean(categoryDialog)} onOpenChange={(open) => { if (!open) { setCategoryDialog(null); setPendingDialog(null); } }} title={categoryDialog?.title ?? "新建客户"} fields={categoryDialog?.fields ?? []} onSubmit={(values) => { categoryDialog?.submit(values); }} />
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
    {!error && activeTab.key === "outbound-entries" && <>
      <section className="panel panel-body">
        <div className="filter-bar"><label>搜索<Input value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} placeholder="来源编号 / 订单号 / 客户 / 出库单 / 产品" /></label></div>
        <p className="panel-note">待确认应收 {pendingSources.length} 笔 / 合计 {pendingAmount.toFixed(2)}</p>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>成品出库条目</h2><span className="panel-note">共 {outboundSources.length} 条</span></div>
        <div className="panel-body"><DataTable columns={sourceColumns} data={outboundSources} empty={<EmptyState title="暂无成品出库形成的应收来源" />} onRowDoubleClick={(row) => setDetail({ kind: "source", id: row.id })} rowTitle="双击查看详情" /></div>
      </section>
    </>}
    {!error && activeTab.key === "reconciliations" && <>
      <section className="panel">
        <div className="panel-heading">
          <h2>待创建对账的条目</h2>
          {/* 条数放在 h2 外面：标题保持原样，按标题定位这个面板的脚本/测试才不会被条数干扰。 */}
          <span className="panel-note" data-testid="receivable-pending-summary">{pendingReconcile.length} 条 / 合计 {pendingReconcileTotal.toFixed(2)}</span>
        </div>
        <div className="panel-body">
          <div data-testid="receivable-pending-entries">
            <DataTable columns={pendingSourceColumns} data={pendingReconcile} empty={<EmptyState title="没有待创建对账的条目" />} onRowDoubleClick={(row) => setDetail({ kind: "source", id: row.id })} rowTitle="双击查看详情" />
          </div>
          {/* 已被对账单覆盖的草稿必须点名，否则用户会以为「这条应收没流转过去」。 */}
          {coveredDrafts.length ? <p className="panel-note" data-testid="receivable-covered-drafts">
            另有 {coveredDrafts.length} 条出库条目已纳入对账单、不在此重复对账：{coveredDrafts.map((source) => `${source.sourceNo}（${source.reconciliation?.reconciliation_no}）`).join("、")}
          </p> : null}
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>应收对账单</h2><span className="panel-note">共 {reconciliations.length} 张</span></div>
        <div className="panel-body"><DataTable columns={reconciliationColumns} data={reconciliations} empty={<EmptyState title="暂无应收对账单" />} onRowDoubleClick={(row) => setDetail({ kind: "reconciliation", id: row.id })} rowTitle="双击查看详情" /></div>
      </section>
    </>}
    {!error && activeTab.key === "confirmed" && <section className="panel">
      <div className="panel-heading"><h2>确认应收</h2><span className="panel-note">共 {ledgerSources.length} 条 · 草稿 {pendingSources.length} 条</span></div>
      <div className="panel-body">
        <div style={{ marginBottom: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem" }} data-testid="receivable-batch-bar">
          <span className="panel-note" data-testid="receivable-selected-count">已选 {selectedDrafts.length} 条</span>
          <Button size="sm" data-testid="receivable-batch-confirm" disabled={!selectedDrafts.length} onClick={batchConfirm}>批量确认（{selectedDrafts.length} 条）</Button>
        </div>
        <DataTable columns={ledgerColumns} data={ledgerSources} empty={<EmptyState title="暂无应收台账" />} onRowDoubleClick={(row) => setDetail({ kind: "source", id: row.id })} rowTitle="双击查看详情" />
      </div>
    </section>}
  </div>;
}
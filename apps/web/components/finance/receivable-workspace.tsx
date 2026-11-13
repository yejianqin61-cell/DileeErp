"use client";

// 应收管理二级页（/finance/receivable?tab=...）。
//
// 三个子栏目按业务顺序排列，对应「先有出库、再对账、最后确认应收」：
//   1. 成品出库条目：成品出库过账自动生成的应收来源（一个订单分批出库 = 多条），草稿可编辑/确认/取消；
//   2. 应收对账：按客户 + 期间创建对账单（自动汇总该期间的出库条目为明细），对平后可一键确认一批；
//   3. 确认应收：应收台账，**勾选多条一次确认**（2026-09-24 起确认 = **挂账**：借应收账款/贷收入，钱未到账；
//      收款走「合并收款」整单结清 —— 2026-11-09 D4：核销金额 = 该应收未收余额，收款金额 = Σ核销金额）。
// 双击任意行都会弹出居中详情页（展示全部字段与可用操作），详情数据来自对应的 :id 接口。
//
// 2026-09-16（用户要求「应收侧也改成勾选 + 批量确认」）：当时的理由「确认应收本身就会记一笔收入」
// **已被 2026-09-24 挂账口径取代**（确认只挂账、钱没到；收款另走「合并收款」，见下方）。
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../layout/app-shell";
import { DataTable } from "../data/data-table";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { SearchableSelect } from "../ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost } from "../../lib/api-client";
import { downloadFile } from "../../lib/download";
import { formatBeijingDate } from "../../lib/audit-time";
import { ledgerExportQuery, paymentBucket, paymentCounts, withinDateRange, type LedgerPaymentFilter } from "../../lib/finance-ledger-filter";
import { currencyOptions, currencyOptionsWithCurrent, fetchCurrencyOptions, type CurrencyOption } from "../../lib/currency-catalogue";
import { RECEIVABLE_TABS, RECEIVABLE_TAB_ALIASES, resolveFinanceTab, type ReceivableTabParam } from "../../lib/finance-sections";
import { ACCOUNTING_SUBJECTS_PATH, subjectOptionLabel, toSubjectOptions, type AccountingSubject } from "../../lib/accounting-subjects";
import { accrualStatusLabel, isAccrualReversed, type AccrualReaccrueResult } from "../../lib/accrual-status";
import { paymentNatureOptions } from "../../lib/payment-natures";
import { notifyError, notifySuccess } from "../ui/toaster";
import { FinanceTabs } from "./finance-tabs";
import FinanceSlipEditor from "./finance-slip-editor";
import { RecordDetailDialog, money, type DetailField } from "./record-detail-dialog";
import { auditColumns, auditDetailFields, type AuditRow } from "../data/audit-columns";
import { OrderNoWithOrphan } from "../data/orphan-badge";
import { financeStatus } from "./finance-status";
import { financeSlipDraftBody, financeSlipDraftPath, formatSlipAmount, parseSlipAmount, type FinanceSlipDraft } from "../../lib/finance-slip";

/**
 * 本页四张表的列宽（百分比）。
 *
 * 为什么需要：2026-10-09 起 `DataTable`**一律**给 `<table>` 加 `data-table-fixed` → `table-layout: fixed`
 * （components/data/data-table.tsx），没写 `meta.width` 的列由浏览器**均分**容器宽度。
 * 均分对财务表是错的：`应收金额` / `未收` 会跟 `状态` 拿到一样宽，金额被截成看不全。
 *
 * 总和为什么是 84%：四张表都用 `auditColumns()` 追加「创建人 / 最后修改人」，那两列是列工厂产物、
 * **不给宽度**（`lib/audit-columns-coverage.test.mjs` 盯着用法，不要改成逐列挂 meta），
 * 剩下的 16% 由它们均分（各 8%）。多一个点就会让表比容器宽、把横向滚动条拉回来。
 *
 * ⚠️ 本页在 `.finance-page` 内，`globals.css` 的 `.finance-page .ui-table.data-table-fixed` 三条会把它
 * 放回「自动布局 + 换行」（财务口径：金额换行也要看得全，不能被省略）。也就是说**页面里的表**上，
 * 下面这些数字是**建议宽度**、浏览器仍会按内容调整；**弹窗里**的表（Radix Portal，够不到 `.finance-page`）
 * 才是硬约束。两边都要给 —— 不给就是一个 19 列的表格每列均分到 4%。
 *
 * 分配原则：金额列（应收金额 / 未收 / 应收快照 / 已收快照 / 系统余额 / 外部余额 / 差异 / 核销金额）
 * 在列数允许时给到 6%~13%（钱最要紧）；名称与单号列次之；日期（`2026-10-09` 定长 10 字符）给 6%~7%；
 * 状态 4%~5%；操作列按按钮数估（每个小按钮约 44px + 间距 4px ÷ 1366 屏的 1034px 可用宽度）。
 * 对账明细表有 19 列，84% 摊下来每列只有 4%~6% —— 这是列数决定的，靠 `.finance-page` 的换行兜住可读性。
 */
const COLUMN_WIDTH = {
  // ① 成品出库条目（sourceColumns，12 列 = 9 业务 + 2 审计 + 操作）
  sourceNo: "9%",
  orderNo: "9%",
  customer: "10%",
  outbound: "8%",
  product: "11%",
  quantity: "6%",
  amount: "10%",
  outstanding: "8%",
  status: "5%",
  sourceActions: "8%",
  // ② 确认应收台账（ledgerColumns，10 列 = 勾选 + 6 业务 + 2 审计 + 操作）
  selection: "4%",
  ledgerSourceNo: "10%",
  ledgerOrderNo: "10%",
  ledgerCustomer: "12%",
  ledgerAmount: "13%",
  ledgerDue: "11%",
  ledgerStatus: "8%",
  ledgerActions: "16%",
  // ③ 应收对账明细（reconciliationColumns，19 列 = 16 业务 + 2 审计 + 操作）
  reconciliationNo: "6%",
  reconciliationCustomer: "6%",
  reconciliationOrder: "6%",
  reconciliationProduct: "5%",
  reconciliationSpecification: "5%",
  period: "6%",
  entries: "4%",
  receivable: "6%",
  paid: "6%",
  system: "4%",
  external: "5%",
  difference: "5%",
  bank: "6%",
  subject: "5%",
  reconciliationStatus: "4%",
  reconciliationActions: "5%",
  // ④ 待创建对账的条目（pendingSourceColumns，12 列 = 9 业务 + 2 审计 + 操作）
  pendingCustomer: "9%",
  pendingSourceNo: "9%",
  pendingMonth: "7%",
  pendingOrderNo: "9%",
  pendingOutbound: "8%",
  pendingProduct: "9%",
  pendingSpecification: "8%",
  pendingAmount: "10%",
  pendingCreated: "7%",
  pendingActions: "8%",
} as const;


/**
 * 银行下拉的「清空」哨兵值。
 *
 * 银行是可选字段，选错了必须能去掉；而 Radix Select 不接受空串 value，所以用一个显式哨兵值表示「不指定银行」，
 * 提交时再翻译成 null（后端 DTO 的 @IsOptional 会放过 null 并按「清空」处理）。
 */
const BANK_CLEAR = "__no_bank__";
/**
 * 会计科目下拉的「清空」哨兵值。
 *
 * 会计科目也是可选的，而已有单据上的科目要能去掉（后端 PATCH 收 null 表示清空）；
 * 但**未改动**时必须送 undefined，否则每次「只改金额」都会把单据上已有的科目一并抹掉。
 * Radix Select 不接受空串 value，所以空值代表「不改动」、哨兵值代表「明确清空」。
 */
const SUBJECT_CLEAR = "__no_subject__";

type Reference = { id: string; name: string; customerCode?: string; orderNo?: string };
type CustomerRef = { id: string; name: string; customerCode: string | null };
/** 银行账户池条目（财务 → 银行账户）。收款的「到账银行」只能从这里选，不在这里手输账户。 */
type BankRef = { id: string; bankCode: string; bankName: string; accountName: string; accountNumber: string; currency: string; isActive: boolean };
type BankLink = { id: string; bankName: string; accountNumber: string } | null;
/** 列表/详情接口内嵌的会计科目（财务 → 收支管理 → 会计科目）。 */
type SubjectLink = { id: string; category: string; name: string };
type SourceAllocation = { id: string; amount: string; status: string; payment?: { id: string; paymentNo: string; status: string; paymentDate: string; amount?: string; currency?: string } | null };
/** 覆盖这条应收的对账单（列表接口算好给前端：对账范围是「订单号或客户 + 币种 + 期间」，前端推不出来）。 */
type ReconciliationRef = { id: string; reconciliation_no: string; status: string; period_start: string; period_end: string };
type ReceivableSource = AuditRow & {
  id: string; sourceNo: string; orderNo: string; customerId: string; outboundId: string;
  /** 所属销售单已被软删（2026-11-03）：应收来源不删、钱照收，只标成「孤立」。判定只认后端字段。 */
  orphaned?: boolean;
  quantity: string; unit: string; unitPrice: string | null; taxRate: string | null; amount: string; currency: string;
  amountReason: string | null; status: string; dueDate: string | null; invoiceNo: string | null; invoiceDate: string | null;
  signedAtSnapshot: string | null; remark: string | null; createdAt: string;
  customer_name: string | null; customer_code: string | null; outbound_no: string | null;
  product_name: string | null; product_specification: string | null;
  allocated_amount: string; outstanding_amount: string;
  /**
   * 挂账状态（2026-11-09 R3-6 / R3-13）：`posted` 已挂账 / `draft` 草稿挂账 / `reversed` 挂账已红冲 / `none` 未挂账。
   * **可选**：旧响应没有这个字段，按 `none` 处理（见 `lib/accrual-status.ts`）；`reversed` 才是需要处理的异常。
   */
  accrual_status?: string | null;
  reconciliation?: ReconciliationRef | null;
  customer?: CustomerRef | null;
  outbound?: { outboundNo: string; status: string; productNameSnapshot: string | null; productSpecificationSnapshot: string | null; signedAt: string | null; shipmentDate: string | null } | null;
  allocations?: SourceAllocation[];
};
type ReconciliationEntry = ReceivableSource;
type Reconciliation = AuditRow & {
  id: string; reconciliationNo: string; orderNo: string | null; customerId: string;
  periodStart: string; periodEnd: string; receivableAmountSnapshot: string; paymentAmountSnapshot: string;
  adjustmentAmountSnapshot: string; systemBalance: string; externalBalance: string; difference: string;
  currency: string; status: string; resolutionRemark: string | null; remark: string | null; createdAt: string;
  bankId?: string | null; bank?: BankLink;
  /** 建单/确认时人工选定的会计科目（挂账凭证贷方收入科目；确认接口仍接受它作为覆盖值）。 */
  subjectId?: string | null;
  /** 列表/详情接口内嵌的会计科目对象（`{ id, category, name }`）。 */
  subject?: SubjectLink | null;
  customer?: CustomerRef | null;
  status_label?: string;
  /** 所属销售单已被软删（2026-11-03）：对账单不删、收付款照走，只标成「孤立」。判定只认后端字段。 */
  orphaned?: boolean;
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
 * 逐条与按对账单回金额，批量回条数与按币种合计。`bank_missing` 是**旧口径**字段（钱记了但没落到银行）：
 * 2026-09-24 起确认 = **挂账**、不动现金，后端对该字段恒返回 false，界面只保留中性兜底。
 */
type ConfirmResult = {
  bank_missing?: boolean; amount?: string; currency?: string; count?: number;
  confirmed_amount?: string; confirmed_count?: number; skipped_count?: number;
  /** 勾选批量确认的按币种合计（跨币种不相加）。 */
  amounts?: Array<{ currency: string; amount: string }>;
};
/**
 * 三个确认弹窗共用的只读说明（`ActionField.type: "info"`）。
 *
 * 确认 = **挂账**：只生成「借 应收账款 / 贷 收入」的凭证，钱没到账；收款是另一条路（「合并收款」）。
 * 不写清楚，很容易把确认当成收款。
 */
const CONFIRM_ACCRUAL_INFO = "确认后生成挂账凭证：借 应收账款、贷 收入；钱未到账，收款请用「合并收款」";

/** 收款单的资源路径（`api-client` 会自己补 `/api/v1`），建单与过账都用它拼。 */
const CUSTOMER_PAYMENTS_PATH = "/finance/customer-payments";
/** 可核销的应收状态：与后端 `customer-payment.service.ts` 的 `["confirmed","partially_paid"]` 一字不差。 */
const SETTLEABLE_STATUSES = ["confirmed", "partially_paid"] as const;
/**
 * 一条应收能不能进「合并收款」：状态已确认 / 部分收款，且**未收余额 > 0**。
 *
 * 余额用 `parseSlipAmount` 判定而不是 `Number(...) > 0`：它同时拦掉 "0.0000"、负数、空值与
 * 超过 4 位小数的脏数据（与后端 DECIMAL(18,4) 同一套口径）。余额为 0（已收清）的条目勾了也只会 422。
 */
const settleableSource = (source: Pick<ReceivableSource, "status" | "outstanding_amount">): boolean =>
  (SETTLEABLE_STATUSES as readonly string[]).includes(source.status) && parseSlipAmount(source.outstanding_amount ?? "") !== null;
/** 一条应收在「合并收款」里需要的全部字段（都来自台账列表接口，不必再逐条查详情）。 */
type MergeReceivable = {
  id: string; sourceNo: string; orderNo: string | null;
  customerId: string; customerName: string; currency: string; amount: string; outstanding: string;
};
const mergeReceivableOf = (source: ReceivableSource): MergeReceivable => ({
  id: source.id, sourceNo: source.sourceNo, orderNo: source.orderNo,
  customerId: source.customerId, customerName: source.customer_name ?? source.customer_code ?? source.customerId,
  currency: source.currency, amount: source.amount, outstanding: source.outstanding_amount,
});
/** 合并收款的锚点：这批的客户 + 币种（一张收款单只对一个客户、一个币种，后端同样会拒）。 */
type ReceiptAnchor = { customerId: string; customerName: string; currency: string };
const receiptAnchorOf = (rows: readonly MergeReceivable[]): ReceiptAnchor | null =>
  rows[0] ? { customerId: rows[0].customerId, customerName: rows[0].customerName, currency: rows[0].currency } : null;
/** 为什么某条应收不能跟着已选的那批一起收款（返回全部原因，界面按条显示）。 */
const receiptLockReasons = (anchor: ReceiptAnchor, row: Pick<MergeReceivable, "customerId" | "currency">): string[] => {
  const reasons: string[] = [];
  if (row.currency !== anchor.currency) reasons.push(`不能与已选的 ${anchor.currency} 应收合并在一次收款里（金额不跨币种合计）`);
  if (row.customerId !== anchor.customerId) reasons.push(`不能与「${anchor.customerName}」的应收合并在一次收款里（一张收款单只对一个客户）`);
  return reasons;
};
/** 核销合计（整数分求和，唯一真源；非法行按 0 计，合计只用于显示与提交前校验）。 */
const receiptAllocationTotal = (rows: readonly MergeReceivable[]): string => {
  let units = 0n;
  for (const row of rows) units += parseSlipAmount(row.outstanding) ?? 0n;
  return formatSlipAmount(units);
};
/** 幂等键：一次弹窗**一个**（与付款/工资那些批量入口同一约定），重试命中同一张草稿。 */
const newReceiptIdempotencyKey = () => `web-customer-payment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
type DetailKind = "source" | "reconciliation";

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : "-");
const monthOf = (value: string | null | undefined) => (value ? value.slice(0, 7) : "-");
const monthRange = (month: string) => ({ start: `${month}-01`, end: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10) });

export default function ReceivableWorkspace({ tab, testId }: { tab: ReceivableTabParam; testId: string }) {
  const [sources, setSources] = useState<ReceivableSource[]>([]);
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([]);
  const [customers, setCustomers] = useState<Reference[]>([]);
  const [orders, setOrders] = useState<Reference[]>([]);
  const [banks, setBanks] = useState<BankRef[]>([]);
  const [subjects, setSubjects] = useState<AccountingSubject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  /** 「按来源重算」正在提交的应收 id（按钮 loading/禁用防双击）。 */
  const [reaccruing, setReaccruing] = useState("");
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
  /**
   * 「确认应收」页的筛选：收款情况 + 出库日期区间（与应付侧同一口径，见 lib/finance-ledger-filter.ts）。
   * **默认只显示未收**＝草稿 + 已确认（挂账，钱还没收到）+ 部分收款（尾款还欠着）—— 这一页是待办
   * 清单，只有已收清的才默认不在；需要时用筛选器切到「已收」或「全部」。
   * 时间用创建日期（= 成品出库过账生成这条来源的日期）：应收来源没有确认日期列，
   * 列表页的「待对账月份 / 出库日期」用的也是它。
   */
  const [payment, setPayment] = useState<LedgerPaymentFilter>("unpaid");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [exporting, setExporting] = useState(false);
  /**
   * 收款单编辑器（财务 2026-09-20：「同理，收款单的编辑和导出」；2026-09-24 改为**队列**）。
   *
   * 与付款单同一套：打开时先按勾选的应收条目向后端预填（单号 / 客户 / 开户行 / 科目 / 借贷行），
   * 再让财务改金额、加行、写备注，最后出 xlsx。跨客户 / 跨币种时后端拆成多张（一次集中收款 =
   * 一队单子），所以这里存的是数组；`pendingIds` 是这批里还没确认的条目（钱还没进来）。
   * 收款单**不落库**（它是一张打印件）。
   */
  const [slip, setSlip] = useState<{ open: boolean; loading: boolean; error: string; drafts: FinanceSlipDraft[] | null; pendingIds: string[] }>({ open: false, loading: false, error: "", drafts: null, pendingIds: [] });
  /**
   * 「合并收款」弹窗（真的建收款单 + 过账逐条核销，与上面那张打印件队列不是一回事）。
   * 2026-11-09 D4：整单结清 —— 每条核销金额 = 该应收未收余额（只读），收款金额 = Σ核销金额。
   */
  const [mergeOpen, setMergeOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // 客户/销售单走 sales 权限：只有财务权限的账号拉不到它们，但不应因此整页报错（选项留空即可）。
      // 银行账户池同理（走 finance 权限，正常能拿到）。
      // 会计科目走财务科目表接口，**要停用的**：下拉只列启用科目（见 subjectOptions 的 filter），
      // 但历史对账单上挂着已停用科目时必须还能显示它的名字 —— 只说「启用」会让那些行显示成 "-"，
      // 而「停用后历史科目名消失」正是后端刻意避免的情况（会计科目服务与报表都为此保留了停用科目）。
      const [s, r, c, o, b, i] = await Promise.all([
        apiGet<ReceivableSource[]>("/finance/receivable-sources"),
        apiGet<Reconciliation[]>("/finance/reconciliations"),
        apiGet<Reference[]>("/customers").catch(() => ({ data: [] as Reference[], meta: {} })),
        apiGet<Reference[]>("/sales-orders").catch(() => ({ data: [] as Reference[], meta: {} })),
        apiGet<BankRef[]>("/finance/banks").catch(() => ({ data: [] as BankRef[], meta: {} })),
        apiGet<AccountingSubject[]>(`${ACCOUNTING_SUBJECTS_PATH}?include_inactive=true`).catch(() => ({ data: [] as AccountingSubject[], meta: {} })),
      ]);
      setSources(s.data); setReconciliations(r.data); setCustomers(c.data); setOrders(o.data); setBanks(b.data); setSubjects(i.data);
      // 勾选状态跟着数据走：已经不能确认、也不能收款（已收清/已取消）的条目自动退出勾选
      // （界面上再也点不到它们，留着 id 会让「批量确认 N 条 / 合并收款 N 条」里的 N 与实际能操作的条数对不上）。
      setSelected((ids) => ids.filter((id) => s.data.some((source) => source.id === id && (source.status === "draft" || settleableSource(source)))));
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
   * 2026-09-24 起三条路径都是**挂账**（借 应收账款 / 贷 收入）：钱还没到，所以这里只能报
   * 「已生成挂账凭证、钱未到账」，**不能**再报「已记入收支流水」或「已记到所选银行账户」——
   * 确认这一步根本不动银行。收款走「合并收款」（逐条全额核销）。
   * `bank_missing` 是旧口径的字段（后端现已恒为 false）；保留分支只是给历史/异常响应一个中性兜底，
   * 不再当作主路径，更不能拿它提示用户「钱进了流水但没进账户」。
   *
   * 失败时把错误**抛回** ActionDialog（它靠 onSubmit 是否 reject 决定关不关弹窗），
   * 与应付页 submitAction 同一理由：失败不能静默关闭。
   */
  async function submitConfirm(path: string, body: Record<string, unknown>, describe: (data: ConfirmResult) => { success: string; warning: string }, failure: string) {
    try {
      const result = await apiPost<ConfirmResult>(path, body);
      const text = describe(result.data);
      if (result.data.bank_missing) notifyError(text.warning, "确认完成，请核对资金归属");
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
  /**
   * 可人工指定的会计科目：只给启用项，留空则由后端按来源自动归类。
   *
   * 下拉一律用 `searchable-select`（用户 2026-09-20 第 1 条：「所有涉及会计科目的下拉列表，
   * 都要新增一个搜索框支持搜索」）：科目表一百二十多条、标签是「分类 / 名称」，普通下拉只能滚动找，
   * 而财务心里想的是科目名。与应付侧同一处理。
   */
  const subjectOptions = toSubjectOptions(subjects.filter((item) => item.isActive)).map((option) => ({ value: option.id, label: option.label }));  /**
   * 会计科目 id → 显示名。
   *
   * 列表/详情接口通常只给 `subjectId`（Prisma 不外带科目对象），标签得在前端拿科目表还原；
   * 科目表里查不到（科目被删/停用，或权限不够没拉到）就显示 `-`，不能让整页崩在这里。
   * 接口若内嵌了 `subject`，优先用它 —— 显示口径与下拉一致（`分类 / 科目名称`）。
   */
  const subjectLabel = (subject: SubjectLink | null | undefined, id?: string | null) => {
    if (subject) return subjectOptionLabel(subject);
    const found = subjects.find((item) => item.id === id);
    return found ? subjectOptionLabel(found) : "-";
  };
  /**
   * 建单弹窗的会计科目：可选，留空即交给后端按来源自动归类（应收默认「货款」）；
   * 新建单据上本来就没有科目可清，所以不摆「清空」哨兵（避免多出一个必然选不中的选项）。
   */
  const subjectCreateField = (label: string): ActionField => ({ name: "subject_id", label, type: "searchable-select", options: subjectOptions });
  /**
   * 已有单据上的会计科目：默认带出当前值；选「（不指定会计科目）」送 null。
   *
   * 默认值用 `current ?? ""`（而不是银行那种「当前值否则哨兵」）是刻意的：未改动时必须送 undefined，
   * 后端 PATCH 才完全不动这个字段；若默认成哨兵，以后端「将来给这类单据补默认值」为例，
   * 用户只改金额就会把默认值一起抹成 null。
   */
  const subjectEditField = (label: string, current?: string | null): ActionField => ({
    name: "subject_id", label, type: "searchable-select",
    options: [{ value: SUBJECT_CLEAR, label: "（不指定会计科目）" }, ...subjectOptions],
    defaultValue: current ?? "",
  });
  /** 哨兵/空值 → 提交值：明确清空送 null，未改动送 undefined（后端不更新该字段）。 */
  const subjectValue = (value: string | undefined) => (value === SUBJECT_CLEAR ? null : (value || undefined));

  /**
   * 确认应收时的「款项性质」（定金 / 货款 / 尾款 / 其他）。
   *
   * 为什么放在**确认**这一步而不是建应收的时候：确认就是记账，钱的性质要在这唯一一次录入口里
   * 问清楚 —— 建单时钱还没进来，性质随时会变。老表「外汇一览表」正是按这一列把收款拆成
   * 「定金 / 货款」两组，所以它必须落库，不能只在界面上显示一下。
   *
   * 默认「货款」：绝大多数确认都是出货后收的货款；定金要手工选（而且定金通常走
   * 【收支流水】手工录入，因为出货前系统里还没有应收来源可挂）。
   */
  const paymentNatureField = (): ActionField => ({
    name: "payment_nature", label: "款项性质（收入用）", type: "select",
    options: paymentNatureOptions(), defaultValue: "balance",
  });
  /** 空值 → 提交值：没选（理论上不会，下拉有默认值）时送 null = 不标注，不编一个性质出来。 */
  const paymentNatureValue = (value: string | undefined) => value || null;

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
   * 逐条确认应收 —— 与「勾选批量确认」「一键确认应收」（按对账单）是同一件事的三条入口，都**挂账**
   * （借 应收账款 / 贷 收入），钱未到账。
   *
   * 确认这一步**不动银行**（后端也没把 bank_id 用去记账），所以弹窗只问「会计科目」（挂账贷方收入科目）
   * 与「款项性质」。到账银行在「合并收款」收款时才选。
   */
  function confirmSource(item: ReceivableSource) {
    setDialog({ title: `确认应收：${item.sourceNo}`, fields: [
      { name: "confirm", label: `确认应收 ${item.sourceNo}：${item.amount} ${item.currency}`, type: "info" as const },
      { name: "info", label: CONFIRM_ACCRUAL_INFO, type: "info" as const },
      subjectEditField("会计科目"),
      paymentNatureField(),
    ], submit: (v) => submitConfirm(`/finance/receivable-sources/${item.id}/confirm`, { subject_id: subjectValue(v.subject_id), payment_nature: paymentNatureValue(v.payment_nature) }, (data) => ({
      success: `应收 ${item.sourceNo} 已确认（${data.amount ?? item.amount} ${data.currency ?? item.currency}），已生成挂账凭证（借 应收账款，贷 收入）；钱未到账`,
      warning: `确认已完成，但接口报告资金归属异常（bank_missing）：本次确认只生成挂账凭证、不写收支流水，请刷新核对`,
    }), "确认应收失败") });
  }
  /**
   * 勾选批量确认 —— 用户要求「应收侧也改成勾选 + 批量确认」（与应付侧完全对称）。
   *
   * 整批共用**一个会计科目**（挂账贷方收入科目；后端逐条挂账，每条应收各生成一张凭证）；
   * 合计**按币种分组**显示，跨币种不相加。这里不问银行卡 —— 确认不动钱，收款在「合并收款」里选账户。
   * 勾选里混进已被别人确认掉的条目时，后端会跳过并回报条数。
   */
  function batchConfirm(ids: string[] = selectedDrafts.map((draft) => draft.id)) {
    const drafts = sources.filter((source) => source.status === "draft" && ids.includes(source.id));
    const totals = new Map<string, number>();
    for (const draft of drafts) totals.set(draft.currency, (totals.get(draft.currency) ?? 0) + Number(draft.amount));
    setDialog({ title: `批量确认应收（${drafts.length} 条）`, fields: [
      { name: "confirm", label: `确认 ${drafts.length} 条草稿应收（合计 ${[...totals.entries()].map(([currency, amount]) => `${amount.toFixed(4)} ${currency}`).join("、")}）`, type: "info" as const },
      { name: "info", label: CONFIRM_ACCRUAL_INFO, type: "info" as const },
      subjectEditField("会计科目"),
      paymentNatureField(),
    ], submit: (v) => submitConfirm("/finance/receivable-sources/batch-confirm", { ids: drafts.map((draft) => draft.id), subject_id: subjectValue(v.subject_id), payment_nature: paymentNatureValue(v.payment_nature) }, (data) => {
      const amount = data.amounts?.length ? data.amounts.map((item) => `${item.amount} ${item.currency}`).join("、") : "-";
      const skipped = data.skipped_count ? `；跳过 ${data.skipped_count} 条` : "";
      return {
        success: `已确认 ${data.confirmed_count ?? drafts.length} 条应收（${amount}）${skipped}，已生成挂账凭证（借 应收账款，贷 收入）；钱未到账`,
        warning: `确认已完成，但接口报告资金归属异常（bank_missing）：本次确认只生成挂账凭证、不写收支流水，请刷新核对`,
      };
    }, "批量确认应收失败") });
  }

  /**
   * 导出当前筛选出的应收台账（用户要求「确认应收要支持导出 excel」）。
   *
   * 查询串与界面筛选一一对应（`ledgerExportQuery`），所以**导出的就是所见**；
   * 文件名带行数由后端按既有约定给出。
   */
  async function exportLedger() {
    setExporting(true);
    try {
      const query = ledgerExportQuery({ payment, from: dateFrom || undefined, to: dateTo || undefined, q: sourceFilter });
      await downloadFile(`/api/v1/finance/receivable-sources.xlsx?${query}`, "迪礼ERP-应收台账.xlsx");
      notifySuccess(`已导出 ${ledgerSources.length} 条应收`);
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }

  /**
   * 打开收款单队列：先按勾选的应收条目向后端要一份预填（可能是一队多张）。
   *
   * 一行一条应收（贷「主营业务收入」等确认时实际用的科目）+ 借方一行银行存款等于合计；
   * 财务要拆收入与税就自己加行、要少收就自己改金额（与手续费/折扣等零星扣减对应）。
   * 后端按「客户 + 币种」拆张（与应付侧同一口径，用户 2026-09-24 要求「收款也一并检查是否支持
   * 收束收款」）；预填失败时**照样打开弹窗**把原因写出来：静默什么都不发生，用户只会以为按钮坏了。
   */
  async function openReceiptSlip(ids: string[]) {
    setSlip({ open: true, loading: true, error: "", drafts: null, pendingIds: [] });
    try {
      const result = await apiPost<{ slips: FinanceSlipDraft[] }>(financeSlipDraftPath("receipt"), financeSlipDraftBody("receipt", ids));
      setSlip({ open: true, loading: false, error: "", drafts: result.data.slips, pendingIds: ids.filter((id) => sources.some((source) => source.id === id && source.status === "draft")) });
    } catch (cause) {
      setSlip({ open: true, loading: false, error: messageOf(cause, "收款单预填失败"), drafts: null, pendingIds: [] });
    }
  }

  function createReconciliation(preset?: { customerId: string; month: string }) {    const range = preset ? monthRange(preset.month) : undefined;
    setDialog({ title: "创建应收对账", fields: [
      { name: "customer_id", label: "客户", type: "select", required: true, canAddCategory: true, options: customerOptions, defaultValue: preset?.customerId },
      { name: "order_no", label: "订单号（可选）", type: "select", options: orderOptions },
      { name: "period_start", label: "期间开始", type: "date", required: true, defaultValue: range?.start },
      { name: "period_end", label: "期间结束", type: "date", required: true, defaultValue: range?.end },
      { name: "external_balance", label: "外部余额", type: "number", required: true },
      { name: "currency", label: "币种", type: "select", required: true, options: currencyOptions(currencyCatalogue), defaultValue: currencyDefault("CNY") },
      bankField("回款银行"),
      subjectCreateField("会计科目"),
      { name: "remark", label: "备注", type: "textarea" },
    ], submit: (v) => void action("/finance/reconciliations", { customer_id: v.customer_id, order_no: v.order_no || undefined, period_start: v.period_start, period_end: v.period_end, external_balance: v.external_balance, currency: v.currency, bank_id: bankValue(v.bank_id), subject_id: v.subject_id || undefined, remark: v.remark || undefined }, "对账单已创建") });
  }
  function resolveReconciliation(item: Reconciliation) {
    setDialog({ title: `处理对账差异：${item.reconciliationNo}`, fields: [{ name: "remark", label: "处理说明", type: "textarea", required: true, defaultValue: "已核对" }], submit: (v) => void action(`/finance/reconciliations/${item.id}/resolve`, { resolution_remark: v.remark }, "对账差异已处理") });
  }
  /**
   * 确认应收（按对账单）—— 一键确认范围内的草稿应收，同样是**挂账**（借 应收账款 / 贷 收入），钱未到账。
   *
   * 所以弹窗只问「会计科目」与「款项性质」；到账银行在「合并收款」里选。
   * 历史对账单常常没填科目，必须让它能补上。
   */
  function confirmReconciliation(item: Reconciliation) {
    const count = item.details?.draft_count ?? item.flow?.draft_count ?? 0;
    const amount = item.details?.draft_amount ?? item.flow?.draft_amount;
    setDialog({ title: `确认应收：${item.reconciliationNo}`, fields: [
      { name: "confirm", label: `确认 ${count} 条草稿应收${amount ? `（合计 ${amount} ${item.currency}）` : ""}`, type: "info" as const },
      { name: "info", label: CONFIRM_ACCRUAL_INFO, type: "info" as const },
      subjectEditField("会计科目", item.subjectId),
      paymentNatureField(),
    ], submit: (v) => submitConfirmReconciliation(item, v) });
  }
  /** 确认应收的提交：与逐条 / 批量确认共用 submitConfirm（三条路径都是挂账；bank_missing 只做中性兜底）。 */
  async function submitConfirmReconciliation(item: Reconciliation, v: Record<string, string>) {
    return submitConfirm(`/finance/reconciliations/${item.id}/confirm-receivables`, { subject_id: subjectValue(v.subject_id), payment_nature: paymentNatureValue(v.payment_nature) }, (data) => {
      const count = data.confirmed_count ?? data.count ?? 0;
      const amount = data.confirmed_amount ?? data.amount ?? "-";
      const currency = data.currency ?? item.currency;
      return {
        success: `${item.reconciliationNo} 已确认 ${count} 条应收（${amount} ${currency}），已生成挂账凭证（借 应收账款，贷 收入）；钱未到账`,
        warning: `确认已完成，但接口报告资金归属异常（bank_missing）：本次确认只生成挂账凭证、不写收支流水，请刷新核对`,
      };
    }, "批量确认应收失败");
  }

  /**
   * 按来源重算挂账（2026-11-09 R3-6 / R3-13）：挂账凭证被**红冲**后，用这条应收现在的数据
   * 重建一张 `posted` 挂账凭证（借 应收账款、贷 收入；钱未到账）。
   *
   * 只有 `accrual_status === "reversed"` 的行给入口；原因可选、只进审计。
   * 后端 422（`ACCRUAL_ALREADY_POSTED` / `RECEIVABLE_NOT_RECALCULABLE`）原样展示：
   * 前端不重写「能不能重算」的判断，失败 throw 回弹窗并 toast。
   * 成功提示带新凭证号；`replayed=true` 表示复用已有有效凭证、这次没有新生成。
   */
  function reaccrueReceivable(source: ReceivableSource) {
    setDialog({
      title: `按来源重算挂账：${source.sourceNo}`,
      fields: [
        { name: "info", label: "挂账凭证已红冲：将按这条应收现在的金额 / 科目重建一张已过账的挂账凭证（借 应收账款、贷 收入）；钱未到账。", type: "info" as const },
        { name: "reason", label: "重算原因（可选，记入审计）", type: "textarea" },
      ],
      submit: async (values) => {
        setReaccruing(source.id);
        try {
          const reason = values.reason?.trim();
          const result = await apiPost<AccrualReaccrueResult>(`/finance/receivables/${source.id}/reaccrue`, reason ? { reason } : {});
          const data = result.data;
          notifySuccess(data.replayed
            ? `已有有效挂账凭证 ${data.voucherNo}，未重复生成`
            : `已按来源重算挂账：${data.voucherNo}`);
          setDialog(null);
          setDetail(null);
          await load();
        } catch (cause) {
          // 422 的 code/message 原样显示（不翻译成前端自己的判断），并留在弹窗里。
          const message = messageOf(cause, "按来源重算失败");
          notifyError(message);
          throw new Error(message);
        } finally {
          setReaccruing("");
        }
      },
    });
  }

  // ---------------------------------------------------------------- 待创建对账

  // ---------------------------------------------------------------- 列表

  // 待确认收款提醒：成品出库过账会自动生成应收来源草稿（通知财务收款），这里把待确认的笔数与金额显示出来。
  const pendingSources = useMemo(() => sources.filter((item) => item.status === "draft"), [sources]);
  const pendingAmount = pendingSources.reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
  // 应收台账 = 全部应收来源（含草稿），再按「确认应收」页的筛选收窄：
  // 关键字 → 出库日期区间 → 收款情况（默认只留未收＝草稿 + 已确认 + 部分收款）。
  // 成品出库条目那张表也用这一份（原来是另一套只差一个字段的匹配规则，两处迟早会漂移）。
  const matchedSources = useMemo(() => {
    const text = sourceFilter.trim().toLowerCase();
    if (!text) return sources;
    return sources.filter((item) => [item.sourceNo, item.orderNo, item.customer_name, item.outbound_no, item.product_name, item.product_specification].some((value) => (value ?? "").toLowerCase().includes(text)));
  }, [sourceFilter, sources]);
  // 「待创建对账」「应收对账单」两张表也吃同一个关键字（见 pendingReconcile 的注释）。
  const pendingReconcile = useMemo(() => matchedSources.filter((source) => source.status === "draft" && !source.reconciliation), [matchedSources]);
  const pendingReconcileTotal = pendingReconcile.reduce((sum, source) => sum + Number(source.amount), 0);
  const coveredDrafts = useMemo(() => sources.filter((source) => source.status === "draft" && source.reconciliation), [sources]);
  /**
   * 应收对账单的搜索：字段与列表列一一对应（对账单号 / 客户 / 订单号 / 产品 / 规格型号）。
   *
   * 与应付侧同一个理由：这个页签原来**根本没有搜索框**，而对账单是财务翻得最多的表 ——
   * 「单少还可以查，多了就不好找」说的正是它。
   */
  const filteredReconciliations = useMemo(() => {
    const text = sourceFilter.trim().toLowerCase();
    if (!text) return reconciliations;
    return reconciliations.filter((item) => [
      item.reconciliationNo, item.customer?.name, item.orderNo,
      item.flow?.order_nos.join("、"), item.flow?.product_names?.join("、"), item.flow?.product_specifications?.join("、"),
    ].some((value) => (value ?? "").toLowerCase().includes(text)));
  }, [reconciliations, sourceFilter]);
  // 计数用「日期与关键字已筛、收款情况还没筛」的那一批：筛选器上的「未收（3）/ 已收（5）」才是当前条件下的真实条数。
  const scopedSources = useMemo(
    () => matchedSources.filter((item) => withinDateRange(item.createdAt, dateFrom, dateTo)),
    [matchedSources, dateFrom, dateTo],
  );
  const paymentTally = useMemo(() => paymentCounts(scopedSources), [scopedSources]);
  const ledgerSources = useMemo(
    () => payment === "all" ? scopedSources : scopedSources.filter((item) => paymentBucket(item.status) === payment),
    [scopedSources, payment],
  );
  // 应收来源行的操作：成品出库条目与确认应收两张表共用同一套动作，避免两边行为漂移。
  // 行内不放「登记收款」：收款是**整单结清**的批量动作（勾选 → 「合并收款」，同一客户 + 同一币种），
  // 且它能跨多条应收合并到一张收款单里；逐条按钮会诱导出一条应收一张单。
  // `withSlip`：只有「确认应收」那张台账给「收款单」入口（与应付侧对称 —— 出库条目那张表是
  // 来源视图，在这里出单容易对着还没确认的条目开票）。
  // `withReaccrue`：同理只给台账 —— 挂账已红冲的行才出现「按来源重算」（R3-13）。
  const sourceActions = (item: ReceivableSource, withSlip = false, withReaccrue = false) => <div className="action-row">
    {withReaccrue && isAccrualReversed(item.accrual_status) && <Button size="sm" variant="secondary" data-testid={`receivable-reaccrue-${item.id}`} disabled={reaccruing === item.id} onClick={() => reaccrueReceivable(item)}>{reaccruing === item.id ? "重算中…" : "按来源重算"}</Button>}
    {item.status === "draft" && <><Button size="sm" variant="secondary" onClick={() => confirmSource(item)}>确认应收</Button><Button size="sm" variant="ghost" onClick={() => editSource(item)}>编辑</Button><Button size="sm" variant="ghost" onClick={() => cancelSource(item)}>取消</Button></>}
    {item.status === "confirmed" && <Button size="sm" variant="ghost" onClick={() => reopenSource(item)}>回退草稿</Button>}
    {/* 收款单：草稿（钱还没到）与已确认（挂账、钱未到账）都能出单 —— 它是一张打印件，不改任何数据；
        真正到账走「合并收款」（真的建收款单 + 过账核销）。 */}
    {withSlip && <Button size="sm" variant="ghost" data-testid={`receivable-slip-${item.id}`} onClick={() => void openReceiptSlip([item.id])}>收款单</Button>}
  </div>;

  // 勾选对**两条流程**开放（与应付侧对称，2026-11-09）：
  //   - 草稿行 → 「批量确认」（挂账）；
  //   - 已确认 / 部分收款、且未收余额 > 0 的行 → 「合并收款」（真的建收款单 + 过账核销）。
  // 已收清（余额 0）与已取消的行没有可做的事，勾选框都不给。
  const selectableIds = useMemo(() => ledgerSources.filter((item) => item.status === "draft" || settleableSource(item)).map((item) => item.id), [ledgerSources]);
  const selectedDrafts = useMemo(() => ledgerSources.filter((item) => item.status === "draft" && selected.includes(item.id)), [ledgerSources, selected]);
  const selectedSettleable = useMemo(() => ledgerSources.filter((item) => settleableSource(item) && selected.includes(item.id)), [ledgerSources, selected]);
  const mergeRows = useMemo(() => selectedSettleable.map(mergeReceivableOf), [selectedSettleable]);
  /**
   * 「合并收款」这一批的锚点（第一条被选中的可收款应收）：它决定整批的客户与币种 ——
   * 一张收款单只能对一个客户、一个币种（后端 `customer-payment.service.ts` 会以
   * ALLOCATION_REFERENCE_MISMATCH 拒绝混在一起的），所以其余不同客户/币种的行在界面上直接
   * 锁掉并写明原因，而不是让她勾完再吃一个 422。
   */
  const receiptAnchor = useMemo(() => receiptAnchorOf(mergeRows), [mergeRows]);
  const receiptLock = (source: ReceivableSource) => receiptAnchor ? receiptLockReasons(receiptAnchor, { customerId: source.customerId, currency: source.currency }) : [];
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.includes(id));
  const toggleOne = (id: string) => setSelected((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
  const toggleAll = () => setSelected((ids) => allSelected ? ids.filter((id) => !selectableIds.includes(id)) : [...new Set([...ids, ...selectableIds])]);
  const selectionColumn: ColumnDef<ReceivableSource> = {
    id: "select",
    // 勾选框列：固定布局下不给宽度会跟别的列一样宽（列多时反而挤掉金额），4% 足够放一个复选框。
    meta: { width: COLUMN_WIDTH.selection },
    // 表头全选覆盖「可确认的草稿 + 可收款的已确认应收」两类（见 selectableIds 的注释）。
    header: () => <input type="checkbox" aria-label="全选可确认/可收款应收" data-testid="receivable-select-all" checked={allSelected} disabled={!selectableIds.length} onChange={toggleAll} />,
    cell: ({ row }) => {
      const settleable = settleableSource(row.original);
      if (row.original.status !== "draft" && !settleable) return null;
      // 锁只对可收款的行生效；锁住的原因就写在勾选框旁边（禁用的控件点不动，原因不能只在 title 里）。
      const locks = settleable ? receiptLock(row.original) : [];
      return <>
        <input type="checkbox" aria-label={`选择 ${row.original.sourceNo}`} data-testid={`receivable-select-${row.original.id}`} title={locks.join("；") || undefined} disabled={locks.length > 0} checked={selected.includes(row.original.id)} onChange={() => toggleOne(row.original.id)} />
        {locks.length ? <span className="panel-note status-error" data-testid={`receivable-select-lock-${row.original.id}`}>{locks.join("；")}</span> : null}
      </>;
    },
  };

  const sourceColumns: ColumnDef<ReceivableSource>[] = [
    { accessorKey: "sourceNo", header: "应收来源", meta: { width: COLUMN_WIDTH.sourceNo } },
    { id: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.orderNo }, cell: ({ row }) => <OrderNoWithOrphan orderNo={row.original.orderNo} orphaned={row.original.orphaned} /> },
    { id: "customer", header: "客户", meta: { width: COLUMN_WIDTH.customer }, cell: ({ row }) => row.original.customer_name ?? row.original.customer_code ?? "-" },
    { id: "outbound", header: "出库单", meta: { width: COLUMN_WIDTH.outbound }, cell: ({ row }) => row.original.outbound_no ?? "-" },
    { id: "product", header: "产品", meta: { width: COLUMN_WIDTH.product }, cell: ({ row }) => { const item = row.original; const spec = item.product_specification ? `（${item.product_specification}）` : ""; return item.product_name ? `${item.product_name}${spec}` : "-"; } },
    { id: "quantity", header: "数量", meta: { width: COLUMN_WIDTH.quantity }, cell: ({ row }) => `${row.original.quantity}${row.original.unit ? ` ${row.original.unit}` : ""}` },
    { id: "amount", header: "应收金额", meta: { width: COLUMN_WIDTH.amount }, cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "outstanding", header: "未收", meta: { width: COLUMN_WIDTH.outstanding }, cell: ({ row }) => money(row.original.outstanding_amount, row.original.currency) },
    { id: "status", header: "状态", meta: { width: COLUMN_WIDTH.status }, cell: ({ row }) => financeStatus(row.original.status, "receivable") },
    ...auditColumns<ReceivableSource>(),
    { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.sourceActions }, cell: ({ row }) => sourceActions(row.original) },
  ];
  // 「确认应收」用台账视角的列：带勾选框、到期日与状态。
  // 「已收 / 未收」两列不在台账上展开（列已经很满）；未收余额是「合并收款」核销金额的唯一依据，
  // 在那张弹窗里逐条只读显示，核销明细仍在双击后的详情里。
  const ledgerColumns: ColumnDef<ReceivableSource>[] = [
    selectionColumn,
    { accessorKey: "sourceNo", header: "应收来源", meta: { width: COLUMN_WIDTH.ledgerSourceNo } },
    { id: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.ledgerOrderNo }, cell: ({ row }) => <OrderNoWithOrphan orderNo={row.original.orderNo} orphaned={row.original.orphaned} /> },
    { id: "customer", header: "客户", meta: { width: COLUMN_WIDTH.ledgerCustomer }, cell: ({ row }) => row.original.customer_name ?? row.original.customer_code ?? "-" },
    { id: "amount", header: "应收金额", meta: { width: COLUMN_WIDTH.ledgerAmount }, cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "due", header: "到期日", meta: { width: COLUMN_WIDTH.ledgerDue }, cell: ({ row }) => day(row.original.dueDate) },
    { id: "status", header: "状态", meta: { width: COLUMN_WIDTH.ledgerStatus }, cell: ({ row }) => <span>
      {financeStatus(row.original.status, "receivable")}
      {/* 挂账状态（R3-13）：始终有确定值（旧响应/无挂账概念的历史行按「未挂账」）；reversed 用警示色 ——
          挂账凭证被红冲后总账上就没有这笔往来的对应分录了，是需要财务处理的状态。 */}
      <span className={isAccrualReversed(row.original.accrual_status) ? "status-error" : "panel-note"} style={{ display: "block" }} data-testid={`receivable-accrual-${row.original.id}`}>{accrualStatusLabel(row.original.accrual_status)}</span>
    </span> },
    ...auditColumns<ReceivableSource>(),
    { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.ledgerActions }, cell: ({ row }) => sourceActions(row.original, true, true) },
  ];
  const reconciliationColumns: ColumnDef<Reconciliation>[] = [
    { accessorKey: "reconciliationNo", header: "对账单号", meta: { width: COLUMN_WIDTH.reconciliationNo } },
    { id: "customer", header: "客户", meta: { width: COLUMN_WIDTH.reconciliationCustomer }, cell: ({ row }) => row.original.customer?.name ?? "-" },
    { id: "order", header: "订单号", meta: { width: COLUMN_WIDTH.reconciliationOrder }, cell: ({ row }) => <OrderNoWithOrphan orderNo={row.original.orderNo ?? (row.original.flow?.order_nos.length ? row.original.flow.order_nos.join("、") : "全部订单")} orphaned={row.original.orphaned} /> },
    // 用户要求（应付侧同款）：对账要能看出「这批货是什么、什么规格」。
    { id: "product", header: "产品", meta: { width: COLUMN_WIDTH.reconciliationProduct }, cell: ({ row }) => row.original.flow?.product_names?.join("、") || "-" },
    { id: "specification", header: "规格型号", meta: { width: COLUMN_WIDTH.reconciliationSpecification }, cell: ({ row }) => row.original.flow?.product_specifications?.join("、") || "-" },
    { id: "period", header: "期间", meta: { width: COLUMN_WIDTH.period }, cell: ({ row }) => `${day(row.original.periodStart)} 至 ${day(row.original.periodEnd)}` },
    { id: "entries", header: "待确认应收", meta: { width: COLUMN_WIDTH.entries }, cell: ({ row }) => row.original.flow && row.original.flow.draft_count > 0 ? `${row.original.flow.draft_count} 条 / ${row.original.flow.draft_amount}` : "-" },
    { id: "receivable", header: "应收快照", meta: { width: COLUMN_WIDTH.receivable }, cell: ({ row }) => money(row.original.receivableAmountSnapshot, row.original.currency) },
    { id: "paid", header: "已收快照", meta: { width: COLUMN_WIDTH.paid }, cell: ({ row }) => money(row.original.paymentAmountSnapshot, row.original.currency) },
    { id: "system", header: "系统余额", meta: { width: COLUMN_WIDTH.system }, cell: ({ row }) => money(row.original.systemBalance, row.original.currency) },
    { id: "external", header: "外部余额", meta: { width: COLUMN_WIDTH.external }, cell: ({ row }) => money(row.original.externalBalance, row.original.currency) },
    { id: "difference", header: "差异", meta: { width: COLUMN_WIDTH.difference }, cell: ({ row }) => money(row.original.difference, row.original.currency) },
    { id: "bank", header: "回款银行", meta: { width: COLUMN_WIDTH.bank }, cell: ({ row }) => row.original.bank ? `${row.original.bank.bankName}（${row.original.bank.accountNumber}）` : "-" },
    // 建单时人工选的会计科目（挂账凭证贷方收入科目）；接口没内嵌 `subject` 时只拿到 id，标签在前端用科目表还原。
    { id: "subject", header: "会计科目", meta: { width: COLUMN_WIDTH.subject }, cell: ({ row }) => subjectLabel(row.original.subject, row.original.subjectId) },
    { id: "status", header: "状态", meta: { width: COLUMN_WIDTH.reconciliationStatus }, cell: ({ row }) => financeStatus(row.original.status, "reconciliation") },
    ...auditColumns<Reconciliation>(),
    { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.reconciliationActions }, cell: ({ row }) => <div className="action-row" data-testid={`reconciliation-actions-${row.original.id}`}>
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
    { id: "customer", header: "客户", meta: { width: COLUMN_WIDTH.pendingCustomer }, cell: ({ row }) => row.original.customer_name ?? row.original.customer_code ?? row.original.customerId },
    { accessorKey: "sourceNo", header: "应收来源", meta: { width: COLUMN_WIDTH.pendingSourceNo } },
    { id: "month", header: "待对账月份", meta: { width: COLUMN_WIDTH.pendingMonth }, cell: ({ row }) => monthOf(row.original.createdAt) },
    { id: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.pendingOrderNo }, cell: ({ row }) => <OrderNoWithOrphan orderNo={row.original.orderNo} orphaned={row.original.orphaned} /> },
    { id: "outbound", header: "出库单", meta: { width: COLUMN_WIDTH.pendingOutbound }, cell: ({ row }) => row.original.outbound_no ?? "-" },
    { id: "product", header: "产品", meta: { width: COLUMN_WIDTH.pendingProduct }, cell: ({ row }) => row.original.product_name ?? "-" },
    { id: "specification", header: "规格型号", meta: { width: COLUMN_WIDTH.pendingSpecification }, cell: ({ row }) => row.original.product_specification ?? "-" },
    { id: "amount", header: "应收金额", meta: { width: COLUMN_WIDTH.pendingAmount }, cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "created", header: "出库日期", meta: { width: COLUMN_WIDTH.pendingCreated }, cell: ({ row }) => day(row.original.createdAt) },
    // 「待创建对账」是**逐条**列（不是按客户+月份的汇总行），所以按业务列表给两列。
    ...auditColumns<ReceivableSource>(),
    { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.pendingActions }, cell: ({ row }) => <Button size="sm" variant="secondary" title="按这条的客户 + 月份创建：一张对账单覆盖该客户该月全部待确认应收" onClick={() => createReconciliation({ customerId: row.original.customerId, month: monthOf(row.original.createdAt) })}>创建对账</Button> },
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
        { label: "备注", value: item.remark, wide: true },
        ...auditDetailFields(item),
      ];
    }
    if (detail?.kind === "reconciliation" && detailData) {
      const item = detailData as Reconciliation;
      return [
        { label: "对账单号", value: item.reconciliationNo }, { label: "状态", value: financeStatus(item.status, "reconciliation") },
        { label: "客户", value: item.customer?.name ?? item.customerId },
        // 销售单被删后，对账单仍是有效凭证（收款/核销/差异处理照走）；订单号旁标「孤立」并说明一句。
        { label: "订单号", value: <OrderNoWithOrphan orderNo={item.orderNo ?? "全部订单"} orphaned={item.orphaned} /> },
        ...(item.orphaned ? [{ label: "孤立说明", value: "所属销售单已被删除：对账单原样保留为孤立单据，收款、核销与差异处理都不受影响。", wide: true }] : []),
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
        { label: "会计科目", value: subjectLabel(item.subject, item.subjectId) },
        { label: "纳入条目数", value: item.details ? `${item.details.entry_count} 条（待确认 ${item.details.draft_count} 条 / ${item.details.draft_amount}）` : "-" },
        { label: "差异处理说明", value: item.resolutionRemark, wide: true },
        { label: "备注", value: item.remark, wide: true },
        ...auditDetailFields(item),
      ];
    }
    return [];
  }

  function detailSections() {
    if (detail?.kind === "source" && detailData) {
      const item = detailData as ReceivableSource;
      const allocations = item.allocations ?? [];
      return [{ title: `收款核销记录（${allocations.length} 条）`, content: allocations.length
        ? <DataTable pageSize={10} columns={[{ accessorKey: "id", header: "核销 ID", meta: { width: "16%" } }, { id: "payment", header: "收款单号", meta: { width: "22%" }, cell: ({ row }) => row.original.payment?.paymentNo ?? "-" }, { id: "date", header: "收款日期", meta: { width: "18%" }, cell: ({ row }) => day(row.original.payment?.paymentDate) }, { id: "status", header: "收款状态", meta: { width: "18%" }, cell: ({ row }) => financeStatus(row.original.payment?.status, "receivable") }, { id: "amount", header: "核销金额", meta: { width: "26%" }, cell: ({ row }) => money(row.original.amount, row.original.payment?.currency ?? item.currency) }] as ColumnDef<SourceAllocation>[]} data={allocations} /> : <p className="panel-note">暂无收款核销</p> }];
    }
    if (detail?.kind === "reconciliation" && detailData) {
      const item = detailData as Reconciliation;
      const entries = item.details?.entries ?? [];
      return [{ title: `纳入对账的应收条目（${entries.length} 条）`, content: entries.length
        ? <DataTable pageSize={10} columns={[{ accessorKey: "sourceNo", header: "应收来源", meta: { width: "15%" } }, { accessorKey: "orderNo", header: "订单号", meta: { width: "14%" } }, { id: "customer", header: "客户", meta: { width: "14%" }, cell: ({ row }) => row.original.customer_name ?? "-" }, { id: "product", header: "产品", meta: { width: "15%" }, cell: ({ row }) => row.original.product_name ?? "-" }, { id: "specification", header: "规格型号", meta: { width: "14%" }, cell: ({ row }) => row.original.product_specification ?? "-" }, { id: "amount", header: "金额", meta: { width: "10%" }, cell: ({ row }) => money(row.original.amount, row.original.currency) }, { id: "outstanding", header: "未收", meta: { width: "9%" }, cell: ({ row }) => money(row.original.outstanding_amount, row.original.currency) }, { id: "status", header: "状态", meta: { width: "9%" }, cell: ({ row }) => financeStatus(row.original.status, "receivable") }] as ColumnDef<ReconciliationEntry>[]} data={entries} /> : <p className="panel-note">该期间没有纳入对账的应收条目</p> }];
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
        {/* 与列表同一口径：范围内确实还有草稿才给一键确认；点开的是「确认应收」弹窗（只问会计科目与款项性质，
            确认只挂账、不写现金） */}
        {item.details?.can_confirm_receivables ? <Button onClick={() => confirmReconciliation(item)}>一键确认应收（{item.details.draft_count} 条）</Button> : null}
      </>;
    }
    return null;
  }

  const detailTitle = detail?.kind === "source" ? `应收来源 ${(detailData as ReceivableSource | null)?.sourceNo ?? ""}` : `应收对账 ${(detailData as Reconciliation | null)?.reconciliationNo ?? ""}`;
  /**
   * 当前页签。走 `resolveFinanceTab` 而不是自己 `find`：合并之后**旧的 `confirmed` 必须仍然落在
   * 合并视图上**（收藏过的链接、遗留重定向都写着它），而组件里的 `tab` 既可能来自服务端解析过的
   * searchParams、也可能是调用方直接传进来的，两条路必须得出同一个页签。
   */
  const activeTab = RECEIVABLE_TABS.find((item) => item.key === resolveFinanceTab(RECEIVABLE_TABS, RECEIVABLE_TAB_ALIASES, tab)) ?? RECEIVABLE_TABS[0];

  if (loading) return <><PageHeader title="应收管理" /><LoadingState /></>;

  return <div className="page-root finance-page" data-testid={testId}>
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
    {/* 收款单编辑器：预填 → 现改（金额 / 增删行 / 收款备注）→ 导出 xlsx。不改系统里的任何数据。
        一次勾选多个客户时后端会拆成多张，编辑器就是**队列**（与应付侧完全对称）。 */}
    <FinanceSlipEditor
      kind="receipt"
      open={slip.open}
      onOpenChange={(open) => setSlip((current) => open ? current : { ...current, open: false, drafts: null, error: "", pendingIds: [] })}
      drafts={slip.drafts}
      loading={slip.loading}
      error={slip.error}
      /* 「收束收款」的另一半：队列里还有没确认的条目 → 关掉队列、按同一批 id 打开确认弹窗。 */
      pendingCount={slip.pendingIds.length}
      onConfirmPending={() => { const ids = slip.pendingIds; setSlip((current) => ({ ...current, open: false })); batchConfirm(ids); }}
    />
    {/* 合并收款：真的建收款单并过账核销（与上面那张**打印件**队列不是一回事）。
        核销金额=各条未收余额（只读），收款金额=Σ核销金额；页面只负责刷新台账。 */}
    <ReceivableMergeReceiptDialog
      open={mergeOpen}
      rows={mergeRows}
      banks={bankOptions}
      subjects={subjectOptions}
      onOpenChange={setMergeOpen}
      onSettled={async () => { await load(); }}
    />
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
    {!error && <section className="panel panel-body">
      {/* 搜索框提到页签**外面**（原来只画在「成品出库条目」那一段里）：它一直是「确认应收」页的实际筛选器
          （`matchedSources` 就吃它），但那一页上根本没有输入框 —— 用户切过去只能看到一个来路不明的关键字
          在悄悄生效。放到外面以后四个页签都有，并且每张表都接上了它（用户 2026-09-20 第 7 条）。 */}
      <div className="filter-bar"><label>搜索<Input data-testid="receivable-search" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} placeholder="来源编号 / 订单号 / 客户 / 出库单 / 产品 / 规格" /></label></div>
    </section>}
    {!error && activeTab.key === "outbound-entries" && <>
      <section className="panel panel-body">
        <p className="panel-note">待确认应收 {pendingSources.length} 笔 / 合计 {pendingAmount.toFixed(2)}</p>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>成品出库条目</h2><span className="panel-note">共 {matchedSources.length} 条</span></div>
        <div className="panel-body"><DataTable columns={sourceColumns} data={matchedSources} empty={<EmptyState title="暂无成品出库形成的应收来源" />} onRowDoubleClick={(row) => setDetail({ kind: "source", id: row.id })} rowTitle="双击查看详情" /></div>
      </section>
    </>}
    {/* 2026-09-20（用户要求）：「应收对账」与「确认应收」合并到**一个视图**里，两个动作仍然分开：
        上面两张面板里先建对账单（待创建对账 → 行内「创建对账」），下面那张台账里再勾选确认/收款。 */}
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
        <div className="panel-heading"><h2>应收对账单</h2><span className="panel-note">共 {filteredReconciliations.length} 张</span></div>
        <div className="panel-body">
          {/* 包一层带 testid 的容器（与「待创建对账」对称）：合并之后这一页同时有三张表，
              测试与脚本要能按表定位行数/文案，而不是在全页范围内碰运气。 */}
          <div data-testid="receivable-reconciliations">
            <DataTable columns={reconciliationColumns} data={filteredReconciliations} empty={<EmptyState title={sourceFilter.trim() ? "没有符合搜索条件的应收对账单" : "暂无应收对账单"} />} onRowDoubleClick={(row) => setDetail({ kind: "reconciliation", id: row.id })} rowTitle="双击查看详情" />
          </div>
        </div>
      </section>
    </>}
    {!error && activeTab.key === "reconciliations" && <section className="panel">
      <div className="panel-heading"><h2>确认应收</h2><span className="panel-note">共 {ledgerSources.length} 条（未收 {paymentTally.unpaid} / 已收 {paymentTally.paid}）</span></div>
      <div className="panel-body">
        {/* 收款情况默认「未收」＝草稿 + 已确认（挂账，钱还没收到）+ 部分收款；只有已收清才切到「已收 / 全部」。 */}
        <div className="filter-bar">
          <label>收款情况
            <Select value={payment} onValueChange={(value) => setPayment(value as LedgerPaymentFilter)}>
              <SelectTrigger data-testid="receivable-payment-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="unpaid">未收（{paymentTally.unpaid}）</SelectItem>
                <SelectItem value="paid">已收（{paymentTally.paid}）</SelectItem>
                <SelectItem value="all">全部（{paymentTally.all}）</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label>出库日期从<Input type="date" data-testid="receivable-date-from" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label>
          <label>到<Input type="date" data-testid="receivable-date-to" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label>
          <Button variant="secondary" data-testid="receivable-export" disabled={exporting} onClick={() => void exportLedger()}>{exporting ? "导出中…" : "导出 Excel"}</Button>
        </div>
        <div style={{ marginBottom: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem" }} data-testid="receivable-batch-bar">
          <span className="panel-note" data-testid="receivable-selected-count">已选 {selected.length} 条（可确认 {selectedDrafts.length} / 可收款 {mergeRows.length}）</span>
          {/* 导出收款单（用户 2026-09-20）：勾选几条 → 一队收款单（按客户 + 币种拆张，一行一条应收）。
              走预填接口，不改任何数据；金额、分录行、收款备注都在弹窗里现改。与应付侧的付款单完全对称。 */}
          <Button size="sm" variant="secondary" data-testid="receivable-slip-batch" disabled={!selectedDrafts.length} onClick={() => void openReceiptSlip(selectedDrafts.map((draft) => draft.id))}>集中收款单（{selectedDrafts.length} 条）</Button>
          <Button size="sm" data-testid="receivable-batch-confirm" disabled={!selectedDrafts.length} onClick={() => batchConfirm()}>批量确认（{selectedDrafts.length} 条）</Button>
          {/* 合并收款（2026-11-09 D4）：真的建收款单并过账核销，与上面两条**不是一回事** ——
              它按每条应收的未收余额整单结清（核销金额只读、合计=收款金额），只对同一客户 + 同一币种开放
              （不同客户/币种的行会被上面的勾选框锁掉并写明原因，后端也会拒）。 */}
          <Button size="sm" data-testid="receivable-merge-receipt" disabled={!mergeRows.length} onClick={() => setMergeOpen(true)}>合并收款（{mergeRows.length} 条）</Button>
          {mergeRows.length ? <span className="panel-note" data-testid="receivable-merge-hint">合并收款：{mergeRows[0].customerName} / {mergeRows[0].currency}，未收余额合计 {receiptAllocationTotal(mergeRows)}（同一客户 + 同一币种才能合并；核销金额=各条未收余额）</span> : null}
        </div>
        <DataTable columns={ledgerColumns} data={ledgerSources} empty={<EmptyState title="没有符合条件的应收条目" />} onRowDoubleClick={(row) => setDetail({ kind: "source", id: row.id })} rowTitle="双击查看详情" />
      </div>
    </section>}
  </div>;
}

/**
 * 「合并收款」弹窗：一次收款核销同一客户的若干条已确认应收（可跨订单，同一币种）。
 *
 * 与应付侧的「合并付款」完全对称，走的是真单据：
 *   POST /finance/customer-payments            建一张草稿收款单（头：客户 / 币种 / 金额 / 银行 / 科目）
 *   POST /finance/customer-payments/:id/post   过账并逐条核销（每条应收一行 allocation）
 * 第二步才是钱进来的地方：后端在同一个事务里写完核销行、刷新每条应收状态，事务外写收支流水（含 bankId）。
 *
 * 2026-11-09 D4（整单结清）：
 *   - 每条「本次核销金额」**只读** = 该应收的未收余额，不允许改成部分核销；
 *   - 「收款金额」也**只读派生** = Σ 核销金额（同一真源，不摆第二个可编辑输入去和它互相校验）；
 *     提交前仍做一次防御校验，不等就按后端 `PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION` 的同一口径阻断。
 *
 * 金额求和走整数分（`parseSlipAmount` / `formatSlipAmount`）：浮点相加会出现 0.1+0.2 的尾巴，
 * 而这里的合计就是发出去的收款金额。
 */
function ReceivableMergeReceiptDialog({ open, rows, banks, subjects, onOpenChange, onSettled }: {
  open: boolean;
  /** 已选的可收款应收（同一客户 + 同一币种由页面保证：冲突的勾选框会被锁掉）。 */
  rows: MergeReceivable[];
  /** 可选的到账银行账户（页面已加载的启用账户）。 */
  banks: Array<{ value: string; label: string }>;
  /** 可选的会计科目（留空 = 后端按来源自动归类）。 */
  subjects: Array<{ value: string; label: string }>;
  onOpenChange: (open: boolean) => void;
  /** 核销成功后的收尾：页面负责刷新台账与汇总提示（弹窗只管这张收款单本身）。 */
  onSettled: (summary: { count: number; amount: string; currency: string }) => void | Promise<void>;
}) {
  const [receiptDate, setReceiptDate] = useState("");
  const [method, setMethod] = useState("银行转账");
  const [bankId, setBankId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [nature, setNature] = useState("balance");
  const [remark, setRemark] = useState("");
  /**
   * 收款金额：**只读派生** = Σ 各条未收余额。
   *
   * 2026-11-09 D4 整单结清：核销金额是每条应收的未收余额（只读），所以收款金额也只有一个真源 ——
   * 不就是同一个合计。留一个可编辑输入框再校验相等，等于把「同一件事」摆成两个可以互相矛盾的输入；
   * 这里只显示派生值，提交时仍做一次防御校验（见 `blockers` / `submit`，文案对齐后端
   * `PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION`）。
   */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 过账失败时留下的那句话：草稿单号 + 怎么继续。必须留在界面上，不能只闪一条 toast。 */
  const [draftNotice, setDraftNotice] = useState("");
  const idempotencyKey = useRef("");

  const customer = rows[0]?.customerName ?? "";
  const currency = rows[0]?.currency ?? "";
  const total = receiptAllocationTotal(rows);
  const orderNos = useMemo(() => [...new Set(rows.map((row) => row.orderNo).filter((value): value is string => Boolean(value)))], [rows]);
  // 只有**恰好一个**订单号时才把它写进收款单；跨订单（0 个或多个）一律不写，后端因此按每条应收
  // 自己的订单号核销（与合并付款同一条理由：后端只校验收款单自带的那个订单号）。
  const sharedOrderNo = orderNos.length === 1 ? orderNos[0] : null;

  // 每次打开都是**新的一次收款**：日期回今天（北京时间）、银行回第一个启用账户、金额回 Σ核销金额、
  // 幂等键换一个。跟着 rows/banks 一起监听是刻意的：勾选变了，这张单子本来就不再是同一张。
  useEffect(() => {
    if (!open) return;
    setReceiptDate(formatBeijingDate(new Date()));
    setMethod("银行转账");
    setBankId(banks[0]?.value ?? "");
    setSubjectId("");
    setNature("balance");
    setRemark("");
    setError("");
    setDraftNotice("");
    setBusy(false);
    idempotencyKey.current = newReceiptIdempotencyKey();
  }, [open, rows, banks]);

  /**
   * 点不动提交的那些原因（**全部**列出来，不是第一个）。
   *
   * 禁用的按钮点不动，所以原因必须事先写在界面上。收款金额是派生只读值，正常不会和核销合计不等；
   * 这里仍保留 D4 的防御校验：任一行未收余额解析不出、或合计非法时，按后端同一口径阻断
   * （`PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION`），避免带着一个算出 NA 的金额去建单。
   */
  const blockers = useMemo(() => {
    const problems: string[] = [];
    if (!rows.length) problems.push("没有已选的可收款应收");
    if (new Set(rows.map((row) => row.currency)).size > 1) problems.push("勾选的应收跨币种：一笔收款只能一个币种，请分开收");
    if (new Set(rows.map((row) => row.customerId)).size > 1) problems.push("勾选的应收跨客户：一笔收款只能一个客户，请分开收");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) problems.push("请选择收款日期");
    if (!method.trim()) problems.push("请填写收款方式");
    if (!bankId) problems.push("请选择到账银行账户（没有账户的收款不会体现在任何银行余额里）");
    const totalUnits = parseSlipAmount(total);
    const allRowsParsed = rows.every((row) => parseSlipAmount(row.outstanding) !== null);
    // D4 防御校验：核销合计必须是有效金额、且等于收款金额（收款金额 = 同一合计的派生值，
    // 所以这里实际拦的是「有行的未收余额解析失败、合计被少算」这种数据异常）。
    if (!allRowsParsed || totalUnits === null) problems.push("核销合计必须等于收款金额（PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION）");
    return problems;
  }, [rows, receiptDate, method, bankId, total, currency]);

  async function submit() {
    if (blockers.length || busy) return;
    setBusy(true);
    setError("");
    setDraftNotice("");
    // D4 防御校验（提交前再算一次，与显示用的 `total` 走独立的求和路径）：
    // 收款金额 = Σ 核销金额，不等就按后端同一 code 阻断，不带一个对不上的金额去建单。
    let allocatedUnits = 0n;
    for (const row of rows) {
      const units = parseSlipAmount(row.outstanding);
      if (units === null) allocatedUnits = -1n;
      else if (allocatedUnits >= 0n) allocatedUnits += units;
    }
    const totalUnits = parseSlipAmount(total);
    if (totalUnits === null || allocatedUnits < 0n || allocatedUnits !== totalUnits) {
      const message = "核销合计必须等于收款金额（PAYMENT_AMOUNT_MUST_EQUAL_ALLOCATION）";
      setError(message);
      notifyError(message);
      setBusy(false);
      return;
    }
    const createBody: Record<string, unknown> = {
      customer_id: rows[0].customerId,
      payment_date: receiptDate,
      amount: total,
      currency,
      payment_method: method.trim(),
      bank_id: bankId,
      idempotency_key: idempotencyKey.current,
    };
    if (sharedOrderNo) createBody.order_no = sharedOrderNo;
    if (subjectId) createBody.subject_id = subjectId;
    if (remark.trim()) createBody.remark = remark.trim();

    let created: { id: string; paymentNo: string };
    try {
      created = (await apiPost<{ id: string; paymentNo: string }>(CUSTOMER_PAYMENTS_PATH, createBody)).data;
    } catch (cause) {
      // 建单失败（含「已存在同样草稿」）时**什么都没发生**：留在弹窗里说清原因，不发第二步。
      const message = messageOf(cause, "收款单创建失败");
      setError(message);
      notifyError(message);
      setBusy(false);
      return;
    }
    try {
      await apiPost(`${CUSTOMER_PAYMENTS_PATH}/${created.id}/post`, {
        allocations: rows.map((row) => ({ receivable_source_id: row.id, amount: row.outstanding })),
        payment_nature: nature,
      });
    } catch (cause) {
      // 过账失败但**草稿已经建出来了**：必须点名它是哪张、怎么继续，否则财务以为这笔没发生过，
      // 而库里躺着一张她不知道的草稿收款单。幂等键是这次弹窗固定的，所以再点一次提交会
      // 命中同一张草稿（create 的 idempotency_key 重放），不会多建一张。
      const message = `已创建草稿收款单 ${created.paymentNo}（合计 ${total} ${currency}），但核销未完成：${messageOf(cause, "核销失败")}。草稿不动任何金额与状态；在本弹窗再次提交会复用这张草稿继续核销（不会重复建单）。若台账上这些应收已经显示核销完成，说明上一次提交其实成功了，刷新即可。`;
      setDraftNotice(message);
      notifyError(message);
      setBusy(false);
      return;
    }
    notifySuccess(`已收款并核销 ${rows.length} 条应收（${total} ${currency}）`);
    onOpenChange(false);
    await onSettled({ count: rows.length, amount: total, currency });
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
    <DialogContent data-testid="receivable-merge-dialog">
      <DialogHeader><DialogTitle>合并收款：{customer} / {currency}，{rows.length} 条应收</DialogTitle></DialogHeader>
      <DialogBody>
        {/* 一句话说清这次要发生什么（数据，不是说明文）：涉及哪几个订单、为什么行与合计只有一个真源。 */}
        <p className="panel-note" data-testid="receivable-merge-scope">
          本次收款 {total} {currency}，一次核销 {rows.length} 条已确认应收；涉及订单 {orderNos.length ? orderNos.join("、") : "无"}{sharedOrderNo ? "" : "（跨订单：收款单不写订单号，逐条按应收自己的订单号核销）"}
        </p>
        <p className="panel-note">整单结清：核销金额 = 每条应收的未收余额（只读，不可改成部分核销），收款金额 = 核销合计（只读派生）；只对同一客户 + 同一币种开放。</p>
        <div className="filter-bar">
          <label>收款日期<Input type="date" data-testid="receivable-merge-date" value={receiptDate} disabled={busy} onChange={(event) => setReceiptDate(event.target.value)} /></label>
          <label>收款方式<Input data-testid="receivable-merge-method" value={method} disabled={busy} placeholder="银行转账" onChange={(event) => setMethod(event.target.value)} /></label>
          <label>到账银行账户
            {/* 银行账户会随开户增加（用户 2026-11-13：「所有下拉列表……都要有搜索功能」）：带搜索，
                财务记得的是开户行或账号，不是它排第几行。 */}
            <SearchableSelect
              id="receivable-merge-bank"
              testId="receivable-merge-bank"
              value={bankId}
              options={banks.map((bank) => ({ value: bank.value, label: bank.label }))}
              placeholder={banks.length ? "请选择到账银行账户" : "先在【财务 → 银行账户】建一个账户"}
              label="到账银行账户"
              searchPlaceholder="搜索开户行或账号"
              noResultsText="没有匹配的银行账户"
              disabled={busy}
              onChange={setBankId}
            />
          </label>
          <label>款项性质
            <Select value={nature} onValueChange={setNature} disabled={busy}>
              <SelectTrigger data-testid="receivable-merge-nature"><SelectValue /></SelectTrigger>
              <SelectContent>{paymentNatureOptions().map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <label>会计科目（可选）
            <SearchableSelect testId="receivable-merge-subject" value={subjectId} options={[{ value: "", label: "（不指定：按来源自动归类）" }, ...subjects]} label="会计科目" disabled={busy} onChange={setSubjectId} />
          </label>
        </div>
        <label className="ui-form-item">备注<Textarea data-testid="receivable-merge-remark" value={remark} disabled={busy} onChange={(event) => setRemark(event.target.value)} /></label>
        <div data-testid="receivable-merge-rows">
          <div className="table-wrap">
            <table className="data-table table-bounded">
              <thead><tr>
                <th className="cell-ellipsis" style={{ width: "16%" }} title="应收单号">应收单号</th>
                <th className="cell-ellipsis" style={{ width: "18%" }} title="订单号">订单号</th>
                <th className="cell-ellipsis" style={{ width: "20%" }} title="客户">客户</th>
                <th className="cell-ellipsis" style={{ width: "15%" }} title="应收金额">应收金额</th>
                <th className="cell-ellipsis" style={{ width: "15%" }} title="未收余额">未收余额</th>
                <th className="cell-ellipsis" style={{ width: "16%" }} title="本次核销金额">本次核销金额</th>
              </tr></thead>
              <tbody>
                {rows.map((row) => <tr key={row.id} data-testid={`receivable-merge-row-${row.id}`}>
                  <td className="cell-ellipsis" title={row.sourceNo}>{row.sourceNo}</td>
                  <td className="cell-ellipsis" title={row.orderNo ?? "无"}>{row.orderNo ?? "无"}</td>
                  <td className="cell-ellipsis" title={row.customerName}>{row.customerName}</td>
                  <td className="cell-ellipsis" title={money(row.amount, row.currency)}>{money(row.amount, row.currency)}</td>
                  <td className="cell-ellipsis" title={money(row.outstanding, row.currency)}>{money(row.outstanding, row.currency)}</td>
                  {/* 只读：D4 整单结清，核销金额就是该条未收余额，不给输入框（改了也只能被后端拒）。 */}
                  <td data-testid={`receivable-merge-amount-${row.id}`}>{money(row.outstanding, row.currency)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </div>
        <div className="action-row">
          <span className="panel-note" data-testid="receivable-merge-total">核销合计 {total} {currency}（= 各条未收余额之和，只读）</span>
          {/* 收款金额是派生只读值：唯一真源就是上面的核销合计，不给输入框（两个输入会互相矛盾）。 */}
          <span className="panel-note" data-testid="receivable-merge-receipt-amount">收款金额 {total} {currency}（只读派生 = 核销合计）</span>
        </div>
        {blockers.length ? <ul className="panel-note status-error" data-testid="receivable-merge-blockers">{blockers.map((item) => <li key={item}>{item}</li>)}</ul> : null}
        {error ? <p className="status-error" data-testid="receivable-merge-error">{error}</p> : null}
        {draftNotice ? <p className="status-error" data-testid="receivable-merge-draft-notice">{draftNotice}</p> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" data-testid="receivable-merge-cancel" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
        <Button data-testid="receivable-merge-submit" disabled={busy || blockers.length > 0} onClick={() => void submit()}>{busy ? "提交中…" : "收款并核销"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
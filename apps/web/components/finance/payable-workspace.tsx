"use client";

// 应付管理二级页（/finance/payable?tab=...）。
//
// 四个子栏目：
//   1. 原料入库条目：原料入库过账生成的**待接收**应付来源；
//   2. 外加工签收：外加工实际签收生成的**待接收**应付来源；
//   3. 应付对账：对账创建 + 对账单列表合并在同一视图；
//   4. 确认应付：应付台账，**勾选多条一次确认**（2026-09-24 起确认 = **挂账**：借成本/存货、贷应付账款，付款时再登记）。
// 双击任意行弹出居中详情（展示全部字段与当前可执行操作）。
//
// 2026-09-16（用户要求，三条）：
//   ① 说明性语句全部去掉，界面只留数据；
//   ② **已接收**的来源不再出现在两个「待接收」列表里（它已经是应付草稿了，看草稿就行）；
//   ③ 「登记付款 → 过账核销」这第二遍流程当时被拿掉了：那时确认应付**同时记账**（钱直接从账户出去），
//      再登记一次付款等于同一笔钱扣两次；所以确认这边只保留「勾选 + 批量确认」。
//
// 2026-10-08（用户确认）：确认应付已经是**挂账**（借成本/存货、贷应付账款，钱还没出去），
//   第二步因此回来了，而且是**真的核销**：勾选多条已确认应付 → 「合并付款」建一张付款单
//   （同一供应商 + 同一币种，**可跨多个订单**）→ 过账逐条写核销行、刷应付状态、写收支流水（含银行）。
//   行内「付款单」与「集中付款单」队列仍是**打印件**（不改任何数据），两条路各有各的用途。
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
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { FileInput } from "../ui/file-input";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiDelete, apiGet, apiPatch, apiPost } from "../../lib/api-client";
import { downloadFile } from "../../lib/download";
import { ledgerExportQuery, paymentBucket, paymentCounts, withinDateRange, type LedgerPaymentFilter } from "../../lib/finance-ledger-filter";
import { currencyOptions, currencyOptionsWithCurrent, fetchCurrencyOptions, type CurrencyOption } from "../../lib/currency-catalogue";
import { PAYABLE_TABS, PAYABLE_TAB_ALIASES, resolveFinanceTab, type PayableTabParam } from "../../lib/finance-sections";
import { ACCOUNTING_SUBJECTS_PATH, subjectOptionLabel, toSubjectOptions, type AccountingSubject } from "../../lib/accounting-subjects";
import { notifyError, notifySuccess } from "../ui/toaster";
import { FinanceTabs } from "./finance-tabs";
import FinanceSlipEditor from "./finance-slip-editor";
import { RecordDetailDialog, money, type DetailField } from "./record-detail-dialog";
import { auditColumns, auditDetailFields, type AuditRow } from "../data/audit-columns";
import { financeStatus } from "./finance-status";
import { financeSlipDraftBody, financeSlipDraftPath, type FinanceSlipDraft } from "../../lib/finance-slip";
import PayableMergePaymentDialog, { isSettleable, settleAnchorOf, settleLockReasons, settleOutstandingTotal, type MergePayable } from "./payable-merge-payment-dialog";

/** 银行下拉的「清空」哨兵值（见 bankField / bankValue）：Radix Select 不接受空串 value。 */
const BANK_CLEAR = "__no_bank__";
/**
 * 会计科目下拉的「清空」哨兵值（同银行的理由）：已有单据上的科目要能去掉 PATCH 送 null，
 * 但未改动时必须送 undefined，否则每次编辑都会把单据上已有的科目一并抹掉。
 */
const SUBJECT_CLEAR = "__no_subject__";

type Reference = { id: string; name: string; supplierCode?: string; orderNo?: string };
type SupplierRef = { id: string; name: string; supplierCode: string | null };
type BankRef = { id: string; bankCode: string; bankName: string; accountName: string; accountNumber: string; currency: string; isActive: boolean; swiftCode: string | null; remark: string | null };
/** 来源已经接收成的那张应付单（列表接口的 payable_entry）：有它就说明这条来源不需要再接收。 */
type SourcePayableLink = { id: string; payableNo: string; status: string };
type PayableSource = AuditRow & {
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
type OutsourcePayableSource = AuditRow & {
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
type PayableEntry = AuditRow & {
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
/** 列表/详情接口内嵌的会计科目（财务 → 收支管理 → 会计科目）。 */
type SubjectLink = { id: string; category: string; name: string };
type SupplierReconciliation = AuditRow & {
  id: string; reconciliationNo: string; orderNo: string | null; supplierId: string; periodStart: string; periodEnd: string;
  payableAmountSnapshot: string; paymentAmountSnapshot: string; adjustmentAmountSnapshot: string; systemBalance: string;
  externalBalance: string; difference: string; currency: string; status: string; resolutionRemark: string | null; remark: string | null; createdAt: string;
  supplier?: SupplierRef | null; purchaseOrder?: { purchaseOrderNo: string } | null;
  bank?: BankRef | null;
  /** 建单/确认时人工选定的会计科目（确认应付记流水时用它，除非确认接口再覆盖）。 */
  subjectId?: string | null;
  /** 列表/详情接口内嵌的会计科目对象（`{ id, category, name }`）。 */
  subject?: SubjectLink | null;
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
/**
 * 台账的一行 → 「合并付款」要的那几个字段。
 *
 * `outstanding_amount` 是列表接口算好的「应付金额 - 已过账核销」（`supplier-payable.service.ts:82-83,98`），
 * 前端不重算：核销口径只有服务端一处，前端再算一遍就会出现「界面说能付、后端说超了」。
 * 进到这里来的行都由 `isSettleable` 筛过（余额必然有值且 > 0），所以兜底只服务类型系统。
 */
const mergePayableOf = (entry: PayableEntry): MergePayable => ({
  id: entry.id, payableNo: entry.payableNo, orderNo: entry.orderNo, supplierId: entry.supplierId,
  supplierName: entry.supplier_name ?? entry.supplier?.name ?? entry.supplierId,
  currency: entry.currency, amount: entry.amount, outstanding: entry.outstanding_amount ?? entry.amount,
});

/** 其他应付批量导入的结果（后端 `POST /finance/payable-entries/import` 的 data）。 */
type OtherPayableImportResult = {
  status: "ok" | "partial" | "failed";
  total: number;
  imported: number;
  successCount: number;
  errorCount: number;
  headerRow: number;
  errors: Array<{ row: number; field?: string; reason: string }>;
  missingColumns: string[];
  ignoredColumns: string[];
  ignoredTrailingRows: number;
  createdSuppliers: Array<{ name: string; supplierCode: string; rows: number }>;
  hints: string[];
};

export default function PayableWorkspace({ tab, testId }: { tab: PayableTabParam; testId: string }) {
  const [inboundSources, setInboundSources] = useState<PayableSource[]>([]);
  const [outsourceSources, setOutsourceSources] = useState<OutsourcePayableSource[]>([]);
  const [entries, setEntries] = useState<PayableEntry[]>([]);
  const [reconciliations, setReconciliations] = useState<SupplierReconciliation[]>([]);
  const [suppliers, setSuppliers] = useState<Reference[]>([]);
  const [orders, setOrders] = useState<Reference[]>([]);
  const [banks, setBanks] = useState<BankRef[]>([]);
  const [subjects, setSubjects] = useState<AccountingSubject[]>([]);
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
  // 其他应付批量导入（用户 2026-09-16）：模板下载 + 上传 + 逐行结果。
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<OtherPayableImportResult | null>(null);
  const [currencyCatalogue, setCurrencyCatalogue] = useState<CurrencyOption[]>([]);
  const [filter, setFilter] = useState("");
  /** 勾选出来待确认的应付条目 id（「确认应付」页的批量确认用）。 */
  const [selected, setSelected] = useState<string[]>([]);
  /**
   * 「确认应付」页的筛选：付款情况 + 确认日期区间（用户要求「已付的条目不要出现在那里」+
   * 「按已付未付、按时间范围筛选」）。**默认只显示未付**（草稿）—— 这一页是待办清单，
   * 已经确认过（钱已经出去）的条目默认不在这里，需要时用筛选器切到「已付」或「全部」。
   */
  const [payment, setPayment] = useState<LedgerPaymentFilter>("unpaid");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [exporting, setExporting] = useState(false);
  /**
   * 付款单编辑器（财务 2026-09-20：「她需要在付款界面能导出付款单」；2026-09-24 改为**队列**）。
   *
   * 打开时先去后端预填（单号 / 收款单位 / 开户行 / 科目 / 借贷行），再把结果交给编辑器 ——
   * 预填口径（科目取确认时实际记账的那个、单号按「该供应商本月第几笔付款」）只有服务端知道，
   * 前端拍不出来。跨供应商 / 跨币种时后端会**拆成多张**（一次集中付款 = 一队单子），
   * 所以这里存的是数组；`pending_ids` 是这批里**还没确认**的条目（钱还没出账），
   * 队列底部据此给出「确认这 N 条」的出路。付款单**不落库**：改完直接出 xlsx。
   */
  const [slip, setSlip] = useState<{ open: boolean; loading: boolean; error: string; drafts: FinanceSlipDraft[] | null; pendingIds: string[] }>({ open: false, loading: false, error: "", drafts: null, pendingIds: [] });
  /** 合并付款弹窗（真的建付款单 + 过账核销，与上面那张打印件队列不是一回事）。 */
  const [mergeOpen, setMergeOpen] = useState(false);

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
        // 要停用的科目：下拉只列启用项，但历史单据上挂着已停用科目时必须还能显示它的名字，
        // 否则那些行会显示成 "-"（与应收侧同一条理由）。
        apiGet<AccountingSubject[]>(`${ACCOUNTING_SUBJECTS_PATH}?include_inactive=true`).catch(() => ({ data: [] as AccountingSubject[], meta: {} })),
      ]);
      setInboundSources(inbound.data); setOutsourceSources(outsource.data); setEntries(e.data);
      setReconciliations(r.data); setSuppliers(s.data); setOrders(o.data); setBanks(b.data); setSubjects(i.data);
      // 勾选状态跟着数据走：已经不能确认、也不能核销（已付清/已冲销）的条目自动退出勾选
      // （界面上再也点不到它们，留着 id 会让「批量确认 N 条 / 合并付款 N 条」里的 N 与实际能操作的条数对不上）。
      setSelected((ids) => ids.filter((id) => e.data.some((entry) => entry.id === id && (isDraft(entry) || isSettleable(entry)))));
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
  async function submitAction<T = unknown>(path: string, body: unknown, success: string | ((data: T) => string), method: "post" | "patch" | "delete" = "post"): Promise<T> {
    try {
      const result = await (method === "patch" ? apiPatch<T>(path, body ?? {}) : method === "delete" ? apiDelete<T>(path, body) : apiPost<T>(path, body));
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
   * 三条路径都是**挂账**（借成本 / 贷应付账款）：钱还没付，所以这里不能再报「金额已记入所选银行账户」。
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
  /**
   * 可人工指定的会计科目：只给启用项，不传 include_inactive（停用科目不许再被选中）。
   *
   * 下拉一律用 `searchable-select`（用户 2026-09-20 第 1 条：「所有涉及会计科目的下拉列表，
   * 都要新增一个搜索框支持搜索」）：科目表有一百二十多条，按「分类 / 名称」拼出来的标签更长，
   * 普通 Radix 下拉只能靠滚动找 —— 财务知道科目名却要滚半天。带搜索框以后直接打两个字即可。
   */
  const subjectOptions = toSubjectOptions(subjects.filter((item) => item.isActive)).map((option) => ({ value: option.id, label: option.label }));  /**
   * 会计科目 id → 显示名：列表/详情通常只给 `subjectId`，标签用科目表还原；查不到显示 -，不让整页崩。
   * 接口若内嵌了 `subject`，优先用它 —— 显示口径与下拉一致（`分类 / 科目名称`）。
   */
  const subjectLabel = (subject: SubjectLink | null | undefined, id?: string | null) => {
    if (subject) return subjectOptionLabel(subject);
    const found = subjects.find((item) => item.id === id);
    return found ? subjectOptionLabel(found) : "-";
  };
  /** 建单弹窗的会计科目：可选，留空表示不管这个字段（新建单据上没有科目可清，所以不摆「清空」哨兵）。 */
  const subjectCreateField = (label: string): ActionField => ({ name: "subject_id", label, type: "searchable-select", options: subjectOptions });
  /**
   * 已有单据上的会计科目：默认带出当前值；选「（不指定会计科目）」送 null。
   * 默认值用 `current ?? ""` 而非哨兵：未改动必须送 undefined，后端 PATCH 才完全不动这个字段。
   */
  const subjectEditField = (label: string, current?: string | null): ActionField => ({
    name: "subject_id", label, type: "searchable-select",
    options: [{ value: SUBJECT_CLEAR, label: "（不指定会计科目）" }, ...subjectOptions],
    defaultValue: current ?? "",
  });
  /** 哨兵/空值 → 提交值：明确清空送 null，未改动送 undefined（后端不更新该字段）。 */
  const subjectValue = (value: string | undefined) => (value === SUBJECT_CLEAR ? null : (value || undefined));

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
   * 逻辑删除「其他应付」（用户 2026-09-20：「其他应付这种类型的，允许进行逻辑删除。因为有时候录错了」，
   * 随后追问「包括删除确认应付和应付对账」）。
   *
   * 为什么原因必填：删除是唯一一个「记录会从台账上消失」的动作，事后要能说清是谁、什么时候、
   * 为什么删的。前端必填 + 后端必填（`DELETION_REASON_REQUIRED`）两道，原因同时写进备注与审计。
   *
   * 按钮出现在「其他应付」的**草稿与已确认**行上（界面上与后端的三条边界一致 —— 摆一个点了必然报错的
   * 按钮比不摆更糟）：草稿删了就是没发生过；已确认的删的时候后端会在同一个事务里**冲回那笔支出**
   * （钱回到账上），所以文案里把这件事说清楚，避免财务以为只是「列表上少一行」。已被对账单覆盖时
   * 后端会回一句可执行的说明（先去删那张对账单）。
   */
  function deleteOtherPayable(item: PayableEntry) {
    setDialog({ title: `删除其他应付：${item.payableNo}`, fields: [
      { name: "info", label: `将从台账删除「${item.sourceNoSnapshot}」${money(item.amount, item.currency)}${item.status === "confirmed" ? "；这条已确认并记过账，删除时会同时冲回那笔支出（钱回到账上）" : ""}。记录与删除原因保留在审计里，不会真的从数据库消失`, type: "info" as const },
      { name: "reason", label: "删除原因（录错了请写清错在哪）", type: "textarea", required: true },
    ], submit: (v) => submitAction(`/finance/payable-entries/${item.id}`, { reason: v.reason }, `其他应付 ${item.payableNo} 已删除`, "delete") });
  }
  /**
   * 逻辑删除一张应付对账单（用户 2026-09-20：「包括删除确认应付和应付对账」）。
   *
   * 这条入口是那句错误提示的「下一步」：删一条误录的其他应付时会被「该应付已纳入对账单 XXX，
   * 请先删除那张对账单」挡住，而对账单原先根本没有删除入口。
   * 已经用于确认应付并记账的对账单会被后端拒删（那笔支出会失去来源单号），界面原样显示原因。
   */
  function deleteReconciliation(item: SupplierReconciliation) {
    setDialog({ title: `删除应付对账：${item.reconciliationNo}`, fields: [
      { name: "info", label: `将从应付对账删除 ${item.reconciliationNo}（${item.supplier?.name ?? item.supplierId}，期间 ${day(item.periodStart)} 至 ${day(item.periodEnd)}，系统余额 ${money(item.systemBalance, item.currency)}）。被它覆盖的草稿应付会重新回到「待创建对账」`, type: "info" as const },
      { name: "reason", label: "删除原因（录错了请写清错在哪）", type: "textarea", required: true },
    ], submit: (v) => submitAction(`/finance/supplier-payable-reconciliations/${item.id}`, { reason: v.reason }, `应付对账单 ${item.reconciliationNo} 已删除`, "delete") });
  }

  /**
   * 打开付款单队列：先按勾选的应付条目向后端要一份预填（可能是一队多张）。
   *
   * 一行一条应付（金额全额，**不自动拆进项税** —— 系统里的单价是含税价，按税率拆在取得普票、
   * 优惠税率或部分抵扣时会被填错），贷方一行银行存款等于合计；财务要拆进项税就自己加行、
   * 要少付就自己改金额（用户原话：「我要付款 100，我可以自己填加行」）。
   *
   * 后端按「收款单位 + 币种」拆张（用户 2026-09-24：「还是不能实现一起付款，只能算是一起确认了，
   * 然后还是一个个的改付款单」）：一次勾选多家供应商不再报错，而是一队单子——她在队列里逐张核对，
   * 也能一次全部导出。预填失败时**照样打开弹窗**把原因写出来：静默什么都不发生，
   * 用户只会以为按钮坏了。
   */
  async function openPaymentSlip(ids: string[]) {
    setSlip({ open: true, loading: true, error: "", drafts: null, pendingIds: [] });
    try {
      // 路径与请求体由 lib 的 `financeSlipDraftPath` / `financeSlipDraftBody` 给：
      // 「付款单勾应付条目、收款单勾应收来源」这条区分只该有一处知道（与后端两个 DTO 对称）。
      const result = await apiPost<{ slips: FinanceSlipDraft[] }>(financeSlipDraftPath("payment"), financeSlipDraftBody("payment", ids));
      setSlip({ open: true, loading: false, error: "", drafts: result.data.slips, pendingIds: draftsAmong(ids) });
    } catch (cause) {
      setSlip({ open: true, loading: false, error: messageOf(cause, "付款单预填失败"), drafts: null, pendingIds: [] });
    }
  }
  /** 这批勾选里还没确认的条目 id（队列底部要据此显示「确认这 N 条（付款）」）。 */
  function draftsAmong(ids: string[]): string[] {
    return ids.filter((id) => entries.some((entry) => entry.id === id && isDraft(entry)));
  }
  /**
   * 逐条确认应付 —— 与「勾选批量确认」「按对账单确认」是同一件事的三条入口，都**挂账**（借成本 / 贷应付账款）。
   *
   * 应付条目本身不挂银行账户（它来自入库 / 签收来源），所以这里必须问清「钱从哪个账户出」：
   * 不指定就只能在收支流水里留一笔无归属的钱（后端回 bank_missing，上面会警告）。
   */
  function confirmEntry(item: PayableEntry) {
    setDialog({ title: `确认应付：${item.payableNo}`, fields: [
      { name: "confirm", label: `确认应付 ${item.payableNo}：${item.amount} ${item.currency}`, type: "info" as const },
      bankField("支付银行"),
      subjectEditField("会计科目"),
    ], submit: (v) => submitConfirm(`/finance/payable-entries/${item.id}/confirm`, { bank_id: bankValue(v.bank_id), subject_id: subjectValue(v.subject_id) }, (data) => ({
      success: `应付 ${item.payableNo} 已确认（${data.amount ?? item.amount} ${data.currency ?? item.currency}）并挂账（借成本 / 贷应付账款）；付款后在「登记付款」里记现金`,
      warning: `未指定支付银行：${data.amount ?? item.amount} ${data.currency ?? item.currency} 已记入收支流水，但不会体现在任何银行账户余额里`,
    }), "确认应付失败") });
  }
  /**
   * 勾选批量确认 —— 用户要求「不要又是登记付款又是确认应付，直接就是支持勾选，批量确认」。
   *
   * 整批共用一个支付银行与一个会计科目（后端仍是**每条应付写一条流水**，所以每条都追得回来源单号）；
   * 合计**按币种分组**显示，跨币种不相加。勾选里混进已被别人确认掉的条目时，后端会跳过并回报条数。
   *
   * `ids` 默认取当前勾选；付款单队列底部那条「确认这 N 条」会把**那一批**的 id 传进来
   * （队列可能是从行内单条打开的，那时它不在勾选里 —— 传勾选会让「确认」按到别的条目上）。
   */
  function batchConfirm(ids: string[] = selectedDrafts.map((draft) => draft.id)) {
    const drafts = entries.filter((entry) => isDraft(entry) && ids.includes(entry.id));
    const totals = new Map<string, number>();
    for (const draft of drafts) totals.set(draft.currency, (totals.get(draft.currency) ?? 0) + Number(draft.amount));
    setDialog({ title: `批量确认应付（${drafts.length} 条）`, fields: [
      { name: "confirm", label: `确认 ${drafts.length} 条草稿应付（合计 ${[...totals.entries()].map(([currency, amount]) => `${amount.toFixed(4)} ${currency}`).join("、")}）`, type: "info" as const },
      bankField("支付银行"),
      subjectEditField("会计科目"),
    ], submit: (v) => submitConfirm("/finance/payable-entries/batch-confirm", { ids: drafts.map((draft) => draft.id), bank_id: bankValue(v.bank_id), subject_id: subjectValue(v.subject_id) }, (data) => {
      const amount = data.amounts?.length ? data.amounts.map((item) => `${item.amount} ${item.currency}`).join("、") : "-";
      const skipped = data.skipped_count ? `；跳过 ${data.skipped_count} 条` : "";
      return {
        success: `已确认 ${data.confirmed_count ?? drafts.length} 条应付（${amount}）${skipped}，并逐条挂账（借成本 / 贷应付账款）；付款后在「登记付款」里记现金`,
        warning: `未指定支付银行：${amount} 已记入收支流水，但不会体现在任何银行账户余额里`,
      };
    }, "批量确认应付失败") });
  }

  /**
   * 导出当前筛选出的应付台账（用户要求「确认应付要支持导出 excel」）。
   *
   * 查询串由 `ledgerExportQuery` 统一拼（与后端 `ledger-filter.ts` 同一口径），
   * 所以**导出的就是所见**：界面上筛出几条，文件里就是几条 —— 不会出现「搜了再导出、导出的是全部」。
   * 文件名带行数由后端按既有约定给出（`迪礼ERP-应付台账-<时间戳>-<N>行.xlsx`）。
   */
  async function exportLedger() {
    setExporting(true);
    try {
      const query = ledgerExportQuery({ payment, from: dateFrom || undefined, to: dateTo || undefined, q: filter });
      await downloadFile(`/api/v1/finance/payable-entries.xlsx?${query}`, "迪礼ERP-应付台账.xlsx");
      notifySuccess(`已导出 ${ledgerEntries.length} 条应付`);
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : "导出失败");
    } finally {
      setExporting(false);
    }
  }

  /**
   * 下载「其他应付」导入模板。
   *
   * 走裸 fetch 而不是 apiGet：响应是二进制 xlsx，apiGet 会把它当 JSON 解析。
   * 与人事花名册导入的模板下载同一做法（凭据要带上，接口在 finance 模块权限后面）。
   */
  async function downloadOtherImportTemplate() {
    try {
      const response = await fetch("/api/v1/finance/payable-entries/import-template.xlsx", { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("模板下载失败");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "迪礼ERP-其他应付导入模板.xlsx";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : "模板下载失败");
    }
  }

  /**
   * 上传并导入其他应付。
   *
   * 上传的是 multipart（FormData），不能走 apiPost —— 那会把 body JSON 化。
   * 导入结果整份留在弹窗里（逐行错误 + 自动建档的供应商 + 提示），不做成一条 toast：
   * 「第 7 行金额不合法」这类信息必须能被逐条看清，否则操作员只能瞎猜。
   */
  async function importOtherPayables(file: File | undefined) {
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/v1/finance/payable-entries/import", { method: "POST", credentials: "include", body: form });
      const body = await response.json();
      if (!response.ok || body.error) throw new ApiClientError(body.error?.code ?? "IMPORT_FAILED", body.error?.message ?? "导入失败", body.error?.details ?? []);
      const result = body.data as OtherPayableImportResult;
      setImportResult(result);
      if (result.imported > 0) {
        notifySuccess(`已导入 ${result.imported} 条其他应付草稿${result.errorCount ? `，${result.errorCount} 行未导入` : ""}`);
        await load();
      }
    } catch (cause) {
      notifyError(messageOf(cause, "其他应付导入失败"));
    } finally {
      setImporting(false);
    }
  }

  function createOtherPayable() {    setDialog({ title: "新建其他应付（非订单支出）", fields: [      { name: "supplier_id", label: "供应商", type: "select", required: true, canAddCategory: true, options: supplierOptions },
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
      subjectCreateField("会计科目"),
      { name: "remark", label: "备注", type: "textarea" },
    ], submit: (v) => submitAction("/finance/supplier-payable-reconciliations", { supplier_id: v.supplier_id, order_no: v.order_no || undefined, period_start: v.period_start, period_end: v.period_end, external_balance: v.external_balance, currency: v.currency, bank_id: bankValue(v.bank_id), subject_id: v.subject_id || undefined, remark: v.remark || undefined }, "应付对账单已创建") });
  }
  function resolveReconciliation(item: SupplierReconciliation) {
    setDialog({ title: `处理应付对账差异：${item.reconciliationNo}`, fields: [{ name: "remark", label: "处理说明", type: "textarea", required: true, defaultValue: "已核对" }], submit: (v) => submitAction(`/finance/supplier-payable-reconciliations/${item.id}/resolve`, { resolution_remark: v.remark }, "应付对账差异已处理") });
  }
  /**
   * 对账完成后一键确认范围内的草稿应付。
   *
   * 确认应付现在**同时记账** —— 确认金额作为一笔支出写进收支流水，落到对账单的银行账户上。
   * 所以不能无 body 直接打：历史对账单常常既没银行也没会计科目，必须先把「记到哪个账户、归哪个会计科目」
   * 问清楚（与应收侧同一套弹窗）。
   */
  function confirmReconciliationPayables(item: SupplierReconciliation) {
    const count = item.details?.draft_count ?? item.flow?.draft_count ?? 0;
    const amount = item.details?.draft_amount ?? item.flow?.draft_amount;
    setDialog({ title: `确认应付：${item.reconciliationNo}`, fields: [
      { name: "confirm", label: `确认 ${count} 条草稿应付${amount ? `（合计 ${amount} ${item.currency}）` : ""}`, type: "info" as const },
      bankField("支付银行", item.bank?.id),
      subjectEditField("会计科目", item.subjectId),
    ], submit: (v) => submitConfirmPayables(item, v) });
  }
  /** 确认应付的提交：与逐条 / 勾选批量共用 submitConfirm（三条路径都会记账，都要处理 bank_missing）。 */
  async function submitConfirmPayables(item: SupplierReconciliation, v: Record<string, string>) {
    return submitConfirm(`/finance/supplier-payable-reconciliations/${item.id}/confirm-payables`, { bank_id: bankValue(v.bank_id), subject_id: subjectValue(v.subject_id) }, (data) => {
      const amount = data.confirmed_amount ?? data.amount ?? "-";
      const currency = data.currency ?? item.currency;
      const skipped = data.skipped_count ? `；跳过 ${data.skipped_count} 条` : "";
      return {
        success: `${item.reconciliationNo} 已确认 ${data.confirmed_count ?? 0} 条应付（${amount}）${skipped}，并逐条挂账（借成本 / 贷应付账款）；付款后在「登记付款」里记现金`,
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
  const filteredEntries = useMemo(() => entries.filter((item) => match([item.payableNo, item.orderNo, item.supplier_name, item.material_name, item.purchase_order_no, item.source_no, item.sourceNoSnapshot])), [entries, match]);
  /**
   * 对账单也要能被搜到（用户 2026-09-20 第 7 条：「应收管理，应付管理全部表单可以加个查询，
   * 现在单少还可以查，多的时候就不好找了」）。
   *
   * 上一版的关键字只作用在「应付条目」上，而「应付对账」页的**已创建对账单**那张表渲染的是
   * 原始数组 —— 也就是说这个页签上搜索框看着在，打了字却没有任何反应。对账单是财务翻得最多的表，
   * 恰恰最需要能搜。搜的字段与列表列一一对应（对账单号 / 供应商 / 订单号 / 采购单号 / 物料）。
   */
  const filteredReconciliations = useMemo(() => reconciliations.filter((item) => match([
    item.reconciliationNo, item.supplier?.name, item.orderNo,
    item.flow?.order_nos.join("、"), item.flow?.purchase_order_nos.join("、"),
    item.purchaseOrder?.purchaseOrderNo, item.flow?.material_names.join("、"),
  ])), [reconciliations, match]);
  // 「确认应付」页的取数：关键字 + 确认日期区间 → 付款分档计数 → 当前付款情况。
  // 计数用「日期与关键字已经筛过、但付款情况还没筛」的那一批：筛选器上的
  // 「未付（3）/ 已付（5）」才是当前条件下的真实条数（否则切到「已付」会看到另一个口径）。
  const scopedEntries = useMemo(
    () => filteredEntries.filter((item) => withinDateRange(item.confirmationDate, dateFrom, dateTo)),
    [filteredEntries, dateFrom, dateTo],
  );
  const paymentTally = useMemo(() => paymentCounts(scopedEntries), [scopedEntries]);
  const ledgerEntries = useMemo(
    () => payment === "all" ? scopedEntries : scopedEntries.filter((entry) => paymentBucket(entry.status) === payment),
    [scopedEntries, payment],
  );

  const pendingSourceCount = pendingInbound.length + pendingOutsource.length;
  const draftEntries = entries.filter(isDraft);
  const draftTotal = draftEntries.reduce((sum, entry) => sum + Number(entry.amount), 0);
  const confirmedCount = entries.filter((entry) => ["confirmed", "partially_paid", "paid"].includes(entry.status)).length;
  const readyToConfirm = reconciliations.reduce((sum, item) => sum + (item.flow?.can_confirm_payables ? item.flow.draft_count : 0), 0);

  // 「待创建对账」跟着**关键字**一起收窄（原来只看 entries，搜索在这张表上等于没接上）；
  // 「已创建对账单」同理 —— 见 filteredReconciliations 的注释。
  const pendingEntries = useMemo(() => filteredEntries.filter((entry) => entry.status === "draft" && !entry.reconciliation), [filteredEntries]);
  const coveredDrafts = useMemo(() => entries.filter((entry) => entry.status === "draft" && entry.reconciliation), [entries]);
  const pendingTotal = pendingEntries.reduce((sum, entry) => sum + Number(entry.amount), 0);

  // 勾选对**两条流程**开放（2026-10-08），各自只认自己那一部分：
  //   - 草稿行 → 「集中付款单」（打印件，不改数据）与「批量确认」；
  //   - 已确认 / 部分付款、且未核销余额 > 0 的行 → 「合并付款」（真的建单 + 过账核销）。
  // 已付清（余额 0）与已冲销的行没有可做的事，勾选框都不给。
  // 勾选范围跟着**当前筛选结果**走：被筛选器藏起来的条目不参与全选，也不计入「已选 N 条」。
  const selectableIds = useMemo(() => ledgerEntries.filter((entry) => isDraft(entry) || isSettleable(entry)).map((entry) => entry.id), [ledgerEntries]);
  const selectedDrafts = useMemo(() => ledgerEntries.filter((entry) => isDraft(entry) && selected.includes(entry.id)), [ledgerEntries, selected]);
  const selectedSettleable = useMemo(() => ledgerEntries.filter((entry) => isSettleable(entry) && selected.includes(entry.id)), [ledgerEntries, selected]);
  const mergeRows = useMemo(() => selectedSettleable.map(mergePayableOf), [selectedSettleable]);
  /**
   * 「合并付款」这一批的锚点（第一条被选中的可核销应付）：它决定整批的供应商与币种 ——
   * 一张付款单只能对一个供应商、一个币种（后端 `supplier-payment.service.ts:96` 会以
   * ALLOCATION_REFERENCE_MISMATCH 拒绝混在一起的），所以其余不同供应商/币种的行在界面上直接
   * 锁掉并写明原因，而不是让她勾完再吃一个 422。
   *
   * 草稿行**不受**这把锁影响：集中付款单是打印件，后端本来就会按「收款单位 + 币种」拆成多张。
   */
  const settleAnchor = useMemo(() => settleAnchorOf(mergeRows), [mergeRows]);
  const settleLock = (entry: PayableEntry) => settleAnchor ? settleLockReasons(settleAnchor, { supplierId: entry.supplierId, currency: entry.currency }) : [];
  /**
   * 被「付款情况」筛选藏起来的、可核销的应付条数。
   *
   * 为什么需要这个数：`finance-ledger-filter.ts` 的「已付 / 未付」还是**旧口径**（确认即记账年代：
   * `confirmed` 一律算「已付」），而本轮确认只是挂账、钱还没出去 —— 所以默认的「未付」视图里
   * 一条可核销的应付都看不到，用户会以为「合并付款」没有入口。筛选口径的改动牵动后端同名实现与
   * 两边的既有测试（不在本次改动范围内），这里先把去处写出来，不让功能藏起来。
   */
  const hiddenSettleable = useMemo(
    () => scopedEntries.filter((entry) => isSettleable(entry) && !ledgerEntries.some((row) => row.id === entry.id)).length,
    [scopedEntries, ledgerEntries],
  );
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selected.includes(id));
  const toggleOne = (id: string) => setSelected((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
  const toggleAll = () => setSelected((ids) => allSelected ? ids.filter((id) => !selectableIds.includes(id)) : [...new Set([...ids, ...selectableIds])]);

  const selectionColumn: ColumnDef<PayableEntry> = {
    id: "select",
    // 表头全选覆盖「可确认的草稿 + 可核销的已确认应付」两类（见 selectableIds 的注释）。
    header: () => <input type="checkbox" aria-label="全选可确认/可核销应付" data-testid="payable-select-all" checked={allSelected} disabled={!selectableIds.length} onChange={toggleAll} />,
    cell: ({ row }) => {
      const settleable = isSettleable(row.original);
      if (!isDraft(row.original) && !settleable) return null;
      // 锁只对可核销的行生效；锁住的原因就写在勾选框旁边（禁用的控件点不动，原因不能只在 title 里）。
      const locks = settleable ? settleLock(row.original) : [];
      return <>
        <input type="checkbox" aria-label={`选择 ${row.original.payableNo}`} data-testid={`payable-select-${row.original.id}`} title={locks.join("；") || undefined} disabled={locks.length > 0} checked={selected.includes(row.original.id)} onChange={() => toggleOne(row.original.id)} />
        {locks.length ? <span className="panel-note status-error" data-testid={`payable-select-lock-${row.original.id}`}>{locks.join("；")}</span> : null}
      </>;
    },
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
    ...auditColumns<PayableSource>(),
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
    ...auditColumns<OutsourcePayableSource>(),
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row"><Button size="sm" variant="secondary" onClick={() => receiveSource("outsource_receipt", row.original)}>接收应付</Button></div> },
  ];
  // 「未核销余额」这一列回来了（2026-10-08）：核销现在是真的（「合并付款」过账时真的写核销行），
  // 所以「应付金额 - 已核销」是个可用的数，也是勾选合并付款的依据（余额 0 = 已付清，勾不了）。
  // 当年把它删掉是因为确认即记账：那时每条已确认应付的未付都是全额，与「钱已经出去了」自相矛盾。
  // 核销明细仍在双击后的详情里。
  const entryColumns: ColumnDef<PayableEntry>[] = [
    selectionColumn,
    { accessorKey: "payableNo", header: "应付单号" },
    { id: "sourceNo", header: "来源批次", cell: ({ row }) => row.original.source_no ?? row.original.sourceNoSnapshot },
    { id: "sourceType", header: "来源", cell: ({ row }) => SOURCE_TYPE_LABELS[row.original.sourceType] ?? row.original.sourceType },
    { id: "orderNo", header: "订单号", cell: ({ row }) => row.original.orderNo ?? (row.original.sourceType === "other" ? "无" : "-") },
    { id: "supplier", header: "供应商", cell: ({ row }) => row.original.supplier_name ?? row.original.supplier?.name ?? "-" },
    { id: "material", header: "原料 / 说明", cell: ({ row }) => row.original.sourceType === "other" ? row.original.sourceNoSnapshot : materialText(row.original) },
    { id: "amount", header: "应付金额", cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "outstanding", header: "未核销余额", cell: ({ row }) => money(row.original.outstanding_amount, row.original.currency) },
    { id: "confirmationDate", header: "确认日期", cell: ({ row }) => day(row.original.confirmationDate) },
    { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "payable") },
    ...auditColumns<PayableEntry>(),
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">
      {row.original.status === "draft" && <><Button size="sm" variant="secondary" onClick={() => confirmEntry(row.original)}>确认应付</Button><Button size="sm" variant="ghost" onClick={() => editEntry(row.original)}>编辑</Button></>}
      {row.original.status === "confirmed" && <Button size="sm" variant="ghost" onClick={() => reopenEntry(row.original)}>回退</Button>}
      {/* 付款单：草稿（准备付款）与已确认（钱已经出去了）都能出单 —— 它是一张打印件，不改任何数据。 */}
      <Button size="sm" variant="ghost" data-testid={`payable-slip-${row.original.id}`} onClick={() => void openPaymentSlip([row.original.id])}>付款单</Button>
      {/* 只有「其他应付」给删除：原料/外加工形成的应付是到货事实的账，录错了要走冲销。
          草稿与已确认都给（用户 2026-09-20：「包括删除确认应付」）—— 已确认的由后端在同一事务里冲回支出。 */}
      {(row.original.status === "draft" || row.original.status === "confirmed") && row.original.sourceType === "other" && <Button size="sm" variant="destructive" data-testid={`payable-delete-${row.original.id}`} onClick={() => deleteOtherPayable(row.original)}>删除</Button>}
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
    { id: "subject", header: "会计科目", cell: ({ row }) => subjectLabel(row.original.subject, row.original.subjectId) },
    { id: "status", header: "状态", cell: ({ row }) => financeStatus(row.original.status, "reconciliation") },
    ...auditColumns<SupplierReconciliation>(),
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row" data-testid={`reconciliation-actions-${row.original.id}`}>
      {row.original.status === "difference" && <Button size="sm" variant="secondary" onClick={() => resolveReconciliation(row.original)}>处理差异</Button>}
      {row.original.flow?.can_confirm_payables ? <Button size="sm" data-testid={`reconciliation-confirm-${row.original.id}`} onClick={() => confirmReconciliationPayables(row.original)}>确认 {row.original.flow.draft_count} 条应付</Button> : null}
      {["matched", "resolved"].includes(row.original.status) && row.original.flow && row.original.flow.draft_count === 0 ? <span className="panel-note">范围内没有待确认应付</span> : null}
      {/* 删除对账单（用户 2026-09-20）：「已用于确认应付并记账」的那张会被后端拒删并把流水号说出来。 */}
      <Button size="sm" variant="destructive" data-testid={`reconciliation-delete-${row.original.id}`} onClick={() => deleteReconciliation(row.original)}>删除</Button>
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
    // 「待创建对账」是**逐条**列（注释里写明「汇总行看不出这条在不在」），所以按业务列表给两列。
    ...auditColumns<PayableEntry>(),
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">
      <Button size="sm" variant="secondary" title="按这条的供应商 + 月份创建：一张对账单覆盖该供应商该月全部待确认应付" onClick={() => createReconciliation({ supplierId: row.original.supplierId, month: monthOf(row.original.confirmationDate ?? row.original.createdAt) })}>创建对账</Button>
      {/* 用户 2026-09-20：「其他应付的条目支持删除，包括……应付对账」—— 这一页原先只有「创建对账」，
          录错的那条只能跑到「确认应付」页去删。这里给同一个动作同一套边界（后端仍是同一条 DELETE）。 */}
      {row.original.sourceType === "other" && <Button size="sm" variant="destructive" data-testid={`payable-pending-delete-${row.original.id}`} onClick={() => deleteOtherPayable(row.original)}>删除</Button>}
    </div> },
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
        ...auditDetailFields(item),
      ];
    }
    const outsource = item as OutsourcePayableSource;
    return [...common,
      { label: "外加工批次", value: outsource.logisticsBatch?.batchNo },
      { label: "签收单号", value: outsource.outsourceReceipt?.id },
      { label: "签收时间", value: day(outsource.outsourceReceipt?.receivedAt) },
      ...auditDetailFields(item),
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
        { label: "确认日期", value: day(item.confirmationDate) },
        { label: "备注", value: item.remark, wide: true },
        ...auditDetailFields(item),
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
        {/* 删除对「草稿 + 已确认」都开放（与行内按钮同一套边界）：已确认的删的时候会冲回那笔支出。 */}
        {["draft", "confirmed"].includes(item.status) && item.sourceType === "other" && <Button variant="destructive" onClick={() => deleteOtherPayable(item)}>删除（录错了）</Button>}
        {item.status === "confirmed" && <Button variant="secondary" onClick={() => reopenEntry(item)}>回退草稿</Button>}
        {["confirmed", "partially_paid", "paid"].includes(item.status) && <Button variant="destructive" onClick={() => reverseEntry(item)}>冲销应付</Button>}
      </>;
    }
    if (detail?.kind === "reconciliation") {
      const item = detailData as SupplierReconciliation;
      return <>
        {item.status === "difference" && <Button onClick={() => resolveReconciliation(item)}>处理差异</Button>}
        {item.details?.can_confirm_payables ? <Button onClick={() => confirmReconciliationPayables(item)}>确认应付（{item.details.draft_count} 条）</Button> : null}
        <Button variant="destructive" onClick={() => deleteReconciliation(item)}>删除对账单</Button>
      </>;
    }
    return null;
  }

  const detailTitle = detail?.kind === "source" ? "应付来源详情" : detail?.kind === "entry" ? `应付条目 ${(detailData as PayableEntry | null)?.payableNo ?? ""}` : `应付对账 ${(detailData as SupplierReconciliation | null)?.reconciliationNo ?? ""}`;
  /**
   * 当前页签。走 `resolveFinanceTab` 而不是自己 `find`：合并之后**旧的 `confirmed` 必须仍然落在
   * 合并视图上**（收藏过的链接、流转看板、遗留重定向都写着它），而组件里的 `tab` 既可能来自
   * 服务端解析过的 searchParams、也可能是调用方直接传进来的（测试就是），两条路必须得出同一个页签。
   */
  const activeTab = PAYABLE_TABS.find((item) => item.key === resolveFinanceTab(PAYABLE_TABS, PAYABLE_TAB_ALIASES, tab)) ?? PAYABLE_TABS[0];

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
    {/* 付款单编辑器：预填 → 现改（金额 / 增删行 / 付款备注）→ 导出 xlsx。不改系统里的任何数据。
        一次勾选多家供应商时后端会拆成多张，编辑器就是**队列**（见 finance-slip-editor.tsx 顶部）。 */}
    <FinanceSlipEditor
      kind="payment"
      open={slip.open}
      onOpenChange={(open) => setSlip((current) => open ? current : { ...current, open: false, drafts: null, error: "", pendingIds: [] })}
      drafts={slip.drafts}
      loading={slip.loading}
      error={slip.error}
      /* 「一起付款」的另一半：队列里还有没确认的条目 → 关掉队列、按同一批 id 打开确认弹窗。 */
      pendingCount={slip.pendingIds.length}
      onConfirmPending={() => { const ids = slip.pendingIds; setSlip((current) => ({ ...current, open: false })); batchConfirm(ids); }}
    />
    {/* 合并付款：真的建付款单并过账核销（与上面那张**打印件**队列不是一回事）。
        金额、币种、供应商、幂等键、两步请求体都在弹窗里（payable-merge-payment-dialog.tsx），
        页面只负责刷新台账 —— 核销后状态与未核销余额必须立刻能看见。 */}
    <PayableMergePaymentDialog
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
          {/* ③④ 与②现在是**同一个页签**（2026-09-20 合并「应付对账 + 确认应付」）：
              链接地址因此相同，但四步各自说明「卡在哪一步」，不合并成一句。 */}
          <Link href="/finance/payable?tab=reconciliations">去确认 →</Link>
        </li>
      </ol>
    </section>}
    {!error && <section className="panel panel-body">
      {/* 一个搜索框管本页三个页签的全部表格（原料入库 / 外加工签收 / 「应付对账与确认」里的三张表）。
          data-testid 补上：这是财务最常用的控件，而它是本页唯一没有 testid 的筛选器，
          测试只能靠 placeholder 定位 —— 改一次文案就会把用例打散。 */}
      <div className="filter-bar"><label>搜索<Input data-testid="payable-search" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="单号 / 订单号 / 采购单号 / 供应商 / 原料" /></label></div>
    </section>}
    {!error && activeTab.key === "raw-inbound-entries" && <section className="panel">
      <div className="panel-heading"><h2>原料入库条目</h2><span className="panel-note">待接收 {pendingInbound.length} 条 · 已接收 {receivedInboundCount} 条</span></div>
      <div className="panel-body"><DataTable columns={inboundColumns} data={filteredInbound} empty={<EmptyState title="暂无待接收的原料入库来源" />} onRowDoubleClick={(row) => setDetail({ kind: "source", id: row.id, row })} rowTitle="双击查看详情" /></div>
    </section>}
    {!error && activeTab.key === "outsource-entries" && <section className="panel">
      <div className="panel-heading"><h2>外加工签收</h2><span className="panel-note">待接收 {pendingOutsource.length} 条 · 已接收 {receivedOutsourceCount} 条</span></div>
      <div className="panel-body"><DataTable columns={outsourceColumns} data={filteredOutsource} empty={<EmptyState title="暂无待接收的外加工签收来源" />} onRowDoubleClick={(row) => setDetail({ kind: "source", id: row.id, row })} rowTitle="双击查看详情" /></div>
    </section>}
    {/* 2026-09-20（用户要求）：「应付对账」与「确认应付」合并到**一个视图**里，但两个动作仍然分开：
        上面这张面板里先建对账单（待创建对账 → 行内「创建对账」），下面那张面板里再勾选确认/付款。
        合并的只是「不用再切页签」，不是把两步合成一步 —— 对账对不清的金额不该被确认成生效负债。 */}
    {!error && activeTab.key === "reconciliations" && <section className="panel">
      <div className="panel-heading"><h2>应付对账</h2><span className="panel-note">待创建 {pendingEntries.length} 条 · 对账单 {filteredReconciliations.length} 张</span></div>
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
        {/* 包一层带 testid 的容器（与「待创建对账」对称）：合并之后这一页同时有三张表，
            测试与脚本要能按表定位行数/文案，而不是在全页范围内碰运气。 */}
        <div data-testid="payable-reconciliations">
          <DataTable columns={reconciliationColumns} data={filteredReconciliations} empty={<EmptyState title={filter.trim() ? "没有符合搜索条件的应付对账单" : "暂无应付对账单"} />} onRowDoubleClick={(row) => setDetail({ kind: "reconciliation", id: row.id })} rowTitle="双击查看详情" />
        </div>
      </div>
    </section>}
    {!error && activeTab.key === "reconciliations" && <section className="panel">
      <div className="panel-heading"><h2>确认应付</h2><span className="panel-note">共 {ledgerEntries.length} 条（未付 {paymentTally.unpaid} / 已付 {paymentTally.paid}）</span></div>
      <div className="panel-body">
        {/* 付款情况默认「未付」：已经确认过（钱已经出去）的条目不再占着待办清单；需要时切到「已付 / 全部」。 */}
        <div className="filter-bar">
          <label>付款情况
            <Select value={payment} onValueChange={(value) => setPayment(value as LedgerPaymentFilter)}>
              <SelectTrigger data-testid="payable-payment-filter"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="unpaid">未付（{paymentTally.unpaid}）</SelectItem>
                <SelectItem value="paid">已付（{paymentTally.paid}）</SelectItem>
                <SelectItem value="all">全部（{paymentTally.all}）</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label>确认日期从<Input type="date" data-testid="payable-date-from" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label>
          <label>到<Input type="date" data-testid="payable-date-to" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label>
          <Button variant="secondary" data-testid="payable-export" disabled={exporting} onClick={() => void exportLedger()}>{exporting ? "导出中…" : "导出 Excel"}</Button>
        </div>
        <div style={{ marginBottom: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem" }} data-testid="payable-batch-bar">
          <Button size="sm" variant="secondary" onClick={createOtherPayable}>新建其他应付</Button>
          <Button size="sm" variant="secondary" data-testid="payable-other-import" onClick={() => { setImportResult(null); setImportOpen(true); }}>批量导入其他应付</Button>
          <span className="panel-note" data-testid="payable-selected-count">已选 {selected.length} 条（可确认 {selectedDrafts.length} / 可核销 {mergeRows.length}）</span>
          {/* 导出付款单（用户 2026-09-20）：勾选几条 → 一队付款单（按收款单位 + 币种拆张，
              一行一条应付）。走的是预填接口，不改任何数据；金额、分录行、付款备注都在弹窗里现改。
              用户 2026-09-24 的抱怨正是「还是不能实现一起付款……然后还是一个个的改付款单」，
              所以这条按钮现在出的是**一次拿全的队列**，而不是「跨供应商直接报错」。 */}
          <Button size="sm" variant="secondary" data-testid="payable-slip-batch" disabled={!selectedDrafts.length} onClick={() => void openPaymentSlip(selectedDrafts.map((draft) => draft.id))}>集中付款单（{selectedDrafts.length} 条）</Button>
          <Button size="sm" data-testid="payable-batch-confirm" disabled={!selectedDrafts.length} onClick={() => batchConfirm()}>批量确认（{selectedDrafts.length} 条）</Button>
          {/* 合并付款（2026-10-08，用户确认）：与上面两条**不是一回事** —— 它真的建付款单并过账核销，
              动应付状态、未核销余额与银行流水。只对同一供应商 + 同一币种开放（不同供应商/币种的行会被
              上面的勾选框锁掉并写明原因，后端 :96 也会拒）。 */}
          <Button size="sm" data-testid="payable-merge-pay" disabled={!mergeRows.length} onClick={() => setMergeOpen(true)}>合并付款（{mergeRows.length} 条）</Button>
          {mergeRows.length ? <span className="panel-note" data-testid="payable-merge-hint">合并付款：{mergeRows[0].supplierName} / {mergeRows[0].currency}，未核销余额合计 {settleOutstandingTotal(mergeRows)}（同一供应商 + 同一币种才能合并；金额可在弹窗里逐行改小）</span> : null}
          {!mergeRows.length && hiddenSettleable ? <span className="panel-note" data-testid="payable-merge-hidden-hint">另有 {hiddenSettleable} 条已确认未结清的应付被当前「付款情况」筛选藏着：切到「全部」就能勾选合并付款（一次核销同一供应商的多条，可跨订单）</span> : null}
        </div>
        <DataTable columns={entryColumns} data={ledgerEntries} empty={<EmptyState title="没有符合条件的应付条目" />} onRowDoubleClick={(row) => setDetail({ kind: "entry", id: row.id })} rowTitle="双击查看详情" />
      </div>
    </section>}
    {/* 批量导入其他应付：模板 + 上传 + 逐行结果。文案只留数据与去处，不写说明性句子（用户 2026-09-16 第①条）。 */}
    <Dialog open={importOpen} onOpenChange={(open) => { if (!open) setImportOpen(false); }}>
      <DialogContent data-testid="payable-import-dialog">
        <DialogHeader><DialogTitle>批量导入其他应付</DialogTitle></DialogHeader>
        <DialogBody>
          <div className="action-row">
            <Button size="sm" variant="secondary" data-testid="payable-import-template" onClick={() => void downloadOtherImportTemplate()}>下载模板</Button>
            <FileInput accept=".xlsx,.xls" data-testid="payable-import-file" disabled={importing} onChange={(event) => { void importOtherPayables(event.target.files?.[0]); event.currentTarget.value = ""; }} />
          </div>
          {importing && <LoadingState label="正在导入" />}
          {importResult && <div className="panel-body" data-testid="payable-import-result">
            <p>共 {importResult.total} 行：成功 {importResult.successCount} 行 / 错误 {importResult.errorCount} 行</p>
            {importResult.missingColumns.length > 0 && <p className="status-error">缺少必需列：{importResult.missingColumns.join("、")}</p>}
            {importResult.ignoredColumns.length > 0 && <p>以下列不属于其他应付口径，已忽略：{importResult.ignoredColumns.join("、")}</p>}
            {importResult.ignoredTrailingRows > 0 && <p>表尾 {importResult.ignoredTrailingRows} 行未识别为数据，已跳过</p>}
            {importResult.createdSuppliers.length > 0 && <p data-testid="payable-import-suppliers">新增供应商：{importResult.createdSuppliers.map((item) => `${item.name}（${item.supplierCode}，${item.rows} 条）`).join("、")}</p>}
            {importResult.hints.map((hint) => <p key={hint} className="panel-note">{hint}</p>)}
            {importResult.errors.length > 0 && <DataTable columns={[
              { accessorKey: "row", header: "行号" },
              { accessorKey: "field", header: "字段", cell: ({ row }) => row.original.field ?? "-" },
              { accessorKey: "reason", header: "原因" },
            ]} data={importResult.errors} empty={null} />}
            {importResult.imported > 0 && <div className="action-row">
              <Button size="sm" variant="secondary" asChild><Link href="/finance/payable?tab=reconciliations">去应付对账 →</Link></Button>
              <Button size="sm" onClick={() => setImportOpen(false)}>完成</Button>
            </div>}
          </div>}
        </DialogBody>
      </DialogContent>
    </Dialog>
  </div>;
}

"use client";

// 凭证管理（/finance/voucher）。
//
// 数据全部来自**收支流水**（用户口径：「凭证管理从收支流水中 fetch，每条收支条目都可以生成对应的条目」）：
//   1. 收支流水列表：每条流水都能生成一张记账凭证；已有凭证的流水直接显示凭证号与「查看凭证」；
//   2. 记账凭证列表：草稿可编辑/删除/过账，已过账只能红冲（另开一张红字凭证，原凭证标为已红冲）；
//   3. 凭证纸视图：把结构化分录排版成记账凭证，用「打印 / 另存 PDF」出纸质件或 PDF。
//   4. 分录行的「业务科目（辅助）」（2026-11-09 R3-9）：凭证纸（屏幕/打印）在记账科目下面显示
//      `business_subject_label` —— 只在有值且与记账科目**不同**时显示，相同不重复、没有就整行不出现。
//
// 为什么**不返回一张图片**（用户问「做一个图片返回来？」）：
//   凭证是账务事实，必须可查、可核、可追溯、可重打。图片不可搜索、不可复制（财务要复制凭证号、
//   核对金额）、打印会糊，改一个字就得重新生成；服务端渲染图片还要引入 canvas/无头浏览器依赖。
//   正确做法是「结构化分录（本页数据的来源）+ 凭证纸渲染 + 浏览器打印/另存 PDF」，
//   真需要 PNG 时也只是在打印视图上再套一层 canvas 截图，不动数据模型。
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../layout/app-shell";
import { DataTable } from "../data/data-table";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiRequest, apiPost } from "../../lib/api-client";
// 搜索语义全站统一（空格分词的 AND、忽略大小写与空白、空查询不过滤），见 lib/fuzzy-search.ts。
import { fuzzyMatch } from "../../lib/fuzzy-search";
import { ACCOUNTING_SUBJECTS_PATH, type AccountingSubject } from "../../lib/accounting-subjects";
import { downloadFile } from "../../lib/download";
import { exportVoucherPng } from "../../lib/voucher-image";
import { notifyError, notifySuccess } from "../ui/toaster";
import { money } from "./record-detail-dialog";
import { auditColumns, type AuditRow } from "../data/audit-columns";
import VoucherLineEditor from "./voucher-line-editor";

type CashFlowEntry = AuditRow & {
  id: string; entryNo: string; entryDate: string; counterpartyName: string; direction: string;
  amount: string; currency: string; status: string; settlementMethod: string | null; remark: string | null;
  /** 会计科目（分类 = 科目类别，项目 = 科目名称）：凭证的业务分录科目取自它。 */
  subject?: { id: string; category: string; name: string } | null;
  /**
   * 收支类目（业务科目，2026-11-05）：自动写入的流水才有值。
   * 这张表显示的是**财务认的会计科目**（`categorySubject ?? subject`）——与「收支管理 → 收支流水」
   * 同一口径；`subject`（现金分录的对方科目）只在悬停里提示，生成凭证仍用它。
   */
  categorySubject?: { id: string; category: string; name: string } | null;
  settlementAccount?: { id: string; key: string; label: string } | null;
};
type VoucherLine = {
  id: string; lineNo: number; direction: string; subjectKey: string; subjectLabel: string; summary: string; amount: string; currency: string;
  /** 资金类分录引用的具体银行账户（用户要求「银行存款要引用具体的银行账户」）。 */
  bank?: { id: string; bankName: string; accountNumber: string } | null;
  /** 记账科目 id（2026-11-09 R3-1）：历史行 / 找不到唯一同名科目的行为空。 */
  subjectId?: string | null;
  /**
   * 业务科目（辅助核算维度，2026-11-09 R3-1）：单据上写的科目（应付条目科目 / 流水「收支类目」）。
   * 只用于展示与辅助核算，**不决定借贷方向**；`businessSubjectLabel` 是名称快照。
   */
  businessSubjectId?: string | null;
  businessSubjectLabel?: string | null;
};
type Voucher = AuditRow & {
  id: string; voucherNo: string; voucherDate: string; period: string; sourceType: string; sourceId: string;
  summary: string; currency: string; debitTotal: string; creditTotal: string; status: string; status_label?: string;
  remark: string | null; createdBy?: string; lines: VoucherLine[];
  source_entry?: { id: string; entryNo: string; status: string } | null;
  counterpart_voucher?: { id: string; voucherNo: string; status: string } | null;
  reversal_voucher?: { id: string; voucherNo: string; status: string } | null;
};
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> };

/**
 * 「资金搬运凭证纠正」（2026-10-16）。
 *
 * 背景：其他应付的会计科目填的是资金科目（如「资产类 / 库存现金（备用金）」）时，它表达的是
 * 「从银行取现到备用金」而不是负债。旧口径把它走了「确认挂账（贷应付账款）→ 付款（借应付账款）」，
 * 用户点开凭证纸看到的会计科目是「应付账款」，而她要的是「库存现金（备用金）」。
 * 新口径已经不挂账、付款时借方取条目自己的科目，但**已经生成出来的凭证不会自己变** ——
 * 这个按钮按凭证事实逐张纠正：草稿直接改/删；已过账的先红冲（旧内容留痕）再重开成草稿。
 */
type CashTransferRepairTarget = { entry_no: string; cash_flow_entry_id: string; payable_nos: string[]; subject_label: string; voucher_no: string | null; voucher_status: string | null };
type CashTransferRepairPreview = {
  payables: number;
  accruals: number;
  accruals_draft: number;
  accruals_posted: number;
  flows: number;
  flows_without_voucher: number;
  vouchers_draft: number;
  vouchers_posted: number;
  vouchers_reversed: number;
  skipped: Array<{ entry_no: string; reason: string }>;
  targets: CashTransferRepairTarget[];
};
type CashTransferRepairResult = Omit<CashTransferRepairPreview, "targets"> & { rebuilt: number; reopened: number; without_voucher: number };

/**
 * 预览清单的列（用 `DataTable` 而不是手写表：这一页的凭证纸是**打印/导出用**的手写版式件
 * （见 `lib/table-width-coverage.test.mjs` 的豁免说明），弹窗里这张清单该跟全站一样受列宽治理）。
 */
const REPAIR_COLUMNS: ColumnDef<CashTransferRepairTarget>[] = [
  { accessorKey: "entry_no", header: "流水号", meta: { width: "24%" } },
  { id: "payables", header: "应付单", meta: { width: "26%", ellipsis: true }, cell: ({ row }) => row.original.payable_nos.join("、") || "-" },
  { accessorKey: "subject_label", header: "纠正后的借方科目", meta: { width: "26%", ellipsis: true } },
  { id: "voucher", header: "凭证", meta: { width: "24%", ellipsis: true }, cell: ({ row }) => row.original.voucher_no ? `${row.original.voucher_no}（${STATUS_LABELS[row.original.voucher_status ?? ""] ?? row.original.voucher_status}）` : "还没有凭证" },
];

/**
 * 列表的固定列宽（用户 2026-09-20 第 6 条：「记账凭证这个表单，可以固定column宽度，超过的就省略显示，
 * 鼠标hover的时候再展示。保证一次性展示全部column」）。
 *
 * 两份宽度表**只给自己的列**，创建人 / 最后修改人两列（来自 `auditColumns`）刻意不写死：
 * DataTable 在固定布局下会把剩下的百分比均分给没有宽度的列（各约 8%），
 * 于是以后调整 `auditColumns` 也不会连带把这一页的版式撑破。每份都**恰好留 16%** 给那两列。
 */
const VOUCHER_COLUMN_WIDTHS = { no: "9%", date: "6%", period: "5%", summary: "19%", debit: "9%", credit: "9%", status: "5%", source: "12%", actions: "10%" } as const;
const ENTRY_COLUMN_WIDTHS = { date: "6%", no: "9%", subject: "15%", counterparty: "12%", direction: "4%", amount: "9%", settlement: "12%", voucher: "9%", actions: "8%" } as const;

const STATUS_LABELS: Record<string, string> = { draft: "草稿", posted: "已过账", reversed: "已红冲" };
const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const day = (value: string | null | undefined) => (value ? String(value).slice(0, 10) : "-");
const directionText = (direction: string) => (direction === "income" ? "收入" : "支出");

export default function VoucherWorkspace({ testId = "page-finance-voucher" }: { testId?: string }) {
  const [entries, setEntries] = useState<CashFlowEntry[]>([]);
  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [sheet, setSheet] = useState<Voucher | null>(null);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** 记「导出 Excel」自己的忙碌态：与导出 PNG 分开，否则一个在跑时另一个也点不动。 */
  const [exportingXlsx, setExportingXlsx] = useState(false);
  const [filter, setFilter] = useState("");
  const [generated, setGenerated] = useState<"all" | "pending" | "done">("all");
  const [busy, setBusy] = useState("");
  /** 分录编辑器里的那张凭证（草稿）。非 null 即打开编辑器。 */
  const [editing, setEditing] = useState<Voucher | null>(null);
  /** 手工新建凭证（编辑器的新建态：日期/币种自己填，保存走 POST）。 */
  const [creating, setCreating] = useState(false);
  /**
   * 会计科目表（分录编辑器的科目下拉）。
   *
   * 编辑器要能像全站别处一样「从科目表里选科目」（原来是一个手打文本框），所以这一页必须拉科目表。
   * 只取启用的：停用科目不该再被选进新分录；历史凭证上已有的停用科目仍会原样显示在编辑器里
   * （`linesFromVoucher` 对不上表就保留文本）。
   */
  const [subjects, setSubjects] = useState<AccountingSubject[]>([]);
  /**
   * 「资金搬运凭证纠正」弹窗：先取预览（要改几张、删几张、红冲几张），财务看清了再执行。
   * 预览与执行是同一个接口的两条路（GET / POST），所以「看到的」与「改的」不可能对不上。
   */
  const [repair, setRepair] = useState<{ open: boolean; loading: boolean; preview: CashTransferRepairPreview | null; error: string }>({ open: false, loading: false, preview: null, error: "" });
  const [repairing, setRepairing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [flow, voucherRows, subjectRows] = await Promise.all([
        apiGet<CashFlowEntry[]>("/finance/cash-flow-entries"),
        apiGet<Voucher[]>("/finance/vouchers"),
        apiGet<AccountingSubject[]>(ACCOUNTING_SUBJECTS_PATH).catch(() => ({ data: [] as AccountingSubject[], meta: {} })),
      ]);
      setEntries(flow.data); setVouchers(voucherRows.data); setSubjects(subjectRows.data);
    } catch (cause) {
      setError(messageOf(cause, "凭证数据加载失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** 行内动作：失败要把后端原因抛出来（不静默），成功后重拉列表。 */
  async function run(path: string, body: unknown, success: string, method: "post" | "patch" | "delete" = "post") {
    setBusy(path);
    try {
      await apiRequest(path, { method: method.toUpperCase(), body: body === undefined ? undefined : JSON.stringify(body) });
      notifySuccess(success);
      setDialog(null);
      await load();
    } catch (cause) {
      const message = messageOf(cause, "操作失败");
      notifyError(message);
      throw new Error(message);
    } finally {
      setBusy("");
    }
  }

  /** 弹窗提交：抛回 ActionDialog 以保持弹窗打开并显示原因。 */
  const submitDialog = (path: string, body: unknown, success: string, method: "post" | "patch" | "delete" = "post") => run(path, body, success, method);

  const voucherByEntry = useMemo(() => {
    const map = new Map<string, Voucher>();
    for (const voucher of vouchers) if (voucher.sourceType === "cash_flow_entry") map.set(voucher.sourceId, voucher);
    return map;
  }, [vouchers]);

  const visibleEntries = useMemo(() => {
    const text = filter.trim().toLowerCase();
    return entries.filter((entry) => {
      const has = voucherByEntry.has(entry.id);
      if (generated === "pending" && has) return false;
      if (generated === "done" && !has) return false;
      if (!text) return true;
      return fuzzyMatch(filter, [entry.entryNo, entry.counterpartyName, entry.categorySubject?.name, entry.subject?.name, entry.settlementMethod, entry.settlementAccount?.label]);
    });
  }, [entries, filter, generated, voucherByEntry]);

  const periods = useMemo(() => [...new Set(vouchers.map((voucher) => voucher.period))].sort().reverse(), [vouchers]);
  const draftCount = vouchers.filter((voucher) => voucher.status === "draft").length;
  const generatedCount = entries.filter((entry) => voucherByEntry.has(entry.id)).length;

  async function generate(entry: CashFlowEntry) {
    setBusy(entry.id);
    try {
      const result = await apiPost<Voucher & { replayed?: boolean }>(`/finance/vouchers/from-cash-flow/${entry.id}`);
      const data = result.data;
      // R3-7（2026-11-09）：流水/收付款**自动**生成的凭证生成即 posted，所以成功提示不能再无条件写「草稿」——
      // 只有接口真的返回 status=draft（存量草稿口径）才提示人工过账；判断依据是响应字段，不硬编码。
      notifySuccess(data.replayed
        ? `流水 ${entry.entryNo} 已有凭证 ${data.voucherNo}（重复生成不会重复建单）`
        : data.status === "draft"
          ? `已生成凭证 ${data.voucherNo}（草稿，需人工过账）`
          : `已生成并过账：${data.voucherNo}`);
      await load();
      await openSheet(data.id);
    } catch (cause) {
      notifyError(messageOf(cause, "生成凭证失败"));
    } finally {
      setBusy("");
    }
  }

  async function openSheet(id: string) {
    setSheetLoading(true);
    setSheet({ id } as Voucher);
    try {
      const result = await apiGet<Voucher>(`/finance/vouchers/${id}`);
      setSheet(result.data);
    } catch (cause) {
      notifyError(messageOf(cause, "凭证详情加载失败"));
      setSheet(null);
    } finally {
      setSheetLoading(false);
    }
  }

  /**
   * 一键导出 PNG：把当前凭证纸重新组版成 SVG 再交给浏览器栅格化（见 lib/voucher-image.ts）。
   *
   * 环境不支持（canvas 不可用）时不静默失败：直接把可执行的原因 toast 出来，提示改用「打印 / 另存 PDF」。
   */
  async function exportPng(voucher: Voucher) {
    setExporting(true);
    try {
      const fileName = await exportVoucherPng({
        voucherNo: voucher.voucherNo,
        voucherDate: voucher.voucherDate,
        period: voucher.period,
        currency: voucher.currency,
        status: voucher.status,
        statusLabel: voucher.status_label,
        summary: voucher.summary,
        debitTotal: voucher.debitTotal,
        creditTotal: voucher.creditTotal,
        remark: voucher.remark,
        // 制单人取**姓名**（后端响应出口注入的 created_by_name），不是 createdBy 那个 UUID。
        makerName: voucher.created_by_name ?? null,
        sourceLabel: voucher.source_entry
          ? `收支流水 ${voucher.source_entry.entryNo}`
          : voucher.counterpart_voucher ? `红冲 ${voucher.counterpart_voucher.voucherNo}` : null,
        lines: voucher.lines.map((line) => ({ lineNo: line.lineNo, direction: line.direction, subjectLabel: line.subjectLabel, summary: line.summary, amount: line.amount })),
      });
      notifySuccess(`已导出 ${fileName}`);
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : "导出 PNG 失败");
    } finally {
      setExporting(false);
    }
  }

  /**
   * 导出记账凭证 Excel（2026-10-13，用户：「记账凭证中，摘要也要一并导出」）。
   *
   * 一行一条**分录**、带摘要与会计科目（后端 `voucher-workbook.ts` 的列定义）——
   * 摘要与科目都在分录行上，一张凭证一行的话这两列就看不见了。
   * 文件名优先用后端给的（`迪礼ERP-记账凭证-<时间戳>-<行数>行.xlsx`），
   * 兜底名只在该响应头缺失时用得上。
   */
  async function exportXlsx() {
    setExportingXlsx(true);
    try {
      await downloadFile("/api/v1/finance/vouchers/export.xlsx", "迪礼ERP-记账凭证.xlsx");
      notifySuccess(`已导出 ${vouchers.length} 张记账凭证`);
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : "导出失败");
    } finally {
      setExportingXlsx(false);
    }
  }

  /**
   * 打开分录编辑器（草稿专用）。
   *
   * 原来是「ActionDialog + 每行一个文本框科目」：不能增删行、不能改方向、科目只能手打。
   * 财务要的工资计提（一借三贷）与原材料采购（两借一贷）都表达不出来，这就是
   * 「现在自动生成的不能改」的实际含义。现在换成专用的 `VoucherLineEditor`。
   *
   * 编辑器需要完整的分录（含每行引用的银行账户）与科目的「分类/名称」，而列表接口给的
   * `voucherColumns` 行里没有这些 —— 所以先按 id 取一次详情再打开，
   * 这也顺带保证了编辑期间摊销的是**最新**的分录（列表可能是几分钟前拉的）。
   */
  function editVoucher(voucher: Voucher) {
    setBusy(voucher.id);
    apiGet<Voucher>(`/finance/vouchers/${voucher.id}`)
      .then((result) => setEditing(result.data))
      .catch((cause) => notifyError(messageOf(cause, "凭证详情加载失败")))
      .finally(() => setBusy(""));
  }

  function postVoucher(voucher: Voucher) {
    setDialog({
      title: `过账凭证：${voucher.voucherNo}`,
      fields: [{ name: "confirm", label: `借方 ${voucher.debitTotal} / 贷方 ${voucher.creditTotal} ${voucher.currency}`, type: "info" as const }],
      submit: () => submitDialog(`/finance/vouchers/${voucher.id}/post`, undefined, `凭证 ${voucher.voucherNo} 已过账`),
    });
  }

  /**
   * 按来源流水**重新生成**草稿凭证（摘要 / 科目 / 银行账户 / 金额 / 期间全部重算）。
   *
   * 为什么需要：生成是幂等的，之后流水还可能被改（补银行账户、改会计科目、改金额）；
   * 不重新生成，凭证会一直停在旧口径上。**会覆盖手工改过的分录**，所以弹窗里先把这件事说清楚。
   */
  /**
   * 哪些草稿凭证支持「重新生成」：收支流水来源，以及应付挂账来源（2026-11-04 补）。
   *
   * 为什么挂账凭证也要有：财务手改了「借业务科目 / 贷应付账款」之后，原先只能红冲或删草稿，
   * 没有把凭证拉回系统口径的入口 —— 结果就是手改越改越乱（用户报障的就是这一笔）。
   * 应收挂账暂不开：它的对方科目是候选链推的，重算可能把财务当初选的收入科目换掉。
   */
  const canRegenerate = (voucher: Voucher) => ["cash_flow_entry", "supplier_payable"].includes(voucher.sourceType);

  function regenerateVoucher(voucher: Voucher) {
    const fromCashFlow = voucher.sourceType === "cash_flow_entry";
    const label = fromCashFlow
      ? `按收支流水 ${voucher.source_entry?.entryNo ?? ""} 现在的会计科目、银行账户与金额重算整张凭证（手工改过的分录会被覆盖）`
      : "按来源应付单重建挂账凭证：借 业务科目 / 贷 应付账款（手工改过的分录会被覆盖）";
    setDialog({
      title: `重新生成凭证：${voucher.voucherNo}`,
      fields: [{ name: "confirm", label, type: "info" as const }],
      submit: () => submitDialog(`/finance/vouchers/${voucher.id}/regenerate`, undefined, fromCashFlow ? `凭证 ${voucher.voucherNo} 已按收支流水重新生成` : `凭证 ${voucher.voucherNo} 已按来源单据重新生成`),
    });
  }

  function reverseVoucher(voucher: Voucher) {
    setDialog({
      title: `红冲凭证：${voucher.voucherNo}`,
      fields: [{ name: "reason", label: "红冲原因", type: "textarea", required: true }],
      submit: (values) => submitDialog(`/finance/vouchers/${voucher.id}/reverse`, { reason: values.reason }, `凭证 ${voucher.voucherNo} 已红冲（已生成红字凭证）`),
    });
  }

  function deleteVoucher(voucher: Voucher) {
    setDialog({
      title: `删除草稿凭证：${voucher.voucherNo}`,
      fields: [],
      submit: () => submitDialog(`/finance/vouchers/${voucher.id}`, undefined, "草稿凭证已删除", "delete"),
    });
  }

  /**
   * 打开「资金搬运凭证纠正」：先取预览再开弹窗。
   *
   * 失败也照样打开弹窗并把原因写在里面（不静默什么都不发生）——这与付款单预填同一条教训：
   * 点了没反应，用户只会以为按钮坏了。
   */
  async function openRepair() {
    setRepair({ open: true, loading: true, preview: null, error: "" });
    try {
      const result = await apiGet<CashTransferRepairPreview>("/finance/vouchers/cash-transfer-repair");
      setRepair({ open: true, loading: false, preview: result.data, error: "" });
    } catch (cause) {
      setRepair({ open: true, loading: false, preview: null, error: messageOf(cause, "纠正清单加载失败") });
    }
  }

  /** 执行纠正：逐张凭证按新口径重记（后端留审计），完成后重拉列表。 */
  async function applyRepair() {
    setRepairing(true);
    try {
      const result = await apiPost<CashTransferRepairResult>("/finance/vouchers/cash-transfer-repair");
      const data = result.data;
      notifySuccess(`已纠正 ${data.accruals} 张挂账凭证、${data.vouchers_draft + data.vouchers_posted} 张付款凭证（重算 ${data.rebuilt} 张 / 红冲后重开 ${data.reopened} 张）`);
      setRepair({ open: false, loading: false, preview: null, error: "" });
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "纠正失败"));
    } finally {
      setRepairing(false);
    }
  }

  const entryColumns: ColumnDef<CashFlowEntry>[] = [
    { id: "date", header: "日期", meta: { width: ENTRY_COLUMN_WIDTHS.date }, cell: ({ row }) => day(row.original.entryDate) },
    { accessorKey: "entryNo", header: "流水号", meta: { width: ENTRY_COLUMN_WIDTHS.no } },
    { id: "subject", header: "会计科目", meta: { width: ENTRY_COLUMN_WIDTHS.subject, ellipsis: true }, cell: ({ row }) => {
      // 显示业务科目（收支类目优先，手工流水退回主科目）—— 与「收支管理 → 收支流水」同一口径。
      const business = row.original.categorySubject ?? row.original.subject ?? null;
      const contra = row.original.categorySubject && row.original.subject && row.original.categorySubject.id !== row.original.subject.id ? row.original.subject : null;
      return <span title={contra ? `记账对方科目：${contra.category} / ${contra.name}` : undefined}>{business ? `${business.category} / ${business.name}` : "-"}</span>;
    } },
    { accessorKey: "counterpartyName", header: "对方名称", meta: { width: ENTRY_COLUMN_WIDTHS.counterparty, ellipsis: true } },
    { id: "direction", header: "收支", meta: { width: ENTRY_COLUMN_WIDTHS.direction }, cell: ({ row }) => directionText(row.original.direction) },
    { id: "amount", header: "金额", meta: { width: ENTRY_COLUMN_WIDTHS.amount }, cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "settlement", header: "结算方式", meta: { width: ENTRY_COLUMN_WIDTHS.settlement, ellipsis: true }, cell: ({ row }) => [row.original.settlementMethod, row.original.settlementAccount?.label].filter(Boolean).join("--") || "-" },
    { id: "voucher", header: "凭证", meta: { width: ENTRY_COLUMN_WIDTHS.voucher }, cell: ({ row }) => voucherByEntry.get(row.original.id)?.voucherNo ?? "未生成" },
    ...auditColumns<CashFlowEntry>(),
    { id: "actions", header: "操作", meta: { width: ENTRY_COLUMN_WIDTHS.actions }, cell: ({ row }) => {
      const voucher = voucherByEntry.get(row.original.id);
      if (row.original.status !== "posted") return <span className="panel-note">已冲销流水不可生成凭证</span>;
      return <div className="action-row">
        {voucher
          ? <>
            <Button size="sm" variant="ghost" onClick={() => void openSheet(voucher.id)}>查看凭证</Button>
            {/* 流水改了之后要能把凭证拉回同步；已过账的凭证只能红冲，所以只对草稿给这个按钮。 */}
            {voucher.status === "draft" && <Button size="sm" variant="secondary" data-testid={`voucher-regenerate-from-entry-${voucher.id}`} onClick={() => regenerateVoucher(voucher)}>重新生成</Button>}
          </>
          : <Button size="sm" variant="secondary" disabled={busy === row.original.id} onClick={() => void generate(row.original)}>生成凭证</Button>}
      </div>;
    } },
  ];

  const voucherColumns: ColumnDef<Voucher>[] = [
    { accessorKey: "voucherNo", header: "凭证号", meta: { width: VOUCHER_COLUMN_WIDTHS.no } },
    { id: "date", header: "日期", meta: { width: VOUCHER_COLUMN_WIDTHS.date }, cell: ({ row }) => day(row.original.voucherDate) },
    { accessorKey: "period", header: "期间", meta: { width: VOUCHER_COLUMN_WIDTHS.period } },
    { id: "summary", header: "摘要", meta: { width: VOUCHER_COLUMN_WIDTHS.summary, ellipsis: true }, cell: ({ row }) => row.original.summary },
    { id: "debit", header: "借方合计", meta: { width: VOUCHER_COLUMN_WIDTHS.debit }, cell: ({ row }) => money(row.original.debitTotal, row.original.currency) },
    { id: "credit", header: "贷方合计", meta: { width: VOUCHER_COLUMN_WIDTHS.credit }, cell: ({ row }) => money(row.original.creditTotal, row.original.currency) },
    { id: "status", header: "状态", meta: { width: VOUCHER_COLUMN_WIDTHS.status }, cell: ({ row }) => STATUS_LABELS[row.original.status] ?? row.original.status },
    { id: "source", header: "来源", meta: { width: VOUCHER_COLUMN_WIDTHS.source, ellipsis: true }, cell: ({ row }) => row.original.source_entry
      ? `收支流水 ${row.original.source_entry.entryNo}`
      : row.original.counterpart_voucher ? `红冲 ${row.original.counterpart_voucher.voucherNo}` : "-" },
    ...auditColumns<Voucher>(),
    { id: "actions", header: "操作", meta: { width: VOUCHER_COLUMN_WIDTHS.actions }, cell: ({ row }) => <div className="action-row">
      <Button size="sm" variant="ghost" onClick={() => void openSheet(row.original.id)}>凭证纸</Button>
      {row.original.status === "draft" && <>
        <Button size="sm" variant="ghost" data-testid={`voucher-edit-${row.original.id}`} disabled={busy === row.original.id} onClick={() => editVoucher(row.original)}>编辑分录</Button>
        {/* 来源流水/挂账单据改了之后要能把凭证拉回同步；已过账的凭证只能红冲，所以只对草稿给这个按钮。 */}
        {canRegenerate(row.original)
          ? <Button size="sm" variant="ghost" data-testid={`voucher-regenerate-${row.original.id}`} onClick={() => regenerateVoucher(row.original)}>重新生成</Button>
          : null}
        <Button size="sm" variant="secondary" onClick={() => postVoucher(row.original)}>过账</Button>
        <Button size="sm" variant="destructive" onClick={() => deleteVoucher(row.original)}>删除</Button>
      </>}
      {row.original.status === "posted" && <Button size="sm" variant="destructive" onClick={() => reverseVoucher(row.original)}>红冲</Button>}
    </div> },
  ];

  if (loading) return <><PageHeader title="凭证管理" /><LoadingState /></>;

  return <div className="page-root finance-page voucher-page" data-testid={testId}>
    <PageHeader title="凭证管理">
      {/* 手工新增凭证（2026-09-24）：折旧 / 摊销 / 工资计提 / 结转成本这类**非现金分录**没有收支流水可挂，
          所以凭证不能只从流水生成 —— 没有这条路，三大报表的固定资产/累计折旧/应付职工薪酬等行永远填不上。 */}
      <Button data-testid="voucher-create" onClick={() => setCreating(true)}>新建凭证</Button>
      {/* 导出记账凭证（2026-10-13）：一行一条分录、带摘要；与列表同一份数据，
          所以"看到的就是导出的"（后端 export.xlsx 用同一个 DTO 筛）。 */}
      <Button variant="secondary" data-testid="voucher-export" disabled={exportingXlsx || !vouchers.length} onClick={() => void exportXlsx()}>{exportingXlsx ? "导出中…" : "导出 Excel"}</Button>
      {/* 一次性纠正（2026-10-16）：备用金这类其他应付的会计科目是资金科目，旧口径把它们记成了
          应付账款（挂账 + 付款两张凭证）。新口径不再挂账，但旧凭证要有人按事实改一遍 —— 就是它。 */}
      <Button variant="secondary" data-testid="voucher-repair-cash-transfer" disabled={repairing} onClick={() => void openRepair()}>{repairing ? "纠正中…" : "纠正备用金/取现凭证"}</Button>
      <Button asChild variant="secondary"><Link href="/finance">返回财务</Link></Button>
    </PageHeader>
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    {!error && <>
      <section className="panel">
        <div className="panel-heading">
          <h2>收支流水</h2>
          <span className="panel-note">共 {entries.length} 条 / 已生成凭证 {generatedCount} 条</span>
        </div>
        <div className="panel-body">
          <div className="filter-bar">
            <label>搜索<Input data-testid="voucher-entry-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="流水号 / 对方名称 / 会计科目" /></label>
            <label>凭证状态
              <Select value={generated} onValueChange={(value) => setGenerated(value as typeof generated)}>
                <SelectTrigger data-testid="voucher-generated-filter"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部流水</SelectItem>
                  <SelectItem value="pending">未生成凭证</SelectItem>
                  <SelectItem value="done">已生成凭证</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>
          <DataTable columns={entryColumns} data={visibleEntries} empty={<EmptyState title="没有符合条件的收支流水" />} />
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>记账凭证</h2>
          <span className="panel-note">共 {vouchers.length} 张（草稿 {draftCount} 张）{periods.length ? `；期间 ${periods.join(" / ")}` : ""}</span>
        </div>
        <div className="panel-body"><DataTable columns={voucherColumns} data={vouchers} empty={<EmptyState title="还没有凭证：在上面的收支流水行点「生成凭证」" />} /></div>
      </section>
    </>}
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />
    {/* 分录编辑器：草稿专用，独立于通用表单弹窗（详见 voucher-line-editor.tsx 顶部）。
        `creating` 打开的是同一套编辑器的**新建态**（日期/币种在这里填、保存走 POST）。 */}
    <VoucherLineEditor
      open={Boolean(editing) || creating}
      onOpenChange={(open) => { if (!open) { setEditing(null); setCreating(false); } }}
      voucher={editing}
      creating={creating}
      subjects={subjects}
      onSaved={() => void load()}
    />
    <Dialog open={Boolean(sheet)} onOpenChange={(open) => { if (!open) setSheet(null); }}>
      <DialogContent className="voucher-print-dialog" data-testid="voucher-print-dialog">
        <DialogHeader><DialogTitle>记账凭证 {sheet?.voucherNo ?? ""}</DialogTitle></DialogHeader>
        <DialogBody>{sheetLoading || !sheet?.lines ? <LoadingState /> : <VoucherSheet voucher={sheet} />}</DialogBody>
        <DialogFooter>
          <Button variant="secondary" data-testid="voucher-print-close" onClick={() => setSheet(null)}>关闭</Button>
          <Button variant="secondary" data-testid="voucher-png-button" disabled={!sheet?.lines?.length || exporting} onClick={() => { if (sheet?.lines?.length) void exportPng(sheet); }}>{exporting ? "导出中…" : "导出 PNG"}</Button>
          <Button data-testid="voucher-print-button" disabled={!sheet?.lines} onClick={() => window.print()}>打印 / 另存 PDF</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={repair.open} onOpenChange={(open) => { if (!open && !repairing) setRepair({ open: false, loading: false, preview: null, error: "" }); }}>
      <DialogContent data-testid="voucher-repair-dialog">
        <DialogHeader><DialogTitle>纠正备用金（资金搬运）凭证</DialogTitle></DialogHeader>
        <DialogBody>
          {repair.loading ? <LoadingState /> : repair.error ? <ErrorState message={repair.error} onRetry={() => void openRepair()} /> : repair.preview ? <>
            <p className="panel-note" data-testid="voucher-repair-scope">
              要纠正的是「会计科目选了资金科目（如 资产类 / 库存现金（备用金））」的那些应付：它们表达的是
              「从银行取现到备用金」，不是欠谁的钱，所以不该有「贷 应付账款」的凭证；付款凭证按
              「借 库存现金（备用金）/ 贷 银行存款」重记。
            </p>
            {repair.preview.payables === 0
              ? <p data-testid="voucher-repair-empty">没有需要纠正的凭证（没有「会计科目是资金科目」的应付）。</p>
              : <ul className="panel-note" data-testid="voucher-repair-counts">
                <li>涉及应付 {repair.preview.payables} 条</li>
                <li>挂账凭证 {repair.preview.accruals} 张：草稿 {repair.preview.accruals_draft} 张会删除；已过账 {repair.preview.accruals_posted} 张会红冲（红字凭证留痕）</li>
                <li>付款凭证 {repair.preview.vouchers_draft + repair.preview.vouchers_posted + repair.preview.vouchers_reversed} 张：草稿 {repair.preview.vouchers_draft} 张直接按新口径重算；已过账 {repair.preview.vouchers_posted} 张先红冲再重开成草稿；已红冲 {repair.preview.vouchers_reversed} 张按新口径重开</li>
                {repair.preview.flows_without_voucher > 0 ? <li>另有 {repair.preview.flows_without_voucher} 条流水还没有凭证：只改科目，去「收支流水」点「生成凭证」即可生成正确的凭证</li> : null}
                {repair.preview.skipped.length > 0 ? <li className="status-error">有 {repair.preview.skipped.length} 条流水不能自动纠正（核销里混着非资金搬运的应付，一个主科目拆不开两种语义）：{repair.preview.skipped.map((item) => `${item.entry_no}——${item.reason}`).join("；")}</li> : null}
              </ul>}
            {repair.preview.targets.length ? <div data-testid="voucher-repair-targets"><DataTable columns={REPAIR_COLUMNS} data={repair.preview.targets} empty={null} /></div> : null}
          </> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" data-testid="voucher-repair-cancel" disabled={repairing} onClick={() => setRepair({ open: false, loading: false, preview: null, error: "" })}>取消</Button>
          <Button data-testid="voucher-repair-apply" disabled={repairing || !repair.preview || repair.preview.payables === 0} onClick={() => void applyRepair()}>{repairing ? "纠正中…" : "执行纠正"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

/**
 * 分录行上「业务科目（辅助）」的展示值（R3-9）。
 *
 * 只在 `business_subject_label` **有值**、且与**记账科目名**（`subject_label`）**不同**时返回：
 *   - 没有业务科目（历史行、手工凭证）→ null，界面不出现这一行；
 *   - 业务科目与记账科目相同 → null，不重复写两遍（同一件事写两次只会让凭证纸更挤）。
 * 比较用 trim 后的全等：两个 label 都是科目名快照，口径一致才不会把「管理费用」误判成不同。
 */
const businessSubjectText = (line: VoucherLine): string | null => {
  const business = line.businessSubjectLabel?.trim();
  if (!business) return null;
  return business === (line.subjectLabel ?? "").trim() ? null : business;
};

/** 记账凭证纸：屏幕上是一张仿凭证纸，打印时页面上只留它（见 globals.css 的 @media print）。 */
function VoucherSheet({ voucher }: { voucher: Voucher }) {
  return <div className="voucher-sheet" data-testid="voucher-sheet">
    <div className="voucher-sheet-head"><h2>记账凭证</h2><span>{day(voucher.voucherDate)}</span></div>
    <div className="voucher-sheet-meta">
      <span>凭证号：{voucher.voucherNo}</span>
      <span>期间：{voucher.period}</span>
      <span>币种：{voucher.currency}</span>
      <span>状态：{voucher.status_label ?? STATUS_LABELS[voucher.status] ?? voucher.status}</span>
      <span>来源：{voucher.source_entry ? `收支流水 ${voucher.source_entry.entryNo}` : voucher.counterpart_voucher ? `红冲 ${voucher.counterpart_voucher.voucherNo}` : "-"}</span>
    </div>
    <table className="voucher-sheet-table">
      <thead><tr><th>摘要</th><th>会计科目</th><th className="num">借方金额</th><th className="num">贷方金额</th></tr></thead>
      <tbody>
        {voucher.lines.map((line) => {
          const business = businessSubjectText(line);
          return <tr key={line.id ?? line.lineNo} data-testid={`voucher-line-${line.lineNo}`}>
            <td>{line.summary || voucher.summary}</td>
            <td>
              {line.subjectLabel}
              {/* 业务科目（辅助）：只有「有值且与记账科目不同」才出现（R3-9）；换行显示在记账科目下面，不改台账列数/版式。 */}
              {business ? <span style={{ display: "block", fontSize: "0.85em", opacity: 0.8 }} data-testid={`voucher-line-business-${line.lineNo}`}>业务科目（辅助）：{business}</span> : null}
            </td>
            <td className="num">{line.direction === "debit" ? money(line.amount, voucher.currency) : ""}</td>
            <td className="num">{line.direction === "credit" ? money(line.amount, voucher.currency) : ""}</td>
          </tr>;
        })}
        <tr className="voucher-sheet-total"><td colSpan={2}>合计</td><td className="num">{money(voucher.debitTotal, voucher.currency)}</td><td className="num">{money(voucher.creditTotal, voucher.currency)}</td></tr>
      </tbody>
    </table>
    <div className="voucher-sheet-sign"><span>制单：{voucher.created_by_name ?? "—"}</span><span>审核：</span><span>记账：</span><span>单位负责人：</span></div>
    {voucher.remark ? <p className="panel-note">备注：{voucher.remark}</p> : null}
    {voucher.reversal_voucher ? <p className="panel-note">红冲凭证：{voucher.reversal_voucher.voucherNo}（{STATUS_LABELS[voucher.reversal_voucher.status] ?? voucher.reversal_voucher.status}）</p> : null}
  </div>;
}

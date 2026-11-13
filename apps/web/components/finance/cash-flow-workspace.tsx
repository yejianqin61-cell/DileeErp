"use client";

// 收支管理：/finance/cash-flow?tab=<entries | subjects>
//
// 用户 R6 选定「手工录入 + 可配置项目字典」，2026-09-17 又选定
// 「收支项目维护和会计科目要合并成会计科目！合并成一个」：
// 流水上的分类从「收支项目字典项」换成**会计科目**（分类 = 科目类别，项目 = 科目名称，
// 来源 `example/财务/科目表(2).xls`）。原来的「收支项目维护」弹窗随之消失，
// 维护统一在 `?tab=subjects`（accounting-subject-workspace.tsx）。
//
// 收付款单过账与工资支付过账时，自动写入收支流水（sourceType/sourceId 标记来源）。
// 手工录入的条目与自动条目可混合查看。
//
// 结算账户仍复用既有的字典接口（`/dictionaries/settlement_account/items`），不另造一套。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../layout/app-shell";
import { DataTable } from "../data/data-table";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SearchableSelect } from "../ui/searchable-select";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost } from "../../lib/api-client";
import { ACCOUNTING_SUBJECTS_PATH, subjectOptionLabel, type AccountingSubject } from "../../lib/accounting-subjects";
import { fetchCurrencyOptions, type CurrencyOption } from "../../lib/currency-catalogue";
import { CASH_FLOW_TABS, SETTLEMENT_ACCOUNT_DICTIONARY_KEY, type CashFlowTabKey } from "../../lib/finance-sections";
import { PAYMENT_NATURE_EMPTY, paymentNatureLabel, paymentNatureOptions } from "../../lib/payment-natures";
import { notifySuccess } from "../ui/toaster";
import { auditColumns, type AuditRow } from "../data/audit-columns";
import AccountingSubjectWorkspace from "./accounting-subject-workspace";
import { FinanceTabs } from "./finance-tabs";

type DictionaryItem = { id: string; key: string; label: string; isActive: boolean };
/** 银行账户池条目（财务 → 银行账户）。流水的「银行账户」只能从这里选。 */
type BankRef = { id: string; bankCode: string; bankName: string; accountName: string; accountNumber: string; currency: string; isActive: boolean };
/** 流水上关联的银行账户摘要（列表接口给的就是这几个字段）。 */
type BankLink = { id: string; bankCode: string; bankName: string; accountNumber: string; currency: string };
/** 流水上的会计科目摘要（列表接口给的就是这几个字段）。 */
type SubjectLink = { id: string; category: string; name: string; balanceDirection: string | null };
type CashFlowEntry = AuditRow & {
  id: string;
  entryNo: string;
  entryDate: string;
  counterpartyName: string;
  direction: "income" | "expense";
  amount: string;
  currency: string;
  subject: SubjectLink | null;
  /**
   * 收支类目（业务科目）：自动写入的流水（付款/收款/确认应收应付）才有值。
   *
   * 2026-11-05 用户报障：确认应付时选的「管理费用」到收支流水里变成了「应付账款」——
   * 因为列表取的是 `subject`（现金分录的对方科目）。现在列表显示 `categorySubject ?? subject`，
   * 与后端 `cashFlowBusinessSubject` 同一条规则。
   */
  categorySubject?: SubjectLink | null;
  settlementMethod: string | null;
  settlementAccount: { id: string; label: string } | null;
  /** 这笔钱实际落在哪个银行账户上（算余额的那一个）；未指定时为 null。 */
  bank: BankLink | null;
  status: string;
  sourceType: string | null;
  sourceId: string | null;
  /** 款项性质（定金/货款/尾款/其他）；未标注时为 null。 */
  paymentNature: string | null;
  /** 订单号：把收入流水挂到具体订单（外汇一览表按它归集）。 */
  orderNo: string | null;
  remark: string | null;
};

const ALL = "__all";
/**
 * 银行下拉的「清空」哨兵值（与应收/应付同一个做法）。
 *
 * 银行是可选字段，选错了必须能去掉；而 Radix Select 不接受空串 value，
 * 所以用显式哨兵值表示「不指定银行」，提交时再翻译成 null（后端按「清空」处理）。
 */
const BANK_CLEAR = "__no_bank__";
const DIRECTIONS = [
  { value: "income", label: "收入" },
  { value: "expense", label: "支出" },
] as const;

const today = () => new Date().toISOString().slice(0, 10);
const firstDayOfMonth = () => `${new Date().toISOString().slice(0, 7)}-01`;
const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);

/** 金额显示成「收 1,000.00 / 支 2,900.00」这种一眼能认的形式（库里的金额恒为正，方向在另一列）。 */
const amountText = (entry: CashFlowEntry) => `${entry.direction === "income" ? "收" : "支"} ${entry.amount}`;

const SOURCE_LABELS: Record<string, string> = {
  customer_payment: "客户收款",
  supplier_payment: "供应商付款",
  salary_payment: "工资付款",
  // 「确认即记账」以后，钱进来主要靠这两条来源（确认应收 / 对账一键确认）。
  // 不在这里登记的话，来源列会把内部标识原样显示成英文 key，财务根本认不出是什么。
  receivable_source: "确认应收",
  receivable_reconciliation: "应收对账确认",
  supplier_payable_entry: "确认应付",
  supplier_payable_reconciliation: "应付对账确认",
};

/**
 * 收支流水列表的列宽（用户 2026-09-20 第 6 条：「表单可以固定 column 宽度，超过的就省略显示，
 * 鼠标 hover 的时候再展示。保证一次性展示全部 column」）。
 *
 * 2026-10-09 起 `DataTable` 一律给 `<table>` 加 `data-table-fixed`（`table-layout: fixed`）：
 * 没写宽度的列由浏览器**均分**，那对 16 列的收支流水就是「金额列和状态列一样宽」。
 * 这里按每一列实际要放什么重新配平。两种口径同时存在：
 *   - 本表在页面里（`.finance-page`），`app/globals.css` 那三条把它放回**自动布局 + 换行**，
 *     所以下面的百分比是**建议宽度**：金额与客户名换行也要看得全，不会被省略号吃掉；
 *   - 一旦这个列数组被搬进弹窗 / Sheet（走 Portal，够不到 `.finance-page`），这些数字就是**硬约束**，
 *     超长部分靠 DataTable 默认的 `cell-ellipsis` + 原生 `title` 悬停看全文。
 *
 * 数字的来历（1366 屏整表可用宽度约 1376px，1% ≈ 13.8px）：
 *   - 日期 6%：「2026-10-09」定长 10 字符，与凭证表的日期列同一取值。
 *   - 对方名称 8%：客户/供应商全称，是最长的一列之一；口径要求对面名称这类列 ≥8%，
 *     8% 是下限 —— 页面里放不下就换行（财务口径不省略），弹窗里剩下靠 hover。
 *   - 收支 4%：「收入 / 支出」两个字，与凭证表 `direction` 同一取值。
 *   - 金额 9%：金额是这一页存在的理由，口径要求 ≥8%，在预算内再加 1% ——
 *     「2900.0000」这类十位数字在 6% 下会被截掉，金额被截断等于这一页白做。
 *   - 币种 5%：「CNY / USD」三字符，口径 5%~6%。
 *   - 分类 4%：科目类别（资产类 / 损益类，3 个字）这种定长短词，与 QC 送检表同类短列一致。
 *   - 项目 7%、结算方式 7%、银行账户 7%：三列都是拼接出来的长文本
 *     （「资产类 / 库存现金（备用金）」「转账--农业银行5706」「农业银行 / 5706」），
 *     预算只够给到 7%：页面里靠换行显示全，弹窗里靠 hover 看全。
 *   - 款项性质 4%：只有「定金 / 货款 / 尾款 / 其他」四个两字取值，且支出行恒为「-」。
 *   - 订单号 8%：单号类列，口径要求 ≥8%（「DL260002」这种编号截断后认不出是哪一单）。
 *   - 来源 5%：badge 里的「客户收款 / 应收对账确认」（最长 6 个字）。
 *   - 状态 5%：「生效 / 已冲销」两字状态词，口径 5%~6%。
 *   - 操作 5%：两个小按钮（更正 / 冲销）。5% 在 1366 屏约 69px，一行放不下两个，
 *     `.page-actions` 会折行 —— 宁可按钮折行，也不把金额列压窄（QC 送检表同一取舍）。
 *
 * 总和恰好 84%：本表用了 `auditColumns()`，工厂产出的「创建人 / 最后修改人」两列**不给宽度**
 * （`lib/audit-columns-coverage.test.mjs` 盯着这个用法，不要改成逐列加 meta），
 * 剩下的 16% 由它们均分（各 8%）。改数字前先看总和：不等于 84% 时，
 * 缺口会被浏览器摊到那两列以外，长文本列又会重新被挤窄。
 *
 * 这里**不写 `ellipsis: true`**（2026-10-09 起是默认）。也不用 `ellipsis: false`：
 * 它在关掉省略号的同时也关掉了原生 `title`，在固定布局里就变成「硬裁掉且悬停一片空白」——
 * 比省略号更糟；财务「不省略」的口径由 `.finance-page` 那三条 CSS 负责，不靠这一列的一个开关。
 */
const COLUMN_WIDTH = {
  date: "6%",
  counterparty: "8%",
  direction: "4%",
  amount: "9%",
  currency: "5%",
  category: "4%",
  subject: "7%",
  settlement: "7%",
  bank: "7%",
  paymentNature: "4%",
  orderNo: "8%",
  source: "5%",
  status: "5%",
  actions: "5%",
} as const;

export default function CashFlowWorkspace({ tab = "entries", testId = "page-finance-cash-flow" }: { tab?: CashFlowTabKey; testId?: string }) {
  const [from, setFrom] = useState(firstDayOfMonth);
  const [to, setTo] = useState(today);
  const [subjectFilter, setSubjectFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [currencyFilter, setCurrencyFilter] = useState("");
  const [directionFilter, setDirectionFilter] = useState("");
  const [includeReversed, setIncludeReversed] = useState(false);

  const [entries, setEntries] = useState<CashFlowEntry[]>([]);
  const [subjects, setSubjects] = useState<AccountingSubject[]>([]);
  const [accounts, setAccounts] = useState<DictionaryItem[]>([]);
  const [banks, setBanks] = useState<BankRef[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => Promise<void> } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (subjectFilter) params.set("subject_id", subjectFilter);
      if (categoryFilter) params.set("category", categoryFilter);
      if (currencyFilter) params.set("currency", currencyFilter);
      if (directionFilter) params.set("direction", directionFilter);
      if (includeReversed) params.set("include_reversed", "true");
      const [entryResult, subjectResult, accountResult, bankResult] = await Promise.all([
        apiGet<CashFlowEntry[]>(`/finance/cash-flow-entries?${params.toString()}`),
        // 停用科目也要拉：历史流水上可能挂着已停用的科目，报销单/更正时更要能把当前值显示出来。
        apiGet<AccountingSubject[]>(`${ACCOUNTING_SUBJECTS_PATH}?include_inactive=true`),
        apiGet<DictionaryItem[]>(`/dictionaries/${SETTLEMENT_ACCOUNT_DICTIONARY_KEY}/items`),
        // 银行账户池只是「银行账户」下拉的数据源：拉不到（权限差异/未建账户）就留空，
        // 不能因此让整页流水打不开（与应收侧拉银行的 catch 口径一致）。
        apiGet<BankRef[]>("/finance/banks").catch(() => ({ data: [] as BankRef[], meta: {} })),
      ]);
      setEntries(entryResult.data);
      setSubjects(subjectResult.data);
      setAccounts(accountResult.data);
      setBanks(bankResult.data);
    } catch (cause) {
      setError(messageOf(cause, "收支流水加载失败"));
    } finally {
      setLoading(false);
    }
  }, [from, to, subjectFilter, categoryFilter, currencyFilter, directionFilter, includeReversed]);

  // 科目维护子栏目自己拉数据；在流水子栏目上没必要为它多跑两个请求。
  useEffect(() => { if (tab === "entries") void load(); }, [load, tab]);
  useEffect(() => {
    let cancelled = false;
    void fetchCurrencyOptions().then((options) => { if (!cancelled) setCurrencies(options); });
    return () => { cancelled = true; };
  }, []);

  const activeSubjects = useMemo(() => subjects.filter((subject) => subject.isActive), [subjects]);
  /** 分类清单：来自科目表本身（含迁移带出来的「未分类」），不写死 5 类。 */
  const categories = useMemo(() => [...new Set(subjects.map((subject) => subject.category))], [subjects]);
  const subjectOptions = useMemo(() => activeSubjects.map((subject) => ({ value: subject.id, label: subjectOptionLabel(subject) })), [activeSubjects]);
  const subjectById = useMemo(() => new Map(subjects.map((subject) => [subject.id, subject])), [subjects]);
  /**
   * 科目 id → 显示名。列表接口只给 `subject` 内嵌对象，但历史数据/筛选后可能只有 id，
   * 查不到就显示 `-`，不让整页崩。
   */
  const subjectLabel = (subject: SubjectLink | null, id?: string | null) => {
    if (subject) return subjectOptionLabel(subject);
    const fallback = id ? subjectById.get(id) : undefined;
    return fallback ? subjectOptionLabel(fallback) : "-";
  };
  /**
   * 列表上显示的「会计科目」= **业务科目**：有收支类目用类目（确认应付/付款单上财务选的那个），
   * 手工录入的流水没有类目 → 用它自己的科目（录的时候只选了一个科目）。
   *
   * 与后端 `cashFlowBusinessSubject()` 是同一条规则；这里不 import 后端代码（web 不依赖 api 源码），
   * 所以两边用注释互相指认，改一处必须改另一处。
   */
  const businessSubject = (entry: CashFlowEntry): SubjectLink | null => entry.categorySubject ?? entry.subject ?? null;
  // 银行账户只能从银行池里选（停用的不出现）；账户在「财务 → 银行账户」维护。
  const bankOptions = useMemo(() => banks.filter((bank) => bank.isActive).map((bank) => ({ value: bank.id, label: `${bank.bankName} / ${bank.accountNumber}（${bank.currency}）` })), [banks]);
  /** 哨兵值 → 提交值：清空要显式送 null（后端按「清空」处理），未改动则送 undefined。 */
  const bankValue = (value: string | undefined) => (value === BANK_CLEAR ? null : value || undefined);

  function entryFields(entry?: CashFlowEntry): ActionField[] {
    /**
     * 更正时「会计科目」改的是**列表上显示的那一个**（业务科目）：
     *   - 自动写入的流水：改收支类目 `category_subject_id`（主科目/对方科目由系统按销账规则定）；
     *   - 手工录入的流水：改主科目 `subject_id`（它本身就是这笔钱的类目）。
     * 否则财务在弹窗里把「管理费用」改成「销售费」，列表上纹丝不动 —— 那是下一个报障。
     */
    const editsCategory = Boolean(entry?.categorySubject);
    const business = entry ? businessSubject(entry) : null;
    /**
     * 更正一条挂者**已停用科目**的旧流水时，要把那个科目也放进下拉。
     *
     * 下拉平时只列启用科目（停用的不能再选），但表单提交时会把当前值原样带上；当前值不在选项里
     * 就会被后端按「科目不存在或已停用」422 —— 财务只是想改个备注，却撞上一个改不动的弹窗。
     * 所以补一条「（已停用）」选项：不改它就能保存，真去点了别的才换科目。
     */
    const businessOption = business?.id && !activeSubjects.some((subject) => subject.id === business.id)
      ? subjectById.get(business.id)
      : undefined;
    const subjectFieldOptions = businessOption
      ? [{ value: businessOption.id, label: `${subjectOptionLabel(businessOption)}（已停用）` }, ...subjectOptions]
      : subjectOptions;
    return [
      { name: "entry_date", label: "日期", type: "date", required: true, defaultValue: entry ? entry.entryDate.slice(0, 10) : today() },
      { name: "counterparty_name", label: "对方名称", type: "text", required: true, defaultValue: entry?.counterpartyName },
      { name: "direction", label: "收支方向", type: "select", required: true, defaultValue: entry?.direction ?? "expense", options: DIRECTIONS.map((item) => ({ value: item.value, label: item.label })) },
      { name: "amount", label: "金额", type: "number", required: true, defaultValue: entry?.amount, placeholder: "正数" },
      { name: "currency", label: "币种", type: "select", required: true, defaultValue: entry?.currency ?? currencies[0]?.value, options: currencies.map((item) => ({ value: item.value, label: item.label })) },
      // 会计科目：下拉里带上分类前缀（`损益类 / 主营业务收入`），否则同名科目分不清；
      // 并且用带搜索框的 `searchable-select`（用户 2026-09-20 第 1 条）——
      // 科目表 120+ 条，普通下拉只能靠滚动找。
      { name: editsCategory ? "category_subject_id" : "subject_id", label: "会计科目", type: "searchable-select", required: true, defaultValue: business?.id, options: subjectFieldOptions },
      // 自动写入的流水：对方科目是来源单据决定的，弹窗里说清楚它是什么、为什么不能在这里改，
      // 免得财务以为「列表写管理费用、凭证写应付账款」是又一处不一致。
      ...(editsCategory
        ? [{ name: "contra_subject", label: `记账对方科目：${subjectLabel(entry?.subject ?? null, entry?.subject?.id)}（由来源单据决定，生成凭证用它，不在这里改）`, type: "info" as const }]
        : []),
      { name: "settlement_method", label: "结算方式", type: "text", defaultValue: entry?.settlementMethod ?? undefined, placeholder: "如：转账 / 现金" },
      // 两个「账户」不是一回事，别合并：
      //   结算账户 = 老表「结算方式」字典项（给人看的文本，如「农业银行5706」），不参与任何计算；
      //   银行账户 = 银行账户池（算余额的账），指定后这笔收支才会加减该账户的余额。
      { name: "settlement_account_id", label: "结算账户", type: "select", defaultValue: entry?.settlementAccount?.id, options: accounts.map((item) => ({ value: item.id, label: item.label })) },
      { name: "bank_id", label: "银行账户", type: "select", options: [{ value: BANK_CLEAR, label: "（不指定银行）" }, ...bankOptions], defaultValue: entry?.bank?.id ?? BANK_CLEAR },
      // 款项性质与订单号：老表「外汇一览表」要按「定金/货款」分列、按订单收束统计，这两个字段
      // 就是那张表的数据来源。**只有收入方向才有意义**（支出的性质由会计科目表达），
      // 所以标签里写清「收入用」；但字段始终显示 —— `ActionDialog` 的字段表是打开弹窗时算一次的，
      // 按方向条件显示的话，用户在弹窗里把方向从支出改成收入时字段不会冒出来（反而更 confusing）。
      // 定金是**出货前**收到的钱，那时系统里还没有应收来源可挂，所以订单号必须能手填。
      { name: "payment_nature", label: "款项性质（收入用）", type: "select", options: [{ value: PAYMENT_NATURE_EMPTY, label: "（不标注）" }, ...paymentNatureOptions()], defaultValue: entry?.paymentNature ?? PAYMENT_NATURE_EMPTY },
      { name: "order_no", label: "订单号（收入用）", type: "text", defaultValue: entry?.orderNo ?? undefined, placeholder: "如 DL260001；定金这类出货前的收款靠它归集" },
      { name: "remark", label: "备注", type: "textarea", defaultValue: entry?.remark ?? undefined },
    ];
  }

  const bodyOf = (values: Record<string, string>) => {
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) if (value !== "" && value !== undefined) body[key] = value;
    return body;
  };

  /**
   * 款项性质：哨兵值 → 提交值。
   *
   * 选「（不标注）」时送**空串**（而不是不送）：新建时空串只是「没标注」，无副作用；
   * 更正时后端按「空串 = 清空」处理（见 `payment-nature.ts` 的 `PAYMENT_NATURE_FORM_KEYS`），
   * 不送就变成「不改」，财务于是永远抹不掉一个标错的性质。
   */
  const natureValue = (value: string | undefined) => (value === undefined || value === PAYMENT_NATURE_EMPTY ? "" : value);

  function openCreate() {
    setDialog({
      title: "新增收支流水",
      fields: entryFields(),
      submit: async (values) => {
        setBusy(true);
        try {
          await apiPost("/finance/cash-flow-entries", { ...bodyOf(values), bank_id: bankValue(values.bank_id), payment_nature: natureValue(values.payment_nature) });
          notifySuccess("已新增收支流水");
          await load();
        } finally {
          setBusy(false);
        }
      },
    });
  }

  function openEdit(entry: CashFlowEntry) {
    setDialog({
      title: `更正收支流水 ${entry.entryNo}`,
      fields: entryFields(entry),
      submit: async (values) => {
        setBusy(true);
        try {
          // `order_no` 显式送空串：`bodyOf` 会把空串丢掉，那样「订单号填错了要清掉」在 PATCH 里
          // 就变成「不改」，永远清不掉（与款项性质同一个坑，见上面的 natureValue）。
          await apiPatch(`/finance/cash-flow-entries/${entry.id}`, { ...bodyOf(values), bank_id: bankValue(values.bank_id), payment_nature: natureValue(values.payment_nature), order_no: values.order_no ?? "" });
          notifySuccess("已更正收支流水");
          await load();
        } finally {
          setBusy(false);
        }
      },
    });
  }

  function openReverse(entry: CashFlowEntry) {
    setDialog({
      title: `冲销收支流水 ${entry.entryNo}`,
      fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true, placeholder: "例如：对方名称填错，改为重新录入" }],
      submit: async (values) => {
        setBusy(true);
        try {
          await apiPost(`/finance/cash-flow-entries/${entry.id}/reverse`, { reason: values.reason });
          notifySuccess("已冲销；报表不再计入这一条");
          await load();
        } finally {
          setBusy(false);
        }
      },
    });
  }

  const columns: ColumnDef<CashFlowEntry>[] = [
    { accessorKey: "entryDate", header: "日期", meta: { width: COLUMN_WIDTH.date }, cell: ({ row }) => String(row.original.entryDate).slice(0, 10) },
    { accessorKey: "counterpartyName", header: "对方名称", meta: { width: COLUMN_WIDTH.counterparty } },
    { id: "direction", header: "收支", meta: { width: COLUMN_WIDTH.direction }, cell: ({ row }) => (row.original.direction === "income" ? "收入" : "支出") },
    { accessorKey: "amount", header: "金额", meta: { width: COLUMN_WIDTH.amount } },
    { accessorKey: "currency", header: "币种", meta: { width: COLUMN_WIDTH.currency } },
    // 分类 / 项目 = 业务科目（这笔钱算什么），不是现金分录的对方科目 —— 见 `businessSubject`。
    // 对方科目（生成凭证时的另一头）只在自动写入、且与业务科目不同时挂在项目格的 title 上：
    // 它是核对用的细节，不该抢占「这笔钱花在什么上」这一列。
    { id: "category", header: "分类", meta: { width: COLUMN_WIDTH.category }, cell: ({ row }) => businessSubject(row.original)?.category ?? "-" },
    {
      id: "subject",
      header: "项目",
      meta: { width: COLUMN_WIDTH.subject },
      cell: ({ row }) => {
        const business = businessSubject(row.original);
        const contra = row.original.subject && business && row.original.subject.id !== business.id ? row.original.subject : null;
        return <span title={contra ? `记账对方科目：${subjectLabel(contra, contra.id)}` : undefined}>{subjectLabel(business, business?.id)}</span>;
      },
    },
    { id: "settlement", header: "结算方式", meta: { width: COLUMN_WIDTH.settlement }, cell: ({ row }) => [row.original.settlementMethod, row.original.settlementAccount?.label].filter(Boolean).join("--") || "-" },
    { id: "bank", header: "银行账户", meta: { width: COLUMN_WIDTH.bank }, cell: ({ row }) => (row.original.bank ? `${row.original.bank.bankName} / ${row.original.bank.accountNumber}` : "-") },
    // 款项性质与订单号：老表「外汇一览表」按这两列把收款按客户/订单/期间收束起来。
    // 只对收入显示性质 —— 支出行上这一列永远是空的，显示「-」比显示一个没有意义的标签诚实。
    { id: "paymentNature", header: "款项性质", meta: { width: COLUMN_WIDTH.paymentNature }, cell: ({ row }) => (row.original.direction === "income" ? (paymentNatureLabel(row.original.paymentNature) ?? "-") : "-") },
    { id: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.orderNo }, cell: ({ row }) => row.original.orderNo ?? "-" },
    // 这一列渲染的是 badge（JSX）：DataTable 的自动 title 只认字符串/数字，
    // 拿不到元素内容 → 截断了却「悬停一片空白」（`data-table.tsx` 的 `ellipsisTitle` 注释里记着这个坑）。
    // `accessorFn` 把屏幕上那串字作为这一格的值，title 才取得回来；渲染仍走下面的 `cell`（badge 照旧）。
    { id: "source", accessorFn: (entry) => (entry.sourceType ? (SOURCE_LABELS[entry.sourceType] ?? entry.sourceType) : "手工录入"), header: "来源", meta: { width: COLUMN_WIDTH.source }, cell: ({ row }) => row.original.sourceType ? <span className="badge">{SOURCE_LABELS[row.original.sourceType] ?? row.original.sourceType}</span> : <span className="panel-note">手工录入</span> },
    { id: "status", header: "状态", meta: { width: COLUMN_WIDTH.status }, cell: ({ row }) => (row.original.status === "posted" ? "生效" : "已冲销") },
    ...auditColumns<CashFlowEntry>(),
    {
      id: "actions",
      header: "操作",
      meta: { width: COLUMN_WIDTH.actions },
      cell: ({ row }) => <div className="page-actions">
        <Button size="sm" variant="secondary" data-testid={`cash-flow-edit-${row.original.id}`} disabled={busy || row.original.status !== "posted"} onClick={() => openEdit(row.original)}>更正</Button>
        <Button size="sm" variant="ghost" data-testid={`cash-flow-reverse-${row.original.id}`} disabled={busy || row.original.status !== "posted"} onClick={() => openReverse(row.original)}>冲销</Button>
      </div>,
    },
  ];

  const totalIncome = useMemo(() => entries.filter((entry) => entry.direction === "income").length, [entries]);
  const totalExpense = useMemo(() => entries.filter((entry) => entry.direction === "expense").length, [entries]);

  return <div className="page-root finance-page" data-testid={testId}>
    <PageHeader title="收支管理">
      <Button variant="secondary" asChild><a href="/finance">返回财务</a></Button>
      {tab === "entries" && <Button data-testid="cash-flow-create" onClick={openCreate}>新增流水</Button>}
    </PageHeader>

    <FinanceTabs basePath="/finance/cash-flow" tabs={CASH_FLOW_TABS} active={tab} />

    <ActionDialog
      open={Boolean(dialog)}
      onOpenChange={(open) => { if (!open && !busy) setDialog(null); }}
      title={dialog?.title ?? "操作"}
      fields={dialog?.fields ?? []}
      onSubmit={(values) => (dialog ? dialog.submit(values) : undefined)}
    />

    {tab === "subjects"
      ? <AccountingSubjectWorkspace testId="page-finance-accounting-subjects" />
      : <>
        <section className="panel">
          <div className="panel-body filter-bar">
            <label>起始日期<Input data-testid="cash-flow-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
            <label>截止日期<Input data-testid="cash-flow-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
            <label>分类
              {/*
                分类筛选也用带搜索的下拉（2026-11-13，用户：「所有下拉列表、所有表单……都要有搜索功能」）。
                分类是**会计科目分类**，随科目表一起变长；财务筛流水时记得的是分类名，不是它排在第几行。
                与下面「会计科目」那一格同一个原语，语义只此一处。下面的「币种」「收支方向」是 2~5 项固定枚举，保持紧凑。
              */}
              <SearchableSelect
                id="cash-flow-category-filter"
                testId="cash-flow-category-filter"
                value={categoryFilter || ALL}
                options={[{ value: ALL, label: "全部分类" }, ...categories.map((category) => ({ value: category, label: category }))]}
                placeholder="全部分类"
                label="分类"
                searchPlaceholder="搜索分类"
                noResultsText="没有匹配的分类"
                onChange={(value) => setCategoryFilter(value === ALL ? "" : value)}
              />
            </label>
            <label>会计科目
              {/* 筛选器也用带搜索框的下拉：财务要按科目筛流水时，记住的是科目名而不是它排在第几行。 */}
              <SearchableSelect
                id="cash-flow-subject-filter"
                testId="cash-flow-subject-filter"
                value={subjectFilter || ALL}
                options={[{ value: ALL, label: "全部科目" }, ...activeSubjects.map((subject) => ({ value: subject.id, label: subjectOptionLabel(subject) }))]}
                placeholder="全部科目"
                label="会计科目"
                onChange={(value) => setSubjectFilter(value === ALL ? "" : value)}
              />
            </label>
            <label>币种
              <Select value={currencyFilter || ALL} onValueChange={(value) => setCurrencyFilter(value === ALL ? "" : value)}>
                <SelectTrigger data-testid="cash-flow-currency-filter"><SelectValue placeholder="全部币种" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>全部币种</SelectItem>
                  {currencies.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label>收支方向
              <Select value={directionFilter || ALL} onValueChange={(value) => setDirectionFilter(value === ALL ? "" : value)}>
                <SelectTrigger data-testid="cash-flow-direction-filter"><SelectValue placeholder="收入与支出" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>收入与支出</SelectItem>
                  {DIRECTIONS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label>已冲销
              <Select value={includeReversed ? "true" : "false"} onValueChange={(value) => setIncludeReversed(value === "true")}>
                <SelectTrigger data-testid="cash-flow-include-reversed"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="false">不看</SelectItem>
                  <SelectItem value="true">一起看</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <Button variant="secondary" data-testid="cash-flow-refresh" onClick={() => void load()}>刷新</Button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <h2>收支流水</h2>
            <span className="panel-note" data-testid="cash-flow-count">共 {entries.length} 条（收入 {totalIncome} / 支出 {totalExpense}）</span>
          </div>
          {error && <div className="panel-body"><ErrorState message={error} onRetry={() => void load()} /></div>}
          {!error && loading && <LoadingState />}
          {!error && !loading && <>
            <div className="panel-body">
              <DataTable columns={columns} data={entries} empty={<EmptyState title="本期没有收支流水" />} />
            </div>
          </>}
        </section>
      </>}
  </div>;
}

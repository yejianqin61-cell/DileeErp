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
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost } from "../../lib/api-client";
import { ACCOUNTING_SUBJECTS_PATH, subjectOptionLabel, type AccountingSubject } from "../../lib/accounting-subjects";
import { fetchCurrencyOptions, type CurrencyOption } from "../../lib/currency-catalogue";
import { CASH_FLOW_TABS, SETTLEMENT_ACCOUNT_DICTIONARY_KEY, type CashFlowTabKey } from "../../lib/finance-sections";
import { PAYMENT_NATURE_EMPTY, paymentNatureLabel, paymentNatureOptions } from "../../lib/payment-natures";
import { notifySuccess } from "../ui/toaster";
import AccountingSubjectWorkspace from "./accounting-subject-workspace";
import { FinanceTabs } from "./finance-tabs";

type DictionaryItem = { id: string; key: string; label: string; isActive: boolean };
/** 银行账户池条目（财务 → 银行账户）。流水的「银行账户」只能从这里选。 */
type BankRef = { id: string; bankCode: string; bankName: string; accountName: string; accountNumber: string; currency: string; isActive: boolean };
/** 流水上关联的银行账户摘要（列表接口给的就是这几个字段）。 */
type BankLink = { id: string; bankCode: string; bankName: string; accountNumber: string; currency: string };
/** 流水上的会计科目摘要（列表接口给的就是这几个字段）。 */
type SubjectLink = { id: string; category: string; name: string; balanceDirection: string | null };
type CashFlowEntry = {
  id: string;
  entryNo: string;
  entryDate: string;
  counterpartyName: string;
  direction: "income" | "expense";
  amount: string;
  currency: string;
  subject: SubjectLink | null;
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
  // 银行账户只能从银行池里选（停用的不出现）；账户在「财务 → 银行账户」维护。
  const bankOptions = useMemo(() => banks.filter((bank) => bank.isActive).map((bank) => ({ value: bank.id, label: `${bank.bankName} / ${bank.accountNumber}（${bank.currency}）` })), [banks]);
  /** 哨兵值 → 提交值：清空要显式送 null（后端按「清空」处理），未改动则送 undefined。 */
  const bankValue = (value: string | undefined) => (value === BANK_CLEAR ? null : value || undefined);

  function entryFields(entry?: CashFlowEntry): ActionField[] {
    return [
      { name: "entry_date", label: "日期", type: "date", required: true, defaultValue: entry ? entry.entryDate.slice(0, 10) : today() },
      { name: "counterparty_name", label: "对方名称", type: "text", required: true, defaultValue: entry?.counterpartyName },
      { name: "direction", label: "收支方向", type: "select", required: true, defaultValue: entry?.direction ?? "expense", options: DIRECTIONS.map((item) => ({ value: item.value, label: item.label })) },
      { name: "amount", label: "金额", type: "number", required: true, defaultValue: entry?.amount, placeholder: "正数" },
      { name: "currency", label: "币种", type: "select", required: true, defaultValue: entry?.currency ?? currencies[0]?.value, options: currencies.map((item) => ({ value: item.value, label: item.label })) },
      // 会计科目：下拉里带上分类前缀（`损益类 / 主营业务收入`），否则同名科目分不清。
      { name: "subject_id", label: "会计科目", type: "select", required: true, defaultValue: entry?.subject?.id, options: subjectOptions },
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
    { accessorKey: "entryDate", header: "日期", cell: ({ row }) => String(row.original.entryDate).slice(0, 10) },
    { accessorKey: "counterpartyName", header: "对方名称" },
    { id: "direction", header: "收支", cell: ({ row }) => (row.original.direction === "income" ? "收入" : "支出") },
    { accessorKey: "amount", header: "金额" },
    { accessorKey: "currency", header: "币种" },
    { id: "category", header: "分类", cell: ({ row }) => row.original.subject?.category ?? "-" },
    { id: "subject", header: "项目", cell: ({ row }) => subjectLabel(row.original.subject, row.original.subject?.id) },
    { id: "settlement", header: "结算方式", cell: ({ row }) => [row.original.settlementMethod, row.original.settlementAccount?.label].filter(Boolean).join("--") || "-" },
    { id: "bank", header: "银行账户", cell: ({ row }) => (row.original.bank ? `${row.original.bank.bankName} / ${row.original.bank.accountNumber}` : "-") },
    // 款项性质与订单号：老表「外汇一览表」按这两列把收款按客户/订单/期间收束起来。
    // 只对收入显示性质 —— 支出行上这一列永远是空的，显示「-」比显示一个没有意义的标签诚实。
    { id: "paymentNature", header: "款项性质", cell: ({ row }) => (row.original.direction === "income" ? (paymentNatureLabel(row.original.paymentNature) ?? "-") : "-") },
    { id: "orderNo", header: "订单号", cell: ({ row }) => row.original.orderNo ?? "-" },
    { id: "source", header: "来源", cell: ({ row }) => row.original.sourceType ? <span className="badge">{SOURCE_LABELS[row.original.sourceType] ?? row.original.sourceType}</span> : <span className="panel-note">手工录入</span> },
    { id: "status", header: "状态", cell: ({ row }) => (row.original.status === "posted" ? "生效" : "已冲销") },
    {
      id: "actions",
      header: "操作",
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
              <Select value={categoryFilter || ALL} onValueChange={(value) => setCategoryFilter(value === ALL ? "" : value)}>
                <SelectTrigger data-testid="cash-flow-category-filter"><SelectValue placeholder="全部分类" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>全部分类</SelectItem>
                  {categories.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label>会计科目
              <Select value={subjectFilter || ALL} onValueChange={(value) => setSubjectFilter(value === ALL ? "" : value)}>
                <SelectTrigger data-testid="cash-flow-subject-filter"><SelectValue placeholder="全部科目" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>全部科目</SelectItem>
                  {activeSubjects.map((subject) => <SelectItem key={subject.id} value={subject.id}>{subjectOptionLabel(subject)}</SelectItem>)}
                </SelectContent>
              </Select>
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

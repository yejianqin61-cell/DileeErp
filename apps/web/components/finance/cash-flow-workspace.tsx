"use client";

// 收支管理：/finance/cash-flow
//
// 用户 R6 选定「手工录入 + 可配置项目字典」。
// 收付款单过账与工资支付过账时，自动写入收支流水（sourceType/sourceId 标记来源）。
// 手工录入的条目与自动条目可混合查看。
//
// 收支项目 / 结算账户直接复用既有的字典接口（`/dictionaries/<key>/items`），
// 不另造一套平行接口；写操作仅管理员，非管理员会收到后端 403 提示。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../layout/app-shell";
import { DataTable } from "../data/data-table";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../lib/api-client";
import { fetchCurrencyOptions, type CurrencyOption } from "../../lib/currency-catalogue";
import { CASH_FLOW_ITEM_DICTIONARY_KEY, SETTLEMENT_ACCOUNT_DICTIONARY_KEY } from "../../lib/finance-sections";
import { notifyError, notifySuccess } from "../ui/toaster";

type DictionaryItem = { id: string; key: string; label: string; isActive: boolean };
type CashFlowEntry = {
  id: string;
  entryNo: string;
  entryDate: string;
  counterpartyName: string;
  direction: "income" | "expense";
  amount: string;
  currency: string;
  item: { id: string; label: string } | null;
  settlementMethod: string | null;
  settlementAccount: { id: string; label: string } | null;
  status: string;
  sourceType: string | null;
  sourceId: string | null;
  remark: string | null;
};

const ALL = "__all";
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
};

export default function CashFlowWorkspace({ testId = "page-finance-cash-flow" }: { testId?: string }) {
  const [from, setFrom] = useState(firstDayOfMonth);
  const [to, setTo] = useState(today);
  const [itemFilter, setItemFilter] = useState("");
  const [currencyFilter, setCurrencyFilter] = useState("");
  const [directionFilter, setDirectionFilter] = useState("");
  const [includeReversed, setIncludeReversed] = useState(false);

  const [entries, setEntries] = useState<CashFlowEntry[]>([]);
  const [items, setItems] = useState<DictionaryItem[]>([]);
  const [accounts, setAccounts] = useState<DictionaryItem[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => Promise<void> } | null>(null);
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const [newItemLabel, setNewItemLabel] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (itemFilter) params.set("item_id", itemFilter);
      if (currencyFilter) params.set("currency", currencyFilter);
      if (directionFilter) params.set("direction", directionFilter);
      if (includeReversed) params.set("include_reversed", "true");
      const [entryResult, itemResult, accountResult] = await Promise.all([
        apiGet<CashFlowEntry[]>(`/finance/cash-flow-entries?${params.toString()}`),
        apiGet<DictionaryItem[]>(`/dictionaries/${CASH_FLOW_ITEM_DICTIONARY_KEY}/items?include_inactive=true`),
        apiGet<DictionaryItem[]>(`/dictionaries/${SETTLEMENT_ACCOUNT_DICTIONARY_KEY}/items`),
      ]);
      setEntries(entryResult.data);
      setItems(itemResult.data);
      setAccounts(accountResult.data);
    } catch (cause) {
      setError(messageOf(cause, "收支流水加载失败"));
    } finally {
      setLoading(false);
    }
  }, [from, to, itemFilter, currencyFilter, directionFilter, includeReversed]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let cancelled = false;
    void fetchCurrencyOptions().then((options) => { if (!cancelled) setCurrencies(options); });
    return () => { cancelled = true; };
  }, []);

  const activeItems = useMemo(() => items.filter((item) => item.isActive), [items]);

  function entryFields(entry?: CashFlowEntry): ActionField[] {
    return [
      { name: "entry_date", label: "日期", type: "date", required: true, defaultValue: entry ? entry.entryDate.slice(0, 10) : today() },
      { name: "counterparty_name", label: "对方名称", type: "text", required: true, defaultValue: entry?.counterpartyName },
      { name: "direction", label: "收支方向", type: "select", required: true, defaultValue: entry?.direction ?? "expense", options: DIRECTIONS.map((item) => ({ value: item.value, label: item.label })) },
      { name: "amount", label: "金额", type: "number", required: true, defaultValue: entry?.amount, placeholder: "正数；方向由上一条决定" },
      { name: "currency", label: "币种", type: "select", required: true, defaultValue: entry?.currency ?? currencies[0]?.value, options: currencies.map((item) => ({ value: item.value, label: item.label })) },
      { name: "item_id", label: "收支项目", type: "select", required: true, defaultValue: entry?.item?.id, options: activeItems.map((item) => ({ value: item.id, label: item.label })) },
      { name: "settlement_method", label: "结算方式", type: "text", defaultValue: entry?.settlementMethod ?? undefined, placeholder: "如：转账 / 现金" },
      { name: "settlement_account_id", label: "结算账户", type: "select", defaultValue: entry?.settlementAccount?.id, options: accounts.map((item) => ({ value: item.id, label: item.label })) },
      { name: "remark", label: "备注", type: "textarea", defaultValue: entry?.remark ?? undefined },
    ];
  }

  const bodyOf = (values: Record<string, string>) => {
    const body: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) if (value !== "" && value !== undefined) body[key] = value;
    return body;
  };

  function openCreate() {
    setDialog({
      title: "新增收支流水",
      fields: entryFields(),
      submit: async (values) => {
        setBusy(true);
        try {
          await apiPost("/finance/cash-flow-entries", bodyOf(values));
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
          await apiPatch(`/finance/cash-flow-entries/${entry.id}`, bodyOf(values));
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

  async function addItem() {
    const label = newItemLabel.trim();
    if (!label) {
      notifyError("请填写项目名称");
      return;
    }
    setBusy(true);
    try {
      await apiPost(`/dictionaries/${CASH_FLOW_ITEM_DICTIONARY_KEY}/items`, { key: label, label, sort_order: (items.length + 1) * 10 });
      notifySuccess(`已新增收支项目「${label}」`);
      setNewItemLabel("");
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "新增项目失败（写字典仅管理员可用）"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleItem(item: DictionaryItem) {
    setBusy(true);
    try {
      await apiPatch(`/dictionaries/items/${item.id}`, { is_active: !item.isActive });
      notifySuccess(item.isActive ? `已停用「${item.label}」` : `已启用「${item.label}」`);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "操作失败（写字典仅管理员可用）"));
    } finally {
      setBusy(false);
    }
  }

  const columns: ColumnDef<CashFlowEntry>[] = [
    { accessorKey: "entryDate", header: "日期", cell: ({ row }) => String(row.original.entryDate).slice(0, 10) },
    { accessorKey: "counterpartyName", header: "对方名称" },
    { id: "direction", header: "收支", cell: ({ row }) => (row.original.direction === "income" ? "收入" : "支出") },
    { accessorKey: "amount", header: "金额" },
    { accessorKey: "currency", header: "币种" },
    { id: "item", header: "收支项目", cell: ({ row }) => row.original.item?.label ?? "-" },
    { id: "settlement", header: "结算方式", cell: ({ row }) => [row.original.settlementMethod, row.original.settlementAccount?.label].filter(Boolean).join("--") || "-" },
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

  const itemColumns: ColumnDef<DictionaryItem>[] = [
    { accessorKey: "label", header: "项目" },
    { id: "state", header: "状态", cell: ({ row }) => (row.original.isActive ? "启用" : "已停用") },
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) => <Button size="sm" variant="secondary" data-testid={`cash-flow-item-toggle-${row.original.id}`} disabled={busy} onClick={() => void toggleItem(row.original)}>{row.original.isActive ? "停用" : "启用"}</Button>,
    },
  ];

  const totalIncome = useMemo(() => entries.filter((entry) => entry.direction === "income").length, [entries]);
  const totalExpense = useMemo(() => entries.filter((entry) => entry.direction === "expense").length, [entries]);

  return <div className="page-root" data-testid={testId}>
    <PageHeader title="收支管理" description="手工录入资金收支流水；收支项目与结算账户是可配置字典。收付款与工资过账后自动生成流水。">
      <Button variant="secondary" asChild><a href="/finance">返回财务</a></Button>
      <Button variant="secondary" data-testid="cash-flow-open-dictionary" onClick={() => setDictionaryOpen(true)}>收支项目维护</Button>
      <Button data-testid="cash-flow-create" onClick={openCreate}>新增流水</Button>
    </PageHeader>

    <ActionDialog
      open={Boolean(dialog)}
      onOpenChange={(open) => { if (!open && !busy) setDialog(null); }}
      title={dialog?.title ?? "操作"}
      fields={dialog?.fields ?? []}
      onSubmit={(values) => (dialog ? dialog.submit(values) : undefined)}
    />

    <Dialog open={dictionaryOpen} onOpenChange={setDictionaryOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>收支项目维护</DialogTitle>
          <DialogDescription>项目清单就是老表的 37 个类目；改名或停用后，收支汇总表会跟着变。写操作仅管理员可用。</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="filter-bar">
            <label>新增项目<Input data-testid="cash-flow-item-new" value={newItemLabel} onChange={(event) => setNewItemLabel(event.target.value)} placeholder="例如：展会物料费" /></label>
            <Button data-testid="cash-flow-item-add" disabled={busy} onClick={() => void addItem()}>新增</Button>
          </div>
          <DataTable columns={itemColumns} data={items} empty={<EmptyState title="暂无收支项目" description="迁移或 seed 会写入老表的 37 个项目。" />} />
        </DialogBody>
        <DialogFooter><Button variant="secondary" onClick={() => setDictionaryOpen(false)}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <section className="panel">
      <div className="panel-body filter-bar">
        <label>起始日期<Input data-testid="cash-flow-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>截止日期<Input data-testid="cash-flow-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <label>收支项目
          <Select value={itemFilter || ALL} onValueChange={(value) => setItemFilter(value === ALL ? "" : value)}>
            <SelectTrigger data-testid="cash-flow-item-filter"><SelectValue placeholder="全部项目" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部项目</SelectItem>
              {activeItems.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}
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
        <p className="panel-note panel-body">
          金额一律填正数，收/支由「收支方向」决定；来源列「手工录入」为手动新增，「客户收款 / 供应商付款 / 工资付款」为过账自动生成。
        </p>
        <div className="panel-body">
          <DataTable columns={columns} data={entries} empty={<EmptyState title="本期没有收支流水" description="点右上角「新增流水」手工录入；收付款过账后自动生成。" />} />
        </div>
      </>}
    </section>
  </div>;
}
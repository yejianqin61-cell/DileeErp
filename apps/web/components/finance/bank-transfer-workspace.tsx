"use client";

// 银行余额互转（/finance/bank-transfers）：同一个银行池里两个账户之间的划转。
//
// 为什么不复用收支流水记两笔：互转既不是收入也不是支出。记成「A 支出 + B 收入」会让收支汇总表
// 凭空多出一笔收入与一笔支出（报表口径直接失真）。它只动账户余额，因此单独一张单据，
// 只以「转入 / 转出」参与 `GET /finance/banks/balances` 的余额计算。
//
// 表单字段就是用户点名的四项（本方账户 / 本方币种 / 对方账户 / 对方币种）+ 金额 + 日期 + 备注：
//   - ActionDialog 的字段之间**不能联动**（它只做受控值收集，没有字段依赖机制），所以两个币种下拉
//     只能各给一个「合理默认」并允许改；提交时再按所选账户的币种校验，选错就地在弹窗里说清楚，
//     不让后端 422 TRANSFER_CURRENCY_MISMATCH 变成一句看不懂的报错。
//   - 同币种不送对方金额（后端按本方金额入账）；跨币种必须送实际到账数 —— 见提交处的校验。
//   - 余额不足**不拦截**（期初可能还没录、银行到账有时间差），但必须提示：转出方会变成负数。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../layout/app-shell";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { DataTable } from "../data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPost } from "../../lib/api-client";
import { currencyOptions, fetchCurrencyOptions, type CurrencyOption } from "../../lib/currency-catalogue";
import { notifyError, notifySuccess } from "../ui/toaster";
import { auditColumns, type AuditRow } from "../data/audit-columns";

/** 银行账户池条目（财务 → 银行账户）。互转的两端都只能从这里选，不在这里手输账户。 */
type BankRef = { id: string; bankCode: string; bankName: string; accountName: string; accountNumber: string; currency: string; isActive: boolean; openingBalance: string };
/** `GET /finance/banks/balances` 的一行：金额都是 4 位小数字符串。 */
type BankBalance = {
  id: string; bank_code: string; bank_name: string; account_name: string; account_number: string; currency: string;
  is_active: boolean; opening_balance: string; cash_in: string; cash_out: string; transfer_in: string;
  transfer_out: string; balance: string; cash_flow_count: number;
};
/** 互转单上的账户摘要（后端 include 给的就是这几个字段）。 */
type BankLink = { id: string; bankCode: string; bankName: string; accountNumber: string; currency: string };
type BankTransfer = AuditRow & {
  id: string; transferNo: string; transferDate: string; fromBankId: string; fromCurrency: string;
  toBankId: string; toCurrency: string; fromAmount: string; toAmount: string; exchangeRate: string;
  status: "posted" | "reversed"; reversalReason: string | null; remark: string | null; createdAt: string;
  fromBank: BankLink | null; toBank: BankLink | null;
};
/** 建单响应：余额提示由后端算（它才知道转账前的余额），前端只负责显示。 */
type CreateResult = {
  transfer: BankTransfer; source_balance_before: string | null; source_balance_after: string | null;
  insufficient_balance: boolean;
};
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => Promise<void> | void };

const ALL = "__all";
const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);
const today = () => new Date().toISOString().slice(0, 10);
/** 账户在列表里的显示口径：开户行 + 账号（账户名放不下时至少能靠账号认人）。 */
const accountText = (bank: BankLink | null | undefined) => (bank ? `${bank.bankName} / ${bank.accountNumber}` : "-");

export default function BankTransferWorkspace({ testId = "page-finance-bank-transfers" }: { testId?: string }) {
  const [banks, setBanks] = useState<BankRef[]>([]);
  const [balances, setBalances] = useState<Record<string, BankBalance>>({});
  const [transfers, setTransfers] = useState<BankTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [currencyCatalogue, setCurrencyCatalogue] = useState<CurrencyOption[]>([]);
  // 期间默认留空 = 看全部：互转是低频单据，新建完立刻被默认期间藏起来才是真的难用。
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const [bankFilter, setBankFilter] = useState("");

  useEffect(() => { let cancelled = false; void fetchCurrencyOptions().then((options) => { if (!cancelled) setCurrencyCatalogue(options); }); return () => { cancelled = true; }; }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (fromFilter) params.set("from", fromFilter);
      if (toFilter) params.set("to", toFilter);
      if (bankFilter) params.set("bank_id", bankFilter);
      const query = params.toString();
      // 余额接口失败只让「本方账户余额」这张表空掉，互转单据与账户下拉照常显示
      // （与银行账户页同一个口径：余额是附加值，不该拖垮主数据）。
      const [bankResult, balanceResult, transferResult] = await Promise.all([
        apiGet<BankRef[]>("/finance/banks"),
        apiGet<BankBalance[]>("/finance/banks/balances").catch(() => ({ data: [] as BankBalance[], meta: {} })),
        apiGet<BankTransfer[]>(`/finance/bank-transfers${query ? `?${query}` : ""}`),
      ]);
      setBanks(bankResult.data);
      setBalances(Object.fromEntries(balanceResult.data.map((row) => [row.id, row])));
      setTransfers(transferResult.data);
    } catch (cause) {
      setError(messageOf(cause, "银行互转数据加载失败"));
    } finally {
      setLoading(false);
    }
  }, [fromFilter, toFilter, bankFilter]);

  useEffect(() => { void load(); }, [load]);

  /** 停用的账户不能互转（后端 requireActiveBank 会 404），所以两个下拉都只给启用账户。 */
  const activeBanks = useMemo(() => banks.filter((bank) => bank.isActive), [banks]);
  const bankOptions = useMemo(() => activeBanks.map((bank) => ({ value: bank.id, label: `${bank.bankName} / ${bank.accountNumber}（${bank.currency}）` })), [activeBanks]);

  /**
   * 币种下拉：字典币种 + 启用账户实际持有的币种。
   *
   * 补后者的原因：字典里删过/停用过的币种，账户上仍然可能是它；下拉里没有这个值，
   * 用户就只能眼睁睁看着「币种与账户不一致」的错误却无法选对。
   */
  const currencySelectOptions = useMemo(() => {
    const options = currencyOptions(currencyCatalogue);
    const seen = new Set(options.map((option) => option.value));
    const extra = activeBanks.filter((bank) => !seen.has(bank.currency)).map((bank) => ({ value: bank.currency, label: bank.currency }));
    return [...options, ...extra];
  }, [currencyCatalogue, activeBanks]);

  async function createTransfer(values: Record<string, string>) {
    const fromAccount = banks.find((bank) => bank.id === values.from_bank_id);
    const toAccount = banks.find((bank) => bank.id === values.to_bank_id);
    const sameCurrency = values.from_currency === values.to_currency;
    // 「自己转给自己」在客户端先拦：后端也会拒（TRANSFER_SAME_BANK），但没必要先发一次注定失败的请求。
    if (values.from_bank_id === values.to_bank_id) throw new Error("本方账户与对方账户不能是同一个账户");
    // 账户只对应一个币种，允许改币种会让余额变成一笔算不清的混币账（后端同样会 422）。
    if (fromAccount && values.from_currency !== fromAccount.currency) throw new Error(`本方币种必须是${fromAccount.bankName}的账户币种 ${fromAccount.currency}`);
    if (toAccount && values.to_currency !== toAccount.currency) throw new Error(`对方币种必须是${toAccount.bankName}的账户币种 ${toAccount.currency}`);
    if (!(Number(values.from_amount) > 0)) throw new Error("互转金额必须是大于零的十进制数");
    if (sameCurrency) {
      // 同币种两边金额必然相等，否则这笔差额没有科目可以承载（后端 422 SAME_CURRENCY_AMOUNT_MISMATCH）。
      if (values.to_amount.trim() && Number(values.to_amount) !== Number(values.from_amount)) throw new Error("两种币种相同时，本方金额与对方金额必须相等");
    } else if (!values.to_amount.trim()) {
      throw new Error("请填写对方金额（两种币种不同时必须给出实际到账数）");
    }
    setBusy(true);
    try {
      const result = await apiPost<CreateResult>("/finance/bank-transfers", {
        transfer_date: values.transfer_date,
        from_bank_id: values.from_bank_id,
        from_currency: values.from_currency,
        to_bank_id: values.to_bank_id,
        to_currency: values.to_currency,
        from_amount: values.from_amount,
        // 同币种不送对方金额：交给后端按本方金额入账（送一个不同的值必然 422）。
        to_amount: sameCurrency ? undefined : values.to_amount,
        remark: values.remark || undefined,
      });
      notifySuccess("互转单已生效，两个账户的余额已同步");
      if (result.data.insufficient_balance) {
        // 后端只提示不拦截（期初可能还没录、银行到账有时间差），但这件事财务必须在界面上看到。
        notifyError(`转出后${fromAccount?.bankName ?? "本方账户"}的余额为 ${result.data.source_balance_after}（已成负数），请核对期初余额或到账时间`, "余额不足提醒");
      }
      setDialog(null);
      await load();
    } catch (cause) {
      const message = messageOf(cause, "互转失败");
      notifyError(message);
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    setDialog({
      title: "新建银行余额互转",
      fields: [
        { name: "from_bank_id", label: "本方账户", type: "select", required: true, options: bankOptions, placeholder: "选择转出账户" },
        // 默认值只能猜：ActionDialog 不能跟着「本方账户」联动，所以给启用账户里第一个/第二个的账户币种，
        // 提交时再按所选账户校验；同币种互转（最常见）因此不用碰这两个下拉。
        { name: "from_currency", label: "本方币种", type: "select", required: true, options: currencySelectOptions, defaultValue: activeBanks[0]?.currency },
        { name: "to_bank_id", label: "对方账户", type: "select", required: true, options: bankOptions, placeholder: "选择转入账户" },
        { name: "to_currency", label: "对方币种", type: "select", required: true, options: currencySelectOptions, defaultValue: activeBanks[1]?.currency ?? activeBanks[0]?.currency },
        { name: "from_amount", label: "本方金额", type: "number", required: true, placeholder: "正数" },
        { name: "to_amount", label: "对方金额（两种币种不同时必填）", type: "number" },
        { name: "transfer_date", label: "互转日期", type: "date", required: true, defaultValue: today() },
        { name: "remark", label: "备注", type: "textarea", placeholder: "例如：月末资金归集" },
      ],
      submit: (values) => createTransfer(values),
    });
  }

  function openReverse(item: BankTransfer) {
    setDialog({
      title: `冲销互转单 ${item.transferNo}`,
      fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true, placeholder: "例如：账号选错，重新互转" }],
      submit: async (values) => {
        setBusy(true);
        try {
          await apiPost(`/finance/bank-transfers/${item.id}/reverse`, { reason: values.reason });
          notifySuccess("已冲销；这笔互转不再计入两个账户的余额");
          setDialog(null);
          await load();
        } catch (cause) {
          const message = messageOf(cause, "冲销失败");
          notifyError(message);
          throw new Error(message);
        } finally {
          setBusy(false);
        }
      },
    });
  }

  const balanceOf = (bank: BankRef) => balances[bank.id];
  /** 余额接口挂了也不把整列留白：退回账户档案上的期初余额，并在表头下的说明里点名。 */
  const balanceText = (bank: BankRef) => balanceOf(bank)?.balance ?? (bank.openingBalance ?? "0");
  // 停用账户不能互转，但「我的账户不见了」是最容易被误报成 bug 的事，所以在这里点名说明去向。
  const inactiveCount = banks.length - activeBanks.length;

  const balanceColumns: ColumnDef<BankRef>[] = [
    { accessorKey: "bankCode", header: "银行编码" },
    { accessorKey: "bankName", header: "银行名称" },
    { accessorKey: "accountNumber", header: "银行账号" },
    { accessorKey: "currency", header: "币种" },
    { id: "opening", header: "期初余额", cell: ({ row }) => balanceOf(row.original)?.opening_balance ?? "-" },
    { id: "cashIn", header: "收入", cell: ({ row }) => balanceOf(row.original)?.cash_in ?? "-" },
    { id: "cashOut", header: "支出", cell: ({ row }) => balanceOf(row.original)?.cash_out ?? "-" },
    { id: "transferIn", header: "转入", cell: ({ row }) => balanceOf(row.original)?.transfer_in ?? "-" },
    { id: "transferOut", header: "转出", cell: ({ row }) => balanceOf(row.original)?.transfer_out ?? "-" },
    // data-testid 钉在余额上：能转多少全看这一格，测试要能直接定位到它。
    { id: "balance", header: "当前余额", cell: ({ row }) => <span data-testid={`bank-transfer-balance-${row.original.id}`}>{balanceText(row.original)}</span> },
  ];

  const columns: ColumnDef<BankTransfer>[] = [
    { accessorKey: "transferNo", header: "互转单号" },
    { id: "date", header: "日期", cell: ({ row }) => String(row.original.transferDate).slice(0, 10) },
    { id: "fromBank", header: "本方账户", cell: ({ row }) => accountText(row.original.fromBank) },
    { accessorKey: "fromCurrency", header: "本方币种" },
    { accessorKey: "fromAmount", header: "本方金额" },
    { id: "toBank", header: "对方账户", cell: ({ row }) => accountText(row.original.toBank) },
    { accessorKey: "toCurrency", header: "对方币种" },
    { accessorKey: "toAmount", header: "对方金额" },
    { accessorKey: "exchangeRate", header: "汇率" },
    // 冲销原因不能只留在库里：已冲销的行必须能看出「为什么冲的」，否则只能去翻审计。
    { id: "status", header: "状态", cell: ({ row }) => (row.original.status === "posted" ? "生效" : `已冲销${row.original.reversalReason ? `（${row.original.reversalReason}）` : ""}`) },
    { id: "remark", header: "备注", cell: ({ row }) => row.original.remark || "-" },
    ...auditColumns<BankTransfer>(),
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) => <div className="action-row" data-testid={`bank-transfer-actions-${row.original.id}`}>
        <Button size="sm" variant="secondary" data-testid={`bank-transfer-reverse-${row.original.id}`} disabled={busy || row.original.status !== "posted"} onClick={() => openReverse(row.original)}>冲销</Button>
      </div>,
    },
  ];

  if (loading) return <div className="page-root finance-page" data-testid={testId}><PageHeader title="银行余额互转" /><LoadingState /></div>;

  return <div className="page-root finance-page" data-testid={testId}>
    <PageHeader title="银行余额互转">
      <Button variant="secondary" data-testid="bank-transfer-refresh" onClick={() => void load()}>刷新</Button>
      <Button data-testid="bank-transfer-create" onClick={openCreate}>新建互转</Button>
    </PageHeader>

    <ActionDialog
      open={Boolean(dialog)}
      onOpenChange={(open) => { if (!open && !busy) setDialog(null); }}
      title={dialog?.title ?? "操作"}
      fields={dialog?.fields ?? []}
      onSubmit={(values) => (dialog ? dialog.submit(values) : undefined)}
    />

    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    {!error && <>
      <section className="panel">
        <div className="panel-body filter-bar">
          <label>起始日期<Input data-testid="bank-transfer-from" type="date" value={fromFilter} onChange={(event) => setFromFilter(event.target.value)} /></label>
          <label>截止日期<Input data-testid="bank-transfer-to" type="date" value={toFilter} onChange={(event) => setToFilter(event.target.value)} /></label>
          <label>账户
            <Select value={bankFilter || ALL} onValueChange={(value) => setBankFilter(value === ALL ? "" : value)}>
              <SelectTrigger data-testid="bank-transfer-bank-filter"><SelectValue placeholder="全部账户" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部账户</SelectItem>
                {banks.map((bank) => <SelectItem key={bank.id} value={bank.id}>{bank.bankName} / {bank.accountNumber}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        </div>
      </section>

      <section className="panel" data-testid="bank-transfer-balances">
        <div className="panel-heading"><h2>本方账户余额</h2>{inactiveCount > 0 ? <span className="panel-note">另有 {inactiveCount} 个已停用账户不参与互转</span> : null}</div>
        <div className="panel-body">
          <DataTable columns={balanceColumns} data={activeBanks} pageSize={50} empty={<EmptyState title="没有可用的银行账户" />} />
        </div>
      </section>

      <section className="panel" data-testid="bank-transfer-list">
        <div className="panel-heading"><h2>互转记录</h2><span className="panel-note" data-testid="bank-transfer-count">共 {transfers.length} 条</span></div>
        <div className="panel-body">
          <DataTable columns={columns} data={transfers} pageSize={50} empty={<EmptyState title="还没有互转记录" />} />
        </div>
      </section>
    </>}
  </div>;
}

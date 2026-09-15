"use client";

// 银行账户池（/finance/banks）：付款/对账里「支付银行」下拉的来源，也是财务的银行账户主数据。
//
// 为什么单独一页：这套接口（GET/POST/PATCH/PATCH toggle/DELETE /finance/banks）此前只有后端，
// 前端仅在应付付款/对账里把它当**下拉数据源**用 —— 于是账户只能靠接口写，
// 页面上既看不到池子里有什么，也建不了新账户（用户 2026-09-15 反馈「银行池在哪？我咋没看见」）。
//
// 与「结算账户字典」的区别（两处都要知道，别混）：
//   - 本页 = 银行账户主数据（开户行、账号、账户名、币种、SWIFT），付款单/对账单的 `bank_id` 指向它；
//   - 收支管理里的「结算账户」是**字典项**（老表「结算方式」原文，如「农业银行5706」），
//     收支流水的 `settlement_account_id` 指向它；两者没有外键关系，由自动流水按账号做保守匹配。
//
// 删除是软删除：已引用它的付款/对账单仍能显示账户名称，只是不再出现在下拉里。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../layout/app-shell";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { DataTable } from "../data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../lib/api-client";
import { currencyOptions, currencyOptionsWithCurrent, fetchCurrencyOptions, type CurrencyOption } from "../../lib/currency-catalogue";
import { notifyError, notifySuccess } from "../ui/toaster";

type Bank = {
  id: string; bankCode: string; bankName: string; accountName: string; accountNumber: string; currency: string;
  swiftCode: string | null; isActive: boolean; remark: string | null;
};
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => Promise<void> | void };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

export default function BankWorkspace({ testId = "page-finance-banks" }: { testId?: string }) {
  const [banks, setBanks] = useState<Bank[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  // 删除要二次确认（软删除，但账户会从所有付款下拉里消失）。用全站已验证的 Dialog 原语：
  // components/ui/alert-dialog.tsx 在本环境一渲染就抛 Radix slot 错误（且全站无人使用），不赌它。
  const [pendingDelete, setPendingDelete] = useState<Bank | null>(null);
  const [currencyCatalogue, setCurrencyCatalogue] = useState<CurrencyOption[]>([]);
  const currencyDefault = (preferred: string) => { const options = currencyOptions(currencyCatalogue); return options.some((option) => option.value === preferred) ? preferred : (options[0]?.value ?? preferred); };

  useEffect(() => { let cancelled = false; void fetchCurrencyOptions().then((options) => { if (!cancelled) setCurrencyCatalogue(options); }); return () => { cancelled = true; }; }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await apiGet<Bank[]>("/finance/banks");
      setBanks(result.data);
    } catch (cause) {
      setError(messageOf(cause, "银行账户加载失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** 弹窗动作：失败必须把错误抛回 ActionDialog，否则弹窗静默关闭、用户看不到原因。 */
  async function submitDialog(action: Promise<unknown>, success: string) {
    try {
      await action;
      notifySuccess(success);
      setDialog(null);
      await load();
    } catch (cause) {
      const message = messageOf(cause, "操作失败");
      notifyError(message);
      throw new Error(message);
    }
  }

  function openCreate() {
    setDialog({
      title: "新建银行账户",
      fields: [
        { name: "bank_code", label: "银行编码", required: true, placeholder: "内部唯一编码，如 ABC-5706" },
        { name: "bank_name", label: "银行名称", required: true, placeholder: "如 农业银行" },
        { name: "account_name", label: "账户名称", required: true, placeholder: "开户名（公司全称）" },
        { name: "account_number", label: "银行账号", required: true },
        { name: "currency", label: "币种", type: "select", required: true, options: currencyOptions(currencyCatalogue), defaultValue: currencyDefault("CNY") },
        { name: "swift_code", label: "SWIFT 代码（外币账户用）" },
        { name: "remark", label: "备注", type: "textarea" },
      ],
      submit: (values) => submitDialog(apiPost("/finance/banks", { ...values, swift_code: values.swift_code || undefined, remark: values.remark || undefined }), "银行账户已创建"),
    });
  }

  function openEdit(bank: Bank) {
    setDialog({
      title: `编辑银行账户：${bank.bankName}`,
      fields: [
        { name: "bank_code", label: "银行编码", required: true, defaultValue: bank.bankCode },
        { name: "bank_name", label: "银行名称", required: true, defaultValue: bank.bankName },
        { name: "account_name", label: "账户名称", required: true, defaultValue: bank.accountName },
        { name: "account_number", label: "银行账号", required: true, defaultValue: bank.accountNumber },
        { name: "currency", label: "币种", type: "select", required: true, options: currencyOptionsWithCurrent(currencyCatalogue, bank.currency), defaultValue: bank.currency },
        { name: "swift_code", label: "SWIFT 代码（外币账户用）", defaultValue: bank.swiftCode ?? "" },
        { name: "remark", label: "备注", type: "textarea", defaultValue: bank.remark ?? "" },
      ],
      submit: (values) => submitDialog(apiPatch(`/finance/banks/${bank.id}`, { ...values, swift_code: values.swift_code ?? "", remark: values.remark ?? "" }), "银行账户已更新"),
    });
  }

  async function toggle(bank: Bank) {
    try {
      await apiPatch(`/finance/banks/${bank.id}/toggle`, { is_active: !bank.isActive });
      notifySuccess(bank.isActive ? `${bank.bankName} 已停用（不再出现在付款下拉里）` : `${bank.bankName} 已启用`);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "状态切换失败"));
    }
  }

  async function remove(bank: Bank) {
    try {
      await apiRequest(`/finance/banks/${bank.id}`, { method: "DELETE" });
      notifySuccess(`${bank.bankName} 已删除`);
      setPendingDelete(null);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "删除失败"));
    }
  }

  const visible = useMemo(() => {
    const text = filter.trim().toLowerCase();
    if (!text) return banks;
    return banks.filter((bank) => `${bank.bankCode} ${bank.bankName} ${bank.accountName} ${bank.accountNumber} ${bank.currency}`.toLowerCase().includes(text));
  }, [banks, filter]);

  const columns: ColumnDef<Bank>[] = [
    { accessorKey: "bankCode", header: "银行编码" },
    { accessorKey: "bankName", header: "银行名称" },
    { accessorKey: "accountName", header: "账户名称" },
    { accessorKey: "accountNumber", header: "银行账号" },
    { accessorKey: "currency", header: "币种" },
    { id: "swift", header: "SWIFT", cell: ({ row }) => row.original.swiftCode || "-" },
    { id: "status", header: "状态", cell: ({ row }) => row.original.isActive ? "启用" : "已停用" },
    { id: "remark", header: "备注", cell: ({ row }) => row.original.remark || "-" },
    {
      id: "actions", header: "操作", cell: ({ row }) => <div className="action-row" data-testid={`bank-actions-${row.original.id}`}>
        <Button size="sm" variant="secondary" onClick={() => openEdit(row.original)}>编辑</Button>
        <Button size="sm" variant="secondary" data-testid={`bank-toggle-${row.original.id}`} onClick={() => void toggle(row.original)}>{row.original.isActive ? "停用" : "启用"}</Button>
        <Button size="sm" variant="destructive" data-testid={`bank-delete-${row.original.id}`} onClick={() => setPendingDelete(row.original)}>删除</Button>
      </div>,
    },
  ];

  if (loading) return <div className="page-root" data-testid={testId}><PageHeader title="银行账户" /><LoadingState /></div>;

  return <div className="page-root" data-testid={testId}>
    <PageHeader title="银行账户" description="付款、对账与收款里「支付银行」下拉的来源；停用后不再出现在下拉里。">
      <Button variant="secondary" data-testid="bank-refresh" onClick={() => void load()}>刷新</Button>
      <Button data-testid="bank-create" onClick={openCreate}>新建银行账户</Button>
    </PageHeader>
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />
    <Dialog open={Boolean(pendingDelete)} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
      <DialogContent data-testid="bank-delete-confirm">
        <DialogHeader>
          <DialogTitle>删除银行账户：{pendingDelete?.bankName} {pendingDelete?.accountNumber}</DialogTitle>
          <DialogDescription>删除后它不再出现在付款/对账的「支付银行」下拉里；已引用它的付款单与对账单仍会显示这个账户名称。</DialogDescription>
        </DialogHeader>
        <DialogBody><p className="panel-note">只是暂时不用的话，建议改用「停用」：同样是移出下拉，但保留账户档案、随时可再启用。</p></DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setPendingDelete(null)}>取消</Button>
          <Button variant="destructive" data-testid="bank-delete-confirm-submit" onClick={() => pendingDelete && void remove(pendingDelete)}>确认删除</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    {!error && <>
      <section className="panel panel-body">
        <div className="filter-bar"><label>搜索<Input data-testid="bank-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="银行编码 / 名称 / 账号 / 币种" /></label></div>
        <p className="panel-note">
          共 {banks.length} 个账户（启用 {banks.filter((bank) => bank.isActive).length} 个）。
          这里维护的是**银行账户主数据**；收支管理里的「结算账户」是老表结算方式的字典项，两者不是同一份数据，
          自动写入收支流水时按账号做保守匹配。
        </p>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2>银行账户池</h2><span className="panel-note">共 {visible.length} 条</span></div>
        <div className="panel-body"><DataTable columns={columns} data={visible} pageSize={50} empty={<EmptyState title="还没有银行账户" description="新建账户后，它才会出现在应付付款、应付对账的「支付银行」下拉里。" />} /></div>
      </section>
    </>}
  </div>;
}

"use client";

// 结算方式设置（财务 → 结算方式）。
//
// 用户 2026-11-23 原话：「把系统结算方式改下，加入中国银行-人民币账户，还有备用金（招商银行账户）」。
//
// 在本系统里，「结算方式」这一列由两段拼成：方式文本（`cash_flow_entries.settlement_method`，自由文本）
// + 结算账户（`settlement_account_id` → `dictionary_items`，老表「结算方式」里的账户文本，如「农业银行5706」）。
// 用户给的两个名字都是**账户**，所以落在这个字典上，而不是银行账户池：
//   * 银行账户池（财务 → 银行账户）是主数据，建一户要开户行/账号/账户名/币种，`bank_id` 指向它；
//   * 结算账户字典只需要一个名字，正是用户给的信息。
//
// 两个入口都保留：收支流水表单里的「结算账户」下拉仍读同一个字典接口，因此这里加/停用的项
// 会立刻反映到录流水时的可选项上。
//
// 为什么有「补齐缺失的内置账户」：仓库红线不允许新增 migration，Agent 也不能直接写生产库。
// 内置清单改在代码里之后，已有库不会自动多出这两项；这个按钮走**既有**字典接口，由管理员
// 显式触发，只补「字典里完全没有」的项（已停用的不复活、已改名的按 key/label 认作已存在）。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../layout/app-shell";
import { DataTable } from "../data/data-table";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost } from "../../lib/api-client";
// 搜索语义全站统一（空格分词的 AND、忽略大小写与空白、空查询不过滤），见 lib/fuzzy-search.ts。
import { fuzzyMatch } from "../../lib/fuzzy-search";
import { SETTLEMENT_ACCOUNT_DICTIONARY_KEY } from "../../lib/finance-sections";
import { BUILT_IN_SETTLEMENT_ACCOUNTS, builtInSettlementStatuses } from "../../lib/settlement-accounts";
import { notifyError, notifySuccess } from "../ui/toaster";
import { auditColumns, type AuditRow } from "../data/audit-columns";

/** 字典接口返回的一行（`GET /dictionaries/settlement_account/items`）。 */
type SettlementAccount = AuditRow & {
  id: string;
  key: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
};

const DICTIONARY_PATH = `/dictionaries/${SETTLEMENT_ACCOUNT_DICTIONARY_KEY}/items`;
const ITEM_PATH = "/dictionaries/items";
const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);
const statusLabel = (status: "active" | "inactive" | "missing") => (status === "active" ? "已启用" : status === "inactive" ? "已停用" : "未添加");

export default function SettlementAccountWorkspace({ testId = "page-finance-settlements" }: { testId?: string }) {
  const [accounts, setAccounts] = useState<SettlementAccount[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => Promise<void> } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // include_inactive=true：停用的项也要列出来，否则财务会以为历史流水上的账户名丢了。
      const result = await apiGet<SettlementAccount[]>(`${DICTIONARY_PATH}?include_inactive=true`);
      setAccounts(result.data);
    } catch (cause) {
      setError(messageOf(cause, "结算账户加载失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const builtIns = useMemo(() => builtInSettlementStatuses(accounts), [accounts]);
  const missing = useMemo(() => builtIns.filter((item) => item.status === "missing"), [builtIns]);
  const present = builtIns.filter((item) => item.status !== "missing").length;

  const visible = useMemo(
    () => accounts.filter((account) => fuzzyMatch(filter, [account.key, account.label, account.isActive ? "启用" : "已停用"])),
    [accounts, filter],
  );

  const nextSortOrder = useMemo(() => {
    const max = accounts.reduce((current, account) => Math.max(current, account.sortOrder ?? 0), 0);
    return String(max > 0 ? max + 10 : 10);
  }, [accounts]);

  /** 弹窗动作失败必须把错误抛回 ActionDialog，否则弹窗静默关闭、用户看不到原因。 */
  async function submitDialog(action: Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action;
      notifySuccess(success);
      setDialog(null);
      await load();
    } catch (cause) {
      const message = messageOf(cause, "操作失败");
      notifyError(message);
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }

  function openCreate() {
    setDialog({
      title: "新增结算账户",
      fields: [
        { name: "label", label: "账户名称", required: true, placeholder: "如：中国银行-人民币账户", defaultValue: "" },
        { name: "sort_order", label: "排序（越小越靠前）", type: "number", defaultValue: nextSortOrder },
      ],
      submit: (values) => {
        const label = values.label.trim();
        if (!label) throw new Error("请填写账户名称");
        return submitDialog(
          apiPost(DICTIONARY_PATH, { key: label, label, sort_order: Number(values.sort_order) || 0 }),
          `已新增结算账户「${label}」`,
        );
      },
    });
  }

  function openEdit(account: SettlementAccount) {
    setDialog({
      title: `编辑结算账户：${account.label}`,
      fields: [
        { name: "label", label: "账户名称", required: true, defaultValue: account.label },
        { name: "sort_order", label: "排序（越小越靠前）", type: "number", defaultValue: String(account.sortOrder ?? 0) },
      ],
      submit: (values) => {
        const label = values.label.trim();
        if (!label) throw new Error("请填写账户名称");
        return submitDialog(
          // key 是身份、不在编辑里改：它决定「补齐内置账户」与自动流水匹配时认不认得出这一项。
          apiPatch(`${ITEM_PATH}/${account.id}`, { label, sort_order: Number(values.sort_order) || 0 }),
          `已保存结算账户「${label}」`,
        );
      },
    });
  }

  async function toggle(account: SettlementAccount) {
    setBusy(true);
    try {
      await apiPatch(`${ITEM_PATH}/${account.id}`, { is_active: !account.isActive });
      notifySuccess(account.isActive ? `已停用「${account.label}」（历史流水仍显示这个账户）` : `已启用「${account.label}」`);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "状态切换失败"));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 只补**完全缺失**的内置项。
   *
   * 已存在但停用的项不碰：停用是财务的明确决定（例如这张卡销户了），补齐不该把它复活。
   * 逐条 POST（而不是 Promise.all）：字典项有 `(type_id, key)` 唯一约束，顺序请求让失败点更好定位。
   */
  async function backfillBuiltIns() {
    if (!missing.length) return;
    setBusy(true);
    try {
      for (const item of missing) {
        await apiPost(DICTIONARY_PATH, { key: item.label, label: item.label, sort_order: item.sortOrder });
      }
      notifySuccess(`已补齐 ${missing.length} 个内置结算账户`);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "补齐内置结算账户失败"));
    } finally {
      setBusy(false);
    }
  }

  const columns: ColumnDef<SettlementAccount>[] = [
    { accessorKey: "label", header: "结算账户名称" },
    { id: "sort", header: "排序", cell: ({ row }) => row.original.sortOrder ?? 0 },
    { id: "status", header: "状态", cell: ({ row }) => <span data-testid={`settlement-account-status-${row.original.id}`}>{row.original.isActive ? "启用" : "已停用"}</span> },
    ...auditColumns<SettlementAccount>(),
    {
      id: "actions", header: "操作", cell: ({ row }) => <div className="action-row" data-testid={`settlement-account-actions-${row.original.id}`}>
        <Button size="sm" variant="secondary" data-testid={`settlement-account-edit-${row.original.id}`} onClick={() => openEdit(row.original)}>编辑</Button>
        <Button size="sm" variant="secondary" data-testid={`settlement-account-toggle-${row.original.id}`} disabled={busy} onClick={() => void toggle(row.original)}>{row.original.isActive ? "停用" : "启用"}</Button>
      </div>,
    },
  ];

  if (loading) return <div className="page-root finance-page" data-testid={testId}><PageHeader title="结算方式设置" /><LoadingState /></div>;

  return <div className="page-root finance-page" data-testid={testId}>
    <PageHeader title="结算方式设置">
      <Button variant="secondary" asChild><a href="/finance">返回财务</a></Button>
      <Button variant="secondary" data-testid="settlement-account-refresh" onClick={() => void load()}>刷新</Button>
      <Button data-testid="settlement-account-create" onClick={openCreate}>新增结算账户</Button>
    </PageHeader>
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />

    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    {!error && <>
      <section className="panel" data-testid="settlement-builtins">
        <div className="panel-heading">
          <h2>内置结算账户</h2>
          <span className="panel-note">已添加 {present} / {BUILT_IN_SETTLEMENT_ACCOUNTS.length} 项</span>
        </div>
        <div className="panel-body">
          <p className="panel-note">
            内置清单与后端 seed 同源。已有库升级后若还缺少某几项，点下面的按钮补齐；补齐只新增缺失项，
            不会改动或复活已停用的账户。
          </p>
          <div className="action-row">
            {builtIns.map((item, index) => <span key={item.label} className="badge" data-testid={`settlement-builtin-${index}`}>
              {item.label} · {statusLabel(item.status)}
            </span>)}
          </div>
          <div className="action-row">
            <Button data-testid="settlement-builtin-backfill" disabled={busy || missing.length === 0} onClick={() => void backfillBuiltIns()}>
              {missing.length ? `补齐缺失的内置账户（${missing.length}）` : "内置账户已齐全"}
            </Button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading"><h2>结算账户</h2><span className="panel-note">共 {accounts.length} 项（启用 {accounts.filter((account) => account.isActive).length} 项）</span></div>
        <div className="panel-body filter-bar">
          <label>搜索<Input data-testid="settlement-account-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="账户名称 / 状态" /></label>
        </div>
        <div className="panel-body">
          <DataTable columns={columns} data={visible} pageSize={50} empty={<EmptyState title="还没有结算账户" description="可以点右上角「新增结算账户」，或先用上面的按钮补齐内置账户。" />} />
        </div>
      </section>
    </>}
  </div>;
}

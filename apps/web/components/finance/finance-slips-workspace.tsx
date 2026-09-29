"use client";

// 收/付款单的存档页（/finance/slips?kind=payment|receipt，2026-09-26）。
//
// 用户的原话只有六个字：「付款单要有填写汇率的地方，**保存键**」。但「保存」这个动作必须回答
// 一个界面问题：**存下来的单子去哪了？** 没有这一页，保存就只是往数据库里丢一条没人能再看到的记录
// —— 财务关掉弹窗之后，那张单子就只存在于她的记忆里。
//
// 所以这一页做三件事，每件对应一个真实动作：
//   1. **找回来**：列表按日期倒序，带对方单位与合计，点「打开」回到同一个编辑器（改完再保存 = 覆盖那一张）；
//   2. **再导出**：列表里直接导出 xlsx，不必先打开编辑器（单子早就在库里了）；
//   3. **作废**：录错的单子逻辑删除，**原因必填**（事后要说得清「编号 XXX 的那张为什么没了」）。
//
// 单子**从这里建不出来**，这是刻意的：它的起点是「勾了一批应付/应收条目」，
// 所以新建那条路在应付/应收页（勾选 → 付款单 → 预填 → 保存）。页面上有一句说明写着这件事，
// 否则用户会在这页找「新建」按钮，找不到就以为功能没做完。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { PageHeader } from "../layout/app-shell";
import { ActionDialog } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DataTable } from "../data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiDelete, apiGet } from "../../lib/api-client";
import { downloadPost } from "../../lib/download";
import { notifyError, notifySuccess } from "../ui/toaster";
import { cn } from "../../lib/utils";
import FinanceSlipEditor from "./finance-slip-editor";
import {
  financeSlipDeleteLabel,
  financeSlipExportPath,
  financeSlipFileName,
  financeSlipPayloadFromRecord,
  financeSlipRecordLabel,
  financeSlipRecordPath,
  financeSlipRecordTotal,
  financeSlipsPath,
  slipLabels,
  type FinanceSlipDraft,
  type FinanceSlipKind,
  type FinanceSlipRecord,
} from "../../lib/finance-slip";

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

/** 一页多少张：单子是逐张打印的，一屏看不完时用「上一页 / 下一页」翻，不做无限滚动。 */
const PAGE_SIZE = 20;

export default function FinanceSlipsWorkspace({ kind, testId = "page-finance-slips" }: { kind: FinanceSlipKind; testId?: string }) {
  const labels = slipLabels(kind);
  const [rows, setRows] = useState<FinanceSlipRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [counterparty, setCounterparty] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  /** 正在编辑器里打开的那一张（null = 没打开）。列表里已经有全部字段，不必再拉一次详情。 */
  const [editing, setEditing] = useState<FinanceSlipRecord | null>(null);
  const [deleting, setDeleting] = useState<FinanceSlipRecord | null>(null);
  const [exporting, setExporting] = useState("");

  const load = useCallback(async (target = page, search = counterparty) => {
    setLoading(true);
    setError("");
    try {
      const result = await apiGet<FinanceSlipRecord[]>(financeSlipsPath({ kind, page: target, pageSize: PAGE_SIZE, counterparty: search }));
      setRows(result.data);
      setTotal(Number(result.meta?.total ?? result.data.length));
    } catch (cause) {
      setError(messageOf(cause, "单据加载失败"));
    } finally {
      setLoading(false);
    }
  }, [kind, page, counterparty]);

  // 切种类（kind 变了）时回到第一页并清掉搜索：否则会停在「收款单的第 3 页」这种空页上。
  useEffect(() => { setPage(1); setCounterparty(""); }, [kind]);
  useEffect(() => { void load(); }, [load]);

  async function exportSaved(record: FinanceSlipRecord) {
    setExporting(record.id);
    try {
      await downloadPost(financeSlipExportPath(record.kind), financeSlipPayloadFromRecord(record), financeSlipFileName(record.kind, record.slip_no));
      notifySuccess(`已导出${slipLabels(record.kind).name} ${record.slip_no || "未编号"}`);
    } catch (cause) {
      notifyError(messageOf(cause, "导出失败"));
    } finally {
      setExporting("");
    }
  }

  /**
   * 作废（逻辑删除）。失败原因抛回 ActionDialog（它负责显示在弹窗里）——
   * 直接吞掉的话，用户看到的是「弹窗没关、也没说为什么」。
   */
  async function remove(reason: string) {
    if (!deleting) return;
    try {
      await apiDelete(financeSlipRecordPath(deleting.id), { reason });
      notifySuccess(`${financeSlipDeleteLabel(deleting)} 已作废`);
      setDeleting(null);
      await load();
    } catch (cause) {
      const message = messageOf(cause, "作废失败");
      notifyError(message);
      throw new Error(message);
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const columns = useMemo<ColumnDef<FinanceSlipRecord>[]>(() => [
    { accessorKey: "slip_no", header: "单据编号", cell: ({ row }) => row.original.slip_no || "未编号" },
    { accessorKey: "slip_date", header: labels.date },
    { accessorKey: "counterparty_name", header: labels.counterparty },
    { accessorKey: "currency", header: labels.currency },
    // 汇率 / 折合人民币留空就是空（不写 0）：它们是手填的两格，空着表示「这笔是人民币付款」。
    { id: "rate", header: labels.exchangeRate, cell: ({ row }) => row.original.exchange_rate || "-" },
    { id: "cny", header: labels.amountCny, cell: ({ row }) => row.original.amount_cny || "-" },
    { id: "total", header: "借方合计", cell: ({ row }) => <span data-testid={`slip-total-${row.original.id}`}>{financeSlipRecordTotal(row.original) || "-"}</span> },
    { id: "lines", header: "行数", cell: ({ row }) => (row.original.lines ?? []).length },
    { accessorKey: "maker", header: labels.maker },
    { id: "saved_at", header: "保存时间", cell: ({ row }) => (row.original.updated_at ?? "").replace("T", " ").slice(0, 16) },
    {
      id: "actions", header: "操作", cell: ({ row }) => <div className="action-row" data-testid={`slip-actions-${row.original.id}`}>
        <Button size="sm" variant="secondary" data-testid={`slip-open-${row.original.id}`} onClick={() => setEditing(row.original)}>打开</Button>
        <Button size="sm" variant="secondary" data-testid={`slip-export-${row.original.id}`} disabled={exporting === row.original.id} onClick={() => void exportSaved(row.original)}>{exporting === row.original.id ? "导出中…" : "导出"}</Button>
        <Button size="sm" variant="destructive" data-testid={`slip-delete-${row.original.id}`} onClick={() => setDeleting(row.original)}>作废</Button>
      </div>,
    },
  ], [labels, exporting]);

  return <div className="page-root finance-page" data-testid={testId}>
    <PageHeader title="收付款单">
      <Button variant="secondary" data-testid="slip-refresh" onClick={() => void load()}>刷新</Button>
    </PageHeader>

    {/* 种类切换用真实链接（可收藏、可分享），与其余二级页的子栏目同一套写法。 */}
    <nav className="finance-tabs" aria-label="单据种类" data-testid="slip-kind-tabs">
      {(["payment", "receipt"] as const).map((item) => <Link
        key={item}
        href={`/finance/slips?kind=${item}`}
        aria-current={item === kind ? "page" : undefined}
        data-testid={`slip-kind-${item}`}
        className={cn("finance-tab", item === kind && "finance-tab-active")}
      ><strong>{slipLabels(item).name}</strong></Link>)}
    </nav>

    <ActionDialog
      open={Boolean(deleting)}
      title={`作废：${deleting ? financeSlipDeleteLabel(deleting) : ""}`}
      fields={[
        { name: "info", label: "作废后这张单子不再出现在列表里（数据库里仍有记录，审计里也有这次作废）。已经导出/打印出去的那张纸不受影响", type: "info" as const },
        { name: "reason", label: "作废原因（录错了请写清错在哪）", type: "textarea", required: true },
      ]}
      onOpenChange={(open) => { if (!open) setDeleting(null); }}
      onSubmit={(values) => remove(values.reason)}
    />

    {/* 编辑器就是应付/应收页用的那一个：从存档打开时 drafts 只有一张，`entryOf` 会把 id 带上，
        所以「保存」是覆盖这一张而不是再建一张。 */}
    <FinanceSlipEditor
      kind={kind}
      open={Boolean(editing)}
      onOpenChange={(open) => { if (!open) setEditing(null); }}
      drafts={editing ? [editing] : null}
      loading={false}
      error=""
      onSaved={() => { void load(); }}
    />

    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    {!error && loading && <section className="panel"><LoadingState /></section>}
    {!error && !loading && <>
      <section className="panel panel-body">
        <div className="filter-bar">
          <label>搜索<Input data-testid="slip-filter" value={counterparty} onChange={(event) => setCounterparty(event.target.value)} placeholder={`${labels.counterparty}关键字`} /></label>
          <Button variant="secondary" data-testid="slip-search" onClick={() => { setPage(1); void load(1, counterparty); }}>查询</Button>
        </div>
        <p className="panel-note">
          共 {total} 张{labels.name}。单据<b>在这里建不出来</b>：它的起点是「勾一批{kind === "payment" ? "应付条目" : "应收来源"}」——
          到{kind === "payment" ? <Link href="/finance/payable">应付管理</Link> : <Link href="/finance/receivable">应收管理</Link>}勾选后点「{labels.name}」预填，改完点「保存这一张」就会出现在这里。
        </p>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>已保存的{labels.name}</h2>
          <span className="panel-note">第 {page} / {pages} 页</span>
        </div>
        <div className="panel-body">
          <DataTable columns={columns} data={rows} pageSize={PAGE_SIZE} empty={<EmptyState title={`还没有保存过${labels.name}`} />} />
        </div>
        {pages > 1 && <div className="action-row">
          <Button size="sm" variant="secondary" data-testid="slip-prev" disabled={page <= 1} onClick={() => { const next = page - 1; setPage(next); void load(next, counterparty); }}>上一页</Button>
          <Button size="sm" variant="secondary" data-testid="slip-next" disabled={page >= pages} onClick={() => { const next = page + 1; setPage(next); void load(next, counterparty); }}>下一页</Button>
        </div>}
      </section>
    </>}
  </div>;
}

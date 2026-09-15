"use client";

// 凭证管理（/finance/voucher）。
//
// 数据全部来自**收支流水**（用户口径：「凭证管理从收支流水中 fetch，每条收支条目都可以生成对应的条目」）：
//   1. 收支流水列表：每条流水都能生成一张记账凭证；已有凭证的流水直接显示凭证号与「查看凭证」；
//   2. 记账凭证列表：草稿可编辑/删除/过账，已过账只能红冲（另开一张红字凭证，原凭证标为已红冲）；
//   3. 凭证纸视图：把结构化分录排版成记账凭证，用「打印 / 另存 PDF」出纸质件或 PDF。
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
import { exportVoucherPng } from "../../lib/voucher-image";
import { notifyError, notifySuccess } from "../ui/toaster";
import { money } from "./record-detail-dialog";

type CashFlowEntry = {
  id: string; entryNo: string; entryDate: string; counterpartyName: string; direction: string;
  amount: string; currency: string; status: string; settlementMethod: string | null; remark: string | null;
  item?: { id: string; key: string; label: string } | null;
  settlementAccount?: { id: string; key: string; label: string } | null;
};
type VoucherLine = { id: string; lineNo: number; direction: string; subjectKey: string; subjectLabel: string; summary: string; amount: string; currency: string };
type Voucher = {
  id: string; voucherNo: string; voucherDate: string; period: string; sourceType: string; sourceId: string;
  summary: string; currency: string; debitTotal: string; creditTotal: string; status: string; status_label?: string;
  remark: string | null; createdBy?: string; lines: VoucherLine[];
  source_entry?: { id: string; entryNo: string; status: string } | null;
  counterpart_voucher?: { id: string; voucherNo: string; status: string } | null;
  reversal_voucher?: { id: string; voucherNo: string; status: string } | null;
};
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> };

const STATUS_LABELS: Record<string, string> = { draft: "草稿", posted: "已过账", reversed: "已红冲" };
const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const day = (value: string | null | undefined) => (value ? String(value).slice(0, 10) : "-");
const directionLabel = (direction: string) => (direction === "debit" ? "借方" : "贷方");
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
  const [filter, setFilter] = useState("");
  const [generated, setGenerated] = useState<"all" | "pending" | "done">("all");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [flow, voucherRows] = await Promise.all([
        apiGet<CashFlowEntry[]>("/finance/cash-flow-entries"),
        apiGet<Voucher[]>("/finance/vouchers"),
      ]);
      setEntries(flow.data); setVouchers(voucherRows.data);
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
      return [entry.entryNo, entry.counterpartyName, entry.item?.label, entry.settlementMethod, entry.settlementAccount?.label]
        .some((value) => (value ?? "").toLowerCase().includes(text));
    });
  }, [entries, filter, generated, voucherByEntry]);

  const periods = useMemo(() => [...new Set(vouchers.map((voucher) => voucher.period))].sort().reverse(), [vouchers]);
  const draftCount = vouchers.filter((voucher) => voucher.status === "draft").length;
  const generatedCount = entries.filter((entry) => voucherByEntry.has(entry.id)).length;

  async function generate(entry: CashFlowEntry) {
    setBusy(entry.id);
    try {
      const result = await apiPost<Voucher & { replayed?: boolean }>(`/finance/vouchers/from-cash-flow/${entry.id}`);
      notifySuccess(result.data.replayed
        ? `流水 ${entry.entryNo} 已有凭证 ${result.data.voucherNo}（重复生成不会重复建单）`
        : `已生成凭证 ${result.data.voucherNo}（草稿，确认无误后过账）`);
      await load();
      await openSheet(result.data.id);
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
        createdBy: voucher.createdBy ?? null,
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

  function editVoucher(voucher: Voucher) {
    const lineFields: ActionField[] = voucher.lines.flatMap((line) => [
      { name: `line_${line.lineNo}_subject`, label: `${directionLabel(line.direction)} · 第 ${line.lineNo} 行科目`, required: true, defaultValue: line.subjectLabel },
      { name: `line_${line.lineNo}_amount`, label: `${directionLabel(line.direction)} · 第 ${line.lineNo} 行金额`, type: "number", required: true, defaultValue: line.amount },
    ]);
    setDialog({
      title: `编辑凭证 ${voucher.voucherNo}`,
      fields: [
        { name: "summary", label: "摘要", required: true, defaultValue: voucher.summary },
        ...lineFields,
        { name: "remark", label: "备注", type: "textarea", defaultValue: voucher.remark ?? "" },
      ],
      submit: (values) => submitDialog(`/finance/vouchers/${voucher.id}`, {
        summary: values.summary,
        remark: values.remark || undefined,
        // 分录整组提交（方向保持不变，只改科目与金额）：后端要求借=贷，否则 422
        lines: voucher.lines.map((line) => ({
          direction: line.direction,
          subject_key: values[`line_${line.lineNo}_subject`],
          subject_label: values[`line_${line.lineNo}_subject`],
          summary: values.summary,
          amount: values[`line_${line.lineNo}_amount`],
        })),
      }, "凭证已更新", "patch"),
    });
  }

  function postVoucher(voucher: Voucher) {
    setDialog({
      title: `过账凭证：${voucher.voucherNo}`,
      fields: [{ name: "confirm", label: `过账后凭证不可再修改（只能红冲）。借方 ${voucher.debitTotal} / 贷方 ${voucher.creditTotal} ${voucher.currency}，确认过账？`, type: "info" as const }],
      submit: () => submitDialog(`/finance/vouchers/${voucher.id}/post`, undefined, `凭证 ${voucher.voucherNo} 已过账`),
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
      fields: [{ name: "confirm", label: "只有草稿可以删除；删除后该流水可重新生成凭证。确认删除？", type: "info" as const }],
      submit: () => submitDialog(`/finance/vouchers/${voucher.id}`, undefined, "草稿凭证已删除", "delete"),
    });
  }

  const entryColumns: ColumnDef<CashFlowEntry>[] = [
    { id: "date", header: "日期", cell: ({ row }) => day(row.original.entryDate) },
    { accessorKey: "entryNo", header: "流水号" },
    { id: "item", header: "收支项目", cell: ({ row }) => row.original.item?.label ?? "-" },
    { accessorKey: "counterpartyName", header: "对方名称" },
    { id: "direction", header: "收支", cell: ({ row }) => directionText(row.original.direction) },
    { id: "amount", header: "金额", cell: ({ row }) => money(row.original.amount, row.original.currency) },
    { id: "settlement", header: "结算方式", cell: ({ row }) => [row.original.settlementMethod, row.original.settlementAccount?.label].filter(Boolean).join("--") || "-" },
    { id: "voucher", header: "凭证", cell: ({ row }) => voucherByEntry.get(row.original.id)?.voucherNo ?? "未生成" },
    { id: "actions", header: "操作", cell: ({ row }) => {
      const voucher = voucherByEntry.get(row.original.id);
      if (row.original.status !== "posted") return <span className="panel-note">已冲销流水不可生成凭证</span>;
      return <div className="action-row">
        {voucher
          ? <Button size="sm" variant="ghost" onClick={() => void openSheet(voucher.id)}>查看凭证</Button>
          : <Button size="sm" variant="secondary" disabled={busy === row.original.id} onClick={() => void generate(row.original)}>生成凭证</Button>}
      </div>;
    } },
  ];

  const voucherColumns: ColumnDef<Voucher>[] = [
    { accessorKey: "voucherNo", header: "凭证号" },
    { id: "date", header: "日期", cell: ({ row }) => day(row.original.voucherDate) },
    { accessorKey: "period", header: "期间" },
    { id: "summary", header: "摘要", cell: ({ row }) => row.original.summary },
    { id: "debit", header: "借方合计", cell: ({ row }) => money(row.original.debitTotal, row.original.currency) },
    { id: "credit", header: "贷方合计", cell: ({ row }) => money(row.original.creditTotal, row.original.currency) },
    { id: "status", header: "状态", cell: ({ row }) => STATUS_LABELS[row.original.status] ?? row.original.status },
    { id: "source", header: "来源", cell: ({ row }) => row.original.source_entry
      ? `收支流水 ${row.original.source_entry.entryNo}`
      : row.original.counterpart_voucher ? `红冲 ${row.original.counterpart_voucher.voucherNo}` : "-" },
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">
      <Button size="sm" variant="ghost" onClick={() => void openSheet(row.original.id)}>凭证纸</Button>
      {row.original.status === "draft" && <>
        <Button size="sm" variant="ghost" onClick={() => editVoucher(row.original)}>编辑</Button>
        <Button size="sm" variant="secondary" onClick={() => postVoucher(row.original)}>过账</Button>
        <Button size="sm" variant="destructive" onClick={() => deleteVoucher(row.original)}>删除</Button>
      </>}
      {row.original.status === "posted" && <Button size="sm" variant="destructive" onClick={() => reverseVoucher(row.original)}>红冲</Button>}
    </div> },
  ];

  if (loading) return <><PageHeader title="凭证管理" /><LoadingState /></>;

  return <div className="page-root" data-testid={testId}>
    <PageHeader title="凭证管理" description="从收支流水生成记账凭证：每条流水一张凭证（幂等），草稿可编辑、过账后只能红冲，凭证纸可直接打印或另存为 PDF。">
      <Button asChild variant="secondary"><Link href="/finance">返回财务</Link></Button>
    </PageHeader>
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    {!error && <>
      <section className="panel panel-body">
        <p className="panel-note" role="status" data-testid="voucher-policy-note">
          凭证是结构化分录，而不是一张图片：图片不可搜索、不可复制，改一个字就得重新生成。
          这里保存借贷分录，「凭证纸」按记账凭证版式排版，可「打印 / 另存 PDF」，也可「导出 PNG」直接存档或贴到聊天里。
          科目当前取自「收支项目」字典（资金科目按结算方式里的「现金」自动区分银行存款/库存现金），
          草稿阶段可在「编辑」里手工改成自己账套的科目名。
        </p>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>收支流水</h2>
          <span className="panel-note">共 {entries.length} 条 / 已生成凭证 {generatedCount} 条（生成是幂等的，重复点不会重复建单）</span>
        </div>
        <div className="panel-body">
          <div className="filter-bar">
            <label>搜索<Input data-testid="voucher-entry-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="流水号 / 对方名称 / 收支项目" /></label>
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
          <span className="panel-note">共 {vouchers.length} 张（草稿 {draftCount} 张）{periods.length ? `；期间 ${periods.join(" / ")}` : ""}；草稿可编辑/删除，已过账只能红冲</span>
        </div>
        <div className="panel-body"><DataTable columns={voucherColumns} data={vouchers} empty={<EmptyState title="还没有凭证：在上面的收支流水行点「生成凭证」" />} /></div>
      </section>
    </>}
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />
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
  </div>;
}

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
        {voucher.lines.map((line) => <tr key={line.id ?? line.lineNo} data-testid={`voucher-line-${line.lineNo}`}>
          <td>{line.summary || voucher.summary}</td>
          <td>{line.subjectLabel}</td>
          <td className="num">{line.direction === "debit" ? money(line.amount, voucher.currency) : ""}</td>
          <td className="num">{line.direction === "credit" ? money(line.amount, voucher.currency) : ""}</td>
        </tr>)}
        <tr className="voucher-sheet-total"><td colSpan={2}>合计</td><td className="num">{money(voucher.debitTotal, voucher.currency)}</td><td className="num">{money(voucher.creditTotal, voucher.currency)}</td></tr>
      </tbody>
    </table>
    <div className="voucher-sheet-sign"><span>制单：{voucher.createdBy ?? "—"}</span><span>审核：</span><span>记账：</span><span>单位负责人：</span></div>
    {voucher.remark ? <p className="panel-note">备注：{voucher.remark}</p> : null}
    {voucher.reversal_voucher ? <p className="panel-note">红冲凭证：{voucher.reversal_voucher.voucherNo}（{STATUS_LABELS[voucher.reversal_voucher.status] ?? voucher.reversal_voucher.status}）</p> : null}
  </div>;
}

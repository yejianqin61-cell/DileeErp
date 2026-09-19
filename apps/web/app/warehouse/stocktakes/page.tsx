"use client";

// 仓库 → 库存盘点（/warehouse/stocktakes）。
//
// 用户 2026-09-16：「仓库模块增加一个盘点管理，可以将每月一次的盘点数据导入系统，调整库存物料数量。
// 物料的产品代码作为唯一性，在新建物料时自动生成一个物料代码。物料导入模板，需要有这些 column：
// 产品名称 / 产品规格 / 产品代码 / 仓位 / 货位 / 实际数量」。
//
// 页面只做三件事（与后端口径一一对应，见 stocktake.service.ts 的注释）：
//   1. 导入：下载模板 → 上传 → 逐行结果（行级错误不连坐，找不到的产品代码逐行报出来）；
//   2. 校核：明细里改实盘数与差异原因、删行 —— 只有草稿能改；
//   3. 确认/冲销：确认按**确认当时的账面数**写库存调整（导入后仓库又发过料也不会被冲掉），
//      已确认的单子只能冲销，不能改也不能删。
//
// 数量一律按字符串原样展示与提交：前端不做 Number 累加（与全站金额/数量的约定一致），
// 跨单位的调增/调减也不合计（后端给的就是按单位分开的数）。
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { DataTable } from "../../../components/data/data-table";
import { FileInput } from "../../../components/ui/file-input";
import { Input } from "../../../components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiPatch, apiPost, apiRequest } from "../../../lib/api-client";
import { downloadFile } from "../../../lib/download";
import { fuzzyMatch } from "../../../lib/fuzzy-search";
import { shouldRefreshOnVisibility } from "../../../lib/refresh-policy";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";

type Stocktake = {
  id: string;
  stocktake_no: string;
  period_month: string;
  status: string;
  status_label: string;
  source_file_name: string | null;
  imported_at: string | null;
  confirmed_at: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
  remark: string | null;
  created_at: string;
  line_count: number;
  differing_line_count: number;
};

type StocktakeLine = {
  id: string;
  line_no: number;
  material_id: string;
  material_code: string;
  material_name: string;
  product_code: string;
  product_name: string;
  specification: string | null;
  warehouse_zone: string | null;
  bin_location: string | null;
  unit_id: string;
  unit_name: string;
  actual_quantity: string;
  book_quantity_snapshot: string;
  difference_snapshot: string;
  book_quantity_at_confirm: string | null;
  applied_quantity: string | null;
  difference_reason: string | null;
};

type StocktakeSummary = {
  line_count: number;
  differing_line_count: number;
  increased_line_count: number;
  decreased_line_count: number;
  applied_line_count: number;
  changed_after_import_count: number;
  differing_without_reason_count: number;
  units: Array<{ unit_id: string; unit_name: string; increase_quantity: string; decrease_quantity: string }>;
};

type StocktakeDetail = Stocktake & { lines: StocktakeLine[]; summary: StocktakeSummary };

/** 后端 `POST /stocktakes/import` 的 data（与「其他应付导入」同一套结果形状）。 */
type ImportResult = {
  status: "ok" | "partial" | "failed";
  total: number;
  imported: number;
  errorCount: number;
  headerRow: number;
  errors: Array<{ row: number; field?: string; reason: string }>;
  missingColumns: string[];
  ignoredColumns: string[];
  ignoredTrailingRows: number;
  hints: string[];
  stocktakeId: string | null;
  stocktakeNo: string | null;
};

/** 确认盘点的回报：哪几行在导入之后账面又变了（用户必须看得到，否则不知道为什么差异和文件里不一样）。 */
type ConfirmResult = {
  adjusted: number;
  unchanged: number;
  changedAfterImport: Array<{ line_no: number; product_code: string; book_quantity_snapshot: string; book_quantity_at_confirm: string }>;
  differingWithoutReason: Array<{ line_no: number; product_code: string; difference_quantity: string }>;
};

type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => Promise<void> };

const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);
const currentMonth = () => new Date().toISOString().slice(0, 7);
const dateTime = (value: string | null) => (value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-");
/** 差异着色：盘盈绿、盘亏橙（0 不着色）。带符号展示，避免「5」看不出方向。 */
const signed = (value: string) => (value.startsWith("-") ? value : `+${value}`);

export default function StocktakesPage() {
  const [stocktakes, setStocktakes] = useState<Stocktake[]>([]);
  const [detail, setDetail] = useState<StocktakeDetail | null>(null);
  const [openId, setOpenId] = useState("");
  const [detailBusy, setDetailBusy] = useState(false);
  const [month, setMonth] = useState(currentMonth());
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reversing, setReversing] = useState(false);
  const [reverseReason, setReverseReason] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const loadList = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) setLoading(true);
    setError("");
    try {
      const response = await apiGet<Stocktake[]>("/stocktakes");
      setStocktakes(response.data);
    } catch (cause) {
      setError(messageOf(cause, "盘点单加载失败"));
    } finally {
      if (!options.silent) setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetailBusy(true);
    try {
      const response = await apiGet<StocktakeDetail>(`/stocktakes/${id}`);
      setDetail(response.data);
    } catch (cause) {
      setError(messageOf(cause, "盘点明细加载失败"));
    } finally {
      setDetailBusy(false);
    }
  }, []);

  useEffect(() => { void loadList(); }, [loadList]);
  // 跨模块刷新：盘点表由别人导入/确认后，本页重新可见时要能自己更新（与原料仓储情况同一做法）。
  // 静默刷新（silent）不切整页 loading —— 否则会卸载正在编辑的弹窗，用户填的实盘数就丢了。
  useEffect(() => {
    const refresh = () => {
      if (!shouldRefreshOnVisibility(document.visibilityState)) return;
      void loadList({ silent: true });
      if (openId) void loadDetail(openId);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [loadList, loadDetail, openId]);

  /**
   * 打开某张盘点单的明细。
   *
   * `arm` 用来带出「确认/冲销」的待确认条：列表里的动作按钮与明细面板里的按钮必须是同一件事，
   * 否则从列表点「确认」还得在明细里再点一次才知道要点哪个键。
   */
  async function openStocktake(row: Stocktake, arm: "confirm" | "reverse" | null = null) {
    setOpenId(row.id);
    setConfirming(arm === "confirm");
    setReversing(arm === "reverse");
    setReverseReason("");
    setMessage("");
    await loadDetail(row.id);
  }

  async function refreshAll() {
    await loadList({ silent: true });
    if (openId) await loadDetail(openId);
  }

  /**
   * 下载模板。走 lib/download 的 fetch + blob（带鉴权 cookie，并从 Content-Disposition 解出中文文件名）——
   * 直接 <a href> 会丢掉 cookie，后端只回 401。
   */
  async function downloadTemplate() {
    try {
      await downloadFile("/api/v1/stocktakes/import-template.xlsx", "迪礼ERP-库存盘点导入模板.xlsx");
    } catch (cause) {
      notifyError(cause instanceof Error ? cause.message : "模板下载失败");
    }
  }

  /**
   * 上传盘点表。
   *
   * 上传的是 multipart（FormData），不能走 apiPost —— 那会把 body JSON 化。
   * 结果整份留在页面上（逐行错误 + 少哪些列 + 提示），不做成一条 toast：
   * 「第 7 行产品代码找不到」这类信息必须能逐条看清，否则操作员只能瞎猜。
   */
  async function importStocktake(file: File | undefined) {
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    setError("");
    setMessage("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("period_month", month);
      const response = await fetch("/api/v1/stocktakes/import", { method: "POST", credentials: "include", body: form });
      const body = await response.json();
      if (!response.ok || body.error) throw new ApiClientError(body.error?.code ?? "STOCKTAKE_IMPORT_FAILED", body.error?.message ?? "导入失败", body.error?.details ?? []);
      const result = body.data as ImportResult;
      setImportResult(result);
      await loadList({ silent: true });
      if (result.stocktakeId) await openStocktake({ id: result.stocktakeId, stocktake_no: result.stocktakeNo ?? "", period_month: month } as Stocktake);
      if (result.imported > 0) notifySuccess(`已导入 ${result.imported} 行进盘点草稿${result.errorCount ? `，${result.errorCount} 行未导入` : ""}`);
      else notifyError("没有可导入的行，请按下方逐行原因修改后重传");
    } catch (cause) {
      notifyError(messageOf(cause, "盘点表导入失败"));
    } finally {
      setImporting(false);
    }
  }

  /** 确认盘点：按确认当时的账面数写库存调整。必须点两次（第一次只是把确认条展开）。 */
  async function confirmStocktake() {
    if (!detail) return;
    setBusy("confirm");
    setError("");
    try {
      const response = await apiPost<ConfirmResult>(`/stocktakes/${detail.id}/confirm`, {});
      const result = response.data;
      const parts = [`盘点 ${detail.stocktake_no} 已确认：写库存调整 ${result.adjusted} 行，无差异 ${result.unchanged} 行`];
      if (result.changedAfterImport.length) parts.push(`${result.changedAfterImport.length} 行在导入之后账面有变动，已按确认当时的账面数调整`);
      if (result.differingWithoutReason.length) parts.push(`${result.differingWithoutReason.length} 行差异没有填原因`);
      setMessage(parts.join("；"));
      setConfirming(false);
      await refreshAll();
    } catch (cause) {
      setError(messageOf(cause, "盘点确认失败"));
    } finally {
      setBusy("");
    }
  }

  async function reverseStocktake() {
    if (!detail) return;
    setBusy("reverse");
    setError("");
    try {
      await apiPost(`/stocktakes/${detail.id}/reverse`, { reason: reverseReason.trim() });
      setMessage(`盘点 ${detail.stocktake_no} 已冲销：调整已按行反向写回`);
      setReversing(false);
      setReverseReason("");
      await refreshAll();
    } catch (cause) {
      setError(messageOf(cause, "盘点冲销失败"));
    } finally {
      setBusy("");
    }
  }

  async function deleteStocktake(row: Stocktake) {
    setBusy(row.id);
    setError("");
    try {
      await apiRequest(`/stocktakes/${row.id}`, { method: "DELETE" });
      setMessage(`盘点 ${row.stocktake_no} 已删除`);
      if (openId === row.id) { setOpenId(""); setDetail(null); }
      await loadList({ silent: true });
    } catch (cause) {
      setError(messageOf(cause, "盘点单删除失败"));
    } finally {
      setBusy("");
    }
  }

  /** 改一行的实盘数与差异原因。抛错留给 ActionDialog：弹窗不关、用户填的东西不丢。 */
  function editLine(line: StocktakeLine) {
    setDialog({
      title: `第 ${line.line_no} 行：${line.product_code} ${line.product_name}`,
      fields: [
        { name: "actual_quantity", label: `实盘数（${line.unit_name}，账面 ${line.book_quantity_snapshot}）`, type: "number", required: true, defaultValue: line.actual_quantity },
        { name: "difference_reason", label: "差异原因", type: "textarea", defaultValue: line.difference_reason ?? "" },
      ],
      submit: async (values) => {
        try {
          await apiPatch(`/stocktakes/lines/${line.id}`, { actual_quantity: values.actual_quantity, difference_reason: values.difference_reason ?? "" });
          notifySuccess("盘点行已更新");
          await refreshAll();
        } catch (cause) {
          notifyError(messageOf(cause, "盘点行更新失败"));
          throw cause;
        }
      },
    });
  }

  async function deleteLine(line: StocktakeLine) {
    setBusy(line.id);
    setError("");
    try {
      await apiRequest(`/stocktakes/lines/${line.id}`, { method: "DELETE" });
      notifySuccess(`第 ${line.line_no} 行已删除`);
      await refreshAll();
    } catch (cause) {
      setError(messageOf(cause, "盘点行删除失败"));
    } finally {
      setBusy("");
    }
  }

  const open = detail;
  const isDraft = open?.status === "draft";

  const stocktakeColumns: ColumnDef<Stocktake>[] = [
    { accessorKey: "stocktake_no", header: "盘点单号" },
    { accessorKey: "period_month", header: "盘点月份" },
    { id: "status", header: "状态", cell: ({ row }) => <span className={row.original.status === "confirmed" ? "status-success" : row.original.status === "reversed" ? "status-warning" : undefined}>{row.original.status_label}</span> },
    { accessorKey: "line_count", header: "明细数" },
    { id: "differing", header: "差异行数", cell: ({ row }) => row.original.differing_line_count ? <span className="status-warning">{row.original.differing_line_count}</span> : 0 },
    { id: "source", header: "来源文件", cell: ({ row }) => row.original.source_file_name ?? "-" },
    { id: "imported", header: "导入时间", cell: ({ row }) => dateTime(row.original.imported_at) },
    { id: "confirmed", header: "确认时间", cell: ({ row }) => dateTime(row.original.confirmed_at) },
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) => <div className="action-row">
        <Button size="sm" variant="secondary" onClick={() => void openStocktake(row.original)}>明细</Button>
        {row.original.status === "draft" && <>
          <Button size="sm" onClick={() => void openStocktake(row.original, "confirm")}>确认</Button>
          <Button size="sm" variant="ghost" disabled={busy === row.original.id} onClick={() => void deleteStocktake(row.original)}>删除</Button>
        </>}
        {row.original.status === "confirmed" && <Button size="sm" variant="destructive" onClick={() => void openStocktake(row.original, "reverse")}>冲销</Button>}
      </div>
    },
  ];

  const lineColumns: ColumnDef<StocktakeLine>[] = [
    { accessorKey: "line_no", header: "行号" },
    { accessorKey: "product_code", header: "产品代码" },
    { accessorKey: "product_name", header: "产品名称" },
    { id: "specification", header: "产品规格", cell: ({ row }) => row.original.specification || "-" },
    { id: "zone", header: "仓位", cell: ({ row }) => row.original.warehouse_zone || "-" },
    { id: "bin", header: "货位", cell: ({ row }) => row.original.bin_location || "-" },
    { accessorKey: "unit_name", header: "单位" },
    { accessorKey: "book_quantity_snapshot", header: "导入时账面" },
    { accessorKey: "actual_quantity", header: "实盘数" },
    { id: "difference", header: "导入时差异", cell: ({ row }) => row.original.difference_snapshot === "0" ? "0" : <span className={row.original.difference_snapshot.startsWith("-") ? "status-warning" : "status-success"}>{signed(row.original.difference_snapshot)}</span> },
    { id: "bookAtConfirm", header: "确认时账面", cell: ({ row }) => row.original.book_quantity_at_confirm ?? "-" },
    { id: "applied", header: "已应用调整", cell: ({ row }) => row.original.applied_quantity === null ? "-" : row.original.applied_quantity === "0" ? "0" : <span className={row.original.applied_quantity.startsWith("-") ? "status-warning" : "status-success"}>{signed(row.original.applied_quantity)}</span> },
    { id: "reason", header: "差异原因", cell: ({ row }) => row.original.difference_reason || "-" },
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) => isDraft
        ? <div className="action-row">
          <Button size="sm" variant="secondary" onClick={() => editLine(row.original)}>改实盘数</Button>
          <Button size="sm" variant="ghost" disabled={busy === row.original.id} onClick={() => void deleteLine(row.original)}>删行</Button>
        </div>
        : <span className="panel-note">已确认</span>
    },
  ];

  // 搜索只影响展示，不影响上面的计数与动作（与「原料仓储情况」同一做法）。
  const filteredStocktakes = useMemo(() => stocktakes.filter((row) => fuzzyMatch(query, [
    row.stocktake_no, row.period_month, row.status_label, row.source_file_name, row.remark,
  ])), [stocktakes, query]);
  const filteredLines = useMemo(() => (open?.lines ?? []).filter((row) => fuzzyMatch(query, [
    row.line_no, row.product_code, row.product_name, row.specification, row.warehouse_zone, row.bin_location,
    row.unit_name, row.difference_reason, row.actual_quantity,
  ])), [open, query]);

  if (loading) return <><PageHeader title="库存盘点"><Button asChild variant="secondary"><Link href="/warehouse">返回仓库</Link></Button></PageHeader><LoadingState /></>;

  return (
    <div className="page-root" data-testid="page-warehouse-stocktakes">
      <PageHeader title="库存盘点">
        <Button asChild variant="secondary"><Link href="/warehouse">返回仓库</Link></Button>
        <Button variant="secondary" onClick={() => void loadList()}>刷新</Button>
      </PageHeader>
      <ActionDialog open={Boolean(dialog)} onOpenChange={(value) => { if (!value) setDialog(null); }} title={dialog?.title ?? "盘点明细"} fields={dialog?.fields ?? []} onSubmit={async (values) => { await dialog?.submit(values); setDialog(null); }} />
      {message && <section className="panel panel-body status-success" role="status" data-testid="stocktake-message">{message}</section>}
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void loadList()} /></section>}

      <section className="panel">
        <div className="panel-heading"><h2>导入盘点表</h2></div>
        <div className="panel-body">
          <div className="filter-bar">
            <label>盘点月份<Input type="month" data-testid="stocktake-month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
            <Button size="sm" variant="secondary" data-testid="stocktake-import-template" onClick={() => void downloadTemplate()}>下载模板</Button>
            <FileInput accept=".xlsx,.xls" data-testid="stocktake-import-file" disabled={importing || !month} onChange={(event) => { void importStocktake(event.target.files?.[0]); event.currentTarget.value = ""; }} />
          </div>
          {importing && <LoadingState label="正在导入" />}
          {importResult && <div className="panel-body" data-testid="stocktake-import-result">
            <p data-testid="stocktake-import-count">共 {importResult.total} 行：入库 {importResult.imported} 行 / 错误 {importResult.errorCount} 行{importResult.stocktakeNo ? `（盘点单 ${importResult.stocktakeNo}）` : ""}</p>
            {importResult.missingColumns.length > 0 && <p className="status-error">缺少必需列：{importResult.missingColumns.join("、")}</p>}
            {importResult.ignoredColumns.length > 0 && <p>以下列不属于盘点口径，已忽略：{importResult.ignoredColumns.join("、")}</p>}
            {importResult.ignoredTrailingRows > 0 && <p>表尾 {importResult.ignoredTrailingRows} 行未识别为数据，已跳过</p>}
            {importResult.hints.map((hint) => <p key={hint} className="panel-note">{hint}</p>)}
            {importResult.errors.length > 0 && <DataTable columns={[
              { accessorKey: "row", header: "行号" },
              { accessorKey: "field", header: "字段", cell: ({ row }) => row.original.field ?? "-" },
              { accessorKey: "reason", header: "原因" },
            ]} data={importResult.errors} empty={null} />}
          </div>}
          {!importResult && !importing && <p className="panel-note">模板 6 列：产品名称 / 产品规格 / 产品代码 / 仓位 / 货位 / 实际数量。「产品代码」= 物料清单里的物料编码（新建物料时自动生成），匹配忽略大小写与空格；找不到的代码逐行报错，不会自动新建物料。导入只生成盘点草稿，确认后才写库存调整。</p>}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>盘点单</h2>
          {query ? <span className="panel-note">筛选后 {filteredStocktakes.length} / {stocktakes.length} 张</span> : null}
        </div>
        <div className="panel-body">
          <div className="filter-bar">
            <label>搜索<Input data-testid="stocktake-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="盘点单号 / 月份 / 状态 / 来源文件，或明细里的产品代码、名称、仓位、货位" /></label>
            {query && <Button variant="secondary" onClick={() => setQuery("")}>清除搜索</Button>}
          </div>
          <DataTable
            columns={stocktakeColumns}
            data={filteredStocktakes}
            onRowDoubleClick={(row) => void openStocktake(row)}
            rowTitle="双击查看明细"
            empty={<EmptyState title="暂无盘点单" description="选择盘点月份、下载模板、填写实盘数后上传，系统会生成一张盘点草稿单。" />}
          />
        </div>
      </section>

      {open && (
        <section className="panel" data-testid="stocktake-detail">
          <div className="panel-heading">
            <h2>{open.stocktake_no} · {open.period_month} · {open.status_label}</h2>
            <div className="page-actions">
              {isDraft && <Button data-testid="stocktake-confirm" onClick={() => { setConfirming(true); setReversing(false); }}>确认盘点</Button>}
              {open.status === "confirmed" && <Button variant="destructive" data-testid="stocktake-reverse-arm" onClick={() => { setReversing(true); setConfirming(false); }}>冲销</Button>}
              <Button variant="secondary" onClick={() => { setOpenId(""); setDetail(null); setConfirming(false); setReversing(false); }}>关闭</Button>
            </div>
          </div>
          <div className="panel-body">
            <p data-testid="stocktake-detail-meta">来源文件 {open.source_file_name ?? "-"}；导入 {dateTime(open.imported_at)}；确认 {dateTime(open.confirmed_at)}{open.reversal_reason ? `；冲销原因 ${open.reversal_reason}` : ""}</p>
            <p data-testid="stocktake-summary">明细 {open.summary.line_count} 行：差异 {open.summary.differing_line_count} 行（盘盈 {open.summary.increased_line_count} / 盘亏 {open.summary.decreased_line_count}），已应用调整 {open.summary.applied_line_count} 行，导入后账面有变动 {open.summary.changed_after_import_count} 行，差异无原因 {open.summary.differing_without_reason_count} 行</p>
            {open.summary.units.length > 0 && <p className="panel-note" data-testid="stocktake-unit-summary">按单位调增/调减（不做跨单位合计）：{open.summary.units.map((unit) => `${unit.unit_name} +${unit.increase_quantity} / -${unit.decrease_quantity}`).join("；")}</p>}
            {confirming && isDraft && <div className="action-row" data-testid="stocktake-confirm-bar">
              <span className="panel-note">确认后按确认当时的账面数写库存调整（差异 {(open.summary.differing_line_count)} 行）；已确认的单子只能冲销，不能改</span>
              <Button disabled={busy === "confirm"} onClick={() => void confirmStocktake()}>{busy === "confirm" ? "确认中..." : "确认"}</Button>
              <Button variant="secondary" disabled={busy === "confirm"} onClick={() => setConfirming(false)}>取消</Button>
            </div>}
            {reversing && open.status === "confirmed" && <div className="action-row" data-testid="stocktake-reverse-bar">
              <Input data-testid="stocktake-reverse-reason" value={reverseReason} onChange={(event) => setReverseReason(event.target.value)} placeholder="冲销原因（必填）" />
              <Button variant="destructive" disabled={busy === "reverse" || !reverseReason.trim()} onClick={() => void reverseStocktake()}>{busy === "reverse" ? "冲销中..." : "冲销"}</Button>
              <Button variant="secondary" disabled={busy === "reverse"} onClick={() => { setReversing(false); setReverseReason(""); }}>取消</Button>
            </div>}
            {detailBusy && <LoadingState label="正在加载明细" />}
            <DataTable
              columns={lineColumns}
              data={filteredLines}
              empty={<EmptyState title="这张盘点单没有明细行" />}
            />
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-heading"><h2>盘点口径</h2></div>
        <div className="panel-body">
          <p className="panel-note">账面数 = 该物料的原料库存（raw_material + scrap 两个分类的净额），与「原料仓储情况 → 库存汇总」同一个口径。</p>
          <p className="panel-note">差异 = 实盘数 − 确认当时的账面数。导入与确认之间仓库又发生领料/入库时，按确认当时重算，那笔真实收发不会被盘点单冲掉；导入时的账面数作为快照保留，供逐行对照。</p>
          <p className="panel-note">一个产品代码在一份表里只能出现一行：多个仓位请把数量相加后填一行（库存按物料记一本账）。</p>
          <p className="panel-note">仓位 / 货位 只作为盘点行的记录，本系统不按库位分账；盘点覆盖原料/物料，成品库存按生产单与产品名称快照记账，没有产品代码。</p>
          <p className="panel-note">当前盘点单 {stocktakes.length} 张，其中草稿 {stocktakes.filter((item) => item.status === "draft").length} 张、已确认 {stocktakes.filter((item) => item.status === "confirmed").length} 张、已冲销 {stocktakes.filter((item) => item.status === "reversed").length} 张。</p>
        </div>
      </section>
    </div>
  );
}

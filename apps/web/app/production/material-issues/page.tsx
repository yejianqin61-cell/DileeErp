"use client";

// 生产模块 - 领料单 / 补料单
//
// 层级：订单号 → 生产单 → 单据。领料单与补料单都只绑定生产单（领料单一个生产单可有多张），
// 因此页面把三层作为列展示，并支持两种导出：
//   单张：每行「导出领料单」→ 一个工作表，与用户给定的模板一致；
//   批量：按当前筛选一次导出多张 → 每张领料单一个工作表。
// 导出接口与现有生产导出一致，仅管理员可用（非管理员会收到后端 403 提示）。
//
// 出库已改为两步：草稿不再直接过账出库（那会由生产单方面单方扣减原料库存），
// 必须先「确认提交」（draft → pending_outbound）等仓库「确认出库」（pending_outbound → posted）才写库存事实。
// 本页同时是仓库的「原料流转」入口，所以待出库行也可以在这里直接确认出库 / 撤回提交。

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../../components/ui/select";
import { SearchableSelect } from "../../../components/ui/searchable-select";
import { DataTable } from "../../../components/data/data-table";
import { auditColumns, auditDetailFields, type AuditRow } from "../../../components/data/audit-columns";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { RecordDetailDialog, type DetailField } from "../../../components/finance/record-detail-dialog";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../../lib/api-client";
// 搜索语义全站统一（空格分词的 AND、忽略大小写与空白、空查询不过滤），见 lib/fuzzy-search.ts。
import { fuzzyMatch } from "../../../lib/fuzzy-search";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { downloadFile } from "../../../lib/download";
// 时间统一走 lib/audit-time（固定北京时间）：toLocaleString 按运行宿主时区走。
import { formatBeijingShort } from "../../../lib/audit-time";
import { movementEditorHref, postMovementPath } from "../../../lib/material-slip-api";
import { MaterialSlipLinesTable, type SlipDocument } from "../../../components/production/material-slip-lines-table";
// 打印件（2026-11-02）：纸面版式与导出 xlsx 同一份数据（`slip-document`），只在屏幕上渲染。
import { MaterialSlipPrintSheet } from "../../../components/production/material-slip-print-sheet";
import type { MaterialSlipPrint } from "../../../lib/material-slip-print";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";

type MovementLine = { id: string; materialId: string; quantity: string; remark?: string | null; unit?: { name: string } | null; material?: { materialCode?: string; name: string; specificationModel?: string | null } | null };
type Issue = AuditRow & {
  id: string;
  movementNo: string;
  documentType: string;
  status: string;
  orderNo: string;
  productionOrderId: string;
  productionOrderOperationId?: string | null;
  productionOrder?: { productionOrderNo: string; orderNo: string } | null;
  productionOrderOperation?: { operationNameSnapshot: string } | null;
  businessDate?: string;
  submittedAt?: string | null;
  reason?: string | null;
  remark?: string | null;
  createdAt: string;
  lines: MovementLine[];
};
type ProductionOrder = { id: string; productionOrderNo: string; orderNo: string; operations?: Array<{ id: string; operationNameSnapshot: string; status: string }> };

const statusLabels: Record<string, string> = { draft: "草稿", pending_outbound: "待仓库出库", posted: "已过账", reversed: "已冲销" };
// 领料单与补料单都是挂在生产单下的原料出库单据，版式不同但层级一致。
const typeLabels: Record<string, string> = { issue: "领料单", replenishment: "补料单", return: "退料单", scrap: "报废单", reversal: "冲销单" };
const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const idempotencyKey = () => `web-movement-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * 「领料单 / 补料单」列表（11 列）的声明宽度，**总和 86%**：剩下 14% 留给 `auditColumns()` 的
 * 「创建人 / 最后修改人」（工厂列不给宽度，浏览器把那 14% 均分给它们，约 7% 一列，够放「姓名 + 时间」两行）。
 *
 * 每个数字的来历（估算基准：1366 屏内容宽 1034px）：
 *   - 物料明细 16%（=165px）：`lines.map(line => \`名称 × 数量单位\`).join("、")`（193 行）把整单物料拼成一条长串，
 *     是全表最长的自由文本 —— 宽度给它，它才不会把别的列挤窄（省略 + hover 看全文）；
 *   - 单据号 9%（=93px）/ 生产单号 9% / 订单号 8%：编号型文本，够显示前缀；
 *   - 操作 18%（=186px）：这一列在 draft 状态下要同时渲染 6 个按钮（导出 / 编辑 / 确认提交 / 删除 /
 *     再建领料单 / 再建补料单，197 行），按「每个小按钮 44px + 间距 4px」估需要 6×44 + 5×4 = 284px，
 *     18% 只放得下 4 个 —— 放不下时按钮折成两行。这是刻意取舍：把宽度让给「物料明细」，
 *     也不让这一格吃掉整张表的 1/3（同一取舍见采购物料清单页的「图片 / 操作」两列）；
 *   - 类型 5% / 数量合计 6% / 登记时间 8% / 状态 7%：短列（领料单·补料单 / 数字 / 日期 / 状态词），
 *     按 4%~8% 区间取值。
 */
const ISSUE_COLUMN_WIDTH = {
  orderNo: "8%",
  productionOrder: "9%",
  documentType: "5%",
  movementNo: "9%",
  status: "7%",
  lines: "16%",
  total: "6%",
  createdAt: "8%",
  actions: "18%",
} as const;

/**
 * 详情弹窗里「领用物料（N 项）」小表的列，已挪到 components/production/material-slip-lines-table：
 * 那张表的列名、列宽、四个数量的口径必须与打印件一致，不能在本页再写一份。
 * （2026-10-29：本页原来的 6 列没有配料/已领/本次/余下，与纸面对不上。）
 */

export default function MaterialIssuesPage() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [orderNo, setOrderNo] = useState("");
  const [productionOrderId, setProductionOrderId] = useState("all");
  const [status, setStatus] = useState("all");
  const [documentType, setDocumentType] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> } | null>(null);
  // 双击行弹出的详情：列表行只有 materialId，物料编码/名称/规格型号要按 id 单独拉一次详情接口；
  // 明细数量另取「与打印件同源」的 slip-document（导出服务的组装结果），页面不再自己算。
  const [detailId, setDetailId] = useState("");
  const [detail, setDetail] = useState<Issue | null>(null);
  const [slipDocument, setSlipDocument] = useState<SlipDocument | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailNonce, setDetailNonce] = useState(0);
  /**
   * 打印视图（2026-11-02）：`GET /production/material-movements/:id/slip-document` 的完整单据。
   *
   * 明细四个数量与导出的 xlsx 同源 —— 页面不自己再算一遍（2026-10-29 那次「页面与纸面对不上」的教训）。
   */
  const [printSlip, setPrintSlip] = useState<MaterialSlipPrint | null>(null);
  const [printLoading, setPrintLoading] = useState(false);

  // 确认提交：草稿 → 待仓库出库。只改状态不写库存，所以没有幂等键；
  // 需要幂等键的是仓库端的「确认出库」，那一步才会真正扣减原料库存。
  async function submit(slip: Issue) {
    setBusy(slip.id);
    try { await apiPost(`/production/material-movements/${slip.id}/submit`, {}); notifySuccess("已提交仓库，等待确认出库"); await load(); onChanged(); }
    catch (cause) { notifyError(messageOf(cause, "提交失败")); }
    finally { setBusy(""); }
  }

  // 仓库确认出库：待仓库出库 → 已过账，这一步才写原料库存事实（服务端要求生产单为「生产中」的厂内单）。
  // 补料单走 post-replenishment：本页同时列出领料单与补料单，写死 /post 会让补料单过账 422。
  async function confirmOutbound(slip: Issue) {
    setBusy(slip.id);
    try { await apiPost(postMovementPath(slip.documentType, slip.id), { idempotency_key: idempotencyKey() }); notifySuccess(`${typeLabels[slip.documentType] ?? "单据"}已确认出库`); await load(); onChanged(); }
    catch (cause) { notifyError(messageOf(cause, "确认出库失败")); }
    finally { setBusy(""); }
  }
  async function removeDraft(slip: Issue) {
    setBusy(slip.id);
    try { await apiRequest(`/production/material-movements/${slip.id}`, { method: "DELETE" }); notifySuccess("草稿已删除"); await load(); onChanged(); }
    catch (cause) { notifyError(messageOf(cause, "删除失败")); }
    finally { setBusy(""); }
  }
  function reopen(slip: Issue) { setDialog({ title: `重新打开：${slip.movementNo}`, fields: [{ name: "reason", label: "重新打开原因", type: "textarea", required: true }], submit: (values) => void act(`/production/material-movements/${slip.id}/reopen`, { reason: values.reason }, "已重新打开为草稿") }); }
  /** 撤回提交：单据还停在待仓库出库（尚无库存事实），reopen 只把它退回草稿，不需要冲销。 */
  function withdraw(slip: Issue) { setDialog({ title: `撤回提交：${slip.movementNo}`, fields: [{ name: "reason", label: "撤回原因", type: "textarea", required: true }], submit: (values) => void act(`/production/material-movements/${slip.id}/reopen`, { reason: values.reason }, "已撤回提交，单据回到草稿") }); }
  function reverse(slip: Issue) { setDialog({ title: `冲销：${slip.movementNo}`, fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }], submit: (values) => void act(`/production/material-movements/${slip.id}/reverse`, { reason: values.reason, idempotency_key: idempotencyKey() }, "已冲销") }); }
  async function act(path: string, body: unknown, success: string) {
    setBusy("action");
    try { await apiPost(path, body); notifySuccess(success); setDialog(null); await load(); onChanged(); }
    catch (cause) { notifyError(messageOf(cause, "操作失败")); }
    finally { setBusy(""); }
  }
  function onChanged() {
    // 领料出库会改变库存与生产进度：通知已打开该生产单的页面重新拉取。
    if (typeof window !== "undefined") window.dispatchEvent(new Event("dilee:material-movement-changed"));
  }

  async function load() {
    setLoading(true); setError("");
    try {
      const [movements, production] = await Promise.all([
        apiGet<Issue[]>("/production/material-movements"),
        apiGet<ProductionOrder[]>("/production/orders")
      ]);
      setIssues(movements.data.filter((item) => ["issue", "replenishment"].includes(item.documentType)));
      setOrders(production.data);
    } catch (cause) { setError(messageOf(cause, "领料单加载失败")); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  // 详情弹窗打开时按 :id 拉一次：列表行给不出物料编码/规格型号与提交时间。
  // slip-document 与详情一起取：单据头来自 :id，明细四个数量来自导出服务的组装结果，
  // 两者缺一个都显示不完整，所以统一进同一个 loading/error，避免「半个弹窗」。
  useEffect(() => {
    if (!detailId) { setDetail(null); setSlipDocument(null); return; }
    let cancelled = false;
    setDetailLoading(true); setDetailError("");
    Promise.all([
      apiGet<Issue>(`/production/material-movements/${detailId}`),
      apiGet<SlipDocument>(`/production/material-movements/${detailId}/slip-document`),
    ])
      .then(([movement, slip]) => { if (!cancelled) { setDetail(movement.data); setSlipDocument(slip.data); } })
      .catch((cause) => { if (!cancelled) setDetailError(messageOf(cause, "单据详情加载失败")); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [detailId, detailNonce]);
  useEffect(() => {
    // 深链：生产单详情点「查看领料/补料单」带着 production_order_id 过来时直接按该生产单过滤。
    const target = new URLSearchParams(window.location.search).get("production_order_id");
    if (target) setProductionOrderId(target);
  }, []);

  /**
   * 关键字搜索（2026-11-13，用户：「统计所有下拉列表，所有表单是否都有搜索功能搜索框，如果没有，
   * 都需要加上搜索功能。因为现在单子多了，查找比较麻烦」）。
   *
   * 上面那排是**条件**筛选（订单号精确包含/生产单/状态/类型/日期区间）；这一格是「我记得是领料单、
   * 单号里有这个尾巴」这种模糊查找。可搜：订单号 / 生产单号 / 类型 / 单据号 / 状态 / 业务日期 ——
   * 都是这张表看得见的列。**不动导出**：导出的仍是上面那排条件，避免「看到的」与「导出的」不是同一批
   * 这件事又多一种解释（本页顶部那条注释就是为这件事写的）。
   */
  const [keyword, setKeyword] = useState("");
  const visible = useMemo(() => issues.filter((item) => {
    if (orderNo && !item.orderNo.toLowerCase().includes(orderNo.toLowerCase())) return false;    if (productionOrderId !== "all" && item.productionOrderId !== productionOrderId) return false;
    if (status !== "all" && item.status !== status) return false;
    if (documentType !== "all" && item.documentType !== documentType) return false;
    const businessDate = (item.businessDate ?? item.createdAt ?? "").slice(0, 10);
    if (from && businessDate < from) return false;
    if (to && businessDate > to) return false;
    return fuzzyMatch(keyword, [
      item.orderNo, item.productionOrder?.productionOrderNo, typeLabels[item.documentType] ?? item.documentType,
      item.movementNo, statusLabels[item.status] ?? item.status, businessDate,
    ]);
  }).sort((left, right) => `${left.orderNo}|${left.productionOrder?.productionOrderNo ?? ""}|${left.createdAt}`
    .localeCompare(`${right.orderNo}|${right.productionOrder?.productionOrderNo ?? ""}|${right.createdAt}`)), [issues, orderNo, productionOrderId, status, documentType, from, to, keyword]);

  // 导出参数与页面筛选完全一致，避免"看到的"和"导出的"不是同一批。
  function exportQuery() {
    const params = new URLSearchParams();
    if (documentType !== "all") params.set("document_type", documentType);
    if (orderNo) params.set("order_no", orderNo);
    if (productionOrderId !== "all") params.set("production_order_id", productionOrderId);
    if (status !== "all") params.set("status", status);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }
  // 单张导出：后端按单据类型自动套用领料单/补料单模板。
  async function exportOne(slip: Issue) {
    setBusy(slip.id);
    const label = typeLabels[slip.documentType] ?? "单据";
    try { await downloadFile(`/api/v1/production/reports/material-issue.xlsx?movement_id=${encodeURIComponent(slip.id)}`, `${label}-${slip.movementNo}.xlsx`); notifySuccess(`已导出 ${slip.movementNo}`); }
    catch (cause) { notifyError(messageOf(cause, "导出失败")); }
    finally { setBusy(""); }
  }
  async function exportAll() {
    if (!visible.length) { setError("当前筛选没有可导出的单据"); return; }
    setBusy("all");
    try { await downloadFile(`/api/v1/production/reports/material-slips.xlsx?${exportQuery()}`, "领料补料单汇总.xlsx"); notifySuccess(`已导出 ${visible.length} 张单据`); }
    catch (cause) { notifyError(messageOf(cause, "批量导出失败")); }
    finally { setBusy(""); }
  }
  /**
   * 打开打印视图（2026-11-02）。
   *
   * 只取 `slip-document`（导出服务组装的完整单据），屏幕上就是那张纸；`window.print()` 只留它
   * （见 globals.css 的 @media print）。加载/失败都留在弹窗里说清楚：打不出这张单，车间就领不到料。
   */
  async function openPrint(slip: Issue) {
    setPrintLoading(true);
    setPrintSlip(null);
    try {
      const result = await apiGet<MaterialSlipPrint>(`/production/material-movements/${slip.id}/slip-document`);
      setPrintSlip(result.data);
    } catch (cause) {
      notifyError(messageOf(cause, "打印数据加载失败"));
    } finally {
      setPrintLoading(false);
    }
  }

  const columns: ColumnDef<Issue>[] = [
    { accessorKey: "orderNo", header: "订单号", meta: { width: ISSUE_COLUMN_WIDTH.orderNo } },
    { id: "productionOrder", header: "生产单号", meta: { width: ISSUE_COLUMN_WIDTH.productionOrder }, cell: ({ row }) => row.original.productionOrder?.productionOrderNo ?? "-" },
    { id: "documentType", header: "类型", meta: { width: ISSUE_COLUMN_WIDTH.documentType }, cell: ({ row }) => typeLabels[row.original.documentType] ?? row.original.documentType },
    { accessorKey: "movementNo", header: "单据号", meta: { width: ISSUE_COLUMN_WIDTH.movementNo } },
    { id: "status", header: "状态", meta: { width: ISSUE_COLUMN_WIDTH.status }, cell: ({ row }) => statusLabels[row.original.status] ?? row.original.status },
    { id: "lines", header: "物料明细", meta: { width: ISSUE_COLUMN_WIDTH.lines }, cell: ({ row }) => row.original.lines.map((line) => `${line.material?.name ?? line.materialId} × ${line.quantity}${line.unit?.name ?? ""}`).join("、") || "-" },
    { id: "total", header: "数量合计", meta: { width: ISSUE_COLUMN_WIDTH.total }, cell: ({ row }) => row.original.lines.reduce((sum, line) => sum + Number(line.quantity), 0) },
    { accessorKey: "createdAt", header: "登记时间", meta: { width: ISSUE_COLUMN_WIDTH.createdAt }, cell: ({ row }) => formatBeijingShort(row.original.createdAt) || "-" },
    ...auditColumns<Issue>(),
    { id: "actions", header: "操作", meta: { width: ISSUE_COLUMN_WIDTH.actions }, cell: ({ row }) => { const slip = row.original; const busyRow = busy === slip.id; return <div className="page-actions"><Button size="sm" variant="secondary" disabled={busyRow} onClick={() => void exportOne(slip)}>{busyRow ? "导出中..." : "导出"}</Button><Button size="sm" variant="secondary" disabled={printLoading} data-testid={`material-slip-print-${slip.movementNo}`} onClick={() => void openPrint(slip)}>打印</Button>{slip.status === "draft" && <><Button size="sm" asChild variant="secondary"><Link href={movementEditorHref(slip.documentType, { movementId: slip.id })}>编辑</Link></Button><Button size="sm" disabled={busyRow} onClick={() => void submit(slip)}>确认提交</Button><Button size="sm" variant="ghost" disabled={busyRow} onClick={() => void removeDraft(slip)}>删除</Button></>}{slip.status === "pending_outbound" && <><Button size="sm" disabled={busyRow} onClick={() => void confirmOutbound(slip)}>确认出库</Button><Button size="sm" variant="secondary" disabled={busy === "action"} onClick={() => withdraw(slip)}>撤回提交</Button></>}{slip.status === "posted" && <><Button size="sm" variant="secondary" disabled={busy === "action"} onClick={() => reopen(slip)}>重新打开</Button><Button size="sm" variant="ghost" disabled={busy === "action"} onClick={() => reverse(slip)}>冲销</Button></>}<Button size="sm" asChild variant="ghost"><Link href={movementEditorHref("issue", { productionOrderId: slip.productionOrderId })} title="同一生产单可以开多张领料单">再建领料单</Link></Button><Button size="sm" asChild variant="ghost"><Link href={movementEditorHref("replenishment", { productionOrderId: slip.productionOrderId })} title="同一生产单可以开多张补料单">再建补料单</Link></Button></div>; } }
  ];

  const detailFields: DetailField[] = detail ? [
    { label: "单据号", value: detail.movementNo },
    { label: "类型", value: typeLabels[detail.documentType] ?? detail.documentType },
    { label: "状态", value: statusLabels[detail.status] ?? detail.status },
    { label: "业务日期", value: (detail.businessDate ?? detail.createdAt ?? "").slice(0, 10) },
    { label: "生产单号", value: detail.productionOrder?.productionOrderNo ?? "-" },
    { label: "订单号", value: detail.orderNo ?? detail.productionOrder?.orderNo ?? "-" },
    { label: "提交时间", value: formatBeijingShort(detail.submittedAt) || "-" },
    { label: "备注", value: detail.remark, wide: true },
    { label: "补料原因", value: detail.reason, wide: true },
    ...auditDetailFields(detail),
  ] : [];

  if (loading) return <><PageHeader title="领料单 / 补料单" /><LoadingState /></>;

  return <div className="page-root" data-testid="page-production-material-issues">
    <PageHeader title="领料单 / 补料单" description="两者都只绑定生产单（一个生产单可有多张领料单）。点「新建领料单 / 新建补料单」进入全屏编辑页选择该生产单订单 BOM 里的物料；草稿不再直接出库，改为「确认提交 → 仓库确认出库」两步：提交后进入「待仓库出库」，仓库确认出库才扣减原料库存；待出库可撤回提交，已过账可重新打开或冲销。每行可「打印」（A4 纸面单据，浏览器打印 / 另存 PDF）或「导出」Excel，两者是同一份数据。双击任意一行可查看该单的全部领用物料。">
      <Button asChild variant="secondary"><Link href="/production">返回生产单</Link></Button>
      <Button asChild><Link href={movementEditorHref("issue")}>新建领料单</Link></Button>
      <Button asChild variant="secondary"><Link href={movementEditorHref("replenishment")}>新建补料单</Link></Button>
      <Button onClick={() => void exportAll()} disabled={busy === "all" || !visible.length}>{busy === "all" ? "导出中..." : `批量导出（${visible.length} 张）`}</Button>
    </PageHeader>
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { void dialog?.submit(values); }} />
    <section className="panel">
      <div className="panel-heading"><h2>筛选</h2></div>
      <div className="panel-body"><div className="filter-bar">
        <label>订单号<Input value={orderNo} onChange={(event) => setOrderNo(event.target.value)} placeholder="输入订单号" /></label>
        <label>生产单<SearchableSelect value={productionOrderId} options={[{ value: "all", label: "全部生产单" }, ...orders.map((order) => ({ value: order.id, label: `${order.productionOrderNo} / ${order.orderNo}` }))]} placeholder="全部生产单" label="生产单" searchPlaceholder="搜索生产单号或订单号" noResultsText="没有匹配的生产单" onChange={setProductionOrderId} /></label>
        <label>类型<Select value={documentType} onValueChange={setDocumentType}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部类型</SelectItem><SelectItem value="issue">领料单</SelectItem><SelectItem value="replenishment">补料单</SelectItem></SelectContent></Select></label>
        <label>状态<Select value={status} onValueChange={setStatus}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="draft">草稿</SelectItem><SelectItem value="pending_outbound">待仓库出库</SelectItem><SelectItem value="posted">已过账</SelectItem></SelectContent></Select></label>
        <label>起始日期<Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>结束日期<Input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        {/* 关键字（2026-11-13）：上面的条件是精确筛选，这一格才是「记得单号里有这个尾巴」的查找。 */}
        <label>搜索单号、订单号、生产单号或状态
          <Input data-testid="material-issue-search" value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="输入关键词，空格分隔多个词" />
        </label>
        {keyword.trim() ? <Button variant="secondary" onClick={() => setKeyword("")}>清除搜索</Button> : null}
      </div></div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>领料单 / 补料单</h2><span className="panel-note">共 {visible.length} 张{keyword.trim() ? `（关键字筛选后）` : ""}（同一生产单可开多张领料单与补料单，行内「再建领料单/再建补料单」可直接续开）</span></div>
      <div className="panel-body"><DataTable columns={columns} data={visible} empty={keyword.trim() ? <EmptyState title={`没有匹配“${keyword.trim()}”的单据`} description={`当前条件下共 ${visible.length} 张，换个关键词或清空搜索框。`} /> : <EmptyState title="暂无单据" description="点右上角「新建领料单 / 新建补料单」进入全屏编辑页创建；两者都只需要选择生产单，物料从该订单 BOM 明细中选。" />} onRowDoubleClick={(slip) => setDetailId(slip.id)} rowTitle="双击查看领用物料" /></div>
    </section>
    {/* 双击弹出的详情：把这一条单据的全部领用物料列出来，而不是只给「N 项」的合计。 */}
    <RecordDetailDialog
      open={Boolean(detailId)}
      onOpenChange={(open) => { if (!open) setDetailId(""); }}
      title={`${typeLabels[detail?.documentType ?? "issue"] ?? "单据"}详情：${detail?.movementNo ?? ""}`}
      description="双击单据行打开的详情：展示本条单据的全部领用物料与提交信息。"
      fields={detailFields}
      sections={detail && slipDocument ? [{ title: `领用物料（${slipDocument.document.lines.length} 项）`, content: <MaterialSlipLinesTable slip={slipDocument} /> }] : []}
      loading={detailLoading}
      error={detailError}
      onRetry={() => setDetailNonce((value) => value + 1)}
      testId="material-slip-detail"
    />
    {/* 打印视图（2026-11-02）：屏幕上是这张纸，打印时只留它。数据与「导出」同一个 slip-document。 */}
    <Dialog open={printLoading || Boolean(printSlip)} onOpenChange={(open) => { if (!open) { setPrintSlip(null); setPrintLoading(false); } }}>
      <DialogContent className="material-slip-dialog" data-testid="material-slip-print-dialog">
        <DialogHeader><DialogTitle>领料单 / 补料单打印</DialogTitle></DialogHeader>
        <DialogBody>
          {printLoading ? <LoadingState label="正在生成单据" /> : printSlip ? <MaterialSlipPrintSheet slip={printSlip} /> : null}
        </DialogBody>
        <DialogFooter>
          <div className="action-row">
            <Button variant="secondary" onClick={() => setPrintSlip(null)}>关闭</Button>
            <Button data-testid="material-slip-print-confirm" disabled={!printSlip} onClick={() => window.print()}>打印 / 另存 PDF</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

"use client";

// 生产单成品存量与成品入库通知面板。
//
// 业务口径（用户确认）：
// - 包装工序（工序名称含「包装」）是每个生产单的收尾工序，默认要有；
// - 包装累计报工量就是「可通知入库」的数量，可以边生产边分批通知，不必等包装全部完成；
// - 仓库按通知送检/QC，QC 合格量再入库；本面板只负责生产侧的报工量→通知→进度展示。
import { useEffect, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "../ui/button";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { DataTable } from "../data/data-table";
import { auditColumns, type AuditRow } from "../data/audit-columns";
import { EmptyState } from "../feedback/states";
import { ApiClientError, apiGet, apiPost } from "../../lib/api-client";
import { shouldRefreshOnVisibility } from "../../lib/refresh-policy";
import { notifyError, notifySuccess } from "../ui/toaster";

type PackagingOperation = { id: string; name: string; sequence_no: number; target_quantity: string; status: string };
type Notice = AuditRow & {
  id: string; noticeNo: string; noticeDate: string; batchNo?: string | null; status: string;
  noticeQuantity: string; submittedQuantity: string; qcQualifiedQuantity: string; qcRejectedQuantity: string;
  inboundDraftQuantity: string; inboundPostedQuantity: string; availableSubmissionQuantity: string; remainingForInbound: string;
  operationNameSnapshot: string; unitNameSnapshot: string;
};
type Summary = {
  production_order_id: string; production_order_no: string; order_no: string; execution_mode: string; status: string;
  planned_quantity: string; unit_name: string; packaging_operation: PackagingOperation | null;
  packaging_reported_quantity: string; notified_quantity: string; available_notice_quantity: string;
  submitted_quantity: string; qc_qualified_quantity: string; inbound_draft_quantity: string; inbound_posted_quantity: string;
  finished_goods_stock: string; defective_goods_stock: string; outbound_quantity: string; customer_return_quantity: string;
  notice_count: number; notices: Notice[];
};

const noticeStatusLabels: Record<string, string> = { pending: "待送检", partially_inbound: "入库中", completed: "已完成", cancelled: "已取消" };
const number = (value: string | undefined) => Number(value ?? 0);
const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

/**
 * 「入库通知（分批）」表（13 列 = 11 个业务列 + `auditColumns()` 的「创建人 / 最后修改人」两列）的列宽。
 *
 * 业务列声明宽度**合计恰好 84%**，剩下 16% 留给那两列审计列 —— 它们不给宽度
 * （改工厂用法会让 `lib/audit-columns-coverage.test.mjs` 的守卫失守），由固定布局按剩余空间分配。
 *
 * 估算基准（与仓库其它页同一套）：1366 屏内容宽 1034px（1% = 10.34px），
 * 数据格 Arial 13px + 左右内边距 24px，表头 12px 加粗 + 24px。逐列的来历见下面每一条。
 *
 * 取舍：这张表 11 列要摊 84%，平均每列 7.6%，所以「数量 / 日期 / 短状态取 4%~6%」的通则
 * 在这里没法全部照办 —— 11 列都按 4%~5% 只摊得出 61%，与「总和恰好 84%」互相矛盾。
 * 因此长文本列压到 9%~11%（≥7%），短列取 6%~7%（它们各自的表头本身就要 5.8%~7.0%）。
 */
const COLUMN_WIDTH = {
  // 通知单号（如 FG-IN-20261009-001）：整张表唯一的长文本列，给最宽的一档。
  noticeNo: "11%",
  // 批次号：与通知单号同量级的短编码（"B20261009-01" 约 14 字符 = 93px ≈ 9%）。
  batch: "9%",
  // 通知日期：定长 10 字符（2026-10-09），Arial 13px 下 66.5px + 24px 内边距 = 90.5px ≈ 8.8%，
  // 给 9% 才不会截成「2026-10-…」；这也是本表唯一超出「日期列 4%~6%」的一列。
  date: "9%",
  // 通知数量：表头 4 个汉字 = 48px + 24px ≈ 7.0%，值还要带上单位快照（"120 个"）。
  quantity: "7%",
  // 已送检 / 待送检：表头 3 个汉字 = 36px + 24px ≈ 5.8%，值是纯数字，给 7% 留余量。
  submittedQuantity: "7%",
  availableSubmissionQuantity: "7%",
  // QC 合格：表头「QC 合格」两个拉丁字母 + 两个汉字 ≈ 60px + 24px ≈ 8.1%，
  // 数值列统一取 7%（表头放不下时省略、hover 看全）。
  qcQualifiedQuantity: "7%",
  // 在途入库：表头 4 个汉字 ≈ 7.0%，与「通知数量」同一档。
  inboundDraftQuantity: "7%",
  // 已入库：表头 3 个汉字 ≈ 5.8%。
  inboundPostedQuantity: "6%",
  // 状态：标签是三个汉字（待送检 / 入库中 / 已完成 / 已取消）= 36px + 24px ≈ 5.8%。
  status: "6%",
  // 操作：最多同时 1 个按钮 —— 只有「未送检且未取消」的行才渲染「取消」，其余渲染 null，
  // 44px + 内边距 ≈ 6.6%，按规则的下限取 8%。
  actions: "8%",
} as const;

export function FinishedGoodsPanel({ productionOrderId, executionMode, orderStatus, onChanged }: { productionOrderId: string; executionMode: string; orderStatus: string; onChanged?: () => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> } | null>(null);
  const loadedOnce = useRef(false);

  async function load() {
    try {
      const result = await apiGet<Summary>(`/production/orders/${productionOrderId}/finished-goods-summary`);
      setSummary(result.data);
      setError("");
    } catch (cause) {
      setError(messageOf(cause, "成品存量加载失败"));
    } finally {
      loadedOnce.current = true;
    }
  }

  useEffect(() => { void load(); }, [productionOrderId]);
  // 报工/领料等操作会改变包装累计量，本页重新可见或收到生产变更事件时刷新。
  useEffect(() => {
    const refresh = () => { if (shouldRefreshOnVisibility(document.visibilityState)) void load(); };
    const operationChanged = () => void load();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("production-order-operation-updated", operationChanged);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("production-order-operation-updated", operationChanged); };
  }, [productionOrderId]);

  async function createNotice(values: Record<string, string>) {
    try {
      await apiPost("/production/finished-goods-inbound-notices", { production_order_id: productionOrderId, notice_quantity: values.notice_quantity, notice_date: values.notice_date, batch_no: values.batch_no || undefined, remark: values.remark || undefined });
      notifySuccess("成品入库通知已发出，仓库可按通知送检/质检");
      setDialog(null);
      await load();
      onChanged?.();
    } catch (cause) {
      notifyError(messageOf(cause, "成品入库通知创建失败"));
    }
  }

  function openNotice() {
    if (!summary) return;
    setDialog({ title: "新建成品入库通知", fields: [
      { name: "notice_quantity", label: "通知数量", type: "number", required: true, defaultValue: summary.available_notice_quantity, placeholder: `可通知 ${summary.available_notice_quantity}` },
      { name: "notice_date", label: "通知日期", type: "date", required: true, defaultValue: new Date().toISOString().slice(0, 10) },
      { name: "batch_no", label: "批次号", type: "text", placeholder: "可选，例如 B1" },
      { name: "remark", label: "备注", type: "textarea", placeholder: "可选" },
    ], submit: (values) => void createNotice(values) });
  }

  function cancelNotice(notice: Notice) {
    setDialog({ title: `取消入库通知：${notice.noticeNo}`, fields: [{ name: "reason", label: "取消原因", type: "textarea", required: true }], submit: async (values) => {
      try {
        await apiPost(`/production/finished-goods-inbound-notices/${notice.id}/cancel`, { reason: values.reason });
        notifySuccess("入库通知已取消");
        setDialog(null);
        await load();
        onChanged?.();
      } catch (cause) {
        notifyError(messageOf(cause, "取消失败"));
      }
    } });
  }

  async function ensurePackaging() {
    try {
      const result = await apiPost<{ created: boolean; operation: PackagingOperation }>(`/production/orders/${productionOrderId}/packaging-operation`, {});
      notifySuccess(result.data.created ? "已补建包装工序" : "该生产单已有包装工序");
      await load();
      onChanged?.();
    } catch (cause) {
      notifyError(messageOf(cause, "补建包装工序失败"));
    }
  }

  const noticeColumns: ColumnDef<Notice>[] = [
    { accessorKey: "noticeNo", header: "通知单", meta: { width: COLUMN_WIDTH.noticeNo } },
    { id: "batch", header: "批次", meta: { width: COLUMN_WIDTH.batch }, cell: ({ row }: { row: { original: Notice } }) => row.original.batchNo ?? "-" },
    { id: "date", header: "通知日期", meta: { width: COLUMN_WIDTH.date }, cell: ({ row }: { row: { original: Notice } }) => row.original.noticeDate.slice(0, 10) },
    { id: "quantity", header: "通知数量", meta: { width: COLUMN_WIDTH.quantity }, cell: ({ row }: { row: { original: Notice } }) => `${row.original.noticeQuantity} ${row.original.unitNameSnapshot}` },
    { accessorKey: "submittedQuantity", header: "已送检", meta: { width: COLUMN_WIDTH.submittedQuantity } },
    { accessorKey: "availableSubmissionQuantity", header: "待送检", meta: { width: COLUMN_WIDTH.availableSubmissionQuantity } },
    { accessorKey: "qcQualifiedQuantity", header: "QC 合格", meta: { width: COLUMN_WIDTH.qcQualifiedQuantity } },
    { accessorKey: "inboundDraftQuantity", header: "在途入库", meta: { width: COLUMN_WIDTH.inboundDraftQuantity } },
    { accessorKey: "inboundPostedQuantity", header: "已入库", meta: { width: COLUMN_WIDTH.inboundPostedQuantity } },
    { accessorKey: "status", header: "状态", meta: { width: COLUMN_WIDTH.status }, cell: ({ row }: { row: { original: Notice } }) => noticeStatusLabels[row.original.status] ?? row.original.status },
    // 通知行是嵌套在成品入库汇总里的数组，姓名由 finished-goods-inbound-notices.service 显式补好
    // （响应出口的拦截器只处理顶层行）。
    ...auditColumns<Notice>(),
    // 已有送检记录的通知后端不允许取消（会 422），这里直接不给按钮，避免必然失败的操作。
    { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.actions }, cell: ({ row }: { row: { original: Notice } }) => row.original.status === "cancelled" || Number(row.original.submittedQuantity ?? 0) > 0 ? null : <Button size="sm" variant="ghost" onClick={() => cancelNotice(row.original)}>取消</Button> },
  ];

  const packaging = summary?.packaging_operation ?? null;
  const canNotice = executionMode === "in_house" && ["in_progress", "completed"].includes(orderStatus) && number(summary?.available_notice_quantity) > 0;

  return <>
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { dialog?.submit(values); }} />
    <section className="panel">
      <div className="panel-heading">
        <h2>成品存量与入库通知</h2>
        <div className="page-actions">
          <Button variant="secondary" onClick={() => void ensurePackaging()} disabled={executionMode !== "in_house"}>{packaging ? "确认包装工序" : "补建包装工序"}</Button>
          <Button onClick={openNotice} disabled={!canNotice}>发成品入库通知</Button>
          <Button variant="ghost" onClick={() => void load()}>刷新</Button>
        </div>
      </div>
      {error && <p className="status-error panel-body" role="alert">{error}</p>}
      {!summary ? <div className="panel-body">正在加载成品存量…</div> : <>
        <div className="panel-body">
          {!packaging && <p className="status-warning">该生产单还没有包装（收尾）工序：请先「补建包装工序」，否则无法通知成品入库。</p>}
          <div className="daily-report-summary">
            <span><small>包装工序</small><strong>{packaging ? `${packaging.name}（第 ${packaging.sequence_no} 道）` : "未建立"}</strong></span>
            <span><small>包装累计报工</small><strong>{summary.packaging_reported_quantity}</strong></span>
            <span><small>已通知入库</small><strong>{summary.notified_quantity}</strong></span>
            <span><small>可通知入库</small><strong>{summary.available_notice_quantity}</strong></span>
            <span><small>已送检</small><strong>{summary.submitted_quantity}</strong></span>
            <span><small>QC 合格</small><strong>{summary.qc_qualified_quantity}</strong></span>
            <span><small>在途入库</small><strong>{summary.inbound_draft_quantity}</strong></span>
            <span><small>已入库</small><strong>{summary.inbound_posted_quantity}</strong></span>
            <span><small>成品存量</small><strong>{summary.finished_goods_stock}</strong></span>
            <span><small>次品存量</small><strong>{summary.defective_goods_stock}</strong></span>
            <span><small>已出库</small><strong>{summary.outbound_quantity}</strong></span>
            <span><small>客户退货</small><strong>{summary.customer_return_quantity}</strong></span>
          </div>
          <p className="panel-note">单位：{summary.unit_name}；包装工序按「工序名称包含 包装」认定，其累计报工量即为可通知入库上限（可分批、边生产边通知）。</p>
        </div>
        <div className="panel-body">
          <h3>入库通知（分批）</h3>
          <DataTable columns={noticeColumns} data={summary.notices} empty={<EmptyState title="暂无入库通知" description="包装工序累计报工后，点「发成品入库通知」按批次通知仓库送检/入库。" />} />
        </div>
      </>}
    </section>
  </>;
}

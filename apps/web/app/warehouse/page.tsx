"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../components/layout/app-shell";
import { Button } from "../../components/ui/button";
import { DataTable } from "../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../components/feedback/states";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../lib/api-client";
// 时间统一走 lib/audit-time（固定北京时间）：toLocaleString 按**运行宿主**时区走，
// 导出在容器里跑、界面在浏览器里跑，两边会不一致。
import { formatBeijingShort } from "../../lib/audit-time";
import { postMovementPath } from "../../lib/material-slip-api";
import { auditColumns, type AuditRow } from "../../components/data/audit-columns";
import { notifyError, notifySuccess } from "../../components/ui/toaster";

type InboundNotice = AuditRow & { id: string; noticeNo: string; orderNo: string; status: string; notifiedQuantity: string; notifiedAt?: string | null; inbounds?: Array<{ id: string; status: string; quantity: string }>; purchaseOrder?: { purchaseOrderNo?: string }; purchaseReceipt?: { receiptNo?: string; quantity?: string }; purchaseOrderItem?: { material?: { name?: string; materialCode?: string }; unit?: { name?: string } } };
// 生产「确认提交」后送来的待出库单据（领料单 / 补料单）：仓库在这里确认出库才真正扣减原料库存。
type PendingOutbound = AuditRow & {
  id: string;
  movementNo: string;
  documentType: string;
  status: string;
  orderNo: string;
  productionOrderId: string;
  businessDate?: string | null;
  submittedAt?: string | null;
  reason?: string | null;
  remark?: string | null;
  createdAt: string;
  productionOrder?: { productionOrderNo: string; orderNo: string } | null;
  lines: Array<{ id: string; materialId: string; quantity: string; remark?: string | null; material?: { materialCode?: string; name: string; specificationModel?: string | null } | null; unit?: { name: string } | null }>;
};

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const typeLabels: Record<string, string> = { issue: "领料单", replenishment: "补料单" };
const idempotencyKey = () => `web-outbound-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * 仓库首页三张表的列宽（百分比）。
 *
 * 为什么需要：2026-10-09 起 `DataTable` 一律给 `<table>` 加 `data-table-fixed`
 * （components/data/data-table.tsx），`table-layout: fixed` 下**没写宽度的列由浏览器均分**容器宽度。
 * 「某列不受限把表顶宽」因此不会发生，但"均分"对这三张表是错的：`采购/到货`、`物料`（都是
 * `A / B` 两段拼串）与「物料明细」（整单明细摊成一格）跟「状态」「明细数」拿到一样宽 ——
 * 长的只能看到开头、短的留着大片空白。这里把宽度从"按列数均分"改成"按内容需要分配"。
 *
 * 总和为什么是 84% 而不是 100%：三张表都用 `auditColumns()` 追加「创建人 / 最后修改人」，
 * 那两列是工厂产物（`lib/audit-columns-coverage.test.mjs` 有守卫盯着用法）**不给宽度** ——
 * 声明 84% 正好把剩下的 16% 留给它们各 8%，与物料清单页（app/procurement/materials/page.tsx）
 * 的先例一致。多一个点就会让表比容器宽、把已经消掉的横向滚动条又拉回来。
 *
 * 每个数字的来历：
 *   - 长文本列 ≥8%（通知单号 / 采购·到货拼串 / 物料编码·名称拼串 / 订单号 / 单据号 / 生产单号）：
 *     内容是长度无界的字符串，给窄了就只能看到开头（省略号 + hover 全文兜底）；
 *   - 短列 4%~8%（通知时间 / 业务日期 / 提交时间 / 通知数量 / 状态 / 明细数 / 类型）：
 *     内容是固定形状的日期、数字或三字状态，超过 8% 是浪费；
 *   - `materialLines`（「待出库通知」的物料明细）14%：第 139 行把整单物料摊成一格
 *     （`物料名 × 数量单位`，多条用「、」连接），这串文本没有上界，是这张表最该宽的列；
 *     它的 cell 返回的就是一个字符串，`DataTable` 的省略 title 取得到全文；
 *   - 操作列 12%：三张表这一列都只渲染一个按钮，最长的文案是 6 个汉字
 *     （「接收入库通知」「补建入库草稿」），12px 字号下按钮约 92px + 单元格左右内边距 24px = 116px
 *     ≈ 11.2%，12% 留一点余量，按钮不会折行；
 *   - 「已接收但缺入库草稿」只有 5 个业务列，同样 84% 的预算摊到更少的列上，同名列必然更宽
 *     （18/19/19 对 12/14/14）—— 这是按需分配的结果，不是数字抄错了。
 */
const COLUMN_WIDTH = {
  // 三张表共用的列：同名列给同一个宽度，改一处三张表一起走，不容易漂。
  orderNo: "8%",
  quantity: "8%",
  status: "8%",
  actions: "12%",
  // 「待入库通知」（10 列 = 7 业务 + 2 审计 + 1 操作）
  noticeNo: "12%",
  notifiedAt: "8%",
  purchase: "14%",
  material: "14%",
  // 「待出库通知」（11 列 = 8 业务 + 2 审计 + 1 操作）
  movementNo: "12%",
  documentType: "6%",
  productionOrder: "10%",
  businessDate: "8%",
  materialLines: "14%",
  lineCount: "6%",
  submittedAt: "8%",
  // 「已接收但缺入库草稿」（8 列 = 5 业务 + 2 审计 + 1 操作）
  stuckNoticeNo: "18%",
  stuckPurchase: "19%",
  stuckMaterial: "19%",
} as const;

export default function WarehousePage() {
  const [inboundNotices, setInboundNotices] = useState<InboundNotice[]>([]);
  const [stuckNotices, setStuckNotices] = useState<InboundNotice[]>([]);
  const [pendingOutbounds, setPendingOutbounds] = useState<PendingOutbound[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      // 待出库通知单独兜底：该接口不可用时不能把整页（含待入库通知）一起打空。
      const [notices, pending] = await Promise.all([
        apiGet<InboundNotice[]>("/raw-material-inbound-notices"),
        apiGet<PendingOutbound[]>("/production/material-movements/pending-outbound").catch(() => ({ data: [] as PendingOutbound[], meta: {} })),
      ]);
      setInboundNotices(notices.data.filter((item) => item.status === "pending"));
      setStuckNotices(notices.data.filter((item) => ["acknowledged", "processing"].includes(item.status) && !(item.inbounds ?? []).length));
      setPendingOutbounds(pending.data);
    } catch (cause) {
      setError(messageOf(cause, "仓库数据加载失败"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function acknowledgeNotice(notice: InboundNotice) {
    setError("");
    try {
      await apiRequest(`/raw-material-inbound-notices/${notice.id}/acknowledge`, { method: "PATCH" });
      window.location.href = `/warehouse/raw-material-storage?notice_id=${encodeURIComponent(notice.id)}`;
    } catch (cause) {
      notifyError(messageOf(cause, "接收入库通知失败"));
    }
  }

  async function repairNotice(notice: InboundNotice) {
    setError("");
    try {
      await apiRequest(`/raw-material-inbound-notices/${notice.id}/acknowledge`, { method: "PATCH" });
      notifySuccess(`${notice.noticeNo} 已补建入库草稿`);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "补建入库草稿失败"));
    }
  }

  /**
   * 确认出库：pending_outbound → posted，这一步才真正写原料库存事实（生产端提交时不动库存）。
   * 必须带幂等键：重复点击若被当成两次出库，会把同一批料扣两遍。
   * 补料单走 post-replenishment（写死 /post 会被服务端判成「该单据不是领料单」422）。
   */
  async function confirmOutbound(movement: PendingOutbound) {
    setBusy(movement.id);
    try {
      await apiPost(postMovementPath(movement.documentType, movement.id), { idempotency_key: idempotencyKey() });
      notifySuccess(`${movement.movementNo} 已确认出库，原料库存已扣减`);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "确认出库失败"));
    } finally {
      setBusy("");
    }
  }

  const noticeStatusLabels: Record<string, string> = { pending: "待接收", acknowledged: "已接收", processing: "入库中", completed: "已完成", cancelled: "已取消" };

  const stuckColumns: ColumnDef<InboundNotice>[] = [
    { accessorKey: "noticeNo", header: "通知单号", meta: { width: COLUMN_WIDTH.stuckNoticeNo } },
    { id: "purchase", header: "采购/到货", meta: { width: COLUMN_WIDTH.stuckPurchase }, cell: ({ row }) => `${row.original.purchaseOrder?.purchaseOrderNo ?? "-"} / ${row.original.purchaseReceipt?.receiptNo ?? "-"}` },
    { id: "material", header: "物料", meta: { width: COLUMN_WIDTH.stuckMaterial }, cell: ({ row }) => `${row.original.purchaseOrderItem?.material?.materialCode ?? ""} / ${row.original.purchaseOrderItem?.material?.name ?? "-"}` },
    { id: "quantity", header: "通知数量", meta: { width: COLUMN_WIDTH.quantity }, cell: ({ row }) => `${row.original.notifiedQuantity} ${row.original.purchaseOrderItem?.unit?.name ?? ""}` },
    { accessorKey: "status", header: "状态", meta: { width: COLUMN_WIDTH.status }, cell: ({ row }) => noticeStatusLabels[row.original.status] ?? row.original.status },
    ...auditColumns<InboundNotice>(),
    { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.actions }, cell: ({ row }) => <Button size="sm" variant="secondary" onClick={() => void repairNotice(row.original)}>补建入库草稿</Button> },
  ];

  const noticeColumns: ColumnDef<InboundNotice>[] = [
    { accessorKey: "noticeNo", header: "通知单号", meta: { width: COLUMN_WIDTH.noticeNo } },
    { id: "notifiedAt", header: "通知时间", meta: { width: COLUMN_WIDTH.notifiedAt }, cell: ({ row }) => formatBeijingShort(row.original.notifiedAt) || "-" },
    { id: "purchase", header: "采购/到货", meta: { width: COLUMN_WIDTH.purchase }, cell: ({ row }) => `${row.original.purchaseOrder?.purchaseOrderNo ?? "-"} / ${row.original.purchaseReceipt?.receiptNo ?? "-"}` },
    { accessorKey: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.orderNo } },
    { id: "material", header: "物料", meta: { width: COLUMN_WIDTH.material }, cell: ({ row }) => `${row.original.purchaseOrderItem?.material?.materialCode ?? ""} / ${row.original.purchaseOrderItem?.material?.name ?? "-"}` },
    { id: "quantity", header: "通知数量", meta: { width: COLUMN_WIDTH.quantity }, cell: ({ row }) => `${row.original.notifiedQuantity} ${row.original.purchaseOrderItem?.unit?.name ?? ""}` },
    { accessorKey: "status", header: "状态", meta: { width: COLUMN_WIDTH.status }, cell: ({ row }) => noticeStatusLabels[row.original.status] ?? row.original.status },
    ...auditColumns<InboundNotice>(),
    { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.actions }, cell: ({ row }) => <Button size="sm" variant="secondary" onClick={() => void acknowledgeNotice(row.original)}>接收入库通知</Button> },
  ];

  const pendingOutboundColumns: ColumnDef<PendingOutbound>[] = [
    { accessorKey: "movementNo", header: "单据号", meta: { width: COLUMN_WIDTH.movementNo } },
    { id: "documentType", header: "类型", meta: { width: COLUMN_WIDTH.documentType }, cell: ({ row }) => typeLabels[row.original.documentType] ?? row.original.documentType },
    { id: "productionOrder", header: "生产单号", meta: { width: COLUMN_WIDTH.productionOrder }, cell: ({ row }) => row.original.productionOrder?.productionOrderNo ?? "-" },
    { id: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.orderNo }, cell: ({ row }) => row.original.orderNo ?? row.original.productionOrder?.orderNo ?? "-" },
    { id: "businessDate", header: "业务日期", meta: { width: COLUMN_WIDTH.businessDate }, cell: ({ row }) => (row.original.businessDate ?? row.original.createdAt ?? "").slice(0, 10) },
    // 仓库最关心「出哪些料、各多少」：把整单明细摊平成一格，多条用「、」连接。
    // 这一列是全表唯一没有长度上界的（14%），且 cell 返回字符串 —— 省略号与 hover 全文都成立。
    { id: "lines", header: "物料明细", meta: { width: COLUMN_WIDTH.materialLines }, cell: ({ row }) => row.original.lines.map((line) => `${line.material?.name ?? line.materialId} × ${line.quantity}${line.unit?.name ?? ""}`).join("、") || "-" },
    { id: "lineCount", header: "明细数", meta: { width: COLUMN_WIDTH.lineCount }, cell: ({ row }) => row.original.lines.length },
    { id: "submittedAt", header: "提交时间", meta: { width: COLUMN_WIDTH.submittedAt }, cell: ({ row }) => formatBeijingShort(row.original.submittedAt) || "-" },
    ...auditColumns<PendingOutbound>(),
    { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.actions }, cell: ({ row }) => <Button size="sm" disabled={busy === row.original.id} onClick={() => void confirmOutbound(row.original)}>{busy === row.original.id ? "出库中..." : "确认出库"}</Button> },
  ];

  if (loading) return <><PageHeader title="仓库" /><LoadingState /></>;

  return (
    <div className="page-root" data-testid="page-warehouse">
      <PageHeader title="仓库">
        <div className="page-actions">
          <Button asChild variant="secondary">
            <Link href="/warehouse/raw-material-storage">原料仓储情况</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/warehouse/finished-goods-storage">成品仓储情况</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/warehouse/stocktakes">库存盘点</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/production/material-issues">原料流转</Link>
          </Button>
          <Button asChild>
            <Link href="/production/material-issues/new">新建领料单</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/production/material-issues/new?type=replenishment">新建补料单</Link>
          </Button>
        </div>
      </PageHeader>

      {error && (
        <section className="panel">
          <ErrorState message={error} onRetry={() => void load()} />
        </section>
      )}

      <section className="panel">
        <div className="panel-heading">
          <h2>待入库通知 <span className="status-warning">{inboundNotices.length}</span></h2>
        </div>
        <div className="panel-body">
          <DataTable
            columns={noticeColumns}
            data={inboundNotices}
            empty={<EmptyState title="暂无待入库通知" description="触发条件：采购在【采购 → 登记到货】后，由【质检 → 来料质检】对已完成且未拒收的批次点击「通知入库」。这里只显示状态为待接收（pending）的通知；已接收的通知请到「原料仓储情况」继续登记入库。" />}
          />
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>待出库通知 <span className="status-warning">{pendingOutbounds.length}</span></h2>
        </div>
        <div className="panel-body">
          <DataTable
            columns={pendingOutboundColumns}
            data={pendingOutbounds}
            empty={<EmptyState title="暂无待出库通知" description="触发条件：生产在领料单上点「确认提交」后，这里会出现待出库通知；确认出库才会真正扣减原料库存。生产提交前不会扣料，撤回提交后通知也会消失。" />}
          />
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>原料流转单据</h2>
          <div className="page-actions">
            <Button variant="secondary" asChild>
              <Link href="/production/material-issues">查看全部领料单 / 补料单</Link>
            </Button>
          </div>
        </div>
        <div className="panel-body">
          <p className="panel-note">这里是待出库通知的快捷入口；完整的领料单 / 补料单（含草稿、已过账、已冲销与导出）在「原料流转」列表页。</p>
        </div>
      </section>

      {stuckNotices.length > 0 && (
        <section className="panel">
          <div className="panel-heading">
            <h2>已接收但缺入库草稿 <span className="status-error">{stuckNotices.length}</span></h2>
          </div>
          <div className="panel-body">
            <p className="panel-note">这些通知已经接收，但当时没有生成入库草稿（例如质检未完成或历史数据），因此「原料仓储情况」看不到待入库记录。点「补建入库草稿」即可修复；若质检确实还没完成，后端会给出明确提示。</p>
            <DataTable columns={stuckColumns} data={stuckNotices} empty={<EmptyState title="无" />} />
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-heading">
          <h2>质检</h2>
          <div className="page-actions">
            <Button variant="secondary" asChild>
              <Link href="/qc">进入质检模块</Link>
            </Button>
          </div>
        </div>
        <div className="panel-body">
          <p className="panel-note">成品送检与质检、来料质检、质检合格待入库与次品登记已统一迁到【质检】模块。</p>
        </div>
      </section>
    </div>
  );
}
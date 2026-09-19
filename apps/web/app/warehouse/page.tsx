"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../components/layout/app-shell";
import { Button } from "../../components/ui/button";
import { DataTable } from "../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../components/feedback/states";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../lib/api-client";
import { postMovementPath } from "../../lib/material-slip-api";
import { notifyError, notifySuccess } from "../../components/ui/toaster";

type InboundNotice = { id: string; noticeNo: string; orderNo: string; status: string; notifiedQuantity: string; notifiedAt?: string | null; inbounds?: Array<{ id: string; status: string; quantity: string }>; purchaseOrder?: { purchaseOrderNo?: string }; purchaseReceipt?: { receiptNo?: string; quantity?: string }; purchaseOrderItem?: { material?: { name?: string; materialCode?: string }; unit?: { name?: string } } };
// 生产「确认提交」后送来的待出库单据（领料单 / 补料单）：仓库在这里确认出库才真正扣减原料库存。
type PendingOutbound = {
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
    { accessorKey: "noticeNo", header: "通知单号" },
    { id: "purchase", header: "采购/到货", cell: ({ row }) => `${row.original.purchaseOrder?.purchaseOrderNo ?? "-"} / ${row.original.purchaseReceipt?.receiptNo ?? "-"}` },
    { id: "material", header: "物料", cell: ({ row }) => `${row.original.purchaseOrderItem?.material?.materialCode ?? ""} / ${row.original.purchaseOrderItem?.material?.name ?? "-"}` },
    { id: "quantity", header: "通知数量", cell: ({ row }) => `${row.original.notifiedQuantity} ${row.original.purchaseOrderItem?.unit?.name ?? ""}` },
    { accessorKey: "status", header: "状态", cell: ({ row }) => noticeStatusLabels[row.original.status] ?? row.original.status },
    { id: "actions", header: "操作", cell: ({ row }) => <Button size="sm" variant="secondary" onClick={() => void repairNotice(row.original)}>补建入库草稿</Button> },
  ];

  const noticeColumns: ColumnDef<InboundNotice>[] = [
    { accessorKey: "noticeNo", header: "通知单号" },
    { id: "notifiedAt", header: "通知时间", cell: ({ row }) => row.original.notifiedAt ? new Date(row.original.notifiedAt).toLocaleString("zh-CN") : "-" },
    { id: "purchase", header: "采购/到货", cell: ({ row }) => `${row.original.purchaseOrder?.purchaseOrderNo ?? "-"} / ${row.original.purchaseReceipt?.receiptNo ?? "-"}` },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "material", header: "物料", cell: ({ row }) => `${row.original.purchaseOrderItem?.material?.materialCode ?? ""} / ${row.original.purchaseOrderItem?.material?.name ?? "-"}` },
    { id: "quantity", header: "通知数量", cell: ({ row }) => `${row.original.notifiedQuantity} ${row.original.purchaseOrderItem?.unit?.name ?? ""}` },
    { accessorKey: "status", header: "状态", cell: ({ row }) => noticeStatusLabels[row.original.status] ?? row.original.status },
    { id: "actions", header: "操作", cell: ({ row }) => <Button size="sm" variant="secondary" onClick={() => void acknowledgeNotice(row.original)}>接收入库通知</Button> },
  ];

  const pendingOutboundColumns: ColumnDef<PendingOutbound>[] = [
    { accessorKey: "movementNo", header: "单据号" },
    { id: "documentType", header: "类型", cell: ({ row }) => typeLabels[row.original.documentType] ?? row.original.documentType },
    { id: "productionOrder", header: "生产单号", cell: ({ row }) => row.original.productionOrder?.productionOrderNo ?? "-" },
    { id: "orderNo", header: "订单号", cell: ({ row }) => row.original.orderNo ?? row.original.productionOrder?.orderNo ?? "-" },
    { id: "businessDate", header: "业务日期", cell: ({ row }) => (row.original.businessDate ?? row.original.createdAt ?? "").slice(0, 10) },
    // 仓库最关心「出哪些料、各多少」：把整单明细摊平成一格，多条用「、」连接。
    { id: "lines", header: "物料明细", cell: ({ row }) => row.original.lines.map((line) => `${line.material?.name ?? line.materialId} × ${line.quantity}${line.unit?.name ?? ""}`).join("、") || "-" },
    { id: "lineCount", header: "明细数", cell: ({ row }) => row.original.lines.length },
    { id: "submittedAt", header: "提交时间", cell: ({ row }) => row.original.submittedAt ? new Date(row.original.submittedAt).toLocaleString("zh-CN", { hour12: false }) : "-" },
    { id: "actions", header: "操作", cell: ({ row }) => <Button size="sm" disabled={busy === row.original.id} onClick={() => void confirmOutbound(row.original)}>{busy === row.original.id ? "出库中..." : "确认出库"}</Button> },
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
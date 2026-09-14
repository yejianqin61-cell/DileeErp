"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../components/layout/app-shell";
import { Button } from "../../components/ui/button";
import { DataTable } from "../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../components/feedback/states";
import { ApiClientError, apiGet, apiRequest } from "../../lib/api-client";
import { notifyError, notifySuccess } from "../../components/ui/toaster";

type InboundNotice = { id: string; noticeNo: string; orderNo: string; status: string; notifiedQuantity: string; notifiedAt?: string | null; inbounds?: Array<{ id: string; status: string; quantity: string }>; purchaseOrder?: { purchaseOrderNo?: string }; purchaseReceipt?: { receiptNo?: string; quantity?: string }; purchaseOrderItem?: { material?: { name?: string; materialCode?: string }; unit?: { name?: string } } };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

export default function WarehousePage() {
  const [inboundNotices, setInboundNotices] = useState<InboundNotice[]>([]);
  const [stuckNotices, setStuckNotices] = useState<InboundNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const notices = await apiGet<InboundNotice[]>("/raw-material-inbound-notices");
      setInboundNotices(notices.data.filter((item) => item.status === "pending"));
      setStuckNotices(notices.data.filter((item) => ["acknowledged", "processing"].includes(item.status) && !(item.inbounds ?? []).length));
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
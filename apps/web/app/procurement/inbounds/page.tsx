"use client";

import { useEffect, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { DataTable } from "../../../components/data/data-table";
import { auditColumns, type AuditRow } from "../../../components/data/audit-columns";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiRequest } from "../../../lib/api-client";
import { shouldRefreshOnVisibility } from "../../../lib/refresh-policy";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";

type Inbound = AuditRow & { id: string; inboundNo: string; orderNo: string; quantity: string; settlementUnitPrice?: string | null; settlementTotalAmount?: string | null; settlementAmountReason?: string | null; status: string; purchase_order_no?: string | null; receipt_no?: string | null; batch_sequence?: number | null; inspection_status?: string | null };
type PayableSource = { id: string; orderNo: string; amount: string; status: string; rawMaterialInboundId?: string | null; rawMaterialInbound?: { inboundNo?: string } };
type PayableEntry = { id: string; payableNo: string; payableSourceId?: string | null; status: string; amount: string; currency?: string };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
const inboundStatusLabels: Record<string, string> = { draft: "待入库登记", posted: "入库成功", reversed: "已冲销" };
// 来源状态：财务「接收应付」后后端会把 payable_sources.status 置为 received（历史数据可能缺失），
// 因此这里既给 received 的中文，也在下面用应付条目关联兜底显示「已通知」。
const payableStatusLabels: Record<string, string> = { pending_finance: "待通知财务", received: "财务已接收", draft: "待财务确认", confirmed: "财务已确认", partially_paid: "部分付款", paid: "已付款", reversed: "已冲回", voided: "已作废" };

export default function InboundsPage() {
  const [inbounds, setInbounds] = useState<Inbound[]>([]);
  const [payables, setPayables] = useState<PayableSource[]>([]);
  const [payableEntries, setPayableEntries] = useState<PayableEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void } | null>(null);

  async function load(options: { silent?: boolean } = {}) {
    if (!options.silent) setLoading(true);
    setError("");
    try {
      const [ib, payable, entries] = await Promise.all([
        apiGet<Inbound[]>("/raw-material-inbounds"),
        apiGet<PayableSource[]>("/payable-sources"),
        apiGet<PayableEntry[]>("/finance/payable-entries").catch(() => ({ data: [] as PayableEntry[], meta: {} })),
      ]);
      setInbounds(ib.data);
      setPayables(payable.data);
      setPayableEntries(entries.data);
    } catch (cause) {
      setError(messageOf(cause, "入库数据加载失败"));
    } finally {
      if (!options.silent) setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const refresh = () => { if (shouldRefreshOnVisibility(document.visibilityState)) void load({ silent: true }); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);

  async function action(path: string, body?: unknown, success = "操作已完成") {
    setError("");
    try {
      await apiRequest(path, { method: "POST", body: JSON.stringify(body) });
      notifySuccess(success);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "操作失败"));
    }
  }

  const payableSourcesOf = (inbound: Inbound) => payables.find((s) => s.rawMaterialInboundId === inbound.id);

  function editInbound(item: Inbound) {
    setDialog({
      title: "编辑原料入库单",
      fields: [
        { name: "quantity", label: "入库数量", type: "number", required: true, defaultValue: item.quantity },
        { name: "settlement_unit_price", label: "结算单价", type: "number", defaultValue: item.settlementUnitPrice ?? "" },
        { name: "settlement_total_amount", label: "结算总价", type: "number", defaultValue: item.settlementTotalAmount ?? "" },
        { name: "settlement_amount_reason", label: "金额差异原因", type: "textarea", defaultValue: item.settlementAmountReason ?? "" },
        { name: "remark", label: "备注", type: "textarea" },
      ],
      submit: (v) => void action(`/raw-material-inbounds/${item.id}`, {
        quantity: v.quantity,
        settlement_unit_price: v.settlement_unit_price || undefined,
        settlement_total_amount: v.settlement_total_amount || undefined,
        settlement_amount_reason: v.settlement_amount_reason || undefined,
        remark: v.remark || undefined,
      }, "原料入库单已更新"),
    });
  }

  function reverseInbound(item: Inbound) {
    setDialog({
      title: `冲销入库：${item.inboundNo}`,
      fields: [{ name: "reason", label: "冲销原因", required: true, type: "textarea" }],
      submit: (v) => void action(`/raw-material-inbounds/${item.id}/reverse`, { reason: v.reason }, "原料入库已冲销"),
    });
  }

  function notifyFinance(inbound: Inbound, source: PayableSource) {
    void action("/finance/payable-entries/from-source", { source_type: "raw_material_inbound", source_id: source.id, remark: `采购通知付款：${inbound.inboundNo}` }, "已通知财务付款");
  }

  const columns: ColumnDef<Inbound>[] = [
    { accessorKey: "inboundNo", header: "入库单号" },
    { accessorKey: "orderNo", header: "订单号" },
    { accessorKey: "purchase_order_no", header: "采购单号" },
    { id: "batch", header: "到货批次", cell: ({ row }) => `第 ${row.original.batch_sequence ?? "-"} 批` },
    { accessorKey: "receipt_no", header: "到货记录" },
    { accessorKey: "quantity", header: "数量" },
    { accessorKey: "inspection_status", header: "质检状态" },
    { accessorKey: "status", header: "入库状态", cell: ({ row }) => <span className={row.original.status === "posted" ? "status-success" : row.original.status === "reversed" ? "status-warning" : undefined}>{inboundStatusLabels[row.original.status] ?? row.original.status}</span> },
    { id: "payable", header: "应付来源", cell: ({ row }) => { const source = payableSourcesOf(row.original); return source ? `${source.amount}（${payableStatusLabels[source.status] ?? source.status}）` : "待过账生成"; } },
    {
      id: "finance", header: "财务付款",
      cell: ({ row }) => {
        const source = payableSourcesOf(row.original);
        const entry = source ? payableEntries.find((e) => e.payableSourceId === source.id) : undefined;
        if (entry) return <span className="status-success">已通知（{payableStatusLabels[entry.status] ?? entry.status}）</span>;
        if (row.original.status !== "posted" || !source) return <span className="panel-note">仓库入库成功后可通知</span>;
        return <Button size="sm" variant="secondary" onClick={() => notifyFinance(row.original, source)}>通知财务付款</Button>;
      },
    },
    ...auditColumns<Inbound>(),
    {
      id: "actions", header: "操作",
      cell: ({ row }) => (
        <div className="action-row">
          <Button size="sm" variant="secondary" onClick={() => editInbound(row.original)}>编辑</Button>
          {row.original.status === "posted" && <Button size="sm" variant="ghost" onClick={() => reverseInbound(row.original)}>冲销</Button>}
        </div>
      ),
    },
  ];

  if (loading) return <><PageHeader title="原料入库" breadcrumb={["采购", "原料入库"]} /><LoadingState /></>;

  return (
    <div className="page-root" data-testid="page-procurement-inbounds">
      <PageHeader title="原料入库" breadcrumb={["采购", "原料入库"]} description="入库登记和过账在仓库模块执行；本页展示跨模块状态与财务通知。">
        <div className="page-actions">
          <Button variant="secondary" asChild><Link href="/warehouse/raw-material-storage">去原料仓储过账</Link></Button>
          <Button variant="secondary" onClick={() => void load()}>刷新</Button>
        </div>
      </PageHeader>
      <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />
      {message && <section className="panel panel-body status-success" role="status">{message}</section>}
      {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
      <section className="panel">
        <div className="panel-body">
          <DataTable columns={columns} data={inbounds} empty={<EmptyState title="暂无入库记录" />} />
        </div>
      </section>
    </div>
  );
}
"use client";

// 质检合格待入库 + 次品登记（QC 模块）。
//
// 这两块原来是「仓库 → 成品仓储情况」里的两个区块：QC 合格量与不合格量都来自质检单，
// 属于质检结论的下游处理，所以随质检一起拆到 QC 模块；真正的库存单据（成品入库单的过账/冲销）
// 仍留在成品仓储情况页，本面板只负责按 QC 额度登记草稿并给出跳转入口。
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DataTable } from "../data/data-table";
import { auditColumns, type AuditRow } from "../data/audit-columns";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiGet, apiPost } from "../../lib/api-client";
import { displayStatus } from "../../lib/display-text";
import { emitQcDataChanged, subscribeQcDataChanged } from "./qc-refresh";
import { notifyError, notifySuccess } from "../ui/toaster";

type QcAvailable = AuditRow & { qc_id: string; qc_no: string; order_no: string; submission_id: string; source_type: string; qualified_quantity: string; conditional_accept_quantity: string; rejected_quantity: string; available_for_inbound_quantity: string; available_for_defective_quantity: string; unit?: string; conditionally_accepted?: boolean };
type Defective = AuditRow & { id: string; defectiveNo: string; orderNo: string; quantity: string; status: string; productNameSnapshot?: string | null };
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> };

const number = (value: string | undefined) => Number(value ?? 0);
const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

export function QcInboundPanel() {
  const [qcAvailable, setQcAvailable] = useState<QcAvailable[]>([]);
  const [defectives, setDefectives] = useState<Defective[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);

  async function load(options: { silent?: boolean } = {}) {
    if (!options.silent) setLoading(true);
    setError("");
    try {
      const [qcResult, defectiveResult] = await Promise.all([
        apiGet<QcAvailable[]>("/finished-goods/qc-records/available-inbound-sources"),
        apiGet<Defective[]>("/finished-goods/defectives"),
      ]);
      // 额度由后端按净值给出（扣掉草稿 + 已过账）；这里只留还有额度的质检单。
      setQcAvailable(qcResult.data.filter((row) => number(row.available_for_inbound_quantity) > 0 || number(row.available_for_defective_quantity) > 0));
      setDefectives(defectiveResult.data);
    } catch (cause) { setError(messageOf(cause, "质检待入库数据加载失败")); }
    finally { if (!options.silent) setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  // 同页其它面板（来料质检 / 成品质检）写入后，这里的可入库额度与次品记录跟着刷新。
  useEffect(() => subscribeQcDataChanged("qc-inbound", () => void load({ silent: true })), []);

  function run(path: string, body: unknown, success: string) {
    setError("");
    return apiPost(path, body)
      .then(async () => { notifySuccess(success); setMessage(success); setDialog(null); await load({ silent: true }); emitQcDataChanged("qc-inbound"); })
      .catch((cause) => { const text = messageOf(cause, "操作失败"); setError(text); notifyError(text); });
  }

  // 按订单号收束：订单一多，全量列表就没法用了。
  const visibleQc = useMemo(() => qcAvailable.filter((row) => !query.trim() || row.order_no.toLowerCase().includes(query.trim().toLowerCase())), [qcAvailable, query]);
  const visibleDefectives = useMemo(() => defectives.filter((row) => !query.trim() || row.orderNo.toLowerCase().includes(query.trim().toLowerCase())), [defectives, query]);

  function registerInbound(row: QcAvailable) {
    setDialog({ title: `成品入库登记：${row.qc_no}`, fields: [
      { name: "quantity", label: "本次入库数量", type: "number", required: true, defaultValue: row.available_for_inbound_quantity, placeholder: `QC 可入库 ${row.available_for_inbound_quantity}` },
      { name: "remark", label: "备注", type: "textarea", placeholder: "可选" },
    ], submit: (values) => void run("/finished-goods/inbounds", { qc_record_id: row.qc_id, quantity: values.quantity, remark: values.remark || undefined }, "成品入库单已登记（待过账）") });
  }

  function registerDefective(row: QcAvailable) {
    setDialog({ title: `次品登记：${row.qc_no}`, fields: [
      { name: "quantity", label: "本次登记次品数量", type: "number", required: true, defaultValue: row.available_for_defective_quantity, placeholder: `QC 不合格可登记 ${row.available_for_defective_quantity}` },
      { name: "remark", label: "备注", type: "textarea", placeholder: "可选" },
    ], submit: (values) => void run("/finished-goods/defectives", { qc_record_id: row.qc_id, quantity: values.quantity, remark: values.remark || undefined }, "次品记录已登记（待过账）") });
  }

  function reverseDefective(row: Defective) {
    setDialog({ title: `冲销次品记录：${row.defectiveNo}`, fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }], submit: (values) => void run(`/finished-goods/defectives/${row.id}/reverse`, { reason: values.reason }, "次品记录已冲销") });
  }

  const qcColumns: ColumnDef<QcAvailable>[] = [
    { accessorKey: "qc_no", header: "质检单" },
    { accessorKey: "order_no", header: "订单号" },
    { id: "qualified", header: "合格/条件合格", cell: ({ row }) => `${row.original.qualified_quantity} / ${row.original.conditional_accept_quantity}` },
    { id: "rejected", header: "不合格", cell: ({ row }) => row.original.rejected_quantity ?? "-" },
    { id: "unit", header: "单位", cell: ({ row }) => row.original.unit ?? "-" },
    { accessorKey: "available_for_inbound_quantity", header: "可入库（净值）" },
    { accessorKey: "available_for_defective_quantity", header: "可登记次品" },
    ...auditColumns<QcAvailable>(),
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">{number(row.original.available_for_inbound_quantity) > 0 ? <Button size="sm" variant="secondary" onClick={() => registerInbound(row.original)}>登记入库</Button> : null}{number(row.original.available_for_defective_quantity) > 0 ? <Button size="sm" variant="ghost" onClick={() => registerDefective(row.original)}>登记次品</Button> : null}</div> },
  ];
  const defectiveColumns: ColumnDef<Defective>[] = [
    { accessorKey: "defectiveNo", header: "次品单" },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "product", header: "成品", cell: ({ row }) => row.original.productNameSnapshot ?? "-" },
    { accessorKey: "quantity", header: "数量" },
    { id: "status", header: "状态", cell: ({ row }) => displayStatus(row.original.status) },
    ...auditColumns<Defective>(),
    { id: "actions", header: "操作", cell: ({ row }) => row.original.status === "draft" ? <Button size="sm" onClick={() => void run(`/finished-goods/defectives/${row.original.id}/post`, {}, "次品已过账")}>过账</Button> : row.original.status === "posted" ? <Button size="sm" variant="ghost" onClick={() => reverseDefective(row.original)}>冲销</Button> : null },
  ];

  return <section className="panel" style={{ gridColumn: "1 / -1" }}>
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { const current = dialog; void current?.submit(values); }} />
    <div className="panel-heading">
      <h2>质检合格待入库 / 次品登记</h2>
      <div className="page-actions">
        <Button variant="ghost" onClick={() => void load()}>刷新</Button>
      </div>
    </div>
    <div className="panel-body">
      <p className="panel-note">按 QC 合格量分批登记成品入库、按不合格量登记次品；过账后才计入库存。成品入库单的过账/冲销在【仓库 → 成品仓储情况】完成。</p>
      <div className="action-row">
        <Input value={query} placeholder="按订单号筛选" onChange={(event) => setQuery(event.target.value)} />
        <Button size="sm" variant="secondary" asChild><Link href="/warehouse/finished-goods-storage">去成品仓储情况过账入库</Link></Button>
      </div>
    </div>
    {message && <p className="status-success panel-body" role="status">{message}</p>}
    {error && <div className="panel-body" role="alert"><ErrorState message={error} onRetry={() => void load()} /></div>}
    <div className="panel-body">
      {loading ? <LoadingState /> : <>
        <h3>质检合格待入库</h3>
        <DataTable columns={qcColumns} data={visibleQc} empty={<EmptyState title={query.trim() ? "该订单号没有可入库/可登记次品的质检单" : "暂无可入库/可登记次品的质检单"} description="成品质检录入合格或不合格数量后，这里会出现可入库 / 可登记次品额度。" />} />
        <h3>次品记录</h3>
        <DataTable columns={defectiveColumns} data={visibleDefectives} empty={<EmptyState title={query.trim() ? "该订单号没有次品记录" : "暂无次品记录"} description="质检不合格数量在上方「登记次品」后在这里过账。" />} />
      </>}
    </div>
  </section>;
}

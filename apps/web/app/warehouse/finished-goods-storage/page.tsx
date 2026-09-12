"use client";

// 仓库成品存量管理：成品/次品存量、待入库通知（分批）、QC 合格待入库、成品入库单与成品出库单。
// 数据口径：库存储量取自库存事实聚合（/inventory/balances），入库/出库单据来自成品链路表。
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { DataTable } from "../../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../../lib/api-client";
import { shouldRefreshOnVisibility } from "../../../lib/refresh-policy";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";

type Balance = { category: string; unit_id: string; production_order_id: string | null; order_no: string | null; product_name: string | null; product_specification: string | null; quantity: string };
type Notice = { id: string; noticeNo: string; orderNo: string; batchNo?: string | null; noticeDate: string; status: string; noticeQuantity: string; submittedQuantity: string; qcQualifiedQuantity: string; inboundDraftQuantity: string; inboundPostedQuantity: string; availableSubmissionQuantity: string; remainingForInbound: string; operationNameSnapshot: string; unitNameSnapshot: string; productNameSnapshot?: string | null };
type QcAvailable = { qc_id: string; qc_no: string; order_no: string; submission_id: string; source_type: string; qualified_quantity: string; conditional_accept_quantity: string; rejected_quantity: string; available_for_inbound_quantity: string; available_for_defective_quantity: string; unit?: string; conditionally_accepted?: boolean };
type Inbound = { id: string; inboundNo: string; orderNo: string; quantity: string; status: string; productNameSnapshot?: string | null; qcRecord?: { qcNo?: string } | null; createdAt?: string };
type Defective = { id: string; defectiveNo: string; orderNo: string; quantity: string; status: string; productNameSnapshot?: string | null };
type Outbound = { id: string; outboundNo: string; orderNo: string; quantity: string; status: string; productNameSnapshot?: string | null };

const noticeStatusLabels: Record<string, string> = { pending: "待送检", partially_inbound: "入库中", completed: "已完成", cancelled: "已取消" };
const inboundStatusLabels: Record<string, string> = { draft: "待入库登记", posted: "入库成功", reversed: "已冲销" };
const outboundStatusLabels: Record<string, string> = { draft: "待出库", posted: "已出库", shipped: "已发出", signed: "已签收", reversed: "已冲销" };
const categoryLabels: Record<string, string> = { finished_goods: "成品", defective_goods: "次品" };
const number = (value: string | undefined) => Number(value ?? 0);
const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

export default function FinishedGoodsStoragePage() {
  const [orderNo, setOrderNo] = useState("");
  const [appliedOrderNo, setAppliedOrderNo] = useState("");
  const [finished, setFinished] = useState<Balance[]>([]);
  const [defective, setDefective] = useState<Balance[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [qcAvailable, setQcAvailable] = useState<QcAvailable[]>([]);
  const [inbounds, setInbounds] = useState<Inbound[]>([]);
  const [defectives, setDefectives] = useState<Defective[]>([]);
  const [outbounds, setOutbounds] = useState<Outbound[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> } | null>(null);

  async function load(targetOrderNo = appliedOrderNo) {
    setLoading(true);
    setError("");
    const scope = targetOrderNo ? `?order_no=${encodeURIComponent(targetOrderNo)}` : "";
    try {
      const [finishedResult, defectiveResult, noticeResult, qcResult, inboundResult, defectiveDocResult, outboundResult] = await Promise.all([
        apiGet<Balance[]>(`/inventory/balances?category=finished_goods${targetOrderNo ? `&order_no=${encodeURIComponent(targetOrderNo)}` : ""}`),
        apiGet<Balance[]>(`/inventory/balances?category=defective_goods${targetOrderNo ? `&order_no=${encodeURIComponent(targetOrderNo)}` : ""}`),
        apiGet<Notice[]>(`/finished-goods/inbound-notices${scope}`),
        apiGet<QcAvailable[]>(`/finished-goods/qc-records/available-inbound-sources${scope}`),
        apiGet<Inbound[]>(`/finished-goods/inbounds${scope}`),
        apiGet<Defective[]>(`/finished-goods/defectives${scope}`),
        apiGet<Outbound[]>(`/finished-goods/outbounds${scope}`),
      ]);
      setFinished(finishedResult.data);
      setDefective(defectiveResult.data);
      setNotices(noticeResult.data);
      // 只展示还有可入库/可登记次品额度的质检单（额度由后端按净值给出：扣掉草稿+已过账）。
      setQcAvailable(qcResult.data.filter((row) => number(row.available_for_inbound_quantity) > 0 || number(row.available_for_defective_quantity) > 0));
      setInbounds(inboundResult.data);
      setDefectives(defectiveDocResult.data);
      setOutbounds(outboundResult.data);
    } catch (cause) {
      setError(messageOf(cause, "成品仓储情况加载失败"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(""); }, []);
  useEffect(() => {
    const refresh = () => { if (shouldRefreshOnVisibility(document.visibilityState)) void load(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [appliedOrderNo]);

  async function run(path: string, body: unknown, success: string, method: "POST" | "PATCH" = "POST") {
    try {
      if (method === "POST") await apiPost(path, body); else await apiRequest(path, { method: "PATCH", body: JSON.stringify(body) });
      notifySuccess(success);
      setDialog(null);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "操作失败"));
    }
  }

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

  function reverseInbound(row: Inbound) {
    setDialog({ title: `冲销成品入库：${row.inboundNo}`, fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }], submit: (values) => void run(`/finished-goods/inbounds/${row.id}/reverse`, { reason: values.reason }, "成品入库已冲销") });
  }

  function reverseDefective(row: Defective) {
    setDialog({ title: `冲销次品记录：${row.defectiveNo}`, fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }], submit: (values) => void run(`/finished-goods/defectives/${row.id}/reverse`, { reason: values.reason }, "次品记录已冲销") });
  }

  const balanceColumns = [
    { id: "order", header: "订单号", cell: ({ row }: { row: { original: Balance } }) => row.original.order_no ?? "-" },
    { id: "product", header: "成品", cell: ({ row }: { row: { original: Balance } }) => row.original.product_name ?? "-" },
    { id: "spec", header: "规格", cell: ({ row }: { row: { original: Balance } }) => row.original.product_specification ?? "-" },
    { accessorKey: "category", header: "类别", cell: ({ row }: { row: { original: Balance } }) => categoryLabels[row.original.category] ?? row.original.category },
    { accessorKey: "quantity", header: "存量" },
  ];
  const noticeColumns = [
    { accessorKey: "noticeNo", header: "入库通知" },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "batch", header: "批次", cell: ({ row }: { row: { original: Notice } }) => row.original.batchNo ?? "-" },
    { accessorKey: "operationNameSnapshot", header: "包装工序" },
    { id: "date", header: "通知日期", cell: ({ row }: { row: { original: Notice } }) => row.original.noticeDate.slice(0, 10) },
    { id: "quantity", header: "通知数量", cell: ({ row }: { row: { original: Notice } }) => `${row.original.noticeQuantity} ${row.original.unitNameSnapshot}` },
    { accessorKey: "submittedQuantity", header: "已送检" },
    { accessorKey: "availableSubmissionQuantity", header: "待送检" },
    { accessorKey: "qcQualifiedQuantity", header: "QC 合格" },
    { accessorKey: "inboundPostedQuantity", header: "已入库" },
    { accessorKey: "status", header: "状态", cell: ({ row }: { row: { original: Notice } }) => noticeStatusLabels[row.original.status] ?? row.original.status },
  ];
  const qcColumns = [
    { accessorKey: "qc_no", header: "质检单" },
    { accessorKey: "order_no", header: "订单号" },
    { id: "qualified", header: "合格/条件合格", cell: ({ row }: { row: { original: QcAvailable } }) => `${row.original.qualified_quantity} / ${row.original.conditional_accept_quantity}` },
    { id: "rejected", header: "不合格", cell: ({ row }: { row: { original: QcAvailable } }) => row.original.rejected_quantity ?? "-" },
    { accessorKey: "available_for_inbound_quantity", header: "可入库（净值）" },
    { accessorKey: "available_for_defective_quantity", header: "可登记次品" },
    { id: "actions", header: "操作", cell: ({ row }: { row: { original: QcAvailable } }) => <div className="action-row">{number(row.original.available_for_inbound_quantity) > 0 ? <Button size="sm" variant="secondary" onClick={() => registerInbound(row.original)}>登记入库</Button> : null}{number(row.original.available_for_defective_quantity) > 0 ? <Button size="sm" variant="ghost" onClick={() => registerDefective(row.original)}>登记次品</Button> : null}</div> },
  ];
  const inboundColumns = [
    { accessorKey: "inboundNo", header: "入库单" },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "product", header: "成品", cell: ({ row }: { row: { original: Inbound } }) => row.original.productNameSnapshot ?? "-" },
    { accessorKey: "quantity", header: "数量" },
    { id: "status", header: "状态", cell: ({ row }: { row: { original: Inbound } }) => inboundStatusLabels[row.original.status] ?? row.original.status },
    { id: "actions", header: "操作", cell: ({ row }: { row: { original: Inbound } }) => row.original.status === "draft" ? <Button size="sm" onClick={() => void run(`/finished-goods/inbounds/${row.original.id}/post`, {}, "成品入库已过账")}>过账</Button> : row.original.status === "posted" ? <Button size="sm" variant="ghost" onClick={() => reverseInbound(row.original)}>冲销</Button> : null },
  ];
  const outboundColumns = [
    { accessorKey: "outboundNo", header: "出库单" },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "product", header: "成品", cell: ({ row }: { row: { original: Outbound } }) => row.original.productNameSnapshot ?? "-" },
    { accessorKey: "quantity", header: "数量" },
    { id: "status", header: "状态", cell: ({ row }: { row: { original: Outbound } }) => outboundStatusLabels[row.original.status] ?? row.original.status },
  ];
  const defectiveColumns = [
    { accessorKey: "defectiveNo", header: "次品单" },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "product", header: "成品", cell: ({ row }: { row: { original: Defective } }) => row.original.productNameSnapshot ?? "-" },
    { accessorKey: "quantity", header: "数量" },
    { id: "status", header: "状态", cell: ({ row }: { row: { original: Defective } }) => inboundStatusLabels[row.original.status] ?? row.original.status },
    { id: "actions", header: "操作", cell: ({ row }: { row: { original: Defective } }) => row.original.status === "draft" ? <Button size="sm" onClick={() => void run(`/finished-goods/defectives/${row.original.id}/post`, {}, "次品已过账")}>过账</Button> : row.original.status === "posted" ? <Button size="sm" variant="ghost" onClick={() => reverseDefective(row.original)}>冲销</Button> : null },
  ];
  // 待入库 = 还有未入库量的通知（按实际剩余工作量统计，而不是按状态），避免“已建草稿送检就被当成完成”而漏掉待办。
  const pendingNoticeCount = notices.filter((row) => row.status !== "cancelled" && number(row.remainingForInbound) > 0).length;

  if (loading && !finished.length && !notices.length) return <LoadingState label="正在加载成品仓储情况" />;
  if (error && !finished.length && !notices.length) return <ErrorState message={error} onRetry={() => void load()} />;

  return <>
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => { dialog?.submit(values); }} />
    <PageHeader title="成品仓储情况">
      <Button asChild variant="secondary"><Link href="/warehouse">返回仓库</Link></Button>
      <Button variant="ghost" onClick={() => void load()}>刷新</Button>
    </PageHeader>
    {error && <section className="panel panel-body status-error" role="alert">{error}</section>}
    <section className="panel">
      <div className="panel-body filter-bar">
        <label>订单号 <Input value={orderNo} onChange={(event) => setOrderNo(event.target.value)} placeholder="可选，留空看全部" /></label>
        <Button variant="secondary" onClick={() => { setAppliedOrderNo(orderNo.trim()); void load(orderNo.trim()); }}>筛选</Button>
      </div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>成品存量</h2><span className="panel-note">按订单/生产单/成品规格聚合库存事实</span></div>
      <div className="panel-body">
        <h3>成品</h3>
        <DataTable columns={balanceColumns} data={finished} empty={<EmptyState title="暂无成品存量" description="成品入库过账后这里会出现存量。" />} />
        <h3>次品</h3>
        <DataTable columns={balanceColumns} data={defective} empty={<EmptyState title="暂无次品存量" />} />
      </div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>待入库通知 <span className="status-warning">{pendingNoticeCount}</span></h2><span className="panel-note">生产按包装工序累计报工分批通知；仓库按通知送检 → 质检 → 入库</span></div>
      <div className="panel-body"><DataTable columns={noticeColumns} data={notices} empty={<EmptyState title="暂无入库通知" description="生产在【生产单详情 → 成品存量与入库通知】按包装工序累计量发通知。" />} /></div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>质检合格待入库</h2><span className="panel-note">按 QC 合格量分批登记入库、按不合格量登记次品；过账后才计入对应存量</span></div>
      <div className="panel-body"><DataTable columns={qcColumns} data={qcAvailable} empty={<EmptyState title="暂无可入库/可登记次品的质检单" />} /></div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>成品入库单</h2></div>
      <div className="panel-body"><DataTable columns={inboundColumns} data={inbounds} empty={<EmptyState title="暂无成品入库单" />} /></div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>次品记录</h2></div>
      <div className="panel-body"><DataTable columns={defectiveColumns} data={defectives} empty={<EmptyState title="暂无次品记录" description="质检不合格数量可在上方「登记次品」后过账。" />} /></div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>成品出库单</h2></div>
      <div className="panel-body"><DataTable columns={outboundColumns} data={outbounds} empty={<EmptyState title="暂无成品出库单" />} /></div>
    </section>
  </>;
}

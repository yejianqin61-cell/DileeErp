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
type Outbound = { id: string; outboundNo: string; orderNo: string; quantity: string; status: string; productNameSnapshot?: string | null; shipmentDate?: string | null; carrier?: string | null; trackingNo?: string | null; packingListNo?: string | null; invoiceNo?: string | null; signedAt?: string | null; riskReason?: string | null; remark?: string | null; unit?: { name?: string } | null; salesOrder?: { currency?: string; unitPrice?: string | null; settlementUnitPrice?: string | null; customer?: { name?: string } | null } | null; outboundNotice?: { id: string; noticeNo: string; status: string } | null };
// 销售发起的成品出库通知：仓库据此生成整批出库单。
type OutboundNotice = { id: string; noticeNo: string; orderNo: string; productionOrderId: string; productNameSnapshot?: string | null; productSpecificationSnapshot?: string | null; noticeQuantity: string; status: string; notifiedAt: string; remark?: string | null; unit?: { name?: string } | null; salesOrder?: { customer?: { name?: string } | null } | null; outbound?: { id: string; outboundNo: string; status: string; quantity: string } | null };

const noticeStatusLabels: Record<string, string> = { pending: "待送检", partially_inbound: "入库中", completed: "已完成", cancelled: "已取消" };
const inboundStatusLabels: Record<string, string> = { draft: "待入库登记", posted: "入库成功", reversed: "已冲销" };
const outboundStatusLabels: Record<string, string> = { draft: "待出库", posted: "已出库", shipped: "已发出", signed: "已签收", reversed: "已冲销" };
const categoryLabels: Record<string, string> = { finished_goods: "成品", defective_goods: "次品" };
// 出库通知状态：pending 待仓库建出库单 → outbound_created 已建单待过账 → completed 已出库（已通知财务收款）。
const outboundNoticeStatusLabels: Record<string, string> = { pending: "待建出库单", outbound_created: "已建单待过账", completed: "已出库（已通知财务收款）", cancelled: "已取消" };
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
  const [outboundNotices, setOutboundNotices] = useState<OutboundNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> } | null>(null);

  // options.silent：后台刷新（焦点/可见性变化）时不切整页 loading，避免卸载正在编辑的弹窗、清掉用户刚填的内容。
  async function load(targetOrderNo = appliedOrderNo, options: { silent?: boolean } = {}) {
    if (!options.silent) setLoading(true);
    setError("");
    const scope = targetOrderNo ? `?order_no=${encodeURIComponent(targetOrderNo)}` : "";
    try {
      const [finishedResult, defectiveResult, noticeResult, qcResult, inboundResult, defectiveDocResult, outboundResult, outboundNoticeResult] = await Promise.all([
        apiGet<Balance[]>(`/inventory/balances?category=finished_goods${targetOrderNo ? `&order_no=${encodeURIComponent(targetOrderNo)}` : ""}`),
        apiGet<Balance[]>(`/inventory/balances?category=defective_goods${targetOrderNo ? `&order_no=${encodeURIComponent(targetOrderNo)}` : ""}`),
        apiGet<Notice[]>(`/finished-goods/inbound-notices${scope}`),
        apiGet<QcAvailable[]>(`/finished-goods/qc-records/available-inbound-sources${scope}`),
        apiGet<Inbound[]>(`/finished-goods/inbounds${scope}`),
        apiGet<Defective[]>(`/finished-goods/defectives${scope}`),
        apiGet<Outbound[]>(`/finished-goods/outbounds${scope}`),
        apiGet<OutboundNotice[]>(`/finished-goods/outbound-notices${scope}`),
      ]);
      setFinished(finishedResult.data);
      setDefective(defectiveResult.data);
      setNotices(noticeResult.data);
      // 只展示还有可入库/可登记次品额度的质检单（额度由后端按净值给出：扣掉草稿+已过账）。
      setQcAvailable(qcResult.data.filter((row) => number(row.available_for_inbound_quantity) > 0 || number(row.available_for_defective_quantity) > 0));
      setInbounds(inboundResult.data);
      setDefectives(defectiveDocResult.data);
      setOutbounds(outboundResult.data);
      setOutboundNotices(outboundNoticeResult.data);
    } catch (cause) {
      setError(messageOf(cause, "成品仓储情况加载失败"));
    } finally {
      if (!options.silent) setLoading(false);
    }
  }

  useEffect(() => { void load(""); }, []);
  useEffect(() => {
    const refresh = () => { if (shouldRefreshOnVisibility(document.visibilityState)) void load(undefined, { silent: true }); };
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

  /** 按销售发起的出库通知生成成品出库单：数量固定为通知数量（整批），仓库不能改。 */
  function createOutboundFromNotice(row: OutboundNotice) {
    setDialog({ title: `生成成品出库单（整批）：${row.noticeNo}`, fields: [
      { name: "confirm", label: `确认按通知数量 ${row.noticeQuantity}${row.unit?.name ? ` ${row.unit.name}` : ""} 整批出库？`, required: true, placeholder: "输入 确认 继续" },
    ], submit: async (values) => { if (values.confirm?.trim() !== "确认") { notifyError("请输入“确认”以生成出库单"); return; } await run(`/finished-goods/outbound-notices/${row.id}/create-outbound`, {}, "成品出库单已生成（整批，待过账）"); } });
  }

  function editShipping(row: Outbound) {
    setDialog({ title: `维护发货信息：${row.outboundNo}`, fields: [
      { name: "shipment_date", label: "发货日期", type: "date", required: true, defaultValue: row.shipmentDate?.slice(0, 10) ?? new Date().toISOString().slice(0, 10) },
      { name: "carrier", label: "承运商", defaultValue: row.carrier ?? undefined },
      { name: "tracking_no", label: "运单号", defaultValue: row.trackingNo ?? undefined },
      { name: "packing_list_no", label: "装箱单号", defaultValue: row.packingListNo ?? undefined },
      { name: "invoice_no", label: "发票号", defaultValue: row.invoiceNo ?? undefined },
    ], submit: (values) => void run(`/finished-goods/outbounds/${row.id}/shipping`, { shipment_date: values.shipment_date, carrier: values.carrier || undefined, tracking_no: values.tracking_no || undefined, packing_list_no: values.packing_list_no || undefined, invoice_no: values.invoice_no || undefined }, "发货信息已保存", "PATCH") });
  }

  function signOutbound(row: Outbound) {
    setDialog({ title: `登记签收：${row.outboundNo}`, fields: [
      { name: "signed_at", label: "签收时间", type: "date", required: true, defaultValue: new Date().toISOString().slice(0, 10) },
      { name: "signature_reference", label: "签收凭证/单号", placeholder: "可选" },
    ], submit: (values) => void run(`/finished-goods/outbounds/${row.id}/sign`, { signed_at: new Date(`${values.signed_at}T00:00:00.000Z`).toISOString(), signature_reference: values.signature_reference || undefined }, "签收已登记") });
  }

  function reverseOutbound(row: Outbound) {
    setDialog({ title: `冲销成品出库：${row.outboundNo}`, fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }], submit: (values) => void run(`/finished-goods/outbounds/${row.id}/reverse`, { reason: values.reason }, "成品出库已冲销（来源出库通知退回待处理）") });
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
    { id: "customer", header: "客户", cell: ({ row }: { row: { original: Outbound } }) => row.original.salesOrder?.customer?.name ?? "-" },
    { id: "product", header: "成品", cell: ({ row }: { row: { original: Outbound } }) => row.original.productNameSnapshot ?? "-" },
    { id: "quantity", header: "数量", cell: ({ row }: { row: { original: Outbound } }) => `${row.original.quantity}${row.original.unit?.name ? ` ${row.original.unit.name}` : ""}` },
    { id: "amount", header: "应收金额", cell: ({ row }: { row: { original: Outbound } }) => { const price = row.original.salesOrder?.settlementUnitPrice ?? row.original.salesOrder?.unitPrice; return price ? `${(Number(price) * Number(row.original.quantity)).toFixed(2)} ${row.original.salesOrder?.currency ?? ""}` : "-"; } },
    { id: "shipping", header: "发货", cell: ({ row }: { row: { original: Outbound } }) => row.original.shipmentDate ? `${row.original.shipmentDate.slice(0, 10)}${row.original.carrier ? ` / ${row.original.carrier}` : ""}${row.original.trackingNo ? ` / ${row.original.trackingNo}` : ""}` : "-" },
    { id: "notice", header: "来源通知", cell: ({ row }: { row: { original: Outbound } }) => row.original.outboundNotice?.noticeNo ?? "-" },
    { id: "status", header: "状态", cell: ({ row }: { row: { original: Outbound } }) => outboundStatusLabels[row.original.status] ?? row.original.status },
    { id: "actions", header: "操作", cell: ({ row }: { row: { original: Outbound } }) => <div className="action-row">{row.original.status === "draft" ? <Button size="sm" onClick={() => void run(`/finished-goods/outbounds/${row.original.id}/post`, {}, "成品出库已过账（已生成应收来源，等待财务收款）")}>过账出库</Button> : null}{["posted", "shipped"].includes(row.original.status) ? <Button size="sm" variant="secondary" onClick={() => editShipping(row.original)}>维护发货</Button> : null}{["posted", "shipped", "signed"].includes(row.original.status) ? <Button size="sm" variant="secondary" onClick={() => signOutbound(row.original)}>登记签收</Button> : null}{["posted", "shipped", "signed"].includes(row.original.status) ? <Button size="sm" variant="ghost" onClick={() => reverseOutbound(row.original)}>冲销</Button> : null}</div> },
  ];
  const outboundNoticeColumns = [
    { accessorKey: "noticeNo", header: "出库通知" },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "customer", header: "客户", cell: ({ row }: { row: { original: OutboundNotice } }) => row.original.salesOrder?.customer?.name ?? "-" },
    { id: "product", header: "成品", cell: ({ row }: { row: { original: OutboundNotice } }) => `${row.original.productNameSnapshot ?? "-"}${row.original.productSpecificationSnapshot ? ` / ${row.original.productSpecificationSnapshot}` : ""}` },
    { id: "quantity", header: "通知数量（整批）", cell: ({ row }: { row: { original: OutboundNotice } }) => `${row.original.noticeQuantity}${row.original.unit?.name ? ` ${row.original.unit.name}` : ""}` },
    { id: "status", header: "状态", cell: ({ row }: { row: { original: OutboundNotice } }) => outboundNoticeStatusLabels[row.original.status] ?? row.original.status },
    { id: "outbound", header: "出库单", cell: ({ row }: { row: { original: OutboundNotice } }) => row.original.outbound ? `${row.original.outbound.outboundNo}（${outboundStatusLabels[row.original.outbound.status] ?? row.original.outbound.status}）` : "-" },
    { id: "actions", header: "操作", cell: ({ row }: { row: { original: OutboundNotice } }) => row.original.status === "pending" ? <Button size="sm" onClick={() => createOutboundFromNotice(row.original)}>生成出库单（整批）</Button> : row.original.status === "cancelled" ? <span>已取消</span> : <span>已建单</span> },
  ];
  const defectiveColumns = [
    { accessorKey: "defectiveNo", header: "次品单" },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "product", header: "成品", cell: ({ row }: { row: { original: Defective } }) => row.original.productNameSnapshot ?? "-" },
    { accessorKey: "quantity", header: "数量" },
    { id: "status", header: "状态", cell: ({ row }: { row: { original: Defective } }) => inboundStatusLabels[row.original.status] ?? row.original.status },
    { id: "actions", header: "操作", cell: ({ row }: { row: { original: Defective } }) => row.original.status === "draft" ? <Button size="sm" onClick={() => void run(`/finished-goods/defectives/${row.original.id}/post`, {}, "次品已过账")}>过账</Button> : row.original.status === "posted" ? <Button size="sm" variant="ghost" onClick={() => reverseDefective(row.original)}>冲销</Button> : null },
  ];
  // 待入库 = 还有「可送检额度」或「在途入库」的通知。不用 remainingForInbound：QC 不合格的部分永远不会入库，
  // 按通知量减已入库会把这类通知永久算成待办。
  const pendingNoticeCount = notices.filter((row) => row.status !== "cancelled" && (number(row.availableSubmissionQuantity) > 0 || number(row.inboundDraftQuantity) > 0)).length;

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
      <div className="panel-heading"><h2>成品出库通知（销售发起）</h2><span className="panel-note">销售在销售订单页「通知仓库出库」后出现在这里；点「生成出库单（整批）」即可建单，过账后自动生成应收来源并通知财务收款</span></div>
      <div className="panel-body"><DataTable columns={outboundNoticeColumns} data={outboundNotices} empty={<EmptyState title="暂无出库通知" description="成品入库后由销售在【销售 → 打开销售单 → 成品入库与出库】通知仓库出库。" />} /></div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>成品出库单</h2><span className="panel-note">只允许整批出库（数量=当前成品可用量）；过账后自动生成应收来源草稿，财务在「应收来源」确认并核销收款</span></div>
      <div className="panel-body"><DataTable columns={outboundColumns} data={outbounds} empty={<EmptyState title="暂无成品出库单" description="生成出库单后在这里过账、维护发货与签收。" />} /></div>
    </section>
  </>;
}

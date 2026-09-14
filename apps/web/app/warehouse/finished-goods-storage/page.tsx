"use client";

// 仓库成品存量管理：成品/次品存量、待入库通知（分批）、成品入库单与成品出库单。
// 质检（送检、判定、次品登记）已迁到【质检】模块，本页只读质检结论带来的库存结果。
// 数据口径：库存储量取自库存事实聚合（/inventory/balances），入库/出库单据来自成品链路表。
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
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
type Inbound = { id: string; inboundNo: string; orderNo: string; quantity: string; status: string; productNameSnapshot?: string | null; qcRecord?: { qcNo?: string } | null; createdAt?: string };
type Outbound = { id: string; outboundNo: string; orderNo: string; quantity: string; status: string; productNameSnapshot?: string | null; shipmentDate?: string | null; carrier?: string | null; trackingNo?: string | null; packingListNo?: string | null; invoiceNo?: string | null; signedAt?: string | null; riskReason?: string | null; remark?: string | null; unit?: { name?: string } | null; salesOrder?: { currency?: string; unitPrice?: string | null; settlementUnitPrice?: string | null; customer?: { name?: string } | null } | null; outboundNotice?: { id: string; noticeNo: string; status: string } | null };
// 销售发起的成品出库通知：仓库据此分批生成出库单（可只出一部分，剩余量继续出）。
type OutboundNotice = { id: string; noticeNo: string; orderNo: string; productionOrderId: string; productNameSnapshot?: string | null; productSpecificationSnapshot?: string | null; noticeQuantity: string; shippedQuantity?: string; remaining_quantity?: string; draft_quantity?: string; status: string; notifiedAt: string; remark?: string | null; outbound_summary?: string; unit?: { name?: string } | null; salesOrder?: { customer?: { name?: string } | null } | null };

const noticeStatusLabels: Record<string, string> = { pending: "待送检", partially_inbound: "入库中", completed: "已完成", cancelled: "已取消" };
const inboundStatusLabels: Record<string, string> = { draft: "待入库登记", posted: "入库成功", reversed: "已冲销" };
const outboundStatusLabels: Record<string, string> = { draft: "待出库", posted: "已出库", shipped: "已发出", signed: "已签收", reversed: "已冲销", cancelled: "已取消" };
const categoryLabels: Record<string, string> = { finished_goods: "成品", defective_goods: "次品" };
// 出库通知状态：pending 待仓库建出库单 → outbound_created 已建单待过账 → partially_outbound 已部分出库 → completed 已出库（已通知财务收款）。
const outboundNoticeStatusLabels: Record<string, string> = { pending: "待建出库单", outbound_created: "已建单待过账", partially_outbound: "已部分出库", completed: "已出库（已通知财务收款）", cancelled: "已取消" };
const number = (value: string | undefined) => Number(value ?? 0);
const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

export default function FinishedGoodsStoragePage() {
  const [orderNo, setOrderNo] = useState("");
  const [appliedOrderNo, setAppliedOrderNo] = useState("");
  const [finished, setFinished] = useState<Balance[]>([]);
  const [defective, setDefective] = useState<Balance[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [inbounds, setInbounds] = useState<Inbound[]>([]);
  const [outbounds, setOutbounds] = useState<Outbound[]>([]);
  const [outboundNotices, setOutboundNotices] = useState<OutboundNotice[]>([]);
  // 「成品存量」按订单号收束：展开状态记在这里（点击条目展开明细）。
  const [expandedOrders, setExpandedOrders] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> } | null>(null);

  // options.silent：后台刷新（焦点/可见性变化）时不切整页 loading，避免卸载正在编辑的弹窗、清掉用户刚填的内容。
  async function load(targetOrderNo = appliedOrderNo, options: { silent?: boolean } = {}) {
    if (!options.silent) setLoading(true);
    setError("");
    const scope = targetOrderNo ? `?order_no=${encodeURIComponent(targetOrderNo)}` : "";
    try {
      const [finishedResult, defectiveResult, noticeResult, inboundResult, outboundResult, outboundNoticeResult] = await Promise.all([
        apiGet<Balance[]>(`/inventory/balances?category=finished_goods${targetOrderNo ? `&order_no=${encodeURIComponent(targetOrderNo)}` : ""}`),
        apiGet<Balance[]>(`/inventory/balances?category=defective_goods${targetOrderNo ? `&order_no=${encodeURIComponent(targetOrderNo)}` : ""}`),
        apiGet<Notice[]>(`/finished-goods/inbound-notices${scope}`),
        apiGet<Inbound[]>(`/finished-goods/inbounds${scope}`),
        apiGet<Outbound[]>(`/finished-goods/outbounds${scope}`),
        apiGet<OutboundNotice[]>(`/finished-goods/outbound-notices${scope}`),
      ]);
      setFinished(finishedResult.data);
      setDefective(defectiveResult.data);
      setNotices(noticeResult.data);
      setInbounds(inboundResult.data);
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

  function reverseInbound(row: Inbound) {
    setDialog({ title: `冲销成品入库：${row.inboundNo}`, fields: [{ name: "reason", label: "冲销原因", type: "textarea", required: true }], submit: (values) => void run(`/finished-goods/inbounds/${row.id}/reverse`, { reason: values.reason }, "成品入库已冲销") });
  }

  /** 按销售发起的出库通知生成成品出库单：默认出剩余量，也可以只出一部分（分批出库）。 */
  function createOutboundFromNotice(row: OutboundNotice) {
    const remaining = row.remaining_quantity ?? row.noticeQuantity;
    // 幂等键在打开弹窗时生成一次：同一次提交被重试（网络抖动、重复点击）时复用同一个键，
    // 服务端会返回同一张出库单，而不是按剩余量再建一张草稿。
    const idempotencyKey = `web-notice-outbound-${row.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setDialog({ title: `生成成品出库单：${row.noticeNo}`, fields: [
      { name: "quantity", label: "本次出库数量", type: "number", required: true, defaultValue: remaining, placeholder: `通知 ${row.noticeQuantity}，剩余 ${remaining}（可分批出库）` },
      { name: "confirm", label: `确认出库数量不超过剩余 ${remaining}${row.unit?.name ? ` ${row.unit.name}` : ""}`, required: true, placeholder: "输入 确认 继续" },
    ], submit: async (values) => {
      // 校验失败抛错（而不是 notifyError + return）：ActionDialog 会把异常显示在弹窗内并保留用户已填的值，
      // 用 notifyError 的话弹窗会被立刻关掉，用户手里的数量也跟着丢。
      if (values.confirm?.trim() !== "确认") throw new Error("请输入“确认”以生成出库单");
      await run(`/finished-goods/outbound-notices/${row.id}/create-outbound`, { quantity: values.quantity, idempotency_key: idempotencyKey }, `成品出库单已生成（本次 ${values.quantity}，待过账）`);
    } });
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

  /** 取消未过账的草稿出库单：库存变化导致过账必然失败时的出路，来源通知会退回待处理。 */
  function cancelOutbound(row: Outbound) {
    setDialog({ title: `取消成品出库单：${row.outboundNo}`, fields: [{ name: "reason", label: "取消原因", type: "textarea", required: true, placeholder: "例如：通知数量与库存不一致，需重新通知" }], submit: (values) => void run(`/finished-goods/outbounds/${row.id}/cancel`, { reason: values.reason }, "出库单已取消，来源通知退回待处理") });
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
    { id: "actions", header: "操作", cell: ({ row }: { row: { original: Outbound } }) => <div className="action-row">{row.original.status === "draft" ? <Button size="sm" onClick={() => void run(`/finished-goods/outbounds/${row.original.id}/post`, {}, "成品出库已过账（已生成应收来源，等待财务收款）")}>过账出库</Button> : null}{row.original.status === "draft" ? <Button size="sm" variant="ghost" onClick={() => cancelOutbound(row.original)}>取消出库单</Button> : null}{["posted", "shipped"].includes(row.original.status) ? <Button size="sm" variant="secondary" onClick={() => editShipping(row.original)}>维护发货</Button> : null}{["posted", "shipped", "signed"].includes(row.original.status) ? <Button size="sm" variant="secondary" onClick={() => signOutbound(row.original)}>登记签收</Button> : null}{["posted", "shipped", "signed"].includes(row.original.status) ? <Button size="sm" variant="ghost" onClick={() => reverseOutbound(row.original)}>冲销</Button> : null}</div> },
  ];
  const outboundNoticeColumns = [
    { accessorKey: "noticeNo", header: "出库通知" },
    { accessorKey: "orderNo", header: "订单号" },
    { id: "customer", header: "客户", cell: ({ row }: { row: { original: OutboundNotice } }) => row.original.salesOrder?.customer?.name ?? "-" },
    { id: "product", header: "成品", cell: ({ row }: { row: { original: OutboundNotice } }) => `${row.original.productNameSnapshot ?? "-"}${row.original.productSpecificationSnapshot ? ` / ${row.original.productSpecificationSnapshot}` : ""}` },
    { id: "quantity", header: "通知数量", cell: ({ row }: { row: { original: OutboundNotice } }) => `${row.original.noticeQuantity}${row.original.unit?.name ? ` ${row.original.unit.name}` : ""}` },
    { id: "shipped", header: "已出库 / 剩余", cell: ({ row }: { row: { original: OutboundNotice } }) => `${row.original.shippedQuantity ?? "0"} / ${row.original.remaining_quantity ?? "-"}` },
    { id: "status", header: "状态", cell: ({ row }: { row: { original: OutboundNotice } }) => outboundNoticeStatusLabels[row.original.status] ?? row.original.status },
    { id: "outbound", header: "出库单", cell: ({ row }: { row: { original: OutboundNotice } }) => row.original.outbound_summary || "-" },
    { id: "actions", header: "操作", cell: ({ row }: { row: { original: OutboundNotice } }) => ["pending", "outbound_created", "partially_outbound"].includes(row.original.status) && Number(row.original.remaining_quantity ?? row.original.noticeQuantity) > 0 ? <Button size="sm" onClick={() => createOutboundFromNotice(row.original)}>生成出库单</Button> : row.original.status === "cancelled" ? <span>已取消</span> : <span>已发完</span> },
  ];
  // 待入库 = 还有「可送检额度」或「在途入库」的通知。不用 remainingForInbound：QC 不合格的部分永远不会入库，
  // 按通知量减已入库会把这类通知永久算成待办。
  const pendingNoticeCount = notices.filter((row) => row.status !== "cancelled" && (number(row.availableSubmissionQuantity) > 0 || number(row.inboundDraftQuantity) > 0)).length;
  // 成品存量按订单号收束成一条（客户反馈：订单一多整张表很冗长），点开才看该订单下的明细。
  // 现存 = 库存事实余额；已入库/已出库只算已过账（草稿/已冲销/已取消不算）。
  const finishedGroups = useMemo(() => {
    const groups = new Map<string, { orderNo: string; stock: number; inbound: number; outbound: number; rows: Balance[] }>();
    for (const row of finished) {
      const orderNo = row.order_no ?? "（无订单号）";
      const group = groups.get(orderNo) ?? { orderNo, stock: 0, inbound: 0, outbound: 0, rows: [] };
      group.stock += number(row.quantity);
      group.rows.push(row);
      groups.set(orderNo, group);
    }
    for (const row of inbounds) {
      if (row.status !== "posted") continue;
      const orderNo = row.orderNo ?? "（无订单号）";
      const group = groups.get(orderNo) ?? { orderNo, stock: 0, inbound: 0, outbound: 0, rows: [] };
      group.inbound += number(row.quantity);
      groups.set(orderNo, group);
    }
    for (const row of outbounds) {
      if (!["posted", "shipped", "signed"].includes(row.status)) continue;
      const orderNo = row.orderNo ?? "（无订单号）";
      const group = groups.get(orderNo) ?? { orderNo, stock: 0, inbound: 0, outbound: 0, rows: [] };
      group.outbound += number(row.quantity);
      groups.set(orderNo, group);
    }
    return [...groups.values()].sort((left, right) => left.orderNo.localeCompare(right.orderNo));
  }, [finished, inbounds, outbounds]);
  const toggleGroup = (orderNo: string) => setExpandedOrders((current) => ({ ...current, [orderNo]: !current[orderNo] }));

  if (loading && !finished.length && !notices.length) return <LoadingState label="正在加载成品仓储情况" />;
  if (error && !finished.length && !notices.length) return <ErrorState message={error} onRetry={() => void load()} />;

  return <div className="page-root" data-testid="page-warehouse-finished-goods-storage">
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />
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
      <div className="panel-heading"><h2>成品存量</h2><span className="panel-note">按订单号收束（展开到生产单/成品规格），存量口径见下表说明</span></div>
      <div className="panel-body">
        <h3>成品（按订单号收束，点击条目展开明细）</h3>
        <p className="panel-note">
          三个数不是同一个口径，不满足「现存 = 已入库 − 已出库」属正常：
          现存数量取库存事实余额（入库过账 − 出库过账 + 客户退货回仓 − 转次品/冲销）；
          已入库 / 已出库是单据口径（只统计已过账的入库单与已过账/已发出/已签收的出库单，
          不含退货回仓与转次品）。要对账请以「现存数量」为准。
        </p>
        <div className="table-wrap"><table className="ui-table">
          <thead><tr><th className="ui-table-head">订单号</th><th className="ui-table-head">成品现存数量</th><th className="ui-table-head">已入库数量</th><th className="ui-table-head">已出库数量</th><th className="ui-table-head">明细</th></tr></thead>
          <tbody>
            {finishedGroups.length ? finishedGroups.map((group) => <Fragment key={group.orderNo}>
              <tr className="ui-table-row">
                <td className="ui-table-cell"><Button size="sm" variant="link" aria-expanded={Boolean(expandedOrders[group.orderNo])} onClick={() => toggleGroup(group.orderNo)}>{group.orderNo}</Button></td>
                <td className="ui-table-cell">{group.stock}</td>
                <td className="ui-table-cell">{group.inbound}</td>
                <td className="ui-table-cell">{group.outbound}</td>
                <td className="ui-table-cell">{group.rows.length} 个成品批次 <Button size="sm" variant="ghost" onClick={() => toggleGroup(group.orderNo)}>{expandedOrders[group.orderNo] ? "收起" : "展开"}</Button></td>
              </tr>
              {expandedOrders[group.orderNo] ? group.rows.map((row, index) => <tr className="ui-table-row" key={`${group.orderNo}-${row.production_order_id ?? "none"}-${index}`}>
                <td className="ui-table-cell">└ 生产单 {row.production_order_id ? row.production_order_id.slice(0, 8) : "-"} / {row.product_name ?? "-"}{row.product_specification ? ` / ${row.product_specification}` : ""}</td>
                <td className="ui-table-cell">{row.quantity}</td>
                <td className="ui-table-cell">-</td>
                <td className="ui-table-cell">-</td>
                <td className="ui-table-cell">单位 {row.category === "finished_goods" ? "成品" : row.category}</td>
              </tr>) : null}
            </Fragment>) : <tr><td className="ui-table-cell" colSpan={5}><EmptyState title="暂无成品存量" description="成品入库过账后这里会出现存量。" /></td></tr>}
          </tbody>
        </table></div>
        <h3>次品</h3>
        <DataTable columns={balanceColumns} data={defective} empty={<EmptyState title="暂无次品存量" />} />
      </div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>待入库通知 <span className="status-warning">{pendingNoticeCount}</span></h2><span className="panel-note">生产按包装工序累计报工分批通知；仓库按通知送检 → 质检 → 入库</span></div>
      <div className="panel-body"><DataTable columns={noticeColumns} data={notices} empty={<EmptyState title="暂无入库通知" description="生产在【生产单详情 → 成品存量与入库通知】按包装工序累计量发通知。" />} /></div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>质检合格待入库 / 次品登记</h2><div className="page-actions"><Button size="sm" variant="secondary" asChild><Link href="/qc">进入质检模块</Link></Button></div></div>
      <div className="panel-body"><p className="panel-note">按 QC 合格量登记成品入库、按不合格量登记次品，以及次品记录的过账/冲销，已整体迁到【质检】模块；本页保留成品入库单的过账与冲销。</p></div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>成品入库单</h2></div>
      <div className="panel-body"><DataTable columns={inboundColumns} data={inbounds} empty={<EmptyState title="暂无成品入库单" />} /></div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>成品出库通知（销售发起）</h2><span className="panel-note">销售在销售订单页「通知仓库出库」后出现在这里；点「生成出库单」可按剩余量分批出库，每次过账后自动生成应收来源并通知财务收款</span></div>
      <div className="panel-body"><DataTable columns={outboundNoticeColumns} data={outboundNotices} empty={<EmptyState title="暂无出库通知" description="成品入库后由销售在【销售 → 打开销售单 → 成品入库与出库】通知仓库出库。" />} /></div>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>成品出库单</h2><span className="panel-note">支持分批出库（单张数量 ≤ 当前成品可用量）；每次过账自动生成应收来源草稿，财务在「应收来源」确认并核销收款</span></div>
      <div className="panel-body"><DataTable columns={outboundColumns} data={outbounds} empty={<EmptyState title="暂无成品出库单" description="生成出库单后在这里过账、维护发货与签收。" />} /></div>
    </section>
  </div>;
}

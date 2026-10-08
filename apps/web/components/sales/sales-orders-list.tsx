"use client";

// 销售二级页：销售单列表（含打开单据看成品入库/出库、通知仓库出库、导出工艺单）。
//
// 与改造前的关系：这段逻辑原来长在 `app/sales/page.tsx` 里，现在整段搬进独立页面，
// 行为与 testid 全部保留（`sales-order-new` / `order-edit-*` / `order-production-sheet-*` /
// `sales-item-no-filter` 与销售单详情 Sheet 里的每一句文案），只是不再与客户池、成品总览挤一页。
//
// 三条不能丢的口径：
//   1. **出库通知的数量由服务端裁决**（超过可出库量返回 422），前端只把原因显示出来；
//   2. **工艺单导出**：这一单引用了有图的物料才弹勾选窗（没图直接出文件，不多一次点击）；
//   3. **货号筛选**（2026-09-26）：老板要求每个销售单都有货号，历史单得能被找出来补录。
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../layout/app-shell";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet";
import { DataTable } from "../data/data-table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { EmptyState, ErrorState, LoadingState } from "../feedback/states";
import { ApiClientError, apiDelete, apiGet, apiPost } from "../../lib/api-client";
import { downloadFile } from "../../lib/download";
import { exportImagesPath, productionSheetExportPath, productionSheetFileName, selectableImages, type ExportImageCandidate } from "../../lib/production-sheet-image";
import ProductionSheetExportDialog from "./production-sheet-export-dialog";
import { auditColumns, auditDetailFields, type AuditRow } from "../data/audit-columns";
import { notifyError, notifySuccess } from "../ui/toaster";

/** 列表接口带回的客户摘要（只需要名字；客户池的完整形状在 `customer-pool.tsx`，不互相 import）。 */
type OrderCustomer = { id: string; name: string };
type Order = AuditRow & { id: string; orderNo: string; /** 货号（2026-09-26）：老板要求每个销售单都有；历史单为空。 */ itemNo?: string | null; productName: string; productSpec?: string; quantity: string; unit: string; status: string; currency?: string | null; unitPrice?: string | null; totalAmount?: string | null; taxRate?: string | null; settlementUnitPrice?: string | null; receivableAmount?: string | null; settlementMethod?: string | null; localCurrencyAmount?: string | null; customer: OrderCustomer; boms: { id: string; version: number; status?: string }[] };
// 成品入库/出库与出库通知（销售页展示 + 通知仓库出库）。
type OutboundNotice = { id: string; notice_no: string; notice_quantity: string; shipped_quantity?: string; remaining_quantity?: string; status: string; notified_at: string; remark?: string | null; outbound_nos?: string[]; outbound_statuses?: string[] };
type FinishedGoodsRow = { production_order_id: string; production_order_no: string; production_status: string; product_specification?: string | null; unit?: string | null; planned_quantity: string; inbound_quantity: string; outbound_quantity: string; pending_notice_quantity: string; available_quantity: string; notices: OutboundNotice[] };
// 三个数字的口径（后端计算，前端只展示）：全部成品数 = 累计成品入库；已出库数 = 已过账/已发出/已签收出库；
// 未出库数 = 全部 − 已出库。按「产品 + 单位」分行：不同单位的数量不做合计。
type FinishedGoodsTotals = { product_name: string; unit: string; inbound_quantity: string; outbound_quantity: string; unshipped_quantity: string; production_order_count?: number };
type FinishedGoodsSummary = { sales_order_id: string; order_no: string; customer?: string | null; product_name: string; unit: string; totals?: FinishedGoodsTotals[]; production_orders: FinishedGoodsRow[] };
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
// 结算方式枚举与后端 SETTLEMENT_METHODS 同源（sales-orders.controller.ts）。
const settlementMethodOptions = [{ value: "tt", label: "T/T 电汇" }, { value: "letter_of_credit", label: "信用证 L/C" }, { value: "cash", label: "现金" }, { value: "monthly", label: "月结" }, { value: "other", label: "其他" }];
const settlementMethodLabel = (value?: string | null) => settlementMethodOptions.find((option) => option.value === value)?.label ?? (value || "-");
// 成品出库通知状态（销售发起 → 仓库建单 → 出库过账自动生成应收）。
const outboundNoticeStatusLabels: Record<string, string> = { pending: "待仓库建出库单", outbound_created: "已建出库单待过账", partially_outbound: "已部分出库", completed: "已出库（已通知财务收款）", cancelled: "已取消" };

export default function SalesOrdersList({ testId = "page-sales-orders" }: { testId?: string }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [query, setQuery] = useState("");
  const [itemNoFilter, setItemNoFilter] = useState<"all" | "with" | "without">("all");
  const [selected, setSelected] = useState<Order | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 成品入库/出库情况 + 出库通知：打开某张销售单时加载（「打开销售订单能看到成品入库情况」）。
  const [finishedGoods, setFinishedGoods] = useState<FinishedGoodsSummary | null>(null);
  const [finishedGoodsBusy, setFinishedGoodsBusy] = useState(false);
  // 工艺单导出：按行禁用防连点（与采购单/领料单导出一致）。
  const [exportingId, setExportingId] = useState("");
  // 工艺单带图导出的勾选弹窗（用户 2026-09-24）：null = 不显示。
  const [sheetExport, setSheetExport] = useState<{ id: string; orderNo: string; candidates: ExportImageCandidate[] } | null>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      setOrders((await apiGet<Order[]>("/sales-orders?page_size=200")).data);
    } catch (cause) {
      setError(messageOf(cause, "销售数据加载失败"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function loadFinishedGoods(salesOrderId: string) { try { setFinishedGoods((await apiGet<FinishedGoodsSummary>(`/sales-orders/${salesOrderId}/finished-goods`)).data); } catch { setFinishedGoods(null); } }
  useEffect(() => {
    const id = selected?.id;
    if (!id) { setFinishedGoods(null); return; }
    let cancelled = false;
    // 明说「加载中」（null）：接口失败与「还没回来」都落到 null，但界面上两者都是占位，
    // 而**不能**退化成一张空表 —— 空表会被读成「这一单没有成品」。
    setFinishedGoods(null);
    void (async () => { try { const result = await apiGet<FinishedGoodsSummary>(`/sales-orders/${id}/finished-goods`); if (!cancelled) setFinishedGoods(result.data); } catch { if (!cancelled) setFinishedGoods(null); } })();
    return () => { cancelled = true; };
  }, [selected?.id]);

  /** 通知出库的统一提交：数量由服务端裁决（超过可出库量返回 422），失败**抛错**让 ActionDialog 留在弹窗里展示原因。 */
  async function postOutboundNotices(body: Record<string, unknown>) {
    const id = selected?.id;
    if (!id) throw new Error("请先打开销售单");
    setFinishedGoodsBusy(true);
    try {
      const result = await apiPost<OutboundNotice[]>(`/sales-orders/${id}/outbound-notices`, { ...body, idempotency_key: `web-outbound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
      await loadFinishedGoods(id);
      return result.data;
    } finally {
      setFinishedGoodsBusy(false);
    }
  }
  /** 分批通知：弹窗里填「本次通知数量」（默认全部可出库量），余量之后再通知一次。 */
  function openNotifyOutbound(row: FinishedGoodsRow) {
    const unit = row.unit ?? finishedGoods?.unit ?? "";
    setDialog({ title: `通知仓库出库：${row.production_order_no}`, fields: [
      { name: "notice_quantity", label: "本次通知数量", type: "number", required: true, defaultValue: row.available_quantity, placeholder: `可出库 ${row.available_quantity}${unit ? ` ${unit}` : ""}（可只通知一部分，余量以后再通知）` },
      { name: "remark", label: "备注", type: "textarea", placeholder: "可选，例如：客户先要第一批" },
    ], submit: async (values) => {
      const created = await postOutboundNotices({ production_order_id: row.production_order_id, notice_quantity: values.notice_quantity, ...(values.remark?.trim() ? { remark: values.remark } : {}) });
      const notice = created[0];
      notifySuccess(notice ? `已通知仓库出库：${notice.notice_no} 本次 ${notice.notice_quantity}${unit ? ` ${unit}` : ""}` : "已通知仓库出库");
    } });
  }
  /** 整批通知：对该销售单每个可出库批次各建一张通知（数量由服务端按可出库量计算）。 */
  async function notifyAllOutbound() { try { const created = await postOutboundNotices({}); notifySuccess(created.length ? `已通知仓库出库（${created.length} 批）` : "已通知仓库出库"); } catch (cause) { notifyError(messageOf(cause, "通知仓库出库失败")); } }
  function cancelOutboundNotice(notice: OutboundNotice) { const id = selected?.id; if (!id) return; setDialog({ title: `取消出库通知：${notice.notice_no}`, fields: [{ name: "reason", label: "取消原因", type: "textarea", required: true }], submit: async (values) => { try { await apiPost(`/sales-orders/${id}/outbound-notices/${notice.id}/cancel`, { reason: values.reason }); notifySuccess("出库通知已取消"); await loadFinishedGoods(id); } catch (cause) { notifyError(messageOf(cause, "取消失败")); } } }); }

  // 货号筛选（2026-09-26）：老板要求每个销售单都有货号，历史单得能被找出来补录 ——
  // 这是【返单与总结】那张待办表在销售页的入口（没有它，销售不知道该去哪补）。
  const visibleOrders = useMemo(() => orders.filter((order) => {
    if (itemNoFilter === "with" && !order.itemNo) return false;
    if (itemNoFilter === "without" && order.itemNo) return false;
    return !query || `${order.orderNo} ${order.itemNo ?? ""} ${order.customer.name} ${order.productName} ${order.status}`.toLowerCase().includes(query.toLowerCase());
  }), [orders, query, itemNoFilter]);

  function confirmOrder(order: Order) { void run(() => apiPost(`/sales-orders/${order.id}/confirm`), "销售单已确认"); }
  function revertOrder(order: Order) { setDialog({ title: "销售单回退草稿", fields: [{ name: "reason", label: "回退原因", type: "textarea", required: true }], submit: (v) => void run(() => apiPost(`/sales-orders/${order.id}/revert-draft`, v), "销售单已回到草稿") }); }
  /**
   * 删除草稿销售单（2026-10-08）。**不弹确认框、不填原因**（用户 2026-10-08 选定：草稿多是录错或
   * 重复录入，点一下就该消失，多一次确认只是多一步）——与 `outsource-logistics-panel` 的草稿删除同一形状。
   * 服务端是软删：只有 draft 能删，且会先盘点下游事实；列表默认视图不再显示它，删错了由审计追。
   */
  function deleteOrder(order: Order) { void run(() => apiDelete(`/sales-orders/${order.id}`), `已删除草稿 ${order.orderNo}`); }
  async function run(action: () => Promise<unknown>, success: string) {
    setError("");
    try {
      await action();
      notifySuccess(success);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "操作失败"));
    }
  }

  /**
   * 导出工艺单（2026-09-16；2026-09-24 加图片勾选）。文件名用订单号。
   *
   * 先问一次「这一单引用了哪些有图的物料」：
   *   - 一张图都没有 → 直接出单（点一下就拿文件，与改造前完全一样）；
   *   - 有图 → 打开勾选弹窗（用户 2026-09-24：「每个有图片的物料允许用户勾选是否 excel 中
   *     一并导出这个图片」）。候选项**带进弹窗**，不重复请求。
   *
   * 失败原因要露出来：`lib/download` 已经把可读原因（超时 / HTTP 码 / 服务端 message）包在 Error 里，
   * 套 `messageOf` 的兜底会把它压成光秃秃的「导出失败」，用户无从下手（上一轮采购单导出踩过）。
   */
  async function exportProductionSheet(order: Order) {
    setExportingId(order.id);
    try {
      const candidates = (await apiGet<{ images: ExportImageCandidate[] }>(exportImagesPath(order.id))).data.images ?? [];
      if (selectableImages(candidates).length) { setSheetExport({ id: order.id, orderNo: order.orderNo, candidates }); return; }
      await downloadFile(productionSheetExportPath(order.id), productionSheetFileName(order.orderNo));
      notifySuccess(`已导出 ${order.orderNo} 的工艺单`);
    } catch (cause) {
      notifyError(cause instanceof Error && cause.message ? cause.message : "导出失败");
    } finally {
      setExportingId("");
    }
  }

  const orderColumns: ColumnDef<Order>[] = [
    { accessorKey: "orderNo", header: "订单号", cell: ({ row }) => <Button variant="link" onClick={() => setSelected(row.original)}>{row.original.orderNo}</Button> },
    { id: "itemNo", header: "货号", cell: ({ row }) => row.original.itemNo ?? "-" },
    { id: "customer", header: "客户", cell: ({ row }) => row.original.customer.name },
    { accessorKey: "productName", header: "产品" },
    { id: "quantity", header: "数量", cell: ({ row }) => `${row.original.quantity} ${row.original.unit}` },
    { accessorKey: "status", header: "状态" },
    ...auditColumns<Order>(),
    { id: "actions", header: "操作", cell: ({ row }) => <div className="action-row">
      {["draft", "confirmed"].includes(row.original.status) && <Button size="sm" variant="secondary" asChild><Link href={`/sales/orders/${row.original.id}/edit`} data-testid={`order-edit-${row.original.orderNo}`}>编辑</Link></Button>}
      {/* 工艺单：按 example/销售单 的模板版式导出，图片格留空。销售每天要打这张单，所以不锁管理员。 */}
      <Button size="sm" variant="secondary" data-testid={`order-production-sheet-${row.original.orderNo}`} disabled={exportingId === row.original.id} onClick={() => void exportProductionSheet(row.original)}>{exportingId === row.original.id ? "导出中…" : "工艺单"}</Button>
      {row.original.status === "draft" && <Button size="sm" variant="secondary" onClick={() => confirmOrder(row.original)}>确认</Button>}
      {row.original.status === "draft" && <Button size="sm" variant="destructive" data-testid={`order-delete-${row.original.orderNo}`} onClick={() => deleteOrder(row.original)}>删除</Button>}
      {row.original.status === "confirmed" && <Button size="sm" variant="secondary" onClick={() => revertOrder(row.original)}>回到草稿</Button>}
    </div> },
  ];

  if (loading) return <div className="page-root" data-testid={testId}><PageHeader title="销售单" breadcrumb={["客户与销售", "销售单"]} /><LoadingState /></div>;

  return <div className="page-root" data-testid={testId}>
    <PageHeader title="销售单" breadcrumb={["客户与销售", "销售单"]} description="销售单列表：确认与回退、删除草稿、导出工艺单、通知仓库出库。">
      <Button asChild><Link href="/sales/orders/new" data-testid="sales-order-new">新建销售单</Link></Button>
    </PageHeader>
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={async (values) => { await dialog?.submit(values); setDialog(null); }} />
    {sheetExport && <ProductionSheetExportDialog orderId={sheetExport.id} orderNo={sheetExport.orderNo} candidates={sheetExport.candidates} open onOpenChange={(open) => { if (!open) setSheetExport(null); }} />}
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    <section className="panel">
      <div className="panel-heading"><h2>销售单</h2></div>
      <div className="panel-body">
        <div className="filter-bar">
          <label>搜索订单、货号、客户或状态<Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词" /></label>
          <label>货号
            <Select value={itemNoFilter} onValueChange={(value) => setItemNoFilter(value as "all" | "with" | "without")}>
              <SelectTrigger data-testid="sales-item-no-filter"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">全部</SelectItem><SelectItem value="with">仅填了货号</SelectItem><SelectItem value="without">未填货号（待补录）</SelectItem></SelectContent>
            </Select>
          </label>
        </div>
        <DataTable columns={orderColumns} data={visibleOrders} empty={<EmptyState title="暂无销售单" />} />
      </div>
    </section>
    <Sheet open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }}>
      <SheetContent>
        <SheetHeader><SheetTitle>{selected?.orderNo}</SheetTitle><SheetDescription>销售单详情</SheetDescription></SheetHeader>
        {selected && <div className="detail-list">
          <p>客户：{selected.customer.name}</p>
          <p>产品：{selected.productName}</p>
          <p>规格：{selected.productSpec || "-"}</p>
          <p>数量：{selected.quantity} {selected.unit}</p>
          <p>单价：{selected.unitPrice ?? "-"}</p>
          <p>金额：{selected.totalAmount ?? "-"}</p>
          <p>结算币价：{selected.settlementUnitPrice ?? "-"}</p>
          <p>应收金额：{selected.receivableAmount ?? "-"}</p>
          <p>结算方式：{settlementMethodLabel(selected.settlementMethod)}</p>
          <p>本币金额：{selected.localCurrencyAmount ?? "-"}</p>
          <p>状态：{selected.status}</p>
          {auditDetailFields(selected).map((field) => <p key={field.label}>{field.label}：{field.value}</p>)}
        </div>}
        {selected && <div className="detail-list">
          <h3>成品入库与出库</h3>
          {finishedGoods?.totals?.length ? <p data-testid="order-finished-goods-totals">{finishedGoods.totals.map((item) => `${item.product_name} ${item.unit} · 全部成品 ${item.inbound_quantity} · 已出库 ${item.outbound_quantity} · 未出库 ${item.unshipped_quantity}`).join("；")}</p> : null}
          {!finishedGoods ? <p>正在加载成品情况…</p> : <>
            {finishedGoods.production_orders.length === 0 ? <p>该销售单还没有生产单，无法通知出库。</p> : <>
              <div className="page-actions"><Button size="sm" variant="secondary" disabled={finishedGoodsBusy} onClick={() => void notifyAllOutbound()}>通知仓库出库（全部可出库批次）</Button></div>
              {finishedGoods.production_orders.map((row) => <div className="contact-block" key={row.production_order_id}>
                <p>{row.production_order_no} · {row.production_status === "completed" ? "已完工" : row.production_status === "in_progress" ? "生产中" : row.production_status}</p>
                <p>成品已入库 {row.inbound_quantity} / 已出库 {row.outbound_quantity} / 待仓库建单 {row.pending_notice_quantity} / 可出库 {row.available_quantity} {row.unit ?? finishedGoods.unit}</p>
                <div className="page-actions"><Button size="sm" disabled={finishedGoodsBusy || Number(row.available_quantity) <= 0} title={Number(row.available_quantity) <= 0 ? "没有可出库的成品（需先成品入库，或已在等待仓库出库）" : `可出库 ${row.available_quantity}${row.unit ? ` ${row.unit}` : ""}：可只通知一部分（分批出库），余量以后再通知`} onClick={() => openNotifyOutbound(row)}>通知仓库出库</Button></div>
                {row.notices.length ? row.notices.map((notice) => <p key={notice.id}>
                  {notice.notice_no} · 通知 {notice.notice_quantity} · 已出库 {notice.shipped_quantity ?? "0"} · 剩余 {notice.remaining_quantity ?? "-"} · {outboundNoticeStatusLabels[notice.status] ?? notice.status}
                  {notice.outbound_nos?.length ? ` · 出库单 ${notice.outbound_nos.join("、")}` : ""}
                  {["pending", "partially_outbound"].includes(notice.status) && Number(notice.remaining_quantity ?? notice.notice_quantity) > 0 ? <Button size="sm" variant="ghost" onClick={() => cancelOutboundNotice(notice)}>{notice.status === "partially_outbound" ? `取消剩余通知（剩余 ${notice.remaining_quantity ?? "-"}）` : "取消通知"}</Button> : null}
                </p>) : <p>暂无出库通知</p>}
              </div>)}
            </>}
          </>}
        </div>}
      </SheetContent>
    </Sheet>
  </div>;
}

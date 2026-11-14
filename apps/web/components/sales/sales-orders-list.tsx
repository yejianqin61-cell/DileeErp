"use client";

// 销售二级页：销售单列表（含打开单据看成品入库/出库、通知仓库出库、导出工艺单）。
//
// 与改造前的关系：这段逻辑原来长在 `app/sales/page.tsx` 里，现在整段搬进独立页面，
// 行为与 testid 全部保留（`sales-order-new` / `order-edit-*` / `order-production-sheet-*` /
// `sales-item-no-filter` 与销售单详情 Sheet 里的每一句文案），只是不再与客户池、成品总览挤一页。
//
// 三条不能丢的口径：
//   1. **出库通知的数量由服务端裁决**（超过可出库量返回 422），前端只把原因显示出来；
//   2. **工艺单导出**：这一单有可导出的图片（材料行图 / 引用物料图 / 明细行图）才弹勾选窗
//      （没图直接出文件，不多一次点击；2026-11-04 起候选也含行级图片，见设计文档）；
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
import { fuzzyMatch } from "../../lib/fuzzy-search";
import { DEFAULT_SALES_ORDER_SORT_VALUE, SALES_ORDER_SORT_OPTIONS, salesOrderListPath } from "../../lib/sales-order-sort";
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
type DialogState = { title: string; fields: ActionField[]; /** 提交按钮文案（删除确认框用「确认删除」，别的操作保持默认「保存」）。 */ submitLabel?: string; submit: (values: Record<string, string>) => void | Promise<void> };
/**
 * `GET /sales-orders/:id/delete-preview` 的形状（2026-11-03，契约见设计文档 §3.1）。
 * `downstream` 只有 `count > 0` 的类型，顺序由后端按 ORPHAN_DOCUMENT_TYPES 固定。
 */
type DeletePreviewDocument = { key: string; label: string; count: number };
type DeletePreview = { sales_order_id: string; order_no: string; status: string; reason_required: boolean; downstream: DeletePreviewDocument[]; downstream_total: number };

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
  /**
   * 排序（2026-11-13，用户：「需要给销售单排序，支持按照销售单号字典序排序，创建时间排序」）。
   *
   * 值形如 `order_no:asc`，选项与文案在 `lib/sales-order-sort.ts`（与后端口径有静态守卫比对）。
   * **排序在服务端做**：这个接口是分页的，前端手上只有 `page_size=200` 那一页，
   * 在前端排只会在翻页时前后矛盾。这里只负责如实把选中的那一项发出去。
   */
  const [sortValue, setSortValue] = useState<string>(DEFAULT_SALES_ORDER_SORT_VALUE);
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
  // 正在读「删除影响面」的那一行：读接口回来之前按钮不能连点（否则会弹两次确认框）。
  const [deletingId, setDeletingId] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      setOrders((await apiGet<Order[]>(salesOrderListPath(sortValue))).data);
    } catch (cause) {
      setError(messageOf(cause, "销售数据加载失败"));
    } finally {
      setLoading(false);
    }
  }
  // 排序变了要**重新拉**（排序是服务端做的，不重拉就只是换了个下拉的文字）。
  useEffect(() => { void load(); }, [sortValue]);

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
    // 搜索语义全站统一（空格分词 AND、忽略大小写与空白、空查询不过滤），见 lib/fuzzy-search.ts。只搜这张表**看得见**的列。
    return fuzzyMatch(query, [order.orderNo, order.itemNo, order.customer.name, order.productName, order.quantity, order.unit, order.status]);
  }), [orders, query, itemNoFilter]);

  function confirmOrder(order: Order) { void run(() => apiPost(`/sales-orders/${order.id}/confirm`), "销售单已确认"); }
  function revertOrder(order: Order) { setDialog({ title: "销售单回退草稿", fields: [{ name: "reason", label: "回退原因", type: "textarea", required: true }], submit: (v) => void run(() => apiPost(`/sales-orders/${order.id}/revert-draft`, v), "销售单已回到草稿") }); }
  /**
   * 删除销售单（2026-11-03 起对所有状态开放），两条路：
   *
   * ① **草稿：一键删**，不弹确认框、不填原因 —— 用户 2026-10-08 拍板「草稿多是录错或重复录入，
   *    点一下就该消失，多一次确认只是多一步」。这一版只扩大了「哪些状态能删」，没有推翻这条；
   *    而且草稿不可能有下游单据，弹一个「会留下 0 张单据」的框只是让用户白点一次。
   *
   * ② **非草稿（已确认 / 已关闭）：预览 → 确认框 → 必须填原因**。删除**不再带走下游单据**，
   *    采购单 / 生产单 / 成品出库单 / 应收来源…会原样留下、显示为「孤立单据」，所以先问服务端
   *    会留下什么（`GET /:id/delete-preview`，与真删共用同一张 11 类清单），把「哪些类型、各多少张」
   *    铺在确认框里，看清楚再动手。原因必填：删的是一整条链的父单，比删草稿重得多；
   *    是否必填仍由服务端的 `reason_required` 给（预览与执行的后端判定是同一个函数，两边不会分叉）。
   */
  async function deleteOrder(order: Order) {
    setDeletingId(order.id);
    try {
      // 草稿一键删：不调 delete-preview（没有下游可预览），失败照旧把服务端原因 toast 出来。
      if (order.status === "draft") { await performDelete(order, 0); return; }
      const preview = (await apiGet<DeletePreview>(`/sales-orders/${order.id}/delete-preview`)).data;
      const fields: ActionField[] = [{ name: "effect", type: "info", label: "销售单会被删除；它的下游单据一张都不删、也不解绑，删除后显示为「孤立单据」。" }];
      if (preview.downstream_total > 0) {
        // 一类一行，而不是拼成一句话：读的人要能一眼数清「2 张采购单 + 1 张生产单」。
        fields.push({ name: "downstream-summary", type: "info", label: `删除后会留下 ${preview.downstream_total} 张下游单据：` });
        for (const document of preview.downstream) fields.push({ name: `downstream-${document.key}`, type: "info", label: `${document.label}：${document.count} 张` });
      } else {
        fields.push({ name: "downstream-none", type: "info", label: "这张销售单没有下游单据：删除后不会留下孤立单据。" });
      }
      if (preview.reason_required) fields.push({ name: "reason", label: "删除原因（必填，会记进审计）", type: "textarea", required: true, placeholder: "例如：客户取消订单 / 重复录入，需整单作废" });
      setDialog({
        title: `删除销售单：${preview.order_no}`,
        submitLabel: "确认删除",
        fields,
        // 必须把 Promise 交回 ActionDialog：它靠 onSubmit 抛错决定「保持弹窗 + 显示原因」，
        // 被 void 吞掉就会关窗，用户填的原因与服务端拒绝理由一起丢（采购单打印信息踩过同一个坑）。
        submit: async (values) => { await performDelete(order, preview.downstream_total, values.reason?.trim() || undefined); },
      });
    } catch (cause) {
      notifyError(messageOf(cause, "读取删除影响失败，请稍后重试"));
    } finally {
      setDeletingId("");
    }
  }
  /** 真正发 DELETE 并统一「toast + 重新拉列表」—— 草稿一键删与确认框共用，成功文案也就只有一处。 */
  async function performDelete(order: Order, downstreamTotal: number, reason?: string) {
    await apiDelete(`/sales-orders/${order.id}`, reason ? { reason } : undefined);
    notifySuccess(downstreamTotal > 0 ? `已删除销售单 ${order.orderNo}（留下 ${downstreamTotal} 张孤立单据）` : `已删除销售单 ${order.orderNo}`);
    await load();
  }
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
   * 先问一次「这一单有哪些可导出的图片」（2026-11-04 起含材料行自己的图、引用物料的图与
   * 细分明细行的图，形状见 docs/design/sales-order-row-images-2026-11-04.md §2.4）：
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
      {/*
        复制（2026-10-XX）：任何状态都能用 —— 含草稿，也**不要求有货号**（与「返单」的三条门槛相反）。
        是一个链接而不是按钮：新建页的复制模式由 URL 参数决定（`?copy_from_id=`），
        这样业务能把「照这一张新建」的链接直接发给同事，也不用在这里再实现一遍预填。
        用 id 而不是单号：列表行手上就是 id，复制这条路口径上不需要先知道单号。
      */}
      <Button size="sm" variant="secondary" asChild><Link href={`/sales/orders/new?copy_from_id=${row.original.id}`} data-testid={`order-copy-${row.original.orderNo}`}>复制</Link></Button>
      {/* 工艺单：按 example/销售单 的模板版式导出，图片格留空。销售每天要打这张单，所以不锁管理员。 */}
      <Button size="sm" variant="secondary" data-testid={`order-production-sheet-${row.original.orderNo}`} disabled={exportingId === row.original.id} onClick={() => void exportProductionSheet(row.original)}>{exportingId === row.original.id ? "导出中…" : "工艺单"}</Button>
      {row.original.status === "draft" && <Button size="sm" variant="secondary" onClick={() => confirmOrder(row.original)}>确认</Button>}
      {/*
        删除（2026-11-03）：**所有状态都能删**。草稿一键删；非草稿先读影响面再弹确认框、必填原因
        （两条路的理由见 deleteOrder 上方的注释）。
      */}
      <Button size="sm" variant="destructive" data-testid={`order-delete-${row.original.orderNo}`} disabled={deletingId === row.original.id} onClick={() => void deleteOrder(row.original)}>{deletingId === row.original.id ? "删除中…" : "删除"}</Button>
      {row.original.status === "confirmed" && <Button size="sm" variant="secondary" onClick={() => revertOrder(row.original)}>回到草稿</Button>}
    </div> },
  ];

  if (loading) return <div className="page-root" data-testid={testId}><PageHeader title="销售单" breadcrumb={["客户与销售", "销售单"]} /><LoadingState /></div>;

  return <div className="page-root" data-testid={testId}>
    <PageHeader title="销售单" breadcrumb={["客户与销售", "销售单"]} description="销售单列表：确认与回退、删除（下游单据保留为孤立单据）、导出工艺单、通知仓库出库。">
      {/* 删单不会带走下游单据，它们集中收在「孤立单据」页；入口放在这里，删完就能点过去看留了什么。 */}
      <Button variant="secondary" asChild><Link href="/sales/orphans" data-testid="sales-orphans-link">孤立单据</Link></Button>
      {/* Excel 补录（2026-11-02）：偶发动作，所以是次要按钮，排在新单之后。 */}
      <Button variant="secondary" asChild><Link href="/sales/orders/import" data-testid="sales-order-import">从 Excel 补录</Link></Button>
      <Button asChild><Link href="/sales/orders/new" data-testid="sales-order-new">新建销售单</Link></Button>
    </PageHeader>
    <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} submitLabel={dialog?.submitLabel} onSubmit={async (values) => { await dialog?.submit(values); setDialog(null); }} />
    {sheetExport && <ProductionSheetExportDialog orderId={sheetExport.id} orderNo={sheetExport.orderNo} candidates={sheetExport.candidates} open onOpenChange={(open) => { if (!open) setSheetExport(null); }} />}
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    <section className="panel">
      <div className="panel-heading"><h2>销售单</h2></div>
      <div className="panel-body">
        <div className="filter-bar">
          <label>搜索订单号、货号、客户、产品或状态<Input data-testid="sales-order-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入关键词，空格分隔多个词" /></label>
          {query.trim() ? <span className="panel-note" data-testid="sales-order-search-count">筛选后 {visibleOrders.length} / {orders.length} 张</span> : null}
          {query.trim() ? <Button variant="secondary" onClick={() => setQuery("")}>清除搜索</Button> : null}
          <label>货号
            <Select value={itemNoFilter} onValueChange={(value) => setItemNoFilter(value as "all" | "with" | "without")}>
              <SelectTrigger data-testid="sales-item-no-filter"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">全部</SelectItem><SelectItem value="with">仅填了货号</SelectItem><SelectItem value="without">未填货号（待补录）</SelectItem></SelectContent>
            </Select>
          </label>
          {/*
            排序（2026-11-13）：用户要「按销售单号字典序」与「按创建时间」两种。
            放在筛选栏里而不是做成表头点击排序 —— `DataTable` 是全站共用的（96 张表），
            给表头加排序要动那个共用组件；而后端排序需要一个显式的参数来源，
            一个下拉比"哪几列可点"更好解释（也更好测）。
          */}
          <label>排序
            <Select value={sortValue} onValueChange={setSortValue}>
              <SelectTrigger data-testid="sales-order-sort"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SALES_ORDER_SORT_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        </div>
        <DataTable columns={orderColumns} data={visibleOrders} empty={query.trim() ? <EmptyState title={`没有匹配“${query.trim()}”的销售单`} description={`共 ${orders.length} 张销售单，换个关键词或清空搜索框。`} /> : <EmptyState title="暂无销售单" />} />
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

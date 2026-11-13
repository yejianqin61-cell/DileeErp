"use client";

// 采购单（2026-09-27 瘦身）：**只放"已经过供应商收束下单的采购单"**（口径 11）。
//
// 用户原话：「也就是说，采购单模块就是所有已经经过供应商收束下单的采购单了。」
//
// 这一页原来的「草稿工作区」（新建采购单 → 带入 BOM 明细 → 逐行填供应商 → 保存草稿 / 收束下单）
// 整套搬去了 `/procurement/plans`（采购计划），因为草稿就是计划的半成品形态。
// 于是这一页去掉了：新建采购单、草稿筛选 tab、编辑明细、下单。
//
// 留下的都是**凭证层**的事：打印信息（付款方式/交期条款/交货地址/交货日期/备注/回签）、
// 导出、到货跟踪、关闭到货，以及**退回采购计划**（供应商做不了 / 价格谈崩了 / 下错了）。
//
// ⚠️ 为什么「数量/单价/供应商」在这里**不能再改**（口径 7）：这张单已经发给供应商了，
// 而采购计划是唯一的编辑点。两个模块都能改，同一批货就有两份数字，
// 而「这张 BOM 还差什么没买」立刻失真。要改就「退回采购计划」——
// 退回是**可逆**的：计划行保留数量/单价/供应商，只断开"已下单"这个链接。
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { ActionDialog, type ActionField } from "../../../components/ui/action-dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { DataTable } from "../../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet, apiPost, apiRequest } from "../../../lib/api-client";
import { fuzzyMatch } from "../../../lib/fuzzy-search";
import { downloadFile } from "../../../lib/download";
import { shouldRefreshOnVisibility } from "../../../lib/refresh-policy";
import { auditColumns, type AuditRow } from "../../../components/data/audit-columns";
import { OrderNoWithOrphan } from "../../../components/data/orphan-badge";
import { paymentTermOptions, printFieldsDefaults, printFieldsPayload } from "../../../lib/purchase-order-print";
import { notifyError, notifySuccess } from "../../../components/ui/toaster";

type Receipt = { id: string; receiptNo: string; quantity: string; status?: string };
type PurchaseItem = { id: string; materialId: string; quantity: string; unitPrice?: string; unit?: { name?: string }; receipts: Receipt[] };
type PurchaseOrder = AuditRow & {
  id: string; purchaseOrderNo: string; orderNo: string; bomId: string | null;
  purchaseDate?: string | null; expectedDate?: string | null; status: string; currency: string | null; totalAmount: string;
  extensionData?: { arrival_closed?: boolean; over_order?: boolean };
  /** 打印信息（2026-09-16）：付款方式 / 交期条款 / 交货地址 / 厂家回签意见 / 厂家回签 / 主管签字 */
  paymentTerms?: string | null; deliveryTerms?: string | null; deliveryAddress?: string | null;
  supplierReply?: string | null; supplierSigned?: string | null; supervisorSignature?: string | null; remark?: string | null;
  /** 所属销售单已被软删（2026-11-03）：这张采购单不删、也不解绑，只显示成「孤立」——判定只认后端字段。 */
  orphaned?: boolean;
  supplier?: { name: string } | null; items: PurchaseItem[];
};
type DialogState = { title: string; fields: ActionField[]; submit: (values: Record<string, string>) => void | Promise<void> };

const messageOf = (cause: unknown, fallback: string) => (cause instanceof ApiClientError ? cause.message : fallback);
/**
 * 下载类失败（lib/download 抛普通 Error，消息已经是可读原因：超时 / HTTP 码 / 服务端 message）。
 * 不能套 `messageOf` 的兜底 —— 那会把「导出失败：服务端异常」压成光秃秃的「导出失败」。
 */
const downloadErrorOf = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);
const statusMap: Record<string, string> = { ordered: "已下单", partially_arrived: "部分到货", arrived_complete: "到货完成" };

/**
 * 采购单列表的列宽（2026-10-09：`DataTable` 一律 `table-layout: fixed`，没写宽度的列由浏览器**均分**，
 * 这里把「均分」换成「按内容需要分配」）。
 *
 * 口径同 `app/procurement/inbounds/page.tsx`，两个常数先记住：
 *   - 可用宽度基线 **1034px**（1366 视口减侧栏后的实测表宽）；
 *   - `.ui-table-cell` 左右各 12px 内边距 → 一列定 n% 后真正能放字的宽度是 `n% × 1034 - 24`
 *     （8% → 58.7px，与 `components/data/audit-columns.tsx:44` 记的实测值一致）。
 *
 * 本表 8 列 = 6 列业务列（含「操作」）+ `auditColumns()` 的「创建人 / 最后修改人」。
 * 后两列**刻意不给宽度、也不改工厂用法**（`lib/audit-columns-coverage.test.mjs` 有守卫），
 * 所以下面 6 个数字的总和必须是 **84%**，剩下 16% 由那两列均分（各 8% = 58.7px）。
 */
const COLUMN_WIDTH = {
  // 采购单号：`PO-20261009-0001` 一行 16 字符 ≈ 110px（需求 10.6%），但 84% 要分给 6 列、
  // 其中操作列一个就吃掉 28%（见下）。按内容取 11%（= 89.7px，放得下约 9 个字符），
  // 长出来的靠「cell-ellipsis 省略 + hover 看全文」兜住。
  purchaseOrderNo: "11%",
  // 订单号：与采购单号同形（`SO-20261009-0001`），取 12% —— 它还是打开详情的链接，
  // 一次能看到整串比省下 1% 更值（多出这 1% 正好把 84% 分平）。
  orderNo: "12%",
  // 供应商：供应商名 6~14 汉字（`深圳市恒达精密制造有限公司`），这是本表最长的文本列，
  // 取规则下限往上 11%（= 89.7px，放得下 7 个汉字）；剩下的靠 hover 看全。
  supplier: "10%",
  // 状态：`已下单 / 部分到货 / 到货完成 / 超单`，最长 4 汉字 ≈ 48px，
  // 短状态 4%~6% 里取 6%（= 38.1px），超长部分 hover。
  status: "6%",
  // 金额：`123456.78 CNY` ≈ 13 字符 ≈ 90px，金额列规则下限 7%，这里给 16%（= 141.4px）——
  // 它的取值区间是「≥7% 无上限」，而金额看错一位就是事故，宁宽勿窄。
  amount: "14%",
  // 操作列：**最多同时 6 个控件**（到货跟踪 / 关闭到货 / 退回采购计划 / 打印信息 / 导出 / 「已关闭」标签）。
  // 按规则「每控件 44px + 间距 4px」：5 个按钮 + 1 个标签 = 6 × 44 + 5 × 4 = 284px，
  // 加本格 24px 内边距 = 308px → 29.8%。按 12px 字号的实测值重算一遍更松：
  // `ui-button-sm`（padding 0 10px、font-size 12px）下四字按钮 ≈ 68px、六字按钮 ≈ 92px，
  // 6 个 ≈ 448px → 43%，做不到；所以取 28%（= 289.5px）。
  // 为什么必须给到全表最大的一列：`.action-row`（`globals.css:134`）是 `flex-wrap: wrap`，
  // 格子不够宽时按钮会**叠行**把行高撑起来，且没有任何省略号提示这件事 —— 这里宁可让
  // 「供应商」只有 11%（hover 看全），也不让操作列叠行。
  // 给常见的 3～4 个动作留出同一行空间，减少采购单列表的行高抖动。
  actions: "31%",
} as const;

export default function PurchaseOrdersPage() {
  const searchParams = useSearchParams();
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [exportBusy, setExportBusy] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  // 预置筛选：工作台与【返单与总结】都会用 `?order_no=` 跳过来。只在挂载时取初值，
  // 之后的手工清空/输入不受影响（预置值是起点，不是锁）。
  const [query, setQuery] = useState(searchParams.get("order_no") ?? "");

  async function load(options: { silent?: boolean } = {}) {
    if (!options.silent) setLoading(true);
    setError("");
    try {
      const result = await apiGet<PurchaseOrder[]>("/purchase-orders");
      setOrders(result.data ?? []);
    } catch (cause) { setError(messageOf(cause, "采购单数据加载失败")); }
    finally { if (!options.silent) setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  /**
   * 到货状态必须跟着窗口焦点刷新，而不是只在挂载时拉一次。
   *
   * 场景：仓库那边过账/登记到货之后，本页的"部分到货 / 到货完成"如果不刷新就一直显示旧状态。
   * 两条要求（`lib/refresh-policy.test.mjs` 有守卫盯着）：
   *   1. 只在页面**可见**时刷（后台标签页不刷）；
   *   2. **静默**刷 —— 切回本页时不能整页 loading，否则会把正在填的打印信息弹窗连同 DOM 一起卸载。
   */
  useEffect(() => {
    const refresh = () => { if (shouldRefreshOnVisibility(document.visibilityState)) void load({ silent: true }); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);

  const visible = useMemo(() => orders.filter((item) => {
    // 搜索语义全站统一（空格分词 AND、忽略大小写与空白）：改用 fuzzyMatch，多词查询才成立。
    if (query && !fuzzyMatch(query, [item.purchaseOrderNo, item.orderNo, item.status, item.supplier?.name])) return false;
    if (statusFilter === "all") return true;
    const totals = item.items.reduce((s, i) => { s.planned += Number(i.quantity); s.received += i.receipts.reduce((sum, r) => sum + Number(r.quantity), 0); return s; }, { planned: 0, received: 0 });
    if (statusFilter === "over") return totals.received > totals.planned;
    if (statusFilter === "complete") return totals.received === totals.planned && totals.planned > 0;
    if (statusFilter === "arrived") return item.status === "partially_arrived" || item.status === "arrived_complete";
    return item.status === statusFilter;
  }), [orders, query, statusFilter]);

  async function action(path: string, body?: unknown, success = "操作已完成", method: "POST" | "PATCH" = "POST") {
    setError("");
    try {
      if (method === "PATCH") await apiRequest(path, { method, body: JSON.stringify(body) });
      else await apiPost(path, body);
      notifySuccess(success);
      await load();
    } catch (cause) { notifyError(messageOf(cause, "操作失败")); }
  }

  async function exportPurchaseOrder(order: PurchaseOrder) {
    setExportBusy(order.id);
    try { await downloadFile(`/api/v1/procurement/reports/purchase-order.xlsx?purchase_order_id=${encodeURIComponent(order.id)}`, `采购订单-${order.purchaseOrderNo}.xlsx`); notifySuccess(`已导出 ${order.purchaseOrderNo}`); }
    catch (cause) { notifyError(downloadErrorOf(cause, "导出失败")); }
    finally { setExportBusy(""); }
  }

  async function exportPurchaseOrders() {
    if (!visible.length) { setError("当前筛选没有可导出的采购单"); return; }
    setExportBusy("all");
    try {
      const params = new URLSearchParams();
      if (query) params.set("order_no", query);
      await downloadFile(`/api/v1/procurement/reports/purchase-orders.xlsx${params.toString() ? `?${params.toString()}` : ""}`, "采购订单汇总.xlsx");
      notifySuccess(`已导出 ${visible.length} 张采购订单`);
    } catch (cause) { notifyError(downloadErrorOf(cause, "批量导出失败")); }
    finally { setExportBusy(""); }
  }

  /**
   * 采购单「打印信息」（用户 2026-09-16：付款方式 / 交期条款 / 交货地址 / 交货日期 /
   * 厂家回签意见 / 厂家回签 / 主管签字 / 备注）。
   *
   * 这一组字段与明细/金额/供应商都无关，所以**任何状态**都能填（含已下单、已到货）——
   * 厂家回签本来就是下单之后才发生的事，后端也是这么放行的（PATCH /print-fields）。
   */
  function openPrintInfo(order: PurchaseOrder) {
    setDialog({
      title: `打印信息：${order.purchaseOrderNo}`,
      fields: [
        { name: "payment_terms", label: "付款方式", type: "select", options: paymentTermOptions(order.paymentTerms), defaultValue: printFieldsDefaults(order).payment_terms },
        { name: "expected_date", label: "交货日期（打印在表头；留空则按明细行日期）", type: "date", defaultValue: printFieldsDefaults(order).expected_date },
        { name: "delivery_terms", label: "交期条款", type: "textarea", defaultValue: printFieldsDefaults(order).delivery_terms },
        { name: "delivery_address", label: "交货地址", defaultValue: printFieldsDefaults(order).delivery_address },
        { name: "supplier_reply", label: "厂家回签意见（存系统；导出仍留空供手写）", type: "textarea", defaultValue: printFieldsDefaults(order).supplier_reply },
        { name: "supplier_signed", label: "厂家回签（经办人 / 日期）", defaultValue: printFieldsDefaults(order).supplier_signed },
        { name: "supervisor_signature", label: "主管签字", defaultValue: printFieldsDefaults(order).supervisor_signature },
        { name: "remark", label: "备注", type: "textarea", defaultValue: printFieldsDefaults(order).remark },
      ],
      // 必须把 Promise 交回 ActionDialog（不要写成 `void savePrintInfo(...)`）：
      // 它靠 onSubmit 抛错来决定「保持弹窗打开 + 显示原因」，被 void 吞掉就会关窗、用户填的几行字全丢。
      submit: (values) => savePrintInfo(order, values),
    });
  }

  async function savePrintInfo(order: PurchaseOrder, values: Record<string, string>) {
    setError("");
    try {
      await apiRequest(`/purchase-orders/${order.id}/print-fields`, { method: "PATCH", body: JSON.stringify(printFieldsPayload(values)) });
      notifySuccess(`${order.purchaseOrderNo} 打印信息已保存`);
      await load({ silent: true });
    } catch (cause) {
      // 抛出去：ActionDialog 会保持弹窗打开并显示原因，用户填的几行字不会丢
      notifyError(messageOf(cause, "打印信息保存失败"));
      throw cause;
    }
  }

  /** 退回采购计划（口径 15③，替换原来的「回到草稿」）。 */
  function revertToPlan(order: PurchaseOrder) {
    setDialog({
      title: `退回采购计划：${order.purchaseOrderNo}`,
      fields: [{
        name: "reason",
        label: "退回原因（这张单会作废留痕；计划行保留数量/单价/供应商，回到未下单）",
        required: true,
        type: "textarea",
      }],
      submit: (values) => action(`/purchase-orders/${order.id}/revert-to-plan`, { reason: values.reason }, "采购单已退回采购计划"),
    });
  }

  const orderColumns: ColumnDef<PurchaseOrder>[] = [
    { accessorKey: "purchaseOrderNo", header: "采购单号", meta: { width: COLUMN_WIDTH.purchaseOrderNo } },
    // 订单号是这张单「属于哪张销售单」的唯一线索；销售单被删后这里会多一个「孤立」徽章。
    { id: "orderNo", header: "订单号", meta: { width: COLUMN_WIDTH.orderNo }, cell: ({ row }) => <OrderNoWithOrphan orphaned={row.original.orphaned} orderNo={<Button variant="link" asChild><Link href={`/procurement/orders/${row.original.id}`}>{row.original.orderNo}</Link></Button>} /> },
    { id: "supplier", header: "供应商", meta: { width: COLUMN_WIDTH.supplier }, cell: ({ row }) => row.original.supplier?.name ?? "-" },
    { id: "status", header: "状态", meta: { width: COLUMN_WIDTH.status }, cell: ({ row }) => { const totals = row.original.items.reduce((s, i) => { s.planned += Number(i.quantity); s.received += i.receipts.reduce((sum, r) => sum + Number(r.quantity), 0); return s; }, { planned: 0, received: 0 }); return totals.received > totals.planned ? <span className="status-error">超单</span> : totals.received === totals.planned && totals.planned > 0 ? <span className="status-success">到货完成</span> : <span className="status-label">{statusMap[row.original.status] ?? row.original.status}</span>; } },
    { id: "amount", header: "金额", meta: { width: COLUMN_WIDTH.amount }, cell: ({ row }) => `${row.original.totalAmount} ${row.original.currency}` },
    ...auditColumns<PurchaseOrder>(),
    { id: "actions", header: "操作", meta: { width: COLUMN_WIDTH.actions }, cell: ({ row }) => {
      const complete = row.original.items.length > 0 && row.original.items.every((item) => item.receipts.reduce((sum, r) => sum + Number(r.quantity), 0) >= Number(item.quantity));
      const closed = row.original.extensionData?.arrival_closed;
      const noReceipts = row.original.items.every((item) => item.receipts.length === 0);
      // 可退回的范围与后端同一条线：只有"已下单且没有任何到货事实"。已有到货的要改内容，
      // 走质检/退货那条线 —— 到货是既成事实，退回计划会与它打架。
      const revertible = row.original.status === "ordered" && noReceipts;
      const canReceive = ["ordered", "partially_arrived", "arrived_complete"].includes(row.original.status) && !closed;
      return <div className="action-row purchase-table-actions">
        {canReceive && <Button size="sm" variant="secondary" asChild><Link href={`/procurement/orders/${row.original.id}`}>到货跟踪</Link></Button>}
        {complete && !closed && <Button size="sm" variant="secondary" onClick={() => void action(`/purchase-orders/${row.original.id}/close-arrivals`, undefined, "到货已关闭，批次已进入来料质检")}>关闭到货</Button>}
        {revertible && <Button size="sm" variant="ghost" data-testid={`order-revert-to-plan-${row.original.purchaseOrderNo}`} onClick={() => revertToPlan(row.original)}>退回采购计划</Button>}
        <Button size="sm" variant="secondary" data-testid={`order-print-info-${row.original.purchaseOrderNo}`} onClick={() => openPrintInfo(row.original)}>打印信息</Button>
        <Button size="sm" variant="secondary" data-testid={`order-export-${row.original.purchaseOrderNo}`} disabled={exportBusy === row.original.id} onClick={() => void exportPurchaseOrder(row.original)}>{exportBusy === row.original.id ? "导出中..." : "导出"}</Button>
        {closed && <span className="status-label status-success">已关闭</span>}
      </div>; } },
  ];

  return (
    <div className="page-root" data-testid="page-procurement-orders">
      <PageHeader title="采购单" breadcrumb={["采购", "采购单"]} description="已经过供应商收束下单的采购单。要改数量/单价/供应商请去采购计划；这里只登记到货、关闭到货与打印信息。">
        <Button variant="secondary" onClick={() => void load()}>刷新</Button>
        <Button variant="secondary" disabled={exportBusy === "all"} onClick={() => void exportPurchaseOrders()}>{exportBusy === "all" ? "导出中..." : "导出当前筛选"}</Button>
      </PageHeader>
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
      <div className="filter-bar">
        <label>搜索
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="采购单号 / 订单号 / 状态" aria-label="搜索采购单" data-testid="order-search" />
        </label>
        <div className="page-actions">
          {[{ value: "all", label: "全部" }, { value: "ordered", label: "已下单" }, { value: "arrived", label: "已到货" }, { value: "over", label: "超单" }, { value: "complete", label: "已完成" }].map((tab) => <Button key={tab.value} size="sm" variant={statusFilter === tab.value ? "secondary" : "ghost"} data-active={statusFilter === tab.value} data-testid={`order-status-${tab.value}`} onClick={() => setStatusFilter(tab.value)}>{tab.label}</Button>)}
        </div>
      </div>
      {loading ? <LoadingState /> : <DataTable columns={orderColumns} data={visible} empty={<EmptyState title={query ? "没有匹配的采购单" : "暂无采购单"} description={query ? "换个筛选条件试试。" : "采购单在采购计划里「收束下单」之后产生。"} />} />}
      <ActionDialog open={Boolean(dialog)} onOpenChange={(open) => { if (!open) setDialog(null); }} title={dialog?.title ?? "操作"} fields={dialog?.fields ?? []} onSubmit={(values) => dialog?.submit(values)} />
    </div>
  );
}

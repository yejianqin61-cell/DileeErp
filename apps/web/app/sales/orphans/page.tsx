"use client";

// 销售 → 孤立单据（2026-11-03，新页）。
//
// 用户口径：「销售单能够删除；删除后，相对应的采购单及其后续绑定的单据**不删**，而是显示为孤立单据。」
// 这一页就是「显示」的两个入口之一（另一个是各下游列表/详情里的「孤立」徽章）：
// 把**被删的销售单**按删除时间倒序排出来，每张下面列出它留下的单据（类型 / 单号 / 状态 / 金额 / 时间）。
//
// 为什么按销售单分组而不是平铺一张大表：用户的问题是「我删掉的那张单底下还留着什么」，
// 单据本身在各自的模块里都还在（采购/生产/仓库/财务都能照常打开），这里回答的是归属关系。
//
// 数据只有一个来源：`GET /sales-orders/orphans`（契约见设计文档 §3.3）。「孤立」的判定在服务端
// （下游单据的 sales_order_id 指向的销售单 deleted_at 非空），前端不按单号推断 ——
// 删除后同一单号可被新单重新使用，按单号猜会把旧单据错挂到新单上。
import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../../components/layout/app-shell";
import { Button } from "../../../components/ui/button";
import { DataTable } from "../../../components/data/data-table";
import { EmptyState, ErrorState, LoadingState } from "../../../components/feedback/states";
import { ApiClientError, apiGet } from "../../../lib/api-client";
import { displayStatus } from "../../../lib/display-text";
import { formatBeijing } from "../../../lib/audit-time";

/** 一类下游单据的张数（删除预览与汇总页共用同一张 11 类清单）。 */
type OrphanDocumentCount = { key: string; label: string; count: number };
/** 汇总页里的一行单体单据：各类单据的「单号/状态/金额」都由后端归一成这个形状。 */
type OrphanDocument = {
  id: string; type: string; label: string; document_no: string; order_no: string | null;
  status: string | null; amount: string | null; currency: string | null; occurred_at: string;
  sales_order_id: string;
};
/** 一张已删的销售单 + 它留下的单据类型与张数。 */
type OrphanSalesOrder = {
  sales_order_id: string; order_no: string; status: string; deleted_at: string; deleted_by_name: string | null;
  documents: OrphanDocumentCount[]; document_total: number;
};
type OrphanSummary = {
  orders: OrphanSalesOrder[]; documents: OrphanDocument[]; by_type: OrphanDocumentCount[];
  totals: { orders: number; documents: number }; truncated: boolean;
};

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;
/** 「采购单 2 张、生产单 1 张」——类型与张数，组头上用。 */
const documentCountText = (documents: OrphanDocumentCount[]) => documents.length ? documents.map((item) => `${item.label} ${item.count} 张`).join("、") : "没有下游单据";
const moneyText = (amount: string | null, currency: string | null) => amount ? `${amount}${currency ? ` ${currency}` : ""}` : "—";

/**
 * 单据明细的列（每张已删销售单下面一张）。宽度总和 100%：`DataTable` 一律 `table-layout: fixed`，
 * 剩下的宽度不给的话金额与时间会被均匀压缩。
 */
const DOCUMENT_COLUMNS: ColumnDef<OrphanDocument>[] = [
  { id: "type", header: "单据类型", meta: { width: "16%" }, accessorFn: (row) => row.label },
  { id: "documentNo", header: "单号", meta: { width: "22%" }, accessorFn: (row) => row.document_no },
  { id: "status", header: "状态", meta: { width: "14%" }, cell: ({ row }) => row.original.status ? displayStatus(row.original.status) : "—" },
  { id: "amount", header: "金额", meta: { width: "18%" }, cell: ({ row }) => moneyText(row.original.amount, row.original.currency) },
  { id: "occurredAt", header: "发生时间", meta: { width: "30%" }, cell: ({ row }) => formatBeijing(row.original.occurred_at) || "—" },
];

export default function SalesOrphansPage() {
  const [summary, setSummary] = useState<OrphanSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try { setSummary((await apiGet<OrphanSummary>("/sales-orders/orphans")).data); }
    catch (cause) { setError(messageOf(cause, "孤立单据加载失败")); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  /**
   * 按「被删的销售单」分组：`documents` 里的每行都带 `sales_order_id`（不是只带单号）——
   * 单号在删除后可以被新单重新使用，拿单号做分组键会把两张不同销售单的单据混在一起。
   */
  const groups = useMemo(() => {
    const byOrder = new Map<string, OrphanDocument[]>();
    for (const document of summary?.documents ?? []) {
      const list = byOrder.get(document.sales_order_id);
      if (list) list.push(document); else byOrder.set(document.sales_order_id, [document]);
    }
    return (summary?.orders ?? []).map((order) => ({ order, documents: byOrder.get(order.sales_order_id) ?? [] }));
  }, [summary]);

  if (loading) return <div className="page-root" data-testid="page-sales-orphans"><PageHeader title="孤立单据" breadcrumb={["客户与销售", "孤立单据"]} /><LoadingState /></div>;

  return <div className="page-root" data-testid="page-sales-orphans">
    <PageHeader title="孤立单据" breadcrumb={["客户与销售", "孤立单据"]} description="删除销售单不会删除它的下游单据：采购单、生产单、成品出库单、应收来源等原样保留，在这里按被删的销售单分组查看。">
      <Button variant="secondary" onClick={() => void load()}>刷新</Button>
    </PageHeader>
    {error && <section className="panel"><ErrorState message={error} onRetry={() => void load()} /></section>}
    {!summary ? null : !summary.orders.length
      // 空态文案按用户口径固定：「没有孤立单据」。
      ? <section className="panel"><EmptyState title="没有孤立单据" description="删除销售单后，它留下的下游单据会出现在这里；现在还没有删过任何销售单。" /></section>
      : <>
        <section className="panel">
          <div className="panel-body">
            {/* 头部先把「多少张销售单、多少张单据」说清楚；by_type 是跨销售单的合计（与组内计数同源）。 */}
            <p className="panel-note" data-testid="orphans-totals">
              被删销售单 <strong>{summary.totals.orders}</strong> 张，遗留孤立单据 <strong>{summary.totals.documents}</strong> 张：{documentCountText(summary.by_type)}
            </p>
            {summary.truncated ? <p className="panel-note" data-testid="orphans-truncated">单据明细最多显示 1000 行，其余只计入上面的统计数；每一类单据仍可在自己的模块里查到全部记录。</p> : null}
          </div>
        </section>
        {groups.map(({ order, documents }) => <section className="panel" key={order.sales_order_id} data-testid={`orphan-group-${order.sales_order_id}`}>
          <div className="panel-heading">
            <h2>{order.order_no}</h2>
            <span className="panel-note">
              删除于 {formatBeijing(order.deleted_at) || "—"}{order.deleted_by_name ? ` · ${order.deleted_by_name}` : ""}
            </span>
          </div>
          <div className="panel-body">
            <p className="panel-note">
              这张销售单已被删除（原状态 {displayStatus(order.status)}），留下 {order.document_total} 张单据：{documentCountText(order.documents)}
            </p>
            {documents.length ? <DataTable columns={DOCUMENT_COLUMNS} data={documents} empty={<EmptyState title="没有可显示的单据明细" />} /> : (
              // 明细被 1000 行上限截断时，可能这张单的明细一行都没进列表；不能说成「没有单据」。
              <p className="panel-note">{order.document_total > 0 ? "这张销售单的单据明细未包含在本次返回里（受明细行数上限影响），张数见上一行。" : "这张销售单没有留下下游单据。"}</p>
            )}
          </div>
        </section>)}
      </>}
  </div>;
}

"use client";

// 销售二级页：成品出库总览（模块级 —— 全部销售单按「产品 + 单位」汇总）。
//
// 口径（后端计算，前端只展示）：全部成品数 = 累计成品入库；已出库数 = 已过账/已发出/已签收出库；
// 未出库数 = 全部 − 已出库。按「产品 + 单位」分行：**不同单位的数量不做合计**。
//
// 为什么单独一页：这张表要回答的是老板的问题「还有多少成品压在仓里」，与「某一张销售单出到哪一步」
// 不是同一件事（后者在销售单详情里，按生产单列）。改造前它挤在销售页顶部，和客户池、销售单
// 两张表共用一个错误态；现在它自己一页，失败也不会连累另外两张表。
import { useEffect, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../layout/app-shell";
import { Button } from "../ui/button";
import { DataTable } from "../data/data-table";
import { EmptyState, ErrorState } from "../feedback/states";
import { ApiClientError, apiGet } from "../../lib/api-client";

/** 三个数字都是后端算好的 Decimal 字符串（前端不做任何加减）。 */
export type FinishedGoodsTotals = { product_name: string; unit: string; inbound_quantity: string; outbound_quantity: string; unshipped_quantity: string; production_order_count?: number };
export type FinishedGoodsOverviewData = { production_order_count: number; groups: FinishedGoodsTotals[] };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

export default function FinishedGoodsOverview({ testId = "page-sales-finished-goods" }: { testId?: string }) {
  const [overview, setOverview] = useState<FinishedGoodsOverviewData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setBusy(true);
    setError("");
    try {
      setOverview((await apiGet<FinishedGoodsOverviewData>("/sales-orders/finished-goods-summary")).data);
    } catch (cause) {
      // `overview` **不清空**：刷新失败时保留上一份数字，比让表格突然变空（像是"成品都没了"）安全。
      setError(messageOf(cause, "成品出库总览加载失败"));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void load(); }, []);

  const columns: ColumnDef<FinishedGoodsTotals>[] = [
    { accessorKey: "product_name", header: "产品" },
    { accessorKey: "unit", header: "单位" },
    { accessorKey: "inbound_quantity", header: "全部成品数" },
    { accessorKey: "outbound_quantity", header: "已出库数" },
    { accessorKey: "unshipped_quantity", header: "未出库数" },
    { id: "production_orders", header: "生产单数", cell: ({ row }) => row.original.production_order_count ?? 0 },
  ];

  return <div className="page-root" data-testid={testId}>
    <PageHeader title="成品出库总览" breadcrumb={["客户与销售", "成品出库总览"]} description="全部销售单的成品存量：入库、已出库与未出库。" />
    <section className="panel" data-testid="finished-goods-overview">
      <div className="panel-heading">
        <h2>成品出库总览</h2>
        <span className="panel-note" data-testid="finished-goods-overview-note">全部成品数 = 累计成品入库；已出库数 = 已过账/已发出/已签收出库；未出库数 = 全部 − 已出库（仍在成品仓）。按产品与单位分行：不同单位的数量不做合计。</span>
      </div>
      <div className="panel-body">
        <div className="page-actions"><Button size="sm" variant="secondary" data-testid="finished-goods-overview-refresh" disabled={busy} onClick={() => void load()}>刷新</Button></div>
        {error ? <ErrorState message={error} onRetry={() => void load()} /> : !overview ? <p>正在加载成品总览…</p> : <DataTable columns={columns} data={overview.groups ?? []} empty={<EmptyState title="暂无成品数据" description="销售单确认后生成生产单，成品入库后这里会按产品与单位汇总。" />} />}
      </div>
    </section>
  </div>;
}

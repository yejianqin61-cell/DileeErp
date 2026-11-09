"use client";

// 销售二级页：成品出库总览（模块级 —— 全部销售单按「产品 + 单位」汇总）。
//
// 口径（后端计算，前端只展示）：全部成品数 = 累计成品入库；已出库数 = 已过账/已发出/已签收出库；
// 未出库数 = 全部 − 已出库。按「产品 + 单位」分行：**不同单位的数量不做合计**。
//
// 为什么单独一页：这张表要回答的是老板的问题「还有多少成品压在仓里」，与「某一张销售单出到哪一步」
// 不是同一件事（后者在销售单详情里，按生产单列）。改造前它挤在销售页顶部，和客户池、销售单
// 两张表共用一个错误态；现在它自己一页，失败也不会连累另外两张表。
//
// 2026-11-09（用户：「成品出库总览明细表单那边要有订单号」）：汇总表下方新增「按订单号明细」表。
// 为什么不在汇总表里加一列订单号：一行「产品+单位」可能由同一产品的多张销售单折成，一格里塞
// 多个订单号既看不出哪个量属于哪张单，也排不了序；明细是一行一张生产单，订单号与数量一一对应。
// 两份数据来自同一个接口（`GET /sales-orders/finished-goods-summary` 的 `groups` 与 `details`），
// 同一次 groupBy 算出来，汇总与明细永远对得上 —— 前端不做任何加减。
import { useEffect, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../layout/app-shell";
import { Button } from "../ui/button";
import { DataTable } from "../data/data-table";
import { EmptyState, ErrorState } from "../feedback/states";
import { ApiClientError, apiGet } from "../../lib/api-client";

/** 三个数字都是后端算好的 Decimal 字符串（前端不做任何加减）。 */
export type FinishedGoodsTotals = { product_name: string; unit: string; inbound_quantity: string; outbound_quantity: string; unshipped_quantity: string; production_order_count?: number };
/**
 * 「按订单号明细」一行 = 一张生产单。
 *
 * `order_no` 是销售订单号（用户点名要的那一列），`production_order_no` 是它在产线上的生产单号；
 * 同一张销售单可能有多个生产单（分批投产），所以两列都要给，否则同一订单的几行分不出来。
 * `details` 在响应里是可选字段：旧的后端/测试替身不带它时页面按空明细处理，而不是白屏。
 */
export type FinishedGoodsOverviewDetail = { order_no: string; production_order_no: string; product_name: string; unit: string; inbound_quantity: string; outbound_quantity: string; unshipped_quantity: string };
export type FinishedGoodsOverviewData = { production_order_count: number; groups: FinishedGoodsTotals[]; details?: FinishedGoodsOverviewDetail[] };

const messageOf = (cause: unknown, fallback: string) => cause instanceof ApiClientError ? cause.message : fallback;

/**
 * 两张表的列宽（百分比，各自合计 100%）。
 *
 * 估算基准与 `components/qc/finished-goods-qc-panel.tsx` 的 T24 同一档（1440 屏、表格可用宽约 1108px，
 * 1% ≈ 11.08px；`.ui-table-cell` 左右内边距 24px，所以一列真正能写字的宽度 = 百分比 × 1108 − 24px）：
 *
 * 汇总表（6 列）：
 *   - 产品 28%（310px / 可用 286px）：产品名是全角中文（`55cm*6K 三折手开POE伞` 这类二三十字符），
 *     长文本靠省略 + hover 看全文，但要把可见长度留给它，所以是最大的一列；
 *   - 单位 10%（111px / 87px）：一个字宽（把 / 件 / kg），够放表头「单位」与数值；
 *   - 全部成品数 / 已出库数 / 未出库数 各 16%（177px / 153px）：表头 5 个汉字 ≈ 65px 以上，
 *     数字列按通则 8%~12% 取整到 16% —— 这三个数是这张表的主语，宁可给宽；
 *   - 生产单数 14%（155px / 131px）：表头 4 个汉字 + 一位数。
 *   合计 28 + 10 + 16×3 + 14 = 100%。
 *
 * 明细表（7 列，2026-11-09 新增）：
 *   - 订单号 13%（144px / 120px）：识别一行的第一眼信息，编号型文本，省略 + hover 看全；
 *   - 生产单号 15%（166px / 142px）：比订单号长两三个字符（`MO-20261109-8431493E`），给 15%；
 *   - 产品 26%（288px / 264px）：与汇总表同一列，长文本省略 + hover；
 *   - 单位 9%（100px / 76px）：一个字宽；
 *   - 全部成品数 12%、已出库数 12%、未出库数 13%（133~144px）：数字列，表头 5 个汉字，
 *     按通则「数量列 4%~6%、表头要完整可读」取上限。
 *   合计 13 + 15 + 26 + 9 + 12 + 12 + 13 = 100%。
 */
const COLUMN_WIDTH = {
  overviewProduct: "28%",
  overviewUnit: "10%",
  overviewInbound: "16%",
  overviewOutbound: "16%",
  overviewUnshipped: "16%",
  overviewProductionOrders: "14%",
  detailOrderNo: "13%",
  detailProductionOrderNo: "15%",
  detailProduct: "26%",
  detailUnit: "9%",
  detailInbound: "12%",
  detailOutbound: "12%",
  detailUnshipped: "13%",
} as const;

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
    { accessorKey: "product_name", header: "产品", meta: { width: COLUMN_WIDTH.overviewProduct } },
    { accessorKey: "unit", header: "单位", meta: { width: COLUMN_WIDTH.overviewUnit } },
    { accessorKey: "inbound_quantity", header: "全部成品数", meta: { width: COLUMN_WIDTH.overviewInbound } },
    { accessorKey: "outbound_quantity", header: "已出库数", meta: { width: COLUMN_WIDTH.overviewOutbound } },
    { accessorKey: "unshipped_quantity", header: "未出库数", meta: { width: COLUMN_WIDTH.overviewUnshipped } },
    { id: "production_orders", header: "生产单数", meta: { width: COLUMN_WIDTH.overviewProductionOrders }, cell: ({ row }) => row.original.production_order_count ?? 0 },
  ];
  /**
   * 明细表列（2026-11-09）：列名与汇总表对齐（全部成品数 / 已出库数 / 未出库数），
   * 只在前面多出用户要的「订单号」与它的「生产单号」。
   * 一律 `accessorKey`：这几列都是纯文本标量，DataTable 能直接给出 hover 全文，
   * 不需要像 QC 面板那样用 `accessorFn` 把拼接串写进取值层。
   */
  const detailColumns: ColumnDef<FinishedGoodsOverviewDetail>[] = [
    { accessorKey: "order_no", header: "订单号", meta: { width: COLUMN_WIDTH.detailOrderNo } },
    { accessorKey: "production_order_no", header: "生产单号", meta: { width: COLUMN_WIDTH.detailProductionOrderNo } },
    { accessorKey: "product_name", header: "产品", meta: { width: COLUMN_WIDTH.detailProduct } },
    { accessorKey: "unit", header: "单位", meta: { width: COLUMN_WIDTH.detailUnit } },
    { accessorKey: "inbound_quantity", header: "全部成品数", meta: { width: COLUMN_WIDTH.detailInbound } },
    { accessorKey: "outbound_quantity", header: "已出库数", meta: { width: COLUMN_WIDTH.detailOutbound } },
    { accessorKey: "unshipped_quantity", header: "未出库数", meta: { width: COLUMN_WIDTH.detailUnshipped } },
  ];

  return <div className="page-root" data-testid={testId}>
    <PageHeader title="成品出库总览" breadcrumb={["客户与销售", "成品出库总览"]} description="全部销售单的成品存量：入库、已出库与未出库；明细按订单号逐张生产单列出。" />
    <section className="panel" data-testid="finished-goods-overview">
      <div className="panel-heading">
        <h2>成品出库总览</h2>
        <span className="panel-note" data-testid="finished-goods-overview-note">全部成品数 = 累计成品入库；已出库数 = 已过账/已发出/已签收出库；未出库数 = 全部 − 已出库（仍在成品仓）。按产品与单位分行：不同单位的数量不做合计。下方的「按订单号明细」是同一份数据的逐生产单展开，两处数字相加相等。</span>
      </div>
      <div className="panel-body">
        <div className="page-actions"><Button size="sm" variant="secondary" data-testid="finished-goods-overview-refresh" disabled={busy} onClick={() => void load()}>刷新</Button></div>
        {error ? <ErrorState message={error} onRetry={() => void load()} /> : !overview ? <p>正在加载成品总览…</p> : <>
          {/* 两张表的表头有重名（全部成品数 / 已出库数 / 未出库数），各自套一层带 testid 的容器：
              测试与验收脚本按容器取表，不靠「表头是不是唯一」猜。 */}
          <div data-testid="finished-goods-overview-summary">
            <DataTable columns={columns} data={overview.groups ?? []} empty={<EmptyState title="暂无成品数据" description="销售单确认后生成生产单，成品入库后这里会按产品与单位汇总。" />} />
          </div>
          {/* 明细表：用户 2026-11-09「成品出库总览明细表单那边要有订单号」。
              空态与汇总表分开写 —— 汇总有行而明细为空只可能是后端没返回 details（旧版本/替身），
              这时提示「升级后端」比显示「暂无成品数据」诚实。 */}
          <h3 style={{ marginTop: 20 }}>按订单号明细</h3>
          <p className="panel-note" data-testid="finished-goods-overview-detail-note">一行一张生产单：订单号 → 生产单号 → 该批的全部成品 / 已出库 / 未出库。同一张销售单分批投产时会出现多行。</p>
          <div data-testid="finished-goods-overview-detail">
            <DataTable columns={detailColumns} data={overview.details ?? []} empty={<EmptyState title="暂无按订单号的成品明细" description="有成品入库的生产单确认后，会在这里按订单号逐行列出。" />} />
          </div>
        </>}
      </div>
    </section>
  </div>;
}

"use client";

// 销售一级页：只展示板块入口，点击才进入二级页面。
//
// 为什么不做成"三个板块平铺在一页"（改造前的做法）：一页要同时拉客户池、销售单与成品总览
// 三个接口，销售每天只看其中一张表却要等三次请求；而拆成「一级选板块、二级看一张表」之后
// 每个二级页只拉自己那一个接口，地址也能直接发给同事（`/sales/orders`）。
// 这与财务板块（`components/finance/finance-board-index.tsx`）是同一套做法。
//
// 板块清单在 `lib/sales-sections.ts`（无 "use client" 的纯数据模块），不要在组件里另写一份。
import Link from "next/link";
import { PageHeader } from "../layout/app-shell";
import { SALES_BOARDS } from "../../lib/sales-sections";

export default function SalesBoardIndex({ testId = "page-sales" }: { testId?: string }) {
  return <div className="page-root sales-page" data-testid={testId}>
    <PageHeader title="客户与销售" description="成品出库总览、客户池与销售单各自一个页面。" />
    <div className="board-grid" data-testid="sales-board-grid">
      {SALES_BOARDS.map((board) => <Link key={board.key} href={`/sales/${board.key}`} className="board-card" data-testid={`sales-board-${board.key}`}>
        <h2>{board.title}</h2>
        <p>{board.description}</p>
        <span className="board-enter">进入 &rarr;</span>
      </Link>)}
    </div>
  </div>;
}

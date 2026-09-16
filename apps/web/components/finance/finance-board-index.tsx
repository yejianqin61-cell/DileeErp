"use client";

// 财务一级页：只展示板块入口，点击才进入二级页面。
//
// 为什么不做成"全部板块平铺 + 可折叠"（重构前的做法）：财务接口一次要拉 10+ 个列表，
// 平铺页面既慢又难读；拆成「一级选板块、二级看子栏目」后每个二级页只拉自己需要的接口，
// 地址也能直接收藏（/finance/receivable?tab=confirmed）。
//
// 板块清单在 lib/finance-sections.ts（无 "use client" 的纯数据模块），不要在组件里另写一份。
import Link from "next/link";
import { PageHeader } from "../layout/app-shell";
import { FINANCE_BOARDS } from "../../lib/finance-sections";

export default function FinanceBoardIndex({ testId = "page-finance" }: { testId?: string }) {
  return <div className="page-root" data-testid={testId}>
    <PageHeader title="财务" />
    <div className="board-grid" data-testid="finance-board-grid">
      {FINANCE_BOARDS.map((board) => <Link key={board.key} href={`/finance/${board.key}`} className="board-card" data-testid={`finance-board-${board.key}`}>
        <h2>{board.title}</h2>
        <span className="board-enter">进入 →</span>
      </Link>)}
    </div>
  </div>;
}

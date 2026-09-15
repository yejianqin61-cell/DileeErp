"use client";

// 财务二级页的子栏目切换条。
//
// 用真实链接而不是本地 state：子栏目地址可以直接收藏/分享，也与旧地址重定向
// （/finance/receivable-sources → /finance/receivable?tab=outbound-entries）配合。
import Link from "next/link";
import { cn } from "../../lib/utils";

export function FinanceTabs({ basePath, tabs, active, query }: { basePath: string; tabs: ReadonlyArray<{ key: string; title: string; description: string }>; active: string; query?: Record<string, string> }) {
  // query 让「切子栏目」保留当前筛选（例如工资管理的月份/部门/岗位），否则切一次 tab 就要重选一遍。
  const suffix = query && Object.keys(query).length ? `&${new URLSearchParams(query).toString()}` : "";
  return <nav className="finance-tabs" aria-label="子栏目" data-testid="finance-tabs">
    {tabs.map((tab) => <Link
      key={tab.key}
      href={`${basePath}?tab=${tab.key}${suffix}`}
      aria-current={tab.key === active ? "page" : undefined}
      data-testid={`finance-tab-${tab.key}`}
      className={cn("finance-tab", tab.key === active && "finance-tab-active")}
    >
      <strong>{tab.title}</strong>
      <span>{tab.description}</span>
    </Link>)}
  </nav>;
}

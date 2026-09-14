// 财务次级页面：/finance/<section> 只渲染一个板块（订单多时比总览页清爽，地址可收藏）。
// 与总览页共用 components/finance/finance-workspace.tsx（同一份实现、同一套加载逻辑）。
import { notFound } from "next/navigation";
import FinanceWorkspace, { FINANCE_SECTIONS, type FinanceSectionKey } from "../../../components/finance/finance-workspace";

export function generateStaticParams() {
  return FINANCE_SECTIONS.map((section) => ({ section: section.key }));
}

export default async function FinanceSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!FINANCE_SECTIONS.some((item) => item.key === section)) notFound();
  // 页面根 testid 由工作台在加载完成后渲染，加载中不渲染。
  return <FinanceWorkspace only={section as FinanceSectionKey} testId="page-finance-section" />;
}

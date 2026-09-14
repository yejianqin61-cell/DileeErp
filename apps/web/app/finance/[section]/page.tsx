// 旧财务板块地址（重构前的 7 个平铺 section）重定向到新的二级页。
//
// 为什么保留：这些地址曾经是「进入独立页面」按钮的目标，已经有人收藏；直接 404 会让人以为功能被删。
// 白名单之外的 section 一律 notFound()，不做模糊跳转（否则打错的地址会静默落到某个页面）。
import { notFound, redirect } from "next/navigation";
import { FINANCE_LEGACY_REDIRECTS, financeLegacyTarget } from "../../../lib/finance-sections";

export function generateStaticParams() {
  return FINANCE_LEGACY_REDIRECTS.map((section) => ({ section: section.key }));
}

export default async function FinanceLegacySectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const target = financeLegacyTarget(section);
  if (!target) notFound();
  redirect(target);
}

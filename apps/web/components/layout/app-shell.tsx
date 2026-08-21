"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ClipboardList, Coins, Factory, LayoutDashboard, Package, Users, WalletCards } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { apiGet } from "../../lib/api-client";

const navigation = [
  ["工作台", "/", LayoutDashboard],
  ["生产", "/production", Factory],
  ["采购", "/procurement", ClipboardList],
  ["财务", "/finance", Coins],
  ["仓库", "/warehouse", Package],
  ["人事", "/hr", Users],
  ["客户与销售", "/sales", WalletCards],
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [ready, setReady] = useState(pathname === "/login");
  useEffect(() => { if (pathname === "/login") { setReady(true); return; } apiGet("/auth/me").then(() => setReady(true)).catch(() => { window.location.href = "/login"; }); }, [pathname]);
  if (pathname === "/login") return <>{children}</>;
  if (!ready) return <div className="feedback-state"><span>正在验证登录状态...</span></div>;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">D</span><div><strong>迪礼 ERP</strong><small>厂内业务系统</small></div></div>
      <nav aria-label="主导航">{navigation.map(([label, href, Icon]) => <Link key={href} href={href} className={cn("nav-item", pathname === href && "nav-item-active")}><Icon size={17} strokeWidth={1.8} /><span>{label}</span></Link>)}</nav>
    </aside>
    <div className="shell-main">
      <header className="topbar"><span className="environment-label">厂内 ERP</span><div className="user-menu"><span className="user-dot">操</span><span>当前操作员</span></div></header>
      <main className="content-area">{children}</main>
    </div>
  </div>;
}

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <div className="page-header"><div><div className="breadcrumb">迪礼 ERP <span>/</span> {title}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{children && <div className="page-actions">{children}</div>}</div>;
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Bell, ClipboardList, Coins, Factory, LayoutDashboard, LogOut, Package, Users, WalletCards } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { apiGet, apiPost } from "../../lib/api-client";
import { Button } from "../ui/button";

const navigation = [
  ["工作台", "/", LayoutDashboard],
  ["生产", "/production", Factory],
  ["采购", "/procurement", ClipboardList],
  ["财务", "/finance", Coins],
  ["仓库", "/warehouse", Package],
  ["人事", "/hr", Users],
  ["客户与销售", "/sales", WalletCards],
  ["报表与告警", "/reports", Bell],
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [ready, setReady] = useState(pathname === "/login");
  const [user, setUser] = useState<{ display_name: string; username: string } | null>(null);
  useEffect(() => { if (pathname === "/login") { setReady(true); return; } apiGet<{ display_name: string; username: string }>("/auth/me").then((result) => { setUser(result.data); setReady(true); }).catch(() => { window.location.href = "/login"; }); }, [pathname]);
  async function logout() { await apiPost("/auth/logout"); window.location.href = "/login"; }
  if (pathname === "/login") return <>{children}</>;
  if (!ready) return <div className="feedback-state"><span>正在验证登录状态...</span></div>;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">迪</span><div><strong>迪礼管理系统</strong><small>厂内业务系统</small></div></div>
      <nav aria-label="主导航">{navigation.map(([label, href, Icon]) => <Link key={href} href={href} className={cn("nav-item", pathname === href && "nav-item-active")}><Icon size={17} strokeWidth={1.8} /><span>{label}</span></Link>)}</nav>
    </aside>
    <div className="shell-main">
      <header className="topbar"><span className="environment-label">厂内系统</span><div className="user-menu"><span className="user-dot">{user?.display_name.slice(0, 1) ?? "-"}</span><span>{user?.display_name ?? "当前操作员"}</span><Button variant="ghost" size="icon" title="退出登录" aria-label="退出登录" onClick={() => void logout()}><LogOut size={16} /></Button></div></header>
      <main className="content-area">{children}</main>
    </div>
  </div>;
}

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <div className="page-header"><div><div className="breadcrumb">迪礼管理系统 <span>/</span> {title}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{children && <div className="page-actions">{children}</div>}</div>;
}

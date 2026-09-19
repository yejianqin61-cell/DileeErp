"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Bell, ClipboardList, Coins, Factory, LayoutDashboard, LogOut, Package, ShieldCheck, UserCog, Users, WalletCards } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { ApiClientError, apiPost } from "../../lib/api-client";
import { fetchSessionProfile, type SessionProfile } from "../../lib/session";
import { SessionContext } from "../../lib/session-context";
import { canVisitPath, surfaceRoleName } from "../../lib/surface-permission";
import { Button } from "../ui/button";
import { AccessDenied } from "./access-denied";

const navigation = [
  ["工作台", "/", LayoutDashboard],
  ["生产", "/production", Factory],
  ["采购", "/procurement", ClipboardList],
  ["质检", "/qc", ShieldCheck],
  ["财务", "/finance", Coins],
  ["仓库", "/warehouse", Package],
  ["人事", "/hr", Users],
  ["客户与销售", "/sales", WalletCards],
  ["报表与告警", "/reports", Bell],
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [ready, setReady] = useState(pathname === "/login");
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [authError, setAuthError] = useState("");
  useEffect(() => {
    if (pathname === "/login") { setReady(true); setAuthError(""); return; }
    setReady(false); setAuthError("");
    fetchSessionProfile().then((result) => { setProfile(result); setReady(true); }).catch((cause) => {
      if (cause instanceof ApiClientError && ["UNAUTHORIZED", "UNAUTHENTICATED", "AUTH_REQUIRED", "SESSION_EXPIRED"].includes(cause.code)) { window.location.href = "/login"; return; }
      setAuthError(cause instanceof ApiClientError ? cause.message : "无法连接服务，请稍后重试"); setReady(true);
    });
  }, [pathname]);
  async function logout() { await apiPost("/auth/logout"); window.location.href = "/login"; }
  if (pathname === "/login") return <>{children}</>;
  if (!ready) return <div className="feedback-state"><span>正在验证登录状态...</span></div>;
  if (authError) return <div className="feedback-state"><span>{authError}</span><Button variant="secondary" onClick={() => window.location.reload()}>重试</Button></div>;
  if (!profile) return <div className="feedback-state"><span>正在读取权限...</span></div>;
  // 菜单只留他进得去的栏目（用户拍板：无权入口直接隐藏，别让人点进去撞门禁）。
  const visibleNavigation = navigation.filter(([, href]) => canVisitPath(profile.surface_sections, href));
  const allowed = canVisitPath(profile.surface_sections, pathname);
  const roles = profile.surface_roles.length ? profile.surface_roles.map(surfaceRoleName).join("、") : "未分配角色";
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">迪</span><div><strong>迪礼管理系统</strong><small>厂内业务系统</small></div></div>
      <nav aria-label="主导航" data-testid="app-nav">
        {visibleNavigation.map(([label, href, Icon]) => <Link key={href} href={href} data-testid={`nav-link-${href === "/" ? "dashboard" : href.slice(1).replace(/\//g, "-")}`} className={cn("nav-item", pathname === href && "nav-item-active")}><Icon size={17} strokeWidth={1.8} /><span>{label}</span></Link>)}
        <Link href="/account" data-testid="nav-link-account" className={cn("nav-item", pathname === "/account" && "nav-item-active")}><UserCog size={17} strokeWidth={1.8} /><span>账号中心</span></Link>
      </nav>
    </aside>
    <div className="shell-main">
      <header className="topbar">
        <span className="environment-label">厂内系统</span>
        <div className="user-menu">
          <Link href="/account" className="user-menu-account" data-testid="user-menu-account" title="账号中心：改姓名、改密码、查看权限范围">
            <span className="user-dot">{profile.display_name.slice(0, 1) || "-"}</span>
            <span className="user-menu-name">{profile.display_name}</span>
            <span className="user-menu-role" data-testid="user-menu-role">{roles}</span>
          </Link>
          <Button variant="ghost" size="icon" title="退出登录" aria-label="退出登录" onClick={() => void logout()} data-testid="logout-button"><LogOut size={16} /></Button>
        </div>
      </header>
      <main className="content-area" data-testid="app-main"><SessionContext.Provider value={profile}>{allowed ? children : <AccessDenied profile={profile} pathname={pathname} />}</SessionContext.Provider></main>
    </div>
  </div>;
}

export function PageHeader({ title, description, children, breadcrumb }: { title: string; description?: string; children?: ReactNode; breadcrumb?: string[] }) {
  const parts = breadcrumb ? breadcrumb : [title];
  return <div className="page-header"><div><div className="breadcrumb">迪礼管理系统 {parts.map((seg, i) => <span key={i}><span>/</span> {seg}</span>)}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{children && <div className="page-actions">{children}</div>}</div>;
}

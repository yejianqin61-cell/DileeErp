"use client";

import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { SECTION_LABELS, SECTION_PATHS, sectionOfPath, surfaceRoleName, type SurfaceSection } from "../../lib/surface-permission";
import type { SessionProfile } from "../../lib/session";

/**
 * 门禁页：**就地渲染**，不改地址栏、不跳转。
 *
 * 为什么就地而不重定向到 /no-access（用户拍板）：
 *   1. 地址栏还留着他刚才输的路径，能看懂"我为什么被拦"；
 *   2. 左侧导航还在，一点就回到自己有权限的地方，不用先回去再找；
 *   3. 刷新、后退都符合直觉，也不会在两个路由之间来回弹。
 */
export function AccessDenied({ profile, pathname }: { profile: SessionProfile; pathname: string }) {
  const section = sectionOfPath(pathname);
  const roles = profile.surface_roles.length ? profile.surface_roles.map(surfaceRoleName).join("、") : "未分配角色";
  const visible = profile.surface_sections as SurfaceSection[];
  return (
    <div className="page-root" data-testid="page-access-denied">
      <section className="panel" data-testid="access-denied-panel">
        <div className="panel-body" style={{ display: "grid", gap: "var(--space-2, 12px)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <ShieldAlert size={22} aria-hidden />
            <h1 style={{ margin: 0, fontSize: 20 }}>无访问权限</h1>
          </div>
          <p data-testid="access-denied-message">
            你的角色是「{roles}」，没有「{SECTION_LABELS[section] ?? section}」的访问权限。
          </p>
          <p className="panel-note">
            你的可见范围：{visible.length ? visible.map((item) => SECTION_LABELS[item] ?? item).join("、") : "无"}。需要调整请找老板或财务在账号管理中心修改。
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }} data-testid="access-denied-links">
            {visible.map((item) => (
              <Link key={item} className="nav-item" style={{ width: "auto", padding: "6px 12px" }} href={SECTION_PATHS[item] ?? "/"}>
                去{SECTION_LABELS[item] ?? item}
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

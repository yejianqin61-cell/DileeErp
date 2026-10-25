/**
 * 两档数据档位（docs/design/business-query-agent-v0-architecture-2026-10-23.md「两档权限如何判定」）。
 *
 * 为什么不复用 `surface_scope`：表面权限只决定「菜单里显示什么」，而这里判的是**数据可见性**
 * （财务字段）。`administrator` 在表面权限里是最高档，在数据档位里只是 operational ——
 * 管理员要查财务事实必须显式分配 `laoban`/`caiwu`，这是工程布局的明文决定，不得放开。
 */

export type AgentAccessLevel = "full" | "operational";
export type ResolvedAccessLevel = AgentAccessLevel | "denied";

/** 取得 full 档位的角色 key（工程布局原文：含 laoban 或 caiwu）。 */
const FULL_ROLE_KEYS = ["laoban", "caiwu"] as const;

/**
 * 角色集合 → 数据档位。多角色取最高档；入参必须是**已过滤软删与停用**的有效角色 key
 * （过滤条件在角色读取处统一执行，见 query-permission.guard.ts）。
 */
export function resolveAccessLevel(roleKeys: readonly string[]): ResolvedAccessLevel {
  if (roleKeys.some((key) => (FULL_ROLE_KEYS as readonly string[]).includes(key))) return "full";
  return roleKeys.length > 0 ? "operational" : "denied";
}

/** 两档之间的「较低者」：运行中的有效档位 = 创建时档位与当前档位的较低者（工程布局）。 */
export function lowerAccessLevel(a: AgentAccessLevel, b: AgentAccessLevel): AgentAccessLevel {
  return a === "operational" || b === "operational" ? "operational" : "full";
}

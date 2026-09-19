/**
 * 表面权限（surface permission）：只在前端生效的"页面可见范围"。
 *
 * 用户拍板的模型：
 *   * **实际权限** —— 所有角色一律等同于管理员。后端不按角色拦人（实现见
 *     `module-permission.guard.ts` 与迁移 20260919160000：四个角色各授予全部 6 个模块）。
 *   * **表面权限** —— 只决定"菜单里显示什么、哪个页面进得去"。越权直达 URL 会被前端门禁页拦住。
 *
 * 三个范围与四个角色的对应（用户原话）：
 *   1. 老板、财务 —— 最高表面权限：全部页面。
 *   2. 人事 —— 只能访问人事页面及其下属页面。
 *   3. 其他 —— 除人事、财务页面之外的页面。
 *
 * **栏目（section）是这套权限的唯一粒度**：这里定义了每个角色能看到哪些栏目，
 * 前端只负责"哪个路径属于哪个栏目"（`apps/web/lib/surface-permission.ts`）。
 * 这样"谁能看什么"只有一处真源，不会出现前后端各写一套、慢慢走偏。
 *
 * 为什么把栏目清单也发给前端（而不是只发一个范围名）：一个账号理论上可以挂多个角色，
 * 而"人事＋其他"这种组合的可见范围是**并集**（除财务外全部），不是任何一个单独范围能表达的。
 * 所以前端拿的是精确的栏目集合；`surface_scope` 只是给人看的一句话标签。
 */
export const SURFACE_SECTIONS = [
  "dashboard", // 工作台
  "production", // 生产
  "procurement", // 采购
  "qc", // 质检
  "warehouse", // 仓库
  "sales", // 客户与销售
  "customers", // 客户
  "reports", // 报表与告警
  "finance", // 财务
  "hr", // 人事
  "account", // 账号管理中心（所有人可进，见用户拍板）
] as const;
export type SurfaceSection = (typeof SURFACE_SECTIONS)[number];

export const SURFACE_SCOPES = ["full", "hr", "general"] as const;
export type SurfaceScope = (typeof SURFACE_SCOPES)[number];

/**
 * 四个表面角色。key 用拼音而不是英文，是为了**不与模块 key 撞名**：
 * 模块里已经有 `finance` / `hr`（`MODULE_KEYS`），角色再叫 `finance` / `hr` 会在日志、
 * 审计与代码里造成"这个 finance 到底是角色还是模块"的长期误读。
 */
export const SURFACE_ROLES = [
  { key: "laoban", name: "老板", scope: "full" },
  { key: "caiwu", name: "财务", scope: "full" },
  { key: "renshi", name: "人事", scope: "hr" },
  { key: "qita", name: "其他", scope: "general" },
] as const satisfies ReadonlyArray<{ key: string; name: string; scope: SurfaceScope }>;

export type SurfaceRoleKey = (typeof SURFACE_ROLES)[number]["key"];

export const SURFACE_ROLE_KEYS: readonly string[] = SURFACE_ROLES.map((role) => role.key);

/** 每个范围能看到哪些栏目。 */
const SECTIONS_BY_SCOPE: Record<SurfaceScope, readonly SurfaceSection[]> = {
  full: SURFACE_SECTIONS,
  // 用户原话"只能访问人事页面及其下属页面"。账号管理中心是用户单独拍板的"所有人可进"，
  // 所以它是唯一在人事范围里的例外（否则人事连改自己密码的地方都没有）。
  hr: ["hr", "account"],
  general: ["dashboard", "production", "procurement", "qc", "warehouse", "sales", "customers", "reports", "account"],
};

export function isSurfaceRoleKey(key: string): key is SurfaceRoleKey {
  return SURFACE_ROLE_KEYS.includes(key);
}

export function surfaceRoleName(key: string): string {
  return SURFACE_ROLES.find((role) => role.key === key)?.name ?? key;
}

/** 角色 key → 范围。`administrator` 视为最高（它就是"实际权限"的那个角色）。 */
function scopeOfRole(key: string): SurfaceScope {
  if (key === "administrator") return "full";
  return SURFACE_ROLES.find((role) => role.key === key)?.scope ?? "general";
}

/**
 * 角色集合 → 可见栏目（**并集**）。
 *
 * 没有任何可识别角色时给 `general`（"其他"）：用户的规则里"其他"就是兜底那一类
 * （除财务、人事之外的页面），所以未知角色的人落到兜底类，而不是被关在门外——
 * 后者会让一个还没分配角色的新账号登录后什么都看不见，反而更难排查。
 */
export function surfaceSectionsOf(roleKeys: readonly string[]): SurfaceSection[] {
  if (!roleKeys.length) return [...SECTIONS_BY_SCOPE.general];
  const sections = new Set<SurfaceSection>();
  for (const key of roleKeys) for (const section of SECTIONS_BY_SCOPE[scopeOfRole(key)]) sections.add(section);
  return SURFACE_SECTIONS.filter((section) => sections.has(section));
}

/**
 * 给人看的一句话标签。**只看它决定不了任何事**（门禁用的是栏目集合）：
 * 多角色并集不是任何一个范围时，落到 `general` 是最不误导的标签。
 */
export function surfaceScopeOf(roleKeys: readonly string[]): SurfaceScope {
  const sections = new Set(surfaceSectionsOf(roleKeys));
  if (sections.has("finance") && sections.has("hr")) return "full";
  if (sections.has("hr") && sections.size <= SECTIONS_BY_SCOPE.hr.length) return "hr";
  return "general";
}

/** 表面权限范围的中文描述（账号管理中心里给自己看的那句话）。 */
export const SURFACE_SCOPE_LABELS: Record<SurfaceScope, string> = {
  full: "全部页面（含财务、人事）",
  hr: "仅人事页面",
  general: "除财务、人事之外的页面",
};

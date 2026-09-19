/**
 * 表面权限（前端）：菜单显示什么、哪个页面进得去。
 *
 * 分工（与后端 `apps/api/src/platform/authorization/surface-scope.ts` 配对）：
 *   * 后端负责"**谁能看哪些栏目**"（唯一真源，随 `/auth/me` 的 `surface_sections` 下发）；
 *   * 这里只负责"**哪个路径属于哪个栏目**"以及菜单/门禁的判定。
 * 这样规则不会两边各写一套：调整角色范围只需改后端一张表，前端不用动。
 *
 * 为什么表面权限只在前端：用户拍板的模型是「所有角色都有等同于管理员的实际权限」——
 * 后端不按角色拦人（API 层面）。这里的门禁是**操作习惯上的限制**，不是安全边界。
 * 真正的安全边界是"登录 + 会话"，那部分在后端。
 */

/** 栏目清单必须与后端 `SURFACE_SECTIONS` 一致（顺序也一致，用于稳定渲染权限范围文案）。 */
export const SURFACE_SECTIONS = [
  "dashboard",
  "production",
  "procurement",
  "qc",
  "warehouse",
  "sales",
  "customers",
  "reports",
  "finance",
  "hr",
  "account",
] as const;
export type SurfaceSection = (typeof SURFACE_SECTIONS)[number];

export const SECTION_LABELS: Record<SurfaceSection, string> = {
  dashboard: "工作台",
  production: "生产",
  procurement: "采购",
  qc: "质检",
  warehouse: "仓库",
  sales: "客户与销售",
  customers: "客户",
  reports: "报表与告警",
  finance: "财务",
  hr: "人事",
  account: "账号管理中心",
};

/** 栏目对应的一级路径（账号中心与"回得去的地方"都用它）。 */
export const SECTION_PATHS: Record<SurfaceSection, string> = {
  dashboard: "/",
  production: "/production",
  procurement: "/procurement",
  qc: "/qc",
  warehouse: "/warehouse",
  sales: "/sales",
  customers: "/customers",
  reports: "/reports",
  finance: "/finance",
  hr: "/hr",
  account: "/account",
};

/** 表面角色：key 与后端 roles.key 一致。 */
export const SURFACE_ROLES = [
  { key: "laoban", name: "老板" },
  { key: "caiwu", name: "财务" },
  { key: "renshi", name: "人事" },
  { key: "qita", name: "其他" },
] as const;

export const SURFACE_ROLE_NAMES: Record<string, string> = Object.fromEntries(SURFACE_ROLES.map((role) => [role.key, role.name]));

export const SURFACE_SCOPE_LABELS: Record<string, string> = {
  full: "全部页面（含财务、人事）",
  hr: "仅人事页面",
  general: "除财务、人事之外的页面",
};

/** 角色 key → 中文名；认不出来就原样显示（例如 administrator）。 */
export function surfaceRoleName(key: string): string {
  return SURFACE_ROLE_NAMES[key] ?? key;
}

/** 路径前缀 → 栏目。**顺序有意义**：先比长前缀，最后才是工作台的 "/"。 */
const SECTION_BY_PREFIX: ReadonlyArray<readonly [string, SurfaceSection]> = [
  ["/production", "production"],
  ["/procurement", "procurement"],
  ["/qc", "qc"],
  ["/warehouse", "warehouse"],
  ["/sales", "sales"],
  ["/customers", "customers"],
  ["/reports", "reports"],
  ["/finance", "finance"],
  ["/hr", "hr"],
  ["/account", "account"],
];

/**
 * 路径属于哪个栏目。认不出来的一律归工作台（`/` 是唯一一个"任意路径都算它"的栏目）。
 * 注意按**段**匹配：`/financex` 不能算进 `/finance`。
 */
export function sectionOfPath(pathname: string): SurfaceSection {
  const path = normalize(pathname);
  for (const [prefix, section] of SECTION_BY_PREFIX) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return section;
  }
  return "dashboard";
}

/** 去掉查询串/尾斜杠；空串当根路径。 */
function normalize(pathname: string): string {
  const withoutQuery = pathname.split("?")[0].split("#")[0];
  if (!withoutQuery || withoutQuery === "/") return "/";
  return withoutQuery.endsWith("/") ? withoutQuery.slice(0, -1) : withoutQuery;
}

/** 这个路径能不能进。`sections` 来自 `/auth/me`；给空数组时按"什么栏目都没有"处理（一律拦住）。 */
export function canVisitPath(sections: readonly string[] | undefined, pathname: string): boolean {
  if (!sections) return false;
  return sections.includes(sectionOfPath(pathname));
}

/** 登录后该落在哪个页面：工作台进得去就工作台，否则第一个进得去的栏目（人事 → /hr）。 */
export function landingPathFor(sections: readonly string[] | undefined): string {
  if (!sections?.length) return "/";
  if (canVisitPath(sections, "/")) return "/";
  const first = SURFACE_SECTIONS.find((section) => sections.includes(section));
  return first ? SECTION_PATHS[first] : "/";
}

/** 一句话说清"你能看哪些页面"（账号中心给自己看的那段）。 */
export function describeSurfaceScope(sections: readonly string[] | undefined, scope?: string): string {
  if (scope && SURFACE_SCOPE_LABELS[scope]) return SURFACE_SCOPE_LABELS[scope];
  if (!sections?.length) return "未分配任何页面权限";
  return sections.map((section) => SECTION_LABELS[section as SurfaceSection] ?? section).join("、");
}

/** 后端模块 key → 中文名（账号中心显示"实际权限"用）。 */
export const MODULE_LABELS: Record<string, string> = {
  sales: "销售",
  procurement: "采购",
  production: "生产",
  warehouse: "仓库",
  finance: "财务",
  hr: "人事",
};
export const ALL_MODULE_KEYS = ["sales", "procurement", "production", "warehouse", "finance", "hr"] as const;

/** 实际权限是否已经是"全部模块"（即等同管理员）——界面据此显示一句话结论。 */
export function hasAllModules(moduleKeys: readonly string[] | undefined): boolean {
  if (!moduleKeys) return false;
  return ALL_MODULE_KEYS.every((key) => moduleKeys.includes(key));
}

/**
 * 谁能管别人的账号（用户拍板：**仅老板、财务**）。
 *
 * 这是**表面权限**：后端接口本身对"实际权限"是放行的（所有角色等同管理员），
 * 所以这里决定的是"界面给不给他这块操作区"。老账号如果还挂着 administrator 也一并算管理者，
 * 否则迁移前建的管理员登录后会看不到自己本来就有的功能。
 */
export function canManageAccounts(profile: { surface_roles?: readonly string[]; role_keys?: readonly string[] } | null | undefined): boolean {
  if (!profile) return false;
  const surface = profile.surface_roles ?? [];
  const all = profile.role_keys ?? [];
  return surface.includes("laoban") || surface.includes("caiwu") || all.includes("administrator");
}

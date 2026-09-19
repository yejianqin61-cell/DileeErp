import { apiGet } from "./api-client";

/**
 * 会话用户 + 表面权限（`/auth/me` 与登录接口的返回形状）。
 *
 * 字段以后端 `AuthService.SessionProfile` 为准：
 *   * `surface_sections` 是**精确的可见栏目集合**，菜单过滤与门禁页都用它；
 *   * `surface_scope` 只是给人看的一句话标签（`full` / `hr` / `general`）；
 *   * `surface_roles` 是表面角色 key（老板/财务/人事/其他），账号中心用它显示与编辑。
 */
export type SessionProfile = {
  id: string;
  username: string;
  display_name: string;
  role_keys: string[];
  surface_roles: string[];
  surface_scope: string;
  surface_sections: string[];
  /** 实际权限（后端模块接口），例如 ["finance","hr",...]。四个表面角色都是全部模块。 */
  module_keys: string[];
};

/** 账号管理中心列表里的一行（`GET /admin/users`）。 */
export type ManagedUser = {
  id: string;
  username: string;
  display_name: string;
  is_active: boolean;
  created_at: string;
  role_keys: string[];
  surface_roles: string[];
  surface_scope: string;
};

export async function fetchSessionProfile(): Promise<SessionProfile> {
  const result = await apiGet<SessionProfile>("/auth/me");
  return result.data;
}

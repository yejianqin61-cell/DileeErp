"use client";

import { useCallback, useEffect, useState } from "react";
import { LogOut, UserPlus } from "lucide-react";
import { ApiClientError, apiGet, apiPatch, apiPost } from "../../lib/api-client";
import { fetchSessionProfile, type ManagedUser, type SessionProfile } from "../../lib/session";
import { canManageAccounts, describeSurfaceScope, hasAllModules, MODULE_LABELS, SECTION_LABELS, SURFACE_ROLES, surfaceRoleName, type SurfaceSection } from "../../lib/surface-permission";
import { formatBeijingShort } from "../../lib/audit-time";
import { notifyError, notifySuccess } from "../ui/toaster";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ActionDialog, type ActionField } from "../ui/action-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

const ROLE_OPTIONS = SURFACE_ROLES.map((role) => ({ value: role.key, label: role.name }));
const PASSWORD_HINT = "至少 10 位，且同时包含字母和数字";

/**
 * 账号管理中心。
 *
 * 分区与权限（用户拍板）：
 *   * **所有人**：改自己的姓名、改自己的密码、退出登录、看自己的权限范围；
 *   * **仅老板/财务**：新建账号、重置他人密码、停用/启用、改角色。
 *
 * 注意"仅老板/财务"是**表面权限**（界面分区），不是后端拦截——后端对所有角色一律放行，
 * 这是用户明确要的模型。真正的防线是登录与会话。
 */
export function AccountCenter() {
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loadError, setLoadError] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [passwords, setPasswords] = useState({ current: "", next: "", confirm: "" });
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [roleTarget, setRoleTarget] = useState<ManagedUser | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<ManagedUser | null>(null);

  const manager = canManageAccounts(profile);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const current = await fetchSessionProfile();
      setProfile(current);
      setDisplayName(current.display_name);
      if (canManageAccounts(current)) setUsers((await apiGet<ManagedUser[]>("/admin/users")).data);
      else setUsers([]);
    } catch (cause) {
      setLoadError(cause instanceof ApiClientError ? cause.message : "账号信息加载失败");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function saveDisplayName() {
    setSavingName(true);
    try {
      await apiPatch<SessionProfile>("/auth/me", { display_name: displayName });
      notifySuccess("姓名已更新");
      await load();
    } catch (cause) { notifyError(cause instanceof ApiClientError ? cause.message : "保存失败"); }
    finally { setSavingName(false); }
  }

  async function changePassword() {
    setPasswordError("");
    if (passwords.next !== passwords.confirm) { setPasswordError("两次输入的新密码不一致"); return; }
    setChangingPassword(true);
    try {
      await apiPost("/auth/password", { current_password: passwords.current, new_password: passwords.next });
      setPasswords({ current: "", next: "", confirm: "" });
      notifySuccess("密码已修改，其它设备上的登录已失效");
    } catch (cause) { setPasswordError(cause instanceof ApiClientError ? cause.message : "修改密码失败"); }
    finally { setChangingPassword(false); }
  }

  async function logout() { await apiPost("/auth/logout"); window.location.href = "/login"; }

  async function run(action: () => Promise<unknown>, success: string) {
    try { await action(); notifySuccess(success); await load(); }
    catch (cause) { notifyError(cause instanceof ApiClientError ? cause.message : "操作失败"); }
  }

  if (loadError) return <section className="panel panel-body status-danger" role="alert" data-testid="account-error">{loadError}</section>;
  if (!profile) return <section className="panel panel-body" data-testid="account-loading">正在加载账号信息...</section>;

  const sections = profile.surface_sections as SurfaceSection[];
  const roleNames = profile.surface_roles.length ? profile.surface_roles.map(surfaceRoleName).join("、") : "未分配角色";
  const createFields: ActionField[] = [
    { name: "username", label: "登录用户名", required: true, placeholder: "拼音或工号，例如 caiwu" },
    { name: "display_name", label: "姓名", required: true, placeholder: "员工真实姓名" },
    { name: "password", label: `初始密码（${PASSWORD_HINT}）`, required: true },
    { name: "role_keys", label: "角色", type: "select", required: true, options: ROLE_OPTIONS, defaultValue: "qita" },
  ];

  return <>
    <section className="panel" data-testid="account-profile-panel">
      <div className="panel-heading"><h2>我的资料</h2><span className="panel-note">姓名会显示在全站的「创建人 / 最后修改人」里</span></div>
      <div className="panel-body">
        <div className="ui-form-item">
          <Label htmlFor="account-display-name">姓名</Label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Input id="account-display-name" data-testid="account-display-name" value={displayName} maxLength={100} onChange={(event) => setDisplayName(event.target.value)} />
            <Button onClick={() => void saveDisplayName()} disabled={savingName || !displayName.trim() || displayName.trim() === profile.display_name} data-testid="account-save-name">{savingName ? "保存中" : "保存姓名"}</Button>
          </div>
        </div>
        <div className="ui-form-item"><Label>登录用户名</Label><p className="panel-note" data-testid="account-username">{profile.username}（用户名不可修改）</p></div>
        <div className="ui-form-item"><Label>我的角色</Label><p className="panel-note" data-testid="account-roles">{roleNames}</p></div>
        <div className="ui-form-item">
          <Label>我的权限范围</Label>
          <p className="panel-note" data-testid="account-surface-scope">页面可见范围：{describeSurfaceScope(profile.surface_sections, profile.surface_scope)}</p>
          <p className="panel-note" data-testid="account-surface-sections">可访问栏目：{sections.length ? sections.map((section) => SECTION_LABELS[section] ?? section).join("、") : "无"}</p>
          <p className="panel-note" data-testid="account-module-keys">
            实际权限（后端接口）：{hasAllModules(profile.module_keys) ? "全部业务模块，等同于管理员" : (profile.module_keys.length ? profile.module_keys.map((key) => MODULE_LABELS[key] ?? key).join("、") : "无模块权限")}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}><Button variant="secondary" onClick={() => void logout()} data-testid="account-logout"><LogOut size={15} />退出登录</Button></div>
      </div>
    </section>

    <section className="panel" data-testid="account-password-panel">
      <div className="panel-heading"><h2>修改密码</h2><span className="panel-note">{PASSWORD_HINT}；改完只保留当前设备</span></div>
      <div className="panel-body">
        <div className="ui-form-item"><Label htmlFor="account-current-password">当前密码</Label><Input id="account-current-password" type="password" data-testid="account-current-password" value={passwords.current} autoComplete="current-password" onChange={(event) => setPasswords((current) => ({ ...current, current: event.target.value }))} /></div>
        <div className="ui-form-item"><Label htmlFor="account-new-password">新密码</Label><Input id="account-new-password" type="password" data-testid="account-new-password" value={passwords.next} autoComplete="new-password" onChange={(event) => setPasswords((current) => ({ ...current, next: event.target.value }))} /></div>
        <div className="ui-form-item"><Label htmlFor="account-confirm-password">重复新密码</Label><Input id="account-confirm-password" type="password" data-testid="account-confirm-password" value={passwords.confirm} autoComplete="new-password" onChange={(event) => setPasswords((current) => ({ ...current, confirm: event.target.value }))} /></div>
        {passwordError && <p className="feedback-error" role="alert" data-testid="account-password-error">{passwordError}</p>}
        <Button onClick={() => void changePassword()} disabled={changingPassword || !passwords.current || !passwords.next || !passwords.confirm} data-testid="account-change-password">{changingPassword ? "提交中" : "修改密码"}</Button>
      </div>
    </section>

    {manager && <section className="panel" data-testid="account-admin-panel">
      <div className="panel-heading"><h2>账号管理</h2><span className="panel-note">仅老板、财务可见；系统始终保留至少一个老板账号</span><Button onClick={() => setCreateOpen(true)} data-testid="account-create-open"><UserPlus size={15} />新建账号</Button></div>
      <div className="panel-body">
        <Table>
          <TableHeader><TableRow><TableHead>用户名</TableHead><TableHead>姓名</TableHead><TableHead>角色</TableHead><TableHead>状态</TableHead><TableHead>创建时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
          <TableBody>
            {users.map((user) => <TableRow key={user.id} data-testid={`account-row-${user.username}`}>
              <TableCell>{user.username}</TableCell>
              <TableCell>{user.display_name}</TableCell>
              <TableCell data-testid={`account-role-${user.username}`}>{user.surface_roles.length ? user.surface_roles.map(surfaceRoleName).join("、") : (user.role_keys.join("、") || "未分配")}</TableCell>
              <TableCell>{user.is_active ? "启用" : "已停用"}</TableCell>
              <TableCell>{formatBeijingShort(user.created_at)}</TableCell>
              <TableCell>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Button variant="ghost" data-testid={`account-set-role-${user.username}`} onClick={() => setRoleTarget(user)}>改角色</Button>
                  <Button variant="ghost" data-testid={`account-reset-password-${user.username}`} onClick={() => setPasswordTarget(user)}>重置密码</Button>
                  <Button variant="ghost" data-testid={`account-toggle-active-${user.username}`} disabled={user.id === profile.id} onClick={() => void run(() => apiPatch(`/admin/users/${user.id}/active`, { is_active: !user.is_active }), user.is_active ? "账号已停用" : "账号已启用")}>{user.is_active ? "停用" : "启用"}</Button>
                </div>
              </TableCell>
            </TableRow>)}
            {!users.length && <TableRow><TableCell colSpan={6}>暂无账号</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
    </section>}

    <ActionDialog open={createOpen} title="新建账号" fields={createFields} submitLabel="创建账号" onOpenChange={setCreateOpen} onSubmit={async (values) => {
      await apiPost("/admin/users", { username: values.username, display_name: values.display_name, password: values.password, role_keys: [values.role_keys] });
      notifySuccess("账号已创建");
      await load();
    }} />
    <ActionDialog open={Boolean(roleTarget)} title={`修改角色：${roleTarget?.username ?? ""}`} fields={[{ name: "role_keys", label: "角色", type: "select", required: true, options: ROLE_OPTIONS, defaultValue: roleTarget?.surface_roles[0] ?? "qita" }]} onOpenChange={(open) => { if (!open) setRoleTarget(null); }} onSubmit={async (values) => {
      await apiPost(`/admin/users/${roleTarget?.id}/roles`, { role_keys: [values.role_keys] });
      notifySuccess("角色已修改");
      await load();
    }} />
    <ActionDialog open={Boolean(passwordTarget)} title={`重置密码：${passwordTarget?.username ?? ""}`} fields={[{ name: "password", label: `新密码（${PASSWORD_HINT}）`, required: true }]} submitLabel="重置密码" onOpenChange={(open) => { if (!open) setPasswordTarget(null); }} onSubmit={async (values) => {
      await apiPost(`/admin/users/${passwordTarget?.id}/reset-password`, { password: values.password });
      notifySuccess("密码已重置，该账号的登录已失效");
      await load();
    }} />
  </>;
}

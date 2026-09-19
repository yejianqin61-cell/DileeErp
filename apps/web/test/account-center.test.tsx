// 账号管理中心（components/account/account-center.tsx）的真实行为测试。
//
// 用户 2026-09-19 拍板的分工，这个文件就是它的守卫：
//   * **所有人**：改自己的姓名、改自己的密码、退出登录、看自己的权限范围；
//   * **仅老板/财务**：新建账号、重置他人密码、停用/启用、改角色（非老板/财务连这块界面都不该有）。
//
// 另外两条防自锁约束在界面层也各有一条影子（真正拦住的是后端，见
// apps/api/test/unit/auth-account-service.test.cjs）：自己那一行的「停用」必须点不动；
// 改角色失败（最后一个老板）要把后端的话原样显示出来，而不是静默失败。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiErr, apiNoContent, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";
import { AccountCenter } from "../components/account/account-center";

const ALL_MODULES = ["sales", "procurement", "production", "warehouse", "finance", "hr"];
const FULL_SECTIONS = ["dashboard", "production", "procurement", "qc", "warehouse", "sales", "customers", "reports", "finance", "hr", "account"];

const owner = { id: "u-owner", username: "laoban1", display_name: "老板甲", role_keys: ["laoban"], surface_roles: ["laoban"], surface_scope: "full", surface_sections: FULL_SECTIONS, module_keys: ALL_MODULES };
const hrUser = { id: "u-hr", username: "renshi", display_name: "人事小王", role_keys: ["renshi"], surface_roles: ["renshi"], surface_scope: "hr", surface_sections: ["hr", "account"], module_keys: ALL_MODULES };

const managedRows = [
  { id: "u-owner", username: "laoban1", display_name: "老板甲", is_active: true, created_at: "2026-09-19T02:00:00Z", role_keys: ["laoban"], surface_roles: ["laoban"], surface_scope: "full" },
  { id: "u-hr", username: "renshi", display_name: "人事小王", is_active: true, created_at: "2026-09-19T02:05:00Z", role_keys: ["renshi"], surface_roles: ["renshi"], surface_scope: "hr" },
];

/**
 * 按 URL 分发的假后端。`onRequest` 可以针对某个端点返回自定义响应（例如模拟后端拒绝），
 * 返回 undefined 则走默认分支。
 */
function stubBackend({ me = owner as Record<string, unknown>, users = managedRows as unknown[], onRequest }: { me?: Record<string, unknown>; users?: unknown[]; onRequest?: (call: StubbedCall) => Response | undefined } = {}) {
  return stubApi((url, call) => {
    const override = onRequest?.(call);
    if (override) return override;
    if (url.endsWith("/auth/me")) return apiOk(me);
    if (url.endsWith("/admin/users")) return apiOk(users);
    return apiNoContent();
  });
}

describe("账号管理中心 · 自助部分（所有角色）", () => {
  it("人事也能进：显示姓名/角色/权限范围，并且看得到自己的实际权限", async () => {
    stubBackend({ me: hrUser });

    render(<AccountCenter />);

    expect(await screen.findByTestId("account-profile-panel")).toBeVisible();
    expect(screen.getByTestId("account-display-name")).toHaveValue("人事小王");
    expect(screen.getByTestId("account-username")).toHaveTextContent("renshi");
    expect(screen.getByTestId("account-roles")).toHaveTextContent("人事");
    expect(screen.getByTestId("account-surface-scope")).toHaveTextContent("仅人事页面");
    expect(screen.getByTestId("account-surface-sections")).toHaveTextContent("人事、账号管理中心");
    // 实际权限是所有角色都等同管理员，界面要**显示**这件事而不是含糊其辞
    expect(screen.getByTestId("account-module-keys")).toHaveTextContent("全部业务模块，等同于管理员");
  });

  it("非老板/财务：不请求账号列表，也不渲染账号管理区块", async () => {
    const calls = stubBackend({ me: hrUser });

    render(<AccountCenter />);

    await screen.findByTestId("account-profile-panel");
    expect(screen.queryByTestId("account-admin-panel")).toBeNull();
    expect(screen.queryByTestId("account-create-open")).toBeNull();
    expect(callsTo(calls, "/admin/users")).toHaveLength(0);
  });

  it("改姓名：PATCH /auth/me 只提交 display_name，成功后重新拉取会话", async () => {
    const calls = stubBackend({ onRequest: (call) => (call.url.endsWith("/auth/me") && call.method === "PATCH" ? apiOk({ ...owner, display_name: "老板乙" }) : undefined) });

    render(<AccountCenter />);
    await screen.findByTestId("account-profile-panel");

    const input = screen.getByTestId("account-display-name");
    await userEvent.clear(input);
    await userEvent.type(input, "老板乙");
    await userEvent.click(screen.getByTestId("account-save-name"));

    const [patch] = calls.filter((call) => call.url.endsWith("/auth/me") && call.method === "PATCH");
    await waitFor(() => expect(patch).toBeDefined());
    expect(patch.url).toBe("/api/v1/auth/me");
    expect(JSON.parse(String(patch.body))).toEqual({ display_name: "老板乙" });
    // 保存后必须重取会话：/auth/me 的 GET 至少发生两次（挂载 + 保存后）
    await waitFor(() => expect(callsTo(calls, "/auth/me").length).toBeGreaterThan(1));
  });

  it("姓名没改动时保存按钮点不动（避免无意义的写入与审计噪音）", async () => {
    stubBackend();

    render(<AccountCenter />);
    await screen.findByTestId("account-profile-panel");

    expect(screen.getByTestId("account-save-name")).toBeDisabled();
  });

  it("改密码：两次新密码不一致时本地就拦下，不发请求", async () => {
    const calls = stubBackend();

    render(<AccountCenter />);
    await screen.findByTestId("account-profile-panel");

    await userEvent.type(screen.getByTestId("account-current-password"), "OldPassw0rd1");
    await userEvent.type(screen.getByTestId("account-new-password"), "NewPassw0rd1");
    await userEvent.type(screen.getByTestId("account-confirm-password"), "NewPassw0rd2");
    await userEvent.click(screen.getByTestId("account-change-password"));

    expect(await screen.findByTestId("account-password-error")).toHaveTextContent("两次输入的新密码不一致");
    expect(callsTo(calls, "/auth/password")).toHaveLength(0);
  });

  it("改密码：一致时 POST /auth/password（旧密码 + 新密码），并清空输入框", async () => {
    const calls = stubBackend({ onRequest: (call) => (call.url.endsWith("/auth/password") ? apiNoContent() : undefined) });

    render(<AccountCenter />);
    await screen.findByTestId("account-profile-panel");

    await userEvent.type(screen.getByTestId("account-current-password"), "OldPassw0rd1");
    await userEvent.type(screen.getByTestId("account-new-password"), "NewPassw0rd1");
    await userEvent.type(screen.getByTestId("account-confirm-password"), "NewPassw0rd1");
    await userEvent.click(screen.getByTestId("account-change-password"));

    const [change] = callsTo(calls, "/auth/password");
    await waitFor(() => expect(change).toBeDefined());
    expect(change.method).toBe("POST");
    expect(JSON.parse(String(change.body))).toEqual({ current_password: "OldPassw0rd1", new_password: "NewPassw0rd1" });
    await waitFor(() => expect(screen.getByTestId("account-current-password")).toHaveValue(""));
  });

  it("后端判定旧密码不对时，把服务端原话显示出来而不是含糊的失败文案", async () => {
    stubBackend({ onRequest: (call) => (call.url.endsWith("/auth/password") && call.method === "POST" ? apiErr(400, "CURRENT_PASSWORD_INVALID", "当前密码不正确") : undefined) });

    render(<AccountCenter />);
    await screen.findByTestId("account-profile-panel");

    await userEvent.type(screen.getByTestId("account-current-password"), "WrongPassw0rd1");
    await userEvent.type(screen.getByTestId("account-new-password"), "NewPassw0rd1");
    await userEvent.type(screen.getByTestId("account-confirm-password"), "NewPassw0rd1");
    await userEvent.click(screen.getByTestId("account-change-password"));

    expect(await screen.findByTestId("account-password-error")).toHaveTextContent("当前密码不正确");
  });
});

describe("账号管理中心 · 管理部分（仅老板/财务）", () => {
  it("老板能看到账号列表：用户名、姓名、角色、状态", async () => {
    stubBackend();

    render(<AccountCenter />);

    const panel = await screen.findByTestId("account-admin-panel");
    expect(within(panel).getByTestId("account-row-laoban1")).toBeVisible();
    expect(within(panel).getByTestId("account-row-renshi")).toBeVisible();
    expect(within(panel).getByTestId("account-role-renshi")).toHaveTextContent("人事");
    expect(within(panel).getAllByText("启用").length).toBeGreaterThan(0);
  });

  it("自己那一行的「停用」是禁用的（防自锁在界面上的体现）", async () => {
    stubBackend();

    render(<AccountCenter />);
    await screen.findByTestId("account-admin-panel");

    // me 的 id 是 u-owner，所以 u-owner 那一行不可停用
    expect(screen.getByTestId("account-toggle-active-laoban1")).toBeDisabled();
    expect(screen.getByTestId("account-toggle-active-renshi")).not.toBeDisabled();
  });

  it("停用他人账号：PATCH /admin/users/:id/active 提交取反后的状态", async () => {
    const calls = stubBackend({ onRequest: (call) => (call.url.includes("/admin/users/") && call.url.endsWith("/active") ? apiOk({}) : undefined) });

    render(<AccountCenter />);
    await screen.findByTestId("account-admin-panel");

    await userEvent.click(screen.getByTestId("account-toggle-active-renshi"));

    const [toggle] = calls.filter((call) => call.url.endsWith("/active"));
    await waitFor(() => expect(toggle).toBeDefined());
    expect(toggle.url).toBe("/api/v1/admin/users/u-hr/active");
    expect(toggle.method).toBe("PATCH");
    expect(JSON.parse(String(toggle.body))).toEqual({ is_active: false });
  });

  it("新建账号：默认角色是「其他」，提交时带用户名/姓名/初始密码与角色", async () => {
    const calls = stubBackend({ onRequest: (call) => (call.url === "/api/v1/admin/users" && call.method === "POST" ? apiOk({}) : undefined) });

    render(<AccountCenter />);
    await screen.findByTestId("account-admin-panel");

    await userEvent.click(screen.getByTestId("account-create-open"));
    const dialog = await screen.findByTestId("action-dialog");
    await userEvent.type(within(dialog).getByTestId("action-field-username"), "yuangong9");
    await userEvent.type(within(dialog).getByTestId("action-field-display_name"), "员工小九");
    await userEvent.type(within(dialog).getByTestId("action-field-password"), "Passw0rd123");
    await userEvent.click(within(dialog).getByRole("button", { name: "创建账号" }));

    const [created] = calls.filter((call) => call.url === "/api/v1/admin/users" && call.method === "POST");
    await waitFor(() => expect(created).toBeDefined());
    expect(JSON.parse(String(created.body))).toEqual({ username: "yuangong9", display_name: "员工小九", password: "Passw0rd123", role_keys: ["qita"] });
  });

  it("最后一个老板被降级时，后端的话原样显示在弹窗里（防自锁②）", async () => {
    stubBackend({ onRequest: (call) => (call.url.endsWith("/roles") && call.method === "POST" ? apiErr(409, "LAST_OWNER_REQUIRED", "系统必须保留至少一个启用中的「老板」账号：请先给另一个账号分配老板角色，再改这个") : undefined) });

    render(<AccountCenter />);
    await screen.findByTestId("account-admin-panel");

    await userEvent.click(screen.getByTestId("account-set-role-laoban1"));
    const dialog = await screen.findByTestId("action-dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));

    expect(await within(dialog).findByText(/系统必须保留至少一个启用中的「老板」账号/)).toBeVisible();
  });
});

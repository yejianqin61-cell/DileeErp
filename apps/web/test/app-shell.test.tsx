// AppShell（components/layout/app-shell.tsx）的**真实行为**测试。
//
// 为什么这个文件优先级高（见 docs/test/00-recon-frontend-coverage.md §5.6 / §7 Top15 #3）：
//   app-shell 是全站**唯一**的会话/权限门禁 —— 挂载时 apiGet("/auth/me")，失败且 code 属于
//   ["UNAUTHORIZED","UNAUTHENTICATED","AUTH_REQUIRED","SESSION_EXPIRED"] 才 window.location.href = "/login"。
//   它此前零行为覆盖：所有"401 → 跳登录"的保证只存在于这一处，回归即全站鉴权门禁失效或登录死循环。
//
// 纪律：不 readFileSync、不正则匹配源码、不断言 className；
//       只断言 DOM 可见结果（文案/可见性/testid）+ window.location 桩 + callsTo(...) 记录到的网络调用。
//       注意 globals: false，vitest API 必须显式 import（见 apps/web/vitest.config.mts）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { apiErr, apiNoContent, apiOk, callsTo, stubApi } from "./helpers/api-stub";
import { AppShell } from "../components/layout/app-shell";

// next/navigation 的桩：pathname 由用例控制（vi.hoisted 避免 mock 工厂的 TDZ）。
const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));

/** 与 app-shell.tsx 的导航表一致（文案 / href / 生成的 testid）。账号中心固定排在最后。 */
const NAV_ITEMS = [
  { label: "工作台", href: "/", testId: "nav-link-dashboard" },
  { label: "生产", href: "/production", testId: "nav-link-production" },
  { label: "采购", href: "/procurement", testId: "nav-link-procurement" },
  { label: "质检", href: "/qc", testId: "nav-link-qc" },
  { label: "财务", href: "/finance", testId: "nav-link-finance" },
  { label: "仓库", href: "/warehouse", testId: "nav-link-warehouse" },
  { label: "人事", href: "/hr", testId: "nav-link-hr" },
  { label: "客户与销售", href: "/sales", testId: "nav-link-sales" },
  { label: "报表与告警", href: "/reports", testId: "nav-link-reports" },
  { label: "账号中心", href: "/account", testId: "nav-link-account" },
] as const;

/** 老板/财务的可见栏目（= 全部）与人事的可见栏目（= 人事 + 账号中心）。 */
const FULL_SECTIONS = ["dashboard", "production", "procurement", "qc", "warehouse", "sales", "customers", "reports", "finance", "hr", "account"];
const HR_SECTIONS = ["hr", "account"];
const ALL_MODULES = ["sales", "procurement", "production", "warehouse", "finance", "hr"];

/** 视为"会话已失效"的 code 白名单（app-shell.tsx:32）。 */
const SESSION_LOST_CODES = ["UNAUTHORIZED", "UNAUTHENTICATED", "AUTH_REQUIRED", "SESSION_EXPIRED"] as const;

/**
 * 已登录会话的响应。必须是**工厂**而不是共享常量：
 * `Response` 的 body 是一次性的，同一个实例第二次 `response.json()` 会 reject，
 * api-client 会把它降级成 `请求失败（HTTP 200）`（lib/api-client.ts:19），
 * 于是除第一个用例外的所有用例都拿到错误态 —— 与组件行为无关的纯测试装配缺陷。
 *
 * 2026-09-19 权限规范起，`/auth/me` 还会带**表面权限**（栏目集合 / 范围 / 角色）与**实际权限**
 * （模块）。默认给"老板"，于是"全部导航 + 内容直出"这一组既有断言仍然成立；
 * 要测门禁就传 overrides 换成人事或其他角色。
 */
const me = (overrides: Record<string, unknown> = {}) => apiOk({
  display_name: "张三",
  username: "zhangsan",
  role_keys: ["laoban"],
  surface_roles: ["laoban"],
  surface_scope: "full",
  surface_sections: FULL_SECTIONS,
  module_keys: ALL_MODULES,
  ...overrides,
});

/** 人事账号：按规则只能进人事页面（以及所有人都能进的账号中心）。 */
const apiAsHr = () => apiOk({ display_name: "人事小王", username: "renshi", role_keys: ["renshi"], surface_roles: ["renshi"], surface_scope: "hr", surface_sections: HR_SECTIONS, module_keys: ALL_MODULES });

/** 其他角色：除财务、人事之外的页面。 */
const apiAsGeneral = () => apiOk({ display_name: "员工小赵", username: "yuangong1", role_keys: ["qita"], surface_roles: ["qita"], surface_scope: "general", surface_sections: ["dashboard", "production", "procurement", "qc", "warehouse", "sales", "customers", "reports", "account"], module_keys: ALL_MODULES });

type LocationStub = { href: string; reload: ReturnType<typeof vi.fn>; assign: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn> };

/**
 * 可观测的 window.location 桩。
 *
 * 为什么不能直接 Object.defineProperty(window, "location", ...)：jsdom 把 window.location 实现为
 * [LegacyUnforgeable]（window 上的 location 与 Location 实例上的 href 都是 configurable: false 的访问器），
 * 重定义会直接抛 TypeError；而组件里的 window.location.href = "/login" 在 jsdom 里只会走
 * "Not implemented: navigation to another Document"，真实 URL 不会变，无任何可断言的痕迹。
 *
 * 做法：用 Object.create(window) 克隆一个 window（原型链仍是真实 window，React / RTL / user-event
 * 需要的其余能力一个不少），只把 location 换成可观测的记录器，再用 vi.stubGlobal 换掉全局 window ——
 * 组件里的 window 是全局自由变量，运行时取到的就是这个克隆。
 * setup.ts 的 afterEach 会 vi.unstubAllGlobals() 还原。
 */
function stubLocation(): LocationStub {
  const location: LocationStub = { href: "/", reload: vi.fn(), assign: vi.fn(), replace: vi.fn() };
  const shellWindow = Object.create(window) as Window;
  Object.defineProperty(shellWindow, "location", { value: location, writable: true, configurable: true });
  vi.stubGlobal("window", shellWindow);
  return location;
}

function renderShell(children: ReactNode = <div data-testid="page-content">页面内容</div>) {
  return render(<AppShell>{children}</AppShell>);
}

/** 可控 Promise：把组件稳定停在"正在验证登录状态..."上。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  route.pathname = "/";
});

describe("AppShell · 会话门禁：/auth/me 与会话失效跳登录", () => {
  it.each(SESSION_LOST_CODES)("会话失效 code=%s → 跳转 /login，且不渲染导航与页面内容", async (code) => {
    const location = stubLocation();
    route.pathname = "/production";
    const calls = stubApi(() => apiErr(401, code, "登录状态已失效"));

    renderShell(<div data-testid="page-content">生产看板</div>);

    await waitFor(() => expect(location.href).toBe("/login"));
    expect(callsTo(calls, "/auth/me")).toHaveLength(1);
    // 未认证时绝不能把业务界面闪给用户
    expect(screen.queryByTestId("app-nav")).toBeNull();
    expect(screen.queryByTestId("app-main")).toBeNull();
    expect(screen.queryByTestId("page-content")).toBeNull();
  });

  it("401 且响应体不是 JSON：api-client 映射成 UNAUTHENTICATED，同样跳转", async () => {
    const location = stubLocation();
    // 反代/网关返回 HTML 错误页时 body 解析不了（api-client.ts:19 的降级分支）
    stubApi(() => new Response("<html><body>401 Unauthorized</body></html>", { status: 401, headers: { "content-type": "text/html" } }));

    renderShell();

    await waitFor(() => expect(location.href).toBe("/login"));
  });

  it.each([
    { status: 500, code: "INTERNAL_SERVER_ERROR", message: "服务器内部错误" },
    { status: 403, code: "FORBIDDEN", message: "没有访问该模块的权限" },
    { status: 503, code: "SERVICE_UNAVAILABLE", message: "服务暂不可用" },
  ])("非会话类错误 $code → 显示错误态而不是跳转，并且不发第二次鉴权请求", async ({ status, code, message }) => {
    const location = stubLocation();
    const calls = stubApi(() => apiErr(status, code, message));

    renderShell(<div data-testid="page-content">生产看板</div>);

    expect(await screen.findByText(message)).toBeVisible();
    // 服务端故障/无权限不能被误判成"会话失效"，否则会把用户踢进登录页
    expect(location.href).toBe("/");
    expect(screen.queryByTestId("app-nav")).toBeNull();
    expect(screen.queryByTestId("page-content")).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
    expect(callsTo(calls, "/auth/me")).toHaveLength(1);
  });

  it("边界（recon 附录 B3 标注未验证）：白名单外的 401 code 只显示错误、不跳登录", async () => {
    const location = stubLocation();
    stubApi(() => apiErr(401, "TOKEN_MALFORMED", "登录凭证无法识别"));

    renderShell();

    expect(await screen.findByText("登录凭证无法识别")).toBeVisible();
    expect(location.href).toBe("/");
  });

  it("网络不可达（fetch 直接拒绝）→ 回落到统一的连接错误文案，不跳登录也不白屏", async () => {
    const location = stubLocation();
    stubApi(() => Promise.reject(new TypeError("Failed to fetch")));

    renderShell();

    expect(await screen.findByText("无法连接服务，请稍后重试")).toBeVisible();
    expect(location.href).toBe("/");
    expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
  });

  it("错误态点「重试」触发整页重新加载（window.location.reload）", async () => {
    const location = stubLocation();
    stubApi(() => apiErr(500, "INTERNAL_SERVER_ERROR", "服务器内部错误"));

    renderShell();
    await screen.findByText("服务器内部错误");

    await userEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  it("鉴权请求未返回时显示「正在验证登录状态...」，此时既无导航也无页面内容", async () => {
    const gate = deferred<Response>();
    stubApi(() => gate.promise);

    renderShell(<div data-testid="page-content">生产看板</div>);

    expect(screen.getByText("正在验证登录状态...")).toBeVisible();
    expect(screen.queryByTestId("app-nav")).toBeNull();
    expect(screen.queryByTestId("app-main")).toBeNull();
    expect(screen.queryByTestId("page-content")).toBeNull();

    gate.resolve(me());

    expect(await screen.findByTestId("app-nav")).toBeVisible();
    expect(screen.queryByText("正在验证登录状态...")).toBeNull();
    expect(screen.getByTestId("page-content")).toBeVisible();
  });
});

describe("AppShell · 鉴权通过后的导航与主区渲染", () => {
  it("渲染 9 项主导航（文案 + href + 定位钩子），主区内渲染 children，顶栏显示操作员", async () => {
    const calls = stubApi(() => me());

    renderShell(<div data-testid="page-content">生产看板</div>);

    const navEl = await screen.findByTestId("app-nav");
    expect(navEl).toHaveAttribute("aria-label", "主导航");
    expect(within(navEl).getAllByRole("link")).toHaveLength(NAV_ITEMS.length);
    for (const item of NAV_ITEMS) {
      const link = within(navEl).getByRole("link", { name: item.label });
      expect(link).toHaveAttribute("href", item.href);
      expect(link).toBe(screen.getByTestId(item.testId));
    }

    // 页面内容必须落在主区内（布局契约：导航在侧栏，children 在 main）
    expect(screen.getByTestId("app-main")).toContainElement(screen.getByTestId("page-content"));
    expect(screen.getByTestId("page-content")).toHaveTextContent("生产看板");
    expect(screen.getByText("厂内系统")).toBeVisible();

    // 顶栏操作员取自 /auth/me
    expect(screen.getByText("张三")).toBeVisible();
    expect(screen.queryByText("当前操作员")).toBeNull();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeVisible();

    // 一次挂载只校验一次会话
    expect(callsTo(calls, "/auth/me")).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("只有鉴权成功后才有退出登录入口：加载态与错误态都不渲染它", async () => {
    stubApi(() => apiErr(500, "INTERNAL_SERVER_ERROR", "服务器内部错误"));

    renderShell();

    expect(await screen.findByText("服务器内部错误")).toBeVisible();
    expect(screen.queryByRole("button", { name: "退出登录" })).toBeNull();
  });

  it("pathname 变化会重新校验会话（切页后仍受门禁保护）", async () => {
    const calls = stubApi(() => me());
    const { rerender } = renderShell(<div data-testid="page-content">工作台</div>);
    await screen.findByTestId("app-nav");
    expect(callsTo(calls, "/auth/me")).toHaveLength(1);

    route.pathname = "/finance";
    rerender(
      <AppShell>
        <div data-testid="page-content">财务</div>
      </AppShell>
    );

    await waitFor(() => expect(callsTo(calls, "/auth/me")).toHaveLength(2));
    expect(await screen.findByTestId("app-nav")).toBeVisible();
    expect(screen.getByTestId("page-content")).toHaveTextContent("财务");
  });

  it("切页后会话已过期：第二次校验失败即跳转 /login", async () => {
    const location = stubLocation();
    route.pathname = "/";
    let attempts = 0;
    stubApi(() => {
      attempts += 1;
      return attempts === 1 ? me() : apiErr(401, "SESSION_EXPIRED", "登录已过期，请重新登录");
    });

    const { rerender } = renderShell();
    await screen.findByTestId("app-nav");

    route.pathname = "/warehouse";
    rerender(
      <AppShell>
        <div data-testid="page-content">仓库</div>
      </AppShell>
    );

    await waitFor(() => expect(location.href).toBe("/login"));
    expect(screen.queryByTestId("app-nav")).toBeNull();
  });
});

describe("AppShell · 登录页旁路", () => {  it("pathname 为 /login 时不发任何鉴权请求，直接渲染登录页", async () => {
    route.pathname = "/login";
    // 任何请求都会让本用例以"不该发生的调用"失败
    const calls = stubApi(() => apiErr(500, "SHOULD_NOT_BE_CALLED", "pathname=/login 不应发起请求"));

    renderShell(<div data-testid="page-content">登录表单</div>);

    expect(screen.getByTestId("page-content")).toBeVisible();
    expect(screen.queryByTestId("app-nav")).toBeNull();
    expect(screen.queryByTestId("app-main")).toBeNull();
    expect(screen.queryByText("正在验证登录状态...")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("从 /login 进入业务页后门禁立即生效：先显示校验中，再渲染导航", async () => {
    route.pathname = "/login";
    const gate = deferred<Response>();
    const calls = stubApi(() => gate.promise);
    const { rerender } = renderShell(<div data-testid="page-content">登录表单</div>);
    expect(calls).toHaveLength(0);

    route.pathname = "/production";
    rerender(
      <AppShell>
        <div data-testid="page-content">生产看板</div>
      </AppShell>
    );

    expect(await screen.findByText("正在验证登录状态...")).toBeVisible();
    expect(callsTo(calls, "/auth/me")).toHaveLength(1);

    gate.resolve(me());

    expect(await screen.findByTestId("app-nav")).toBeVisible();
    expect(screen.getByTestId("page-content")).toHaveTextContent("生产看板");
  });
});

describe("AppShell · 退出登录", () => {
  /** /auth/me 成功、其余请求按参数响应。 */
  function stubShell(logout: () => Response) {
    return stubApi((url) => (url.endsWith("/auth/me") ? me() : logout()));
  }

  it("点「退出登录」：POST /api/v1/auth/logout（无请求体）成功后跳转 /login", async () => {
    const location = stubLocation();
    const calls = stubShell(() => apiNoContent());

    renderShell();
    await screen.findByTestId("app-nav");

    await userEvent.click(screen.getByRole("button", { name: "退出登录" }));

    await waitFor(() => expect(callsTo(calls, "/auth/logout")).toHaveLength(1));
    const [logoutCall] = callsTo(calls, "/auth/logout");
    expect(logoutCall.method).toBe("POST");
    expect(logoutCall.url).toBe("/api/v1/auth/logout");
    expect(logoutCall.body).toBeNull();
    await waitFor(() => expect(location.href).toBe("/login"));
  });

  it("KNOWN_DEFECT：退出登录请求失败时静默无反应（无提示、不跳转）", async () => {
    // 期望：退出登录失败时给出可读提示（或至少清掉本地会话状态 / 落回登录页）。
    // 实际：logout() 没有 try/catch，失败时 await 抛出 → 既不提示也不跳转，用户点了按钮却停在原页面；
    //      调用点是 `onClick={() => void logout()}`（app-shell.tsx:46），拒绝的 Promise 无人接管，
    //      成为未处理的 Promise 拒绝（生产环境控制台报错）。
    // 责任文件：components/layout/app-shell.tsx:36（logout 无错误处理）、:46（void 丢弃拒绝）。
    const location = stubLocation();
    const calls = stubShell(() => apiErr(500, "INTERNAL_SERVER_ERROR", "退出失败，请重试"));

    renderShell();
    await screen.findByTestId("app-nav");

    // 本仓库 vitest 会把未处理的 Promise 拒绝判为整个测试文件的错误；为了让"缺陷本身"可被断言而不是把测试跑红，
    // 这里在触发窗口内**追加**一个 unhandledRejection 监听器（不是摘掉 vitest 的）：
    // vitest 的 catchError 在 `process.listeners(event).length > 1` 时直接返回，认为拒绝已由用户代码接管
    //（node_modules/vitest/dist/chunks/init.BS957yFf.js:103），因此文件不再报 "Errors 1 error"。
    // 顺带把这个"逃逸的拒绝"本身变成证据：它必须真的派发过一次，且原因就是服务端消息。
    const escapedRejections: unknown[] = [];
    const onRejection = (reason: unknown) => { escapedRejections.push(reason); };
    process.on("unhandledRejection", onRejection);
    try {
      await userEvent.click(screen.getByRole("button", { name: "退出登录" }));
      await waitFor(() => expect(callsTo(calls, "/auth/logout")).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onRejection);
    }

    expect(location.href).not.toBe("/login");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("app-nav")).toBeVisible();
    // 缺陷的直接证据：logout() 的拒绝没有任何人接管（onClick 用 void 丢弃）
    expect(escapedRejections).toHaveLength(1);
    expect((escapedRejections[0] as Error).message).toBe("退出失败，请重试");
  });

  it("KNOWN_DEFECT：退出登录按钮没有 in-flight 守卫，连点会发出第二次 POST", async () => {
    // 期望：请求进行中时按钮禁用（或 logout 内部有重入锁），连点只发一次 POST。
    // 实际：按钮只挂 onClick（app-shell.tsx:46），无 disabled / 无重入标志 —— 两次点击 = 两次登出请求。
    // 严重度低（登出幂等），但它是 recon §5.7「全站无 disabled 守卫」在门禁组件上的实例。
    // 责任文件：components/layout/app-shell.tsx:46（Button 无 disabled={...}）、:36（logout 无重入锁）。
    const location = stubLocation();
    const calls = stubShell(() => apiNoContent());

    renderShell();
    await screen.findByTestId("app-nav");

    const button = screen.getByRole("button", { name: "退出登录" });
    await userEvent.click(button);
    await userEvent.click(button);

    await waitFor(() => expect(callsTo(calls, "/auth/logout")).toHaveLength(2));
    expect(location.href).toBe("/login");
  });

  it("退出登录只影响会话：不额外拉取任何业务数据", async () => {
    const location = stubLocation();
    const calls = stubShell(() => apiNoContent());

    renderShell();
    await screen.findByTestId("app-nav");
    await userEvent.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(location.href).toBe("/login"));

    expect(calls.map((call) => call.url)).toEqual(["/api/v1/auth/me", "/api/v1/auth/logout"]);
  });
});

/**
 * 表面权限（2026-09-19 权限规范）：菜单只留进得去的、越权直达就地拦。
 *
 * 为什么这几条必须测：门禁与菜单都由 `/auth/me` 的 `surface_sections` 驱动，
 * 而它算错时**不会有任何报错**——菜单少一项、或页面进不去，只有人试用才会发现。
 * 规则本身（谁能看哪些栏目）在后端 surface-scope.test.cjs 与前端 lib/surface-permission.test.mjs
 * 各有一份矩阵；这里测的是**组件确实按它执行**：藏菜单、就地拦、不改地址栏。
 */
describe("AppShell · 表面权限门禁", () => {
  it("人事：菜单只剩人事与账号中心，直达 /finance 被就地拦截且不渲染页面内容", async () => {
    route.pathname = "/finance";
    stubApi(apiAsHr);

    renderShell(<div data-testid="page-content">财务看板</div>);

    const navEl = await screen.findByTestId("app-nav");
    expect(within(navEl).getAllByRole("link").map((link) => link.textContent)).toEqual(["人事", "账号中心"]);
    // 门禁页取代 children：财务内容一个字都不许出现
    expect(screen.getByTestId("page-access-denied")).toBeVisible();
    expect(screen.queryByTestId("page-content")).toBeNull();
    // 就地渲染：地址栏不变（没有跳转），导航还在，用户能点回自己的页面
    expect(screen.getByTestId("access-denied-message")).toHaveTextContent("人事");
    expect(screen.getByTestId("access-denied-message")).toHaveTextContent("财务");
    expect(within(screen.getByTestId("access-denied-links")).getByRole("link", { name: "去人事" })).toHaveAttribute("href", "/hr");
  });

  it("人事：自己权限内的页面正常渲染（门禁不会误伤）", async () => {
    route.pathname = "/hr";
    stubApi(apiAsHr);

    renderShell(<div data-testid="page-content">员工名单</div>);

    await screen.findByTestId("app-nav");
    expect(screen.getByTestId("page-content")).toHaveTextContent("员工名单");
    expect(screen.queryByTestId("page-access-denied")).toBeNull();
  });

  it("其他角色：菜单隐藏财务与人事，直达 /hr 被拦", async () => {
    route.pathname = "/hr";
    stubApi(apiAsGeneral);

    renderShell(<div data-testid="page-content">员工名单</div>);

    const navEl = await screen.findByTestId("app-nav");
    const labels = within(navEl).getAllByRole("link").map((link) => link.textContent);
    expect(labels).not.toContain("财务");
    expect(labels).not.toContain("人事");
    expect(labels).toContain("工作台");
    expect(labels).toContain("报表与告警");
    expect(screen.getByTestId("page-access-denied")).toBeVisible();
  });

  it("其他角色：财务页同样被拦（用户拍板的两个禁区之一）", async () => {
    route.pathname = "/finance/payable";
    stubApi(apiAsGeneral);

    renderShell(<div data-testid="page-content">应付管理</div>);

    await screen.findByTestId("app-nav");
    expect(screen.getByTestId("page-access-denied")).toBeVisible();
    expect(screen.getByTestId("access-denied-message")).toHaveTextContent("财务");
    expect(screen.queryByTestId("page-content")).toBeNull();
  });

  it("老板：全部导航可见、财务页直出（最高表面权限）", async () => {
    route.pathname = "/finance";
    stubApi(() => me());

    renderShell(<div data-testid="page-content">财务看板</div>);

    const navEl = await screen.findByTestId("app-nav");
    expect(within(navEl).getAllByRole("link")).toHaveLength(NAV_ITEMS.length);
    expect(screen.getByTestId("page-content")).toHaveTextContent("财务看板");
    expect(screen.queryByTestId("page-access-denied")).toBeNull();
  });

  it("顶栏显示当前角色，并且总是留一个进账号中心的入口", async () => {
    route.pathname = "/";
    stubApi(apiAsHr);

    renderShell();

    await screen.findByTestId("app-nav");
    expect(screen.getByTestId("user-menu-role")).toHaveTextContent("人事");
    expect(screen.getByTestId("user-menu-account")).toHaveAttribute("href", "/account");
    expect(screen.getByTestId("nav-link-account")).toHaveAttribute("href", "/account");
  });
});

// 单位池页面（components/production/unit-pool-page.tsx）的真实行为测试。
//
// 纪律：真实 render + userEvent/fireEvent 驱动，只断言 DOM 可见结果与 callsTo(...) 记录到的请求；
// 不 readFileSync、不正则匹配源码、不断言 className。
//
// 页面契约来源（读实现得出，测试按运行时结果钉住）：
//   - 首屏 GET /units + 整页加载态：unit-pool-page.tsx:36-40、:73
//   - 列表与统计「共 N 个单位，其中 M 个启用」：:48、:74
//   - 搜索按「名称 + 备注」小写包含匹配：:49
//   - 新建/编辑：:52 / :55（apiPost("/units") / apiPatch("/units/:id")，提交体出自 lib/unit-options.ts:38）
//   - 停用/启用：:57（apiPatch("/units/:id/active", { is_active })）
//   - 删除：:58（apiRequest DELETE）
//   - 动作结果只经 toast 呈现（:44-45），页面本身没有动作结果区，故渲染时一并挂 <Toaster />
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnitPoolPage } from "../components/production/unit-pool-page";
import { Toaster } from "../components/ui/toaster";
import { apiErr, apiOk, callsTo, stubApi, type StubbedCall } from "./helpers/api-stub";

type Unit = { id: string; name: string; remark?: string | null; isActive: boolean };
type FixtureError = { status: number; code: string; message: string };

const baseUnits: Unit[] = [
  { id: "unit-1", name: "打", remark: null, isActive: true },
  { id: "unit-2", name: "个", remark: "常用计量", isActive: false },
  { id: "unit-3", name: "码", remark: null, isActive: true },
];

/** 带拉丁名的单位，用来验证搜索的大小写不敏感。 */
const searchableUnits: Unit[] = [
  { id: "unit-1", name: "打", remark: null, isActive: true },
  { id: "unit-2", name: "个", remark: "常用计量", isActive: false },
  { id: "unit-3", name: "KG", remark: "Kilogram", isActive: true },
];

type Fixture = {
  units?: Unit[];
  /** 前 N 次 GET /units 以 listError 失败（用于错误态 + 重试）。 */
  listFailures?: number;
  listError?: FixtureError;
  /** 所有变更请求（POST/PATCH/DELETE）都以该错误失败。 */
  mutationError?: FixtureError;
  /**
   * 变更请求挂起在该 Promise 上（用于观察"提交中"与飞行中状态）。
   * 只应在"一个用例里只发一个变更请求"时使用：同一个 Response 被读取两次会抛错。
   */
  mutationGate?: Promise<Response>;
};

/** 复刻真实后端形状的桩：GET 回列表，变更成功后把结果写回本地列表，下一次 GET 能看到。 */
function stubUnitApi(fixture: Fixture = {}) {
  let current = [...(fixture.units ?? baseUnits)];
  let remainingListFailures = fixture.listFailures ?? 0;
  const calls = stubApi((url, call) => {
    if (url.endsWith("/units") && call.method === "GET") {
      if (remainingListFailures > 0) {
        remainingListFailures -= 1;
        const failure = fixture.listError ?? { status: 500, code: "INTERNAL_SERVER_ERROR", message: "单位池加载失败" };
        return apiErr(failure.status, failure.code, failure.message);
      }
      return apiOk(current);
    }
    if (call.method === "GET") return apiErr(404, "NOT_FOUND", `测试未打桩的请求：${url}`);

    // —— 以下都是变更请求 ——
    if (fixture.mutationGate) return fixture.mutationGate;
    if (fixture.mutationError) return apiErr(fixture.mutationError.status, fixture.mutationError.code, fixture.mutationError.message);

    const body = call.body ? (JSON.parse(String(call.body)) as Record<string, unknown>) : null;
    if (call.method === "POST" && url.endsWith("/units")) {
      current = [...current, { id: `unit-created-${current.length + 1}`, name: String(body?.name ?? ""), remark: (body?.remark as string | null) ?? null, isActive: true }];
      return apiOk({});
    }
    if (call.method === "PATCH" && url.endsWith("/active")) {
      const id = unitIdFrom(url);
      current = current.map((row) => (row.id === id ? { ...row, isActive: Boolean(body?.is_active) } : row));
      return apiOk({});
    }
    if (call.method === "PATCH" && /\/units\/[^/]+$/.test(url)) {
      const id = unitIdFrom(url);
      current = current.map((row) => (row.id === id ? { ...row, name: String(body?.name ?? row.name), remark: (body?.remark as string | null) ?? null } : row));
      return apiOk({});
    }
    if (call.method === "DELETE") {
      const id = unitIdFrom(url);
      current = current.filter((row) => row.id !== id);
      return apiOk({});
    }
    return apiOk({});
  });
  return { calls };
}

function unitIdFrom(url: string) {
  return url.replace(/^.*\/units\//, "").replace(/\/active$/, "");
}

function renderPage() {
  // 动作结果（成功/失败）只通过 toast 呈现，所以必须挂上 Toaster，否则"操作成功"不可见。
  return render(
    <>
      <UnitPoolPage />
      <Toaster />
    </>
  );
}

/** 挂载页面并等待首屏加载结束（loading-state 消失），返回 fetch 调用记录。 */
async function renderLoaded(fixture: Fixture = {}) {
  const api = stubUnitApi(fixture);
  renderPage();
  await waitFor(() => expect(screen.queryByTestId("loading-state")).toBeNull());
  return api;
}

// queryAllByTestId：空表（0 行）时 getAllByTestId 会直接抛错，取不到"零行"这个事实。
function dataRows() {
  return screen.queryAllByTestId("data-table-row");
}

function rowFor(text: string) {
  const row = dataRows().find((item) => item.textContent?.includes(text));
  if (!row) throw new Error(`未找到包含「${text}」的单位行`);
  return row;
}

function jsonBody(call: StubbedCall | undefined) {
  if (!call) throw new Error("没有记录到该请求");
  return JSON.parse(String(call.body)) as Record<string, unknown>;
}

function mutations(calls: StubbedCall[], method: string) {
  return calls.filter((call) => call.method === method);
}

function listGets(calls: StubbedCall[]) {
  return calls.filter((call) => call.method === "GET" && call.url.endsWith("/units"));
}

/** 可手动控制的 Promise，用来把页面稳定停在"提交中/飞行中"上做断言。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 打开新建对话框并等到它可见。 */
async function openCreateDialog() {
  await userEvent.click(screen.getByRole("button", { name: "新建单位" }));
  const dialog = await screen.findByTestId("action-dialog");
  return dialog;
}

describe("单位池 · 加载态、列表渲染与空态", () => {
  it("GET /units 未返回时只显示加载态，返回后渲染数据行与「共 N 个 / M 个启用」统计", async () => {
    const gate = deferred<Response>();
    stubApi((url) => (url.endsWith("/units") ? gate.promise : apiOk([])));

    renderPage();

    expect(screen.getByTestId("loading-state")).toBeVisible();
    expect(screen.queryByTestId("data-table")).toBeNull();

    gate.resolve(apiOk(baseUnits));

    expect(await screen.findByTestId("data-table")).toBeVisible();
    expect(screen.queryByTestId("loading-state")).toBeNull();
    expect(dataRows()).toHaveLength(3);
    // 统计段落里「2」在 <strong> 内，跨元素取不到整串，用 toHaveTextContent 断言整段文本
    expect(screen.getByText(/共 3 个单位/)).toHaveTextContent("共 3 个单位，其中 2 个启用。");
  });

  it("每行渲染名称、备注（缺失回落 -）、启停状态与三个行内操作", async () => {
    await renderLoaded();

    const active = rowFor("打");
    expect(active).toHaveTextContent("打");
    expect(active).toHaveTextContent("-");
    expect(within(active).getByText("启用")).toBeVisible();
    expect(within(active).getByRole("button", { name: "编辑" })).toBeVisible();
    expect(within(active).getByRole("button", { name: "停用" })).toBeVisible();
    expect(within(active).getByRole("button", { name: "删除" })).toBeVisible();

    const inactive = rowFor("个");
    expect(inactive).toHaveTextContent("常用计量");
    expect(within(inactive).getByText("停用")).toBeVisible();
    // 已停用的行给的是「启用」入口，而不是再停用一次
    expect(within(inactive).getByRole("button", { name: "启用" })).toBeVisible();
    expect(within(inactive).queryByRole("button", { name: "停用" })).toBeNull();
  });

  it("单位池为空时渲染空态与 0 统计，一行都不渲染", async () => {
    await renderLoaded({ units: [] });

    expect(screen.getByTestId("empty-state")).toHaveTextContent("暂无单位");
    expect(screen.getByText(/共 0 个单位/)).toHaveTextContent("共 0 个单位，其中 0 个启用。");
    expect(dataRows()).toHaveLength(0);
  });

  it("加载失败显示错误态，点「重新加载」重新请求并恢复列表", async () => {
    const { calls } = await renderLoaded({ listFailures: 1, listError: { status: 503, code: "SERVICE_UNAVAILABLE", message: "服务端维护中，请稍后重试" } });

    // 服务端的 message 要原样呈现给用户，而不是笼统的兜底文案
    expect(screen.getByTestId("error-state")).toHaveTextContent("服务端维护中，请稍后重试");
    expect(dataRows()).toHaveLength(0);

    await userEvent.click(screen.getByTestId("error-state-retry"));

    expect(await screen.findByTestId("data-table")).toBeVisible();
    expect(screen.queryByTestId("error-state")).toBeNull();
    expect(dataRows()).toHaveLength(3);
    expect(listGets(calls)).toHaveLength(2);
  });

  it("KNOWN_DEFECT：加载失败时同时渲染「暂无单位」空态与「共 0 个单位」，用户会误以为单位池是空的", async () => {
    // 期望：加载失败时数据区不渲染（或与错误态互斥），用户只看到"加载失败 + 重试"。
    // 实际：error 与数据区是并列分支（unit-pool-page.tsx:72 与 :73-75），加载失败后 loading=false，
    //      于是 rows=[] 的空表照常渲染 → EmptyState「暂无单位」+「共 0 个单位，其中 0 个启用」，
    //      与上面的错误提示自相矛盾，用户可能据此以为单位主数据被清空。
    // 责任文件：components/production/unit-pool-page.tsx:72-75。
    await renderLoaded({ listFailures: 1, listError: { status: 503, code: "SERVICE_UNAVAILABLE", message: "服务端维护中，请稍后重试" } });

    expect(screen.getByTestId("error-state")).toHaveTextContent("服务端维护中，请稍后重试");
    expect(screen.getByTestId("empty-state")).toHaveTextContent("暂无单位");
    expect(screen.getByText(/共 0 个单位/)).toHaveTextContent("共 0 个单位，其中 0 个启用。");
  });

  it("搜索框按名称或备注过滤（大小写不敏感），无匹配回落空态，清空后恢复全部", async () => {
    await renderLoaded({ units: searchableUnits });
    const search = screen.getByPlaceholderText("输入关键词");

    // 命中备注
    await userEvent.type(search, "常用");
    await waitFor(() => expect(dataRows()).toHaveLength(1));
    expect(rowFor("个")).toBeVisible();

    // 命中名称，且大小写不敏感（KG ← "kg"）
    await userEvent.clear(search);
    await userEvent.type(search, "kg");
    await waitFor(() => expect(dataRows()).toHaveLength(1));
    expect(dataRows()[0]).toHaveTextContent("KG");

    // 清空恢复全部
    await userEvent.clear(search);
    await waitFor(() => expect(dataRows()).toHaveLength(3));

    // 无匹配 → 空态
    await userEvent.type(search, "不存在的单位");
    await waitFor(() => expect(dataRows()).toHaveLength(0));
    expect(screen.getByTestId("empty-state")).toHaveTextContent("暂无单位");
  });
});

describe("单位池 · 新建单位对话框", () => {
  it("点「新建单位」才打开对话框：标题与两个字段可见，未点击前弹窗不存在", async () => {
    await renderLoaded();

    expect(screen.queryByTestId("action-dialog")).toBeNull();

    const dialog = await openCreateDialog();

    expect(within(dialog).getByRole("heading", { name: "新建单位" })).toBeVisible();
    expect(within(dialog).getByText("单位名称")).toBeVisible();
    expect(within(dialog).getByText("备注")).toBeVisible();
    expect(screen.getByTestId("action-field-name")).toBeEnabled();
    expect(screen.getByTestId("action-field-remark")).toBeEnabled();
    expect(screen.getByTestId("action-dialog-submit")).toHaveTextContent("保存");
  });

  it("名称留空提交：提示「请填写单位名称」，不发请求，弹窗也不关闭", async () => {
    const { calls } = await renderLoaded();
    await openCreateDialog();

    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    expect(await screen.findByTestId("action-dialog-error")).toHaveTextContent("请填写单位名称");
    expect(mutations(calls, "POST")).toHaveLength(0);
    // 校验失败不能关弹窗，否则用户填的内容会丢
    expect(screen.getByTestId("action-dialog")).toBeVisible();
  });

  it("新建成功：POST /units 带 trim 后的名称与备注，提示成功、关闭弹窗并把新单位刷进列表", async () => {
    const { calls } = await renderLoaded();
    await openCreateDialog();

    // 名称前后故意带空格：提交体必须是 trim 过的
    await userEvent.type(screen.getByTestId("action-field-name"), "  套  ");
    await userEvent.type(screen.getByTestId("action-field-remark"), "成套计量");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(mutations(calls, "POST")).toHaveLength(1));
    const [created] = mutations(calls, "POST");
    expect(created.url).toBe("/api/v1/units");
    expect(jsonBody(created)).toEqual({ name: "套", remark: "成套计量" });

    expect(await screen.findByText("单位已创建")).toBeVisible();
    expect(screen.queryByTestId("action-dialog")).toBeNull();
    // 成功后必须重新拉取列表，新单位要真的出现在表里（POST → GET 的数据流）
    await waitFor(() => expect(dataRows()).toHaveLength(4));
    expect(rowFor("套")).toBeVisible();
    expect(listGets(calls).length).toBeGreaterThanOrEqual(2);
  });

  it("新建时备注留空：提交体要带 remark: null，而不是省略该键", async () => {
    // 后端 updateUnit 把 undefined 解释为"不修改"，省略 remark 会让"清空备注"静默失效
    // （lib/unit-options.ts:38-40 的约定），所以这里钉住键必须存在且为 null。
    const { calls } = await renderLoaded();
    await openCreateDialog();

    await userEvent.type(screen.getByTestId("action-field-name"), "箱");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(mutations(calls, "POST")).toHaveLength(1));
    const body = jsonBody(mutations(calls, "POST")[0]);
    expect(body).toEqual({ name: "箱", remark: null });
    expect(Object.keys(body)).toContain("remark");
  });
});

describe("单位池 · 编辑单位对话框", () => {
  it("编辑对话框预填当前名称与备注，改名后 PATCH /units/:id 并刷新列表", async () => {
    const { calls } = await renderLoaded();

    await userEvent.click(within(rowFor("个")).getByRole("button", { name: "编辑" }));

    expect(await screen.findByRole("heading", { name: "编辑单位：个" })).toBeVisible();
    expect(screen.getByTestId("action-field-name")).toHaveValue("个");
    expect(screen.getByTestId("action-field-remark")).toHaveValue("常用计量");

    await userEvent.clear(screen.getByTestId("action-field-name"));
    await userEvent.type(screen.getByTestId("action-field-name"), "个（大）");
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/units/unit-2").filter((call) => call.method === "PATCH")).toHaveLength(1));
    const [patched] = callsTo(calls, "/units/unit-2").filter((call) => call.method === "PATCH");
    // 必须打到该行自己的 id 上，不能打到集合根
    expect(patched.url).toBe("/api/v1/units/unit-2");
    expect(jsonBody(patched)).toEqual({ name: "个（大）", remark: "常用计量" });

    expect(await screen.findByText("单位已更新")).toBeVisible();
    await waitFor(() => expect(rowFor("个（大）")).toBeVisible());
  });

  it("编辑时清空备注：PATCH 带 remark: null，刷新后该行备注回落为 -", async () => {
    const { calls } = await renderLoaded();

    await userEvent.click(within(rowFor("个")).getByRole("button", { name: "编辑" }));
    await screen.findByTestId("action-dialog");
    expect(screen.getByTestId("action-field-remark")).toHaveValue("常用计量");

    await userEvent.clear(screen.getByTestId("action-field-remark"));
    await userEvent.click(screen.getByTestId("action-dialog-submit"));

    await waitFor(() => expect(callsTo(calls, "/units/unit-2").filter((call) => call.method === "PATCH")).toHaveLength(1));
    expect(jsonBody(callsTo(calls, "/units/unit-2").filter((call) => call.method === "PATCH")[0])).toEqual({ name: "个", remark: null });

    await waitFor(() => expect(listGets(calls).length).toBeGreaterThanOrEqual(2));
    const row = rowFor("个");
    expect(row).toHaveTextContent("-");
    expect(row).not.toHaveTextContent("常用计量");
  });
});

describe("单位池 · 停用与启用", () => {
  it("停用启用中的单位：PATCH /units/:id/active 带 is_active:false，提示并刷新为停用", async () => {
    const { calls } = await renderLoaded();
    expect(screen.getByText(/共 3 个单位/)).toHaveTextContent("共 3 个单位，其中 2 个启用。");

    await userEvent.click(within(rowFor("打")).getByRole("button", { name: "停用" }));

    await waitFor(() => expect(callsTo(calls, "/units/unit-1/active")).toHaveLength(1));
    const [toggle] = callsTo(calls, "/units/unit-1/active");
    expect(toggle.method).toBe("PATCH");
    expect(toggle.url).toBe("/api/v1/units/unit-1/active");
    expect(jsonBody(toggle)).toEqual({ is_active: false });

    expect(await screen.findByText("单位已停用")).toBeVisible();
    // 刷新后状态列翻转成「停用」，行内动作随之变成「启用」，统计里的启用数也要减少
    await waitFor(() => expect(within(rowFor("打")).getByText("停用")).toBeVisible());
    expect(within(rowFor("打")).getByRole("button", { name: "启用" })).toBeVisible();
    expect(screen.getByText(/共 3 个单位/)).toHaveTextContent("共 3 个单位，其中 1 个启用。");
  });

  it("启用已停用的单位：PATCH 带 is_active:true，提示「单位已启用」并把状态刷成启用", async () => {
    const { calls } = await renderLoaded();
    expect(within(rowFor("个")).getByRole("button", { name: "启用" })).toBeVisible();

    await userEvent.click(within(rowFor("个")).getByRole("button", { name: "启用" }));

    await waitFor(() => expect(callsTo(calls, "/units/unit-2/active")).toHaveLength(1));
    const [toggle] = callsTo(calls, "/units/unit-2/active");
    expect(toggle.method).toBe("PATCH");
    expect(jsonBody(toggle)).toEqual({ is_active: true });

    expect(await screen.findByText("单位已启用")).toBeVisible();
    await waitFor(() => expect(within(rowFor("个")).getByRole("button", { name: "停用" })).toBeVisible());
    expect(within(rowFor("个")).getByText("启用")).toBeVisible();
    expect(screen.getByText(/共 3 个单位/)).toHaveTextContent("共 3 个单位，其中 3 个启用。");
  });

  it("停用被服务端拒绝（单位已被物料/BOM/工序引用）：提示服务端原因，状态不变也不重拉列表", async () => {
    // 后端 procurement-master-data.service.ts 在单位被引用时拒绝停用/删除，
    // 前端的责任是把服务端原因原样告诉用户，并且不能"看起来成功了"。
    const { calls } = await renderLoaded({ mutationError: { status: 409, code: "MASTER_DATA_IN_USE", message: "该单位已被物料默认单位引用，无法停用" } });

    await userEvent.click(within(rowFor("打")).getByRole("button", { name: "停用" }));

    expect(await screen.findByText("该单位已被物料默认单位引用，无法停用")).toBeVisible();
    expect(within(rowFor("打")).getByText("启用")).toBeVisible();
    expect(within(rowFor("打")).getByRole("button", { name: "停用" })).toBeVisible();
    expect(screen.getByText(/共 3 个单位/)).toHaveTextContent("共 3 个单位，其中 2 个启用。");
    // 失败路径不 load()：只有首屏那一次 GET
    expect(listGets(calls)).toHaveLength(1);
  });
});

describe("单位池 · 删除与提交中状态", () => {
  it("删除单位：DELETE /units/:id，提示成功并刷新掉该行", async () => {
    const { calls } = await renderLoaded();

    // 现状：点一次就直接发 DELETE（页面没有二次确认步骤）
    await userEvent.click(within(rowFor("码")).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(callsTo(calls, "/units/unit-3")).toHaveLength(1));
    const [removed] = callsTo(calls, "/units/unit-3");
    expect(removed.method).toBe("DELETE");
    expect(removed.url).toBe("/api/v1/units/unit-3");

    expect(await screen.findByText("单位已删除")).toBeVisible();
    await waitFor(() => expect(dataRows()).toHaveLength(2));
    expect(dataRows().some((row) => row.textContent?.includes("码"))).toBe(false);
  });

  it("提交中：保存按钮立刻进入「提交中…」禁用态，连点也不会发出第二个请求", async () => {
    const gate = deferred<Response>();
    const { calls } = await renderLoaded({ mutationGate: gate.promise });
    await openCreateDialog();
    await userEvent.type(screen.getByTestId("action-field-name"), "套");

    // 用 fireEvent 同步点击：ActionDialog 在同一个事件 tick 内就置 submitting=true（action-dialog.tsx:28）
    fireEvent.click(screen.getByTestId("action-dialog-submit"));

    const pending = screen.getByTestId("action-dialog-submit");
    expect(pending).toBeDisabled();
    expect(pending).toHaveTextContent("提交中…");
    expect(mutations(calls, "POST")).toHaveLength(1);

    // 提交中的按钮不可再触发一次提交
    fireEvent.click(pending);
    expect(mutations(calls, "POST")).toHaveLength(1);

    gate.resolve(apiOk({}));

    expect(await screen.findByText("单位已创建")).toBeVisible();
  });

  it("KNOWN_DEFECT：请求还没返回对话框就先关了；失败时用户输入丢失、弹窗里看不到错误", async () => {
    // 期望：提交期间弹窗保持打开（action-dialog.tsx:26-28 的设计契约：submitting 期间门禁关闭，
    //      失败时在弹窗内用 action-dialog-error 报错、保留用户输入）。
    // 实际：unit-pool-page.tsx:52/55 写的是 `submit: (values) => void run(...)` —— `void` 丢弃了 Promise，
    //      ActionDialog 的 `await onSubmit(values)` 立刻返回并 onOpenChange(false)，
    //      弹窗在请求仍在飞行时就被关掉；run() 内部又自己 catch 掉了错误（:45），
    //      所以服务端拒绝时错误只以 toast 出现，用户刚填的名称无法找回、也无法在弹窗里改正后重试。
    // 责任文件：components/production/unit-pool-page.tsx:44-46（run 吞掉错误）、:52 与 :55（void 丢弃 Promise）。
    const gate = deferred<Response>();
    const { calls } = await renderLoaded({ mutationGate: gate.promise });
    await openCreateDialog();
    await userEvent.type(screen.getByTestId("action-field-name"), "套");

    fireEvent.click(screen.getByTestId("action-dialog-submit"));
    expect(mutations(calls, "POST")).toHaveLength(1);

    // 请求仍在飞行中，弹窗却已经关闭
    await waitFor(() => expect(screen.queryByTestId("action-dialog")).toBeNull());

    gate.resolve(apiErr(409, "UNIT_NAME_EXISTS", "单位名称已存在"));

    expect(await screen.findByText("单位名称已存在")).toBeVisible();
    // 弹窗级错误区永远不会出现，输入框也不在了 → 用户只能从头再填
    expect(screen.queryByTestId("action-dialog-error")).toBeNull();
    expect(screen.queryByTestId("action-field-name")).toBeNull();
    // 失败不应该触发列表重拉（只有成功路径才 load()）
    expect(listGets(calls)).toHaveLength(1);
  });
});

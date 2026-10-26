// 「迪礼顾问」对话页的**行为**测试（真实渲染 + 真实事件，只替换网络与 SSE）。
//
// 覆盖用户拍板的验收点：
//   空态 → 推荐问题只填入输入框不发送；首条消息后自然进入对话；Enter 发送 / Shift+Enter 换行；
//   流式增量与 Markdown 表格；工具调用折叠卡（默认摘要、展开只有安全详情）；
//   停止按钮打真接口；失败后错误反馈 + 重试；提交失败（409/429）草稿不丢；
//   历史会话列表与切换；新建对话不产生空会话。
// 同时锁住 E2E（tests/e2e/business-query-recovery.spec.mjs）依赖的 testid 与文案。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BusinessQueryPage from "../app/business-query/page";

type StreamEvent = { seq: number; type: string; data: Record<string, unknown> };
type StreamOptions = { runId: string; lastSeq: number; onOpen?: () => void; onEvent: (event: StreamEvent) => void; onRetry?: () => void };

const streamCalls = vi.hoisted(() => ({ current: null as StreamOptions | null }));
const stream = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const errors = vi.hoisted(() => ({
  ApiClientError: class ApiClientError extends Error {
    readonly code: string;
    readonly details: unknown[] = [];
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock("../lib/api-client", () => ({ ApiClientError: errors.ApiClientError, apiGet: api.get, apiPost: api.post }));
vi.mock("../lib/business-query-stream", () => ({ followRunStream: stream }));

beforeEach(() => {
  // SSE 被替换成「只登记回调」：用例自己决定什么时候推哪个事件，时序完全可控。
  streamCalls.current = null;
  stream.mockImplementation(async (options: StreamOptions) => { streamCalls.current = options; });
});

const session = (overrides: Record<string, unknown> = {}) => ({ session_id: "s-1", created_at: "2026-10-26T01:00:00.000Z", updated_at: "2026-10-26T02:00:00.000Z", ...overrides });
const snapshotRun = (overrides: Record<string, unknown> = {}) => ({
  run_id: "r-1",
  state: "completed",
  question: "最近有哪些销售订单？",
  answer: "有 3 张订单。",
  sources: [] as { business_type: string; business_no: string }[],
  latest_seq: 5,
  error_code: null,
  access_level: "operational",
  created_at: "2026-10-26T01:00:00.000Z",
  ...overrides,
});

/** 挂载时两次 GET：会话列表 + 最近会话快照。 */
function stubBootstrap(runs: Record<string, unknown>[] = [], sessions = [session()]) {
  api.get.mockResolvedValueOnce({ data: { sessions } });
  if (sessions.length > 0) api.get.mockResolvedValueOnce({ data: { session_id: String(sessions[0].session_id), runs } });
}

/** 打开页面并等到工作区真正就绪（加载态没有 page-business-query testid）。 */
async function renderPage() {
  render(<BusinessQueryPage />);
  await screen.findByTestId("page-business-query");
  return screen.getByLabelText("业务问题") as HTMLTextAreaElement;
}

/** 提问 → 等 POST /runs 返回 → 拿到页面注册的 SSE 回调。 */
async function sendQuestion(question: string) {
  const input = screen.getByLabelText("业务问题") as HTMLTextAreaElement;
  await userEvent.type(input, `${question}{Enter}`);
  await waitFor(() => expect(streamCalls.current).not.toBeNull());
  return streamCalls.current as StreamOptions;
}

function emit(options: StreamOptions, event: StreamEvent) {
  act(() => options.onEvent(event));
}

describe("迪礼顾问 · 空态与输入", () => {
  it("无消息时展示 AI 图标、标题、副标题与四个推荐问题", async () => {
    stubBootstrap([]);

    await renderPage();

    expect(screen.getByTestId("agent-welcome")).toBeVisible();
    expect(screen.getByText("今天有什么可以帮您？")).toBeVisible();
    expect(screen.getByText("查询订单、追踪生产进度、了解采购与库存情况")).toBeVisible();
    expect(screen.getAllByTestId("agent-suggestion").map((card) => card.textContent)).toEqual([
      "最近有哪些销售订单？",
      "哪些生产任务即将延期？",
      "目前有哪些物料库存不足？",
      "帮我汇总本月采购情况。",
    ]);
  });

  it("点推荐问题只把内容填进输入框，不直接发送", async () => {
    stubBootstrap([]);
    const input = await renderPage();

    await userEvent.click(screen.getAllByTestId("agent-suggestion")[1]);

    expect(input).toHaveValue("哪些生产任务即将延期？");
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByTestId("agent-welcome")).toBeVisible();
  });

  it("Shift+Enter 换行不发送，Enter 才发送（没有会话时先按需建会话）", async () => {
    stubBootstrap([], []);
    api.post.mockResolvedValueOnce({ data: { session_id: "s-2" } }).mockResolvedValueOnce({ data: { run_id: "r-9", state: "planning" } });
    const input = await renderPage();

    await userEvent.type(input, "第一行{Shift>}{Enter}{/Shift}第二行");
    expect(input).toHaveValue("第一行\n第二行");
    expect(api.post).not.toHaveBeenCalled();

    await userEvent.type(input, "{Enter}");
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post.mock.calls[0][0]).toBe("/business-query/sessions");
    expect(api.post.mock.calls[1][0]).toBe("/business-query/sessions/s-2/runs");
  });

  it("中文输入法选词时的 Enter 不发送（否则半截问题会被发出去）", async () => {
    stubBootstrap([]);
    const input = await renderPage();
    await userEvent.type(input, "订单");

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(api.post).not.toHaveBeenCalled();
    expect(input).toHaveValue("订单");
  });

  it("提交请求还没返回时连按 Enter 只发一次请求；此时停止按钮禁用（没有可取消的 run）", async () => {
    stubBootstrap([]);
    let resolveRun!: (value: { data: { run_id: string; state: string } }) => void;
    api.post.mockReturnValueOnce(new Promise((resolve) => { resolveRun = resolve; }));
    const input = await renderPage();
    await userEvent.type(input, "最近有哪些销售订单？");

    // 同一个 act 里连按两次：两次 keydown 之间 React 还没提交 busy 状态，靠 submitLock 挡住第二次
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("business-query-cancel")).toBeDisabled();

    resolveRun({ data: { run_id: "r-9", state: "planning" } });
    await waitFor(() => expect(screen.getByTestId("business-query-cancel")).not.toBeDisabled());
  });
});

describe("迪礼顾问 · 第一条消息后进入对话", () => {
  it("发送后欢迎页消失、用户气泡出现、运行中显示停止按钮", async () => {
    stubBootstrap([]);
    api.post.mockResolvedValueOnce({ data: { run_id: "r-9", state: "planning" } });
    await renderPage();

    const options = await sendQuestion("最近有哪些销售订单？");

    // 已有会话时直接提问，不再建会话（apiPost 已被整体替换，body 仍是对象 —— 真实的 api-client 才负责 JSON.stringify）
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post.mock.calls[0][0]).toBe("/business-query/sessions/s-1/runs");
    const body = api.post.mock.calls[0][1] as { question: string; client_message_id: string };
    expect(body.question).toBe("最近有哪些销售订单？");
    expect(body.client_message_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(options.runId).toBe("r-9");

    expect(screen.queryByTestId("agent-welcome")).toBeNull();
    expect(screen.getByTestId("agent-message-user")).toHaveTextContent("最近有哪些销售订单？");
    expect(await screen.findByTestId("business-query-cancel")).toBeVisible();
    expect(screen.getByTestId("business-query-phase")).toHaveTextContent("正在连接…");
    expect(screen.queryByTestId("business-query-submit")).toBeNull();
  });

  it("流式增量逐段渲染，Markdown 表格可横向滚动，完成后显示来源与复制按钮", async () => {
    stubBootstrap([]);
    api.post.mockResolvedValueOnce({ data: { run_id: "r-9", state: "planning" } });
    await renderPage();
    const options = await sendQuestion("最近有哪些销售订单？");

    emit(options, { seq: 1, type: "answer_delta", data: { text: "查到 2 张订单：\n\n| 订单号 | 状态 |\n| --- | --- |\n| SO-1 | 已确认 |" } });
    expect(await screen.findByTestId("agent-markdown-table")).toBeVisible();

    // 再来一段纯正文：流式光标必须贴着最后一个字（在段落里），不能单独占一行。
    emit(options, { seq: 2, type: "answer_delta", data: { text: "\n\n请以单据为准。" } });
    const caret = await screen.findByTestId("agent-stream-caret");
    expect(caret.closest("p")).not.toBeNull();
    expect(caret.closest("p")).toHaveTextContent("请以单据为准。");

    emit(options, { seq: 3, type: "completed", data: { answer: "查到 2 张订单：\n\n| 订单号 | 状态 |\n| --- | --- |\n| SO-1 | 已确认 |\n\n请以单据为准。", sources: [{ business_type: "sales_order", business_no: "SO-1" }] } });

    await waitFor(() => expect(screen.getByTestId("business-query-phase")).toHaveTextContent("已完成"));
    expect(screen.getByTestId("business-query-answer")).toHaveTextContent("SO-1");
    expect(screen.getByTestId("business-query-sources")).toHaveTextContent("销售单 SO-1");
    expect(screen.getByTestId("agent-copy")).toBeVisible();
    expect(screen.queryByTestId("business-query-cancel")).toBeNull();
  });
});

describe("迪礼顾问 · 工具调用与结构化内容", () => {
  it("执行步骤默认一行摘要，展开只显示安全详情（不出现内部参数）", async () => {
    stubBootstrap([]);
    api.post.mockResolvedValueOnce({ data: { run_id: "r-9", state: "planning" } });
    await renderPage();
    const options = await sendQuestion("最近有哪些销售订单？");

    emit(options, { seq: 1, type: "tool_status", data: { tool: "order_query", operation: "search_orders", status: "running" } });
    expect(await screen.findByTestId("agent-tool-step-toggle")).toHaveTextContent("正在查询销售订单");
    expect(screen.getByTestId("agent-tool-step")).toHaveAttribute("data-status", "running");

    emit(options, { seq: 2, type: "tool_status", data: { tool: "order_query", operation: "search_orders", status: "completed" } });
    await waitFor(() => expect(screen.getByTestId("agent-tool-step-toggle")).toHaveTextContent("已查询销售订单"));
    expect(screen.getByTestId("agent-tool-step")).toHaveAttribute("data-status", "success");
    expect(screen.queryByTestId("agent-tool-step-detail")).toBeNull();

    await userEvent.click(screen.getByTestId("agent-tool-step-toggle"));
    const detail = await screen.findByTestId("agent-tool-step-detail");
    expect(detail).toHaveTextContent("查询项：销售订单");
    expect(detail).toHaveTextContent("状态：已完成");
    expect(detail).toHaveTextContent("执行详情只含查询名称与状态");
    expect(detail.textContent).not.toMatch(/search_orders|order_query|SELECT/i);
  });

  it("执行步骤失败时给出业务可读原因", async () => {
    stubBootstrap([]);
    api.post.mockResolvedValueOnce({ data: { run_id: "r-9", state: "planning" } });
    await renderPage();
    const options = await sendQuestion("本月财务应收有多少？");

    emit(options, { seq: 1, type: "tool_status", data: { tool: "finance_query", operation: "get_receivables", status: "failed", code: "AGENT_TOOL_FORBIDDEN" } });
    await userEvent.click(await screen.findByTestId("agent-tool-step-toggle"));
    expect(await screen.findByTestId("agent-tool-step-detail")).toHaveTextContent("当前数据档位不包含这类查询");
  });

  it("复制回复：写入剪贴板后按钮给出「已复制」反馈", async () => {
    stubBootstrap([]);
    api.post.mockResolvedValueOnce({ data: { run_id: "r-9", state: "planning" } });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { clipboard: { writeText } }));
    await renderPage();
    const options = await sendQuestion("最近有哪些销售订单？");

    emit(options, { seq: 1, type: "answer_delta", data: { text: "有 3 张订单。" } });
    emit(options, { seq: 2, type: "completed", data: { answer: "有 3 张订单。", sources: [] } });

    await userEvent.click(await screen.findByTestId("agent-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("有 3 张订单。"));
    expect(screen.getByTestId("agent-copy")).toHaveTextContent("已复制");
  });
});

describe("迪礼顾问 · 取消、错误与恢复", () => {
  it("运行中点停止按钮调用后端取消接口，收到 cancelled 后显示「已取消」", async () => {
    stubBootstrap([]);
    api.post.mockResolvedValueOnce({ data: { run_id: "r-9", state: "planning" } }).mockResolvedValueOnce({ data: { state: "responding" } });
    await renderPage();
    const options = await sendQuestion("最近有哪些销售订单？");

    await userEvent.click(await screen.findByTestId("business-query-cancel"));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/business-query/runs/r-9/cancel"));

    emit(options, { seq: 2, type: "cancelled", data: { state: "cancelled" } });
    await waitFor(() => expect(screen.getByTestId("business-query-phase")).toHaveTextContent("已取消"));
    expect(screen.getByTestId("agent-answer-cancelled")).toBeVisible();
  });

  it("回答失败：显示未完成原因，并可一键用同一问题重试", async () => {
    stubBootstrap([]);
    api.post.mockResolvedValueOnce({ data: { run_id: "r-9", state: "planning" } });
    await renderPage();
    const options = await sendQuestion("最近有哪些销售订单？");

    emit(options, { seq: 1, type: "error", data: { code: "AGENT_RUN_TIMEOUT", message: "本次回答超时，请重试" } });
    expect(await screen.findByTestId("business-query-error")).toHaveTextContent("本次回答超时，请重试");

    api.post.mockResolvedValueOnce({ data: { run_id: "r-10", state: "planning" } });
    await userEvent.click(screen.getByTestId("agent-retry"));
    await waitFor(() => expect(api.post.mock.calls.filter((call) => String(call[0]).endsWith("/runs"))).toHaveLength(2));
    expect(api.post.mock.calls.at(-1)?.[1]).toMatchObject({ question: "最近有哪些销售订单？" });
  });

  it("提交失败（已有进行中的查询）：错误可读、草稿不丢", async () => {
    stubBootstrap([]);
    api.post.mockRejectedValueOnce(new errors.ApiClientError("RUN_IN_PROGRESS", "你已有一个正在进行的查询，请等待完成或取消后再提问"));
    const input = await renderPage();

    await userEvent.type(input, "界面提问必须保留的草稿{Enter}");

    const notice = await screen.findByTestId("agent-notice");
    expect(notice).toHaveAttribute("role", "alert");
    expect(notice).toHaveTextContent("你已有一个正在进行的查询，请等待完成或取消后再提问");
    expect(input).toHaveValue("界面提问必须保留的草稿");
    expect(stream).not.toHaveBeenCalled();
  });
});

describe("迪礼顾问 · 刷新恢复与历史会话", () => {
  it("从快照恢复最近一轮：答案直接可见，进行中的继续续接 SSE 而不重新提问", async () => {
    stubBootstrap([snapshotRun({ state: "responding", answer: "已有回答", latest_seq: 7 })]);

    await renderPage();

    expect(await screen.findByTestId("business-query-answer")).toHaveTextContent("已有回答");
    await waitFor(() => expect(stream).toHaveBeenCalledWith(expect.objectContaining({ runId: "r-1", lastSeq: 7 })));
    expect(api.post).not.toHaveBeenCalled();
  });

  it("历史记录列出本人会话（标题取首个问题）并可切过去继续看", async () => {
    stubBootstrap([], [session()]);
    const input = await renderPage();
    expect(input).toBeVisible();
    expect(screen.getByTestId("agent-welcome")).toBeVisible();

    api.get
      .mockResolvedValueOnce({ data: { sessions: [session({ session_id: "s-2", updated_at: "2026-10-26T03:00:00.000Z" }), session()] } })
      .mockResolvedValueOnce({ data: { runs: [snapshotRun({ run_id: "r-2", question: "之前问过的问题", answer: "旧答案" })] } })
      .mockResolvedValueOnce({ data: { runs: [] } });

    await userEvent.click(screen.getByTestId("agent-history-open"));
    const items = await screen.findAllByTestId("agent-history-item");
    expect(items[0]).toHaveTextContent("之前问过的问题");

    api.get.mockResolvedValueOnce({ data: { session_id: "s-2", runs: [snapshotRun({ run_id: "r-2", question: "之前问过的问题", answer: "旧答案" })] } });
    await userEvent.click(items[0]);

    await waitFor(() => expect(screen.getByTestId("agent-message-user")).toHaveTextContent("之前问过的问题"));
    expect(screen.getByTestId("business-query-answer")).toHaveTextContent("旧答案");
    expect(screen.queryByTestId("agent-welcome")).toBeNull();
  });

  it("新建对话回到欢迎页，且不会先造一个空会话", async () => {
    stubBootstrap([snapshotRun()]);
    await renderPage();
    expect(await screen.findByTestId("agent-message-user")).toHaveTextContent("最近有哪些销售订单？");

    await userEvent.click(screen.getByTestId("agent-new-conversation"));

    expect(await screen.findByTestId("agent-welcome")).toBeVisible();
    expect(screen.queryByTestId("agent-message-user")).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgentPage from "../app/agent/page";
import { SessionContext } from "../lib/session-context";
import type { SessionProfile } from "../lib/session";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
const stream = vi.hoisted(() => vi.fn());
const errors = vi.hoisted(() => ({
  ApiClientError: class ApiClientError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
const cache = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  const store = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
  };
  return { data, store };
});

vi.mock("../lib/api-client", () => ({ ApiClientError: errors.ApiClientError, apiGet: api.get, apiPost: api.post }));
vi.mock("../lib/business-query-stream", () => ({ followRunStream: stream }));
vi.mock("../lib/agent-cache-idb", () => ({ openAgentCacheStore: () => cache.store }));

const KEY = "session:u-1";
const never = () => new Promise<never>(() => undefined);

const run = (patch: Record<string, unknown> = {}) => ({
  run_id: "r-1",
  state: "completed",
  question: "最近有哪些销售订单？",
  answer: "缓存答案",
  sources: [],
  latest_seq: 5,
  error_code: null,
  access_level: "operational",
  created_at: "2026-11-26T01:00:00.000Z",
  ...patch,
});

const profile: SessionProfile = {
  id: "u-1",
  username: "yuangong1",
  display_name: "员工小赵",
  role_keys: ["qita"],
  surface_roles: ["qita"],
  surface_scope: "general",
  surface_sections: ["business-query"],
  module_keys: [],
};

const sessions = (ids: string[] = ["s-1"]) => ({ data: { sessions: ids.map((id) => ({ session_id: id, created_at: "2026-11-26", updated_at: "2026-11-26" })) } });
const snapshot = (runs: unknown[]) => ({ data: { session_id: "s-1", runs } });
const seed = (runs: unknown[] = [run()]) => cache.data.set(KEY, { v: 1, session_id: "s-1", runs });

function renderPage() {
  return render(<SessionContext.Provider value={profile}><AgentPage /></SessionContext.Provider>);
}

beforeEach(() => {
  cache.data.clear();
  cache.store.get.mockImplementation(async (key: string) => cache.data.get(key));
  cache.store.set.mockImplementation(async (key: string, value: unknown) => { cache.data.set(key, value); });
  cache.store.delete.mockImplementation(async (key: string) => { cache.data.delete(key); });
  cache.store.clear.mockImplementation(async () => { cache.data.clear(); });
  api.get.mockReset();
  api.post.mockReset();
  stream.mockReset();
  stream.mockResolvedValue(undefined);
});

describe("顾问页 · 冷启动先出缓存", () => {
  it("服务端未返回时先看到缓存内容，发送被挡住且草稿保留", async () => {
    seed();
    api.get.mockImplementation(never);
    renderPage();

    expect(await screen.findByTestId("business-query-answer")).toHaveTextContent("缓存答案");
    const input = screen.getByLabelText("业务问题");
    await userEvent.type(input, "新问题{Enter}");

    expect(api.post).not.toHaveBeenCalled();
    expect(input).toHaveValue("新问题");
    expect(screen.getByTestId("business-query-submit")).toBeDisabled();
  });

  it("服务端快照到达后覆盖屏上内容与缓存", async () => {
    seed();
    api.get.mockResolvedValueOnce(sessions()).mockResolvedValueOnce(snapshot([run({ answer: "服务端答案" })]));
    renderPage();

    await waitFor(() => expect(screen.getByTestId("business-query-answer")).toHaveTextContent("服务端答案"));
    expect(screen.queryByText("缓存答案")).toBeNull();
    await waitFor(() => expect(JSON.stringify(cache.data.get(KEY))).toContain("服务端答案"));
  });

  it("缓存读取卡住时服务端路径照常出结果", async () => {
    cache.store.get.mockImplementation(never);
    api.get.mockResolvedValueOnce(sessions()).mockResolvedValueOnce(snapshot([run({ answer: "服务端答案" })]));
    renderPage();

    expect(await screen.findByTestId("business-query-answer")).toHaveTextContent("服务端答案");
  });

  it("服务端没有任何会话时回到欢迎页并清缓存", async () => {
    seed();
    api.get.mockResolvedValueOnce(sessions([]));
    renderPage();

    expect(await screen.findByTestId("agent-welcome")).toBeVisible();
    await waitFor(() => expect(cache.data.has(KEY)).toBe(false));
    expect(screen.queryByText("缓存答案")).toBeNull();
  });

  it("对账期间新建对话，迟到的快照被丢弃", async () => {
    seed();
    let deliver!: (value: unknown) => void;
    api.get.mockResolvedValueOnce(sessions()).mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve; }));
    renderPage();
    await screen.findByTestId("business-query-answer");
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole("button", { name: /新建对话/ }));
    await act(async () => { deliver(snapshot([run({ answer: "迟到答案" })])); });

    expect(screen.getByTestId("agent-welcome")).toBeVisible();
    expect(screen.queryByText("迟到答案")).toBeNull();
    await userEvent.type(screen.getByLabelText("业务问题"), "x");
    expect(screen.getByTestId("business-query-submit")).not.toBeDisabled();
  });

  it("缓存里的财务档轮次不展示给普通档位", async () => {
    seed([run({ access_level: "full", answer: "财务答案" })]);
    api.get.mockImplementation(never);
    renderPage();

    await waitFor(() => expect(cache.store.get).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByText("财务答案")).toBeNull();
    expect(screen.queryByTestId("page-agent")).toBeNull();
  });
});

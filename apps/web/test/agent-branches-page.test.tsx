import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
    get: async (key: string) => data.get(key),
    set: async (key: string, value: unknown) => { data.set(key, value); },
    delete: async (key: string) => { data.delete(key); },
    clear: async () => { data.clear(); },
    keys: async () => [...data.keys()],
  };
  return { data, store };
});

vi.mock("../lib/api-client", () => ({ ApiClientError: errors.ApiClientError, apiGet: api.get, apiPost: api.post, apiPatch: vi.fn(), apiDelete: vi.fn() }));
vi.mock("../lib/business-query-stream", () => ({ followRunStream: stream }));
vi.mock("../lib/agent-cache-idb", () => ({ openAgentCacheStore: () => cache.store }));

const profile: SessionProfile = { id: "u-1", username: "u", display_name: "员工", role_keys: ["qita"], surface_roles: ["qita"], surface_scope: "general", surface_sections: ["business-query"], module_keys: [] };
const run = (id: string, question: string) => ({ run_id: id, state: "completed", question, answer: `${question}的回答`, sources: [], latest_seq: 3, error_code: null, access_level: "operational", created_at: "2026-11-26" });
let runs: ReturnType<typeof run>[] = [];

beforeEach(() => {
  cache.data.clear();
  runs = [run("r-1", "第一问"), run("r-2", "第二问")];
  api.get.mockReset();
  api.post.mockReset();
  stream.mockReset();
  api.get.mockImplementation(async (path: string) => (path === "/business-query/sessions"
    ? { data: { sessions: [{ session_id: "s-1", created_at: "2026-11-26", updated_at: "2026-11-26" }] } }
    : { data: { session_id: "s-1", runs } }));
  api.post.mockImplementation(async (_path: string, body: { question: string }) => {
    const id = `r-${runs.length + 1}`;
    runs = [...runs, run(id, body.question)];
    return { data: { run_id: id, state: "planning" } };
  });
  stream.mockImplementation(async (options: { onEvent: (event: unknown) => void }) => options.onEvent({ seq: 2, type: "completed", data: { answer: "新回答", sources: [] } }));
});

const questions = () => screen.getAllByTestId("agent-message-user").map((node) => within(node).getByTestId("agent-question").textContent);
const lastBody = () => api.post.mock.calls.at(-1)?.[1] as { question: string; context_run_ids: string[] };

async function open() {
  const view = render(<SessionContext.Provider value={profile}><AgentPage /></SessionContext.Provider>);
  await screen.findByText("第一问");
  await waitFor(() => expect(screen.getAllByRole("button", { name: "编辑" })[0]).not.toBeDisabled());
  return view;
}

async function editSecond(text: string) {
  await userEvent.click(within(screen.getAllByTestId("agent-message-user")[1]).getByRole("button", { name: "编辑" }));
  const editor = screen.getByLabelText("编辑问题");
  await userEvent.clear(editor);
  await userEvent.type(editor, text);
  await userEvent.click(screen.getByRole("button", { name: "重新发送" }));
  await screen.findByText("2/2");
}

describe("顾问页 · 编辑重发与分支", () => {
  it("改第二问只带第一轮作上下文，旧版本可见版本号", async () => {
    await open();

    await editSecond("改过的第二问");

    expect(lastBody()).toMatchObject({ question: "改过的第二问", context_run_ids: ["r-1"] });
    expect(questions()).toEqual(["第一问", "改过的第二问"]);
  });

  it("切回旧版本后重挂仍是旧版本", async () => {
    const view = await open();
    await editSecond("改过的第二问");

    await userEvent.click(await screen.findByRole("button", { name: "上一个版本" }));
    expect(questions()).toEqual(["第一问", "第二问"]);
    expect(screen.getByText("1/2")).toBeVisible();
    view.unmount();

    await open();
    await waitFor(() => expect(questions()).toEqual(["第一问", "第二问"]));
  });

  it("在旧版本上追问带旧路径的两轮", async () => {
    await open();
    await editSecond("改过的第二问");
    await userEvent.click(await screen.findByRole("button", { name: "上一个版本" }));

    await userEvent.type(screen.getByLabelText("业务问题"), "接着问{Enter}");

    await waitFor(() => expect(lastBody().question).toBe("接着问"));
    expect(lastBody().context_run_ids).toEqual(["r-1", "r-2"]);
    await waitFor(() => expect(questions()).toEqual(["第一问", "第二问", "接着问"]));
  });

  it("改首问不带任何历史", async () => {
    await open();

    await userEvent.click(within(screen.getAllByTestId("agent-message-user")[0]).getByRole("button", { name: "编辑" }));
    await userEvent.type(screen.getByLabelText("编辑问题"), "补充");
    await userEvent.click(screen.getByRole("button", { name: "重新发送" }));

    await screen.findByText("2/2");
    expect(lastBody().context_run_ids).toEqual([]);
    expect(questions()).toEqual(["第一问补充"]);
  });

  it("重发失败时不动输入框，提示里的重试仍按分支发送", async () => {
    await open();
    await userEvent.type(screen.getByLabelText("业务问题"), "打到一半");
    api.post.mockImplementationOnce(async () => { throw new errors.ApiClientError("AGENT_BUSY", "当前使用业务查询的人较多"); });

    await userEvent.click(within(screen.getAllByTestId("agent-message-user")[1]).getByRole("button", { name: "编辑" }));
    await userEvent.type(screen.getByLabelText("编辑问题"), "再问");
    await userEvent.click(screen.getByRole("button", { name: "重新发送" }));

    await screen.findByTestId("agent-notice");
    expect(screen.getByLabelText("业务问题")).toHaveValue("打到一半");
    await userEvent.click(screen.getByTestId("agent-notice-retry"));
    await screen.findByText("2/2");
    expect(lastBody()).toMatchObject({ question: "第二问再问", context_run_ids: ["r-1"] });
    expect(screen.getByLabelText("业务问题")).toHaveValue("打到一半");
  });
});

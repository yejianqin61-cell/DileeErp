import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgentPage from "../app/agent/page";
import { SessionContext } from "../lib/session-context";
import type { SessionProfile } from "../lib/session";
import { clearPrivateData, loadDraft, saveDraft } from "../features/agent-chat/chat/drafts";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
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
vi.mock("../lib/business-query-stream", () => ({ followRunStream: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/agent-cache-idb", () => ({ openAgentCacheStore: () => cache.store }));

const profile: SessionProfile = { id: "u-1", username: "u", display_name: "员工", role_keys: ["qita"], surface_roles: ["qita"], surface_scope: "general", surface_sections: ["business-query"], module_keys: [] };
const row = (id: string) => ({ session_id: id, title: null, created_at: "2026-11-26", updated_at: "2026-11-26" });
const run = (id: string, question: string) => ({ run_id: id, state: "completed", question, answer: "答", sources: [], latest_seq: 3, error_code: null, access_level: "operational", created_at: "2026-11-26" });

beforeEach(() => {
  cache.data.clear();
  sessionStorage.clear();
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(async (path: string) => {
    if (path === "/business-query/sessions") return { data: { sessions: [row("s-1"), row("s-2")] } };
    const id = path.split("/").at(-1) as string;
    return { data: { session_id: id, runs: [run(`r-${id}`, `问题 ${id}`)] } };
  });
});

const input = () => screen.getByLabelText("业务问题") as HTMLTextAreaElement;
const canSend = () => waitFor(() => expect(screen.getByTestId("business-query-submit")).not.toBeDisabled());

async function open() {
  const view = render(<SessionContext.Provider value={profile}><AgentPage /></SessionContext.Provider>);
  await screen.findByText("问题 s-1");
  return view;
}

async function switchTo(title: string) {
  await userEvent.click(screen.getByTestId("agent-history-open"));
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(title) }));
  await screen.findByTestId("page-agent");
  await screen.findByText(title);
}

describe("草稿模块", () => {
  const memorySession = () => {
    const data = new Map<string, string>();
    return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); }, key: (index: number) => [...data.keys()][index] ?? null, get length() { return data.size; } };
  };

  it("按会话分开存取；空串删键", async () => {
    const context = { userId: "u-1", level: "operational" as const, store: cache.store, session: memorySession() };
    await saveDraft(context, "s-1", "甲");
    expect(await loadDraft(context, "s-1")).toBe("甲");
    expect(await loadDraft(context, "s-2")).toBe("");
    await saveDraft(context, "s-1", "");
    expect(cache.data.size).toBe(0);
  });

  it("财务档位只写 sessionStorage", async () => {
    const session = memorySession();
    const context = { userId: "u-1", level: "full" as const, store: cache.store, session };
    await saveDraft(context, null, "乙");
    expect(cache.data.size).toBe(0);
    expect(session.data.get("drafts:u-1:new")).toBe("乙");
    expect(await loadDraft(context, null)).toBe("乙");
  });

  it("存储抛错时不外抛", async () => {
    const fail = async () => { throw new Error("不可用"); };
    const context = { userId: "u-1", level: "operational" as const, store: { get: fail, set: fail, delete: fail, clear: fail, keys: fail }, session: null };
    await saveDraft(context, "s-1", "甲");
    expect(await loadDraft(context, "s-1")).toBe("");
    await clearPrivateData(context.store, null);
  });

  it("清私有数据时保留分支关系", async () => {
    const session = memorySession();
    session.setItem("drafts:u-1:new", "乙");
    session.setItem("other", "留");
    for (const key of ["session:u-1", "drafts:u-1:s-1", "branches:u-1:s-1"]) cache.data.set(key, 1);
    await clearPrivateData(cache.store, session);
    expect([...cache.data.keys()]).toEqual(["branches:u-1:s-1"]);
    expect([...session.data.keys()]).toEqual(["other"]);
  });
});

describe("顾问页草稿", () => {
  it("打到一半卸载重挂仍在", async () => {
    const view = await open();
    await userEvent.type(input(), "半句");
    await waitFor(() => expect(cache.data.get("drafts:u-1:s-1")).toBe("半句"));
    view.unmount();

    await open();

    await waitFor(() => expect(input()).toHaveValue("半句"));
  });

  it("两个会话各记各的草稿", async () => {
    await open();
    await userEvent.type(input(), "甲");

    await switchTo("问题 s-2");
    await waitFor(() => expect(input()).toHaveValue(""));
    await switchTo("问题 s-1");

    await waitFor(() => expect(input()).toHaveValue("甲"));
  });

  it("发送成功后清掉草稿", async () => {
    api.post.mockResolvedValue({ data: { run_id: "r-9", state: "planning" } });
    await open();
    await userEvent.type(input(), "要发送的");
    await canSend();
    await userEvent.type(input(), "{Enter}");

    await waitFor(() => expect(cache.data.has("drafts:u-1:s-1")).toBe(false));
    expect(input()).toHaveValue("");
  });

  it("发送失败时草稿保留", async () => {
    api.post.mockRejectedValue(new errors.ApiClientError("AGENT_BUSY", "当前使用业务查询的人较多"));
    await open();
    await userEvent.type(input(), "要保留的");
    await canSend();
    await userEvent.type(input(), "{Enter}");

    await screen.findByTestId("agent-notice");
    expect(input()).toHaveValue("要保留的");
    await waitFor(() => expect(cache.data.get("drafts:u-1:s-1")).toBe("要保留的"));
  });
});

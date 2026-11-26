import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgentPage from "../app/agent/page";
import { SessionContext } from "../lib/session-context";
import type { SessionProfile } from "../lib/session";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), remove: vi.fn() }));
const errors = vi.hoisted(() => ({
  ApiClientError: class ApiClientError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
const cache = vi.hoisted(() => ({ data: new Map<string, unknown>() }));

vi.mock("../lib/api-client", () => ({ ApiClientError: errors.ApiClientError, apiGet: api.get, apiPost: api.post, apiPatch: api.patch, apiDelete: api.remove }));
vi.mock("../lib/business-query-stream", () => ({ followRunStream: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/agent-cache-idb", () => ({
  openAgentCacheStore: () => ({
    get: async (key: string) => cache.data.get(key),
    set: async (key: string, value: unknown) => { cache.data.set(key, value); },
    delete: async (key: string) => { cache.data.delete(key); },
    clear: async () => { cache.data.clear(); },
    keys: async () => [...cache.data.keys()],
  }),
}));

const profile: SessionProfile = { id: "u-1", username: "u", display_name: "员工", role_keys: ["qita"], surface_roles: ["qita"], surface_scope: "general", surface_sections: ["business-query"], module_keys: [] };

const run = (id: string, question: string) => ({ run_id: id, state: "completed", question, answer: `${question}的回答`, sources: [], latest_seq: 3, error_code: null, access_level: "operational", created_at: "2026-11-26T01:00:00.000Z" });
const sessionRow = (id: string, title: string | null) => ({ session_id: id, title, created_at: "2026-11-26T01:00:00.000Z", updated_at: "2026-11-26T02:00:00.000Z" });
const runsBySession: Record<string, unknown[]> = { "s-1": [run("r-1", "最近的订单")], "s-2": [run("r-2", "采购到货了吗")] };

beforeEach(() => {
  cache.data.clear();
  for (const mock of Object.values(api)) mock.mockReset();
  api.get.mockImplementation(async (path: string) => {
    if (path === "/business-query/sessions") return { data: { sessions: [sessionRow("s-1", null), sessionRow("s-2", "十月订单")] } };
    const id = path.split("/").at(-1) as string;
    return { data: { session_id: id, runs: runsBySession[id] } };
  });
});

async function openHistory() {
  render(<SessionContext.Provider value={profile}><AgentPage /></SessionContext.Provider>);
  await screen.findByTestId("business-query-answer");
  await userEvent.click(screen.getByTestId("agent-history-open"));
  return screen.findAllByTestId("agent-history-row");
}

describe("历史会话 · 改名与删除", () => {
  it("手动名优先，没有时用首个问题", async () => {
    const rows = await openHistory();

    expect(within(rows[0]).getByTestId("agent-history-item")).toHaveTextContent("最近的订单");
    expect(within(rows[1]).getByTestId("agent-history-item")).toHaveTextContent("十月订单");
  });

  it("改名回车后调接口并更新列表", async () => {
    api.patch.mockResolvedValue({ data: { session_id: "s-2", title: "采购跟进" } });
    const rows = await openHistory();

    await userEvent.click(within(rows[1]).getByRole("button", { name: "改名" }));
    const input = screen.getByLabelText("会话名称");
    await userEvent.clear(input);
    await userEvent.type(input, "  采购跟进  {Enter}");

    await waitFor(() => expect(screen.getAllByTestId("agent-history-item")[1]).toHaveTextContent("采购跟进"));
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledWith("/business-query/sessions/s-2", { title: "采购跟进" });
  });

  it("空白名不提交，Esc 取消且弹窗不关", async () => {
    const rows = await openHistory();

    await userEvent.click(within(rows[1]).getByRole("button", { name: "改名" }));
    await userEvent.clear(screen.getByLabelText("会话名称"));
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Escape}");

    expect(api.patch).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("会话名称")).toBeNull();
    expect(screen.getByTestId("agent-history-dialog")).toBeVisible();
    expect(screen.getAllByTestId("agent-history-item")[1]).toHaveTextContent("十月订单");
  });

  it("删除要确认：取消不请求，确认后该项消失", async () => {
    api.remove.mockResolvedValue({ data: { session_id: "s-2" } });
    const rows = await openHistory();

    await userEvent.click(within(rows[1]).getByRole("button", { name: "删除" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("删除后你看不到这个会话");
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "取消" }));
    expect(api.remove).not.toHaveBeenCalled();

    await userEvent.click(within(screen.getAllByTestId("agent-history-row")[1]).getByRole("button", { name: "删除" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(screen.getAllByTestId("agent-history-item")).toHaveLength(1));
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(api.remove).toHaveBeenCalledWith("/business-query/sessions/s-2");
  });

  it("删除当前会话后回欢迎页并清本地缓存", async () => {
    api.remove.mockResolvedValue({ data: { session_id: "s-1" } });
    const rows = await openHistory();
    await waitFor(() => expect(cache.data.has("session:u-1")).toBe(true));

    await userEvent.click(within(rows[0]).getByRole("button", { name: "删除" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(cache.data.has("session:u-1")).toBe(false));
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByTestId("agent-welcome")).toBeVisible();
  });

  it("删除被拒时显示服务端消息，项还在", async () => {
    api.remove.mockRejectedValue(new errors.ApiClientError("RUN_IN_PROGRESS", "这个会话还有正在进行的查询"));
    const rows = await openHistory();

    await userEvent.click(within(rows[1]).getByRole("button", { name: "删除" }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "确认删除" }));

    expect(await screen.findByTestId("agent-history-action-error")).toHaveTextContent("这个会话还有正在进行的查询");
    expect(screen.getAllByTestId("agent-history-item")).toHaveLength(2);
  });
});

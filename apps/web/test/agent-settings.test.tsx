import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgentPage from "../app/agent/page";

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../lib/api-client", () => ({ ApiClientError: class extends Error {}, apiGet: api.get, apiPost: vi.fn(), apiPatch: vi.fn(), apiDelete: vi.fn() }));
vi.mock("../lib/business-query-stream", () => ({ followRunStream: vi.fn() }));

const KEY = "dilee.agent.settings";
const system = { dark: false, listeners: new Set<() => void>() };

beforeEach(() => {
  system.dark = false;
  system.listeners.clear();
  localStorage.clear();
  api.get.mockResolvedValue({ data: { sessions: [] } });
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return system.dark; },
    addEventListener: (_type: string, listener: () => void) => { system.listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { system.listeners.delete(listener); },
  }));
});

afterEach(() => {
  localStorage.clear();
});

async function open() {
  const view = render(<AgentPage />);
  const workspace = await screen.findByTestId("page-agent");
  return { view, workspace };
}

async function choose(option: string) {
  await userEvent.click(screen.getByTestId("agent-settings-open"));
  await userEvent.click(screen.getByRole("radio", { name: option }));
}

describe("顾问页 · 主题", () => {
  it("默认跟随系统，系统变化时跟着变", async () => {
    system.dark = true;
    const { workspace } = await open();
    await waitFor(() => expect(workspace).toHaveAttribute("data-agent-theme", "dark"));

    act(() => {
      system.dark = false;
      for (const listener of system.listeners) listener();
    });

    expect(workspace).toHaveAttribute("data-agent-theme", "light");
  });

  it("手动选浅色后重挂仍是浅色", async () => {
    system.dark = true;
    const first = await open();
    await choose("浅色");
    expect(first.workspace).toHaveAttribute("data-agent-theme", "light");
    first.view.unmount();

    const second = await open();

    await waitFor(() => expect(second.workspace).toHaveAttribute("data-agent-theme", "light"));
  });

  it.each(["乱码", "{\"theme\":\"紫色\",\"locale\":5}", "null"])("设置值为 %s 时按默认", async (stored) => {
    localStorage.setItem(KEY, stored);

    const { workspace } = await open();

    expect(workspace).toHaveAttribute("data-agent-theme", "light");
    expect(screen.getByText("今天有什么可以帮您？")).toBeVisible();
  });

  it("历史弹窗跟随主题", async () => {
    system.dark = true;
    await open();

    await userEvent.click(screen.getByTestId("agent-history-open"));

    expect(await screen.findByTestId("agent-history-dialog")).toHaveAttribute("data-agent-theme", "dark");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AgentPage from "../app/agent/page";
import { DICTIONARIES } from "../features/agent-chat/i18n";

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

describe("顾问页 · 中英切换", () => {
  it("中英词表键集合一致且没有空值", () => {
    const [chinese, english] = [DICTIONARIES["zh-CN"], DICTIONARIES["en-US"]];

    expect(Object.keys(english).sort()).toEqual(Object.keys(chinese).sort());
    expect([...Object.values(chinese), ...Object.values(english)].filter((value) => !value.trim())).toEqual([]);
  });

  it("占位符在两种语言里一致", () => {
    const slots = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, value] of Object.entries(DICTIONARIES["zh-CN"])) {
      expect(slots(DICTIONARIES["en-US"][key as keyof (typeof DICTIONARIES)["zh-CN"]]), key).toEqual(slots(value));
    }
  });

  it("切到英文后欢迎页没有汉字，重挂仍是英文", async () => {
    const first = await open();
    await choose("English");
    await userEvent.click(screen.getByTestId("agent-settings-open"));
    expect(screen.getByText("How can I help today?")).toBeVisible();
    expect(first.workspace.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    first.view.unmount();

    const second = await open();

    await waitFor(() => expect(screen.getByText("How can I help today?")).toBeVisible());
    expect(second.workspace.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    expect(screen.getByLabelText("Business question")).toBeVisible();
  });
});

// 工具链自检：证明"真实渲染 + 真实事件 + jest-dom 匹配器 + API 桩"四件事都可用。
//
// 这条用例的价值不是覆盖业务，而是让后续 38 个组件测试文件有一个可参照的最小样板，
// 并在工具链被误配（例如 jsdom 未生效、setup 未加载）时立刻变红。
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmptyState, ErrorState, LoadingState } from "../components/feedback/states";
import { apiErr, apiOk, callsTo, stubApi } from "./helpers/api-stub";

describe("frontend-toolchain", () => {
  it("renders a component into jsdom and applies jest-dom matchers", () => {
    render(<LoadingState label="正在加载客户" />);

    // toBeVisible / toHaveTextContent 来自 @testing-library/jest-dom/vitest
    expect(screen.getByText("正在加载客户...")).toBeVisible();
  });

  it("dispatches real user events and invokes the handler", async () => {
    const onRetry = vi.fn();
    render(<ErrorState message="数据加载失败" onRetry={onRetry} />);

    await userEvent.click(screen.getByRole("button", { name: "重新加载" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the empty state with its default copy", () => {
    render(<EmptyState />);

    expect(screen.getByText("暂无数据")).toBeVisible();
    expect(screen.getByText("当前没有可展示的记录")).toBeVisible();
  });

  it("stubs global fetch and records the request the api-client layer would issue", async () => {
    const calls = stubApi((url) => (url.endsWith("/customers") ? apiOk([{ id: "c-1" }]) : apiErr(404, "NOT_FOUND")));

    const ok = await fetch("/api/v1/customers", { method: "GET" });
    const missing = await fetch("/api/v1/unknown", { method: "GET" });

    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({ data: [{ id: "c-1" }], meta: {} });
    expect(missing.status).toBe(404);
    expect(calls).toHaveLength(2);
    expect(callsTo(calls, "/customers")).toHaveLength(1);
  });
});

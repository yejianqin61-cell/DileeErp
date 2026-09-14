// 修复护栏：searchable-select 的弹层必须落在宿主对话框的裁切盒内，否则顶部选项鼠标点不到。
//
// 缺陷（docs/test/results/2026-09-13-e2e-rewrite-and-platform-unit-expansion.md §7.1）：
//   原实现只比较"下方空间是否 ≥288"，不够就朝上，**没检查上方是否够**。
//   触发点靠近对话框顶部时，朝上的弹层伸出对话框上边缘被 overflow:auto 裁掉；
//   实测 1280×720 下 playwright 报 `div.ui-dialog-overlay intercepts pointer events`。
//
// 这里分两层验证：纯决策函数（几何算得准）+ 组件接线（样式确实落到弹层上）。
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchableSelect, choosePopoverPlacement, SEARCHABLE_POPOVER_MAX_HEIGHT } from "../components/ui/searchable-select";

const options = Array.from({ length: 12 }, (_, index) => ({ label: `订单 ${index + 1}`, value: `order-${index + 1}` }));

describe("弹层朝向决策（纯函数）", () => {
  it("下方空间足够时朝下，并使用首选高度", () => {
    expect(choosePopoverPlacement({ spaceAbove: 40, spaceBelow: 400 })).toEqual({ maxHeight: SEARCHABLE_POPOVER_MAX_HEIGHT, placement: "down" });
  });

  it("仅上方足够时朝上", () => {
    expect(choosePopoverPlacement({ spaceAbove: 400, spaceBelow: 40 })).toEqual({ maxHeight: SEARCHABLE_POPOVER_MAX_HEIGHT, placement: "up" });
  });

  it("两侧都放不下整高时选空间更大的一侧 —— 这是原实现出错的分支", () => {
    // 回归点：spaceBelow=265 < 288，原实现无条件朝上（spaceAbove 只有 84），导致弹层被裁掉。
    const chosen = choosePopoverPlacement({ spaceAbove: 84, spaceBelow: 265 });
    expect(chosen.placement).toBe("down");
    expect(chosen.maxHeight).toBe(265);
  });

  it("朝上的可用高度同样会被收敛，保证不越出裁切盒上边缘", () => {
    const chosen = choosePopoverPlacement({ spaceAbove: 150, spaceBelow: 20 });
    expect(chosen.placement).toBe("up");
    expect(chosen.maxHeight).toBe(150);
  });

  it("可用高度永不超过该侧空间（唯一不变量：弹层不越界）", () => {
    for (const [spaceAbove, spaceBelow] of [[0, 0], [10, 20], [100, 100], [0, 500], [500, 0], [287, 287]]) {
      const chosen = choosePopoverPlacement({ spaceAbove, spaceBelow });
      const available = chosen.placement === "down" ? spaceBelow : spaceAbove;
      expect(chosen.maxHeight).toBeLessThanOrEqual(Math.max(24, available));
    }
  });
});

/** 用可控的矩形替换 getBoundingClientRect，模拟真实布局（jsdom 无布局，全部为 0）。 */
function mockRect(element: Element, rect: { bottom: number; top: number }) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ bottom: rect.bottom, height: rect.bottom - rect.top, left: 0, right: 0, toJSON: () => ({}), top: rect.top, width: 0, x: 0, y: 0 }) as DOMRect,
  });
}

describe("弹层在裁切容器内的实际朝向与高度", () => {
  it("触发点靠近对话框顶部且下方不足整高时，改为朝下并把高度限制在可用空间内", async () => {
    const { container } = render(
      <div style={{ overflowY: "auto" }}>
        <SearchableSelect label="订单号" onChange={() => {}} options={options} value="" />
      </div>
    );
    const clip = container.firstElementChild as HTMLElement;
    // 让容器被识别为滚动祖先（scrollHeight > clientHeight 且 overflowY 为 auto）
    Object.defineProperty(clip, "scrollHeight", { configurable: true, value: 800 });
    Object.defineProperty(clip, "clientHeight", { configurable: true, value: 349 });
    // 模拟实测几何：对话框 [186, 535]，触发点靠近其顶部
    mockRect(clip, { bottom: 535, top: 186 });
    const root = container.querySelector(".ui-searchable-select") as HTMLElement;
    mockRect(root, { bottom: 300, top: 260 });

    await userEvent.click(screen.getByRole("combobox"));

    const popover = document.querySelector(".ui-searchable-select-popover") as HTMLElement;
    expect(popover).not.toBeNull();
    // 关键：朝下（不再翻到对话框外），且高度受可用空间约束
    expect(popover.className).toContain("ui-searchable-select-popover-down");
    expect(popover.style.maxHeight).toBe("231px"); // 535 - 300 - 4
    expect(Number.parseInt(popover.style.maxHeight, 10)).toBeLessThanOrEqual(SEARCHABLE_POPOVER_MAX_HEIGHT);
  });

  it("上方空间充裕（≥ 首选高度）时朝上并使用首选高度", async () => {
    const { container } = render(
      <div style={{ overflowY: "auto" }}>
        <SearchableSelect label="订单号" onChange={() => {}} options={options} value="" />
      </div>
    );
    const clip = container.firstElementChild as HTMLElement;
    Object.defineProperty(clip, "scrollHeight", { configurable: true, value: 800 });
    Object.defineProperty(clip, "clientHeight", { configurable: true, value: 700 });
    mockRect(clip, { bottom: 900, top: 200 });
    const root = container.querySelector(".ui-searchable-select") as HTMLElement;
    mockRect(root, { bottom: 740, top: 700 });

    await userEvent.click(screen.getByRole("combobox"));

    const popover = document.querySelector(".ui-searchable-select-popover") as HTMLElement;
    expect(popover.className).toContain("ui-searchable-select-popover-up");
    expect(popover.style.maxHeight).toBe(`${SEARCHABLE_POPOVER_MAX_HEIGHT}px`); // 上方 496px，够整高
  });

  it("上方空间不足以放整高但比下方大时，朝上并按上方可用高度收敛", async () => {
    const { container } = render(
      <div style={{ overflowY: "auto" }}>
        <SearchableSelect label="订单号" onChange={() => {}} options={options} value="" />
      </div>
    );
    const clip = container.firstElementChild as HTMLElement;
    Object.defineProperty(clip, "scrollHeight", { configurable: true, value: 800 });
    Object.defineProperty(clip, "clientHeight", { configurable: true, value: 400 });
    mockRect(clip, { bottom: 500, top: 100 });
    const root = container.querySelector(".ui-searchable-select") as HTMLElement;
    mockRect(root, { bottom: 340, top: 300 });

    await userEvent.click(screen.getByRole("combobox"));

    const popover = document.querySelector(".ui-searchable-select-popover") as HTMLElement;
    // 上方 196 > 下方 156，且都 < 288 —— 选上方并把高度收敛到 196
    expect(popover.className).toContain("ui-searchable-select-popover-up");
    expect(popover.style.maxHeight).toBe("196px");
  });
});

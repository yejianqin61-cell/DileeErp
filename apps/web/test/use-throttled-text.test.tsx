import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { AgentMarkdown } from "../components/agent/agent-markdown";
import { useThrottledText } from "../features/agent-chat/markdown/use-throttled-text";

const clock = { now: 0 };

function SlowChild({ value, cost }: { value: string; cost: number }) {
  clock.now += cost;
  return <p data-testid="out">{value}</p>;
}

function Probe({ text, enabled, cost }: { text: string; enabled: boolean; cost: number }) {
  return <SlowChild value={useThrottledText(text, enabled)} cost={cost} />;
}

const shown = () => screen.getByTestId("out").textContent;
const elapse = (milliseconds: number) => act(() => {
  clock.now += milliseconds;
  vi.advanceTimersByTime(milliseconds);
});

beforeEach(() => {
  clock.now = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useThrottledText", () => {
  it("关闭时立即返回最新内容", () => {
    const view = render(<Probe text="甲" enabled={false} cost={100} />);

    view.rerender(<Probe text="乙" enabled={false} cost={100} />);

    expect(shown()).toBe("乙");
  });

  it("按上次渲染耗时的两倍合并更新，只显示最新一份", () => {
    const view = render(<Probe text="甲" enabled cost={100} />);
    view.rerender(<Probe text="乙" enabled cost={0} />);
    view.rerender(<Probe text="丙" enabled cost={0} />);
    const seen: (string | null)[] = [];

    for (let step = 0; step < 19; step += 1) {
      elapse(10);
      seen.push(shown());
    }
    expect(new Set(seen)).toEqual(new Set(["甲"]));

    elapse(500);
    expect(shown()).toBe("丙");
  });

  it("满间隔时更新，不早不晚", () => {
    const view = render(<Probe text="甲" enabled cost={100} />);
    const committed = clock.now;
    view.rerender(<Probe text="乙" enabled cost={0} />);
    const remaining = committed + 200 - clock.now;

    elapse(remaining - 1);
    expect(shown()).toBe("甲");
    elapse(1);
    expect(shown()).toBe("乙");
  });

  it("等待中关闭节流立即显示最新内容", () => {
    const view = render(<Probe text="甲" enabled cost={100} />);
    view.rerender(<Probe text="乙" enabled cost={100} />);

    view.rerender(<Probe text="乙" enabled={false} cost={100} />);

    expect(shown()).toBe("乙");
  });

  it("渲染再慢，等待也不超过两秒", () => {
    const view = render(<Probe text="甲" enabled cost={5000} />);
    view.rerender(<Probe text="乙" enabled cost={0} />);

    elapse(2000);

    expect(shown()).toBe("乙");
  });
});

describe("AgentMarkdown 流式节流", () => {
  it("流结束时立刻显示完整内容", () => {
    const view = render(<AgentMarkdown text="第一段" caret />);
    view.rerender(<AgentMarkdown text="第一段加上结尾" caret />);

    view.rerender(<AgentMarkdown text="第一段加上结尾" />);

    expect(screen.getByTestId("agent-markdown")).toHaveTextContent("第一段加上结尾");
    expect(screen.queryByTestId("agent-stream-caret")).toBeNull();
  });
});

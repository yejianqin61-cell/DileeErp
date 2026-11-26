import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AgentMarkdown } from "../components/agent/agent-markdown";

const loaded = { timeout: 5000 };

describe("AgentMarkdown 公式", () => {
  it.each(["$$E=mc^2$$", "\\[\nE=mc^2\n\\]", "能量 \\(E=mc^2\\) 守恒"])("%j 排成公式", async (text) => {
    const { container } = render(<AgentMarkdown text={text} />);

    await waitFor(() => expect(container.querySelector(".katex")).not.toBeNull(), loaded);
  });

  it("单个 $ 的金额不排版，文字原样", async () => {
    await import("katex");
    const { container } = render(<AgentMarkdown text="$1,200 到 $1,500" />);

    expect(container.querySelector(".katex")).toBeNull();
    expect(screen.getByTestId("agent-markdown")).toHaveTextContent("$1,200 到 $1,500");
  });

  it("写错的公式退回原文", async () => {
    const { container } = render(<><AgentMarkdown text="$$E=mc^2$$" /><AgentMarkdown text={"$$\\frac{1}{$$"} /></>);

    await waitFor(() => expect(container.querySelector(".katex")).not.toBeNull(), loaded);
    expect(screen.getAllByTestId("agent-markdown")[1]).toHaveTextContent("\\frac{1}{");
    expect(screen.getAllByTestId("agent-markdown")[1].querySelector(".katex")).toBeNull();
  });

  it("后面追加内容时不重建已排版的公式节点", async () => {
    const view = render(<AgentMarkdown text="$$E=mc^2$$" />);
    await waitFor(() => expect(view.container.querySelector(".katex")).not.toBeNull(), loaded);
    const first = view.container.querySelector(".katex");

    view.rerender(<AgentMarkdown text={"$$E=mc^2$$

补充说明"} />);

    expect(view.container.querySelector(".katex")).toBe(first);
  });

  it("公式里的链接命令不产生可点击元素", async () => {
    const { container } = render(<><AgentMarkdown text="$$x$$" /><AgentMarkdown text={"$$\\href{javascript:alert(1)}{y}$$"} /></>);

    await waitFor(() => expect(container.querySelector(".katex")).not.toBeNull(), loaded);
    expect(container.querySelector("[href]")).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AgentMarkdown } from "../components/agent/agent-markdown";

const draw = vi.hoisted(() => vi.fn());

vi.mock("../features/agent-chat/markdown/mermaid", async (original) => ({
  ...(await original<typeof import("../features/agent-chat/markdown/mermaid")>()),
  renderMermaid: draw,
}));

const SOURCE = "```mermaid\ngraph TD\n  A-->B\n```";

beforeEach(() => {
  draw.mockReset();
});

describe("AgentMarkdown 图表", () => {
  it("流式中按代码显示，不调绘制", () => {
    const { container } = render(<AgentMarkdown text={SOURCE} caret />);

    expect(container.querySelector(".agent-md-pre code")).toHaveTextContent("A-->B");
    expect(draw).not.toHaveBeenCalled();
  });

  it("流结束后画成图", async () => {
    draw.mockResolvedValue('<svg data-testid="d"></svg>');
    const view = render(<AgentMarkdown text={SOURCE} caret />);

    view.rerender(<AgentMarkdown text={SOURCE} />);

    expect(await screen.findByTestId("d")).toBeInTheDocument();
    expect(draw).toHaveBeenCalledWith("graph TD\n  A-->B", expect.any(Function));
  });

  it("画好后的重渲染不重建图形节点", async () => {
    draw.mockResolvedValue('<svg data-testid="d"></svg>');
    const view = render(<AgentMarkdown text={SOURCE} />);
    const first = await screen.findByTestId("d");

    view.rerender(<AgentMarkdown text={`${SOURCE}

补充说明`} />);

    expect(screen.getByTestId("d")).toBe(first);
  });

  it("画不出来时保留代码并说明", async () => {
    draw.mockRejectedValue(new Error("语法错误"));
    const { container } = render(<AgentMarkdown text={SOURCE} />);

    expect(await screen.findByText("图表无法渲染")).toBeVisible();
    await waitFor(() => expect(container.querySelector(".agent-md-pre code")).toHaveTextContent("A-->B"));
  });

  it("图片标签在交给库之前被转义", async () => {
    const { sanitizeMermaid } = await import("../features/agent-chat/markdown/mermaid");

    expect(sanitizeMermaid('A["<img src=x>"]')).toBe('A["&lt;img src=x>"]');
    expect(sanitizeMermaid("A[<IMAGE href=x>]")).toBe("A[&lt;IMAGE href=x>]");
  });
});

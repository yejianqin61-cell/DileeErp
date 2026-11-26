import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AgentMarkdown } from "../components/agent/agent-markdown";

const fence = (language: string, code: string) => `\`\`\`${language}\n${code}\n\`\`\``;
const codeOf = (container: HTMLElement) => container.querySelector(".agent-md-pre code") as HTMLElement;
const loaded = { timeout: 5000 };

describe("AgentMarkdown 代码高亮", () => {
  it("内置语言首帧就着色", () => {
    const { container } = render(<AgentMarkdown text={fence("js", "const a = 1;")} />);

    expect(codeOf(container).querySelector(".token.keyword")).toHaveTextContent("const");
    expect(codeOf(container).textContent).toBe("const a = 1;");
  });

  it.each([["python", "def f():\n    return 1"], ["sql", "select 1 from t"], ["tsx", "const a = <b />;"]])("%s 语言包加载后着色", async (language, code) => {
    const { container } = render(<AgentMarkdown text={fence(language, code)} />);

    await waitFor(() => expect(codeOf(container).querySelector(".token")).not.toBeNull(), loaded);
    expect(codeOf(container).textContent).toBe(code);
  });

  it("不支持的语言按纯文本显示", () => {
    const { container } = render(<AgentMarkdown text={fence("abc", "const a = <1>;")} />);

    expect(codeOf(container).children).toHaveLength(0);
    expect(codeOf(container).textContent).toBe("const a = <1>;");
    expect(screen.getByText("abc")).toBeInTheDocument();
  });

  it("后面追加内容时不重建已着色的节点", () => {
    const source = fence("js", "const a = 1;");
    const view = render(<AgentMarkdown text={source} />);
    const first = view.container.querySelector(".token.keyword");

    view.rerender(<AgentMarkdown text={`${source}

补充说明`} />);

    expect(view.container.querySelector(".token.keyword")).toBe(first);
  });

  it("代码里的标签只作为文本", () => {
    const { container } = render(<AgentMarkdown text={fence("html", "<img src=x onerror=alert(1)>")} />);

    expect(container.querySelector("img")).toBeNull();
    expect(codeOf(container).textContent).toBe("<img src=x onerror=alert(1)>");
  });
});

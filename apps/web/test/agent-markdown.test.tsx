// 「迪礼顾问」答案 Markdown 渲染组件（components/agent/agent-markdown.tsx）的渲染测试。
//
// 这里只断言「DOM 契约」：对话页依赖的 data-testid / 语义角色 / CSS 类名，以及安全约束
// （裸 HTML 只当文本、javascript: 不生成 href）。解析细节由 lib/agent-markdown.test.mjs 覆盖。
// 注意：globals: false，测试 API 必须显式 import（见 apps/web/vitest.config.mts）。
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { AgentMarkdown } from "../components/agent/agent-markdown";

describe("AgentMarkdown 渲染契约", () => {
  it("渲染标题 / 段落 / 无序列表，根节点带 testid", () => {
    render(<AgentMarkdown text={"# 订单总览\n\n找到 2 张订单。\n\n- SO-001\n- SO-002"} />);

    const root = screen.getByTestId("agent-markdown");
    expect(root).toBeVisible();
    expect(root).toHaveClass("agent-md");

    const heading = screen.getByRole("heading", { level: 1, name: "订单总览" });
    expect(heading).toHaveClass("agent-md-h", "agent-md-h1");

    expect(screen.getByText("找到 2 张订单。")).toHaveClass("agent-md-p");
    expect(screen.getByRole("list")).toHaveClass("agent-md-ul");
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("SO-001");
    expect(items[0]).toHaveClass("agent-md-li");
  });

  it("渲染有序列表并保留起始序号", () => {
    render(<AgentMarkdown text={"3. 第三\n4. 第四"} />);

    const list = screen.getByRole("list");
    expect(list).toHaveClass("agent-md-ol");
    expect(list).toHaveAttribute("start", "3");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("表格：存在 role=table、外层 testid 与对齐内联样式", () => {
    render(<AgentMarkdown text={"| 名称 | 数量 |\n| --- | ---: |\n| 螺丝 | 12 |"} />);

    const table = screen.getByRole("table");
    expect(table).toHaveClass("agent-md-table");
    expect(screen.getByTestId("agent-markdown-table")).toContainElement(table);
    expect(within(table).getByText("名称")).toBeInTheDocument();
    // 右对齐写在 th/td 的内联样式上（CSS 不写对齐 class）。
    expect(within(table).getByText("12")).toHaveStyle({ textAlign: "right" });
  });

  it("代码块：语言名与原始代码", () => {
    const { container } = render(<AgentMarkdown text={"```ts\nconst total = 1;\n```"} />);

    expect(container.querySelector(".agent-md-code")).not.toBeNull();
    expect(container.querySelector(".agent-md-code-head span")).toHaveTextContent("ts");
    expect(container.querySelector(".agent-md-pre code")).toHaveTextContent("const total = 1;");
    // 代码块内的内容不能被当成 Markdown 渲染成别的元素。
    expect(container.querySelector(".agent-md-pre code")?.children).toHaveLength(0);
  });

  it("无语言信息的代码块用「代码」兜底", () => {
    render(<AgentMarkdown text={"```\nplain\n```"} />);
    expect(screen.getByText("代码")).toBeInTheDocument();
  });

  it("裸 HTML 标签只作为文本，不产生 script 元素", () => {
    const { container } = render(<AgentMarkdown text={"<script>alert(1)</script>\n\n普通回答"} />);

    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByTestId("agent-markdown").textContent).toContain("<script>alert(1)</script>");
  });

  it("javascript: 链接降级为文本，不生成可点击元素", () => {
    render(<AgentMarkdown text={"[点我](javascript:alert(1))"} />);

    expect(screen.queryByRole("link")).toBeNull();
    const text = screen.getByTestId("agent-markdown").textContent ?? "";
    expect(text).toContain("点我");
    expect(text).toContain("javascript:alert(1)");
  });

  it("安全链接以新窗口打开且带 rel 保护", () => {
    render(<AgentMarkdown text={"[文档](https://example.com/a)"} />);

    const link = screen.getByRole("link", { name: "文档" });
    expect(link).toHaveAttribute("href", "https://example.com/a");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
    expect(link).toHaveClass("agent-md-link");
  });

  it("行内代码、引用与水平线使用约定类名", () => {
    const { container } = render(<AgentMarkdown text={"用 `npm run dev` 启动\n\n> 引用提示\n\n---"} />);

    expect(container.querySelector(".agent-md-code-inline")).toHaveTextContent("npm run dev");
    expect(container.querySelector(".agent-md-quote")).toHaveTextContent("引用提示");
    expect(container.querySelector(".agent-md-hr")).not.toBeNull();
  });

  it("空文本渲染空容器（根节点仍在）", () => {
    render(<AgentMarkdown text="" />);

    expect(screen.getByTestId("agent-markdown")).toBeEmptyDOMElement();
  });

  it("外部 className 与根类名共存", () => {
    render(<AgentMarkdown text="正文" className="agent-md-test" />);

    expect(screen.getByTestId("agent-markdown")).toHaveClass("agent-md", "agent-md-test");
  });
});

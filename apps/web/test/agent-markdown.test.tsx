// 「迪礼顾问」答案 Markdown 渲染组件（components/agent/agent-markdown.tsx）的渲染测试。
//
// 这里只断言「DOM 契约」：对话页依赖的 data-testid / 语义角色 / CSS 类名，以及安全约束
// （裸 HTML 只当文本、javascript: 不生成 href）。解析细节由 test/agent-markdown-parse.test.ts 覆盖。
// 注意：globals: false，测试 API 必须显式 import（见 apps/web/vitest.config.mts）。
import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

  it("流式光标放在列表最后一项内部", () => {
    render(<AgentMarkdown text={"- 甲\n- 乙"} caret />);

    expect(screen.getByTestId("agent-stream-caret").parentElement).toBe(screen.getAllByRole("listitem")[1]);
  });

  it("流式光标放在末尾标题内部", () => {
    render(<AgentMarkdown text="## 标题" caret />);

    expect(screen.getByTestId("agent-stream-caret").parentElement).toBe(screen.getByRole("heading", { level: 2 }));
  });

  it("流式光标放在引用的末段内部", () => {
    render(<AgentMarkdown text={"> 引用提示"} caret />);

    expect(screen.getByTestId("agent-stream-caret").closest("blockquote p")).not.toBeNull();
  });

  it("新段落到达后光标移到新的末段，旧段不再带光标", async () => {
    const view = render(<AgentMarkdown text="甲段" caret />);

    view.rerender(<AgentMarkdown text={["甲段", "", "乙段"].join(String.fromCharCode(10))} caret />);

    await waitFor(() => expect(screen.getByText("乙段")).toContainElement(screen.getByTestId("agent-stream-caret")));
    expect(screen.getAllByTestId("agent-stream-caret")).toHaveLength(1);
  });

  it("以表格结尾时不显示流式光标", () => {
    render(<AgentMarkdown text={"说明\n\n| 名称 |\n| --- |\n| 螺丝 |"} caret />);

    expect(screen.queryByTestId("agent-stream-caret")).toBeNull();
  });

  it("单换行显示为换行，任务列表带勾选符号", () => {
    const { container } = render(<AgentMarkdown text={"第一行\n第二行\n\n- [x] 已完成\n- [ ] 未完成"} />);

    expect(container.querySelector(".agent-md-p br")).not.toBeNull();
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("☑");
    expect(items[1]).toHaveTextContent("□");
  });

  it("图片与相对链接不产生元素，原文可见", () => {
    const { container } = render(<AgentMarkdown text={"![图](https://a.com/i.png) [本地](/orders)"} />);

    expect(container.querySelector("img, a")).toBeNull();
    expect(screen.getByTestId("agent-markdown").textContent).toContain("![图](https://a.com/i.png) [本地](/orders)");
  });

  it("流式半截输入渲染不抛异常", () => {
    for (const text of ["**半个", "[文本](https://example.com/a", "`行内", "```ts\nlet a = 1", "| 表头 |\n| --- |", "$$E=mc", "1. 一\n2."]) {
      expect(() => render(<AgentMarkdown text={text} caret />), text).not.toThrow();
    }
  });
});

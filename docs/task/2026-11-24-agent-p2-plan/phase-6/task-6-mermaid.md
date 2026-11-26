# 任务 6：图表

<task-brief>

## 1. 在哪里

- **阶段 6 长答案不卡**。
- **本任务推进 R-10**：`mermaid` 代码块在回答结束后画成图。
- **开工前提**：任务 5 已提交。**后续**：任务 7。

## 2. 要知道的

**先读**

- `C:\Users\USER\Desktop\chat-demo\src\services\markdown\mermaid.ts`：加载、排队与净化。
- `C:\Users\USER\Desktop\chat-demo\src\components\markdown\MermaidDiagram.tsx`：失败状态（流式绘制部分不搬）。
- `apps/web/features/agent-chat/markdown/code-block.tsx`：分流位置。

**已定**

- 加载器放同目录 `mermaid.ts`，组件放 `mermaid-diagram.tsx`，两者带许可头。
- **流式期间按普通代码块显示**，流结束后才加载库并绘制（本批决定，省掉流式重画）。
- `securityLevel: "strict"`、`startOnLoad: false`、`suppressErrorRendering: true`，主题 `default`。
- 绘制失败：显示代码块，上方一行「图表无法渲染」。图超宽横向滚动。
- 库只能动态加载，构建输出里 `/agent` 首屏 JS 不超过 350 kB。

**边界与接缝**

- 动上述两个新文件、代码块组件、新测试 `apps/web/test/agent-mermaid.test.tsx`。
  接缝：渲染 `AgentMarkdown`，`vi.mock` 加载器模块（jsdom 画不了图，真绘制由任务 7 验）。

**运行**

- `npm run test:components --workspace=@dilee/web -- test/agent-mermaid.test.tsx`，然后全套、类型检查、构建。

**可能卡住**

- `next build` 在引入 mermaid 后内存不足或解析失败：停下上报原文，不改构建配置。
- 首屏超过 350 kB：停下上报构建输出。

## 3. 步骤

1. 读上面三处，用一行复述任务。
2. 写用例 1、2，红后绿。
3. 写用例 3、4，红后绿。
4. 跑全套、类型检查、构建，记下 `/agent` 首屏 JS。
5. 提交：`feat(agent): 回答里的 mermaid 代码块画成图`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | 流式中（`caret` 真）的 mermaid 块 | 显示代码；绘制函数一次未调 | 渲染组件 |
| 2 | 同一内容 `caret` 假，绘制返回 `<svg data-testid="d">` | 出现该 svg | 渲染组件 |
| 3 | 绘制函数抛错 | 见「图表无法渲染」与原代码 | 渲染组件 |
| 4 | 代码含 `<img src=x>` 的节点标签，调加载器的净化 | 传给库的代码里是 `&lt;img src=x>` | 加载器 |

</task-brief>

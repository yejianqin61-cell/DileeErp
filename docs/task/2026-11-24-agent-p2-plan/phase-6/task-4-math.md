# 任务 4：公式

<task-brief>

## 1. 在哪里

- **阶段 6 长答案不卡**。
- **本任务推进 R-10**：公式节点排版显示，库按需加载。
- **开工前提**：任务 2 已提交。**后续**：任务 7。

## 2. 要知道的

**先读**

- `C:\Users\USER\Desktop\chat-demo\src\services\markdown\katex.ts`：按需加载。
- `C:\Users\USER\Desktop\chat-demo\src\components\markdown\MathFormula.tsx`：失败时退回什么。
- `apps/web/components/agent/agent-markdown.tsx`：公式节点现在显示原文的位置。

**已定**

- 加载器放 `features/agent-chat/markdown/katex.ts`，公式组件放同目录 `math.tsx`，两者带许可头。
- 连同样式与 `mhchem` 一起动态加载；`trust` 保持 `false`。
- 解析失败时保留上一次成功结果；从未成功过就显示原文。
- 块级公式超宽时横向滚动，样式写 CSS Module。

**边界与接缝**

- 动上述两个新文件、渲染组件、新测试 `apps/web/test/agent-math.test.tsx`。接缝：渲染 `AgentMarkdown`，用真 `katex`。

**运行**

- `npm run test:components --workspace=@dilee/web -- test/agent-math.test.tsx`，然后全套、类型检查、构建。

**可能卡住**

- Next 构建拒绝动态引入 KaTeX 样式：改在公式组件里静态引入样式；还不行就停下上报。
- 测试环境加载不了 `katex/contrib/mhchem`：停下上报，不要删掉它。

## 3. 步骤

1. 读上面三处，用一行复述任务。
2. 写用例 1、2，红后绿。
3. 写用例 3、4，红后绿。
4. 跑全套、类型检查、构建，记下 `/agent` 首屏 JS。
5. 提交：`feat(agent): 回答里的公式用 KaTeX 显示`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | `$$E=mc^2$$` | 出现 `.katex` 元素 | 渲染组件 |
| 2 | `$1,200 到 $1,500` | 没有 `.katex`，文字原样 | 渲染组件 |
| 3 | `$$\frac{1}{$$` | 不抛异常，能看到 `\frac{1}{` 原文 | 渲染组件 |
| 4 | `$$\href{javascript:alert(1)}{x}$$` | 没有任何带 `href` 的元素 | 渲染组件 |

</task-brief>

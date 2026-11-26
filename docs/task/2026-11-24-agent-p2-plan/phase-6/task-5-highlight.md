# 任务 5：代码高亮

<task-brief>

## 1. 在哪里

- **阶段 6 长答案不卡**。
- **本任务推进 R-10**：代码块按语言着色，语言包按需加载。
- **开工前提**：任务 2 已提交。**后续**：任务 6。

## 2. 要知道的

**先读**

- `C:\Users\USER\Desktop\chat-demo\src\services\markdown\highlight.ts`：语言表与依赖顺序。
- `C:\Users\USER\Desktop\chat-demo\src\components\markdown\CodeBlock.tsx`：加载与重渲染。
- `apps/web/test/agent-markdown.test.tsx` 代码块两条：DOM 不能变的部分。

**已定**

- 加载器放 `features/agent-chat/markdown/highlight.ts`，代码块组件放同目录 `code-block.tsx`，两者带许可头。
- 外层结构与类名不变：`.agent-md-code`、`.agent-md-code-head span`、`.agent-md-pre code`。
- 设 `Prism.manual = true`。不支持或还没加载的语言显示纯文本，且 `code` 内没有子元素。
- 不加复制按钮和主题切换（不在本阶段）；记号颜色写 CSS Module，只做浅色。

**边界与接缝**

- 动上述两个新文件、渲染组件、新测试 `apps/web/test/agent-code-block.test.tsx`。接缝：渲染 `AgentMarkdown`。

**运行**

- `npm run test:components --workspace=@dilee/web -- test/agent-code-block.test.tsx`，然后全套、类型检查、构建。

**可能卡住**

- 现有「`ts` 代码块内无子元素」断言与高亮冲突：它断言的是加载完成前的首帧；若首帧也出现子元素或测试变得不稳定，停下上报。
- 语言包在构建时报找不到全局 `Prism`：停下上报。

## 3. 步骤

1. 读上面三处，用一行复述任务。
2. 写用例 1、2，红后绿。
3. 写用例 3、4，红后绿。
4. 跑全套、类型检查、构建。
5. 提交：`feat(agent): 回答里的代码块按语言高亮`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | `js` 代码块 `const a = 1;` | `code` 内出现 `.token.keyword`，文字为 `const` | 渲染组件 |
| 2 | `python` 代码块，语言包异步加载 | 最终出现 `.token` 元素 | 渲染组件 |
| 3 | 语言 `abc` | `code` 无子元素，文字一字不差 | 渲染组件 |
| 4 | `html` 代码块内容 `<img src=x onerror=alert(1)>` | 页面没有 `img` 元素，原文可见 | 渲染组件 |

</task-brief>

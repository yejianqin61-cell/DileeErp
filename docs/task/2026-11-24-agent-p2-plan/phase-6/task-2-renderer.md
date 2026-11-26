# 任务 2：渲染器改读语法树

<task-brief>

## 1. 在哪里

- **阶段 6 长答案不卡**。
- **本任务推进 R-10**：页面改用新解析器，手写解析器删除，光标贴住正文末尾。
- **开工前提**：任务 1 已提交。**后续**：任务 3、4、5。

## 2. 要知道的

**先读**

- `apps/web/components/agent/agent-markdown.tsx`：DOM 契约与光标现在怎么挂。
- `apps/web/test/agent-markdown.test.tsx`：必须保持的类名、testid 与安全断言。
- `C:\Users\USER\Desktop\chat-demo\src\components\markdown\MarkdownAstRenderer.tsx`：每种节点怎么渲染。
- `apps/web/lib/table-width-coverage.test.mjs` 第 70–80 行：表格豁免按这个文件路径登记。

**已定**

- 组件名、props（`text`、`className`、`caret`）与全部 `.agent-md-*` 类名、testid 不变，表格仍在本文件渲染。
- 文本里的换行渲染为 `<br>`；裸 HTML 节点渲染为文本；任务列表项前加 `☑` 或 `□`。
- 本任务里公式节点显示原文，代码块按纯文本（后续任务接）。
- 光标：末块是段落、标题时放在其末尾；列表放最后一项末尾；引用放其内部末块；
  末块是代码、表格、公式、分隔线时**不显示**光标。
- 删除 `lib/agent-markdown.ts` 与 `lib/agent-markdown.test.mjs`。

**边界与接缝**

- 动渲染组件、上述两个删除文件、`agent-markdown.test.tsx`（只加用例）。接缝：渲染 `AgentMarkdown`。

**运行**

- `npm run test:components --workspace=@dilee/web -- test/agent-markdown.test.tsx`，然后全套、类型检查、构建。

**可能卡住**

- 现有 11 条渲染用例有一条要改断言才能绿：停下上报。
- 删掉的旧测试里有安全类断言没被任务 1 或现有渲染用例覆盖：先补到渲染用例里再删。

## 3. 步骤

1. 读上面四处，用一行复述任务。
2. 写用例 1–3，跑出红。
3. 改渲染器读 `toMdAst`，跑现有 11 条与新用例到绿。
4. 删旧解析器与旧测试，核对安全断言覆盖。
5. 跑全套、类型检查、构建。
6. 提交：`feat(agent): 回答正文改按语法树渲染，删除手写解析器`。

## 4. 用例

| # | 输入（`caret` 为真） | 期望 | 接缝 |
|---|---|---|---|
| 1 | `- 甲\n- 乙` | 光标在第二个 `li` 内部 | 渲染组件 |
| 2 | `## 标题` | 光标在 `h2` 内部 | 渲染组件 |
| 3 | 以一张表格结尾 | 页面上没有 `agent-stream-caret` | 渲染组件 |
| 4 | 现有 11 条 | 不改断言全部通过 | 渲染组件 |

</task-brief>

# 任务 3：流式节流

<task-brief>

## 1. 在哪里

- **阶段 6 长答案不卡**。
- **本任务推进 R-10**：流式期间按渲染耗时合并更新，结束时立刻显示完整内容。
- **开工前提**：任务 2 已提交。**后续**：任务 7。

## 2. 要知道的

**先读**

- `C:\Users\USER\Desktop\chat-demo\src\components\markdown\useThrottleMarkdownRender.ts`：算法全文。
- `apps/web/components/agent/agent-markdown.tsx`：文本从哪进解析。
- `apps/web/test/agent-chat-page.test.tsx`：哪些断言紧跟在流事件之后。

**已定**

- 新文件 `features/agent-chat/markdown/use-throttled-text.ts`，导出 `useThrottledText(text, enabled)`，带许可头。
- 间隔 = 上次渲染耗时 × 2，最长 2000 毫秒；等待期间到达的内容只取最新一份。
- `enabled` 为假时直接返回最新内容。组件里 `enabled` 取 `caret`（即流式中）。
- 复制按钮仍复制完整原文，不受节流影响。

**边界与接缝**

- 动新模块、渲染组件、新测试 `apps/web/test/use-throttled-text.test.tsx`。接缝：该 hook。

**运行**

- `npm run test:components --workspace=@dilee/web -- test/use-throttled-text.test.tsx`，然后全套与类型检查。

**可能卡住**

- 控制耗时：让 `performance.now` 读一个可控时钟，用一个渲染时把时钟拨快 100 的子组件模拟慢渲染。做不到就停下上报。
- 现有页面测试因更新变晚而红：只许把紧跟流事件的同步断言改成 `waitFor`，期望值不动，提交说明里逐条列出。

## 3. 步骤

1. 读上面三处，用一行复述任务。
2. 写用例 1、2，红后绿。
3. 写用例 3、4，红后绿。
4. 接进渲染组件，写用例 5。
5. 跑全套与类型检查。
6. 提交：`feat(agent): 流式回答按渲染耗时节流`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | `enabled` 假，内容从甲换成乙 | 立即是乙 | hook |
| 2 | 渲染耗时 100；连续给乙、丙 | 200 毫秒内仍是甲；满 200 毫秒显示丙，中间不出现乙 | hook |
| 3 | 等待中把 `enabled` 改为假 | 立即是最新内容 | hook |
| 4 | 渲染耗时 5000 | 等待不超过 2000 毫秒 | hook |
| 5 | `AgentMarkdown` 流式中换内容后立刻把 `caret` 置假 | 完整内容可见 | 渲染组件 |

</task-brief>

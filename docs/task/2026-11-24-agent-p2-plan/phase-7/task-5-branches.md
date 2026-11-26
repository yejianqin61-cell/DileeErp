# 任务 5：编辑重发与分支切换

<task-brief>

## 1. 在哪里

- **阶段 7 会话能像样地用**。
- **本任务推进 R-9**：改一条旧问题重发，原版本保留，可左右切换。
- **开工前提**：任务 2、4 已提交。**后续**：任务 6。

## 2. 要知道的

**先读**

- `C:\Users\USER\Desktop\chat-demo\src\services\chat\branches.ts`：路径、版本、切换三种算法。
- `apps/web/app/agent/page.tsx`：历史轮与活动轮怎么合成 `turns`。
- `apps/web/components/agent/agent-message.tsx`：用户消息与重试按钮。
- 任务 2 简报「已定」：`context_run_ids` 语义。

**已定**

- 纯函数放 `features/agent-chat/chat/branches.ts`（带许可头），输入是按时间排的轮次号与 `{ parents, selected }`。
- 没记录父节点的轮次，父节点是时间上的前一轮；父节点当前不可见时同样按此处理。默认选最新的子版本。
- 每次提问都记父节点，并带 `context_run_ids` = 该父节点为止的当前路径（超过 200 项只带最后 200）。新对话首问传空数组。
- 编辑：用户消息上「编辑」按钮，就地文本框，发送或取消。新轮次与被改轮次同父。
- 版本数大于 1 时显示 `‹ 序号/总数 ›`。运行中与对账未完成时，编辑与切换禁用。
- 重试仍是在当前路径末尾追加（现状不变）。关系存键 `branches:<userId>:<sessionId>`。reducer 不改。

**边界与接缝**

- 动新模块、顾问页、消息与对话区组件。接缝：纯函数（`test/agent-branches.test.ts`）与页面测试 `agent-branches-page.test.tsx`。

**运行**

- `npm run test:unit --workspace=@dilee/web`，`npm run typecheck`，`npm run build --workspace=@dilee/web`

**可能卡住**

- 活动轮次不在选中路径上时界面状态无法自洽，或必须改 reducer：停下上报。
- 现有页面测试断言了提问请求体的完整形状：允许加上 `context_run_ids` 期望，其他不改。

## 3. 步骤

1. 读上面四处，用一行复述任务。
2. 用例 1–3（纯函数），红后绿。
3. 用例 4、5（页面编辑与切换），红后绿。
4. 用例 6，红后绿。
5. 跑全套、类型检查、构建，提交：`feat(agent): 编辑重发产生分支并可切换`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | 轮次甲乙丙，无记录 | 路径甲乙丙，各 1 个版本 | 纯函数 |
| 2 | 加丁，父为甲（即改乙） | 路径甲丁；丁处版本 `2/2` | 纯函数 |
| 3 | 接上切到版本 1 | 路径甲乙丙 | 纯函数 |
| 4 | 两轮会话里改第二问发送 | 请求带 `context_run_ids: [第一轮]`；见新问题与 `2/2` | 页面 |
| 5 | 点「‹」后重挂页面 | 仍显示旧版本 | 页面 |
| 6 | 在旧版本上直接追问 | `context_run_ids` 是旧路径两轮 | 页面 |

</task-brief>

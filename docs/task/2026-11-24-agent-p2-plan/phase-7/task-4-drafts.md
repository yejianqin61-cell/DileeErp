# 任务 4：草稿按会话保存

<task-brief>

## 1. 在哪里

- **阶段 7 会话能像样地用**。
- **本任务推进 R-9**：每个会话各记各的草稿，刷新不丢。
- **开工前提**：无。**后续**：任务 5。

## 2. 要知道的

**先读**

- `apps/web/lib/agent-cache.ts` 与 `agent-cache-idb.ts`：存储接口与档位判断。
- `apps/web/app/agent/page.tsx`：`input` 在哪些地方被改写。
- `apps/web/components/layout/app-shell.tsx`：退出时清什么。
- `apps/web/test/app-shell.test.tsx` 的「退出登录」两条。

**已定**

- 新模块 `features/agent-chat/chat/drafts.ts`。键 `drafts:<userId>:<会话号或 new>`。
- 档位 `operational` 写 `CacheStore`；`full` 写 `sessionStorage`。没有用户信息时不持久化。
- 提交成功清当前草稿；提交失败保留。空串即删键。存储抛错一律忽略。
- 切会话、新建对话、挂载时载入对应草稿；载入迟到时不覆盖用户已打的字。
- `CacheStore` 加 `keys()`。退出登录改为删除除 `branches:` 开头以外的全部键，并清 `sessionStorage` 里的草稿键。

**边界与接缝**

- 动新模块、两个缓存模块、顾问页、`app-shell.tsx`。接缝：新模块函数与页面测试 `agent-drafts-page.test.tsx`。

**运行**

- `npm run test:unit --workspace=@dilee/web`，`npm run typecheck`

**可能卡住**

- 退出两条旧用例断言 `clear` 被调：改为断言非 `branches:` 键被删，提交说明写明。其他旧断言要改就停下上报。

## 3. 步骤

1. 读上面四处，用一行复述任务。
2. 用例 1、2（模块），红后绿。
3. 用例 3–5（页面），红后绿。
4. 用例 6（退出），红后绿。
5. 跑全套与类型检查，提交：`feat(agent): 顾问草稿按会话保存`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | `operational` 存「甲」到会话一，读会话一与二 | 「甲」与空串 | 模块 |
| 2 | `full` 存「乙」 | `CacheStore` 里没有；`sessionStorage` 读得到 | 模块 |
| 3 | 打字「半句」后卸载重挂 | 输入框是「半句」 | 页面 |
| 4 | 会话一打「甲」，切到二，再切回 | 二是空的，一仍是「甲」 | 页面 |
| 5 | 发送成功；另一次发送返回 429 | 前者重挂后空；后者草稿仍在 | 页面 |
| 6 | 存储里有会话缓存、草稿、`branches:u:s`，点退出 | 只剩 `branches:u:s` | AppShell |

</task-brief>

# 任务 1：后端会话标题与软删除

<task-brief>

## 1. 在哪里

- **阶段 7 会话能像样地用**。
- **本任务推进 R-9**：服务端能改会话名、能软删除。页面此时还不用。
- **开工前提**：无。**后续**：任务 3。

## 2. 要知道的

**先读**

- `apps/api/src/modules/business-query-agent/business-query-agent.controller.ts`：现有会话接口与归属校验。
- 同目录 `state-manager.ts`：`listSessions`、`findSession`、`hasActiveRun`。
- `apps/api/test/unit/agent-gap-tables-migration.test.cjs`：迁移守卫测试怎么写。
- `apps/api/test/helpers/agent-fake-prisma.cjs`：假库缺哪些 `agentSession` 方法。

**已定**

- `AgentSession` 加 `title String? @db.VarChar(100)`、`deletedAt DateTime? @map("deleted_at")`；迁移目录 `20261126090000_agent_session_title`。
- `PATCH sessions/:id`，体 `{ title }`，去首尾空白后 1–100 字，返回 `{ session_id, title }`。
- `DELETE sessions/:id`：写 `deletedAt`，返回 `{ session_id }`；该会话有活动轮次时 409 `RUN_IN_PROGRESS`。
- 他人、不存在、已删除一律 404 `AGENT_SESSION_NOT_FOUND`。改名与删除不改 `updatedAt`。
- 列表排除已删除，多返回 `title`（可为 `null`）。普通档位下，含 `full` 轮次的会话 `title` 返回 `null`。
- 按轮次号访问的 `runs/:id/*` 不改。

**边界与接缝**

- 动 API 模块、schema、迁移、假库。接缝：控制器方法（用假库构造的 `AgentStateManager`）。

**运行**

- `npx prisma generate --schema apps/api/prisma/schema.prisma`，`npm run test:unit:api`，`npm run typecheck`

**可能卡住**

- `prisma migrate diff` 生成的语句与手写迁移不一致：以生成的为准；离线比对做不了就停下上报。
- 状态账号对 `agent_sessions` 的 `UPDATE` 权限：发布探针已要求，若发现并没有，停下上报。

## 3. 步骤

1. 读上面四处，用一行复述任务。
2. 迁移守卫测试（用例 1），改 schema、写迁移。
3. 用例 2–4，红后绿。
4. 用例 5、6，红后绿。
5. 跑 API 全套与类型检查，提交：`feat(agent): 顾问会话支持改名与软删除`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | 读迁移 SQL | 给 `agent_sessions` 加 `title`、`deleted_at` 两列，均可空；无新表、无外键 | 迁移文本 |
| 2 | 本人改名 `"  十月订单  "`；另试空白串与 101 字 | 存成 `十月订单`；后两者被校验拒绝 | 控制器与 DTO |
| 3 | 他人改名、删除 | 都是 404，库里不变 | 控制器 |
| 4 | 删除后查列表、读快照、提问 | 列表没有它；后两者 404 | 控制器 |
| 5 | 有活动轮次时删除 | 409，`deletedAt` 仍空 | 控制器 |
| 6 | 改过名的会话含 full 轮次，分别按两个档位列表 | full 见标题；operational 为 `null` | 控制器 |

</task-brief>

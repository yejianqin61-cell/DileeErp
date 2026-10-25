# T-1 Agent 自有表与迁移

## 1. 位置

- 阶段：Phase 1 一条安全的订单问答链路，目标是登录员工能在查询页问一张订单并收到答案。
- 本任务把 R-7 持久状态与幂等的存储底座落进数据库：三张 agent 自有表和约束。
- 前置：无。后续 T-2 状态管理器、T-6 证据测试都建在它上面。

## 2. 开发者须知

**先读**

- `apps/api/prisma/schema.prisma` — User/Session 的命名惯例（snake_case map、UUID、时间列）。
- `apps/api/prisma/migrations/20260915180000_bank_balances_and_transfers/migration.sql` — 迁移 SQL 的手写风格。
- `apps/api/test/unit/bank-balance-migration.test.cjs` — 本机无库时迁移靠静态断言守卫的惯例。
- `apps/api/test/helpers/migration-guards.cjs` — 推演「活着的唯一约束」的现成工具。
- `docs/design/business-query-agent-v0-module-design-2026-10-25.md`「API 权限与数据表」— 三张表的字段与约束清单。

**定案（不得重开）**

- 只建 `agent_sessions`、`agent_runs`、`agent_run_events` 三张表（模块设计「数据表」清单）。
- `agent_runs` 的部分唯一索引：`(user_id) WHERE state IN ('planning','querying','responding')`。
- `(session_id, client_message_id)` 唯一、`(run_id, seq)` 唯一（模块设计原文）。
- 表不与业务表建外键；agent 表是自有容器，业务表只读。

**边界**

- 只动 `schema.prisma`、新增一个迁移目录。不写任何 TS 代码，不建模块目录。
- 迁移目录名以 `20261025` 开头、14 位时间戳，排在现有迁移之后。

**运行**

- `node --test apps/api/test/unit/agent-tables-migration.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**未知**

- `agent_run_events.payload` 用 Jsonb；`agent_runs.usage` 可空 Jsonb。若 prisma generate 与现有引擎版本冲突，停下来说明。

## 3. 工作流

1. 读上面 5 处，然后一句话复述本任务。
2. 在 `schema.prisma` 末尾追加三个 model，字段按模块设计清单，`@@map` 成 snake_case。
3. 手写迁移 `migration.sql`：三张 CREATE TABLE、三个索引、部分唯一索引。
4. 跑 `prisma generate`，确认 client 生成成功。
5. 写 `test/unit/agent-tables-migration.test.cjs`（先红后绿）：断言迁移原文含部分唯一索引 WHERE 子句、两个唯一索引；用 `liveUniqueGuards` 推演唯一约束。
6. 跑本任务两条命令。
7. 提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | 读迁移 SQL 原文 | 含 `CREATE UNIQUE INDEX` 且带 `WHERE state IN ('planning','querying','responding')` | 迁移文件 |
| 2 | 读迁移 SQL 原文 | `(session_id, client_message_id)` 与 `(run_id, seq)` 两个唯一索引存在 | 迁移文件 |
| 3 | `liveUniqueGuards(全部迁移 SQL)` | agent_runs 上有两个唯一约束，列与预期一致 | `liveUniqueGuards` |
| 4 | 读 schema.prisma | 三张表列与模块设计清单一致，含 `access_level`、`error_code`、`question` | schema 文本 |
| 5 | 迁移目录排序 | 新目录 14 位时间戳，排在所有现有迁移之后 | 目录名 |

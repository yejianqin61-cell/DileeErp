<task-brief>

## 1. Where this task sits

- **阶段 4 缺口变成候选**，目标是同一差异只攒一条候选、达门槛交一次建单器。
- **本任务交付 R-6 的存储**：两张表、一条迁移、静态守卫，脱敏脚本一并清空它们。
- **Starts after**：无。**Waits on it**：任务 2。

## 2. What the developer needs to know

**Read first**

- `apps/api/prisma/schema.prisma` 的 `AgentSession` 至 `AgentRunEvent` — agent 表的命名与映射写法。
- `apps/api/prisma/migrations/20261025100000_business_query_agent_tables/migration.sql` — 迁移 SQL 风格与索引命名。
- `apps/api/test/unit/agent-tables-migration.test.cjs` 与 `apps/api/test/helpers/migration-guards.cjs` — 静态守卫怎么写。
- `scripts/snapshot/desensitize.sql` 第 5 节 — agent 数据怎样清空。

**Settled**

- 模型 `AgentGapCandidate`（表 `agent_gap_candidates`）：`id` uuid、`nearestOperation` VarChar(60)、`missing` VarChar(20)、`status` VarChar(20) 默认 `accumulating`、`dispatchedAt` 可空、`createdAt`、`updatedAt`；唯一键 `(nearest_operation, missing)`。
- 模型 `AgentGapReport`（表 `agent_gap_reports`）：`id`、`candidateId` uuid、`sessionId` uuid、`runId` uuid、`missingDetail` VarChar(200)、`missingParam` VarChar(20) 可空、`neededFields` Json、`unverifiedFields` Json、`createdAt`；唯一键 `(candidate_id, run_id)`。不建外键（README）。
- 迁移目录 `20261125090000_agent_gap_candidates`；列名一律 snake_case 映射。

**Edges and seam**

- 改 schema、新迁移、`desensitize.sql`（并入 `TRUNCATE`）。不改应用代码。
- Seam：迁移 SQL 与 schema 的静态断言，不连库。

**Run**

- `npx prisma validate --schema apps/api/prisma/schema.prisma`，再 `npx prisma generate --schema apps/api/prisma/schema.prisma`
- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-gap-tables-migration.test.cjs apps/api/test/unit/agent-tables-migration.test.cjs`

**Unknowns**

- 本工作树的 `node_modules`（根、`apps/api`、`apps/web`）是指向主目录的**目录联接**，直接 `prisma generate` 会改到主目录。先确认三处是联接（PowerShell `(Get-Item node_modules).LinkType`），逐个用 `cmd /c rmdir <路径>`（**不带 `/s`**，只删联接）移除，再在本工作树 `npm ci`。任何一处不是联接、或删除命令要求带 `/s`，停下报告。
- `prisma validate` 因缺少环境变量失败：给一个本地占位 `DATABASE_URL`，不要读或复制任何 `.env`。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 按 Unknowns 第一条把依赖换成本工作树自己的安装。
3. 写用例 1–3，红，再写 schema 与迁移。
4. 写用例 4，红，再改 `desensitize.sql`。
5. 跑 `prisma validate`、`generate`、Run 的测试与 `npm run typecheck`，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 迁移 SQL | 有两张表的 `CREATE TABLE`；不含 `FOREIGN KEY`；不含问题原文列（无 `question`） | 迁移 SQL |
| 2 | 迁移里的唯一约束 | 恰为 `agent_gap_candidates:nearest_operation+missing` 与 `agent_gap_reports:candidate_id+run_id`（用 `liveUniqueGuards`） | 迁移 SQL |
| 3 | schema | 两个模型的 `@@map` 为上述表名；候选 `status` 默认 `accumulating` | schema |
| 4 | `desensitize.sql` | `TRUNCATE` 语句里含两个新表名 | 脚本文本 |

</task-brief>

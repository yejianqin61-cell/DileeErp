<task-brief>

## 1. Where this task sits

- **阶段 4 缺口变成候选**，目标是同一差异只攒一条候选、达门槛交一次建单器。
- **本任务交付 R-6 的归并与计数**：一次放行的声明落成「候选一条 + 声明记录一条」，返回不同会话数。
- **Starts after**：任务 1。**Waits on it**：任务 3。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/tools/gap-check.ts` — `AcceptedGap` 的字段。
- `apps/api/src/modules/business-query-agent/state-manager.ts` — 怎样把最小的 Prisma delegate 类型传进服务。
- `apps/api/test/helpers/agent-fake-prisma.cjs` — 内存假库的写法，照此扩两张表。

**Settled**

- 只用四个 delegate 方法：`createMany`（带 `skipDuplicates: true`）、`findFirst`、`findMany`、`updateMany`。先插候选（跳过重复）再按键查出，保证并发时不报唯一冲突。
- 声明记录按 `(candidateId, runId)` 去重；计数为该候选全部记录的**不同 `sessionId` 数**（README）。
- 候选与记录里不写问题原文，也不接收它。

**Edges and seam**

- 新文件 `apps/api/src/modules/business-query-agent/gap-candidates.ts`：`GapCandidateService`，构造参数是客户端；`record({ sessionId, runId, gap })` 返回 `{ candidateId, sessionCount }`。
- 扩 `agent-fake-prisma.cjs`（只加两个 delegate，支持 `skipDuplicates`）。Seam：`record`。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-gap-candidates.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 假库的 `skipDuplicates` 必须按任务 1 的两个唯一键判重；若发现需要它支持别的 Prisma 语义，停下报告。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 扩假库，写用例 1，红，再实现 `record`。
3. 写用例 2、3（同键与异键），红，再补。
4. 写用例 4（同会话与同一轮），红，再补。
5. 写用例 5（字段落库内容），红，再补；跑 Run 的命令，提交。

## 4. The test cases

基准声明 G：`nearest_operation:"list_low_stock_materials", missing:"group_by", missing_detail:"按仓库分组", needed_fields:[], unverified_fields:["仓库"]`。

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 会话 s1、轮 r1 报 G | 1 条候选（`status` 为 `accumulating`）、1 条记录；返回 `sessionCount` 1 | `record` |
| 2 | 再以 s2、r2 报同键但 `missing_detail:"分仓库看"` | 仍 1 条候选、2 条记录、`sessionCount` 2（来源：计划 R-6「短语不同也一样」） | `record` |
| 3 | 以 s2、r3 报 `missing:"filter"` | 候选变 2 条 | `record` |
| 4 | s1 再用 r4 报 G；然后 r4 重复报一次 | 第一次后记录增 1、`sessionCount` 仍 2；第二次记录数不变 | `record` |
| 5 | 带 `missing_param:"status"` 的一次记录 | 记录行的键恰含 `candidateId,sessionId,runId,missingDetail,missingParam,neededFields,unverifiedFields`（外加库生成列），没有 `question` | `record` |

</task-brief>

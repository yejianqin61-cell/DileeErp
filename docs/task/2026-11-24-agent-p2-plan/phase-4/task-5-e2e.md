<task-brief>

## 1. Where this task sits

- **阶段 4 缺口变成候选**，目标是同一差异只攒一条候选、达门槛交一次建单器。
- **本任务是本批验收**：真编排器加真候选服务加假库，走完「三个会话问同一缺口，建单一次」。
- **Starts after**：任务 4。**Waits on it**：P3 桥接。

## 2. What the developer needs to know

**Read first**

- `docs/task/2026-11-24-agent-p2-plan/plan.md` R-6 — 验收条件原文。
- `apps/api/test/unit/agent-gap-e2e.test.cjs` — 阶段 3 端到端的搭法。
- `apps/api/test/helpers/agent-fake-prisma.cjs` — `createPlanningRun` 固定用同一个 `clientMessageId`，多会话要各建各的会话。

**Settled**

- 只新增测试；任一用例要改 `src` 才能过，停下报告是哪个任务漏了。
- 同一个假库实例承载多轮 run；每轮 run 结束后再建下一轮（单用户同时只能有一个活动 run）。

**Edges and seam**

- 新文件 `apps/api/test/unit/agent-gap-candidate-e2e.test.cjs`。
- Seam：`AgentOrchestrator.run` 与假库里的两张候选表。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-gap-candidate-e2e.test.cjs`
- `npm run typecheck`；`npm run test:unit`

**Unknowns**

- `createPlanningRun` 无法在同一假库上为不同会话建 run：在测试文件里自己调 `state.createSession` 与 `state.createRun`，不改辅助文件的既有行为。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1，跑。
3. 写用例 2、3，跑。
4. 跑 `npm run typecheck` 与 `npm run test:unit`，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 三个会话各一轮，问法不同（「各仓库库存多少」「分仓库看库存」「按仓库汇总原料」），都声明 `list_low_stock_materials/group_by` | 1 条候选、3 条记录；建单器在第三轮后恰调 1 次；工单内容 `JSON.stringify` 后不含三句问法中任何一句 | `run` |
| 2 | 同一会话连续三轮声明同键 | 1 条候选、3 条记录；建单器 0 次 | `run` |
| 3 | 三个会话中两个报 `group_by`、一个报 `filter` | 2 条候选；建单器 0 次 | `run` |

</task-brief>

<task-brief>

## 1. Where this task sits

- **阶段 4 缺口变成候选**，目标是同一差异只攒一条候选、达门槛交一次建单器。
- **本任务把候选服务接进运行时**：放行的缺口声明进入候选路径，模块装配默认建单器。
- **Starts after**：任务 3。**Waits on it**：任务 5。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/agent-orchestrator.ts` — `declareGap` 与 `AgentOrchestratorOptions`。
- `apps/api/src/modules/business-query-agent/business-query-agent.module.ts` — 工厂注入与 `AGENT_STATE_CLIENT`。
- `apps/api/test/unit/agent-gap-orchestrator.test.cjs` — 编排器缺口用例的搭法。

**Settled**

- 编排器只依赖接口 `{ record(input): Promise<unknown> }`，经 `AgentOrchestratorOptions.gapCandidates` 注入；不注入时行为与现在完全一样。
- 调用点在 `declareGap` 里写 `gap_declared` 的同一分支（同轮同键只调一次）；入参 `{ sessionId: run.sessionId, runId: run.id, gap }`。
- `record` 抛错：吞掉并记一行 `logger.warn`（只含 runId 与错误信息），模型仍收到「已记录」，问答照常。
- 模块用 `AGENT_STATE_CLIENT` 构造 `GapCandidateService`，建单器用 `LoggingGapTicketBuilder`。

**Edges and seam**

- 改编排器与模块文件。不改控制器、传输层、前端。
- Seam：`AgentOrchestrator.run` 配假候选服务。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-gap-wiring.test.cjs apps/api/test/unit/agent-gap-orchestrator.test.cjs apps/api/test/unit/agent-orchestrator.test.cjs`
- `npm run typecheck --workspace=@dilee/api`；`npm run test:unit`

**Unknowns**

- 若有既有测试断言模块的 provider 清单或编排器构造参数而变红：停下报告是哪一条。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1，红，再加选项与调用。
3. 写用例 2、3，红，再补。
4. 写用例 4（抛错不影响问答），红，再补。
5. 装配模块，跑 Run 的全部命令，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 脚本放行一个声明 | 假服务收到恰一次，`sessionId` 与 `runId` 等于该轮，`gap.nearest_operation` 正确；参数里不含问题原文 | `run` |
| 2 | 同批两个同键声明；另一次一个被驳回的声明 | 前者调 1 次；后者调 0 次 | `run` |
| 3 | 不注入候选服务 | run `completed`，仍写 `gap_declared` | `run` |
| 4 | 假服务 `record` 抛错 | run `completed`；该声明的 tool 消息仍是 `{"result":"已记录"}` | `run` |

</task-brief>

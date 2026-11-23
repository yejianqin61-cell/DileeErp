<task-brief>

## 1. Where this task sits

- **Phase P1 止血**的收尾：把盲区三补上，并出 P0→P1 的对比结论。
- **本任务交付 R-6 model_steps 采集 + P1 基线报告**。
- **Starts after**：任务 1–5。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/agent-orchestrator.ts` — `modelSteps` 已在本地计数（`planOnce` 里 `++modelSteps`），但从未写进 `usage`。
- `apps/api/src/modules/business-query-agent/stream-transport.ts` — `completed` 事件的 `payload.usage` 就是它下发的字段。
- `scripts/agent/golden-runner.mjs` — `applyEvent` 收集 `usage.tool_calls`，这里加一项即可。
- `docs/review/agent-golden-baseline-2026-11-22.md` — P0 的数，报告要做成对比。

**Settled**

- `model_steps` 与 `tool_calls` 一起进 `usage`，随 `completed` 事件下发。它是成品字段，不是猜的。
- 报告新增一节「P0 → P1 对比」：通过率、工具调用失败率、失败码分布、模型步数中位数。
- 不许把「通过率还是 100%」当成改进的证明；唯一的改进指标是工具调用失败率下降。

**Edges and seam**

- `agent-orchestrator.ts` 的 `usage` 对象；`golden-runner.mjs` 的 `applyEvent`；`golden-report.mjs` 加对比节。
- 不改 SSE 信封结构。

**Run**

- `npm run test:agent-golden:unit`
- `npm run test:unit:api`
- `npm run test:agent-golden`（真机全量，两组账号都要）

**Unknowns**

- 若 `model_steps` 落进 `usage` 会让既有 `agent-orchestrator.test.cjs` 的深比较红，那是预期内的：改断言，不放宽实现。

## 3. The workflow

1. 读四个文件，一句话复述本任务。
2. 先写失败测试：`completed` 事件的 `usage.model_steps` 是整数且 >= 1。
3. 在 `agent-orchestrator.ts` 的 completed `usage` 里加 `model_steps: modelSteps`。
4. `golden-runner.mjs` 采集 `modelSteps`；`golden-report.mjs` 加对比节 `## 9. P0 → P1 对比`。
5. 跑真机全量（默认账号 + full 账号），落 P1 报告。
6. 更新设计文档 §9 的阶段表与 `docs/log/2026-11-23.md`，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 一次完成的 run | `usage.model_steps` >= 1 且为整数 | `agent-orchestrator` 事件 |
| 2 | 零工具调用的 run | `usage.model_steps` = 1（只规划一次就回答） | 同上 |
| 3 | runner 收到 completed 事件 | `outcome.modelSteps` 是整数 | `applyEvent()` |
| 4 | 报告 meta 带 P0 数 | 渲染出 `## 9. P0 → P1 对比`，含两列 | `renderMarkdown()` |
| 5 | meta 不带 P0 数 | 不出第 9 节，不编造对比 | `renderMarkdown()` |

</task-brief>
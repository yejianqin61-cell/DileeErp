## 1. Where this task sits

- **阶段 4 查不到也说得清楚**，目标是把三条用户真实会遇到的情况固定成回归。
- **本任务推进 R-4 单号检索归一与 R-6 部分答案**：三条用例，各自独立期望。
- **Starts after**：任务 6、任务 7、任务 8。**Waits on it**：无。

## 2. What the developer needs to know

**Read first**

- `agent-orchestrator.test.cjs` 的 `driveWith` — 多步问答的测试底座。
- `agent-orchestrator.ts` 的失败预算与空结果注入 — 被断言的两处行为。
- `tools/order-query-tools.ts` 的归一函数 — 被复用的口径。

**Settled**

- 三条用例都走编排器入口，不新造接缝。
- 「空结果」与「失败降级」是两种不同路径，断言分开写。
- 期望值来自计划与审计报告，不由实现反推。

**Edges and seam**

- 只加测试。
- Seam：`agent-orchestrator.test.cjs`。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-orchestrator.test.cjs`

**Unknowns**

- 若三条用例里有一条拿不到独立期望，说明前序任务的行为还没定死，回去补。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 写用例 1（小写单号）并确认转绿。
3. 写用例 2（多余空格）并确认转绿。
4. 写用例 3（空结果）并确认转绿。
5. 跑 API 全量单测。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 用户小写单号提问 | 检索命中并完成回答 | 编排器 |
| 2 | 用户单号里多一个空格 | 检索命中 | 编排器 |
| 3 | 单号完全不存在 | 回答上下文含检索词与 0 条，run 仍完成 | 编排器 |

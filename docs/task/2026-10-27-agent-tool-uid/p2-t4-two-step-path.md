## 1. Where this task sits

- **阶段 2 一条只靠 uid 走通的链路**，目标是一次问答从头到尾不再让模型抄单号。
- **本任务推进 R-2 根查询改用 uid 派生句柄**：把检索与根查询两步串成一条完整路径。
- **Starts after**：任务 7 根查询从句柄还原主键。**Waits on it**：任务 9 伪造与跨轮句柄被拒。

## 2. What the developer needs to know

**Read first**

- `agent-orchestrator.test.cjs:66-90` — 假 provider 的多步计划写法。
- `agent-orchestrator.test.cjs:94-130` — 建 planning run 与驱动编排器的辅助函数。
- `agent-orchestrator.ts:126-155` — 多步循环里工具消息如何回喂模型。

**Settled**

- 第一步检索、第二步根查询，两次调用共享同一份本轮句柄表。
- 第二步的入参只有 `order_ref`。
- 结束时回答里仍带来源，且来源指向真实单号。

**Edges and seam**

- 只加测试，不改实现；若实现要改，退回任务 7。
- Seam：`agent-orchestrator.test.cjs` 现有编排器入口。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-orchestrator.test.cjs`

**Unknowns**

- 若假 provider 的两次 plan 拿不到同一份状态，说明句柄表放错了层级，停下来问。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 写用例 1：两步跑通，先红。
3. 用例 2 到 4 补齐。
4. 跑测试与 typecheck。
5. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 第一步检索、第二步根查询带句柄 | run 终态 `completed` | 编排器 |
| 2 | 第二步的入参 | 只有 `order_ref`，无单号 | 模拟执行器 |
| 3 | 执行器收到的根查询参数 | `order_no` 是检索返回的真实单号 | 模拟执行器 |
| 4 | 最终回答的来源 | 指向真实单号 | 状态事件 |

## 1. Where this task sits

- **阶段 2 一条只靠 uid 走通的链路**，目标是第二个工具不再出现单号原文。
- **本任务推进 R-2 根查询改用 uid 派生句柄**：检索结果给每行发一个句柄，并登记到本轮。
- **Starts after**：任务 5 模型层出现 order_ref。**Waits on it**：任务 7 根查询从句柄还原主键。

## 2. What the developer needs to know

**Read first**

- `agent-orchestrator.ts:109-155` — `searchedOrderNos` 的维护位置与工具消息的推送方式。
- `agent-orchestrator.ts:211-220` — `rememberSearchedOrderNos` 现在的做法。
- `query-fact.ts` — `QueryFact` 的固定形状，句柄加在哪一层不破形状。

**Settled**

- 句柄格式 `o_1`、`o_2`，按本轮命中顺序递增，只在本轮有效。
- 句柄加在检索事实的每一行上，模型只从工具消息里看到它。
- 检索事实仍带 `order_no`，用于人和回放阅读。

**Edges and seam**

- 只碰编排器的检索后处理，不碰执行器投影。
- Seam：`agent-orchestrator.test.cjs` 现有编排器入口。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-orchestrator.test.cjs`

**Unknowns**

- 若检索分页导致同一单在两页出现，句柄是否要稳定复用。先按出现顺序发，遇到重复再说。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 先写用例 1，跑红。
3. 在检索事实入表时登记句柄并回写每一行。
4. 用例 2 到 4 红后转绿。
5. 跑测试与 typecheck。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 检索返回两行 | 工具消息里两行分别带 `o_1`、`o_2` | 编排器 |
| 2 | 检索返回一行 | 句柄为 `o_1` | 编排器 |
| 3 | 第二次检索 | 句柄从已发数量继续，不重号 | 编排器 |
| 4 | 非检索操作 | 不发放句柄 | 编排器 |

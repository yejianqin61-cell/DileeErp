## 1. Where this task sits

- **阶段 2 一条只靠 uid 走通的链路**，目标是根查询不再依赖模型复述单号。
- **本任务推进 R-2 根查询改用 uid 派生句柄**：把句柄还原成内部主键，替掉单号透传。
- **Starts after**：任务 6 检索结果带句柄并登记。**Waits on it**：任务 8 两步串起来跑通。

## 2. What the developer needs to know

**Read first**

- `agent-orchestrator.ts:193-209` — 现在的搜索守卫，要改成句柄校验。
- `agent-orchestrator.ts:126-150` — 调用进入执行前的那一段循环。
- `agent-tool-executor.ts:41-51` — 解析器拒绝额外字段，句柄必须在这里之前被剥掉。

**Settled**

- 句柄优先；没有句柄且本轮只有一张单时，自动用那张单。
- 多张单又没有句柄时拒绝，并说明要带句柄。
- `order_ref` 不进执行器参数，执行器只看见 `order_no`。

**Edges and seam**

- 只碰编排器的调用预处理与守卫，不碰执行器。
- Seam：`agent-orchestrator.test.cjs` 现有编排器入口。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-orchestrator.test.cjs`

**Unknowns**

- 兼容期模型可能同时传单号与句柄。两者都在时以句柄为准，若与单号冲突，停下来问。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 先写用例 1，跑红。
3. 在调用预处理里做句柄还原与参数剥离。
4. 用例 2 到 4 红后转绿。
5. 跑测试与 typecheck。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 根查询只带 `order_ref: "o_1"` | 执行器收到 `order_no: "SO-001"` | 编排器 |
| 2 | 根查询不带任何单号，本轮只有一张单 | 自动用那张单 | 编排器 |
| 3 | 执行器收到的参数 | 不含 `order_ref` 键 | 模拟执行器 |
| 4 | 本轮两张单、根查询不带句柄 | 拒绝且不触达数据库 | 模拟执行器 |

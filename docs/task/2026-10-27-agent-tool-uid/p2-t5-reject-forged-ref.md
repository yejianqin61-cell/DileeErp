## 1. Where this task sits

- **阶段 2 一条只靠 uid 走通的链路**，目标是句柄只能由本轮发放，别人猜不到。
- **本任务推进 R-2 根查询改用 uid 派生句柄**：关闭伪造与跨轮复用两条越权路径。
- **Starts after**：任务 8 两步串起来跑通。**Waits on it**：无。

## 2. What the developer needs to know

**Read first**

- `agent-orchestrator.ts:33-41` — 可回传失败码集合，新码要决定放不放进这里。
- `agent-orchestrator.ts:144-149` — 失败预算如何计数。
- `agent-orchestrator.test.cjs:125-161` — 现有守卫测试的断言方式。

**Settled**

- 未发放的句柄一律拒绝，不触达数据库。
- 拒绝属于可回传失败，模型可以改口重试，不直接终结整轮。
- 句柄表只在本轮内存在，下一轮从空表开始。

**Edges and seam**

- 只碰编排器与其单测。
- Seam：`agent-orchestrator.test.cjs` 现有编排器入口。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-orchestrator.test.cjs`

**Unknowns**

- 若拒绝码被计入失败预算，三次猜错就整轮失败。是否把它排除在预算外，需要产品口径，停下来问。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 先写用例 1，跑红。
3. 加未发放句柄的拒绝分支。
4. 用例 2 到 4 红后转绿。
5. 跑测试与 typecheck。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 根查询带 `o_9`（未发放） | 拒绝，执行器零调用 | 模拟执行器 |
| 2 | 上一轮的句柄 `o_1` 在新一轮使用 | 拒绝 | 编排器 |
| 3 | 拒绝后的模型重试带正确句柄 | 该次执行成功 | 编排器 |
| 4 | 拒绝事件 | 只含操作名与错误码，不含猜测值 | 状态事件 |

## 1. Where this task sits

- **阶段 3 任何单号都能进**，目标是端到端证明「采购单号进得去」。
- **本任务推进 R-1 采购单号与生产单号入口**：用采购单号走完检索到根查询的整条路。
- **Starts after**：任务 1、任务 2。**Waits on it**：无。

## 2. What the developer needs to know

**Read first**

- `agent-orchestrator.test.cjs` 的 `driveWith` 与 `scriptedProvider` — 多步问答的测试底座。
- `agent-orchestrator.ts` 的 `registerSearchResults` — 句柄绑的是所属销售单号。
- `tools/tool-executor.ts` 的特例分支 — 检索类 operation 不走根验证。

**Settled**

- 检索行的 `sales_order_no` 才发句柄，单据号本身不发。
- 第二步根查询用采购工具的 operation，句柄还原成销售单号。
- 这是单元级端到端；真实数据对照留到部署后。

**Edges and seam**

- 只加测试，不改实现；要改实现就退回任务 1/2。
- Seam：`agent-orchestrator.test.cjs` 现有编排器入口。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-orchestrator.test.cjs`

**Unknowns**

- 没有生产库可连，真实单号无法验证。若必须真库，停下来等环境。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 先写用例 1：采购单号检索 → 句柄 → 采购根查询成功。
3. 补用例 2 到 4。
4. 跑测试与 typecheck。
5. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 问采购单，检索命中采购单行 | 句柄指向所属销售单号 | 编排器 |
| 2 | 第二步用该句柄查采购单 | 执行器收到销售单号 | 模拟执行器 |
| 3 | 最终回答 | 来源含采购单号 | 状态事件 |
| 4 | 采购单号的检索结果为空 | 不发放任何句柄 | 编排器 |

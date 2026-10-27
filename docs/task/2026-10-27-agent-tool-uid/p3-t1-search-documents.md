## 1. Where this task sits

- **阶段 3 任何单号都能进**，目标是拿采购单号提问能答出来。
- **本任务推进 R-1 采购单号与生产单号入口**：新增一个按号检索任意单据的 operation。
- **Starts after**：阶段 2 全部。**Waits on it**：任务 2 解析顺序、任务 3 文案、任务 4 目录审计。

## 2. What the developer needs to know

**Read first**

- `tools/tool-registry.ts:34-72` — 31 项能力怎么登记，operation 名是稳定标识。
- `tools/tool-executor.ts:50-91` — `search_orders` 特例分支与根查询分发的分工。
- `tools/order-query-tools.ts:40-56` — 现有检索的投影形状与分页。

**Settled**

- 新 operation 名 `search_documents`，挂在 `order_query` 下，其余 31 项不动。
- 每行必须同时给出「单据类型、单据号、所属销售单号」，后者才是后续根查询的根。
- 只读、不超过 20 行、不接受额外字段。

**Edges and seam**

- 触碰注册表、执行器分发、检索实现；不碰根验证与前端。
- Seam：新建领域测试文件，并在目录审计的覆盖映射里登记。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-document-search.test.cjs`

**Unknowns**

- 采购单与生产单的模型字段名若与销售单不同，先按最窄的字段集投影；拿不准就停下来问。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 先写用例 1，跑红。
3. 注册能力、加执行器分支、实现检索与投影。
4. 用例 2 到 4 红后转绿。
5. 跑该测试与 typecheck。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 销售单号命中 | 一行，类型 `sales_order`，带所属销售单号 | 执行器 |
| 2 | 采购单号 `PO-2026…` 命中 | 一行，类型 `purchase_order`，所属销售单号有值 | 执行器 |
| 3 | 生产单号 `MO-2026…` 命中 | 一行，类型 `production_order` | 执行器 |
| 4 | 不存在的号 | 空数组，不报错 | 执行器 |
| 5 | 请求带额外字段 | 422 `AGENT_TOOL_ARGUMENT_INVALID` | 执行器 |

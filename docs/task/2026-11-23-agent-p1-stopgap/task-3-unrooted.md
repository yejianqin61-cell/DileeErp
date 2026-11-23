<task-brief>

## 1. Where this task sits

- **Phase P1 止血**，目标是工具调用失败率归零。
- **本任务交付 R-3 无根聚合入口 + 根缺失时的引导文案**：让「哪些物料库存不足」「本月到货超期」不必挂在某张单上。
- **Starts after**：任务 1（归一）。**Waits on it**：任务 6。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/tools/rooted-operations.ts` — 31 个 operation 全在这一张表里，每个都要 `order_no`。
- `apps/api/src/modules/business-query-agent/agent-orchestrator.ts` 的 `resolveRootCall` — 没有根时抛 `ORDER_SEARCH_REQUIRED`，文案是「请先调用 search_orders 取得句柄」。
- `docs/review/agent-golden-baseline-analysis-2026-11-22.md` D-2 — 证据：run `0b42af37` seq 3–7，`get_raw_material_balance` 被拒后模型退化成检索词「库存不足」。

**Settled**

- 新增一张 `UNROOTED_OPERATIONS` 表，与 `ROOTED_OPERATIONS` 并列；执行器先查这张表，命中就不做根验证。
- 两个新 operation：`list_low_stock_materials`（挂在 `warehouse_query`）、`list_overdue_arrivals`（挂在 `procurement_query`）。
- **不改 `ORDER_SEARCH_REQUIRED` 这个码**（既有测试依赖它），只改文案：说明该操作需要单据根，并点名当前可用的无根替代。
- 无根操作同样不许返回财务字段。

**Edges and seam**

- 新增 `tools/unrooted-operations.ts`；`tool-executor.ts` 加一条分支；`agent-orchestrator.ts` 改 `resolveRootCall` 的一条文案；registry 登记两个 operation。

**Run**

- `node --test apps/api/test/unit/agent-tool-unrooted.test.cjs`（本任务新建）
- `npm run test:unit:api`

**Unknowns**

- 「库存不足」的阈值：库里没有安全库存字段，只能用「净变动 < 0」或「余额 <= 0」。选哪个口径要在返回里写清（`basis` 字段），不能让模型自己解释。若发现两种口径在同一批数据上结论相反，停下来报告。

## 3. The workflow

1. 读三个文件，一句话复述本任务。
2. 先写失败测试：`list_low_stock_materials` 不带 `order_no` 能执行；带 `order_no` 被拒（未知字段）。
3. 实现 `listLowStockMaterials`：按物料聚合 `inventoryFact.quantityDelta`，筛出净额 <= 0 的，返回 `{material_code, material_name, net_quantity, basis}`。
4. 实现 `listOverdueArrivals`：`purchaseOrder.expectedDate < today` 且未全部到货，返回单号、供应商、预期日、逾期天数。
5. 补测试：伪造 `order_ref` 传给无根操作 → 参数错误（它不认句柄）。
6. 注册两个 operation，执行器加分支，改 `resolveRootCall` 文案，跑 `test:unit:api`，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `{}` 调 `list_low_stock_materials` | 不抛根缺失，返回行集 | `execute()` |
| 2 | `{order_no:"X"}` 调同一操作 | 抛参数错误，消息含 `order_no` | `execute()` |
| 3 | 种子数据 | 结果里每个 `net_quantity` <= 0 | `listLowStockMaterials()` |
| 4 | `{}` 调 `list_overdue_arrivals` | 不抛根缺失 | `execute()` |
| 5 | 种子数据（预期日已过） | 返回行含 `overdue_days` >= 1 | `listOverdueArrivals()` |
| 6 | 无根调用一个有根 operation | `ORDER_SEARCH_REQUIRED`，文案提到 `list_documents` 或无根替代 | `resolveRootCall()` |

</task-brief>
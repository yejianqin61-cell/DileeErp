## 1. Where this task sits

- **阶段 5 把关系键从单号换成外键**，目标是 schema 与库不许再漂移。
- **本任务推进 R-8 27 张表补外键并回填**：加一条守卫，新增带单号的表必须登记去向。
- **Starts after**：任务 2 采购链路补外键与回填。**Waits on it**：任务 4 其余链路。

## 2. What the developer needs to know

**Read first**

- `apps/api/test/unit/sales-order-order-no-rename.test.cjs` — 现有的「38 张表要么登记要么豁免」守卫写法。
- `apps/api/test/unit/agent-tables-migration.test.cjs` — 迁移与 schema 三边同步的断言风格。
- `prisma/schema.prisma` 的 `AuditEvent` 与 `SalesOrder` — 两个豁免的理由。

**Settled**

- 守卫判据：带 `@map("order_no")` 的模型，要么有 `sales_order_id`，要么在豁免清单。
- 豁免只有两条：审计事件流（历史）与销售单本身（源头）。
- 守卫扫 schema 源码，不连库，本机无库也能跑。

**Edges and seam**

- 只加测试，不改实现。
- Seam：新建 `apps/api/test/unit/order-no-fk-guard.test.cjs`。

**Run**

- `node --test apps/api/test/unit/order-no-fk-guard.test.cjs`

**Unknowns**

- 若某张表确实不该有外键（例如纯历史快照），先停下来问，不要自行往豁免里塞。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 写用例 1（当前 27 张里有一张没列 → 应红）。
3. 让守卫通过：这一步由任务 2/4 的迁移完成，守卫本身只读 schema。
4. 补用例 3、4（豁免正确、集合稳定）。
5. 跑测试与 typecheck。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | schema 全量 | 带 order_no 的模型全部有 sales_order_id 或在豁免里 | 静态守卫 |
| 2 | 豁免清单 | 只有 AuditEvent 与 SalesOrder | 静态守卫 |
| 3 | 迁移文件 | 每张补列的表都有回填 UPDATE | 静态守卫 |
| 4 | 人为删掉一个字段（模拟漂移） | 守卫报错 | 静态守卫 |

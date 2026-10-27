## 1. Where this task sits

- **阶段 5 把关系键从单号换成外键**，目标是采购链路先走通。
- **本任务推进 R-8 27 张表补外键并回填**：给采购链路的表加可空外键并回填历史行。
- **Starts after**：任务 1 逐表盘点。**Waits on it**：任务 3 一致性守卫、任务 5 改号一致性。

## 2. What the developer needs to know

**Read first**

- `prisma/migrations/20261025100000_business_query_agent_tables/migration.sql` — 仓库里迁移文件的写法与注释口径。
- `prisma/schema.prisma` 中 `PurchaseOrder` 已有的 `salesOrderId` 关系 — 已建过的外键长什么样。
- `sales-order-order-no.ts:83-122` — 采购链路的表在登记表里的位置。

**Settled**

- 列可空：`sales_order_id UUID NULL`，只回填不改写入点。
- 回填只认未软删的销售单：`WHERE s.deleted_at IS NULL`，对不上任何单的行留 NULL。
- 外键 `ON DELETE RESTRICT`：外键列指向的销售单不允许被删；销售单删除本来就有下游守卫。

**Edges and seam**

- 触碰 schema 与一个新迁移；不碰任何 service。
- Seam：新建库上的迁移验证 + 静态守卫测试。

**Run**

- `docker exec … psql` 建空库后 `npx prisma migrate deploy`，再查 `information_schema` 确认列与外键。

**Unknowns**

- 若历史数据里有 `order_no` 指向已软删的销售单，那行会保持 NULL；这是预期，不要用「非空」当验收。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 在 schema 给采购链路模型加可空列。
3. 写迁移：加列、回填、建外键、建索引。
4. 在干净库上 `migrate deploy`，确认列与外键存在。
5. 跑 typecheck 与既有单测。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 干净库跑全部迁移 | 采购链路表都有 `sales_order_id` | 迁移验证 |
| 2 | 同上 | 外键指向 `sales_orders(id)` | 迁移验证 |
| 3 | 有历史行但销售单已软删 | 该行外键为 NULL，迁移不失败 | 迁移验证 |
| 4 | 迁移文件 SQL 扫描 | 每张表都有 ALTER 与 UPDATE 两条 | 静态断言 |

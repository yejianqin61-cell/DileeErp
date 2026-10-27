## 1. Where this task sits

- **阶段 5 把关系键从单号换成外键**，目标是把采购试点的做法铺到其余链路。
- **本任务推进 R-8 27 张表补外键并回填**：生产、库存、成品、财务四段一次补齐。
- **Starts after**：任务 3 一致性守卫。**Waits on it**：任务 5 改号一致性。

## 2. What the developer needs to know

**Read first**

- `docs/task/2026-10-27-order-fk/t2-procurement-fk.md` — 采购链路的迁移写法，本任务照抄结构。
- `prisma/schema.prisma` 中 `ProductionOrder` 已有的 `salesOrderId` — 生产链路的参照点。
- `apps/api/src/modules/sales/sales-order-order-no.ts:83-122` — 剩下四段各自包含哪些表。

**Settled**

- 结构与采购链路完全一致：可空列 + 回填 + 外键 + 索引。
- 现金流分录与应付台账的 `order_no` 是手填的，回填只认能对上的行。
- 两段迁移分开提交，便于单独回滚。

**Edges and seam**

- 触碰 schema 与两个新迁移；仍然不碰写入点。
- Seam：任务 3 的静态守卫 + 干净库迁移验证。

**Run**

- `npx prisma migrate deploy`（干净库）后查 `information_schema.columns`。

**Unknowns**

- 若某张表的 `order_no` 存在明显脏值（长度超限、非订单号），先停下来列出样本再决定。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. schema 补齐剩余模型的可空列。
3. 写生产+库存的迁移，干净库验证。
4. 写成品+财务的迁移，干净库验证。
5. 跑守卫测试与全量单测。
6. 提交（两条：迁移一条、schema 一条）。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 干净库跑迁移 | 剩余 22 张表都有列与外键 | 迁移验证 |
| 2 | 守卫测试 | 全量通过，豁免仍只有两条 | 静态守卫 |
| 3 | 手填单号对不上任何销售单 | 该行 NULL，不阻塞迁移 | 迁移验证 |
| 4 | 全量 API 单测 | 全绿 | 单元测试 |

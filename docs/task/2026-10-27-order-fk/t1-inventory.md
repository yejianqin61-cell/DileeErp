## 1. Where this task sits

- **阶段 5 把关系键从单号换成外键**，目标是改号不再依赖 38 张表的文本联动。
- **本任务推进 R-8 27 张表补外键并回填**：先把「哪 27 张、谁在写」盘清楚，后面的迁移才有清单可依。
- **Starts after**：无。**Waits on it**：任务 2、任务 4。

## 2. What the developer needs to know

**Read first**

- `prisma/schema.prisma` — 哪些模型带 `@map("order_no")`、哪些已经有 `sales_order_id`。
- `apps/api/src/modules/sales/sales-order-order-no.ts:83-122` — 现有 38 项改号登记表，等于「谁冗余了单号」的既有答案。
- `docs/design/sales-order-no-rename-2026-09-30.md` — 为什么当初按文本联动，判据是「现在指向谁」还是「当时发生了什么」。

**Settled**

- 范围是 27 张：带 `order_no` 且没有 `sales_order_id` 的表，去掉 `AuditEvent` 与 `SalesOrder`。
- 只记录清单，不改任何代码。
- 每行标注所属链路（采购 / 生产 / 库存 / 成品 / 财务）与写入点文件。

**Edges and seam**

- 产出是一份设计文档，不进 Prisma。
- Seam：无（纯盘点）。

**Run**

- 无需跑测试；清单可用 `grep @map("order_no")` 复核。

**Unknowns**

- 两张手工单据（现金流与应付台账）的 `order_no` 是人手填的，可能对不上任何销售单；先标注，回填时留空。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 从 schema 生成「带 order_no 的模型」与「已有 sales_order_id 的模型」两个集合。
3. 差集去掉两个豁免，得到 27 张。
4. 逐张标链路与写入点（写路径文件用 grep 定位）。
5. 写成设计文档，附复核用命令。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | schema 全量扫描 | 带 order_no 的模型 40 个 | 盘点脚本 |
| 2 | 已有 sales_order_id 的模型 | 15 个 | 盘点脚本 |
| 3 | 差集去豁免 | 正好 27 张 | 盘点脚本 |
| 4 | 清单里出现 AuditEvent 或 SalesOrder | 判定失败 | 盘点脚本 |

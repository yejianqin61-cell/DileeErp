# T01 货号字段：数据层迁移

> 设计依据：[reorder-item-no-and-summary-2026-09-26.md](../../design/reorder-item-no-and-summary-2026-09-26.md) §二
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

无。本任务之后：[T02](./02-sales-order-item-no-api.md) 依赖它。

## 目标

在 `sales_orders` 上加「货号」与「返单来源单号」两列 + 一个索引，**不碰任何下游表、不建外键、不回填历史数据**。

## 关联决策

- 设计文档 §二：货号是**订单级**字段；货号**不冗余到下游**；不建主数据表。
- 给 `T07` 的聚合查询准备索引：货号清单要按 `(item_no, order_date)` 取数。

## 范围与非范围

**范围**

- `apps/api/prisma/schema.prisma` 的 `model SalesOrder` 加两个字段与一个索引。
- 新迁移目录 `apps/api/prisma/migrations/20260927090000_sales_order_item_no/migration.sql`。
- 迁移守卫单测。

**非范围**

- 不加 `NOT NULL`、不加唯一约束、不加外键、不加 `DEFAULT`。
- 不改 `SalesOrderVersion`（货号通过 §T02 进快照 JSON，不新建表）。
- 不动采购/生产/QC 任何表（设计文档 §二已定：下游只冗余 `order_no`）。

## 交付物

| 文件 | 改动 |
| --- | --- |
| `apps/api/prisma/schema.prisma` | `SalesOrder` 加 `itemNo String? @map("item_no") @db.VarChar(100)`、`reorderFromOrderNo String? @map("reorder_from_order_no") @db.VarChar(100)`、`@@index([itemNo, orderDate])` |
| `apps/api/prisma/migrations/20260927090000_sales_order_item_no/migration.sql` | 两条 `ALTER TABLE sales_orders ADD COLUMN` + 一条 `CREATE INDEX` |
| `apps/api/test/unit/sales-order-item-no-migration.test.cjs` | 迁移守卫（新建） |

字段命名口径（**三个任务共用，写错就要返工**）：

| 层 | 名字 |
| --- | --- |
| 数据库列 | `sales_orders.item_no`、`sales_orders.reorder_from_order_no` |
| 索引名 | `sales_orders_item_no_order_date_idx` |
| Prisma 字段 | `itemNo`、`reorderFromOrderNo` |
| 请求键（snake_case） | `item_no`、`reorder_from_order_no` |

## 实施要点

```sql
ALTER TABLE "sales_orders" ADD COLUMN "item_no" VARCHAR(100);
ALTER TABLE "sales_orders" ADD COLUMN "reorder_from_order_no" VARCHAR(100);
CREATE INDEX "sales_orders_item_no_order_date_idx" ON "sales_orders"("item_no", "order_date");
```

- 迁移目录名里的时间戳要在**已有迁移之后**（当前最新是 `20260926120000_finance_slips`），
  目录名与 SQL 都要与 `prisma migrate` 的既有风格一致（双引号标识符、语句末尾分号）。
- schema 里的字段位置放在结算口径那组之后、`status` 之前，并配一段注释说明
  「订单级一个货号；不冗余到下游；不建主数据表」——下一个人读 schema 时不必回翻设计文档。
- **为什么允许 `item_no` 为空**：历史单没有货号，加 `NOT NULL` 会让迁移在真实库上直接失败，
  也会让「确认」这类既有动作变成破坏性变更。兜底在 `T12` 的补录待办。
- **为什么不加唯一约束**：返单的本质就是**同一个货号多张销售单**，唯一约束会把功能本身禁掉。

## 验收与验证

| # | 验收点 | 怎么验 |
| --- | --- | --- |
| 1 | 只加两列一索引，不改数据、不加约束 | `sales-order-item-no-migration.test.cjs` 解析 SQL 断言 |
| 2 | 两列可空、无默认值 | 同上（断言 `ADD COLUMN` 上没有 `NOT NULL` / `DEFAULT`） |
| 3 | 索引是 `(item_no, order_date)` 复合索引，**不是唯一索引** | 同上 |
| 4 | schema 与 SQL 一致 | 同上（读 `schema.prisma` 断言字段与 `@@index` 存在） |
| 5 | 迁移目录顺序正确（时间戳在既有迁移之后） | 同上 |
| 6 | 类型检查通过 | `npm run typecheck` |
| 7 | 全量 API 单测通过 | `npm run test:unit:api` |

迁移守卫的写法照抄现成样本：`apps/api/test/unit/purchase-order-item-supplier-nullable-migration.test.cjs`
（5 条同形状的断言）。**不要**在这里发明新写法。

## 决策记录

- **不加自引用外键**给 `reorder_from_order_no`：订单号本身唯一，而返单链不该因为老单被删/改而断裂
  （外键会强制引用存在，而删除老单是真实会发生的运维动作）。存文本快照，展示时按订单号去查。
- **不建 `product_articles` 主数据表**：见批次 README「批次不做的事」。

## 完成记录

**2026-09-26 完成**（提交 `3a1b7ba`）。

- 交付物：`schema.prisma` 两列 + `@@index([itemNo, orderDate])`；迁移 `20260927090000_sales_order_item_no/migration.sql`；
  守卫测试 `apps/api/test/unit/sales-order-item-no-migration.test.cjs`（7 条）。
- 守卫比计划多钉了一条**「货号不冗余到下游」**（断言 SQL 里不出现 `purchase_orders` / `production_orders` /
  `finished_goods_qc_records` 等表名）——设计里的取舍必须有测试看着，否则下次"顺手补一列"没人拦得住。
- 验证：`npm run typecheck` 通过；`npm run db:generate` 成功；迁移守卫 7/7；`npm run test:unit:api` **2032/2032**。
- **未验证**：迁移**没有在真实 PostgreSQL 上执行过**（本机无库）；`prisma migrate deploy` 由部署侧验收。
- 过程中的坑：`schema.prisma` 当时还有另一个工作流未提交的 `FinanceSlip` 模型，
  直接 `git add` 那个文件会把别人的模型（连同它未跟踪的迁移）卷进本次提交 —— 改为只暂存自己的两个 hunk
  （`git apply --cached`）。后来对方先提交了 `b8f4a5f`，本任务才按普通路径提交。

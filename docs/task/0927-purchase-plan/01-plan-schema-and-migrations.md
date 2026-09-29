# T01 计划数据层：`purchase_plans`/`purchase_plan_items` schema + 两条迁移 + 迁移守卫

> 设计依据：[purchase-plan-and-supplier-collapse-2026-09-27.md](../../design/purchase-plan-and-supplier-collapse-2026-09-27.md) §3、§7.1–7.3
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

无。本任务之后：[T02](./02-plan-api-skeleton.md)、[T06](./06-bom-item-order-status-plan.md) 依赖它。

## 目标

把「一份 BOM 一份采购计划」这件事**在数据库层面成立**：两张新表 + 索引 + 外键 +
**部分唯一索引**（不是全量唯一）；另加一条把历史草稿归并成计划的搬迁迁移（DDL 与 DML 分成两个目录）。

## 口径与决策（依据设计文档）

- **口径 1**：粒度不同才有这两张表（采购单=一个供应商×一个币种；计划=一份 BOM）。
  「一份 BOM 一份计划」交给数据库保证，而不是靠应用层查一遍再插。
- **口径 8**：历史草稿（`status='draft'`）迁移时**按 `bom_id` 归并成计划**，供应商/单价/交期原样保留，
  原草稿行软删 —— 草稿里是采购员逐行填过的数据，丢掉是真实劳动损失。
- **§3.2**：`purchase_plan_items.purchase_order_item_id` 是「这一行已下单」的**唯一表示**，
  `@unique` 保证一条采购明细只能被一行计划认领。
- **§3.3**：为什么**不能**在 schema 写 `@unique`/`@@unique([bomId])`。
- **§3.4**：外键动作表（写错会让 `migrate diff` 长期报漂移）。
- **§3.5**：快照口径与 `Prisma.DbNull`。
- **§7.1–7.3**：两个目录、幂等、基线漂移。

## 范围与非范围

**范围**

- `apps/api/prisma/schema.prisma`：新增 `model PurchasePlan` / `model PurchasePlanItem`。
- 迁移 `20260928090000_purchase_plan`（两张表 + 索引 + 外键 + 部分唯一索引）。
- 迁移 `20260928100000_purchase_plan_backfill_drafts`（历史草稿归并，幂等）。
- 迁移守卫单测 `apps/api/test/unit/purchase-plan-migration.test.cjs`。

**非范围**

- 不写计划 API（[T02](./02-plan-api-skeleton.md)）；不改采购单任何行为（[T05](./05-purchase-order-revert-and-readonly.md)）。
- **不给** `purchase_plans` 加手工状态字段（状态是派生的，§4.1）。
- **不给**计划行加币种列（口径 10）。

## 交付物

| 文件 | 关键改动 |
| --- | --- |
| `apps/api/prisma/schema.prisma` | `PurchasePlan` + `PurchasePlanItem`；`PurchasePlan` 只声明 `@@index([bomId])`（**不写 `@unique`**）；可选关系写 `?` 并配注释说明"部分唯一索引在迁移里" |
| `apps/api/prisma/migrations/20260928090000_purchase_plan/migration.sql` | `CREATE TABLE` ×2 + `CREATE INDEX` + `CREATE UNIQUE INDEX … WHERE "deleted_at" IS NULL` + `ADD CONSTRAINT` 外键 |
| `apps/api/prisma/migrations/20260928100000_purchase_plan_backfill_drafts/migration.sql` | 幂等的 `INSERT … SELECT … WHERE NOT EXISTS` + `UPDATE purchase_orders SET deleted_at` |
| `apps/api/test/unit/purchase-plan-migration.test.cjs` | 迁移守卫（新建，照抄 `bom-item-supplier-migration.test.cjs` 的形状） |

### 两张表的列（照 §3.1，逐列落地）

```
purchase_plans
  id / plan_no(PP-YYYYMMDD-XXXXXXXX, unique) / order_no / sales_order_id
  bom_id / bom_version / bom_snapshot
  extension_data / 审计六列

purchase_plan_items
  id / plan_id / sequence
  material_id / material_snapshot / unit_id / unit_snapshot
  bom_item_id(可空) / supplier_id(可空) / supplier_snapshot(可空)
  model / quantity / unit_price / expected_date
  purchase_order_item_id(可空, unique)
  extension_data / 审计六列
```

命名口径（**后续任务共用，写错就要返工**）：

| 层 | 名字 |
| --- | --- |
| 表 | `purchase_plans` / `purchase_plan_items` |
| Prisma 模型 | `PurchasePlan` / `PurchasePlanItem` |
| 计划编号 | `PP-{YYYYMMDD}-{UUID前8位大写}`（与采购单 `PO-` 同格式，只改前缀，见 `purchase-orders.service.ts:255`） |
| 部分唯一索引 | `purchase_plans_bom_id_active_key`（照抄 `boms_sales_order_id_active_key`） |
| 可选关系 | `supplier` / `bomItem` / `purchaseOrderItem` 三个 `?` |

## 实施要点

### 1. 部分唯一索引（本任务最容易写错的一处）

```sql
CREATE INDEX "purchase_plans_bom_id_idx" ON "purchase_plans"("bom_id");
CREATE UNIQUE INDEX "purchase_plans_bom_id_active_key" ON "purchase_plans"("bom_id") WHERE "deleted_at" IS NULL;
```

- **照抄范本**：迁移 `20260826100000_unique_editable_bom`（`boms_sales_order_id_active_key`）——
  BOM 与销售单是 1:1，用的是同一套做法，照它写。
- **为什么不能写 `@unique`**：`purchase_plans.deleted_at` 是软删列；全量唯一索引会让
  「软删一份计划之后再也建不出第二份」，而这正是口径 15 要允许的事。
- schema 里**只**声明 `@@index([bomId])`，并加一段注释解释"部分唯一索引在迁移里、schema 里写不出来"
  —— 否则下一个人会"顺手补上 `@unique`"。

### 2. 外键动作（§3.4 的表，逐行抄）

| 列 | 关系 | 必须写成 |
| --- | --- | --- |
| `purchase_plan_items.supplier_id` | `Supplier?` | `ON DELETE SET NULL ON UPDATE CASCADE` |
| `purchase_plan_items.bom_item_id` | `BomItem?` | `ON DELETE SET NULL ON UPDATE CASCADE` |
| `purchase_plan_items.purchase_order_item_id` | `PurchaseOrderItem?` | `ON DELETE SET NULL ON UPDATE CASCADE` |
| `purchase_plan_items.material_id` / `unit_id` | 必填 | `ON DELETE RESTRICT ON UPDATE CASCADE` |
| `purchase_plans.bom_id` / `sales_order_id` | 必填 | `ON DELETE RESTRICT ON UPDATE CASCADE` |

「供应商地址/联系人」**不落列**（它是选中供应商的只读派生）——加了列就有两个真源（口径 4）。

### 3. 快照列

- 计划行 `material_snapshot` / `unit_snapshot` / `supplier_snapshot`，与采购明细**同一形状**。
- 计划头 `bom_snapshot`（BOM 被软删后计划仍能说明"这是哪一版 BOM 的计划"）。
- 「没有值」写 `Prisma.DbNull`（SQL NULL），**不是** `Prisma.JsonNull`（§3.5）。本任务只在迁移里落 NULL，
  写入侧的这条规则由 [T02](./02-plan-api-skeleton.md)/[T03](./03-plan-save-and-delete.md) 遵守。

### 4. 搬迁迁移（口径 8）—— 幂等是硬要求

- 已有未删计划（同 `bom_id`）→ **复用**，不再建（`WHERE NOT EXISTS`）。
- 同一 BOM 多个草稿（按供应商拆过）→ **合并进同一份计划**，行**不去重**：同一 BOM 行出现两行是允许的，
  正好表达"两家比价"。
- 没有 `bom_id` 的草稿 → **不动**（原样留在 `purchase_orders`，只是不进列表）。
- 供应商/单价/交期**原样搬**，不重算、不清零。
- 迁移前 `pg_dump` 备份（写进迁移文件头的注释）。**本机无 PostgreSQL，这段 SQL 无法在本地验证**。

### 5. 目录顺序与风格

- 时间戳要在**已有迁移之后**（当前最新是 `20260927180000_bom_item_supplier`）；
  SQL 与既有迁移同风格（双引号标识符、语句末尾分号、文件头写依据与取舍）。
- DDL 与 DML **两个目录**：搬迁比建表风险高，分开才能单独审、单独跳过（§7.1）。

## 验收与验证

| # | 验收点 | 怎么验 |
| --- | --- | --- |
| 1 | 建表迁移只建两张表 + 索引 + 外键 + 部分唯一索引 | `purchase-plan-migration.test.cjs` 解析 SQL 断言 |
| 2 | 部分唯一索引带 `WHERE "deleted_at" IS NULL`，**不是**全量唯一索引 | 同上（断言 SQL 里 `CREATE UNIQUE INDEX … WHERE`，且没有 `UNIQUE` 出现在 `bom_id` 的列定义上） |
| 3 | schema 里**只有** `@@index([bomId])`，没有 `@unique` / `@@unique([bomId])` | 同上（读 `schema.prisma` 断言） |
| 4 | 三个可选外键是 `SET NULL`、必填外键是 `RESTRICT` | 同上（逐条断言 `ADD CONSTRAINT … ON DELETE …`） |
| 5 | 两张表都有审计六列与软删列 | 同上 |
| 6 | 搬迁迁移幂等：含 `WHERE NOT EXISTS`（或 `ON CONFLICT DO NOTHING`），**没有** `DELETE`/`DROP` | 同上 |
| 7 | 搬迁迁移只 `UPDATE … deleted_at`（软删原草稿），不 `DELETE FROM purchase_orders` | 同上 |
| 8 | 两个迁移目录存在且**顺序**为 DDL 在前、DML 在后 | 同上（读目录名排序） |
| 9 | Prisma Client 能生成 | `npm run db:generate --workspace=@dilee/api` |
| 10 | 类型检查通过 | `npm run typecheck` |
| 11 | 全量 API 单测通过（迁移守卫在内） | `npm run test:unit:api` |
| 12 | 迁移在真实库上的行为 | `prisma migrate deploy` —— **本机无库，环境阻断**；部署时影子库干跑并核对行数/金额 |

迁移守卫照抄现成样本 `apps/api/test/unit/bom-item-supplier-migration.test.cjs`：
它钉住了「索引必须声明在 schema 里，否则 `migrate diff` 会想把它 DROP 掉」「外键必须 SET NULL」
「只碰该碰的表」「目录顺序」——本任务再加**部分唯一索引**与**幂等**两条。**不要**发明新写法。

## 决策记录

- **DML 单独一个迁移目录**：搬迁比建表风险高，分开之后出事能单独定位（并允许在某环境跳过）。
- **不把 `bom_id` 的唯一性放进 schema**：见「实施要点 1」，代价是 `migrate diff` 基线小幅增加（§7.3），
  这是**预期内**的成本，判定标准写在 README 的「迁移与部署红线」里。
- **搬迁不去重**：允许同一 BOM 行在计划里出现两行，表达"两家比价"；去重会删掉采购员真实填过的行。

## 完成记录

| 项 | 内容 |
| --- | --- |
| 完成日期 / 提交 | 2026-09-27 / `ee246ed`、`2ac0508` |
| 实际交付物（文件 + 条数） | `apps/api/prisma/migrations/20260928090000_purchase_plan/migration.sql`（建两张表 + 索引 + 外键 + 部分唯一索引）；`apps/api/prisma/migrations/20260928100000_purchase_plan_backfill_drafts/migration.sql`（草稿按 `bom_id` 归并成计划、原草稿行软删，幂等）；`apps/api/prisma/schema.prisma`（`PurchasePlan` / `PurchasePlanItem` 两个 model，各带审计六列与软删列）；`apps/api/test/unit/purchase-plan-migration.test.cjs`（11 条）；顺带 `apps/api/test/unit/sales-order-spec-migration.test.cjs`（懒正则修正） |
| 验证命令与结果 | `npm run typecheck`：双绿；`npm run test:unit:api`：2207/2207；守卫条数：`purchase-plan-migration.test.cjs` 11/11（本机实测，逐条跑过） |
| 与设计的差异（含理由） | 建表、外键动作、部分唯一索引、幂等都按 §3.4 与 §4 落地，无偏差。唯一一处是**顺带修的既有测试**：`purchase_plan_items.quantity` 这个列名触发了 `sales-order-spec-migration.test.cjs` 里那条懒正则的假失败（它跨过了整份拼接 SQL，把别的表也算了进来），改成按语句匹配（`2ac0508`）——不是本任务的设计变更，但是由本任务新增的列名引出来的 |
| 未验证项（环境阻断） | 两条迁移**没有在真实 PostgreSQL 上执行过**（本机无库）；`prisma migrate status` / `migrate diff` 的实际漂移行数没测——部分唯一索引 `purchase_plans_bom_id_active_key` 会让基线漂移小幅增加（预期内，判定标准见 README「迁移与部署红线」）；搬迁 SQL 的幂等只有静态断言（含 `WHERE NOT EXISTS`、无 `DELETE`/`DROP`），没有在影子库干跑核对行数与金额 |
| 踩到的坑 | 就是上面那条懒正则：它按"整份拼接后的 SQL 文本"匹配，于是**任何**新增的带 `quantity` 列的表都会让它假红。教训是"用正则守迁移"必须限定到单条语句，否则守卫会随无关改动变红而被人习惯性放宽 |

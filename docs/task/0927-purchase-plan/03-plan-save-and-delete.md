# T03 计划 API：保存（整体替换行 + 乐观锁 + 已下单行保护）与软删

> 设计依据：[purchase-plan-and-supplier-collapse-2026-09-27.md](../../design/purchase-plan-and-supplier-collapse-2026-09-27.md) §5.1、§2（口径 6/15）
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T02](./02-plan-api-skeleton.md)。后续 [T09](./09-web-plans-list-page.md)、[T10](./10-web-plan-detail-sheet.md) 依赖它。

## 目标

让计划**能改**且**改不坏**：`PATCH` 整体替换明细行（与采购单/BOM 既有语义一致）、
带乐观锁防两个采购员互相覆盖、**已下单的行不许被删、也不许改内容**（只有展示用的 `sequence` 例外）；
`DELETE` 软删，但**只要有一行已下单就拒绝**。

## 口径与决策（依据设计文档）

- **口径 6**：多波次下单——下过的行**留在计划里**并显示 PO 号，所以保存时必须保护它们。
- **口径 15**：计划**未下单过可软删**；BOM 被软删后计划**独立存活**（不因为 BOM 没了就删计划）。
- **§3.2**：`purchase_order_item_id` 是"已下单"的唯一表示 → 保护规则就围着它写。
- **§5.1**：`PATCH /purchase-plans/:id`（乐观锁 `expected_updated_at`）、
  `DELETE /purchase-plans/:id`（已下单行 → 422 `PURCHASE_PLAN_HAS_ORDERED_LINES`）。
- **已下单行的内容锁**：内容改了要退回采购计划（[T05](./05-purchase-order-revert-and-readonly.md)）——
  退回是显式的、有原因的、可审计的；在计划里直接改=让对外凭证与工作面各说各话。

## 范围与非范围

**范围**

- `PATCH /purchase-plans/:id`：整体替换行 + 乐观锁 + 已下单行保护。
- `DELETE /purchase-plans/:id`：软删 + 已下单行拒绝。
- 单测 `apps/api/test/unit/purchase-plan-save.test.cjs`。

**非范围**

- 收束下单（[T04](./04-plan-collapse-order.md)）——它**只**写 `purchase_order_item_id`，不碰其他列。
- 计划行的新增/删除在**前端**怎么呈现（[T10](./10-web-plan-detail-sheet.md)）。
- **不动** `BomsService.replaceItems`（它换行 ID 的行为是既有的，靠 [T06](./06-bom-item-order-status-plan.md)
  的摊回逻辑兼容）。

## 交付物

| 文件 | 关键改动 |
| --- | --- |
| `apps/api/src/modules/procurement/purchase-plans.controller.ts` | `PATCH :id` / `DELETE :id` 与 DTO（`items` 数组 + `expected_updated_at`） |
| `apps/api/src/modules/procurement/purchase-plans.service.ts` | `save`（整体替换 + 乐观锁 + 已下单行保护：`PURCHASE_PLAN_ORDERED_LINE_REMOVED` / `PURCHASE_PLAN_ORDERED_LINE_LOCKED`，`sequence` 例外）、`remove`（软删 + 守卫）、`assertNotStale`（`PURCHASE_PLAN_UPDATE_CONFLICT`） |
| `apps/api/test/unit/purchase-plan-save.test.cjs` | 新建（约 12 条：含两个错误码与 `sequence` 例外） |

## 实施要点

### 1. 整体替换 + 乐观锁（照抄 BOM 的既有做法，不要另发明）

- `BomsService.replaceItems` 的形状是现成范本：**软删全部旧行 + 整批建新行**，同一个事务。
- 乐观锁照 `BomsService.assertNotStale`：客户端回传打开时的 `updated_at`，
  服务端在事务里 `SELECT … FOR UPDATE` 取行锁后比对，不一致 422
  **`PURCHASE_PLAN_UPDATE_CONFLICT`**（已定稿，与 `BOM_UPDATE_CONFLICT` 同款），
  提示"已被他人修改，请重新加载"。
- **不传令牌时跳过比对**（兼容老调用方与轻量单测桩）——与 BOM 一致。

### 2. 已下单行保护（本任务的核心）

**不变的规则**：一行一旦已下单（`purchase_order_item_id` 非空），它的**内容**就归那张采购单了。
保存请求里的行按下面三类处理：

| 请求里的行 | 规则 |
| --- | --- |
| `id` 指向一行**已下单**，且**仍在提交里** | 锁住 `material_id` / `unit_id` / `quantity` / `unit_price` / `supplier_id` / `model`。改了 → 422 **`PURCHASE_PLAN_ORDERED_LINE_LOCKED`**（提示里要带上是哪个字段被改） |
| `id` 指向一行**已下单**，但**从提交里消失** | 422 **`PURCHASE_PLAN_ORDERED_LINE_REMOVED`** |
| `id` 指向一行**未下单** | 可改可删 |
| 没有 `id`（新行） | 允许新增 |

**两个错误码刻意分开（已定稿，不要合成一个）**：给用户的话不一样 ——
前者是"这一行不能删"，后者是"这一行不能改，要改请先**退回采购计划**"。
合成一个码，前端只能给一句含糊的提示，用户不知道该做哪一步。

**两个例外，都是有理由的例外：**

1. **`sequence` 允许被重排。** 序号只是展示顺序，不是业务内容，拖动排序不该被拒绝
   （13 列的排序是采购员的工作习惯）。
2. **`expected_date` 允许改，并且要同步写进对应的采购明细。** 预计到货是「**预期**」而不是
   「既成事实」：供应商说"这周到不了、下周到"是每天都发生的事。而口径 7 已经把采购单页的
   明细编辑关掉了 —— 这里若也锁死，**系统里就再没有任何地方能改这个日期**。
   同步（`tx.purchaseOrderItem.update({ expectedDate })`）是必须的：不同步的话同一行会有两个
   "预计到货"，而采购员拿去跟供应商对的是采购单上那一份。
   注意同步**只写这一个字段**，不放宽任何别的列。

除上面两条之外一律不许动。

实现要点：

- 判断"内容被改"要**逐列比**（与库里那一行比），不能只看有没有提交 `id`：
  前端把整行回传时，未改的列也会出现在请求里。
- 保护判断放在**校验阶段**（写库前），不要把已下单行"静默保留"——静默保留会让界面显示的与库里存的
  不一致，正是这类 bug 的温床。
- **文案必须给出口**：`LOCKED` 的提示里要写"请先退回采购计划再改"（并带 PO 号），
  只报错不指路，用户会以为系统坏了。

### 3. 软删（`DELETE`）

- 前置：**任意一行已下单** → 422 `PURCHASE_PLAN_HAS_ORDERED_LINES`（设计文档已给这个名字）。
- 软删写 `deleted_at` + `deleted_by`（照既有 `audit.softDelete`），**不删行、不级联删明细**
  （审计要能回看这份计划原来有什么）。
- **BOM 被软删后计划独立存活**：软删计划时**不要**去检查/连带处理 BOM；
  反过来 BOM 被删也不该影响计划（口径 15）。
- 审计 `purchase_plan.delete`（含计划号、行数、是否有已下单行）。
- 软删之后同一 BOM **可以再建一份计划**（部分唯一索引 `WHERE deleted_at IS NULL` 才成立）——
  这条要在测试里钉住，它是 [T01](./01-plan-schema-and-migrations.md) 那个索引存在的**理由**。

### 4. 保存时的行字段

请求行字段（与详情 13 列一一对应）：`material_id` / `material_snapshot` / `unit_id` / `unit_snapshot` /
`bom_item_id`(可空) / `supplier_id`(可空) / `supplier_snapshot`(可空) / `model` / `quantity` /
`unit_price` / `expected_date`。
**没有 `currency`**（口径 10：计划是"还没成为采购单"的工作面，币种在下单预览里按组选）。

- 没选供应商时 `supplier_snapshot` 写 **`Prisma.DbNull`**（不是 `Prisma.JsonNull`）——见 README 的红线。
- `material_snapshot` / `unit_snapshot` 由前端回传（与采购明细同形状）；服务端做存在性/启用校验
  （照 `replaceItems` 里 `material.findMany` / `unit.findMany` 的既有写法，**允许轻量桩没有这两张表**）。

## 验收与验证

| # | 验收点 | 怎么验 |
| --- | --- | --- |
| 1 | 保存是**整体替换**：老行软删 + 新行批量建（同一事务） | `purchase-plan-save.test.cjs` |
| 2 | 乐观锁：令牌不一致 → 422 `PURCHASE_PLAN_UPDATE_CONFLICT` 且**一行都没写** | 同上（断言冲突时没有 `updateMany`/`createMany` 调用） |
| 3 | 不传令牌时跳过比对（兼容旧调用方） | 同上 |
| 4 | 一个**已下单**行从提交里消失 → 422 `PURCHASE_PLAN_ORDERED_LINE_REMOVED`，且库里那一行还在 | 同上 |
| 5 | 改**已下单**行的任意内容列（物料/单位/数量/单价/供应商/预计到货之一）→ 422 `PURCHASE_PLAN_ORDERED_LINE_LOCKED` | 同上（逐列各来一条，最少覆盖物料/数量/单价/供应商） |
| 6 | **只**重排 `sequence`（其余列原样）→ **允许**，保存成功 | 同上（`sequence` 例外） |
| 7 | 未下单行可删、可改；新行可加 | 同上 |
| 8 | `DELETE` 有已下单行 → 422 `PURCHASE_PLAN_HAS_ORDERED_LINES` | 同上 |
| 9 | `DELETE` 未下单 → 软删（`deleted_at` 非空、`deleted_by` 有值），明细行**不**被级联删 | 同上 |
| 10 | 软删后可对同一 BOM **再建一份计划**（部分唯一索引只约束未删的） | 同上（或 [T01](./01-plan-schema-and-migrations.md) 的守卫配合假 Prisma 断言 where 形状） |
| 11 | 没选供应商时写 `DbNull` | 同上 |
| 12 | 审计事件 `purchase_plan.save` / `purchase_plan.delete` 带计划号与行数 | 同上 |
| 13 | 两个"已下单行"错误码**不是同一个**（`REMOVED` ≠ `LOCKED`），且 `LOCKED` 文案里有"退回采购计划" | 同上（断言 `code` 与提示文案） |
| 14 | 类型检查 + 全量 API 单测 | `npm run typecheck`、`npm run test:unit:api` |

## 决策记录

- **已下单行 = 内容全锁，只放行 `sequence`**：这一行的内容已经进了采购单（对外凭证），
  在计划里再改它就是让凭证与工作面各说各话。要改就走**退回采购计划**（[T05](./05-purchase-order-revert-and-readonly.md)），
  那条路是显式的、有原因的、可审计的。序号只是展示顺序，不属于内容。
- **两个错误码分开**：`REMOVED`（不能删）与 `LOCKED`（不能改，要改先退回）给用户的下一步动作不同，
  合成一个码前端只能给含糊提示。
- **冲突时"一行都没写"**：先做并发比对再做任何写入（照 `replaceItems` 的注释：冲突时连软删旧行都不发生）。
- **软删不级联明细**：审计要能回看这份计划原来有什么。

## 完成记录

| 项 | 内容 |
| --- | --- |
| 完成日期 / 提交 |  |
| 实际交付物（文件 + 条数） |  |
| 验证命令与结果 | `npm run typecheck`：｜`npm run test:unit:api`： |
| 与设计的差异（含理由） |  |
| 未验证项（环境阻断） |  |
| 踩到的坑 |  |

# T02 计划 API 骨架：module/controller/service，列表·候选·新建（自动带 BOM 明细）·详情

> 设计依据：[purchase-plan-and-supplier-collapse-2026-09-27.md](../../design/purchase-plan-and-supplier-collapse-2026-09-27.md) §5.1、§4.1、§2（口径 2/12/14）
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T01](./01-plan-schema-and-migrations.md)。后续 [T03](./03-plan-save-and-delete.md)、
[T04](./04-plan-collapse-order.md)、[T06](./06-bom-item-order-status-plan.md)、[T09](./09-web-plans-list-page.md) 依赖它。

## 目标

建立 `purchase-plans` 模块与四个**只读为主**的端点：列表（口径 14 的 9 列）、可建计划的 BOM 候选、
新建（**诞生即带全部 BOM 明细行**）、详情（含供应商地址/联系人、累计下单状态、本行 PO 号、
`bom_extra_material_count` 提示）。

## 口径与决策（依据设计文档）

- **口径 2**：计划手动新建，诞生时自动带出该 BOM **全部**明细行（行可删可加）——
  「漏买部件」唯一的防法是"计划一诞生就包含全部需求"。**不做**"按 BOM 自动生成计划"。
- **口径 3**：新建计划时从 BOM 行**预填供应商**（BOM 那列回答"这个部件**通常**找哪家"）。
- **口径 12**：BOM 后续变更**不同步**进计划，但详情/列表要提示「这张 BOM 比计划多 N 个物料」。
- **口径 14**：列表 9 列 —— 计划编号 / 销售单号 / **货号** / 客户 / BOM 版本 / 行数 / 未下单行数 /
  状态 / 最后更新（人 + 北京时间）。**不做** Excel 导出。
- **§4.1**：计划状态是**派生**的（未下单 / 部分下单 / 已完成），不落列。

## 范围与非范围

**范围**

- `apps/api/src/modules/procurement/purchase-plans.module.ts` / `.controller.ts` / `.service.ts` / `.domain.ts`。
- `apps/api/src/app.module.ts` 注册模块。
- 四个端点：`GET /purchase-plans`、`GET /purchase-plans/plan-candidates`、`POST /purchase-plans`、
  `GET /purchase-plans/:id`。
- 单测 `apps/api/test/unit/purchase-plan-service.test.cjs`（列表/候选/新建/详情的口径）。

**非范围**

- 保存与软删（[T03](./03-plan-save-and-delete.md)）、收束下单（[T04](./04-plan-collapse-order.md)）。
- 累计下单状态的四态改造（[T06](./06-bom-item-order-status-plan.md)）——本任务只在详情里**读**它。
- 前端（[T09](./09-web-plans-list-page.md)/[T10](./10-web-plan-detail-sheet.md)）。

## 交付物

| 文件 | 关键改动 |
| --- | --- |
| `apps/api/src/modules/procurement/purchase-plans.module.ts` | 新建；`imports: [AuditModule]`，providers 两个 service，exports 供 [T05](./05-purchase-order-revert-and-readonly.md) 复用 |
| `apps/api/src/modules/procurement/purchase-plans.controller.ts` | `@Controller("purchase-plans")` + `AuthenticationGuard` + `ModulePermissionGuard` + `@RequireModules("procurement")`；四个端点与 DTO |
| `apps/api/src/modules/procurement/purchase-plans.service.ts` | `list` / `planCandidates` / `create` / `get`；派生状态；`bom_extra_material_count` |
| `apps/api/src/modules/procurement/purchase-plans.domain.ts` | 纯函数：派生状态、列表行映射、候选行映射（可单测，不碰库） |
| `apps/api/src/app.module.ts` | 注册 `PurchasePlansModule` |
| `apps/api/test/unit/purchase-plan-service.test.cjs` | 新建（约 10 条） |
| `apps/api/test/http/authorization-matrix-contract.test.cjs` | 登记**第 41 个控制器**与至少一条端点（`purchase-plans.list`，`@RequireModules("procurement")` → `deny: [NO_MODULE]`、`allow: {procurement: 200}`） |

## 实施要点

### 1. 状态是派生的（不落列）

| 显示 | 判据 |
| --- | --- |
| 未下单 | 所有行 `purchase_order_item_id` 都为空 |
| 部分下单 | 有行已下单，也有行为空 |
| 已完成 | 所有行都已下单 |

实现上**用一条聚合查询**（`_count` 或 `groupBy`）算「已下单行数 / 总行数」，不要在 JS 里逐行查。

### 2. 列表（口径 14）

- 参数：`order_no` / `item_no` / `status`（未下单/部分下单/已完成）/ `q`。
- `item_no` 来自**销售单**（2026-09-26 那批的货号）：计划表本身不存货号，列表按 `sales_order_id` join 出
  `sales_orders.item_no`。**不要**为了列表再给计划表加一列货号（两个真源）。
- 「最后更新」= 计划的 `updated_at` + `updated_by` 的姓名（照 `audit-columns` 的既有做法：
  查 `user.display_name`，**绝不显示 UUID**）。
- 默认排序：`updated_at desc`（采购员关心"我上次改到哪了"）。

### 3. 候选（`plan-candidates`）

「可建计划的 BOM」= 已确认销售单 + 有 BOM + **还没有未删计划**。一条查询完成，不要 N+1。
返回列建议：`bom_id / order_no / item_no / customer_name / bom_version / material_count`。

### 4. 新建（`POST /purchase-plans`，body `{bom_id}`）

1. 校验 BOM 存在且未删；其销售单**已确认**；该 BOM **还没有未删计划** →
   否则 409（撞部分唯一索引时同样要翻译成可读冲突，照 `handleUnique` 的既有写法）。
2. 计划号 `PP-{YYYYMMDD}-{UUID前8位大写}`（与 `purchase-orders.service.ts:255` 的 `PO-` 同格式）。
3. **自动带出全部 BOM 明细行**（读 `bom_items`，`deletedAt: null`，按 `sequence`）：
   - `quantity` = BOM 的 `required_quantity`；`unit_price` = 0（口径 2 明确"单价 0"，不猜价格）；
   - `supplier_id` / `supplier_snapshot` = **BOM 行上那一列**（口径 3 的预填），为空就留空；
   - `material_snapshot` / `unit_snapshot` 与采购明细**同一形状**（照抄 `orderData()` 的造法）；
   - `bom_item_id` = 那一行的 id（[T06](./06-bom-item-order-status-plan.md) 的行 ID 摊回要用）；
   - `bom_snapshot`（计划头）= 该 BOM 的版本与明细摘要。
4. 全部在一个事务里建（计划头 + 明细 `createMany`）。
5. 审计 `purchase_plan.create`（含计划号、订单号、BOM 版本、行数）。

### 5. 详情（`GET /purchase-plans/:id`）

- 头：计划号 / 销售单号 / 货号 / 客户 / BOM 版本 / 状态（派生）/ 最后更新。
- 行（**13 列的数据源**，§6.2 的列顺序）：名称 / 型号 / 下单状态（[T06](./06-bom-item-order-status-plan.md)）/
  本次采购量（= `quantity`）/ 当前库存量 / 单位 / 单价 / **供应商** / **供应商地址** / **联系人（含电话）** /
  预计到货 / 本行 PO 号 / 行 id。
  - 供应商地址与联系人是**选中供应商的只读派生**（口径 4）：从 `supplier` 关系或 `supplier_snapshot` 取，
    **不在计划行上落列**。联系人合成一格：`contact_name` + `phone` → `张伟 / 13800000000`（口径 9）。
- `bom_extra_material_count`（口径 12）：该计划对应 BOM 的**当前**明细行数 − 计划行数；
  >0 时前端提示「这张 BOM 比计划多 N 个物料」（**不同步**、**不自动加行**）。

### 6. 路由顺序

`plan-candidates` 是**静态路径**，必须声明在 `@Get(":id")` **之前**，否则会被当成计划 id
（本仓库已经有过 `finished-goods-summary` / `item-nos` / `reorder-preview` 三次同样的教训，
每条都配了静态断言，照抄）。

## 验收与验证

| # | 验收点 | 怎么验 |
| --- | --- | --- |
| 1 | 派生状态三态：无已下单行/部分/全部 | `purchase-plan-service.test.cjs` |
| 2 | 新建自动带出**全部** BOM 明细行（一条不漏），`quantity` = BOM 需求量、`unit_price` = 0 | 同上 |
| 3 | 新建时供应商按 BOM 行预填（BOM 行有就带、没有就空） | 同上 |
| 4 | 同一 BOM 已有未删计划 → 409，且提示可读 | 同上 |
| 5 | 候选列表只含「已确认 + 有 BOM + 无未删计划」 | 同上 |
| 6 | 列表 `item_no` 来自销售单 join，且按 `item_no` 能筛 | 同上 |
| 7 | 列表「最后更新」写**姓名**不写 UUID | 同上 |
| 8 | `bom_extra_material_count` = BOM 当前行数 − 计划行数（>0 才提示） | 同上 |
| 9 | 供应商地址/联系人是只读派生（计划行**没有**这两列） | 同上（断言写入数据里不含 address/contact 列） |
| 10 | `plan-candidates` 不被 `@Get(":id")` 吃掉 | 源码静态断言（照 `item-nos` 的既有写法） |
| 11 | 权限：`@RequireModules("procurement")`，无模块角色 403 | `authorization-matrix-contract.test.cjs` 矩阵条目（**本机跑不了 → 环境阻断**） |
| 12 | 类型检查 + 全量 API 单测 | `npm run typecheck`、`npm run test:unit:api` |

## 决策记录

- **列表不落货号列**：货号是销售单的字段，计划 join 出来即可；落列就有两个真源（与 2026-09-26
  那批"货号不冗余到下游"同一条理由）。
- **新建时单价一律 0**：设计文档口径 2 写死"单价 0"——价格是采购员填的，系统猜一个数比留空更糟。
- **候选与新建的"无计划"判据用 `deleted_at IS NULL`**：软删过的 BOM 可以再建一份计划（口径 15）。

## 完成记录

| 项 | 内容 |
| --- | --- |
| 完成日期 / 提交 |  |
| 实际交付物（文件 + 条数） |  |
| 验证命令与结果 | `npm run typecheck`：｜`npm run test:unit:api`： |
| 与设计的差异（含理由） |  |
| 未验证项（环境阻断） |  |
| 踩到的坑 |  |

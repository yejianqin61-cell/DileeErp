# T06 下单状态四态改造：「草稿中」→「计划中」，数据源改为计划行（含换行 ID 摊回）

> 设计依据：[purchase-plan-and-supplier-collapse-2026-09-27.md](../../design/purchase-plan-and-supplier-collapse-2026-09-27.md) §4.2、§2（口径 13）
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T02](./02-plan-api-skeleton.md)（要读计划行）。与 [T01](./01-plan-schema-and-migrations.md) 可并行
（契约先定，等 01 的表建好后跑通）。

## 目标

`GET /purchase-orders/bom-item-status?bom_id=` 的**第二档**从「草稿中」（数据源是草稿采购单）
改成「**计划中**」（数据源是**计划行**），同时**不改字段名、不改枚举值**（避免动 4 个前端文件的契约），
并保留既有的**行 ID 摊回**逻辑。

## 口径与决策（依据设计文档）

- **口径 13**：这一列答两个问题 —— **还差多少**（累计口径）+ **这行处理了没**（本行 PO 号）；
  草稿时代的数据源过时了，不是这个列过时了。
- **§4.2**：四档的数据源表；字段名 `draft_quantity` / `draft_purchase_order_nos` 与枚举值 `draft` 保留，
  **只改语义与文案**（前端文案「草稿中」→「计划中」）。
- **§4.2 末段**：`BomsService.replaceItems` 是"软删全部旧行 + 整批建新行"，存一次 BOM **所有行 ID 都会换**；
  计划行的 `bom_item_id` 也存的是当时那一版 → 累计归集**必须**沿用既有摊回逻辑
  （`purchase-orders.service.ts:205-245` 的注释是这条的完整来历，**别删**）。

## 范围与非范围

**范围**

- `apps/api/src/modules/procurement/purchase-orders.service.ts` 的 `bomItemOrderStatus`：
  `draft` 档改为读**计划行**（`purchase_order_item_id IS NULL` 的行）；
  连计划编号一起回（填进保留字段 `draft_purchase_order_nos`）。
- 单测 `apps/api/test/unit/purchase-plan-bom-item-status.test.cjs`（新增/改写既有
  `purchase-order-bom-item-status.test.cjs`）。
- 前端**只改文案**（「草稿中」→「计划中」）：`apps/web/app/procurement/orders/page.tsx` ——
  该页在 [T11](./11-web-purchase-order-slimming.md) 会瘦身，文案改动随 T11 一起落。

**非范围**

- `ordered` / `partial` 两档的口径**不变**（仍读采购明细 + `ORDERED_PURCHASE_STATUSES`）。
- `none` 档不变。
- **不动** `BomsService.replaceItems`。

## 交付物

| 文件 | 关键改动 |
| --- | --- |
| `apps/api/src/modules/procurement/purchase-orders.service.ts` | `bomItemOrderStatus` 的 `draft` 档数据源改成计划行；摊回逻辑**原样保留**（含那段注释） |
| `apps/api/test/unit/purchase-order-bom-item-status.test.cjs` | 改写：`draft` 档的用例从"草稿采购单"改成"计划行" |
| `apps/api/test/unit/purchase-plan-bom-item-status.test.cjs` | 新建：计划行 → 四态与累计口径（含换行 ID 摊回） |
| `apps/web/app/procurement/orders/page.tsx` | 文案「草稿中」→「计划中」（随 [T11](./11-web-purchase-order-slimming.md) 落地） |

## 实施要点

### 1. 四档的数据源（§4.2 的表，逐行抄）

| 档 | 数据源 |
| --- | --- |
| `ordered` 已下单（足量） | 采购明细（`ORDERED_PURCHASE_STATUSES`），口径不变 |
| `partial` 部分下单 | 同上，口径不变 |
| `draft` **计划中** | **计划行**（`purchase_order_item_id IS NULL` 的行）的 `quantity` 之和 + 计划编号 |
| `none` 未下单 | 以上都没有 |

### 2. 累计算法必须按"计划行 → BOM 行"归集，并且要摊回

`bomItemOrderStatus` 的既有结构（`:205` 起）是：按 BOM 行 ID 建累加器
（`accumulator: Map<key, { ordered, draft, orderedNos, draftNos }>`），
`ordered` 档吃采购明细、`draft` 档吃草稿采购单。

改成计划行之后：

- 计划行的 `bom_item_id` → 若它**仍在**当前 BOM 的明细行里，直接累加到那一行；
- 若那一行已经被 `replaceItems` 换掉（BOM 存过一次，所有行 ID 都变了）→ **按物料摊回该物料的第一行**
  （既有逻辑，`purchase-orders.service.ts:205-245` 的注释解释了为什么必须这样）。
- 计划行的 `supplier_id`/`quantity` 与采购明细的累计口径**互不覆盖**：`ordered` 与 `draft` 是两个独立的数。

### 3. 契约冻结（本任务的硬约束）

- 字段名：`draft_quantity` / `draft_purchase_order_nos` **保留**（4 个前端文件在用）。
- 枚举值：`state: "draft"` **保留**，只把前端**文案**改成「计划中」。
- `BomItemOrderState = "none" | "draft" | "partial" | "ordered"`（`:16`）**不动**。
- 若实现时觉得"应该顺手把字段名改成 plan_quantity" —— **不要**：设计文档明确写了"避免动 4 个前端文件的契约"，
  改名属于改口径，要先改设计文档。

## 验收与验证

| # | 验收点 | 怎么验 |
| --- | --- | --- |
| 1 | `draft` 档数量 = 该 BOM 对应计划里**未下单行**的 `quantity` 之和 | `purchase-plan-bom-item-status.test.cjs` |
| 2 | `draft_purchase_order_nos` 里给的是**计划编号**（`PP-…`），字段名不变 | 同上 |
| 3 | `ordered` / `partial` 档不再受草稿/计划影响（口径不变） | `purchase-order-bom-item-status.test.cjs` |
| 4 | 一个物料在 BOM 里有多行时，累计归集到**第一行** | 同上（既有行为回归） |
| 5 | BOM 存过一次（行 ID 全换）后，计划行仍能按物料摊回归集 | 同上（本任务的核心） |
| 6 | 计划被软删后，`draft` 档不再计入它的行 | 同上 |
| 7 | 已下单行（`purchase_order_item_id` 非空）**不计入** `draft` 档 | 同上 |
| 8 | `state` 枚举与字段名未变（静态断言源码） | 同上 |
| 9 | 类型检查 + 全量 API 单测 | `npm run typecheck`、`npm run test:unit:api` |

## 决策记录

- **只改语义不改契约**：改名会让 4 个前端文件的字段名对不上，而这一列的价值在数据源不在名字。
- **摊回逻辑保留而不是重写**：它是被真实数据打出来的（BOM 一保存行 ID 就全换），重写一遍等于再踩一次。

## 完成记录

| 项 | 内容 |
| --- | --- |
| 完成日期 / 提交 |  |
| 实际交付物（文件 + 条数） |  |
| 验证命令与结果 | `npm run typecheck`：｜`npm run test:unit:api`： |
| 与设计的差异（含理由） |  |
| 未验证项（环境阻断） |  |
| 踩到的坑 |  |

# T05 返单建单：服务端复制语义与预览

> 设计依据：[reorder-item-no-and-summary-2026-09-26.md](../../design/reorder-item-no-and-summary-2026-09-26.md) §三.1、§五
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T01](./01-sales-order-item-no-schema.md)、[T02](./02-sales-order-item-no-api.md)。后续 [T06](./06-reorder-web-entry.md) 依赖它。

## 目标

让「以此返单」在服务端成为**一条有守卫、可审计、走既有校验路径**的建单方式：
复制工艺口径、货号沿用、来源可追溯；数量与交期**必须重填**；老单及其下游事实零改动。

## 关联决策

- 已拍板 ③：全带工艺口径（37 标量 + 明细 + 材料引用），数量/下单日/交期必重填，单价照带标待复核。
- 设计文档 §五：返单**只到「新建销售单草稿」**，不自动建 BOM、不自动建采购/生产。

## 范围与非范围

**范围**

- `GET /sales-orders/reorder-preview?order_no=`（只读预览）。
- `POST /sales-orders` 接受 `reorder_from_order_no`，服务端按来源单复制。
- 三条守卫与错误码、审计字段。
- 新增 `apps/api/test/unit/sales-order-reorder.test.cjs`。

**非范围**

- 不做前端（[T06](./06-reorder-web-entry.md)）。
- 不做「批量返单」「按花色返单」「返单自动带 BOM」。
- 不复制也不改动来源单的 `SalesOrderVersion`、状态、BOM、采购、生产事实。
- **不改**不带 `reorder_from_order_no` 时的既有建单行为（既有测试必须零改动通过）。

## 交付物

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/modules/sales/sales-orders.controller.ts` | `@Get("reorder-preview")`（**必须声明在 `@Get(":id")` 之前**）、`SalesOrderDto.reorder_from_order_no` |
| `apps/api/src/modules/sales/sales-orders.service.ts` | `reorderPreview(orderNo)`、`create()` 里接来源单与复制 |
| `apps/api/src/modules/sales/sales-orders.domain.ts`（若需要） | 复制字段清单（见下），或直接复用 `SPEC_SCALAR_FIELDS` |
| `apps/api/test/unit/sales-order-reorder.test.cjs` | 新建（约 12 条） |
| `apps/api/test/sales-order-chain.test.cjs` | 加 1 条「不带来源时行为不变」 |

## 实施要点

**1. 路由顺序陷阱（会真的踩）**

`@Get("reorder-preview")` 与 `@Get(":id")` 在同一个控制器里，**声明顺序决定匹配**：
`reorder-preview` 放前面，否则会被当成 `id = "reorder-preview"` 走 `get(id)` 然后 404。
仓库里已有同样形状的先例与教训（`purchase-orders` 的 `bom-item-status`，见
[0917-采购单收束与编辑.md](../0917-procurement-collapse-and-edit.md) 的「未验证」一节：
「先后顺序靠代码位置保证，没有自动化断言」）。本任务**补一条断言**，不要再留这个洞。

**2. 三条守卫与错误码**

| 条件 | 状态码 | 错误码 | 文案要点 |
| --- | --- | --- | --- |
| 来源单不存在或已软删 | 404 | `REORDER_SOURCE_NOT_FOUND` | 「返单来源销售单不存在」 |
| 来源单是草稿 | 422 | `REORDER_SOURCE_NOT_CONFIRMED` | 「只有已确认或已关闭的销售单可以返单」 |
| 来源单没有货号 | 422 | `REORDER_SOURCE_ITEM_NO_MISSING` | 「来源单没有货号：请先给 DL260001-1 补货号，再返单」 |

文案里带上单号——现场一眼知道要处理哪张单。`reorderPreview` 用同一套守卫，前端因此能在点按钮前就知道能不能返。

**3. 复制什么、不复制什么（逐条实现，不要凭感觉）**

| 类别 | 字段 | 处理 |
| --- | --- | --- |
| 货号 | `item_no` | **复制**（老板要求：返单货号不变） |
| 来源 | `reorder_from_order_no` | **写来源单号** |
| 客户 | `customer_id`、`contact_id`、客户/联系人快照 | 复制（前端可改） |
| 产品 | `product_name`、`product_spec`、`unit` | 复制（前端可改） |
| 工艺 | `SPEC_SCALAR_FIELDS` 全部 37 个 | 复制 |
| 明细 | `spec_details` | 复制（作为新单的明细行插入） |
| 材料引用 | `material_refs` | 复制（复用 `replaceMaterialRefs` 的逐行对齐语义） |
| 结算 | `currency`、`settlement_method`、`unit_price`、`settlement_unit_price`、`tax_rate` | 复制（**单价沿用上次 → 预警**） |
| **必须重填** | `order_no`、`order_date`、`quantity`、`delivery_date` | **不复制**；缺 `order_no`/`order_date`/`quantity` 时由既有 DTO 校验直接 400 |
| **不复制（与数量绑定）** | `total_amount`、`receivable_amount`、`local_currency_amount` | 不复制：这三个是 `数量 × 单价` 的派生结果，抄过来必然与新的数量矛盾 |
| **绝不复制** | `status`、`current_version`、`versions`、`boms`、下游任何事实 | 新单从 `draft` / v1 开始 |

实现方式：**在 `create()` 里先解析来源单，再把它拼进 `input` 的缺省值**（`input.x ?? source.x`），
而不是另写一条 `createFromReorder()` 分支——后者会绕过 `create()` 里已有的币种校验、
客户/联系人解析、材料存在性校验、唯一键冲突处理（`ORDER_NO_CONFLICT`）。这条是硬要求。

**4. `reorderPreview` 返回形状**

```jsonc
{
  "source_order_no": "DL260001-1",
  "source_order_id": "…",
  "item_no": "27621",
  "customer": { "…": "…" },
  "copy": { "product_name": "…", "unit": "支", "unit_price": "1.20", "…": "37 个工艺标量 + 明细 + 材料引用" },
  "must_fill": ["order_no", "order_date", "quantity", "delivery_date"],
  "warnings": ["单价沿用上次（1.20 USD），请复核", "应收/本币金额不沿用（与数量绑定），保存后按新数量重新计算"]
}
```

`must_fill` 与 `warnings` **由服务端给出**，前端只展示（保证「必须重填什么」只有一处定义）。

**5. 审计**

`sales_order.create` 的 details 现在是 `{ order_no }`，带来源时补 `reorder_from_order_no`；
另外 `snapshot()` 要把 `reorder_from_order_no` 记进 v1 快照，回看时能回答「这批是从哪张单返的」。

## 验收与验证

| # | 验收点 | 用例 |
| --- | --- | --- |
| 1 | 来源不存在 / 已软删 → 404 `REORDER_SOURCE_NOT_FOUND` | `unit/sales-order-reorder.test.cjs` |
| 2 | 来源是草稿 → 422 `REORDER_SOURCE_NOT_CONFIRMED` | 同上 |
| 3 | 来源无货号 → 422 `REORDER_SOURCE_ITEM_NO_MISSING`，文案含单号 | 同上 |
| 4 | 已关闭单可作为来源 | 同上 |
| 5 | 37 个工艺标量全部复制（逐键断言，不是抽查几个） | 同上 |
| 6 | 明细行与材料引用复制 | 同上 |
| 7 | 数量/下单日/交期**不**复制：请求缺 `quantity` → 400（不会静默沿用旧数量） | 同上 |
| 8 | `total_amount`/`receivable_amount`/`local_currency_amount` 不被复制 | 同上 |
| 9 | 新单状态是 `draft`、`current_version = 1`、只生成一个版本 | 同上 |
| 10 | 新单 `item_no` 与来源一致、`reorder_from_order_no` = 来源单号 | 同上 |
| 11 | 老单及其下游事实零改动（建单前后对老单的版本数/状态/明细做等值断言） | 同上 |
| 12 | 审计事件带 `reorder_from_order_no` | 同上 |
| 13 | 不带 `reorder_from_order_no` 时建单行为与改造前完全一致 | `sales-order-chain.test.cjs` |
| 14 | `GET /sales-orders/reorder-preview` 不被 `:id` 路由吃掉 | 同上（断言返回预览形状而非 404） |

命令：`npm run typecheck` → `npm run test:unit:api`。

## 决策记录

- **不复制金额三兄弟**：它们是数量的派生值，抄过来会与重填的数量矛盾，且矛盾会一路传到应收。
- **必须走 `create()`**：见实施要点 3；违反这条的实现会在几个月后以「返单能建出没有客户的单」的形式爆掉。
- **来源允许 `closed`**：返单恰恰最常发生在「上一批已经关闭」之后；只允许 `confirmed` 会把主场景挡掉。

## 完成记录

（认领后填写。）

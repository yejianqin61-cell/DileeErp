# 销售单删除与孤立单据（2026-11-03）

用户原话：

> 针对销售单部分，我需要能够删除销售单。相对应的采购单及其后续绑定的单据不删除而是显示孤立单据。

用户在本轮拍板的三条口径（都选了推荐项）：

1. **显示方式**：下游列表打「孤立」标记 **+** 销售模块新增「孤立单据」汇总页。
2. **删除防护**：弹窗列出会变成孤立的单据 **+ 非草稿必须填删除原因**（草稿仍是一键删）。
3. **权限**：有 `sales` 模块权限的人都能删，不额外锁管理员。

## 1. 范围与非目标

**做**

- `DELETE /sales-orders/:id` 对任何状态开放（草稿 / 已确认 / 已关闭），不再因「已有下游事实」拒绝。
- 删除前可预览影响面：会留下哪些类型的下游单据、各多少张。
- 下游单据**一行都不动**：不软删、不解绑、单号文本不变。
- 下游列表/详情显示「孤立」标记（`orphaned`）。
- 新增「孤立单据」汇总页：按被删的销售单分组，列出遗留单据。

**不做**

- 不做硬删。SalesOrder 上 `deleted_at` 是既有机制，38 张表的外键一律 `RESTRICT`/`NO ACTION`，
  硬删必然被 Postgres 拒绝；软删同时保住审计、版本快照与财务数据。
- 不做「恢复销售单」入口（数据都还在，真要恢复是运维动作；界面不提供，避免把删除做成开关）。
- 不改任何读路径的关联方式（phase 6 已结论：文本 join ≡ id join）。
- 不动 `sales_orders.order_no` 的部分唯一索引：删除后同一单号可被新单重新使用（既有口径）。

## 2. 「孤立」的判定

软删销售单后，它的 `sales_orders` 行仍在库里（`deleted_at` 非空），下游单据的
`sales_order_id` 仍然指向它。所以判定式是：

> 一张下游单据是**孤立单据** ⇔ 它的 `sales_order_id` 指向的销售单 `deleted_at IS NOT NULL`。

这个口径的好处：

- 下游单据不需要任何数据变更（不置空外键、不改单号），删错了只要清掉 `deleted_at` 就自动接回。
- 与 phase 5 的单号联动守护**不冲突**：`order-no-linkage` 的 `mismatched`/`orphan` 仍然为 0，
  「孤立」是另一维（父单已删），不是「外键丢失」。
- 下游单据仍然带着原来的 `order_no` 文本 —— 用户能看见它原来属于哪张已删的单。

边缘：删除后同一单号被新单重新使用（部分唯一索引允许），旧下游单据仍指向**旧的**那张。
列表上它们显示为「孤立」而不是挂到新单上 —— 这是有意为之：一张新单没有资格继承旧单的采购/生产事实。

## 3. 接口契约

### 3.1 `GET /sales-orders/:id/delete-preview`

只读，不写。

```json
{ "data": {
  "sales_order_id": "uuid",
  "order_no": "DL260170",
  "status": "confirmed",
  "reason_required": true,
  "downstream": [
    { "key": "purchase_order", "label": "采购单", "count": 2 },
    { "key": "production_order", "label": "生产单", "count": 1 }
  ],
  "downstream_total": 3
}, "meta": {} }
```

- `downstream` 只列 `count > 0` 的类型，顺序固定（按下面的 `ORPHAN_DOCUMENT_TYPES`）。
- `reason_required = status !== "draft"`。
- 销售单不存在/已删 → 404（走既有 `get()`）。

### 3.2 `DELETE /sales-orders/:id`

Body 可选：`{ "reason": "..." }`。

- 草稿：原因可省略（保持 2026-10-08 的一键删）。
- 非草稿：原因必填，空/空白 → `422 SALES_ORDER_DELETE_REASON_REQUIRED`。
- 下游单据不因删除被拒；没有下游单据的草稿/确认单也照删。
- 返回软删后的销售单行（形状与现在一致）。
- 审计事件 `sales_order.delete`，payload 增加 `reason`（有才写）、`orphan_documents`（各类型计数）、
  `orphan_total`。

### 3.3 `GET /sales-orders/orphans`

汇总页数据源。只读。

```json
{ "data": {
  "orders": [
    {
      "sales_order_id": "uuid",
      "order_no": "DL260170",
      "status": "confirmed",
      "deleted_at": "2026-11-03T10:00:00.000Z",
      "deleted_by_name": "张三",
      "documents": [ { "key": "purchase_order", "label": "采购单", "count": 2 } ],
      "document_total": 3
    }
  ],
  "documents": [
    { "id": "uuid", "type": "purchase_order", "label": "采购单", "document_no": "CG20261001",
      "order_no": "DL260170", "status": "ordered", "amount": "1200.0000", "currency": "CNY",
      "occurred_at": "2026-10-02T00:00:00.000Z" }
  ],
  "by_type": [ { "key": "purchase_order", "label": "采购单", "count": 2 } ],
  "totals": { "orders": 1, "documents": 3 },
  "truncated": false
}
```

- `orders` 按 `deleted_at` 倒序。
- `documents` 按 `occurred_at` 倒序，最多 1000 行；命中上限时 `truncated: true`
  （`totals.documents` 仍是真实总数，不是截断后的条数）。
- `amount`/`currency` 在单据本身没有金额列时给 `null`（BOM / 采购计划 / 生产单 / 出库通知 / 退货）。
- 下游单据一律 `deleted_at IS NULL` 的才计入（已删的下游单据不算遗留）。

### 3.4 下游列表/详情的 `orphaned` 字段

在下列接口的每一行（以及对应详情接口）增加布尔字段 `orphaned`：

| 接口 | 服务 |
| --- | --- |
| `GET /purchase-orders`、`GET /purchase-orders/:id` | `purchase-orders.service.ts` |
| `GET /purchase-orders/plans`（采购计划列表） | `purchase-plans.service.ts` |
| `GET /production-orders`（生产单列表） | `production-orders.service.ts` |
| `GET /finished-goods-outbounds`、`GET /finished-goods-outbounds/:id` | `finished-goods-outbound.service.ts` |
| `GET /finance/receivable-sources` | `receivable.service.ts` |
| `GET /boms`（BOM 列表） | `boms.service.ts` |

判定一律读销售单的 `deletedAt`（`salesOrder: { select: { deletedAt: true } }`），
不在前端按单号猜。

## 4. 类型清单 `ORPHAN_DOCUMENT_TYPES`

删除预览与孤立汇总共用一张表（新增 `apps/api/src/modules/sales/orphan-documents.ts`）：

| key | 标签 | Prisma 模型 | 单号列 | 金额 |
| --- | --- | --- | --- | --- |
| `bom` | BOM | `bom` | `version`（显示为 `BOM v3`） | 无 |
| `purchase_plan` | 采购计划 | `purchasePlan` | `planNo` | 无 |
| `purchase_order` | 采购单 | `purchaseOrder` | `purchaseOrderNo` | `totalAmount` |
| `production_order` | 生产单 | `productionOrder` | `productionOrderNo` | 无 |
| `finished_goods_outbound` | 成品出库单 | `finishedGoodsOutbound` | `outboundNo` | 无 |
| `finished_goods_outbound_notice` | 出库通知 | `finishedGoodsOutboundNotice` | `noticeNo` | 无 |
| `customer_return` | 客户退货 | `customerReturn` | `returnNo` | 无 |
| `receivable_source` | 应收来源 | `receivableSource` | `sourceNo` | `amount` |
| `customer_payment` | 客户收款 | `customerPayment` | `paymentNo` | `amount` |
| `receivable_adjustment` | 应收调整 | `receivableAdjustment` | `adjustmentNo` | `amount` |
| `receivable_reconciliation` | 应收对账 | `receivableReconciliation` | `reconciliationNo` | `receivableAmountSnapshot` |

这张表就是既有 `countDownstreamFacts` 数的 11 类，键名沿用它的 `*_count` 键去掉后缀
（`purchase_order_count` → `purchase_order`），不另起一套名字。

## 5. 前端落点

| 位置 | 改动 |
| --- | --- |
| `apps/web/components/sales/sales-orders-list.tsx` | 所有状态都有「删除」；先取 `delete-preview`，弹确认框列出下游单据；非草稿必须填原因 |
| `apps/web/app/procurement/orders/page.tsx`、`[id]/page.tsx` | 订单号旁「孤立」徽章；详情顶部提示 |
| `apps/web/app/production/page.tsx` | 生产单表订单号旁「孤立」徽章 |
| `apps/web/app/sales/orphans/page.tsx`（新） | 「孤立单据」汇总页 |
| `apps/web/lib/sales-sections.ts` | 新增 `orphans` 板块 |
| 仓库出库 / 应收来源页面 | 订单号旁「孤立」徽章（`orphaned` 为真时） |

## 6. 验收

- `DELETE` 一张草稿：一键删，不需要原因。
- `DELETE` 一张已确认、有 2 张采购单的销售单：不填原因 → 422；填了 → 单子从销售单列表消失，
  2 张采购单仍在，采购单列表显示「孤立」。
- `GET /sales-orders/orphans`：返回这张单 + 2 张采购单；`by_type` 合计一致。
- `order-no-linkage` 守护仍然 PASS（mismatched = 0、orphan = 0）。
- 删除后，采购单的 `sales_order_id` 与 `order_no` 原样不动（集成测试断言）。

# E3 成品分批出库、发货资料与客户退货链路开发设计

## 1. 目标与边界

本链路承接 E2 成品可用库存，完成：

```text
成品库存事实 -> 成品分批出库 -> 发货/物流/签收资料 -> E4 应收来源
客户退货 -> 回库或不良品分流 -> 新库存事实
```

V1.0 不实现应收确认、收款、核销、客户退货质检流程和完整物流对接；本链路只记录出库事实、发货资料、签收状态和退货库存去向。

## 2. 核心原则

- `order_no` 是跨模块身份证；出库单号、退货单号是派生编号，不能替代订单号。
- 库存余额只由 `InventoryFact` 汇总，禁止直接修改余额或删除历史出库。
- 出库支持分批；单批数量必须大于零且不得超过当前成品可用库存。
- 出库累计超过销售单/生产单计划量时必须返回风险提示并要求填写原因；V1 允许业务确认后继续出库，但负库存始终禁止。
- 客户退货不修改原出库事实，必须创建独立退货单和正向库存事实；去向为 `finished_goods` 或 `defective_goods`。
- 已过账单据只能冲销；冲销必须填写原因、生成反向事实并保留审计链。

## 3. 数据模型

### 3.1 `FinishedGoodsOutbound`

字段：`id`、`outbound_no`、`order_no`、`sales_order_id`、`production_order_id`、`unit_id`、产品/规格快照、`quantity`、`status`、`shipment_date`、`carrier`、`tracking_no`、`packing_list_no`、`invoice_no`、`signed_at`、`signature_reference`、`attachment` 引用、`idempotency_key`、`risk_reason`、`remark`、统一审计和软删除字段。

状态：`draft -> posted -> shipped -> signed`；已过账后只能通过冲销更正。`shipped` 和 `signed` 仅维护发货/签收资料，不重复扣库存。

### 3.2 `CustomerReturn`

字段：`id`、`return_no`、`order_no`、`sales_order_id`、`production_order_id`、`unit_id`、产品/规格快照、`quantity`、`return_date`、`destination`（`finished_goods`/`defective_goods`）、`reason`、`status`、`idempotency_key`、附件、备注及统一审计字段。

状态：`draft -> posted -> reversed`。过账后按去向生成正向库存事实；后续 E5 可继续处理退款或红冲。

### 3.3 `InventoryFact` 来源

- 出库：`inventory_category=finished_goods`，`source_type=finished_goods_outbound`，`quantity_delta` 为负数。
- 出库冲销：`finished_goods_outbound_reversal`，数量为正数。
- 客户退货回库：`finished_goods_customer_return`，分类 `finished_goods`，数量为正数。
- 客户退货转不良品：同一来源类型，分类 `defective_goods`，数量为正数。

## 4. 业务规则

1. 出库必须关联有效销售单、生产单和单位；生产单必须属于同一 `order_no`。
2. 当前可出库量由 `InventoryFact` 的 `finished_goods` 汇总计算；出库后不得为负。
3. 计划量风险按销售单数量优先、生产单计划量兜底；超发不自动阻塞，但必须携带原因并记录告警事实。
4. 每次出库过账在同一事务中更新单据状态、写入负向库存事实和审计事件；重复请求不得重复扣库存。
5. 发货、签收资料更新不写库存事实；签收时间不得早于发货时间。
6. 客户退货数量大于零，退货去向必选；回库/不良品均增加对应库存类别，不能直接恢复原出库单。
7. 出库冲销前必须检查成品库存足以恢复数量；退货冲销前必须检查对应去向库存足够扣减。

## 5. API 草案

### 成品出库

- `GET /api/v1/finished-goods/outbounds?order_no=`
- `POST /api/v1/finished-goods/outbounds`
- `POST /api/v1/finished-goods/outbounds/:id/post`
- `PATCH /api/v1/finished-goods/outbounds/:id/shipping`
- `POST /api/v1/finished-goods/outbounds/:id/sign`
- `POST /api/v1/finished-goods/outbounds/:id/reverse`

### 客户退货

- `GET /api/v1/finished-goods/customer-returns?order_no=`
- `POST /api/v1/finished-goods/customer-returns`
- `POST /api/v1/finished-goods/customer-returns/:id/post`
- `POST /api/v1/finished-goods/customer-returns/:id/reverse`

所有接口返回 `{ data, meta }`，使用 `warehouse` 权限，数量采用十进制字符串。

## 6. 验收标准

- 成品库存 10 件时可分两次出库 4+6，第三次出库被拒绝。
- 出库累计超计划量时要求原因并保留风险，仍不产生负库存。
- 发货和签收资料可更新，签收早于发货被拒绝，资料更新不重复扣库存。
- 客户退货可分别回成品库或不良品库；不修改原出库单。
- 出库/退货冲销均生成反向事实，余额恢复且不可重复冲销。
- `order_no`、操作人、时间、附件和审计事件全程可追溯。

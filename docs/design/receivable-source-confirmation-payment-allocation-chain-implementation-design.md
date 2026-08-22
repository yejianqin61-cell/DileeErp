# E4 应收来源、应收确认、收款与核销链路开发设计

## 1. 目标与边界

本链路承接 E3 已过账成品出库事实：

```text
成品出库 -> 应收来源草稿 -> 财务确认应收 -> 分批/一次性收款 -> 多对多核销 -> 应收余额
```

E4 只实现销售出库产生的应收、确认、收款和核销。退款、红冲、折让、坏账、对账单和订单关闭提示由 E5 实现；不接银行接口、不实现会计总账。

## 2. 设计原则

- `order_no` 是财务追溯主线；应收来源必须关联出库单、销售单、客户和订单号。
- 来源金额使用出库时销售单的价格、税率、币种快照；后续销售单修改不静默改写已生成来源。
- 应收来源、收款和核销都是不可物理删除的业务事实；更正使用取消、冲销或 E5 独立调整。
- 一笔付款可分配给多笔应收来源，一笔应收来源可由多笔付款分批核销。
- 累计核销不得超过应收可核销余额或收款可分配余额；超额核销必须阻断。
- 所有确认、收款过账和核销分配在事务内完成，并记录操作人、时间、原因和审计事件。

## 3. 数据模型

### 3.1 `ReceivableSource`

每笔成品出库对应一条应收来源，字段：`id`、`source_no`、`order_no`、`sales_order_id`、`outbound_id`、`customer_id`、数量、单位、单价、税率、金额、币种、发货/签收快照、`status`、`due_date`、发票字段、备注、统一审计字段。`outbound_id` 唯一，避免重复来源。

状态：`draft -> confirmed -> partially_paid -> paid -> closed`，支持 `cancelled`；E5 负责红冲/退款等独立调整。

### 3.2 `CustomerPayment`

收款事实，字段：`id`、`payment_no`、`customer_id`、`order_no` 可选、收款日期、金额、币种、收款方式、银行流水号、收款人、附件、`status`、备注和审计字段。

状态：`draft -> posted -> reversed`。过账后不可编辑金额。

### 3.3 `ReceivableAllocation`

核销分配明细，字段：`id`、`payment_id`、`receivable_source_id`、分配金额、币种、备注、审计字段。对 `(payment_id, receivable_source_id)` 建唯一约束，允许同一对通过独立冲销记录更正，不物理删除。

## 4. 金额与状态规则

1. 来源金额默认 `outbound.quantity * sales_order.unit_price`；若销售单无单价，来源创建必须要求财务填写确认金额和原因。
2. 税率、币种、含税/未税和金额均保存快照，使用 Decimal(18,4) 和 API 十进制字符串。
3. 只有 `confirmed`、`partially_paid` 的来源可核销；草稿来源不能收款。
4. 付款过账时，分配金额之和不得大于付款金额；每个来源分配不得超过其未核销余额；币种不一致必须阻断。
5. 分配成功后按累计核销金额更新来源状态：`confirmed -> partially_paid -> paid`；付款本身标记 `posted`。
6. 收款允许先登记草稿，但没有分配的已过账收款必须标记为 `unallocated`，不得自动冲抵任何订单。
7. 来源取消、付款冲销和核销更正均保留原始事实，E5 的退款/红冲可消费这些状态。

## 5. API 草案

### 应收来源

- `GET /api/v1/finance/receivable-sources?order_no=&customer_id=&status=`
- `POST /api/v1/finance/receivable-sources/from-outbound/:outbound_id`
- `POST /api/v1/finance/receivable-sources/:id/confirm`
- `POST /api/v1/finance/receivable-sources/:id/cancel`
- `GET /api/v1/finance/receivable-sources/:id/impact-preview`

### 收款与核销

- `GET /api/v1/finance/customer-payments?order_no=&customer_id=`
- `POST /api/v1/finance/customer-payments`
- `POST /api/v1/finance/customer-payments/:id/post`，请求携带 allocations
- `POST /api/v1/finance/customer-payments/:id/reverse`

统一使用 `{ data, meta }`，财务权限为 `finance`，数量/金额不使用浮点数。

## 6. 验收标准

- 一笔成品出库只产生一个应收来源，来源金额保留销售价格快照。
- 未确认来源不能核销；确认后可由多笔收款分批核销。
- 一笔收款可核销多个来源；分配合计不得超过收款金额。
- 任一来源累计核销不得超过应收金额；超额请求事务回滚。
- 来源状态正确推进至部分收款/已收清；未分配收款可查询。
- 所有事实保留 `order_no`、出库单号、客户、操作人、时间和审计日志。

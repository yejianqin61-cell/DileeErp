# E5 应收退款、红冲、调整、对账与订单关闭提示链路开发设计

## 1. 目标与边界

本链路承接 E4 已确认应收、收款和核销事实：

```text
应收/收款事实 -> 退款/红冲/折让/坏账调整 -> 应收净额
应收、收款、调整、出库 -> 对账记录 -> 订单关闭条件提示
```

E5 不修改历史应收、收款、核销和出库事实，不接银行/会计总账，不自动关闭订单。订单关闭提示为只读建议，最终关闭仍由销售操作员按权限执行。

## 2. 数据模型

### 2.1 `ReceivableAdjustment`

独立调整事实：`adjustment_no`、`order_no`、客户、应收来源（可选）、类型（`refund`、`red_credit`、`discount`、`bad_debt`、`correction`）、金额、币种、原因、发生日期、状态、附件、审计字段。调整金额统一为正数，`effect` 为 `decrease` 或 `increase`；退款/红冲/折让/坏账默认减少应收，补收/更正可增加应收。

状态：`draft -> posted -> reversed`。

### 2.2 `ReceivableReconciliation`

对账事实：订单号、客户、对账期间、应收金额快照、收款金额快照、调整金额快照、系统余额、外部余额、差异、状态（`pending`、`matched`、`difference`、`resolved`）、备注、附件和审计字段。对账记录不反写财务余额。

## 3. 规则

1. 调整只能关联有效应收来源或明确的订单号；退款/红冲不得超过该来源当前净未核销余额，补收不得造成金额格式错误。
2. 调整过账与冲销均写独立事实，净应收 = 来源金额 + increase - decrease；已确认收款事实不被改写。
3. 对账快照必须在创建时保存，差异为 `system_balance - external_balance`，差异允许保存但必须标记。
4. 订单关闭提示至少检查：生产/成品出库完成、应收净额已收清、无未处理对账差异、无未冲销财务调整；只返回阻塞原因，不自动变更订单状态。
5. 所有金额 Decimal(18,4)，所有操作保留 `order_no`、关联单号、操作人、时间、附件和审计事件。

## 4. API

- `GET/POST /api/v1/finance/receivable-adjustments`
- `POST /api/v1/finance/receivable-adjustments/:id/post`
- `POST /api/v1/finance/receivable-adjustments/:id/reverse`
- `GET/POST /api/v1/finance/reconciliations`
- `GET /api/v1/finance/order-close-preview?order_no=`

统一认证、`finance` 权限和 `{ data, meta }` 响应。

## 5. 验收标准

- 退款、红冲、折让和补收均生成独立调整事实，原应收/收款记录不变。
- 调整过账与冲销准确影响净应收；超余额退款被拒绝。
- 对账差异可保存、查询、标记解决，不修改系统余额。
- 订单关闭预览明确返回收款余额、对账差异和未处理调整原因。
- 单元测试、API 类型检查、构建通过；真实数据库/API/浏览器验证未具备时明确记录。

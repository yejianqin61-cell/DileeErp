# C6 应付确认、付款与核销链路开发设计

> 文档类型：跨模块纵向链路开发设计文档
>
> 链路：原料入库/外加工签收应付来源 -> 应付确认 -> 供应商付款 -> 分批/多对多核销
>
> 依赖：C4 原料入库应付来源、D6 外加工签收应付来源、A1-A3 平台契约

## 1. 目标与边界

C6 完成采购侧财务闭环。它消费已形成的厂内原料入库应付来源和外加工签收应付来源，生成可确认的应付事实，记录供应商分批付款，并支持一笔付款核销多笔应付、一笔应付由多笔付款核销。

```text
PayableSource / OutsourcePayableSource
        -> SupplierPayableEntry（应付确认快照）
        -> SupplierPayment（供应商付款）
        -> SupplierPaymentAllocation（多对多核销）
```

C6 不修改采购单、入库、外加工签收或原始应付来源，不接银行自动对账、会计总账、发票自动验真和工资支付。退款、红冲、折让等应付调整留给后续对称财务链路；已确认事实只能通过冲销或独立调整更正。

## 2. 统一业务规则

1. 每条有效应付来源最多生成一条有效应付确认入口；重复请求必须幂等返回已有记录。
2. 来源必须是厂内原料入库过账产生的 `PayableSource`，或外加工签收产生的 `OutsourcePayableSource`，且来源状态不能是 `voided`。
3. 应付确认保存来源数量、单价、税率、金额、币种、供应商和 `order_no` 快照；后续来源变化不静默改写快照。
4. 应付金额使用 Decimal(18,4)，金额大于零；付款金额也必须大于零，币种和供应商必须与核销的应付一致。
5. 付款先建立草稿，过账时才写入有效核销；付款可部分核销，也可保留未分配余额。
6. 单笔核销不得超过付款剩余金额或应付未核销余额；同一付款与同一应付只能有一条有效核销记录。
7. 应付、付款和核销状态变更必须在事务内完成，并保留操作人、时间、原因和审计事件。
8. 冲销只改变当前事实状态并写审计，不物理删除、不修改原始来源金额；冲销核销后重新计算应付状态。
9. 所有查询、详情、风险提示和下游报表都保留 `order_no`。采购单号、入库单号、外加工批次号、应付单号和付款单号只是派生编号。

## 3. 核心对象

### 3.1 `SupplierPayableEntry`

统一的应付确认快照。字段包括：`payable_no`、`order_no`、供应商、来源类型和来源 ID、来源单号、数量、单位、单价、税率、金额、币种、确认日期、状态、附件、备注和统一审计/软删除字段。

来源类型为 `raw_material_inbound` 或 `outsource_receipt`。数据库通过两个可选外键分别关联两类来源；应用层强制两者恰好一个非空，并保证来源唯一。

状态：`draft -> confirmed -> partially_paid -> paid`；`confirmed/partially_paid` 可冲销为 `reversed`。草稿可逻辑删除，已确认事实不可直接删除。

### 3.2 `SupplierPayment`

供应商付款事实。字段包括：`payment_no`、`order_no`（可选，跨订单付款时为空）、供应商、付款日期、金额、币种、付款方式、银行流水号、付款人、状态、附件、备注和审计字段。

状态：`draft -> posted -> reversed`。过账后金额不可编辑；更正通过冲销和新付款完成。

### 3.3 `SupplierPaymentAllocation`

付款与应付的核销事实。字段包括：付款 ID、应付 ID、`order_no`、核销金额、币种、状态、备注和审计字段。状态为 `active -> reversed`，唯一约束保证同一付款/应付组合不重复生成有效分配。

## 4. 金额与状态计算

```text
应付未核销 = 应付确认金额 - 有效且已过账核销金额
付款未分配 = 付款金额 - 有效核销金额
```

应付状态由有效核销汇总派生：无核销为 `confirmed`，部分核销为 `partially_paid`，核销达到应付金额为 `paid`。付款状态为 `unallocated` 或 `posted` 不代表应付已收清，必须以核销事实为准。

所有计算使用 Prisma Decimal，不使用 JavaScript `Number`。

## 5. 更正与影响预览

- 来源被冲销或作废时，已确认应付不得静默变更；系统返回受影响的应付单、已付款、已核销和待处理风险。
- 应付确认冲销前必须检查已有核销；存在核销时阻止直接冲销，先要求冲销相关核销或走后续调整流程。
- 付款冲销必须在同一事务内将有效核销标记为 `reversed`，再恢复相关应付状态。
- 任何编辑/冲销操作必须要求原因，并记录前后状态、金额、来源、订单号和操作人。

## 6. REST API

统一前缀 `/api/v1/finance`，认证、`finance` 模块权限和 `{ data, meta }` 响应。

```text
GET  /payable-entries?order_no=&supplier_id=&status=
GET  /payable-entries/:id
POST /payable-entries/from-source
POST /payable-entries/:id/confirm
POST /payable-entries/:id/reverse
GET  /supplier-payments?order_no=&supplier_id=&status=
GET  /supplier-payments/:id
POST /supplier-payments
POST /supplier-payments/:id/post
POST /supplier-payments/:id/reverse
GET  /payable-order-summary?order_no=
```

`from-source` 接受 `source_type` 和来源 ID，可选覆盖应付金额但必须填写原因；确认前返回来源快照和风险。付款过账接受核销明细数组，服务端重新校验所有余额和币种。

## 7. 验收标准

1. 两类应付来源都可以幂等生成应付确认，且来源事实不被改写。
2. 应付确认、付款和核销支持分批、多对多，禁止超额核销。
3. 付款冲销能恢复应付未核销余额和应付状态；应付冲销有下游核销门禁。
4. 所有关键操作保留 `order_no`、来源 ID、操作人、时间、原因和审计事件。
5. API 类型检查、构建、领域/HTTP 测试通过；真实 PostgreSQL/API/浏览器环境不可用时必须明确记录阻断。


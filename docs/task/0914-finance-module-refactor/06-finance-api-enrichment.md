# Task 06：财务列表字段富化与应付款项关联修复

## 状态
已完成

## 认领
负责人：全栈 Agent
开始日期：2026-09-14

## 目标

让财务列表能被人读懂（客户/供应商名称、出库单号、物料、已收付/未收付），
并修掉「按采购单对账永远为空」的写入缺陷。

## 关联决策

- 宪法 / 财务规格：列表以订单号、来源编号、客户/供应商名称和批次展示，UUID 仅作内部关联键；
- `docs/design/finance-module-refactor-2026-09-14.md` 第 4 节。

## 范围

| 接口 | 新增字段 |
| --- | --- |
| `GET /finance/receivable-sources` | `customer`、`outbound`、`allocated_amount`、`outstanding_amount` 及扁平派生字段 |
| `GET /finance/customer-payments` | `customer`、`allocations.receivableSource`、`allocated_amount` |
| `GET /finance/payable-entries` | `supplier`、`paid_amount`、`outstanding_amount` |
| `GET /finance/supplier-payments` | `supplier`、`allocated_amount` |
| `GET /finance/reconciliations` | `customer` |
| `SupplierPayableService.createFromSource` | 落库 `purchaseOrderId / purchaseOrderItemId / outsourceLogisticsBatchId` |

## 不做

- 不改任何金额计算与状态机；
- 不新增接口，只做 `include` 与派生字段。

## 验收与验证

1. 已付/未付口径全站统一为「有效核销 + 已过账付款」：草稿付款与已冲销核销都不计入（单测断言）；
2. 应收来源列表带出客户名与出库单号（组件测试断言）；
3. 应付创建落库采购单关联（单测断言 raw_material_inbound 与 outsource_receipt 两条路径）。

## 决策记录

- 派生字段既给嵌套对象（`customer`/`supplier`/`outbound`）也给扁平别名（`customer_name` 等）：
  嵌套对象让前端可以展示更多字段，扁平别名让列表列定义不必层层空判；
- 口径统一写在各自 service 的 `list` 里而不是前端算：前端算会与详情页、对账页各算一遍，必然漂移。

## 完成记录

- 修改：`receivable.service.ts`、`customer-payment.service.ts`、`supplier-payable.service.ts`、
  `supplier-payment.service.ts`；修好因新增字段而失效的 1 条列表单测并补强为 3 条断言。
- 验证结果：api typecheck 通过；`test:unit:api` 908/908 通过。
- 遗留：应付来源列表自身没有「已接收」标记（前端靠正式应付条目是否引用它来判断），见设计文档未决事项。

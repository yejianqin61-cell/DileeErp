# 单号外键盘点：27 张只冗余单号的表

日期：2026-10-27
依据：[改进计划](agent-tool-uid-root-improvement-plan-2026-10-27.md)阶段 5
复核方式：`schema.prisma` 里带 `@map("order_no")` 的模型 40 个，其中 15 个已有 `sales_order_id`，
差集 29 个，去掉 `AuditEvent` 与 `SalesOrder` 得 27 个。

## 为什么这 27 张要补外键

它们的 `order_no` 是一段**文本副本**，不是关系。改号时必须逐张扫过去改文本，漏一张就静默丢关联
（`sales-order-order-no.ts` 的 38 项登记表就是为这件事存在的）。补上 `sales_order_id` 后，
关系由外键保证，改号只影响显示文本。

## 清单（按链路）

| 表 | 中文名 | 链路 | 写入点 |
|---|---|---|---|
| `purchase_receipts` | 到货记录 | 采购 | `procurement/purchase-orders.service.ts` |
| `incoming_inspections` | 进料质检 | 采购 | `procurement/incoming-inspections.service.ts` |
| `raw_material_inbound_notices` | 原料入库通知 | 采购 | `procurement/raw-material-inbound-notices.service.ts` |
| `raw_material_inbounds` | 原料入库 | 采购 | `procurement/raw-material-inbounds.service.ts` |
| `payable_sources` | 应付来源 | 采购 | `procurement/raw-material-inbounds.service.ts` |
| `outsource_logistics_batches` | 外加工批次 | 外协 | `production/outsource-logistics.service.ts` |
| `outsource_receipts` | 外加工签收 | 外协 | `production/outsource-logistics.service.ts` |
| `outsource_payable_sources` | 外加工应付来源 | 外协 | `production/outsource-logistics.service.ts` |
| `outsource_return_transfers` | 外加工退货调拨 | 外协 | `production/outsource-logistics.service.ts` |
| `outsource_direct_shipments` | 外加工直发 | 外协 | `production/outsource-logistics.service.ts` |
| `raw_material_movements` | 领料/退料/报废单 | 生产 | `production/raw-material-movements.service.ts` |
| `operation_daily_reports` | 工序日报 | 生产 | `production/operation-daily-reports.service.ts` |
| `employee_daily_reports` | 员工计件日报 | 生产 | `production/employee-daily-reports.service.ts` |
| `production_daily_alerts` | 生产异常告警 | 生产 | `production/daily-report-alerts.ts` |
| `production_payroll_sources` | 生产薪资来源 | 生产 | `production/employee-daily-reports.service.ts` |
| `inventory_facts` | 库存事实 | 库存 | `procurement/raw-material-inbounds.service.ts`、`production/raw-material-movements.service.ts` |
| `finished_goods_inspection_submissions` | 成品送检单 | 成品 | `production/finished-goods-qc.service.ts` |
| `finished_goods_qc_records` | 成品 QC 记录 | 成品 | `production/finished-goods-qc.service.ts` |
| `finished_goods_inbound_notices` | 成品入库通知 | 成品 | `production/finished-goods-inbound-notices.service.ts` |
| `finished_goods_inbounds` | 成品入库 | 成品 | `warehouse/finished-goods-inventory.service.ts` |
| `finished_goods_defectives` | 成品次品 | 成品 | `warehouse/finished-goods-inventory.service.ts` |
| `supplier_payable_entries` | 应付台账 | 财务 | `finance/supplier-payable.service.ts` |
| `supplier_payments` | 付款单 | 财务 | `finance/supplier-payment.service.ts` |
| `supplier_payment_allocations` | 付款核销明细 | 财务 | `finance/supplier-payment.service.ts` |
| `supplier_payable_reconciliations` | 应付对账单 | 财务 | `finance/supplier-payable-reconciliation.service.ts` |
| `cash_flow_entries` | 现金流分录 | 财务 | `finance/cash-flow.service.ts` |
| `payroll_payable_entries` | 工资应付台账 | 财务 | `hr/payroll-payable.service.ts` |

## 两条豁免

| 模型 | 理由 |
|---|---|
| `AuditEvent` | 审计事件流记的是「当时发生了什么」，旧号必须留在事件里 |
| `SalesOrder` | 源头本身，它就是被指向的那张单 |

## 回填口径

统一按值关联，只认未软删的销售单：

```sql
UPDATE "<table>" t SET "sales_order_id" = s."id"
FROM "sales_orders" s
WHERE t."order_no" = s."order_no" AND s."deleted_at" IS NULL AND t."sales_order_id" IS NULL;
```

对不上任何销售单的行保持 `NULL`。两类已知会留空：
`cash_flow_entries` 与 `supplier_payable_entries` 的订单号可以手填。

## 不在本轮范围

写入点没有改：新行仍然不填 `sales_order_id`，靠回填只覆盖历史。写入点在阶段 6 一起改，
否则要么改一半（新行永远 NULL），要么要求所有服务同时上线。

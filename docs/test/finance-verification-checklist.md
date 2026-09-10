# 财务改进动态验收清单

> 用途：终端和测试环境恢复后，按本清单逐项验证 F-01 到 F-11。  
> 原则：每项必须记录命令、结果、DB 断言和证据文件。  
> 当前状态：待执行。

## 0. 环境准备

```bash
cd /Users/user/Desktop/Dilee

npm run db:generate --workspace=@dilee/api
npm run typecheck
npm run build

TEST_DATABASE_URL=... npm run db:test:prepare
TEST_DATABASE_URL=... npm run test:integration
API_BASE_URL=... npm run test:api
PLAYWRIGHT_BASE_URL=... npm run test:e2e
```

通过标准：

```text
所有命令退出码为 0
无 skipped 阻断项
```

## 1. 工资：车间日报到工资台账

### 1.1 数据准备

- 创建车间员工 `workshop`；
- 创建生产单；
- 创建生产工序；
- 创建员工日报；
- 确认工资台账。

### 1.2 API

```http
POST /api/v1/production/employee-daily-reports
POST /api/v1/hr/payroll-ledgers/generate
POST /api/v1/hr/payroll-ledgers/:id/confirm
GET  /api/v1/hr/payroll-ledgers
```

### 1.3 DB 断言

```sql
SELECT production_source_amount
FROM payroll_ledgers
WHERE id = :ledger_id;

SELECT amount, source_snapshot
FROM production_payroll_sources
WHERE employee_id = :employee_id
  AND deleted_at IS NULL;
```

通过标准：

```text
工资台账 production_source_amount = 员工日报累计金额
工资台账 source_snapshot 包含日报 ID 和金额
```

## 2. 工资：日报修改后台账联动

### 2.1 操作

- 修改员工日报数量或单价；
- 重新读取工资台账。

### 2.2 预期

```text
draft 工资台账 production_source_amount 自动更新
confirmed 工资台账状态变为 expired
partially_paid / paid 工资台账不自动改写
```

### 2.3 DB 断言

```sql
SELECT status, production_source_amount
FROM payroll_ledgers
WHERE employee_id = :employee_id
  AND period_start <= :report_date
  AND period_end >= :report_date;
```

## 3. 工资：日期范围统计

### 3.1 API

```http
GET /api/v1/hr/payroll-ledgers?from=2026-01-01&to=2026-01-31
```

### 3.2 预期

```text
只返回与查询期间重叠的工资台账
每条台账返回 payableAmount、paidAmount、outstandingAmount
```

## 4. 工资：工资应付

### 4.1 操作

- 确认工资台账；
- 生成工资应付；
- 确认工资应付。

### 4.2 API

```http
POST /api/v1/hr/payroll-ledgers/:id/payable
POST /api/v1/hr/payroll-payables/:id/confirm
GET  /api/v1/hr/payroll-payables
```

### 4.3 DB 断言

```sql
SELECT amount, status, ledger_id
FROM payroll_payable_entries
WHERE ledger_id = :ledger_id;
```

通过标准：

```text
同一台账只有一条有效工资应付
工资应付金额 = 台账实发金额
状态为 confirmed
```

## 5. 工资：工资付款与核销

### 5.1 正常场景

```http
POST /api/v1/hr/salary-payments
POST /api/v1/hr/salary-payments/:id/post
```

请求体必须包含 `ledger_id`，后端自动关联工资应付。

### 5.2 异常场景

```text
没有工资应付     -> PAYROLL_PAYABLE_REQUIRED
工资应付 draft   -> PAYROLL_PAYABLE_NOT_ALLOCATABLE
金额不一致       -> PAYROLL_PAYABLE_AMOUNT_MISMATCH
超过未付余额     -> SALARY_ALLOCATION_EXCEEDED
重复核销同一台账 -> DUPLICATE_SALARY_ALLOCATION
```

### 5.3 DB 断言

```sql
SELECT status, payroll_payable_id, amount
FROM salary_payment_allocations
WHERE ledger_id = :ledger_id;

SELECT status
FROM payroll_payable_entries
WHERE ledger_id = :ledger_id;
```

通过标准：

```text
付款分配同时有 ledger_id 和 payroll_payable_id
付款过账后工资应付状态为 partially_paid 或 paid
```

## 6. 工资付款冲销

### 6.1 操作

```http
POST /api/v1/hr/salary-payments/:id/reverse
```

### 6.2 预期

```text
付款分配状态变为 reversed
工资应付状态恢复为 confirmed 或 partially_paid
工资台账状态恢复
```

## 7. 应收：成品出库自动生成应收

### 7.1 操作

- 创建并过账成品出库；
- 查询应收来源。

### 7.2 API

```http
POST /api/v1/finished-goods/outbounds
POST /api/v1/finished-goods/outbounds/:id/post
GET  /api/v1/finance/receivable-sources?order_no=:orderNo
```

### 7.3 DB 断言

```sql
SELECT outbound_id, amount, status, unit_price
FROM receivable_sources
WHERE outbound_id = :outbound_id;
```

通过标准：

```text
一笔出库只有一条应收来源
金额 = 出库数量 × 销售单价
状态为 draft
```

## 8. 应收：详情追溯和影响预览

### 8.1 API

```http
GET /api/v1/finance/receivable-sources/:id
GET /api/v1/finance/receivable-sources/:id/impact-preview
```

### 8.2 预期

```text
详情可追溯 outbound -> productionOrder -> finishedGoodsInspections
impact-preview 返回 source_trace.outbound
impact-preview 返回 source_trace.qc_records
impact-preview 返回 source_trace.finished_goods_inbounds
```

## 9. 应收：出库冲销保护

### 9.1 草稿应收

```text
出库冲销
-> 应收来源自动取消
-> 生成反向库存事实
```

### 9.2 已确认应收

```text
出库冲销
-> 被拒绝
-> 错误码 OUTBOUND_REVERSAL_HAS_RECEIVABLE
```

### 9.3 已有有效收款核销

```text
出库冲销
-> 被拒绝
-> 错误码 OUTBOUND_REVERSAL_HAS_RECEIVABLE_PAYMENTS
```

## 10. 应付：采购到货、QC、入库、应付

### 10.1 到货后

```sql
SELECT COUNT(*) FROM payable_sources
WHERE purchase_receipt_id = :receipt_id
  AND status <> 'voided';
```

通过标准：

```text
0
```

### 10.2 QC 后

```text
有效应付数量仍为 0
```

### 10.3 入库草稿后

```text
有效应付数量仍为 0
```

### 10.4 入库过账后

```sql
SELECT quantity, unit_price, amount, qc_result,
       accepted_quantity, conditional_quantity, rejected_quantity,
       actual_inbound_quantity, settlement_total_amount,
       settlement_amount_reason
FROM payable_sources
WHERE raw_material_inbound_id = :inbound_id
  AND status <> 'voided';
```

通过标准：

```text
有且仅有 1 条有效应付来源
quantity = actual_inbound_quantity
qcResult、accepted、conditional、rejected、实际入库数量完整
全部入库金额 = 数量 × 采购单价
部分入库金额 = 人工填写结算总价
拒收无应付
```

## 11. 应付：入库冲销保护

### 11.1 只有 pending 应付来源

```text
入库冲销
-> 应付来源作废
-> draft 应付条目作废
-> 生成反向库存事实
```

### 11.2 应付已确认

```text
入库冲销
-> 被拒绝
-> 错误码 INBOUND_PAYABLE_ALREADY_CONFIRMED
```

### 11.3 已有有效付款核销

```text
入库冲销
-> 被拒绝
-> 错误码 INBOUND_PAYABLE_HAS_PAYMENT
```

### 11.4 正确顺序

```text
付款冲销
-> 应付冲销
-> 入库冲销
-> 成功
```

## 12. 对抗性审查复验

### 12.1 并发场景

- 同一付款并发过账；
- 同一入库并发过账；
- 同一 QC 并发累计；
- 同一日报并发登记。

通过标准：

```text
不产生重复库存事实
不产生重复应付来源
不产生重复核销
不产生负库存
```

### 12.2 幂等场景

- 重复提交同一到货；
- 重复提交同一入库过账；
- 重复提交同一付款过账；
- 重复提交同一应收生成。

通过标准：

```text
业务事实数量不增加
返回已有记录或明确冲突错误
```

### 12.3 审计场景

- 回退；
- 冲销；
- 金额覆盖；
- 付款冲销；
- 工资应付回退。

通过标准：

```text
每条操作有原因
有操作人、时间、前后状态
有 AuditEvent
```

## 13. 验收证据归档

每项测试必须归档：

```text
docs/test/results/finance-<task>-<date>.md
```

至少记录：

```text
提交号
命令
环境
通过/失败数量
DB 断言结果
阻断原因
遗留风险
```

## 14. 最终提交

按：

```text
docs/design/finance-commit-plan.md
```

执行独立提交。

每个提交前确认：

```text
只包含本任务文件
本任务测试通过
没有临时文件
符合 Conventional Commit
```

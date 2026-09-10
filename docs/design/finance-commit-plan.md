# 财务改进任务提交计划

> 目标：F-01 到 F-11 每个任务独立提交，使用 Conventional Commit。  
> 注意：多个任务修改了同一文件，需要使用 `git add -p` 或等价方式按 hunk 提交。

## 提交顺序与文件映射

### 1. F-01 薪资台账范围查询

```text
feat(hr): support payroll ledger period range queries
```

包含：

- `apps/api/src/modules/hr/payroll-ledger.service.ts`
  - `list()` 支持 `from/to`
  - `payableAmount`
  - `paidAmount`
  - `outstandingAmount`
- `apps/api/src/modules/hr/hr.controller.ts`
  - `payroll-ledgers` 增加 `from`、`to`
- `apps/api/test/unit/payroll-ledger-service.test.cjs`
  - 新增范围汇总测试

---

### 2. F-02 工资总览金额与状态展示

```text
feat(web): show payroll paid and outstanding amounts
```

包含：

- `apps/web/app/finance/salary/page.tsx`
  - 服务端 `from/to`
  - 应发、已付、未付列
  - 状态中文映射
  - 过期提示

---

### 3. F-03 工资应付模型与生命周期

```text
feat(hr): add payroll payable entry model and lifecycle
```

包含：

- `apps/api/prisma/schema.prisma`
  - `PayrollPayableEntry`
  - `Employee.payrollPayables`
  - `PayrollLedger.payableEntry`
- `apps/api/prisma/migrations/20260906120000_payroll_payable_entries/migration.sql`
- `apps/api/src/modules/hr/payroll-payable.service.ts`
- `apps/api/src/modules/hr/hr.controller.ts`
  - `payroll-payables` 路由
- `apps/api/src/modules/hr/hr.module.ts`
- `apps/api/test/unit/payroll-payable-service.test.cjs`

---

### 4. F-04 工资付款与工资应付联动

```text
feat(hr): link payroll payable rollback with ledger and payments
```

包含：

- `apps/api/src/modules/hr/payroll-payable.service.ts`
  - `refreshStatusForLedger()`
- `apps/api/src/modules/hr/salary-payment.service.ts`
  - 工资付款过账、冲销后刷新工资应付
- `apps/api/test/unit/payroll-payable-service.test.cjs`
  - 付款分配驱动应付状态测试

---

### 5. F-05 成品出库冲销与应收保护

```text
fix(warehouse): guard finished goods outbound reversal with receivable state
```

包含：

- `apps/api/src/modules/warehouse/finished-goods-outbound.service.ts`
- `apps/api/test/unit/finished-goods-outbound-service.test.cjs`

---

### 6. F-06 应收来源追溯到出库/QC

```text
feat(finance): trace receivable rollback to outbound and qc
```

包含：

- `apps/api/src/modules/finance/receivable.service.ts`
  - 详情追溯
  - `impactPreview.source_trace`
- `apps/api/test/unit/receivable-service.test.cjs`

---

### 7. F-07 原料入库冲销与应付/付款保护

```text
fix(procurement): guard raw material inbound reversal with payable and payment state
```

包含：

- `apps/api/src/modules/procurement/raw-material-inbounds.service.ts`
  - `reverse()` 应付/付款门禁
  - draft 应付条目作废
  - `impactPreview()` 应付信息
- `apps/api/test/unit/raw-material-inbounds-service.test.cjs`

---

### 8. F-08 入库结算快照写入应付来源

```text
feat(procurement): snapshot inbound settlement into payable source
```

包含：

- `apps/api/prisma/schema.prisma`
  - `PayableSource.materialId`
  - `settlementUnitPrice`
  - `settlementTotalAmount`
  - `settlementAmountReason`
- `apps/api/prisma/migrations/20260906130000_payable_settlement_snapshot/migration.sql`
- `apps/api/src/modules/procurement/raw-material-inbounds.service.ts`
  - 全部入库/部分入库结算金额计算
  - 应付来源快照
- `apps/api/test/unit/raw-material-inbounds-service.test.cjs`
  - 全部入库、部分入库快照测试

---

### 9. F-09 QC 三结果与部分入库结算

```text
feat(procurement): support qc all-inbound, rejected and partial-inbound settlement
```

包含：

- `apps/api/src/modules/procurement/incoming-inspections.controller.ts`
  - `qc_result` 枚举
- `apps/api/src/modules/procurement/incoming-inspections.service.ts`
  - QC 结果派生
- `apps/api/src/modules/procurement/raw-material-inbounds.service.ts`
  - 拒收禁止入库
  - 部分入库结算字段校验
- `apps/web/app/procurement/page.tsx`
  - QC 三结果表单
  - 部分入库结算字段
- `apps/api/test/unit/raw-material-inbounds-service.test.cjs`

---

### 10. F-10 QC/入库结算与应付金额一致性

```text
feat(finance): keep payable amounts consistent with qc and inbound settlement
```

包含：

- `apps/api/prisma/schema.prisma`
  - `PayableSource.qcResult`
  - `acceptedQuantity`
  - `conditionalQuantity`
  - `rejectedQuantity`
  - `actualInboundQuantity`
- `apps/api/prisma/migrations/20260906140000_payable_qc_snapshot/migration.sql`
- `apps/api/src/modules/procurement/raw-material-inbounds.service.ts`
  - 写入 QC 快照
- `apps/api/test/unit/raw-material-inbounds-service.test.cjs`

---

### 11. F-11 对抗性审查与工资付款强制应付修复

F-11 本身是审查和修复，建议拆成两个提交。

#### 11a 违反审查、静态报告

```text
test(finance): add adversarial review for payroll receivable and payable chains
```

包含：

- `docs/test/results/finance-adversarial-review.md`
- `docs/design/finance-audit-improvement-plan.md`
- `docs/design/finance-commit-plan.md`

#### 11b 工资付款强制核销工资应付

```text
fix(hr): require payroll payable before salary payment allocation
```

包含：

- `apps/api/prisma/schema.prisma`
  - `SalaryPaymentAllocation.payrollPayableId`
  - `PayrollPayableEntry.allocations`
- `apps/api/prisma/migrations/20260906150000_salary_allocation_payroll_payable/migration.sql`
- `apps/api/src/modules/hr/salary-payment.service.ts`
  - 工资付款必须核销已确认工资应付
  - 金额一致性校验
- `apps/api/src/modules/hr/hr.module.ts`（如需依赖调整）
- `apps/web/app/finance/salary/page.tsx`
  - 生成工资应付
  - 确认工资应付
  - 展示工资应付状态
- `apps/api/test/unit/salary-payment-service.test.cjs`

## Hunk 拆分注意事项

以下文件被多个任务修改，必须按 hunk 提交：

### `apps/api/prisma/schema.prisma`

- F-03：`PayrollPayableEntry`、员工/台账关系
- F-08：`PayableSource` 结算字段
- F-10：`PayableSource` QC 快照
- 11b：`SalaryPaymentAllocation.payrollPayableId`

建议：

```bash
git add -p apps/api/prisma/schema.prisma
```

### `apps/api/src/modules/procurement/raw-material-inbounds.service.ts`

- F-07：冲销门禁
- F-08：应付快照金额
- F-09：拒收/部分入库校验
- F-10：QC 快照写入

建议：

```bash
git add -p apps/api/src/modules/procurement/raw-material-inbounds.service.ts
```

### `apps/api/test/unit/raw-material-inbounds-service.test.cjs`

- F-07：冲销测试
- F-08：全部入库/部分入库快照
- F-09：结算原因
- F-10：QC 快照

建议：

```bash
git add -p apps/api/test/unit/raw-material-inbounds-service.test.cjs
```

### `apps/api/src/modules/hr/hr.controller.ts`

- F-01：台账范围参数
- F-03：工资应付 API

建议：

```bash
git add -p apps/api/src/modules/hr/hr.controller.ts
```

### `apps/web/app/finance/salary/page.tsx`

- F-02：应发/已付/未付
- 11b：工资应付生成/确认/状态

建议：

```bash
git add -p apps/web/app/finance/salary/page.tsx
```

## 最终提交前检查

```bash
npm run db:generate --workspace=@dilee/api
npm run typecheck
npm run test:unit
TEST_DATABASE_URL=... npm run test:integration
API_BASE_URL=... npm run test:api
PLAYWRIGHT_BASE_URL=... npm run test:e2e
npm run release:verify
git status --short
```

所有任务必须满足：

- 代码、迁移、文档、测试一起提交；
- 不把多个任务混成一个提交；
- 提交信息符合 Conventional Commit；
- 提交前确认没有未跟踪的临时文件。

# 财务改进实现状态交接表

> 用途：终端恢复后按此表逐项验证和提交。  
> 当前状态：代码/文档/测试已写入，动态验证和提交未执行。  
> 环境阻塞：PTY shell exited during startup。

## 当前任务状态

| 任务 | 内容 | 代码 | 测试 | 迁移 | 动态验证 | 提交 |
|---|---|---|---|---|---|---|
| F-01 | 薪资台账范围查询 | 已写 | 已写 | 无 | 未执行 | 未提交 |
| F-02 | 工资总览金额展示 | 已写 | 前端 | 无 | 未执行 | 未提交 |
| F-03 | 工资应付模型 | 已写 | 已写 | 已写 | 未执行 | 未提交 |
| F-04 | 工资付款联动工资应付 | 已写 | 已写 | 已写 | 未执行 | 未提交 |
| F-05 | 出库冲销应收保护 | 已写 | 已写 | 无 | 未执行 | 未提交 |
| F-06 | 应收追溯出库/QC | 已写 | 已写 | 无 | 未执行 | 未提交 |
| F-07 | 入库冲销应付保护 | 已写 | 已写 | 无 | 未执行 | 未提交 |
| F-08 | 入库结算应付快照 | 已写 | 已写 | 已写 | 未执行 | 未提交 |
| F-09 | QC 三结果与部分入库 | 已写 | 已写 | 无 | 未执行 | 未提交 |
| F-10 | QC/入库/应付一致性 | 已写 | 已写 | 已写 | 未执行 | 未提交 |
| F-11 | 对抗性审查 | 已写 | 静态 | 无 | 未执行 | 未提交 |

## 关键文件

### API

```text
apps/api/src/modules/hr/payroll-ledger.service.ts
apps/api/src/modules/hr/payroll-payable.service.ts
apps/api/src/modules/hr/salary-payment.service.ts
apps/api/src/modules/hr/hr.controller.ts
apps/api/src/modules/hr/hr.module.ts
apps/api/src/modules/finance/receivable.service.ts
apps/api/src/modules/warehouse/finished-goods-outbound.service.ts
apps/api/src/modules/procurement/raw-material-inbounds.service.ts
apps/api/src/modules/procurement/incoming-inspections.service.ts
apps/api/src/modules/procurement/incoming-inspections.controller.ts
```

### Schema 与迁移

```text
apps/api/prisma/schema.prisma
apps/api/prisma/migrations/20260906100000_receive_only_payable_sources
apps/api/prisma/migrations/20260906120000_payroll_payable_entries
apps/api/prisma/migrations/20260906130000_payable_settlement_snapshot
apps/api/prisma/migrations/20260906140000_payable_qc_snapshot
apps/api/prisma/migrations/20260906150000_salary_allocation_payroll_payable
```

### Web

```text
apps/web/app/finance/salary/page.tsx
apps/web/app/procurement/page.tsx
```

### 文档

```text
docs/finance-11-point-audit.md
docs/design/finance-audit-improvement-plan.md
docs/design/finance-commit-plan.md
docs/test/finance-verification-checklist.md
docs/test/results/finance-adversarial-review.md
docs/test/results/finance-adversarial-review-round2.md
docs/test/results/finance-implementation-status.md
```

## 提交顺序

```text
1. feat(hr): support payroll ledger period range queries
2. feat(web): show payroll paid and outstanding amounts
3. feat(hr): add payroll payable entry model and lifecycle
4. feat(hr): link payroll payable rollback with ledger and payments
5. fix(warehouse): guard finished goods outbound reversal with receivable state
6. feat(finance): trace receivable rollback to outbound and qc
7. fix(procurement): guard raw material inbound reversal with payable and payment state
8. feat(procurement): snapshot inbound settlement into payable source
9. feat(procurement): support qc all-inbound, rejected and partial-inbound settlement
10. feat(finance): keep payable amounts consistent with qc and inbound settlement
11. test(finance): add adversarial review for payroll receivable and payable chains
12. fix(hr): require payroll payable before salary payment allocation
```

## 终端恢复后必须执行

```bash
npm run db:generate --workspace=@dilee/api
# 执行数据库迁移
npm run typecheck
npm run test:unit
TEST_DATABASE_URL=... npm run db:test:prepare
TEST_DATABASE_URL=... npm run test:integration
API_BASE_URL=... npm run test:api
PLAYWRIGHT_BASE_URL=... npm run test:e2e
npm run release:verify
```

## 未闭环风险

```text
1. 所有新增 Prisma 模型尚未生成 Client
2. 所有数据库迁移尚未执行
3. 所有动态测试尚未运行
4. 第二轮对抗性审查的动态复验尚未执行
5. 独立 Conventional Commit 尚未执行
```

## 最终验收标准

```text
类型检查通过
单元测试通过
PostgreSQL 集成测试通过
HTTP API 测试通过
Playwright 测试通过
release:verify 通过
所有任务独立提交
第二轮对抗性审查动态复验通过
```

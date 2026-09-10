# F-11 对抗性审查子 Agent 派发任务书

> 用途：全部财务改进任务实现完成后，派发独立子 Agent 进行对抗性审查。  
> 当前状态：等待终端和测试环境恢复。  
> 禁止：开发者自评代替审查结论。

## 1. 子 Agent 角色

```text
你是一个独立对抗性审查 Agent。
你不信任开发者的自评、提交信息和测试结论。
你必须直接检查代码、迁移、API、数据库行为和测试结果。
你的目标是找出状态不一致、金额不一致、重复事实、回退绕过和并发问题。
```

## 2. 审查范围

```text
F-01 薪资台账范围查询
F-02 工资总览金额展示
F-03 工资应付模型
F-04 工资付款联动工资应付
F-05 成品出库冲销应收保护
F-06 应收追溯到出库/QC
F-07 原料入库冲销应付保护
F-08 入库结算应付快照
F-09 QC 三结果与部分入库结算
F-10 QC/入库/应付一致性
第二轮审查 G/H/I/J/K/L
工资付款强制核销工资应付
```

## 3. 必须阅读的文件

### 代码

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

### 数据模型与迁移

```text
apps/api/prisma/schema.prisma
apps/api/prisma/migrations/20260906100000_receive_only_payable_sources
apps/api/prisma/migrations/20260906120000_payroll_payable_entries
apps/api/prisma/migrations/20260906130000_payable_settlement_snapshot
apps/api/prisma/migrations/20260906140000_payable_qc_snapshot
apps/api/prisma/migrations/20260906150000_salary_allocation_payroll_payable
```

### 前端

```text
apps/web/app/finance/salary/page.tsx
apps/web/app/procurement/page.tsx
```

### 测试

```text
apps/api/test/unit/payroll-ledger-service.test.cjs
apps/api/test/unit/payroll-payable-service.test.cjs
apps/api/test/unit/salary-payment-service.test.cjs
apps/api/test/unit/raw-material-inbounds-service.test.cjs
apps/api/test/unit/finished-goods-outbound-service.test.cjs
apps/api/test/unit/receivable-service.test.cjs
apps/api/test/unit/incoming-inspection-batch-sequence.test.cjs
apps/api/test/integration/procurement-inbound.test.cjs
```

### 文档

```text
docs/finance-11-point-audit.md
docs/design/finance-audit-improvement-plan.md
docs/test/finance-verification-checklist.md
docs/test/results/finance-adversarial-review.md
docs/test/results/finance-adversarial-review-round2.md
```

## 4. 必须运行的命令

```bash
npm run db:generate --workspace=@dilee/api
# 执行迁移
npm run typecheck
npm run build
npm run test:unit
TEST_DATABASE_URL=... npm run db:test:prepare
TEST_DATABASE_URL=... npm run test:integration
API_BASE_URL=... npm run test:api
PLAYWRIGHT_BASE_URL=... npm run test:e2e
npm run release:verify
```

## 5. 必须回答的对抗性问题

### 工资

1. 工资付款是否必须经过工资应付？
2. 工资应付未生成、未确认、金额不一致时是否阻断？
3. 工资台账 `update()` / `reopen()` 是否可能绕过工资应付？
4. 工资付款冲销是否正确恢复工资应付和工资台账？
5. 已支付工资是否可能重复核销或漏算？
6. 非车间工资是否可由财务人工维护并正确支付？

### 应收

7. 成品出库是否自动生成唯一应收来源？
8. 应收来源是否能追溯到出库、生产单、成品 QC、成品入库？
9. 出库冲销是否可能绕过应收草稿、应收确认或已收款？
10. 应收取消/回退是否可能绕过有效收款核销？

### 应付

11. 到货、QC、入库草稿是否仍可能生成有效应付？
12. 原料入库过账是否只生成一条有效应付？
13. QC 拒收是否保证 0 入库、0 应付？
14. 部分入库是否必须填写结算单价、总价和原因？
15. 入库冲销是否可能只冲库存但保留有效应付？
16. 已确认应付或已有付款核销时，入库冲销是否被阻断？
17. 单批入库冲销是否可能误伤同一到货其他批次？
18. QC 整批退货是否可能绕过已生成应付条目？

### 一致性

19. 应付数量是否等于实际入库数量？
20. 应付金额是否等于：
    - 全部入库：实际入库数量 × 采购单价；
    - 部分入库：人工结算总价；
21. QC 三结果、实际入库数量、应付金额是否在应付来源中完整保存？
22. 是否存在库存已冲销但应付仍有效、或应收已取消但出库仍有效的状态？
23. 所有回退、冲销、金额覆盖是否有原因和审计事件？
24. 是否存在并发请求产生重复库存、重复应付、重复核销？

## 6. 输出格式

对每个问题输出：

```text
问题编号：
结论：通过 / 不通过 / 无法验证
证据：
  - 文件
  - 行号
  - API
  - SQL 断言
  - 测试结果
复现步骤：
影响：
风险等级：
修复建议：
```

最后输出：

```text
整体结论：通过 / 不通过
阻塞项：
高风险问题：
中风险问题：
必须补测：
是否满足独立提交条件：
```

## 7. 禁止事项

```text
禁止只看提交信息就判定通过
禁止只看代码不运行测试
禁止把“已写测试”当作“测试通过”
禁止忽略未执行动态测试
禁止将无法验证项写成通过
```

## 8. 通过标准

```text
类型检查通过
构建通过
单元测试通过
PostgreSQL 集成测试通过
HTTP API 测试通过
Playwright 测试通过
release:verify 通过
所有对抗性问题有证据
无未解释的 P0/P1 状态不一致
```

## 9. 当前派发状态

```text
子 Agent 尚未实际派发。
原因：当前终端 PTY 不可用，无法运行测试和检查数据库。
终端恢复后，将本文件作为子 Agent 任务书执行。
```

# 财务链路对抗性审查报告

> 审查性质：独立对抗性静态审查  
> 审查目标：工资、应收、应付三条财务链路及其跨模块回退  
> 审查基线：`docs/finance-11-point-audit.md`、`docs/design/finance-audit-improvement-plan.md`  
> 运行环境：当前终端 PTY 不可用，无法执行 PostgreSQL、HTTP、Playwright 测试  
> 审查结论：代码层改动已覆盖主要断点，但未完成运行验证，当前不能标记为最终闭环。

## 1. 审查范围

```text
工资
  生产日报 -> 生产工资来源 -> 工资台账 -> 工资应付 -> 工资付款 -> 冲销

应收
  成品出库 -> 应收来源 -> 应收确认 -> 收款 -> 核销 -> 出库冲销

应付
  原料入库 -> 应付来源 -> 应付确认 -> 付款 -> 核销 -> 入库冲销

跨模块
  成品 QC / 入库 -> 应收
  来料 QC / 入库 -> 应付
  审计 / 权限 / 并发 / 幂等
```

## 2. 逐项审查结果

| 编号 | 审计项 | 代码实现 | 自动测试 | 运行时验证 | 审查结论 |
|---|---|---|---|---|---|
| 1 | 车间工资进入薪资台账 | 已实现 | 有领域/服务测试 | 未执行 | 待运行验证 |
| 2 | 单价和数量变化联动台账 | 已实现 | 有日报测试 | 未执行 | 待运行验证 |
| 3 | 薪资台账按日期范围统计 | 已实现服务端范围 | 有单元测试 | 未执行 | 待运行验证 |
| 4 | 工资进入应付体系 | 已新增工资应付模型 | 有单元测试 | 未执行 | 待运行验证 |
| 5 | 已支付工资状态和防重复 | 已实现状态与核销控制 | 有服务测试 | 未执行 | 待运行验证 |
| 6 | 非车间工资人工维护 | 已实现 | 有前后端入口 | 未执行 | 待运行验证 |
| 7 | 工资应付回退 | 已实现付款核销阻断和状态回退 | 有单元测试 | 未执行 | 待运行验证 |
| 8 | 成品出库自动转应收 | 已实现 | 有外协/财务测试 | 未执行 | 待运行验证 |
| 9 | 应收回退到出库/QC | 已实现追溯和出库冲销保护 | 有单元测试 | 未执行 | 待运行验证 |
| 10 | 原料入库自动转应付和 QC 金额 | 已实现快照字段 | 有入库测试 | 未执行 | 待运行验证 |
| 11 | 原料入库到应付回退 | 已实现待确认来源作废、已确认阻断 | 有单元测试 | 未执行 | 待运行验证 |

## 3. 对抗性审查发现

### A. 环境与提交阻塞

**严重级别：阻塞**

- 当前 PTY 终端不可用：

```text
Error: PTY shell exited during startup
```

影响：

- 无法执行 `prisma generate`；
- 无法执行迁移；
- 无法执行类型检查；
- 无法执行单元/API/集成/E2E 测试；
- 无法按 Conventional Commit 提交。

当前状态不能作为最终验收证据。

### B. 工资付款仍可直接核销工资台账，未强制经过工资应付

**严重级别：高**

当前 `SalaryPaymentService` 仍以 `ledger_id` 作为核销目标；F-04 通过 `ledgerId` 反向刷新工资应付状态，但未强制付款必须选择 `payroll_payable_id`。

影响：

- 可能存在工资台账已付款、工资应付仍为草稿或被绕过的情况；
- 工资应付不是付款的唯一核销入口，审计上不够严格；
- 如果未来引入工资调整，付款来源关系可能不够清晰。

建议：

- 在 `SalaryPaymentAllocation` 增加可选 `payrollPayableId`；
- 工资付款过账优先要求 `payroll_payable_id`；
- 保留旧 `ledger_id` 作为兼容字段；
- 增加“付款必须核销已确认工资应付”的强校验。

### C. 入库冲销对已确认应付的阻断顺序需要运行验证

**严重级别：中**

代码已实现：

- 有已确认应付时阻断入库冲销；
- 有 posted 付款核销时阻断入库冲销；
- draft 应付条目自动作废。

待验证：

- 冲销付款后，应付状态是否自动恢复；
- 应付冲销后，再入库冲销是否成功；
- 并发付款和入库冲销时是否会出现状态穿越。

建议：

- 增加 PostgreSQL 事务测试；
- 增加“付款冲销 -> 应付冲销 -> 入库冲销”完整顺序测试。

### D. 成品出库冲销与应收草稿自动取消需要运行验证

**严重级别：中**

代码已实现：

- 应收草稿自动取消；
- 已确认应收阻断出库冲销；
- 有 posted 收款核销阻断出库冲销。

待验证：

- 出库冲销事务内取消应收和反向库存事实是否原子提交；
- 应收取消后再次冲销是否幂等；
- 已发货/已签收出库单的冲销顺序是否正确。

### E. 工资付款和应付状态刷新依赖可选服务注入

**严重级别：中**

`SalaryPaymentService` 通过 `@Optional()` 注入 `PayrollPayableService`。如果 Nest 模块配置错误，付款过账可能不刷新工资应付，但不会报错。

建议：

- 使用非可选注入，或在模块启动时增加依赖存在性校验；
- 增加 API 集成测试验证工资应付状态确实更新。

### F. Prisma 模型变更未生成 Client

**严重级别：阻塞**

新增模型：

- `PayrollPayableEntry`
- `PayableSource` 新字段
- `RawMaterialInbound` 结算字段
- `IncomingInspection.qcResult`
- `PayableSource` QC 快照字段

这些模型变更必须先执行：

```bash
npm run db:generate --workspace=@dilee/api
```

否则 TypeScript 编译和运行都会失败。

## 4. 必须执行的验证命令

终端恢复后按顺序执行：

```bash
cd /Users/user/Desktop/Dilee

# 1. 生成 Prisma Client
npm run db:generate --workspace=@dilee/api

# 2. 类型检查和构建
npm run typecheck
npm run build

# 3. 单元测试
npm run test:unit

# 4. PostgreSQL 集成测试
TEST_DATABASE_URL=... npm run db:test:prepare
TEST_DATABASE_URL=... npm run test:integration

# 5. HTTP API 测试
API_BASE_URL=... npm run test:api

# 6. 浏览器测试
PLAYWRIGHT_BASE_URL=... npm run test:e2e

# 7. 发布校验
npm run release:verify
```

## 5. 每个任务独立提交建议

```text
feat(hr): support payroll ledger period range queries
feat(web): show payroll paid and outstanding amounts
feat(hr): add payroll payable entry model and lifecycle
feat(hr): link payroll payable rollback with ledger and payments
fix(warehouse): guard finished goods outbound reversal with receivable state
feat(finance): trace receivable rollback to outbound and qc
fix(procurement): guard raw material inbound reversal with payable and payment state
feat(procurement): snapshot inbound settlement into payable source
feat(procurement): support qc all-inbound, rejected and partial-inbound settlement
feat(finance): keep payable amounts consistent with qc and inbound settlement
```

## 6. 审查结论

当前代码已覆盖审计发现的 11 个业务断点，新增了：

- 工资应付模型；
- 应收来源追溯；
- 出库冲销应收保护；
- 入库冲销应付/付款保护；
- 入库结算快照；
- QC 三结果快照；
- 应付金额一致性字段。

但对抗性审查不能给出“通过”结论，因为：

1. Prisma Client 未重新生成；
2. 数据库迁移未执行；
3. 单元/集成/API/E2E 测试未运行；
4. 工资付款尚未强制核销工资应付；
5. 缺少真实并发和回退顺序验证。

最终结论：

```text
静态审查通过，动态验收阻塞。
不能标记为全部实现完成。
```


## 7. 第二轮对抗性审查补充发现

### G. 工资台账可绕过工资应付直接回退草稿

**严重级别：高**

发现：

- `PayrollLedgerService.reopen()` 原先只检查台账状态；
- 未检查是否已经生成有效工资应付；
- 已确认工资应付的台账仍可回退草稿，造成台账和工资应付状态不一致。

修复：

- 在 `reopen()` 事务内查询 `PayrollPayableEntry`；
- 在 `update()` 事务内查询 `PayrollPayableEntry`；
- 如果存在 `draft`、`confirmed`、`partially_paid`、`paid` 工资应付，直接拒绝；
- 新增错误码：

```text
PAYROLL_LEDGER_HAS_PAYABLE
```

- 新增回归测试：

```text
apps/api/test/unit/payroll-ledger-service.test.cjs
```

修复后回退顺序：

```text
工资付款冲销
-> 工资应付回退/冲销
-> 工资台账回退草稿
-> 日报/工资来源更正
```

### H. QC 结果输入与数量分流不一致

**严重级别：中**

发现：

- 前端可能选择 `partial_inbound`，但数量分流实际为全部入库；
- 服务端原先仍按派生结果处理。

修复：

- `IncomingInspectionsService.create/update` 增加 `qc_result` 与派生结果一致性校验；
- 不一致返回：

```text
QC_RESULT_MISMATCH
```

- 新增回归测试。


### I. QC 整批退货可能绕过已生成应付条目

**严重级别：中**

发现：

- `returnToSupplier()` 原只检查 `PayableSource.status === posted`；
- 未检查 `SupplierPayableEntry`；
- 如果已生成应付条目但来源仍是 `pending_finance`，QC 退货可能直接作废来源。

修复：

- 查询应付来源时同时 include `supplierPayableEntry`；
- 如果存在非 `reversed` / `voided` 的应付条目，拒绝退货；
- 新增错误码：

```text
PAYABLE_ENTRY_EXISTS
```

- 新增回归测试。

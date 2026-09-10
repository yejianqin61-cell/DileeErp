# 财务链路第二轮对抗性审查结果

> 审查轮次：第二轮  
> 审查方式：静态对抗性审查  
> 动态执行：阻塞，PTY 终端不可用  
> 审查结论：发现并修复 4 个状态一致性问题，仍有动态验收和环境阻塞未闭环。

## 1. 第一轮遗留高优先级问题修复情况

| 问题 | 修复文件 | 状态 |
|---|---|---|
| 工资付款可直接核销台账，绕过工资应付 | `salary-payment.service.ts`、`salary-payment-allocation` 模型、`finance/salary` 页面 | 已修复代码，待动态验证 |
| 工资应付未生成时付款 | `salary-payment.service.ts` | 已修复，已有单元测试 |
| 工资应付未确认时付款 | `salary-payment.service.ts` | 已修复，已有单元测试 |
| 工资应付金额与台账不一致 | `salary-payment.service.ts` | 已修复，已有单元测试 |
| Prisma Client 未生成 | 环境阻塞 | 未完成 |

## 2. 第二轮新发现问题

### G. 工资台账 `reopen()` 可绕过工资应付

**级别：高**

现象：

```text
工资台账已确认 -> 已生成并确认工资应付 -> reopen() 仍可把台账退回 draft
```

修复：

- `PayrollLedgerService.reopen()` 事务内检查有效工资应付；
- 存在 `confirmed`、`partially_paid`、`paid` 工资应付时拒绝；
- 错误码 `PAYROLL_LEDGER_HAS_PAYABLE`。

测试：

- `apps/api/test/unit/payroll-ledger-service.test.cjs`。

### H. 工资台账 `update()` 可绕过工资应付

**级别：高**

现象：

```text
工资台账已确认 -> 已生成工资应付 -> update({ reason }) 仍可把台账退回 draft
```

修复：

- `PayrollLedgerService.update()` 事务内检查有效工资应付；
- 存在 `draft`、`confirmed`、`partially_paid`、`paid` 工资应付时拒绝；
- 错误码 `PAYROLL_LEDGER_HAS_PAYABLE`。

测试：

- `apps/api/test/unit/payroll-ledger-service.test.cjs`。

### I. QC 结果输入与数量分流不一致

**级别：中**

现象：

```text
用户选择 partial_inbound
但数量分流实际全部入库
服务端仍按全部入库处理
```

修复：

- `IncomingInspectionsService.create()` 和 `update()` 增加一致性校验；
- 错误码 `QC_RESULT_MISMATCH`。

测试：

- `apps/api/test/unit/incoming-inspection-batch-sequence.test.cjs`。

### J. QC 整批退货可绕过已生成应付条目

**级别：中**

现象：

```text
应付来源仍是 pending_finance
但已生成 confirmed SupplierPayableEntry
returnToSupplier() 只检查来源状态，未检查应付条目
```

修复：

- 退货查询 include `supplierPayableEntry`；
- 存在非 `reversed`、`voided` 应付条目时拒绝；
- 错误码 `PAYABLE_ENTRY_EXISTS`。

测试：

- `apps/api/test/unit/incoming-inspection-batch-sequence.test.cjs`。

### K. 单批入库冲销可能误作废同一到货其他批次的应付

**级别：高**

现象：

```text
同一到货 receipt 下允许分批入库；
每批入库生成独立 payable_source；
reverse() 原先按 purchase_receipt_id 作废所有未作废来源；
冲销其中一批会误作废其他批次的应付来源。
```

修复：

- `RawMaterialInboundsService.reverse()` 的应付来源作废条件改为：

```text
raw_material_inbound_id = 当前入库单
OR
purchase_receipt_id = 当前到货 AND raw_material_inbound_id IS NULL
```

- 后者只兼容历史 receipt-level 来源；
- 不会误伤同一到货下其他已入库批次。

测试：

- `apps/api/test/unit/raw-material-inbounds-service.test.cjs` 已同步 where 断言。

### L. 已作废应付来源的入库单再次过账

**级别：低**

现象：

```text
同一入库单存在历史 voided payable_source 时，
post() 当前按 rawMaterialInboundId 查到旧记录并跳过创建，
可能没有重新生成有效 pending_finance 来源。
```

修复：

- `RawMaterialInboundsService.post()` 发现同一入库单已有 `voided` 应付来源时；
- 不创建新来源；
- 将原来源恢复为 `pending_finance`；
- 同步刷新数量、单价、总价、币种、税率、QC 快照；
- 新增单元测试覆盖。

测试：

- `apps/api/test/unit/raw-material-inbounds-service.test.cjs`。

## 3. 修复后的回退顺序

```text
工资付款冲销
-> 工资应付回退或冲销
-> 工资台账 update/reopen
-> 日报或工资来源更正

QC 退货
-> 检查原料入库事实
-> 检查应付来源状态
-> 检查应付条目状态
-> 才允许退货和作废来源

原料入库冲销
-> 检查库存
-> 检查应付来源
-> 检查应付条目
-> 检查付款核销
-> 才允许冲销
```

## 4. 当前测试资产

单元测试：

```text
apps/api/test/unit/payroll-ledger-service.test.cjs
apps/api/test/unit/payroll-payable-service.test.cjs
apps/api/test/unit/salary-payment-service.test.cjs
apps/api/test/unit/raw-material-inbounds-service.test.cjs
apps/api/test/unit/finished-goods-outbound-service.test.cjs
apps/api/test/unit/receivable-service.test.cjs
apps/api/test/unit/incoming-inspection-batch-sequence.test.cjs
```

集成测试：

```text
apps/api/test/integration/procurement-inbound.test.cjs
```

## 5. 未完成动态验收

必须执行：

```bash
npm run db:generate --workspace=@dilee/api
npm run typecheck
npm run test:unit
TEST_DATABASE_URL=... npm run test:integration
API_BASE_URL=... npm run test:api
PLAYWRIGHT_BASE_URL=... npm run test:e2e
```

当前阻塞：

```text
PTY shell exited during startup
```

## 6. 审查结论

```text
第二轮静态对抗性审查发现 4 个状态一致性问题，
均已修复并补充单元测试。

但动态验收和独立提交仍未完成。
不能标记为全部完成。
```

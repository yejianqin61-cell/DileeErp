# 财务模块审计改进开发计划

> 来源：`docs/finance-11-point-audit.md`  
> 状态：ready-for-development  
> 目标：按阶段补齐工资、应收、应付和跨模块回退链，全部完成后执行独立对抗性审查。  
> 提交要求：每个任务独立提交，使用 Conventional Commit。

## 1. 改进目标

本次审计共发现 11 个问题，按业务风险收敛为 5 个改进方向：

1. 工资台账可统计、可展示、可追溯。
2. 工资形成应付或建立与应付的明确边界。
3. 成品出库与应收来源双向可控回退。
4. 原料入库与应付、付款形成受控回退链。
5. QC 三结果与部分入库结算金额准确进入应付来源。

最终系统必须满足：

```text
工资：日报可汇总 -> 台账可生成/调整 -> 支付可核销/冲销 -> 金额和状态可追溯
应收：出库可生成应收 -> 收款可核销 -> 出库冲销与应收取消/调整联动
应付：入库可生成应付 -> 应付可确认 -> 付款可核销 -> 上游冲销按顺序回退
```

## 2. 阶段划分

| 阶段 | 目标 | 包含任务 | 依赖 | 完成标志 |
|---|---|---|---|---|
| P0 | 基线与只读能力 | F-01、F-02 | 无 | 范围统计、金额展示、审计报告齐全 |
| P1 | 工资应付边界 | F-03、F-04 | P0 | 工资应付模型明确，回退边界明确 |
| P2 | 成品出库 ↔ 应收回退 | F-05、F-06 | P1 | 出库冲销不能绕过应收 |
| P3 | 原料入库 ↔ 应付/付款回退 | F-07、F-08 | P1 | 已确认/已付款场景有受控回退链 |
| P4 | QC 三结果与部分入库结算 | F-09、F-10 | P3 | 金额随 QC 结果和人工结算正确进入应付 |
| P5 | 综合验收与对抗性审查 | F-11 | P0-P4 | 子 Agent 审查完成，问题闭环 |

## 3. 子任务清单

### F-01 薪资台账服务端范围统计

**阶段：P0**

**目标**：`GET /hr/payroll-ledgers` 支持按日期范围统计，而不是只支持精确期间。

**实现范围**

- `apps/api/src/modules/hr/hr.controller.ts`
  - 为 `listLedgers` 增加 `from`、`to` 查询参数。
- `apps/api/src/modules/hr/payroll-ledger.service.ts`
  - `list()` 支持日期范围语义：
    - 台账与查询范围存在重叠即命中；
    - 或支持 `periodStart >= from && periodEnd <= to`，由最终业务口径决定。
  - 返回 `summary` 视图字段：
    - `payableAmount`
    - `paidAmount`
    - `outstandingAmount`
- 新增服务端范围汇总字段，避免前端全量加载后过滤。

**测试用例**

1. 单条台账完全在查询范围内：命中。
2. 台账跨查询范围：按最终口径命中或排除，并有明确契约测试。
3. `from > to`：返回参数错误。
4. 无匹配台账：返回空数组。
5. 多员工、多期间台账：只返回范围内的台账。
6. `paidAmount` 使用有效 `posted` 付款分配计算。
7. `outstandingAmount = payableAmount - paidAmount`。
8. 单元测试覆盖 `list()` 的范围边界。

**验收标准**

- API 支持服务端范围过滤和汇总。
- 前端不再依赖全量加载后过滤。
- 构建、类型检查、单元测试通过。

**提交信息**

```text
feat(hr): support payroll ledger period range queries
```

---

### F-02 薪资台账金额与支付状态展示

**阶段：P0**

**目标**：工资总览页清楚展示应发、已付、未付、状态，避免重复支付和漏算。

**实现范围**

- `apps/web/app/finance/salary/page.tsx`
  - 增加列：
    - 应发金额
    - 已付金额
    - 未付余额
    - 支付状态
    - 最近付款单号
  - 增加按状态和期间的筛选。
  - 增加“已支付 / 部分支付 / 已关闭 / 已过期”视觉标识。
- 前端增加重复支付风险提示：
  - 未付余额为 0 时禁用支付入口；
  - 已过期台账提示需重新结算或走调整；
  - 部分支付台账显示剩余可付金额。

**测试用例**

1. 草稿台账显示应发、已付 0、未付等于应发。
2. 部分支付后显示已付金额和未付余额。
3. 已付清后状态为 `paid`，未付为 0。
4. 付款冲销后状态回到 `partially_paid` 或 `confirmed`。
5. 已关闭台账不再显示支付入口。
6. 已过期台账有明确提示。
7. 前端组件测试覆盖状态和金额渲染。

**提交信息**

```text
feat(web): show payroll paid and outstanding amounts
```

---

### F-03 工资进入应付体系的模型与边界

**阶段：P1**

**目标**：明确工资是否需要形成应付；如果需要，新增工资应付来源/应付单，并保持与供应商应付隔离。

**设计选项**

方案 A：工资继续独立支付，不进入 `SupplierPayableEntry`。  
方案 B：新增 `PayrollPayableEntry`，专门表示工资应付。

推荐方案 B，避免把工资和供应商应付混在同一个对象。工资应付至少包含：

```text
payroll_payable_id
ledger_id
employee_id
order_no 可空
amount
currency
status: draft -> confirmed -> partially_paid -> paid -> closed
source_snapshot
```

**实现范围**

- Prisma schema 新增 `PayrollPayableEntry`。
- 新增数据库迁移。
- `PayrollLedger` 生成/确认后可选生成工资应付。
- 新增服务 `payroll-payable.service.ts`。
- API：
  - `GET /hr/payroll-payables`
  - `POST /hr/payroll-payables/from-ledger/:ledgerId`
  - `POST /hr/payroll-payables/:id/confirm`
  - `POST /hr/payroll-payables/:id/reopen`
  - `POST /hr/payroll-payables/:id/reverse`
- 工资付款核销优先核销工资应付，而不是直接核销台账；如果需要兼容期，可保留台账核销并增加关联字段。

**测试用例**

1. 同一工资台账只能生成一条有效工资应付。
2. 工资应付金额等于台账实发金额。
3. 已确认工资应付不能直接修改金额。
4. 工资应付确认后可支付。
5. 工资应付回退草稿要求原因。
6. 已部分支付/已支付工资应付不能直接回退。
7. 已支付工资应付冲销必须先冲销付款。
8. 工资应付与供应商应付不能互相核销。
9. 数据库唯一约束幂等验证。
10. API、集成测试覆盖。

**提交信息**

```text
feat(hr): add payroll payable entry model and lifecycle
```

---

### F-04 工资应付到台账/付款的回退机制

**阶段：P1**

**目标**：建立工资应付、工资台账、工资付款之间的受控回退顺序。

**回退顺序**

```text
工资付款冲销
-> 工资应付回退/冲销
-> 工资台账回退草稿
-> 日报/工资来源更正
```

**实现范围**

- 工资付款冲销恢复工资应付和工资台账。
- 工资应付 `reopen` 要求无有效付款核销。
- 工资应付 `reverse` 要求无有效付款核销。
- 台账 `reopen` 前检查是否存在有效工资应付。
- 所有操作写审计事件和原因。

**测试用例**

1. 工资付款已过账时，工资应付不能直接回退。
2. 先冲销付款后，工资应付可回退草稿。
3. 工资应付已确认但未付款时，不允许直接编辑台账。
4. 工资应付冲销后，工资台账状态正确恢复。
5. 工资台账回退后有有效工资应付时被拒绝。
6. 审计事件覆盖付款、应付、台账三层。
7. 数据库集成测试覆盖事务原子性。

**提交信息**

```text
feat(hr): link payroll payable rollback with ledger and payments
```

---

### F-05 成品出库冲销与应收来源联动

**阶段：P2**

**目标**：成品出库冲销不能绕过应收来源；必须检查并阻断或联动作废。

**规则**

```text
无应收来源       -> 允许出库冲销
应收来源草稿     -> 自动取消应收来源
应收来源已确认   -> 要求先回退草稿或拒绝出库冲销
已有有效收款核销 -> 必须先冲销收款或做应收调整
已收清应收       -> 禁止出库冲销
```

**实现范围**

- `FinishedGoodsOutboundService.reverseOutbound()`：
  - 查找 `ReceivableSource`；
  - 按规则处理；
  - 返回影响预览和阻塞原因。
- `ReceivableService` 增加按 `outboundId` 查询和取消方法。
- 前端出库冲销弹窗显示应收影响。

**测试用例**

1. 无应收来源时成功冲销。
2. 草稿应收来源被自动取消。
3. 已确认应收且无收款：出库冲销被拒绝。
4. 已部分收款：出库冲销被拒绝并要求先冲销收款。
5. 已收清：出库冲销被拒绝。
6. 取消应收来源后再次冲销成功。
7. 冲销幂等，不重复生成反向库存事实。
8. API/集成/浏览器测试覆盖。

**提交信息**

```text
fix(warehouse): guard finished goods outbound reversal with receivable state
```

---

### F-06 应收来源回退到出库/QC 的可追溯性

**阶段：P2**

**目标**：应收来源的取消、回退、调整可追溯到出库、订单和成品 QC。

**实现范围**

- `ReceivableSource` 查询详情返回：
  - 出库单
  - 成品 QC
  - 成品入库
  - 订单
- `reopen`、`cancel` 返回影响预览。
- 前端应收页增加来源追溯区域。
- 对已有收款核销的应收，强制先冲销收款。

**测试用例**

1. 应收来源详情能追溯到出库、成品 QC、成品入库。
2. 应收确认后回退草稿要求原因。
3. 有有效收款核销时回退被拒绝。
4. 取消应收来源后，出库冲销可继续。
5. 审计事件包含 order_no、outbound_id、qc_record_id。
6. API 契约测试覆盖。

**提交信息**

```text
feat(finance): trace receivable rollback to outbound and qc
```

---

### F-07 原料入库冲销与应付/付款回退

**阶段：P3**

**目标**：原料入库冲销必须按下游事实受控处理，不能库存已减而应付仍有效。

**规则**

```text
无应付来源         -> 允许入库冲销
应付来源 pending   -> 作废应付来源
应付已确认         -> 要求先回退/冲销应付
已有付款核销       -> 要求先冲销付款
已付款             -> 要求先冲销付款和应付
```

**实现范围**

- `RawMaterialInboundsService.reverse()`：
  - 查询应付来源、应付条目、付款分配；
  - 按规则阻断或联动作废；
  - 返回影响预览。
- `impactPreview()` 增加：
  - payable status
  - payable entry status
  - payment allocation status
  - 建议处理顺序
- 前端入库冲销弹窗展示影响。

**测试用例**

1. 无应付来源：入库冲销成功。
2. 应付来源 `pending_finance`：自动作废。
3. 应付已确认：冲销被拒绝。
4. 应付已有付款核销：冲销被拒绝。
5. 先冲销付款，再冲销应付，再冲销入库：成功。
6. 库存不足：拒绝冲销。
7. 冲销幂等。
8. 审计覆盖库存、应付、付款。

**提交信息**

```text
fix(procurement): guard raw material inbound reversal with payable and payment state
```

---

### F-08 原料入库到应付的来源快照与幂等

**阶段：P3**

**目标**：应付来源严格来自入库过账，并保存完整的入库结算快照。

**实现范围**

- 禁止到货/QC 阶段生成有效应付来源。
- 应付来源字段：
  - raw_material_inbound_id
  - order_no
  - purchase_order_id
  - purchase_order_item_id
  - receipt_id
  - material_id
  - quantity
  - settlement_unit_price
  - settlement_total_amount
  - settlement_amount_reason
  - currency
  - tax_rate
- 同一入库单只能生成一条有效应付来源。

**测试用例**

1. 到货后有效应付为 0。
2. QC 后有效应付为 0。
3. 入库草稿后有效应付为 0。
4. 入库过账后有效应付为 1。
5. 重复过账请求只生成一条应付来源。
6. 全部入库使用采购单价。
7. 部分入库使用人工结算单价/总价。
8. 拒收不生成应付。
9. 数据库唯一约束验证。

**提交信息**

```text
feat(procurement): snapshot inbound settlement into payable source
```

---

### F-09 QC 三结果与部分入库结算

**阶段：P4**

**目标**：QC 统一为 `全部入库 / 拒收 / 部分入库`，部分入库必须填写实际数量、单价、总价、原因。

**实现范围**

- `IncomingInspection.qcResult` 枚举。
- 原料入库 API 新增：
  - `settlement_unit_price`
  - `settlement_total_amount`
  - `settlement_amount_reason`
- 规则：
  - 全部入库：实际入库数量 = 可入库数量，单价 = 采购单价；
  - 拒收：入库 0，不生成应付；
  - 部分入库：人工填写数量、单价、总价、原因。
- 前端 QC 和入库表单增加三结果选择。

**测试用例**

1. 全部入库：应付金额 = 采购单价 × 实际入库数量。
2. 拒收：入库接口拒绝，有效应付为 0。
3. 部分入库：必须填写单价、总价、原因。
4. 部分入库：金额等于人工填写总价。
5. 部分入库：数量不能超过 QC 可入库数量。
6. 总价与数量×单价不一致时必须有原因。
7. 同一 QC 分批入库时分别生成应付来源。
8. 前端浏览器场景覆盖三种结果。

**提交信息**

```text
feat(procurement): support qc all-inbound, rejected and partial-inbound settlement
```

---

### F-10 QC/入库结算与应付金额一致性

**阶段：P4**

**目标**：应付金额、入库数量和 QC 结果三方一致。

**实现范围**

- 应付来源保存 QC 结果快照。
- 应付详情显示：
  - qc_result
  - accepted_quantity
  - conditional_quantity
  - rejected_quantity
  - actual_inbound_quantity
  - settlement_unit_price
  - settlement_total_amount
- 财务修改金额时必须填写原因。
- 不允许应付金额与来源快照静默不一致。

**测试用例**

1. 应付数量等于实际入库数量。
2. 应付金额等于结算总价。
3. 应付快照包含 QC 三结果。
4. 财务修改金额必须填写原因。
5. 来源变化不静默改写已确认应付。
6. 对账按采购单、批次、入库单聚合。
7. API/集成测试。

**提交信息**

```text
feat(finance): keep payable amounts consistent with qc and inbound settlement
```

---

### F-11 综合验收与对抗性审查

**阶段：P5**

**目标**：全部任务完成后，分派一个独立子 Agent 对财务链路做对抗性审查。

**审查范围**

- 工资：车间/非车间、日报变更、台账重算、付款、冲销。
- 应收：出库、应收、收款、核销、出库冲销、应收回退。
- 应付：到货、QC、入库、应付、付款、上游冲销。
- QC：全部入库、拒收、部分入库、分批入库。
- 并发、幂等、金额守恒、审计、权限。

**子 Agent 审查任务**

```text
你是一个独立对抗性审查 Agent。不要相信开发者的自评。
请基于真实代码、数据库迁移、API 契约和测试用例，逐项验证以下问题：

1. 是否存在库存已冲销但应付仍有效？
2. 是否存在成品出库已冲销但应收仍有效？
3. 是否存在工资已支付但台账仍可被静默改写？
4. 是否存在部分入库金额未进入应付来源？
5. 是否存在重复过账、重复核销、重复应付？
6. 是否存在已确认事实可以绕过状态机回退？
7. 审计事件是否覆盖所有金额和状态变更？
8. 权限是否允许跨模块越权操作？
9. 并发请求是否会产生重复库存、重复付款、重复核销？

对每个问题给出：
- 结论：通过 / 不通过 / 无法验证
- 证据：文件、行号、接口、测试
- 复现步骤
- 风险等级
- 修复建议
```

**验收标准**

- 子 Agent 输出独立审查报告。
- 所有 P0/P1 问题闭环。
- 无法验证项必须写明环境原因。
- 审查报告归档到 `docs/test/results/`。

**提交信息**

```text
test(finance): add adversarial review for payroll receivable and payable chains
```

## 4. 统一测试矩阵

| 测试类型 | 覆盖内容 | 必须执行 |
|---|---|---|
| 单元测试 | 金额计算、状态机、回退规则 | 每个任务 |
| API 契约测试 | 请求/响应、权限、错误码、幂等 | 每个任务 |
| PostgreSQL 集成测试 | 事务、锁、唯一约束、并发 | F-03 以后 |
| Playwright 浏览器测试 | 表单、回退、金额展示、状态提示 | F-02 以后 |
| 并发测试 | 重复过账、重复核销、重复应付 | F-05 以后 |
| 金额守恒测试 | 应付、付款、核销、余额 | F-08 以后 |
| 对抗性审查 | 反向验证所有关键链路 | F-11 |

## 5. 每个任务的交付门槛

每个任务完成时必须提供：

1. 数据模型变更与迁移脚本。
2. API 变更说明。
3. 前端页面位置。
4. 单元/API/集成/浏览器测试结果。
5. 回退和冲销行为说明。
6. 审计事件覆盖说明。
7. Conventional Commit。

## 6. 当前状态

- 本计划已生成。
- 员工生产数据清理脚本已生成，但因当前终端 PTY 不可用，尚未在数据库执行。
- F-01 已实现代码和单元测试：
  - `apps/api/src/modules/hr/payroll-ledger.service.ts`
  - `apps/api/src/modules/hr/hr.controller.ts`
  - `apps/api/test/unit/payroll-ledger-service.test.cjs`
- F-01 尚未执行类型检查和单元测试，当前终端 PTY 启动失败。
- F-01 尚未提交，提交信息应为 `feat(hr): support payroll ledger period range queries`。
- F-02 已实现代码：
  - `apps/web/app/finance/salary/page.tsx`
  - 使用服务端 `from/to` 范围加载；
  - 展示应发、已付、未付；
  - 增加状态中文映射和过期提示。
- F-02 尚未执行 Web 构建、类型检查和浏览器验收。
- F-02 尚未提交，提交信息应为 `feat(web): show payroll paid and outstanding amounts`。
- 因当前无法运行 `prisma generate`，F-03/F-04 的模型变更暂缓，先执行不依赖 schema 变更的资金回退任务 F-05。
- F-05 已实现代码和单元测试：
  - `apps/api/src/modules/warehouse/finished-goods-outbound.service.ts`
  - `apps/api/test/unit/finished-goods-outbound-service.test.cjs`
  - 规则：无应收来源允许冲销；应收草稿自动取消；应收已确认或已有有效收款核销时阻断出库冲销。
- F-05 尚未执行类型检查和单元测试。
- F-05 尚未提交，提交信息应为 `fix(warehouse): guard finished goods outbound reversal with receivable state`。
- F-07 已实现代码和单元测试：
  - `apps/api/src/modules/procurement/raw-material-inbounds.service.ts`
  - `apps/api/test/unit/raw-material-inbounds-service.test.cjs`
  - 规则：pending 应付来源随入库冲销作废；draft 应付条目自动作废；已确认应付要求先处理应付；已有有效付款核销要求先冲销付款。
  - `impactPreview()` 增加应付条目状态和付款核销状态。
- F-07 尚未执行类型检查和单元测试。
- F-07 尚未提交，提交信息应为 `fix(procurement): guard raw material inbound reversal with payable and payment state`。
- F-03 已实现模型、迁移、服务和 API：
  - `apps/api/prisma/schema.prisma` 新增 `PayrollPayableEntry`；
  - `apps/api/prisma/migrations/20260906120000_payroll_payable_entries/migration.sql`；
  - `apps/api/src/modules/hr/payroll-payable.service.ts`；
  - `apps/api/src/modules/hr/hr.controller.ts`；
  - `apps/api/src/modules/hr/hr.module.ts`；
  - `apps/api/test/unit/payroll-payable-service.test.cjs`。
- F-03 尚未执行 `prisma generate`、迁移、类型检查和单元测试。
- F-03 尚未提交，提交信息应为 `feat(hr): add payroll payable entry model and lifecycle`。
- F-04 已实现代码和单元测试：
  - `apps/api/src/modules/hr/payroll-payable.service.ts` 新增 `refreshStatusForLedger()`；
  - `apps/api/src/modules/hr/salary-payment.service.ts` 在工资付款过账、冲销后同步刷新工资应付状态；
  - `apps/api/test/unit/payroll-payable-service.test.cjs` 覆盖付款分配驱动的应付状态变化。
- F-04 尚未执行类型检查和单元测试。
- F-04 尚未提交，提交信息应为 `feat(hr): link payroll payable rollback with ledger and payments`。
- F-06 已实现代码和单元测试：
  - `apps/api/src/modules/finance/receivable.service.ts` 详情查询追溯出库、生产单、成品 QC、成品入库；
  - `impactPreview()` 返回 `source_trace`；
  - `apps/api/test/unit/receivable-service.test.cjs` 覆盖来源追溯。
- F-06 尚未执行类型检查和单元测试。
- F-06 尚未提交，提交信息应为 `feat(finance): trace receivable rollback to outbound and qc`。
- F-08 已实现模型、迁移、服务和测试：
  - `PayableSource` 新增 `materialId`、`settlementUnitPrice`、`settlementTotalAmount`、`settlementAmountReason`；
  - 新增迁移 `20260906130000_payable_settlement_snapshot`；
  - 入库过账按 QC 结果写入应付快照：
    - 全部入库使用采购单价和实际入库数量；
    - 部分入库使用人工结算单价、总价和差异原因；
  - `apps/api/test/unit/raw-material-inbounds-service.test.cjs` 覆盖全部入库和部分入库两种快照。
- F-08 尚未执行 `prisma generate`、迁移、类型检查和单元测试。
- F-08 尚未提交，提交信息应为 `feat(procurement): snapshot inbound settlement into payable source`。
- F-09 已实现/收敛：
  - `qc_result` DTO 已限制为 `all_inbound`、`rejected`、`partial_inbound`；
  - QC 服务按检验数量自动派生最终 QC 结果；
  - 拒收不能入库，不能生成应付；
  - 全部入库按采购单价和实际入库数量计算；
  - 部分入库必须填写结算单价、总价、差异原因；
  - 入库过账按 QC 结果写入应付快照；
  - 修正部分入库金额差异原因的占位错误提示。
- F-09 尚未执行类型检查和单元测试。
- F-09 尚未提交，提交信息应为 `feat(procurement): support qc all-inbound, rejected and partial-inbound settlement`。
- F-10 已实现模型、迁移和快照写入：
  - `PayableSource` 新增 `qcResult`、`acceptedQuantity`、`conditionalQuantity`、`rejectedQuantity`、`actualInboundQuantity`；
  - 新增迁移 `20260906140000_payable_qc_snapshot`；
  - 入库过账写入 QC 三结果和实际入库数量快照；
  - 财务查询默认可以读取应付来源上的 QC 快照；
  - `apps/api/test/unit/raw-material-inbounds-service.test.cjs` 覆盖全部入库、部分入库的 QC 快照。
- F-10 尚未执行 `prisma generate`、迁移、类型检查和单元测试。
- F-10 尚未提交，提交信息应为 `feat(finance): keep payable amounts consistent with qc and inbound settlement`。
- F-11 已完成独立对抗性静态审查报告：
  - `docs/test/results/finance-adversarial-review.md`
  - 结论：静态审查通过，动态验收阻塞。
  - 发现高优先级问题：工资付款仍可直接核销台账，未强制经过工资应付。
  - 发现中优先级问题：入库冲销、出库冲销、工资应付状态刷新需要运行验证。
- F-11 尚未完成动态验收，因为终端 PTY 不可用。
- 已修复对抗性审查高优先级问题：
  - `SalaryPaymentAllocation` 增加 `payrollPayableId`；
  - 工资付款过账必须存在已确认/部分支付的工资应付；
  - 工资应付金额与台账实发金额不一致时阻断付款；
  - 工资付款分配记录同时关联工资应付。
- 新增回归测试：
  - `apps/api/test/unit/salary-payment-service.test.cjs`
  - 覆盖工资付款没有工资应付时必须阻断。
- 新增工资应付前端入口：
  - `apps/web/app/finance/salary/page.tsx`
  - 工资台账确认后可生成工资应付；
  - draft 工资应付可确认；
  - 列表展示工资应付状态；
  - 新增工资付款草稿创建、按台账核销过账、已过账付款冲销入口。

- F-09 全局质检入口已补齐 QC 三结果：
  - `apps/web/app/procurement/page.tsx`
  - 全局“登记质检”与批次内质检均支持全部入库、拒收、部分入库。
- F-09 补充历史部分入库兼容：
  - `apps/api/src/modules/procurement/raw-material-inbounds.service.ts`
  - `qcResult` 为空但 QC 状态为 `partially_accepted` 时，仍要求填写结算单价、总价、原因；
  - 入库过账仍按人工结算金额生成应付。
  - `apps/api/test/unit/raw-material-inbounds-service.test.cjs` 新增兼容测试。
- 新增工资付款金额一致性测试：
  - `apps/api/test/unit/salary-payment-service.test.cjs`
  - 覆盖工资应付金额与台账实发金额不一致时阻断付款。
- 新增动态验收清单：
  - `docs/test/finance-verification-checklist.md`
  - 覆盖工资、应收、应付、QC、并发、幂等、审计和证据归档。
- 修复工资应付幂等/软删除恢复：
  - `apps/api/src/modules/hr/payroll-payable.service.ts`
  - `ledger_id` 唯一键存在软删除记录时恢复原记录，而不是直接创建新记录。
  - `apps/api/test/unit/payroll-payable-service.test.cjs` 适配唯一键查询。
- 新增 PostgreSQL 集成回归场景：
  - `apps/api/test/integration/procurement-inbound.test.cjs`
  - 入库过账后创建已确认应付条目；
  - 断言入库冲销被 `INBOUND_PAYABLE_ALREADY_CONFIRMED` 阻断。
- 迁移顺序兼容性结论：
  - 现有迁移 `20260908150000_backfill_posted_inbound_payables` 依赖
    `raw_material_inbounds.settlement_unit_price` 和
    `raw_material_inbounds.settlement_total_amount`；
  - 本次新增迁移 `20260906100000_receive_only_payable_sources` 已先添加这些字段；
  - 当前时间戳顺序保证 backfill 可以读取结算字段并防止重复应付来源；
  - 不要将本次新增迁移改到 `20260908150000` 之后。
- 新增 QC 结果一致性校验：
  - `apps/api/src/modules/procurement/incoming-inspections.service.ts`
  - `qc_result` 输入必须与检验数量派生的最终结果一致；
  - 不一致返回 `QC_RESULT_MISMATCH`；
  - 修复质检更新分支中的占位注释。
  - `apps/api/test/unit/incoming-inspection-batch-sequence.test.cjs` 新增 QC 结果冲突回归测试。
- 第二轮对抗性审查新增修复：
  - `apps/api/src/modules/hr/payroll-ledger.service.ts`
  - 已有有效工资应付时禁止工资台账回退草稿；
  - 已有工资应付时禁止工资台账更新并退草稿；
  - 新增错误码 `PAYROLL_LEDGER_HAS_PAYABLE`；
  - `apps/api/test/unit/payroll-ledger-service.test.cjs` 覆盖回退和更新阻断场景。
  - `apps/api/src/modules/procurement/incoming-inspections.service.ts`
  - 已生成应付条目时禁止 QC 整批退货；
  - 新增错误码 `PAYABLE_ENTRY_EXISTS`；
  - `apps/api/test/unit/incoming-inspection-batch-sequence.test.cjs` 覆盖阻断场景。
- 第二轮对抗性审查报告：
  - `docs/test/results/finance-adversarial-review-round2.md`
  - 记录 G/H/I/J 四个发现及修复。
- 第二轮补充修复 K：
  - `apps/api/src/modules/procurement/raw-material-inbounds.service.ts`
  - 单批入库冲销只作废本批次应付来源；
  - 对历史 receipt-level 且无入库 ID 的来源才按到货批次作废；
  - 避免同一到货下其他已入库批次被误作废。
  - `apps/api/test/unit/raw-material-inbounds-service.test.cjs` 同步更新断言。
- 第二轮审查修复 L：
  - 同一入库单存在历史 voided 应付来源时，post() 恢复原来源为 pending_finance；
  - 同步刷新数量、单价、总价、币种、税率和 QC 快照；
  - `apps/api/test/unit/raw-material-inbounds-service.test.cjs` 覆盖恢复逻辑。

- 取消工资应付刷新服务的可选注入：
  - `apps/api/src/modules/hr/salary-payment.service.ts`
  - `PayrollPayableService` 改为必填构造依赖，避免模块配置错误时静默跳过工资应付状态刷新。
- 新增独立提交计划：
  - `docs/design/finance-commit-plan.md`
  - 明确 F-01 到 F-11 每个 Conventional Commit 的文件映射；
  - 明确 schema、service、test、page 的 hunk 拆分方式。
- 每个任务独立提交仍未执行。
- 下一步需要终端可用后：
  1. 执行 `prisma generate`；
  2. 执行迁移；
  3. 执行类型检查、单元、集成、API、E2E；
  4. 验证工资付款强制核销工资应付；
  5. 按任务独立提交 Conventional Commit。

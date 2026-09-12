# 财务模块 11 项业务闭环排查

> 排查范围：薪资台账、生产工资来源、工资支付、成品出库/应收、原料入库/应付。  
> 判定口径：代码和接口存在即算“已实现”；只有存在明确阻断、自动联动或受控冲销链才算“已闭环”。

## 1. 车间工人薪资能否正确统计到薪资台账

**结论：能，当前实现为已实现。**

证据：

- `employee-daily-reports.service.ts` 中 `syncPayrollSource()` 只对 `employeeType === "workshop"` 的员工生成 `ProductionPayrollSource`。
- `payroll-ledger.service.ts` 的 `collectProductionSources()` 也只对 `employeeType === "workshop"` 汇总生产工资来源。
- `PayrollLedger.generate()` 会按 `employee_id` + `period_start/period_end` 汇总生产工资来源，写入 `productionSourceAmount` 和 `sourceSnapshot`。
- 薪资台账页面：`apps/web/app/finance/salary/page.tsx` 的“车间 / 非车间”分区。

注意：

- 员工类型必须是 `workshop`，不能是历史 mock 数据里的 `worker`。
- 生成台账前，员工日报必须先形成 `ProductionPayrollSource`。
- 台账按“员工 + 期间”生成，不自动生成，需要财务发起。

## 2. 单价改变、数量改变，薪资台账能否及时改变

**结论：草稿台账能自动更新；已确认台账会转为过期；已支付/部分支付台账不会自动改写。**

证据：

- 员工日报 `create/update/remove` 后调用 `syncPayrollSource()`。
- `syncPayrollSource()` 重新汇总当日 `EmployeeDailyReport`，更新或软删除 `ProductionPayrollSource`。
- 随后 `refreshDraftPayrollLedgers()` 会重算所有覆盖该日期的 `draft` 台账的 `productionSourceAmount` 和 `sourceSnapshot`。
- `reconcilePayrollLedgers()` 对 `confirmed` 台账自动置为 `expired`；对 `partially_paid`、`paid` 台账不做静默改写，只写审计事件要求财务处理。
- 同一员工、同一生产单、同一工序、同一天允许存在多条日报（可复选、可混合计薪方式、可不同单价），不再做同键合并或单价冲突拒绝；`syncPayrollSource()` 按「员工 + 生产单 + 日期 + 计薪方式」重新汇总**全部**日报（件数、时长、金额求和，`sourceSnapshot` 保留每一条日报 ID），因此重复登记是金额累加而不是覆盖。
- `generate()` 命中已存在的 `draft` / `expired` 台账时会**刷新** `productionSourceAmount` 与 `sourceSnapshot` 并回到草稿（重复登记/补录导致 `confirmed` 自动过期后，“重新生成”即完成重算）；已确认、部分支付、已支付、已关闭台账一律不自动改写。

注意：

- 如果台账不存在，源头变化不会自动创建台账。
- 如果台账是 `confirmed`，金额不会自动重算，而是状态变为 `expired`，需要重新生成或回退草稿后才会刷新。
- 如果台账已经 `partially_paid` / `paid`，必须走工资调整、补付或付款冲销。

## 3. 薪资台账能否按日期范围统计

**结论：前端可以按范围筛选；后端列表接口目前主要支持精确期间过滤，范围统计能力不完整。**

证据：

- 前端 `apps/web/app/finance/salary/page.tsx` 对已加载台账做 `periodEnd >= periodStart && periodStart <= periodEnd` 的重叠范围筛选。
- 后端 `PayrollLedgerService.list()` 对 `periodStart`、`periodEnd` 使用精确匹配，不是范围查询。
- 生产工资来源接口 `employeeDailyReports.payrollSources()` 支持 `from`、`to` 日期范围汇总。

缺口：

- 后端 `GET /hr/payroll-ledgers` 缺少 `from/to` 范围语义。
- 台账数据量增大时，前端全量加载再过滤不可持续。
- 报表侧如果要做“按日期范围统计工资总额”，建议增加服务端范围聚合接口或明确的汇总查询。

## 4. 工资能否结算成应付条目

**结论：不能。工资目前不是应付条目，而是独立的工资台账和工资付款。**

证据：

- 应付条目 `SupplierPayableEntry.sourceType` 只接受 `raw_material_inbound`、`purchase_receipt`、`outsource_receipt`。
- `SupplierPayableService.createFromSource()` 不接受工资台账、工资付款等来源。
- 工资侧使用独立的 `PayrollLedger -> SalaryPayment -> SalaryPaymentAllocation`。
- 没有从 `PayrollLedger` 自动生成 `SupplierPayableEntry` 的服务或接口。

结论：

- 如果业务要求“工资结算后进入应付账款”，当前需要新增工资应付来源或工资应付单模型。
- 如果只是内部工资发放台账，当前 `SalaryPayment` 可以独立运行。

## 5. 已支付员工工资能否清楚标明，避免重复/漏算

**结论：后端状态与金额控制较完整，前端展示还不够清楚。**

已有能力：

- 工资台账状态：`draft -> confirmed -> partially_paid -> paid -> closed`，另有 `expired`。
- 工资付款状态：`draft -> posted -> reversed`。
- 核销分配状态：`active -> reversed`。
- `PayrollLedgerService.summary()` 返回：
  - 应发金额
  - 已支付金额
  - 未支付余额
- `PayrollLedgerService.refreshStatus()` 根据有效已过账分配重算状态。
- `SalaryPaymentService.post()`：
  - 必须至少核销一条有效台账；
  - 同一付款不能重复核销同一台账；
  - 不能超过台账未付余额；
  - 不能超过付款金额。
- `SalaryPaymentService.reverse()` 会反向核销并恢复台账状态。

缺口：

- `finance/salary/page.tsx` 列表主要展示状态，未直接展示“已付 / 未付 / 已冲销”金额列。
- 缺少重复支付、漏算的显式预警和业务提示。
- 已支付台账的来源变化只写审计事件，页面提示可能不足。

## 6. 非车间员工工资能否人工填写编辑，发放后能否标记清楚

**结论：能人工填写和编辑；发放状态逻辑与车间一致，但页面金额展示同样不足。**

证据：

- `collectProductionSources()` 对非车间返回生产来源金额 `0`。
- `PayrollLedger.generate()`、`update()` 支持 `base_salary`、`overtime_amount`、`attendance_deduction`、`performance_amount`、`allowance_amount`、`social_insurance`、`individual_tax`、`other_adjustment`。
- 非车间工资由财务在 `finance/salary` 页面新增/编辑台账。
- 支付后走同一套 `SalaryPayment` 和 `SalaryPaymentAllocation` 状态机。

注意：

- 非车间员工不能依赖生产日报金额，必须人工填写。
- 已确认/已支付后仍受同样的回退限制。

## 7. 应付条目到薪资台账是否有回退机制

**结论：当前不存在“应付条目 -> 薪资台账”这条业务链，因此也没有对应回退机制。**

当前实际链路是：

```text
PayrollLedger -> SalaryPayment -> SalaryPaymentAllocation
```

不是：

```text
应付条目 -> 薪资台账
```

现有的工资回退机制：

- `PayrollLedger.reopen()`：仅 `confirmed`、`expired` 可回到 `draft`。
- `PayrollLedger` 调整单：通过 `PayrollAdjustment` 增加/减少金额。
- `SalaryPayment.reverse()`：冲销工资付款，反向核销并恢复台账状态。
- `PayrollAdjustment` 冲销：已过账调整可冲销。

如果业务要求工资进入应付，再通过应付回退到工资，当前系统没有建设该链路。

## 8. 成品 QC 出库能否自动转应收

**结论：能。成品出库过账后自动生成应收来源草稿。**

证据：

- `FinishedGoodsOutboundService.postOutbound()` 在事务中创建 `ReceivableSource`：
  - `sourceNo`
  - `orderNo`
  - `salesOrderId`
  - `outboundId`
  - `customerId`
  - 数量、单位、销售单价、税率、金额、币种
  - 初始状态 `draft`
- 出库过账前会校验库存和销售单价：
  - 库存不足拒绝；
  - 销售单没有有效销售单价拒绝。
- `ReceivableSource.outboundId` 唯一，避免重复生成。
- `ReceivableService.createFromOutbound()` 也支持手工/幂等创建，已有来源直接返回或恢复软删除。

注意：

- 应收来源生成自“成品出库过账”，不是 QC 记录直接生成。
- 完整链路是：成品 QC -> 成品入库 -> 成品出库过账 -> 应收来源。

## 9. 应收条目到 QC 过程是否有回退机制

**结论：不完整。出库冲销不会联动处理应收来源，存在应收残留风险。**

已有能力：

- `ReceivableService.reopen()`：confirmed 且无有效收款核销时，可回退 draft。
- `ReceivableService.cancel()`：未收清且无有效收款核销时，可取消。
- `ReceivableAdjustment`：支持退款、红冲、折让、坏账、补收。
- `CustomerPayment.reverse()`：冲销收款并恢复应收状态。

缺口：

- `FinishedGoodsOutboundService.reverseOutbound()` 只创建反向库存事实，不检查、取消、冲销或阻断对应 `ReceivableSource`。
- 如果出库已经生成应收、应收已确认或已收款，出库冲销不会给出财务阻塞提示。
- 缺少从出库冲销反向驱动应收取消/调整的正式回退机制。
- 需要补充规则：
  - 有草稿应收：出库冲销时提示先取消或自动作废；
  - 有已确认应收：提示先回退草稿；
  - 有有效收款核销：必须先冲销收款或做应收调整；
  - 有已收清应收：禁止直接冲销出库。

## 10. 原料 QC 入库能否自动转应付，金额和 QC 结果是否关联

**结论：入库过账后能生成应付来源；金额与 QC 结果目前是“间接关联”，不是按 QC 三结果直接计价。**

已有能力：

- `RawMaterialInboundsService.post()` 在入库过账后创建 `PayableSource`。
- 应付来源包含：
  - order_no
  - purchase_order/item
  - supplier
  - quantity
  - unit_price
  - tax_rate
  - amount
  - currency
- 应付来源与入库单建立唯一来源关系。
- `receipt` 阶段不应再生成有效应付；应付生成时点应统一到入库过账。

当前金额逻辑：

```text
应付金额 = 入库数量 × 采购单价
```

或人工覆盖金额。

QC 结果关联现状：

- QC 拒收不能入库，因此不能生成应付。
- 合格/条件接收/部分合格数量决定可入库上限。
- 应付金额跟随实际入库数量变化。
- 当前没有按“全部入库 / 部分入库 / 拒收”直接生成不同结算金额的完整逻辑。
- 部分入库的“数量、单价、总价、原因”目前只是新加/待接线字段，尚未完整写入应付来源。

缺口：

- QC 结论与应付金额需要统一口径并落实字段；
- 部分入库的人工结算单价、总价、原因必须进入应付来源快照；
- 应明确条件接收是否折价，以及折价如何影响应付。

## 11. 原料 QC 入库到应付是否有回退机制

**结论：只覆盖了待确认应付来源；已确认/已付款应付的回退链不完整。**

已有能力：

- `RawMaterialInboundsService.reverse()`：
  - 只有已过账入库可以冲销；
  - 必须填写原因；
  - 校验冲销后库存不为负；
  - 创建反向库存事实；
  - 将对应 `pending_finance` 应付来源置为 `voided`。
- `IncomingInspectionsService.returnToSupplier()`：
  - 有原料入库事实时拒绝整批退货；
  - 未过账应付来源可作废；
  - 已过账应付来源拒绝退货。
- `SupplierPayableService.reopen()`：已确认但未付款应付可回退草稿。
- `SupplierPayableService.reverse()`：已确认/部分付款/已付清且无有效付款核销时可冲销。
- `SupplierPaymentService.reverse()`：已过账付款冲销后可恢复应付余额。

缺口：

- 入库冲销只处理 `pending_finance` 应付来源。
- 已确认应付、已有付款核销、已付款的应付没有联动处理。
- 入库冲销不会强制要求先冲销付款/应付，可能造成库存减少但应付仍有效。
- 缺少统一影响预览，明确展示库存、应付、付款、核销受影响范围。
- 需要建立顺序规则：

```text
先冲销付款核销
-> 再冲销/回退应付
-> 再冲销原料入库
-> 再处理 QC/到货更正
```

## 总结

| 编号 | 问题 | 当前结论 |
|---|---|---|
| 1 | 车间工资进入薪资台账 | 已实现 |
| 2 | 单价/数量变化联动台账 | 草稿自动更新，确认转过期，已支付不自动改 |
| 3 | 按日期范围统计台账 | 前端可筛选，后端范围统计不完整 |
| 4 | 工资结算成应付条目 | 未实现 |
| 5 | 已支付工资标识、防重复漏算 | 后端状态完整，前端金额提示不足 |
| 6 | 非车间工资人工填写/发放标记 | 已实现，展示提示不足 |
| 7 | 应付条目到薪资台账回退 | 链路不存在，无回退机制 |
| 8 | 成品出库自动转应收 | 已实现，出库过账自动生成应收草稿 |
| 9 | 应收条目回退到出库/QC | 出库冲销不联动应收，回退链不完整 |
| 10 | 原料入库自动转应付、QC 关联金额 | 已生成应付，金额与 QC 仅间接关联 |
| 11 | 原料入库到应付回退 | 仅覆盖待确认应付，已确认/已付款不完整 |

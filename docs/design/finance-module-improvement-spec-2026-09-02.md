# 财务模块 P0/P1 改进规格

- 日期：2026-09-02
- 状态：ready-for-agent
- 范围：应收、应付、采购/外加工财务来源、工资来源与工资台账、财务单据治理
- 依据：`docs/audit/finance-warehouse-integration-audit-2026-08-30.md`、`docs/task/0831-user-requirements-gap/04-payable-inventory-differences.md`、`docs/task/0831-user-requirements-gap/05-payroll-chain.md`

## Problem Statement

当前系统已经能从成品出库、采购到货、原料入库、外加工签收和车间员工生产日报产生财务相关业务事实，但财务事实分为“来源”和“正式台账”两层，页面和状态规则没有完全对齐：

- 成品出库过账会创建草稿应收，但财务页面只对 `pending_finance` 展示确认动作，导致自动产生的应收草稿可能无法确认。
- 采购到货、原料入库和外加工签收先产生待处理应付来源；正式应付必须由财务人工接收，这是有意的职责边界，但接收入口、来源类型、幂等和状态展示尚未形成完整闭环。
- 应付对账需要按供应商、采购单和批次核对来源、正式应付、付款、冲销与外部余额，现有能力不足以稳定支撑该工作。
- 工资自动化范围需要收窄并明确：只有车间员工的工序生产日报收入自动形成生产工资来源；车间员工其他收入、非车间员工全部收入来源均由人工填写，不从考勤、绩效或其他记录自动推导工资金额。
- 财务单据的草稿、确认、付款/收款、冲销、更正和审计规则未形成统一可执行的产品契约。

## Solution

建立“业务事实先形成待处理来源，财务人员再人工接收为正式财务台账”的统一财务边界，并优先修复 P0/P1 缺陷：

1. 修复应收草稿确认条件和页面动作，使成品出库形成的应收来源可以被财务确认。
2. 完成采购到货、原料入库、外加工签收来源到正式应付的人工接收闭环；不自动跳过财务接收。
3. 完成供应商应付对账，支持来源、应付、付款、冲销和外部余额的可解释差异。
4. 固化工资来源边界：车间生产日报自动生成生产工资来源，其余工资收入和扣款由人工维护；工资台账可汇总、确认和支付。
5. 统一财务单据状态、编辑、冲销、调整、版本和审计规则，防止已产生下游事实的记录被静默覆盖。

## User Stories

1. As a 财务人员, I want to see every receivable source created by a posted finished-goods outbound, so that shipped goods cannot disappear from accounts receivable.
2. As a 财务人员, I want a draft receivable source to expose a confirm action, so that I can accept a valid source into the confirmed receivable ledger.
3. As a 财务人员, I want the receivable source to retain order, customer, outbound, quantity, unit price, tax rate, currency and amount snapshots, so that the amount can be explained later.
4. As a 财务人员, I want missing sales price to require an explicit amount and reason, so that manually determined receivables remain auditable.
5. As a 财务人员, I want to cancel or adjust an uncollected receivable with a reason, so that refunds, discounts, bad debt and corrections do not overwrite the original source.
6. As a 财务人员, I want to register a customer payment as a draft, so that cash receipt can be recorded before allocation.
7. As a 财务人员, I want to allocate a posted customer payment to one or more confirmed receivables, so that partial payment and remaining balance are visible.
8. As a 财务人员, I want reversed allocations to restore receivable availability, so that a reversed payment does not continue to reduce the balance.
9. As a 采购/仓库人员, I want a valid purchase receipt to create a pending payable source, so that the received quantity and supplier amount are available for finance review.
10. As a 仓库人员, I want posting a raw-material inbound to create inventory and, when necessary, a pending payable source in one transaction, so that stock and financial source cannot diverge.
11. As a 外加工业务人员, I want an outsource receipt to create a pending payable source, so that subcontracting settlement is based on actual received quantity rather than dispatch quantity.
12. As a 财务人员, I want to review pending payable sources by supplier, order, purchase order, inbound/receipt batch and source type, so that I can decide which facts are financially acceptable.
13. As a 财务人员, I want to manually accept a pending payable source into a formal payable entry, so that finance remains the approval boundary.
14. As a 财务人员, I want accepting the same source repeatedly to return the existing payable entry, so that retries never duplicate a liability.
15. As a 财务人员, I want to change a draft payable amount only with a reason and snapshot, so that invoice or settlement differences are explainable.
16. As a 财务人员, I want a source to become voided when its upstream inbound or outsource receipt is reversed, so that invalid facts cannot be accepted later.
17. As a 财务人员, I want to confirm a payable entry after reviewing its source, so that payment allocation only targets confirmed liabilities.
18. As a 财务人员, I want to create a supplier payment draft and allocate it across payable entries, so that partial and multi-batch payments are supported.
19. As a 财务人员, I want payment allocation to reject excess amount, currency mismatch and duplicate allocation, so that payable balances remain correct.
20. As a 财务人员, I want to reverse a posted supplier payment and restore payable balances, so that bank corrections are represented without deleting history.
21. As a 财务人员, I want to create an accounts-payable reconciliation by supplier, purchase order and period, so that supplier statements can be compared with system facts.
22. As a 财务人员, I want the reconciliation snapshot to include pending sources, confirmed payables, posted payments, reversals and adjustments, so that the system balance is reproducible.
23. As a 财务人员, I want to record an external balance, difference and resolution remark with attachments, so that supplier disputes have an auditable resolution.
24. As a 车间主管, I want an employee production daily report saved in piece-rate or time-rate mode to automatically create or refresh one production payroll source, so that production income is not re-entered.
25. As a 车间主管, I want repeated daily reports for the same employee, production order, date and wage mode to accumulate idempotently, so that retries do not duplicate production income.
26. As a 人事/财务人员, I want workshop employees' non-production income to be entered manually, so that the system does not infer allowances or other income from unrelated records.
27. As a 人事/财务人员, I want all non-workshop employee income sources to be entered manually, so that payroll policy remains under human control.
28. As a 人事/财务人员, I want attendance, performance, social insurance, individual tax, allowance and other adjustments to remain explicit ledger inputs, so that no unapproved automatic calculation changes salary.
29. As a 财务人员, I want to generate one payroll ledger per employee and period and see the imported workshop production source snapshot, so that the payable salary is reviewable.
30. As a 财务人员, I want to confirm, pay, partially pay, reverse and close payroll ledgers with balances, so that employee payment status is reliable.
31. As a 财务人员, I want draft finance documents to be editable and confirmed documents to be protected, so that operational mistakes require controlled correction.
32. As a 财务人员, I want every confirm, receive, post, allocate, reverse, adjust and reconcile action to record actor, time, reason and before/after values, so that audit review is possible.
33. As a 业务负责人, I want an order-level view linking sales, outbound, receivable, payment, procurement, receipt, inbound, payable and supplier payment, so that financial completeness can be checked by order number.

## Implementation Decisions

### 1. 财务来源哲学

- 上游模块只产生业务事实和待处理来源，不直接创建已确认的财务台账。
- 财务人工接收是从“来源”到“正式应付/应收台账”的职责边界；接收动作必须显式、可追溯、可重试。
- 来源快照是只读业务事实；正式台账允许在草稿阶段进行受控金额修正，但不得静默改写来源事实。
- 任何来源、台账或付款冲销都保留原记录，使用状态和反向事实表达更正。

### 2. 应收 P0

- 成品出库过账继续创建 `ReceivableSource` 草稿；来源必须关联订单号、销售单、客户和出库单。
- 财务页面和 API 统一以 `draft` 作为可确认应收来源状态；不得使用与应付来源混用的 `pending_finance` 判断。
- 有销售单价时金额为出库数量乘销售单价；无单价时允许财务填写金额，但必须填写金额原因。
- 确认后进入 `confirmed`；收款过账按分配金额将其更新为 `partially_paid` 或 `paid`。
- 退款、折让、红冲、坏账和纠正通过独立调整记录处理；不直接覆盖来源金额。
- 同一出库单最多对应一个应收来源，重复请求返回已有来源。

### 3. 应付 P0

- 采购到货批次、原料入库过账、外加工实际签收分别形成待处理来源。
- 采购到货来源按实际到货数量和采购单价生成；原料入库过账只在对应来源不存在时补建；外加工按实际签收数量生成。
- 来源类型至少区分 `raw_material_inbound`、`purchase_receipt`、`outsource_receipt`，正式应付条目保留来源类型和来源编号快照。
- 财务提供统一待处理来源列表和接收动作；接收动作创建 `SupplierPayableEntry` 草稿，不自动确认。
- 接收动作以来源唯一关联和幂等键防止重复应付；来源已作废、已被接收或上游已冲销时拒绝或返回已有条目。
- 正式应付草稿可修改金额、确认日期和备注；金额变化必须记录差异原因，且保留原始来源数量、单价、税率和金额。
- 应付确认后才允许付款核销；付款核销不得超过可用余额，支持部分付款、未分配付款和冲销。
- 上游入库/签收冲销必须将尚未接收的来源置为 `voided`；已接收或已付款的应付不得被上游静默作废。

### 4. 应付对账 P0

- 使用供应商、订单号、采购单、期间和币种作为对账筛选维度。
- 对账快照分别记录待处理来源、正式应付、已付款、已冲销、调整和系统余额；外部余额和差异由财务录入。
- 对账处理必须保存差异说明、处理备注、附件、操作人和时间；已处理记录不可无原因覆盖。
- 默认按入库/签收批次保留明细、按采购单和供应商汇总展示。

### 5. 工资 P1（限定自动化）

- 仅车间员工的工序生产日报自动生成 `ProductionPayrollSource`。
- 自动来源的粒度为员工 + 生产单 + 日期 + 计薪方式；计件金额为件数乘单价，计时金额为时长乘单价。
- 生产日报新增、修改、删除必须在同一事务内刷新工资来源、差异告警和生产进度；重复提交必须幂等或累加符合既定日报规则。
- 车间员工的基本工资、津贴、奖金、补贴等其他收入，以及所有非车间员工收入，均由工资台账人工填写，不从考勤、绩效或其他模块自动生成收入金额。
- 考勤、绩效、社保、个税、扣款和其他调整只作为显式人工台账字段或调整记录；本规格不实现自动算薪规则。
- 工资台账保留生产来源快照，支持草稿、确认、部分支付、已付清、关闭和冲销/调整。

### 6. 财务单据治理 P1

- 草稿可编辑；确认后禁止直接修改核心金额和来源关联。
- 已确认但尚未付款的记录如需改动，必须走受控回退或调整；已有付款/收款的记录只能通过冲销、退款、补收、补付或调整处理。
- 需要影响预览的动作应先返回余额、下游事实和风险，再允许提交。
- 涉及并发修改的来源、台账、付款和工资记录使用版本或事务锁保护。
- 所有业务列表以订单号、采购单号、来源编号、客户/供应商名称和批次展示，UUID 仅作为内部关联键。

### 7. 推荐模块边界

- 采购/仓库/生产：产生业务事实和待处理来源。
- 财务：接收来源、确认台账、收付款、核销、调整、冲销和对账。
- 人事：维护员工档案及工资人工输入；车间日报由生产模块产生自动工资来源。
- 订单工作台：只读聚合各模块事实和差异，不在前端重复计算财务余额。

## Testing Decisions

- 测试最高 seam 采用真实 API 服务加 PostgreSQL 事务链路；页面测试只验证用户可见状态和按钮可用性。
- P0 必须覆盖真实业务链路：成品出库过账 -> 应收草稿 -> 应收确认 -> 收款核销；采购到货/原料入库 -> 待处理应付来源 -> 人工接收 -> 应付确认 -> 付款核销；外加工签收 -> 应付来源 -> 接收。
- 应付测试必须验证：重复接收幂等、来源作废、上游冲销、金额差异、币种不一致、超额付款、部分付款和付款冲销。
- 应收测试必须验证：自动生成草稿、页面确认条件、无单价人工金额与原因、重复创建、调整超过余额拒绝和收款冲销后余额恢复。
- 工资测试必须验证：车间生产日报自动来源、同自然键累加、修改/删除同步、计件与计时金额、非生产收入不自动生成、非车间员工不自动生成生产来源、工资台账快照和支付余额。
- 状态治理测试必须验证：草稿编辑、确认后禁止静默修改、下游事实存在时拒绝危险操作、版本冲突和审计事件。
- 采用现有单元测试、HTTP 合约测试、真实 PostgreSQL 集成测试和 Playwright 登录后工作流测试模式；不得以 TypeScript 构建通过替代跨模块验收。

## Out of Scope

- 会计总账、凭证、会计科目和财务期间结账。
- 发票自动验真、税务申报、银行直连和银行流水自动导入。
- 考勤自动算薪、绩效自动转奖金、社保和个税自动计算。
- 车间员工非生产收入、非车间员工收入的自动来源推导。
- 多仓库、库位、批号成本、先进先出、单位换算和自动排产/采购建议。
- 完整审批流配置；本期只保留权限、操作人、原因、附件和审计门禁。

## Further Notes

- 本规格把“来源”和“正式台账”明确分层：来源代表业务事实，台账代表财务确认结果。该分层不是临时绕路，而是采购、外加工、成品出库和工资来源统一采用的设计原则。
- 第一批开发建议拆成四个可独立验收的任务：应收草稿确认修复；采购/外加工应付来源人工接收闭环；供应商应付对账；限定范围的日报工资来源与工资台账治理。
- 发现的现有高风险缺陷：应收来源创建为 `draft`，但财务页面确认按钮判断 `pending_finance`；外加工应付来源已有后端模型，但财务接收入口需要支持其来源类型；工资字段已覆盖多种收入和扣款，但自动来源必须严格限制为车间生产日报。
- 每个任务完成后都应在订单工作台验证同一订单号下的数量、金额、来源状态、余额和审计记录，避免各模块单独通过但链路不一致。

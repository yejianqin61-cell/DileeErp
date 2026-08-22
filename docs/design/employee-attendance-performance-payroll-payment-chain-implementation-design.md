# F1-F3 员工、考勤、绩效与薪资支付链路开发设计

> 文档类型：人事财务纵向链路开发设计
>
> 链路：员工目录 -> 月度考勤/绩效 -> D5 生产薪资来源 -> 月度薪资台账 -> 分批/一次性工资支付

## 1. 目标与边界

本链路承接 D1 员工目录、D2 工序计价和 D5 员工计件/计时日报。V1.0 支持操作员人工维护考勤、绩效和薪资构成，按自然月形成薪资台账并记录工资支付。不接考勤机、排班、社保/个税自动计算、银行代发和审批流。

考勤与绩效只作为人工调整参考，不自动改变工资；D5 生产薪资来源按员工和月份汇总，作为不可编辑快照进入台账。

## 2. 数据链路与事实边界

```text
Employee
  -> AttendanceRecord / PerformanceRecord
D5 ProductionPayrollSource
  -> PayrollLedger（生产来源快照 + 独立调整行）
  -> SalaryPayment -> SalaryPaymentAllocation
```

已确认的 D5 日报、生产薪资来源和工资付款事实不可直接覆盖。更正通过逻辑删除、冲销、独立薪资调整或补付记录完成，并保留操作人、时间、原因和前后快照。

## 3. 核心对象与状态

### 3.1 `AttendanceRecord`

员工、日期、考勤类型、出勤小时、加班小时、备注、附件、审计字段。类型由可维护字典提供；同一员工同一日期允许多条不同类型记录，但同一类型不得重复有效记录。人工录入，不自动计薪。

### 3.2 `PerformanceRecord`

员工、自然月、评分、等级、奖惩金额、评语、附件和审计字段。同一员工同一月份一条有效记录；金额可正可负但必须使用 Decimal。

### 3.3 `PayrollLedger`

月度薪资台账，按员工和 `period_start/period_end` 唯一。字段包含基本工资、生产薪资来源金额快照、加班、考勤扣款、绩效奖惩、补贴、社保、个税、其他调整、实发金额、币种、状态、附件和审计字段。

状态：`draft -> confirmed -> partially_paid -> paid -> closed`；确认后金额不能直接编辑。

### 3.4 `PayrollAdjustment`

独立薪资调整行，关联台账，类型可配置，方向 `increase/decrease`，金额正数，原因必填。过账/冲销不改写生产薪资来源；台账实发金额由快照基础金额加减有效调整汇总。

### 3.5 `SalaryPayment` 与 `SalaryPaymentAllocation`

工资支付和台账核销事实。支持一笔付款核销多名员工/多个月台账，一个台账由多笔付款分批核销。支付状态 `draft -> posted -> reversed`，核销状态 `active -> reversed`。

## 4. 计算规则

```text
生产薪资来源 = D5 ProductionPayrollSource.amount 按员工+月份汇总
应发基础 = 基本工资 + 生产薪资来源 + 加班 + 绩效奖惩 + 补贴 - 考勤扣款 - 社保 - 个税
实发应付 = 应发基础 + 有效薪资调整增加 - 有效薪资调整减少
未支付 = 实发应付 - 有效工资支付核销
```

所有金额和时长使用 Prisma Decimal；计时日报中的件数仅用于生产统计和 D5 差异核对，不进入生产薪资来源金额。

## 5. 更正、影响和审计

- 生成台账时保存 D5 来源 ID、月份、件计/计时金额和来源数量快照；之后 D5 变更不静默改写已生成台账。
- 台账确认前允许编辑基础字段；确认后只能通过独立调整行更正。
- 有效工资支付后，台账冲销必须先处理付款核销；付款冲销在同一事务内恢复台账状态。
- 所有写操作必须保留 `created_at/updated_at/created_by/updated_by`、操作原因和 `AuditEvent`。

## 6. REST API

统一前缀 `/api/v1/hr`，认证、`hr` 模块权限和 `{ data, meta }` 响应。

```text
GET/POST/PATCH/DELETE /attendance-records
GET/POST/PATCH/DELETE /performance-records
GET/POST /payroll-ledgers/generate
GET /payroll-ledgers
GET /payroll-ledgers/:id
POST /payroll-ledgers/:id/confirm
POST /payroll-ledgers/:id/close
POST /payroll-ledgers/:id/adjustments
POST /payroll-adjustments/:id/post
POST /payroll-adjustments/:id/reverse
GET/POST /salary-payments
POST /salary-payments/:id/post
POST /salary-payments/:id/reverse
GET /payroll-summary?employee_id=&period_start=&period_end=
```

## 7. 验收标准

1. 考勤和绩效可人工维护，不能自动覆盖工资。
2. D5 生产薪资按员工月份生成不可编辑来源快照，计时件数不计薪。
3. 台账支持独立调整，确认后禁止直接修改；实发、未付和状态使用 Decimal 派生。
4. 工资支付支持一次性/分批和多对多核销，阻止超额核销，冲销可恢复余额。
5. API 类型检查、构建、单元测试通过；真实环境不可用时明确记录阻断。


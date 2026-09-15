# 工资管理：月度工资台账满页表格与工资付款筛选（2026-09-15）

> 用户需求原文（第 3、4 条）：
>
> 3. 工资管理，工资台账，做成表格 UI，每个月自动先导入全部员工。车间员工自动导入所有该员工参与的
>    生产单相关的工序的金额（只要一个金额 column 就行了）。不能漏掉任何一单任何一个工序任何一天。
>    非车间员工工资都先为零。所有单元格允许用户改动，除了车间工人的计件计时生产工资。
>    工资的条目类目包含：基本工资（车间的工人的生产工资就放这里），绩效，房补，迟到扣款，旷工扣款，早退扣款。
> 4. 工资台账和工资付款都做成全屏表格 UI，支持按照：月份，部门，岗位，员工姓名/工号 来筛选。

## 1. 排查结论（先回答「另一个 agent 完成度如何」）

| 需求 | 现状 | 结论 |
| --- | --- | --- |
| 工资台账满页表格 + 月份/部门/岗位筛选 | `app/finance/salary/page.tsx`（2026-09-14 任务 04）已是一张满页表，`GET /hr/payroll-ledgers` 支持 `month/department_id/position_id` | **已完成**，本次不推翻 |
| 员工姓名/工号筛选 | 前端本地关键字同时匹配 `name` 与 `employeeNo` | 已完成 |
| 工资付款满页表格 + 同样四个筛选 | 付款只是台账页下面的一块 panel，`GET /hr/salary-payments` **只支持 `status`**，没有月份/部门/岗位/员工维度 | **未完成** |
| 每月自动导入全部员工 | 只有 `POST /hr/payroll-ledgers/generate`（必须指定一个员工），无批量导入 | **未完成** |
| 车间员工自动带入生产工资 | `PayrollLedger` 的生产金额来自 `production_payroll_sources`（派生表），不是日报本身 | **口径需改**（见 §4.5） |
| 条目类目：基本工资/绩效/房补/迟到扣款/旷工扣款/早退扣款 | 现有列是 基本工资/生产来源/加班/考勤扣款/绩效/补贴/社保/个税/其他调整；房补与三种扣款**不存在** | **未完成** |
| 单元格逐个可改（车间生产工资除外） | 只能整条台账走弹窗编辑 | **未完成** |
| 不能漏掉任何一单任何一个工序任何一天 | 无逐单/逐工序/逐日明细可核对 | **未完成** |

即：第 4 条的「工资台账」半边是别人做过的，其余全部本次实现。

## 2. 落地范围

- 新增 4 个工资类目列（房补、迟到扣款、旷工扣款、早退扣款），绩效复用 `performance_amount`，
  基本工资复用 `base_salary`（车间部分复用 `production_source_amount`）。
- 新增 `POST /hr/payroll-ledgers/import-month`：按月**幂等**导入全部在册员工，车间员工同时算生产工资。
- 生产工资的取数口径从 `production_payroll_sources` 改为**员工日报本身**，并按
  「天 × 生产单 × 工序 × 计薪方式」展开成明细快照。
- 新增可编辑满页表格组件（键盘可导航、单击单元格即改、Enter 保存、Esc 取消）。
- 工资管理页拆成「工资台账 / 工资付款」两个 tab，共用一条筛选条。
- `GET /hr/salary-payments` 支持 `month/department_id/position_id`。

## 3. 类目映射

甲方确认过的类目清单（2026-08-20 备忘第 7 条：*「还有房补，这些就行了。要支持后期管理员自行增删改，
灵活为上」*）与本次需求合并后的落地口径：

| 需求类目 | 存储列 | 可编辑性 |
| --- | --- | --- |
| 基本工资（车间生产工资放这里） | 非车间：`base_salary`；车间：`production_source_amount` | 非车间可改；**车间只读**（由日报自动汇总） |
| 绩效 | `performance_amount` | 可改 |
| 房补 | `housing_allowance`（新增） | 可改 |
| 迟到扣款 | `late_deduction`（新增） | 可改 |
| 旷工扣款 | `absence_deduction`（新增） | 可改 |
| 早退扣款 | `early_leave_deduction`（新增） | 可改 |
| 其他增减（只读） | 加班工资 − 考勤扣款 + 补贴金额 − 社保 − 个税 + 其他调整 + 已过账调整 | 只读 |

### 决策 D1：不把老列改语义，而是新增列

`allowance_amount` 保持「补贴金额」语义，不复用成「房补」；`attendance_deduction` 保持「考勤扣款」，
不拆成三种扣款再去写回它（派生写回会立刻漂移）。新增 4 列的唯一代价是一次 `ALTER TABLE`，
换来的是**历史金额不被重新解释**。

### 决策 D2：老类目进「其他增减」列，不藏起来

新需求只列了 6 个可编辑类目，但老台账里的加班/考勤扣款/补贴/社保/个税/其他调整**参与应发计算**。
如果不显示，就会出现「应发 ≠ 表上可见列之和」的黑洞。因此表格增加一列**只读**的
「其他增减（自动）」＝ 上述老类目净额 + 已过账调整净额，并在明细弹窗里逐项展开。
新导入的台账这一列恒为 0。

### 决策 D3：车间工人的 `base_salary` 拒绝手工改为非零

车间工人的基本工资就是生产工资。若允许手工填 `base_salary`，表格上「基本工资」这一格就有了两个来源。
`generate`/`update` 对车间员工收到**非零** `base_salary` 时返回 422 `PAYROLL_BASE_SALARY_MANAGED`。
允许写 0 是为了让历史数据（老页面允许车间员工填基本工资）可以被清干净，不会卡死。

表格「基本工资」格的显示值 = `base_salary + production_source_amount`（两者都是基本工资池），
车间行只读并带拆分提示，非车间行可编辑（非车间的生产来源恒为 0，所以等价于直接改 `base_salary`）。

### 决策 D4：自动导入的触发时机

用户要「每个月自动先导入全部员工」。落地为：**筛选出月份后自动调一次幂等导入**（切月份也触发），
另在筛选条上保留一个「导入本月员工」按钮可手动重跑。导入只新建缺失的草稿台账，
已存在（含已确认/已付款/已软删）的一律不碰，因此重复访问同一月份是零写入。
每次导入写一条 `payroll_ledger.import_month` 审计。

### 决策 D5：谁算「该月的员工」

`deletedAt = null` 且**任职区间与该月有交集**（`hiredOn <= 月末` 且（`leftOn` 为空或 `leftOn >= 月初`））。
全部无任职日期的在册员工照常导入。月前已离职的人不导入（否则每月都多出一堆 0 元台账），
响应里以 `not_employed` 计数与名单返回，不静默丢弃。

### 决策 D6：软删除台账不会被自动导入复活

`payroll_ledgers` 上的唯一索引 `(employee_id, period_start, period_end)` **包含软删行**。
导入前按「包含软删」读取已存在集合，因此不会撞唯一索引（既有 `generate` 在软删后重生成会 P2002，
本次在导入路径上规避，并在服务里把这种情况明确归入 `existing`）。

### 决策 D7：可编辑的状态门禁沿用现有状态机

- `draft` / `expired`：表格里直接改，`expired` 改完自动回草稿（服务既有行为）。
- `confirmed`：**表格内只读**（格子上写明原因：先「回到草稿」）。整条台账仍可用行内「编辑」弹窗修改
  （必须填原因，保存后回到 `draft`）。不把「填原因」塞进单元格流程：弹窗要开着等用户填原因，
  而单元格的保存中状态会一直挂着，交互会变得难以理解。
- `partially_paid` / `paid` / `closed`：只读，提示走工资调整单/冲销（服务既有限制，不放开）。

### 决策 D8：导入的币种

导入不带币种参数时用 `CNY`（工资台账是单据，币种在台账上逐条存在，不对就逐条改或用「编辑」改）。
导入接口本身接受 `currency` 参数，需要整月换币种时可以显式传。

## 4. 后端设计

### 4.1 Schema

`payroll_ledgers` 新增 4 列，均 `DECIMAL(18,4) NOT NULL DEFAULT 0`：
`housing_allowance`、`late_deduction`、`absence_deduction`、`early_leave_deduction`。

### 4.2 统一应发公式

应发在 5 处出现过（列表 balances、详情 summary、付款刷新 refreshStatus、工资应付 netAmount、
工资付款过账的内联算式）。本次把公式收敛成 `hr-payroll.domain.ts` 的**唯一实现**
`payrollBaseAmount(fields): Prisma.Decimal`，五处全部改为调用它，避免「加了类目但漏改一处」
导致同一张台账在不同页面金额不一致。

```
应发 = 基本工资 + 生产来源 + 加班 − 考勤扣款 + 绩效 + 补贴 + 房补
       − 迟到扣款 − 旷工扣款 − 早退扣款 − 社保 − 个税 + 其他调整 + 已过账调整
```

顺带修掉一处口径不一致：`GET /hr/payroll-ledgers/:id/summary` 原先统计已付时**少了**
「工资付款已过账」这一层判断，同一张台账在列表与 summary 上会给出不同的已付/未付。
现在 summary 直接复用 `balances()` 的结果。

### 4.3 生产工资的取数与「不能漏单」的落实

新模块 `production-payroll.domain.ts`：

- `aggregateProductionPayroll(reports)` 纯函数，输入该员工该月的**全部**员工日报行，
  按 `(报告日期, 生产单, 工序, 计薪方式)` 分组，输出每一组的件数/时长/金额与日报 ID 列表，
  外加总计与 `report_count / day_count / order_count / operation_count` 四个计数。
- 取数只过滤 `deletedAt: null` 与 `reportDate ∈ [月初, 月末]`，**不做任何工序/订单/状态预筛**，
  因此「该员工参与过的每一张单、每一道工序、每一天」都会被聚合，不会因为某个订单/工序不在
  某个派生表里而漏算。
- 台账 `source_snapshot` 就写这份分组明细（含 `report_date`、`operation_name`、`report_count`、
  `report_ids`），明细弹窗逐行展示，件数/金额可与生产日报对账。
- 为什么不再用 `production_payroll_sources`：那张表是生产侧按「员工+生产单+日+计薪方式」维护的
  派生表，员工类型从车间改成非车间时会被软删（`employee-daily-reports.service.ts` 的
  `syncPayrollSource`），改回车间又不会自动补建 —— 用它汇总会**真的漏单**。日报才是事实源。

### 4.4 接口

| method | 路径 | 说明 |
| --- | --- | --- |
| POST | `/hr/payroll-ledgers/import-month` | 幂等导入某月全部在册员工，body：`month`（必填，`YYYY-MM`）、`department_id`、`position_id`、`employee_type`、`currency` |
| GET | `/hr/payroll-ledgers` | 既有：`month/department_id/position_id/employee_type/from/to/status` |
| PATCH | `/hr/payroll-ledgers/:id` | 新增 4 个类目字段；车间非零基本工资 422 |
| GET | `/hr/salary-payments` | 新增 `month/department_id/position_id` |

付款的筛选语义：**按核销到的员工命中**，即「该付款单至少有一条核销明细的员工属于所选部门/岗位」。
付款单可以跨多个员工核销，因此行上的金额始终是付款单总额，界面同时列出命中的员工，
不把它拆成「筛选后金额」以免与付款事实不符。

### 4.5 金额上限与异常口径

沿用既有护栏：聚合金额 ≥ 1e14 直接 422（`PAYROLL_LEDGER_AMOUNT_OUT_OF_RANGE`），
不把溢出留到数据库层变成 500；非法月份 422 `INVALID_MONTH`。

## 5. 前端设计

- `app/finance/salary/page.tsx` 变为服务端页（读 `searchParams.tab`，与服务端 tab 约定一致），
  渲染 `components/finance/salary-workspace.tsx`。
- `lib/finance-sections.ts` 新增 `SALARY_TABS`（工资台账 / 工资付款）并挂到 `FINANCE_BOARD_TABS.salary`。
- `components/finance/payroll-sheet.tsx`：满页可编辑表格。
  - 单元格 testid：`payroll-cell-<台账id>-<字段>`；编辑态输入框 `payroll-cell-input-<台账id>-<字段>`。
  - 交互：单击进入编辑；`Enter` 保存、`Esc` 取消、`Tab` 保存并右移；方向键在单元格间移动
    （容器 `tabIndex=0`）；非法金额就地报错不提交。
  - 只读单元格渲染文本并带 `data-readonly="true"` 与提示（车间基本工资 / 其他增减 / 已付款台账）。
  - 提交失败：不改本地值、单元格标红并 toast 原因。
- 筛选条：月份、部门、岗位、员工姓名/工号（本地过滤，与任务 04 的既有约定一致）。
- 工资付款 tab：全屏表格（支付单号/日期/金额/币种/员工/部门/岗位/状态/操作），
  保留新建、核销过账、冲销三个动作。

## 6. 验证

见 `docs/log/2026-09-15.md` 与任务记录 `docs/task/0914-finance-module-refactor/09-salary-ledger-sheet.md`。

## 7. 未验证与风险

- 迁移未在真实 PostgreSQL 上执行（本机无可用库）；`ALTER TABLE ... DEFAULT 0` 对既有行即时生效，
  但仍需在可用库上跑 `prisma migrate status` 确认无漂移。
- 付款按部门/岗位筛选依赖 `salary_payment_allocations -> payroll_ledgers -> employees` 的关联查询，
  真实库上的执行计划未验证（数据量大时可能需要索引）。
- 自动导入会在打开页面时写草稿台账（用户明确要求「自动」）；若不希望浏览即写库，
  可把自动调用改为只留按钮（一处开关）。

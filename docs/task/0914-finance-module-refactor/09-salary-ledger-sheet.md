# Task 09：工资台账满页可编辑表格与工资付款筛选

## 状态
已完成

## 认领
负责人：全栈 Agent
开始日期：2026-09-15

## 目标

按用户第 3、4 条需求完成「工资管理」：

- 工资台账做成**可编辑**满页表格：每月自动导入全部员工；车间工人的计件/计时工资由生产日报
  自动汇总进「基本工资」且不可手改；非车间员工先为零；其余类目逐格可改；
- 类目为 基本工资 / 绩效 / 房补 / 迟到扣款 / 旷工扣款 / 早退扣款；
- 工资台账与工资付款都支持「月份 + 部门 + 岗位 + 员工姓名/工号」筛选。

来源设计：[工资管理：月度工资台账满页表格与工资付款筛选](../../design/payroll-ledger-monthly-sheet-2026-09-15.md)

## 背景与问题

- 2026-09-14 的任务 04 已经交付「工资台账满页表格 + 月/部门/岗位筛选」，但**只读**、且没有
  「每月导入全部员工」与车间生产工资的自动汇总口径；工资付款只是台账页底下的一个 panel，
  接口只支持 `status`，没有月份/部门/岗位维度；
- 车间工资原先取 `production_payroll_sources`（生产侧派生表）：员工类型车间→非车间时该表会被软删、
  改回车间不补建，拿它汇总工资会**真的漏单**。

## 范围

### 后端

- `payroll_ledgers` 新增 `late_deduction` / `absence_deduction` / `early_leave_deduction` / `housing_allowance`
  四列（`DECIMAL(18,4) NOT NULL DEFAULT 0`），老列语义不动；
- 新增 `production-payroll.domain.ts`：把员工日报按「日期 × 生产单 × 工序 × 计薪方式」汇总，
  取数不做订单/工序预筛，并给出日报条数/天数/单数/工序数四个覆盖度计数；
- 生产工资改从**员工日报**取数（`collectProductionSources`），台账 `source_snapshot` 写逐行明细；
- 新增 `POST /hr/payroll-ledgers/import-month`：按月幂等导入全部在册员工；
- 应发公式收敛到 `payrollBaseAmount()` 一处（原先 5 处各写一遍），summary 与列表统一口径；
- 车间工人的 `base_salary` 手工改成非零 → 422 `PAYROLL_BASE_SALARY_MANAGED`（允许清零，留清理路）；
- `GET /hr/salary-payments` 新增 `month` / `department_id` / `position_id`（按核销到的员工命中）。

### 前端

- `/finance/salary` 改为服务端页（读 `searchParams`）转 `components/finance/salary-workspace.tsx`；
- 新增 `components/finance/payroll-sheet.tsx`：可编辑满页表格（单击编辑、Enter 保存、Esc 取消、
  Tab 右移、方向键换格、清空=0、值没变不打接口、失败标红并显示原因）；
- 新增 `SALARY_TABS`（工资台账 / 工资付款），子栏目链接带上当前筛选；
- 进页面/切月份自动调一次 `import-month`，导入完成后再拉列表，并显示导入摘要。

## 不做

- 不做社保/个税/考勤的自动计算（2026-08-20 备忘确认：V1.0 人工维护）；
- 不做银行代发文件与薪酬审批流；
- 不做薪资构成类目的后台增删改（用户已确认是「后期」能力，本次先固定成 6 个类目 + 只读「其他增减」兜住历史类目）。

## 验收与验证

1. 导入幂等：重复访问同一月份零写入、零日报读取；软删台账不会被复活（唯一索引含软删行）；
2. 「不能漏单」：跨订单/工序/日期/计薪方式的日报全部进快照，金额等于日报逐条求和；取数断言不含订单/工序过滤条件；
3. 车间「基本工资」格只读且提示原因；非车间可改；五个新类目逐格 PATCH 的字段名与 DTO 一致；
4. 已确认台账表格内只读、`expired` 可改；`partially_paid/paid/closed` 无行内动作；
5. 付款筛选按核销员工命中，行金额仍是付款单总额；
6. 失败路径：非 API 异常、403、409、422（保存失败原因出现在表格里且弹窗不关）。

## 决策记录

见设计文档 §3 的 D1–D8（老类目进只读「其他增减」、车间基本工资守卫、软删不复活、状态门禁、
导入币种等）。

## 完成记录

- 后端：`hr-payroll.domain.ts`（统一公式 + 月份区间 + 基本工资/其他增减两格口径）、
  `production-payroll.domain.ts`（日报汇总）、`payroll-ledger.service.ts`（import-month、日报取数、
  车间基本工资守卫、balances 增收两个只读格）、`payroll-payable.service.ts` / `salary-payment.service.ts`
  （改用统一公式）、`salary-payment.service.ts`（付款筛选）、`hr.controller.ts`（import-month 端点与 DTO）、
  迁移 `20260915140000_payroll_ledger_salary_categories`；
- 前端：`payroll-sheet.tsx`、`salary-workspace.tsx`、`app/finance/salary/page.tsx`、`finance-sections.ts`、
  `finance-tabs.tsx`（带上筛选参数）、`globals.css`（表格样式）；
- 单测：新增 `production-payroll-domain`、`payroll-ledger-migration`，重写 `hr-payroll-domain`、
  `payroll-ledger-service`、`salary-payment-service`，更新 `payroll-payable-service`；
  组件测试 `test/salary-page.test.tsx` 重写为 48 条；
- 验证结果：api 1085/1085、web 580 + lib 128 全绿；api/web typecheck 通过；web build 通过
  （`/finance/salary` 9.6 kB，45/45 静态页）。

## 未验证

- 迁移未在真实 PostgreSQL 上执行（本机无可用库）：`ALTER TABLE ... DEFAULT 0` 的行为与
  `prisma migrate status` 无漂移待真实库确认；
- 付款按部门/岗位筛选的关联查询（`salary_payment_allocations → payroll_ledgers → employees`）
  未在真实数据量上验证执行计划；
- 表格未在浏览器里做过大规模数据（数百员工 × 十几列）的性能验证。

# Task 04：工资管理满页表格与月 / 部门 / 岗位筛选

## 状态
已完成

## 认领
负责人：全栈 Agent
开始日期：2026-09-14

## 目标

工资台账改为满页表格视图，按「月 + 部门 + 岗位」筛选，原有工资动作全部保留。

## 背景与问题

- 旧页把台账拆成「车间 / 非车间」两张表，同一份数据两处渲染，且没有任何部门/岗位维度；
- 后端 `GET /hr/payroll-ledgers` 只支持 `employee_id/期间/status`，返回的 `employee` 也只有
  `departmentId`/`positionId`（没有名称），前端拿不到部门与岗位；
- `GET /hr/payroll-ledgers/:id` 反而**没有**应发/已付/未付（只有列表算），详情与列表口径不一致。

## 范围

### 后端

- `GET /hr/payroll-ledgers` 新增 `month`（`YYYY-MM`，与 `from/to` 同为「期间有交集」）、
  `department_id`、`position_id`、`employee_type`；
- 返回 `employee.department` / `employee.position`；
- 列表与详情共用一个 `balances()` 计算应发/已付/未付。

### 前端

- 单张满页表格（pageSize 50），列含部门与岗位；
- 筛选：月份、部门（Radix Select）、岗位（随部门收窄，切部门清空岗位）、员工关键字（本地）；
- 双击行弹出详情：全部金额字段 + 生产日报来源 / 工资调整 / 工资付款核销三个分区；
- 动作全部保留：新建台账、编辑、确认、删除、回到草稿、生成应付、确认应付、关闭、新建工资付款、核销过账、冲销。

## 不做

- 不做考勤/绩效自动计薪；
- 不做薪酬审批流与银行代发文件。

## 验收与验证

1. 月份 / 部门 / 岗位都带服务端参数重新拉取；切部门清空岗位；
2. 部门与岗位名称在表格里可见；
3. 每个动作的 method + URL + 请求体与 `hr.controller.ts` 逐条对齐（PATCH 编辑、DELETE 删除、其余 POST）；
4. 详情与列表的应发/已付/未付同口径（单测断言）；
5. 保留两条 KNOWN_DEFECT 断言（重名员工只发姓名；行内动作无 in-flight 守卫）。

## 决策记录

- 关键字筛选保持**本地**过滤：输入时即时响应、不打接口，与旧的既有行为一致（有测试断言不发新请求）；
- 去掉「车间 / 非车间」分区表而不是保留两处渲染：部门/岗位筛选已经能覆盖这个维度，
  同一份数据两处渲染只会让口径漂移（历史上两张表的列定义就靠「共用同一份列定义」勉强维持一致）。

## 完成记录

- `payroll-ledger.service.ts`：`list` 重写（新增 4 个参数 + 部门/岗位 include）、新增 `balances()`、`monthRange()`；`get()` 统一口径；
- `hr.controller.ts`：`listLedgers` 增加查询参数；
- 前端 `app/finance/salary/page.tsx` 重写；
- 单测新增 5 条（月筛选、部门/岗位/员工类型筛选与回显、无筛选不加空 where、非法月份 422、详情同口径）；
- 组件测试 `test/salary-page.test.tsx` 重写为 32 条。
- 验证结果：api typecheck 通过 + 908/908；web 517+121 用例通过。

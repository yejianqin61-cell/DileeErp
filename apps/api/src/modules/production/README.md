# Production Module

生产模块目录：生产主数据（部门/岗位/员工/加工地点/工序/工序计价）、生产单、日报、领料与进度。

员工档案虽然是人事资料，但端点在 `production/employees`（历史归属），口径 = 《在职员工花名册》
导入模板；解析与派生规则收在 `employee-roster.ts`，完整说明见
`docs/design/employee-roster-import-2026-09-16.md`。

# Task 02：F2 月度薪资台账与生产来源

新增 `PayrollLedger`、`PayrollAdjustment`，按员工自然月汇总 D5 `ProductionPayrollSource`，保存不可编辑来源快照，支持草稿台账、基础薪资字段、独立调整和确认状态机。

必须使用 Decimal；计时日报件数不计薪；台账生成幂等，修改前提供影响预览。


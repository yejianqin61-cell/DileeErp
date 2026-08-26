# 人事模块实施任务

这组任务基于 [人事模块审计与改进计划](../hr-module-audit-and-improvement-plan.md)。执行顺序按依赖排列，每个任务完成后单独提交 Conventional Commit。

1. [HR-01 统一新增类目返回链路](./HR-01-shared-category-flow.md)
2. [HR-02 员工目录与筛选](./HR-02-employee-directory.md)
3. [HR-03 员工类型类目](./HR-03-employee-type-category.md)
4. [HR-04 上下班汇总考勤](./HR-04-attendance-work-summary.md)
5. [HR-05 人事流程员工快速创建](./HR-05-employee-quick-create.md)

依赖关系：`HR-01 -> HR-02/HR-03/HR-05`；`HR-04` 可在 HR-01 后独立执行。HR-03 应先于 HR-02 的员工新建表单最终验收，HR-05 依赖 HR-02 和 HR-03 的员工创建表单。

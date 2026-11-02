# 任务 1：定义产量数据契约

## 1. 任务位置

- 属于阶段一 `R-6 真实工具与独立门禁`，目标是让宿主只返回有界、脱敏的员工产量事实。
- 本任务扩展 R-5 受限入口，提供按订单、工序和日期分组的每日数量及员工累计数量。
- 开始条件是 R-5 受限只读入口已完成；候选工具和独立门禁等待本契约。

## 2. 开发者须知

**先读**

- `apps/coding-worker/src/restricted-data-gateway.ts` — 当前固定 operation 与失败关闭规则是什么。
- `apps/api/src/modules/business-query-agent/tools/tool-executor.ts` — 现有订单根、角色重查和 `QueryFact` 怎样组装。
- `apps/api/prisma/schema.prisma` — 员工日报有哪些字段可以安全分组。
- `apps/api/test/unit/agent-tool-production-domain.test.cjs` — 生产查询如何用假只读 client 验证投影。

**已定**

- 宿主按订单和工序过滤软删除日报，并分别按员工/日期及员工累计聚合。
- 返回最多 100 个每日分组和 100 个员工累计分组；超限必须失败关闭，不能静默截断总数。
- 不返回工资、单价、金额、备注、用户令牌、Prisma 对象或数据库连接信息。

**边缘与接缝**

- 接触受限入口契约和宿主聚合适配器测试。
- 接缝是固定 `read_employee_output_summary` 请求；不连接生产库或改活动工具目录。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- restricted-data-gateway`
- `npm run typecheck --workspace=@dilee/coding-worker && npm run typecheck --workspace=@dilee/api`

**未知项**

- 若员工身份不允许在 `operational` 档展示，停止并报告权限决策缺口，不自行改成更高档或隐藏范围。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 为错误累计和泄漏工资字段写红测试。
3. 扩展严格请求解析与宿主聚合结果类型。
4. 加入分组上限、跨订单/工序和未知字段反例。
5. 核对固定投影与来源记录。
6. 运行目标测试和两侧类型检查。
7. 提交测试，再提交实现。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 两名员工的分日数量 | 每日分组和员工累计正确 | 受限入口 |
| 2 | 返回 101 个分组 | `DATA_RESULT_LIMIT_EXCEEDED` | 宿主聚合器 |
| 3 | 返回其他订单或工序 | `DATA_SCOPE_VIOLATION` | 受限入口 |
| 4 | 适配器带工资和备注字段 | 结果不含这些字段 | 固定投影 |
| 5 | 请求附带 SQL/额外字段 | 调用适配器前拒绝 | 请求解析 |


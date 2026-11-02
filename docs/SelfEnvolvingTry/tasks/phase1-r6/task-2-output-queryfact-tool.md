# 任务 2：生成产量 QueryFact 工具

## 1. 任务位置

- 属于阶段一 `R-6 真实工具与独立门禁`，目标是让脱敏订单 A 样例产生可执行的来源事实。
- 本任务实现只依赖 Node 内建模块的候选工具，将受限数据结果变成每日与累计产量 `QueryFact`。
- 开始条件是任务 1 的数据契约已冻结；独立候选门禁等待本任务。

## 2. 开发者须知

**先读**

- `apps/coding-worker/src/restricted-data-gateway.ts` — 候选工具可请求的固定数据面是什么。
- `apps/api/src/modules/business-query-agent/tools/query-fact.ts` — `QueryFact` 的字段和来源格式是什么。
- `apps/api/src/modules/business-query-agent/tools/order-root.ts` — 订单号如何验证与规范化。
- `apps/coding-worker/test/restricted-data-gateway.test.ts` — 结构化数据门禁怎样组织行为测试。

**已定**

- 候选包只用 Node 内建模块，不导入 API 源码、Prisma、SQL、网络或生产凭据。
- 输入必须固定为订单号和工序名；每日数量与员工累计数量均用十进制字符串。
- 来源绑定订单、工序和报工日期/报告 ID；跨订单行必须拒绝。

**边缘与接缝**

- 接触独立 candidate 目录、工具代码和纯 Node 测试。
- 接缝是 `runTool(input, dataReader)`；不注册到 ERP 活动 Tool Registry。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- output-tool`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 若脱敏样例的独立预期数值与分组语义不一致，停止并核对样例口径，不从实现反推期望。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 为固定样例的每日与累计结果写红测试。
3. 加入严格输入解析及受限数据请求。
4. 按员工/日期汇总并产生来源完整的 `QueryFact`。
5. 加入跨订单、非法数量、空结果和敏感字段反例。
6. 运行目标测试和类型检查。
7. 提交测试，再提交实现。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 员工甲 12+8，员工乙 5 | 累计分别为 20 和 5 | `runTool()` |
| 2 | 员工甲 12 和 8 两个日期 | 两个每日分组 | `runTool()` |
| 3 | 输入订单 B，返回订单 A 行 | `DATA_SCOPE_VIOLATION` | `runTool()` |
| 4 | 缺订单号或未知字段 | `DATA_REQUEST_INVALID` | 输入解析 |
| 5 | 空样例数据 | 空结果与空来源 | `runTool()` |


# P2-T4 可观测性与用量记录

## 1. 位置

- 阶段：Phase 2 DeepSeek、上下文与运行控制。
- 本任务落 R-11：结构化记录模型/工具/用量/耗时/拒绝，默认日志不含问题全文与业务结果。
- 前置：P2-T2 的 usage 聚合、P2-T1 的闸门。后续 T-5 的日志断言对准它。

## 2. 开发者须知

**先读**

- `apps/api/src/platform/logging/structured-logger.ts` — 结构化日志的既有形状与用法。
- `apps/api/src/modules/business-query-agent/agent-orchestrator.ts` 与 `business-query-agent.controller.ts` — 埋点位置。
- `docs/design/business-query-agent-v0-module-design-2026-10-25.md`「怎样观察问题，又不泄露业务数据」。

**定案（不得重开）**

- 新 `observability.ts`：`record(runId, event)`，事件字段固定：`run_id`、`user_id`、`access_level`、`model`、`operation`、`result_rows`、`duration_ms`、`usage`、`state`、`error_code`、`denied_count`。
- 接口**不接受** prompt、答案、工具参数原文、查询结果内容——类型上就没有这些字段，脱敏靠形状而非自觉。
- 复用 Nest `Logger`（全局 StructuredLogger 接管输出），context 固定 `business-query-agent`。
- 埋点三处：控制器（run 创建/幂等复用/闸门拒绝）、编排器（模型步骤、每个工具、完成/失败）。先观察三项：活动 run 数、成功/失败/取消比例、单轮模型用量与耗时——不引监控平台。
- V0 先观察三项：同时活动 run 数、成功/失败/取消比例、单轮模型用量与耗时。不引入新的监控平台。

**边界**

- 新文件 `observability.ts`；在 controller 与 orchestrator 插埋点（各 ≤5 行/处）；不动业务逻辑与 SSE。

**运行**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-observability.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**未知**

- Nest Logger 在单测里走内存 console；断言用注入假 logger（构造函数注入 `Logger` 实例或 `log/warn/error` 三方法的鸭子类型），不改全局配置。

## 3. 工作流

1. 读上面 3 处，然后一句话复述本任务。
2. 写 `agent-observability.test.cjs`（红）：字段齐全、缺一不可、多余字段编译期就不存在（TS 类型）。
3. 写 `observability.ts`，构造注入 logger。
4. 控制器与编排器插埋点（创建、模型步骤、工具、完成、失败、闸门拒绝）。
5. 跑本任务命令 + 全量 agent 单测回归；提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | record 一次工具事件 | 日志含 run_id/user_id/operation/result_rows/duration_ms | `record` |
| 2 | record 一次模型事件 | 含 model/usage/duration_ms，不含任何文本字段 | `record` |
| 3 | 完成/失败/取消各记一条 | state 与 error_code 对应；比例可由日志聚合 | `record` |
| 4 | 闸门拒绝 | 记 denied 事件，不含问题内容 | `record` |

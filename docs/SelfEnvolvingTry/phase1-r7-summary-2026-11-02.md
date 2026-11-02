# 阶段一 R-7 批次总结

日期：2026-11-02

对照基线：[阶段一架构、验证与施工计划](phase1-architecture-validation-build-plan-2026-10-31.md) 中的 `R-7 并行批次与可观察失败`。

## 1. 本轮交付

**R-7 已交付 Worker 侧并行批次底座。** Coding Worker 能为多个能力并行运行独立 Harness，按能力与轮次统一记录进度，并且只在整批验证通过时返回候选集合。

| # | 变化 | 位置 | 类型 | 状态 | 对使用者的意义 |
|---|---|---|---|---|---|
| 1 | 统一 SDK 与 Activation 事件 | `batch-progress-events.ts` | 新增 | 完成 | 进度记录可关联批次、能力、attempt 与轮次 |
| 2 | 并行运行隔离能力 | `parallel-build.ts` | 新增 | 完成 | 独立 Harness 与 workspace 可同时执行 |
| 3 | 整批候选独立校验 | `candidate-batch.ts` | 新增 | 完成 | 任一门禁失败都不会返回部分候选 |
| 4 | 取消联动与 attempt 目录 | `runtime-lifecycle.ts`、`attempt-workspace.ts` | 变更 | 完成 | 失败或取消后关闭运行，重试不复用目录 |

例行内容：补充任务简报、定向测试及批次索引。

## 2. 交付意味着什么

双能力批次现在可以并发构建、各自绑定门禁证据，并在失败时拒绝整批候选。事件载荷保留 SDK 与 Cordis 原始内容，外层补充稳定的批次定位字段。

这为后续发布器提供了 Worker 侧批次结果边界；当前实现仍是内存中的调用入口，不代表候选已发布或 Query Agent 已等待续跑。

## 3. 仍未交付

- Artifact Registry 与活动 Tool Registry 尚未接入，因此候选不能热重载上线。
- Query Agent 尚无持久等待与幂等续跑，工具构建完成后不能自动恢复原查询。
- Worker 事件尚未持久化；进程重启后无法从作业记录恢复完整进度。
- Docker Linux engine 在当前环境不可用，因此 R-7 没有新增真实容器并发纵切证据。
- 前端工作态尚未消费统一批次事件，用户看不到并行拓扑。

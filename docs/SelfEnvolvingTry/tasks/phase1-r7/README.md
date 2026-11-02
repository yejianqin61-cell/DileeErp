# 阶段一 R-7 任务批次

> 2026-11-02｜状态：待实施｜输出：Markdown｜实施者：Codex

本批次推进 `R-7 并行批次与可观察失败`。目标是并行构建多个工具能力，统一事件并确保失败批次不能产出可提交候选。

| 顺序 | 任务 | 状态 |
| --- | --- | --- |
| 1 | [归一化批次进度事件](task-1-batch-progress-events.md) | 待实施 |
| 2 | [并行构建隔离能力](task-2-parallel-build-isolation.md) | 待实施 |
| 3 | [汇总并门禁整批候选](task-3-atomic-candidate-batch.md) | 待实施 |
| 4 | [清理失败并隔离新尝试](task-4-failure-cleanup-attempt-isolation.md) | 待实施 |

本批次只处理 Coding Worker 的构建作业、事件、候选汇总与清理；不激活 Artifact Registry，不续跑 Query Agent，也不建设前端工作态。

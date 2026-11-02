# 阶段一 R-4 任务批次

> 2026-11-01｜状态：已完成｜输出：Markdown｜实施者：Codex

本批次推进 `R-4 Cordis 与 Worker 强制规则`。目标是让母 Agent 选择动作，但由规则层拒绝越序委派、旧修订复用、超额返工和缺验证提交，并由 Worker 在截止时间到达后关闭整批 runtime。

| 顺序 | 任务 | 状态 |
| --- | --- | --- |
| 1 | [定义作业动作状态机](task-1-job-policy-state-machine.md) | 已完成 |
| 2 | [接入受控 Cordis 动作](task-2-controlled-cordis-actions.md) | 已完成 |
| 3 | [强制 Worker 截止时间](task-3-worker-deadline.md) | 已完成 |
| 4 | [验证规则层对抗纵切](task-4-policy-adversarial-integration.md) | 已完成 |

本批次不接真实 ERP 数据、Artifact Registry、生产 Tool Registry、热重载、多工具并行或前端拓扑。


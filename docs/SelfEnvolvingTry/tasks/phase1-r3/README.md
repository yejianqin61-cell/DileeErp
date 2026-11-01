# 阶段一 R-3 任务批次

> 2026-11-01｜状态：简报已冻结｜输出：Markdown｜实施者：Codex

本批次推进 `R-3 失败返工可追溯`。目标是让 Validator 拒绝 `h1` 后，母 Agent 续接原 Builder 生成 `h2`，并只接受绑定 `h2` 的新验证证据。

| 顺序 | 任务 | 状态 |
| --- | --- | --- |
| 1 | [锁定修订证据门禁](task-1-revision-evidence-gate.md) | 已完成 |
| 2 | [记录 Activation 轮次](task-2-activation-trace.md) | 已完成 |
| 3 | [用 session/wait 收口批次](task-3-session-tree-wait.md) | 已完成 |
| 4 | [验证原 Builder 返工闭环](task-4-builder-rework-integration.md) | 待实施 |

本批次不接真实业务数据、Artifact Registry、生产 Tool Registry、热重载或前端拓扑。


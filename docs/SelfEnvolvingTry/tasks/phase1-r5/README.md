# 阶段一 R-5 任务批次

> 2026-11-01｜状态：待实施｜输出：Markdown｜实施者：Codex

本批次推进 `R-5 源码与数据只读隔离`。目标是从固定 Git 基线生成净化源码视图，
让 Coding Worker 只写候选目录，并让生成工具只能通过宿主的结构化只读入口取数。

| 顺序 | 任务 | 状态 |
| --- | --- | --- |
| 1 | [生成净化源码视图](task-1-sanitized-source-view.md) | 待实施 |
| 2 | [定义 Linux 容器隔离策略](task-2-linux-container-policy.md) | 待实施 |
| 3 | [建立受限只读数据入口](task-3-restricted-data-gateway.md) | 待实施 |
| 4 | [验证 Linux 隔离纵切](task-4-linux-isolation-integration.md) | 待实施 |

本批次不生成订单 A 的真实工具，不接 ERP 独立发布门禁、Artifact Registry、生产 Tool Registry、
热重载、多工具并行或前端拓扑。


# SelfEnvolvingTry

本目录集中保存 Dilee ERP 自迭代工具阶段的设计与研究文档。

本阶段的核心链路是：Query Agent 发现业务能力缺口，Coding Orchestrator（DeepSeekHarness 根 Agent）拆分工具能力，Builder 编写工具，Validator 对抗性审查并反馈，母 Agent 决定返工，Cordis 插件与 Worker 保证执行规则，ERP 独立发布门禁最终裁决。

| 文档 | 用途 |
| --- | --- |
| [自生成工具架构](business-query-agent-generated-tools-architecture-2026-10-29.md) | 业务流程、运行拓扑、工具包和发布边界 |
| [自生成工具实施计划](business-query-agent-generated-tools-plan-2026-10-29.md) | 分阶段实施任务和验收证据 |
| [DeepSeekHarness SDK 接入方案](business-query-agent-deepseek-harness-sdk-phase1-2026-10-29.md) | Node 24 worker、SDK、Cordis、母 Agent、Builder/Validator 和安全隔离 |
| [SDK 与子 Agent 源码核查](deepseek-harness-sdk-2026-10-29.md) | SDK、profile、子 Agent、取消和沙箱的源码证据 |
| [根 Agent、父会话与 Activation 核查](deepseek-harness-root-parent-activation-2026-10-30.md) | Coding Orchestrator 母 Agent、Parent Session、返工和 Activation 语义 |
| [阶段一架构、验证与施工计划](phase1-architecture-validation-build-plan-2026-10-31.md) | 流程图、调用链、风险、待验证点与 12 工作日证据关口 |
| [阶段一 R-1/R-2 批次总结](phase1-r1-r2-summary-2026-11-01.md) | 独立 Worker、母 Agent 双子会话、工具隔离证据与未完成项 |
| [阶段一 R-3 批次总结](phase1-r3-summary-2026-11-01.md) | 原 Builder 返工、Activation 轮次、哈希门禁与全树收口证据 |
| [阶段一 R-4 批次总结](phase1-r4-summary-2026-11-01.md) | Cordis 动作规则、返工预算、Worker 截止时间与对抗证据 |
| [阶段一 R-5 批次总结](phase1-r5-summary-2026-11-01.md) | 净化源码、Linux 隔离、受限数据入口与容器对抗证据 |
| [阶段一 R-6 批次总结](phase1-r6-summary-2026-11-02.md) | 订单 A 产量 QueryFact、独立候选门禁与真实 Linux 纵切 |
| [阶段一 R-7 批次总结](phase1-r7-summary-2026-11-02.md) | 并行构建、统一进度、整批拒绝和 attempt 隔离 |

执行中的任务批次见 [阶段一 R-1/R-2 任务](tasks/phase1-r1-r2/README.md)。
`R-3 失败返工可追溯` 的施工批次见 [阶段一 R-3 任务](tasks/phase1-r3/README.md)。
`R-4 Cordis 与 Worker 强制规则` 的施工批次见 [阶段一 R-4 任务](tasks/phase1-r4/README.md)。
`R-5 源码与数据只读隔离` 的施工批次见 [阶段一 R-5 任务](tasks/phase1-r5/README.md)。
`R-6 真实工具与独立门禁` 的施工批次见 [阶段一 R-6 任务](tasks/phase1-r6/README.md)。
`R-7 并行批次与可观察失败` 的施工批次见 [阶段一 R-7 任务](tasks/phase1-r7/README.md)。

上游 DeepSeekHarness 源码固定在提交 `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`，本地克隆位于 `tmp/deepseek-harness`。本目录文档记录设计和验证计划；运行实验结果应追加到对应日期的 `docs/log/`。

# 阶段一 R-3 批次总结

> 窗口：2026-11-01  
> 基线：[阶段一 R-1/R-2 批次总结](phase1-r1-r2-summary-2026-11-01.md) 与
> [阶段一施工计划](phase1-architecture-validation-build-plan-2026-10-31.md)  
> 词汇：种类使用“新增、变更、修复、移除”；状态使用“完成、进行中、未开始”。

## 1. 结论

**R-3 的 4 项变化全部完成。`h1` 拒绝、原 Builder 续接、`h2` 重验和旧证据拒绝已有真实 Harness 证据。**

| # | 变化 | 位置 | 种类 | 状态 | 对读者的意义 |
| --- | --- | --- | --- | --- | --- |
| C-1 | 验证绑定当前修订 | `revision-evidence.ts` | 新增 | 完成 | 旧哈希通过记录不能放行新代码 |
| C-2 | Activation 写入 JSONL | `activation-trace.ts` | 新增 | 完成 | 同一 Session 的返工轮次可区分 |
| C-3 | 批次等待完整子树 | `runtime-lifecycle.ts` | 变更 | 完成 | Root 首次 idle 不再代表批次完成 |
| C-4 | 原 Builder 冷恢复返工 | `rework-loop.integration.test.ts` | 新增 | 完成 | `h1` 被拒后可在原上下文生成 `h2` |
| C-5 | started 通知认知修正 | SDK 发布包运行证据 | 修复 | 完成 | 冷恢复会重复通知同一 Session |

例行项：四份任务简报、失败路径、畸形 trace、类型检查和配置装载同步完成。

## 2. 变化的含义

母 Agent 已真实执行 `build h1 → validate reject → send_message → build h2 → validate approve`。
Builder 两轮使用同一子 Session，但内部 trace 记录两个不同 `runId`，四轮 Activation 均有配对 start/end。

Worker 现在按 `run → session/wait → close` 收口，并只接受与当前能力和代码哈希一致的 Validator 通过记录。
重放 `h1` 通过证据到当前 `h2` 会得到 `revision-mismatch`；绑定 `h2` 的证据才接受。

发布包在 Builder 冷恢复时再次发送同一 Session ID 的 `subagent.started`，与原源码核查预期不同。
因此 SDK 通知用于拓扑展示，Activation `runId` 才用于返工轮次审计。
最终验收为 23/23 测试、类型检查和 Harness 配置装载全部通过，且没有外部模型或业务数据调用。

## 3. 仍未完成

- 当前纵切使用字面量 `h1/h2`，所以真实候选目录的确定性代码哈希仍没有生成和落盘。
- `R-4 Cordis 与 Worker 强制规则` 尚未限制动作次序、返工次数和资源预算，因此本轮证明的是可追溯纵切，不是完整策略门禁。
- Activation JSONL 仍是单 attempt 证据文件，不是 Artifact Registry，因此没有版本查询、保留策略或原子发布能力。
- 多工具并行尚未运行，因此同批多个 Builder 的目录隔离、通知交错和整批拒绝仍无证据。
- 真实业务数据、候选工具、ERP 独立发布门禁和生产热重载不在本批次范围，因此没有可发布工具包。


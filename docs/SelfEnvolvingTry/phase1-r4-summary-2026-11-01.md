# 阶段一 R-4 批次总结

> 窗口：2026-11-01  
> 基线：[阶段一 R-3 批次总结](phase1-r3-summary-2026-11-01.md) 与
> [阶段一施工计划](phase1-architecture-validation-build-plan-2026-10-31.md)  
> 词汇：种类使用“新增、变更、修复、移除”；状态使用“完成、进行中、未开始”。

## 1. 结论

**R-4 的 4 项任务全部完成。母 Agent 决定动作，Cordis 与 Worker 已能机械拒绝非法次序并收口超时 runtime。**

| # | 变化 | 位置 | 种类 | 状态 | 对读者的意义 |
| --- | --- | --- | --- | --- | --- |
| C-1 | 作业动作状态机 | `job-policy.ts` | 新增 | 完成 | 次序和返工预算不再依赖提示词 |
| C-2 | Root 受控动作 | `controlled-coding-tools.mjs` | 变更 | 完成 | 原始委派入口不能绕开策略 |
| C-3 | 最新修订提交规则 | Cordis 策略插件 | 新增 | 完成 | 旧哈希和缺验证候选无法申请门禁 |
| C-4 | 整批截止时间 | `runtime-lifecycle.ts` | 新增 | 完成 | 超时批次关闭后才向调用方结束 |
| C-5 | 对抗与真实退出证明 | `policy-adversarial.integration.test.ts` | 新增 | 完成 | 非法动作被拒，超时 Harness PID 消失 |

例行项：四份任务简报、精确版工具依赖、既有脚本夹具、类型检查和配置装载同步完成。

## 2. 变化的含义

Root 现在按 `declare → build → validate → record → revise/submit` 使用六个受控动作。
Cordis 将每轮 Activation 绑定到能力和角色；Validator 拒绝后只允许原 Builder 冷恢复，并限制为一次返工。

Worker 使用一个截止时间覆盖 `run()` 与 `session/wait`。
超时会关闭整批 runtime；关闭也失败时，调用方同时收到原超时和清理错误，不会丢失根因。

真实 SDK 纵切证明了四类拒绝：未声明就验证、未批准就提交、返工后重验旧哈希、超过返工预算。
合法链路只生成绑定当前通过哈希的候选申请；它仍须经过 ERP 独立发布门禁。
最终验收为 35/35 测试、类型检查和 Harness 配置装载全部通过，且没有外部模型或业务数据调用。

## 3. 仍未完成

- `record_validation` 记录的是 Root 提交的结构化结论；ERP 尚未独立读取并重验 Validator 报告。
- 当前纵切仍使用字面量 `h1/h2`，因此真实候选目录的确定性代码哈希尚未生成。
- 本轮证明 Harness 主进程在超时后退出；生产 Linux 容器的完整后代进程树清理仍没有环境证据。
- `R-5 源码与数据只读隔离` 尚未开始，因此 Builder 仍未接触净化源码和受限业务数据入口。
- 多工具并行、整批拒绝、Artifact Registry、生产热重载和 Query Agent 续跑仍不在当前实现中。


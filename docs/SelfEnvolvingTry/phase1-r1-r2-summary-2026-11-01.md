# 阶段一 R-1/R-2 批次总结

> 窗口：2026-11-01  
> 基线：[阶段一架构、验证与施工计划](phase1-architecture-validation-build-plan-2026-10-31.md)  
> 词汇：种类使用“新增、变更、修复、移除”；状态使用“完成、进行中、未开始”。

## 1. 结论

**本批次 5 项关键变化全部完成。R-1 独立运行和 R-2 双子会话已有真实 Harness 证据。**

| # | 变化 | 位置 | 种类 | 状态 | 对读者的意义 |
| --- | --- | --- | --- | --- | --- |
| C-1 | 固定 Worker 运行契约 | `apps/coding-worker` | 新增 | 完成 | Node 与 SDK/CLI 版本不会漂移 |
| C-2 | Worker 持有 SDK 生命周期 | `runtime-lifecycle.ts` | 新增 | 完成 | 每批独立启动、失败也关闭 |
| C-3 | Root 统筹两个角色 | `coding-agents.cordis.patch.yml` | 新增 | 完成 | 母 Agent 只委派 Builder 和 Validator |
| C-4 | Root preset 假设被替换 | SDK Host plane | 修复 | 完成 | 不依赖 SDK 不支持的默认 preset |
| C-5 | 子 Agent 委派面被隔离 | `restrict-delegation-tools.mjs` | 新增 | 完成 | 子会话看不到且不能执行委派工具 |

例行项：四份任务简报、测试 runner、类型检查配置和当日日志同步完成。

## 2. 变化的含义

Coding Worker 已能用固定版本启动真实 SDK runtime，并在固定父 Session 下完成 Builder、Validator 和母 Agent 收口。
集成测试记录了 2 次启动、2 次完成和 2 个不同子 Session；脚本模型没有调用外部模型或业务数据。

本轮也否证了一个关键假设：`sdk` profile 的 Root Agent 不会自动采用 registry 默认 preset。
当前实现把 Coding Orchestrator 放在 DSH 支持的 Host plane，并用公开的 `agent/created` 与 `tools.restrict()` 锁定子工具面。
Builder 伪造 `build_tool` 调用时得到 `UNKNOWN_TOOL`，因此隔离同时覆盖模型 schema 和执行入口。

最终验收为 13/13 测试通过、TypeScript 类型检查通过、Harness 配置装载通过。
任务实现提交为 `a0a7bbe`；本批次从 `8af9995` 起保留了测试先行与任务独立提交记录。

## 3. 仍未完成

- `R-3 失败返工可追溯` 尚未验证 Builder 结算后的原子会话冷恢复，因此 Validator 拒绝后的上下文接续仍无运行证据。
- `R-3 失败返工可追溯` 尚未绑定修订哈希与 Validator 结果，因此旧证据仍不能作为候选包放行依据。
- 完整子树尚未用 `session/wait` 和落盘证据收口，因此当前 `run()` 的 idle 结果只证明本次受控样例结束。
- Activation `runId` 尚未桥接到 Worker 作业记录，因此同一子 Session 的多轮返工还不能逐轮展示和审计。
- 多工具并行、真实工具候选目录和 ERP 独立发布门禁不在本批次范围，因此尚未形成可发布工具包。


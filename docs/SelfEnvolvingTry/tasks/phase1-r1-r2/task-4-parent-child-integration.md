# 任务 4：验证父会话双子 Agent

## 1. 任务位置

- **阶段一 R-1/R-2 批次**，目标是同版 Harness 可独立运行，且母 Agent 可委派双子会话。
- **本任务完成 R-2 母 Agent 统筹双子会话**：真实 Agent loop 依次启动 Builder、Validator 并回报父会话。
- **开始条件**：任务 3 的 patch 可加载。**后续依赖**：R-3 返工轮次和哈希门禁。

## 2. 开发者须知

**先读**

- `tmp/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts` — 无密钥脚本模型的最小流格式。
- `tmp/deepseek-harness/packages/subagent/subagent/tests/parent-result.spec.ts` — parent delivery 的已验证上游行为。
- `tmp/deepseek-harness/packages/sdk/client/src/api.ts` — SDK 收集后代通知的范围。
- `docs/SelfEnvolvingTry/deepseek-harness-root-parent-activation-2026-10-30.md` — 父会话完成判定和待验证点。

**已定**

- 验证使用本地脚本模型，不调用外部模型，也不接触业务数据。
- Builder 与 Validator 结果通过 `delivery: 'parent'` 进入同一个固定父 Session。
- SDK `run()` 的 idle 结果只作观察；本任务还核对子 Agent started/finished 通知。

**边缘与接缝**

- 接触测试用脚本 LLM 插件和 Worker 集成测试；不实现生产模型配置。
- 测试接缝：真实 SDK Worker 入口及其通知流；不新增 Harness 内核接缝。

**运行**

- `npm run test:integration --workspace=@dilee/coding-worker`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 后代通知的实际顺序可能与完成顺序不同。若无法用 Session ID 识别两类子会话，记录原始通知后停止扩大实现。

## 3. 工作流

1. 读完本节列出的入口，用一句话复述任务。
2. 先写集成用例，要求两个子会话都有开始和完成通知。
3. 增加测试专用脚本 LLM 插件，顺序输出 Builder、Validator 委派与收尾文本。
4. 通过真实 SDK 和 Cordis patch 运行固定父 Session。
5. 核对父 Session、两个子 Session、角色工具调用和完成通知。
6. 运行集成测试和类型检查。
7. 提交本任务。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 一项规范化能力 | Builder 与 Validator 各启动一次 | SDK Worker 入口 |
| 2 | Builder 完成 | 父 Session 收到 Builder 结果并继续 | SDK 通知流 |
| 3 | Validator 完成 | 父 Session 收到 Validator 结果并结束 | SDK 通知流 |
| 4 | 固定父 Session ID | 所有后代通知关联同一父 Session | SDK 通知流 |
| 5 | Builder 伪造 `build_tool` 调用 | 子 Agent schema 不暴露委派工具，执行返回 `UNKNOWN_TOOL`，不产生第三个子 Agent | Agent scoped tool restriction |

## 5. 完成证据

- 固定父 Session：`coding-parent-r2-integration`，SDK 返回的 Session ID 与请求一致。
- 通知流：2 个 `subagent.started`、2 个 `subagent.finished`；两个子 Session ID 不同，且都关联固定父 Session。
- 子会话结果：Builder 为 `BUILDER_COMPLETE`，Validator 为 `VALIDATOR_APPROVED`；母 Agent 为 `ORCHESTRATOR_COMPLETE`。
- 工具隔离：Builder 与 Validator 的模型请求均不含 `build_tool`、`validate_tool`、`subagent`、`subagent_fork`。Builder 伪造 `build_tool` 调用后收到 `unknown tool`，没有启动额外子 Agent。
- 实现接缝：Host 在公开的 `agent/created` 生命周期中识别 Builder/Validator preset，并在对应 `agent.ctx` 上调用 DSH 的 `tools.restrict()`；Root Agent 的两个定向入口不受影响。
- 运行方式：真实 SDK、真实 Agent loop、真实 spawn Activation；脚本 LLM 仅替代外部模型，不调用网络或业务数据。
- 验收结果：Worker 完整测试 13/13 通过，类型检查通过，Harness 配置装载与 dump 通过；集成链单次运行约 6 秒。


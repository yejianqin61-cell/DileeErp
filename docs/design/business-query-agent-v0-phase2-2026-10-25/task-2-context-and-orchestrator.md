# P2-T2 八轮上下文、编排器多步循环与用量

## 1. 位置

- 阶段：Phase 2 DeepSeek、上下文与运行控制。
- 本任务落 R-6（八轮上下文、输入不设限、超窗明确报错）与 R-11 的 usage 聚合：context-manager、编排器多步工具循环、run 级超时、provider 用量回流。
- 前置：阶段 1 编排器。后续 T-3 DeepSeek provider 按 T-2 改过的接口实现。

## 2. 开发者须知

**先读**

- `apps/api/src/modules/business-query-agent/agent-orchestrator.ts` — 阶段 1 的单轮 plan 流程，本任务把它改成外层循环。
- `apps/api/src/modules/business-query-agent/llm-provider.ts` 与 `fake-llm-provider.ts` — 接口变更落点。
- `apps/api/src/modules/business-query-agent/state-manager.ts` 的 `listRuns` — 历史轮次的查询底座。
- `docs/design/business-query-agent-v0-module-design-2026-10-25.md`「Context manager」行与「LLM provider 与 orchestrator 如何配合」。

**定案（不得重开）**

- 上下文只取本人该会话最近 **8 个 completed** 轮次，映射为 user/assistant 消息对；降权视角下旧 full 轮次不可进入；不带旧工具原始结果；应用层**不按 token 裁剪**。
- plan 改为外层循环：每轮 plan 返回 0 个调用即进入回答；轮数与工具总数受 `MAX_TOOL_STEPS`（8）约束。
- `AgentLlmToolCall` 增加 `id`；工具结果消息为 `{role:"tool", id, tool, content}`（content 是 QueryFact JSON）——DeepSeek 需要 toolCallId 往返。
- `streamAnswer` 改为产出 chunk：`{type:"text",text}` 或 `{type:"usage",usage}`；编排器聚合 usage 进 `completed` 事件与 `agent_runs.usage`。
- run 级超时 `AGENT_RUN_TIMEOUT_MS`（默认 120000）用 `AbortSignal.any([userSignal, AbortSignal.timeout(ms)])`；超时落 `failed/AGENT_RUN_TIMEOUT`。
- 超窗不是本任务实现（provider 层 T-3），但编排器对 provider 抛的业务异常已有统一 failed 收口，注释点名这个接缝。

**边界**

- 新文件 `context-manager.ts`；改 `llm-provider.ts`、`fake-llm-provider.ts`、`agent-orchestrator.ts`、module 注册、env 读取。
- 不动控制器、SSE、工具链。

**运行**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-context-manager.test.cjs apps/api/test/unit/agent-orchestrator.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**未知**

- `AbortSignal.any` 需要 Node 20+（本机 v24，仓库引擎满足）；若构建目标报类型缺失，在 `node:timers` 类型上确认后再用。

## 3. 工作流

1. 读上面 4 处，然后一句话复述本任务。
2. 写 `agent-context-manager.test.cjs`（红）：8 轮截断、降权过滤、顺序、只含问答。
3. 写 `context-manager.ts`，接进编排器（planning 消息组装处）。
4. 改 llm-provider 接口（toolCall id、chunk 化 streamAnswer、usage 类型）与 fake provider，更新编排器循环与 usage 聚合，同步修正 agent-orchestrator.test.cjs 的桩（红→绿）。
5. 加 run 超时（env 读取 + AbortSignal.any + 超时错误码）与对应单测。
6. 跑本任务命令 + 全量 agent 单测回归；提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | 9 个 completed 轮 | 上下文只含最近 8 个，第 1 轮不在 | `history` |
| 2 | 历史含 full 轮，当前 operational | full 轮不进上下文 | `history` |
| 3 | 历史 3 轮 | 顺序为旧→新的 user/assistant 对，无 tool 内容 | `history` |
| 4 | plan 连续两轮返回调用后返回空 | 编排器执行 2 次工具后进入 responding | `AgentOrchestrator.run` |
| 5 | streamAnswer 产出 2 文本 + 1 usage | completed.usage 聚合 provider 用量 | `AgentOrchestrator.run` |
| 6 | provider 超时（AbortSignal 触发） | run 落 `failed/AGENT_RUN_TIMEOUT`，许可释放 | `AgentOrchestrator.run` |
| 7 | responding 中取消（回归） | 终态保持 cancelled | `AgentOrchestrator.run` |

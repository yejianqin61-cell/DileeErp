# P2-T3 DeepSeek provider 与错误映射

## 1. 位置

- 阶段：Phase 2 DeepSeek、上下文与运行控制的核心。
- 本任务落 R-4：接入真实 DeepSeek（AI SDK）、模型配置服务端化、模型错误映射为稳定错误码。
- 前置：P2-T2 定稿的 provider 接口（toolCall id、chunk 化 streamAnswer、usage）。后续 T-4 的用量记录消费它的 usage。

## 2. 开发者须知

**先读**

- `apps/api/src/modules/business-query-agent/llm-provider.ts` — P2-T2 定稿的接口与消息形状。
- `docs/design/business-query-agent-v0-module-design-2026-10-25.md`「LLM provider 与 orchestrator 如何配合」— 单步 plan、关闭工具流式回答、错误映射。
- `apps/api/src/platform/config/validate-environment.ts` — 生产 env 校验的既有位置。
- AI SDK 文档：ai-sdk.dev「DeepSeek provider」「Tools and tool calling」（实施时对照安装版本的 API，以包内类型为准）。

**定案（不得重开）**

- 只新增两个协议依赖：`ai` 与 `@ai-sdk/deepseek`；不自写模型流解析。
- `plan` 用 `generateText` **单步**（不执行工具）：tools 只作声明（无 execute），返回映射后的 toolCalls（id/tool/operation/args）；不在授权清单里的工具名丢弃并留日志计数。
- `streamAnswer` 用 `streamText`（无工具声明），textStream 逐段产出，结尾 yield usage chunk。
- env：`AGENT_LLM_PROVIDER`（`fake`｜`deepseek`，默认 fake）、`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`（可选）、`DEEPSEEK_MODEL`（默认 `deepseek-chat`）、`AGENT_LLM_TIMEOUT_MS`（默认 60000）。生产环境必须 `deepseek` 且有 key（validate-environment）；开发选 deepseek 缺 key 时模块工厂启动报错。
- 错误映射（原始响应体不回传浏览器）：上下文超限（400 且 context_length_exceeded）→ `AGENT_MODEL_CONTEXT_EXCEEDED`；401/403 → `AGENT_MODEL_AUTH`；429/5xx/网络 → `AGENT_MODEL_UNAVAILABLE`；中止/超时 → `AGENT_MODEL_TIMEOUT`；其余 → `AGENT_MODEL_ERROR`。
- 每次调用受 `AGENT_LLM_TIMEOUT_MS` 约束（`signal` 组合 timeout），编排器的 run 级超时仍在 T-2。
- 密钥只在服务端；Web 不接触。

**边界**

- 新文件：`deepseek-llm-provider.ts`、`model-errors.ts`（映射函数）；改 module 工厂（按 env 选 provider）、`validate-environment.ts`、`package.json`（两个依赖）。
- 不动编排器与工具链。

**运行**

- `npm install ai @ai-sdk/deepseek --workspace=@dilee/api`（安装即本任务第一步）
- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-deepseek-provider.test.cjs apps/api/test/unit/agent-model-errors.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**未知**

- AI SDK 版本 API 名（`stopWhen`/`stepCountIs`、`result.usage` 是否 Promise）以安装后的 `.d.ts` 为准；mock 用 `ai` 包自带的 mock language model。若 DeepSeek 兼容层与 mock 不匹配，停下来说明。

## 3. 工作流

1. 读上面 4 处与安装的 SDK 类型定义，然后一句话复述本任务。
2. 安装两个依赖；`npm run build` 确认无回归。
3. 写 `model-errors.ts` + `agent-model-errors.test.cjs`（红→绿）：五类错误映射。
4. 写 `deepseek-llm-provider.ts`：plan（单步、toolCalls 映射、超限丢弃）、streamAnswer（分片 + usage）、timeout 组合；用 mock model 写 `agent-deepseek-provider.test.cjs`（红→绿）。
5. module 工厂按 env 选 provider + validate-environment 生产校验；补环境契约单测。
6. 跑本任务命令 + 全量 agent 单测回归；提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | mock 模型返回一次 `order_query` 工具调用 | plan 映射出 `{id,tool,operation,args}`，args 是解析后的对象 | `DeepSeekLlmProvider.plan` |
| 2 | mock 模型请求未授权工具名 | 该调用被丢弃，plan 返回剩余调用 | `plan` |
| 3 | mock 流式返回 3 段文本 + usage | streamAnswer 产出 3 个 text chunk + 1 个 usage chunk | `streamAnswer` |
| 4 | mock 抛 context_length_exceeded | 映射 `AGENT_MODEL_CONTEXT_EXCEEDED`，原文不外传 | `model-errors` |
| 5 | mock 抛 401 / 429 | 分别映射 `AGENT_MODEL_AUTH` / `AGENT_MODEL_UNAVAILABLE` | `model-errors` |
| 6 | signal 超时中止 | 映射 `AGENT_MODEL_TIMEOUT` | `plan` |
| 7 | `AGENT_LLM_PROVIDER=deepseek` 且缺 key | 模块工厂抛启动错误（文案含 DEEPSEEK_API_KEY） | module 工厂 |

# T-4 编排器、SSE 与控制器

## 1. 位置

- 阶段：Phase 1 一条安全的订单问答链路，这是链路本身。
- 本任务落 R-4 的假 provider 编排与 R-9 的 JSON/SSE 协议：编排器、流传输、6 条路由、模块注册。
- 前置：T-2 状态管理器、T-3 工具执行器。后续 T-5 前端页面、T-6 证据测试对准这些路由。

## 2. 开发者须知

**先读**

- `apps/api/src/platform/http/response-envelope.interceptor.ts` 与 `api-exception.filter.ts` — SSE 必须绕开信封，改动落在这里并带单测。
- `apps/api/src/modules/order-workbench/order-workbench.controller.ts` — 控制器、守卫组合与 DTO 风格。
- `apps/api/src/main.ts` — 全局管线（信封、异常过滤、ValidationPipe）。
- `docs/design/business-query-agent-v0-module-design-2026-10-25.md`「LLM provider 与 orchestrator 如何配合」「SSE 与前后端状态机」— 编排顺序、事件格式、幂等与取消规则。
- `docs/design/business-query-agent-v0-architecture-2026-10-23.md`「JSON 与 SSE 协议」— 6 条路由与 8 种事件类型。

**定案（不得重开）**

- LLM provider 接口固定 `plan(messages, tools, signal)` 与 `streamAnswer(messages, signal)`；Phase 1 只有假 provider，真实 DeepSeek 是 Phase 2。
- 假 provider 的回答模板引用本轮事实（单号、数量），不编造其他数字。
- 事件 JSON 固定 `{v:1, run_id, seq, type, at, data}`；type 用 8 个固定值；`answer_delta` 是增量片段。
- 路由：POST/GET `/business-query/sessions`、GET `/business-query/sessions/:id`、POST `/business-query/sessions/:id/runs`、GET `/business-query/runs/:id/events`、POST `/business-query/runs/:id/cancel`；创建 run 成功返回 202。
- 幂等：同键同问题返回原 run；同键不同问题 409 `IDEMPOTENCY_CONFLICT`；本人已有活动 run 409 `RUN_IN_PROGRESS`。
- SSE：先重放后轮询，`id: <runId>:<seq>`，心跳是注释；发送前校验归属与档位。
- SSE 绕开信封的方式：`ResponseEnvelopeInterceptor` 对 `res.headersSent` 的响应原样放行；`ApiExceptionFilter` 对已提交响应直接终止。

**边界**

- 新文件：`fake-llm-provider.ts`、`agent-orchestrator.ts`、`stream-transport.ts`、`business-query-agent.controller.ts`、`business-query-agent.dto.ts`、`business-query-agent.module.ts`；改 `app.module.ts` 与上述两个平台文件。
- 不做并发许可闸（Phase 2 R-8），不做八轮上下文（Phase 2 R-6）：编排器只发本次问题，留接缝。

**运行**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-orchestrator.test.cjs apps/api/test/unit/response-envelope-sse.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**未知**

- SSE 轮询间隔取 200ms；若测试里出现事件丢失，先查重放与轮询的衔接（`eventsAfter(lastSeq)`），不是调大间隔。

## 3. 工作流

1. 读上面 5 处，然后一句话复述本任务。
2. 写 `fake-llm-provider.ts`：plan 返回一次 `order_query.search_orders` 调用；streamAnswer 分段产出。
3. 改信封拦截器与异常过滤器的 headersSent 放行，先写单测（红）。
4. 写 `agent-orchestrator.ts`：`run(runId, signal)` 按 planning→querying→responding→completed 推进；异常落 `failed`。
5. 写 `stream-transport.ts` 与控制器 6 条路由、DTO；`app.module.ts` 注册。
6. 编排器单测：状态推进、answer 拼接、取消后不写终态（红→绿）。
7. 跑本任务两条命令，提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | 假 provider + 一张订单事实 | run 推进 planning→querying→responding→completed，事件类型齐全且 seq 单调 | `AgentOrchestrator.run` |
| 2 | 编排正常完成 | `completed` 事件的 answer 等于各 `answer_delta` 拼接，sources 来自本轮事实 | `AgentOrchestrator.run` |
| 3 | 工具执行抛错 | run 落 `failed` 且带错误码，许可释放由调用方 finally 保证 | `AgentOrchestrator.run` |
| 4 | responding 中取消 | 状态 `cancelled`，迟到增量不再追加 | `transitionAndAppend` |
| 5 | 同键不同问题重复 POST | 409 `IDEMPOTENCY_CONFLICT` 信封 | 控制器 |
| 6 | 本人已有活动 run 再 POST | 409 `RUN_IN_PROGRESS` 信封 | 控制器 |
| 7 | 信封拦截器遇到已提交的 SSE 响应 | 原样放行，不再 res.json | 拦截器单测 |

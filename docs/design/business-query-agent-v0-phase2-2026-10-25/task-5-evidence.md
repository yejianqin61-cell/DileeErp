# P2-T5 证据收口：并发、超窗、幂等与脱敏

## 1. 位置

- 阶段：Phase 2 的验收证据。
- 本任务落阶段 2 的可运行检查：五用户并发最多 4 个运行、429 信封、同键重试、超窗失败可预测、日志脱敏。
- 前置：P2-T1 至 P2-T4 全部完成。不产出产品代码，只产出测试与证据。

## 2. 开发者须知

**先读**

- `apps/api/test/http/business-query-contract.test.cjs` — 阶段 1 契约测试的环境门禁与登录纪律（本文件延续）。
- `apps/api/test/integration/business-query-agent.test.cjs` — 集成测试的库准备与清理惯例。
- `apps/api/src/modules/business-query-agent/fake-llm-provider.ts` — T-5 需要的延迟钩子。
- `docs/design/business-query-agent-v0-development-plan-2026-10-25.md` 阶段 2「证据」。

**定案（不得重开）**

- FakeLlmProvider 支持可配置延迟：env `AGENT_FAKE_DELAY_MS`（默认 0），仅用于占住并发窗口，生产无意义（生产用 deepseek）。改动在 P2-T5 内完成并带单测。
- 五用户并发：恰好 4 个 202、1 个 429 `AGENT_BUSY` + `Retry-After` 头；跑完许可归零（后续请求不再 429）。
- 同键重试：重复 POST 返回原 run（阶段 1 已有，回归确认）。
- 超窗：编排器层单测——provider 抛 `AGENT_MODEL_CONTEXT_EXCEEDED` → run failed 且错误码不丢。
- 日志脱敏：T-4 的类型与单测为准；本任务在集成输出上抽查一条 run 的日志行不含问题原文。
- 本机无库惯例不变：能跑的当场跑，门禁挡住的如实记录。

**边界**

- 改 `fake-llm-provider.ts`（延迟钩子）；新 `apps/api/test/http/business-query-concurrency.test.cjs`、`apps/api/test/unit/agent-context-exceeded.test.cjs`。
- 不改产品行为（延迟钩子默认 0，不影响生产路径）。

**运行**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-context-exceeded.test.cjs`
- `npm run test:api`（需 `API_BASE_URL` + `INITIAL_ADMIN_*` + `AGENT_FAKE_DELAY_MS=2000`，账号准备见日志）
- 一次性测试库容器的复跑命令见 `docs/log/2026-10-25.md`。

**未知**

- 并发窗口需要 5 个账号（admin + 4 个 `qita` 用户）；造号走 admin API（阶段 1 已验证）。若登录互踢导致并发请求串号，按契约测试的换会话重试纪律处理。

## 3. 工作流

1. 读上面 4 处，然后一句话复述本任务。
2. 给 FakeLlmProvider 加延迟钩子（env 注入 + 单测，红→绿）。
3. 写 `agent-context-exceeded.test.cjs`：provider 抛超窗业务异常 → failed 收口不丢码（红→绿）。
4. 写 `business-query-concurrency.test.cjs`：五用户并发断言、Retry-After、许可释放后再请求成功。
5. 起临时环境（测试库容器 + API + 5 账号 + 延迟）跑齐证据，记录输出。
6. 清理环境，汇总证据清单，提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | 5 个用户同时 POST runs | 恰 4 个 202、1 个 429 `AGENT_BUSY`，429 带 `Retry-After: 3` | 控制器 |
| 2 | 4 个 run 完成后再 POST | 不再 429（许可释放无泄漏） | 控制器 |
| 3 | 同 client_message_id 重复 POST | 返回原 run_id（回归） | 控制器 |
| 4 | provider 抛 `AGENT_MODEL_CONTEXT_EXCEEDED` | run `failed`，errorCode 原样，事件含 error 终态 | `AgentOrchestrator.run` |
| 5 | `AGENT_FAKE_DELAY_MS=2000` 的 fake provider | 每阶段延迟生效，run 仍能正常完成 | FakeLlmProvider |

<task-brief>

## 1. Where this task sits

- **Phase P0 尺子**，目标是让「查询工具失败率高」变成可读的数字。
- **本任务交付 R-2 评测运行器**：把一条用例真的问出去，收回结构化的 `CaseOutcome`。
- **Starts after**：任务 1（用例形状）。**Waits on it**：任务 7（基线报告）。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/business-query-agent.controller.ts` — 四个要调的端点与状态码。
- `apps/api/src/modules/business-query-agent/business-query-agent.dto.ts` — `client_message_id` 必须是 UUID。
- `apps/api/src/modules/business-query-agent/stream-transport.ts` — `data:` 帧形状、`id:` 行、心跳注释。
- `apps/web/lib/business-query-stream.ts` — 前端已经写好的 SSE 读取器；照它的帧切分逻辑写，别另发明一套。

**Settled**

- `CaseOutcome` 的字段集合固定：`id/group/turns/terminal/errorCode/ops/failureCodes/sources/answer/toolCalls/answerChunks/durationMs`。
- 运行器不做判定；它只**采集**。判定在任务 3。
- 多轮用例复用同一个 session，每轮一个新 run。
- `fetch` 可注入，单测不联网。

**Edges and seam**

- 只新增 `scripts/agent/golden-runner.mjs`。
- Seam：`runCase({ fetchImpl, apiBase, cookie, caseDef, signal })`，以及 `login({ fetchImpl, apiBase, username, password })`。

**Run**

- `node --test scripts/agent/golden-runner.test.mjs`（全程用假 fetch，不调模型）

**Unknowns**

- SSE 帧可能被拆在多个 chunk 中间，也可能一帧里只有注释心跳。若在假 fetch 上无法稳定复现这两种情况，停下来报告，不要靠真网络碰运气。
- `model_steps` 不在 SSE 里，本任务**不采集**它；若发现别的出路（例如从 `tool_status` 分组推断），写进报告的「未采集」一节，别悄悄补一个假数字。

## 3. The workflow

1. 读四个文件，一句话复述本任务。
2. 写 `login()`：POST `/auth/login`，从 `set-cookie` 取 `dilee_session=…`。
3. 写 `followRun()`：GET `/runs/:id/events`，按 `\n\n` 切帧，解析 `data:`，遇到 `completed/error/cancelled` 返回。
4. 先写失败测试：假 fetch 喂三段 chunk（含半帧、含 `: ping` 注释）→ 断言事件齐全。
5. 写 `runCase()`：create session（多轮只建一次）→ POST run → follow → 归一化 `CaseOutcome`。
6. 补测试：`tool_status failed` 的 `code` 进 `failureCodes`；`source` 事件的 `sources[]` 进 `sources`。
7. 写 `main()`：读 env（`GOLDEN_API_BASE` / `GOLDEN_USERNAME` / `GOLDEN_PASSWORD`），跑用例，JSON 打到 stdout。
8. 跑测试，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 假 fetch 把一帧拆成三个 chunk | 事件不丢、不重 | `followRun()` |
| 2 | 帧间夹一条 `: ping` | 心跳不进事件列表 | `followRun()` |
| 3 | `tool_status` payload `status=failed, code=ORDER_NOT_FOUND` | `failureCodes` 含 `ORDER_NOT_FOUND` | `runCase()` |
| 4 | 两条 `source` 事件各 1 条来源 | `sources` 长度 2 | `runCase()` |
| 5 | 多轮用例两轮 | 只 POST 一次 `/sessions`，POST 两次 `/runs` | `runCase()` |
| 6 | 响应头 `set-cookie: dilee_session=abc; Path=/` | 返回 `dilee_session=abc` | `login()` |

</task-brief>
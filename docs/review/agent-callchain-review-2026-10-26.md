# 业务查询 Agent 调用链审查（2026-10-26）

- 任务：shared task `task-4`「Review Agent call chain and find invocation-process defects」。
- 范围：编排器 → 工具执行 → 状态/事件 → SSE → Web 客户端的完整调用链；SDK 线格式由另一条道（`task-2`）负责，本报告只在交叉处引用，不重复判责。
- 基线：`HEAD = 1101215`（工作区另有未提交的 `deepseek-llm-provider.ts` 描述改动）；线上部署记录为 `738cd66`。
- 产出方式：只读源码/测试，另在 `%TEMP%` 写探针脚本跑编译产物（未改任何源码、未部署）。本文件是本次任务唯一写入的仓库文件。
- 结论一句话：**"工具失败 → 整轮 failed" 这条设计把一次可自愈的参数错误升级成了整轮报废；"先 search_orders 再根查询" 只写在（未提交、未部署的）工具描述里，运行时毫无强制；即使补上提示词，多步回传的 SDK 线格式和预算计数也会让第二轮规划失真/消失。**

---

## 1. 证据与复核方法

| 检查 | 命令/方法 | 结果 |
|---|---|---|
| Agent 单元测试（工作区版本） | `node --test apps/api/test/unit/agent-*.test.cjs`（dist 由工作区源码构建，2026-10-26 21:51） | **112 pass / 0 fail** |
| 编排器/执行器/provider 关键用例 | `node --test apps/api/test/unit/agent-orchestrator.test.cjs apps/api/test/unit/agent-tool-executor.test.cjs apps/api/test/unit/agent-deepseek-provider.test.cjs apps/api/test/unit/agent-context-manager.test.cjs` | **27 pass / 0 fail** |
| Web 状态机 | `node --test apps/web/lib/business-query-state.test.mjs` | **11 pass / 0 fail** |
| HEAD 上"测试先于源码"的求证 | `git show 1101215:.../deepseek-llm-provider.ts` 的 `order_query` 描述代入测试正则 `/先调用 search_orders/` | **false**（即 HEAD 干净检出上 `npm run test:unit:api` 必红；工作区未提交改动让它变绿，见 P1-6） |
| 生产调用链复现（探针） | `%TEMP%\dilee-chain-probe.cjs`：dist 的 `AgentOrchestrator` + 内存假 Prisma，plan 返回 8 个调用、第 1 个执行抛 `ORDER_NOT_FOUND` | 终态 `failed/ORDER_NOT_FOUND`；**plan 只被调用 1 次**；只执行 1 个调用；事件 `tool_status failed → error` |
| 预算/丢弃行为（探针） | 同上：A 首轮 8 调用全成功；B 首轮 1 调用、次轮 10 调用 | A：plan 1 次、执行 8 次、无第二轮规划；B：执行 8 次，`b-7..b-9` **3 个调用静默丢弃**，run 仍 `completed` |
| 多步回放的提示词形状（探针） | `%TEMP%\dilee-provider-probe.cjs`：`DeepSeekLlmProvider.plan()` 传一条 tool 消息，看 MockModel 收到的 prompt | assistant tool-call 的 `input` 是**字符串** `"{\"order_no\":\"SO-123\"}"`，`@ai-sdk/deepseek` 再 `JSON.stringify(part.input)`（`node_modules/@ai-sdk/deepseek/dist/index.js:306`）→ 双重编码；且 args 里**没有 `operation`**（与 `docs/review/agent-sdk-wire-proof-2026-10-26.md` §5 的抓包结论一致） |
| 前端终态事件顺序（探针） | 直接 import `apps/web/lib/business-query-state.ts`，先投 `state{failed}` 再投 `error{ORDER_NOT_FOUND}` | 最终仍是 `{code:"RUN_FAILED", message:"本次查询未完成"}` —— 真实错误码被终态锁吞掉 |
| 未捕获拒绝（探针） | `node -e "void Promise.reject(...).finally(...)"` | **Node 24 以 exit code 1 退出**（unhandled rejection），对应 P1-4 |
| 结构化日志形状（探针） | `StructuredLogger.log('{"run_id":...}')` | 输出 `{"level":"info","message":"{\"run_id\":...}"}` —— JSON 被再套一层字符串，`run_id` 不是顶层字段 |

> 说明：`node --test` 的 API 用例依赖 `apps/api/dist`；本机 dist 是工作区源码（含未提交描述改动）在 21:51 构建的，因此工作区测试全绿不等于 HEAD 全绿，也不等于线上正确。

---

## 2. 缺陷清单（按影响排序）

### P0-1 单次工具失败直接终结整轮 run，模型没有任何自纠机会（线上 ORDER_NOT_FOUND 故障直因）

**证据（调用链）**

1. `apps/api/src/modules/business-query-agent/agent-orchestrator.ts:86-101`：plan 返回 N 个调用后逐个执行；`:93` `const fact = await this.executeTool(...)`、`:94-96` 只在**成功**后才 `facts.push` 并把 `{role:"tool"}` 消息压进 `messages`。
2. `agent-orchestrator.ts:140-162` `executeTool`：`try` 内调 `executor.execute`；`:155-161` 的 `catch` 只发 `tool_status failed` 事件、记一条观测，然后 **`:160 throw error;`** 原样上抛。
3. `agent-orchestrator.ts:55-59` `run()` 的 `try/catch` 把任何异常交给 `failRun`；`:176-193` 把 run 直接写成 `failed` 并补 `error` 终态事件。
4. `tools/tool-executor.ts:75-78` 对非 `search_orders` 的操作统一 `assertOrderRoot`；`tools/order-root.ts:24-31`（`:29`）查不到订单即 `NotFoundException({code:"ORDER_NOT_FOUND"})`。

**触发场景**：与线上故障完全一致——模型第 1 步计划了 8 个调用，第 1 个 `get_order_overview` 带猜测的 `order_no`；根验证 404。

**用户可见影响**：整轮回答报废。模型本来可以在拿到"订单不存在"后改写为 `search_orders` 重试，但代码没有任何回传路径：**失败既没有进入 `messages`，也没有第二次 `plan()`**（探针 A：`planCalls=1`、`executorCalls=1`、终态 `failed`）。用户只得到"订单不存在"，且只能整问重发。

**为什么是 P0**：这是生产故障的**直接机制**；任何一次工具参数错误（404/400/422）都会升级为整轮失败。更糟的是，`agent-orchestrator.test.cjs:176-192` 把这个行为写成了断言（"工具执行抛错：run 落 failed"），等于用测试锁住了缺陷。

**最小修复**

- `executeTool` 区分"可回传的工具级失败"与"必须终止的失败"：`ORDER_NOT_FOUND`、`AGENT_TOOL_ARGUMENT_INVALID`、`AGENT_TOOL_UNKNOWN`、`AGENT_OPERATION_NOT_IMPLEMENTED`、`ORDER_SEARCH_REQUIRED` 作为**工具结果**回传（`tool_status failed` + 一条带 `{error:{code,message}}` 的 tool 消息），继续循环；`AGENT_ACCESS_REVOKED`/取消/超时/非 `HttpException` 仍走 `failRun`。
- 加失败预算（例如同一 run 最多 3 次可回传失败、不能对同一 operation 连续失败 2 次），避免模型死循环。
- 同步改写 `agent-orchestrator.test.cjs:176-192` 为新语义，并新增"失败 → 模型 search → 成功回答"的回放用例。
- 依赖：**必须先修 SDK 线格式**（见 3.2），否则第二条 `plan` 请求本身就是畸形的。

---

### P0-2 "先 search_orders 再根查询"只在提示词里，且未提交/未部署；其他 5 个领域工具同样接受猜测单号

**证据**

- `agent-orchestrator.ts:22` 的 `SYSTEM_PROMPT` 只有"只根据工具事实回答"一句，**没有任何"先搜索再按订单号查询"的规则**。
- `deepseek-llm-provider.ts:20-27` 的 `TOOL_DESCRIPTIONS`：`order_query` 的"先调用 search_orders……"只存在于**工作区未提交改动**（`git diff` 唯一改动；`git show 1101215:` 与部署版 `git show 738cd66:` 都是旧文案"按单号关键字搜索销售订单，或查询某张订单的非财务进展"）。
- 即使提交也覆盖不全：`sales_query`/`procurement_query`/`production_query`/`warehouse_query`/`finance_query` 五条描述（`:22-26`）仍只说"查询某张订单"，而这五个工具同样可带 `order_no` 调 `assertOrderRoot`（`tools/tool-executor.ts:70-80`）。
- 运行时没有订单号来源校验：`deepseek-llm-provider.ts:32-42` 的 `domainInputSchema` 里 `order_no` 只是可选自由字符串；`tool-executor.ts:75-78` 拿它直接查根。
- 提交 `1101215` 只加了**文本断言**：`apps/api/test/unit/agent-deepseek-provider.test.cjs:38,42` `assert.match(orderTool.description, /先调用 search_orders/)`。提示词文本 ≠ 运行时保证。

**触发场景**：模型第一步直接根查询（线上即如此）；或模型猜了一个**恰好存在**的订单号——后者更危险：不会 404，会拿错误订单作答。

**用户可见影响**：线上故障触发条件；提示词修复未部署 → 线上复现风险不变；即使部署，跨 5 个领域工具与"猜中存在的单号"仍无保护；提示词遵循度是概率行为，不是契约。

**最小修复**

- 运行时守卫（真正的"保证"）：编排器维护本轮 `searchOrders` 返回过的 `order_no` 集合（事实已在 `facts` 里）；执行根操作前若 `call.args.order_no` 不在集合内，**不触达数据库**，返回可回传失败 `ORDER_SEARCH_REQUIRED`（"请先用 search_orders 取得精确 order_no"），由 P0-1 的回传机制让模型自纠。
- `SYSTEM_PROMPT` 增加一条硬规则；6 个领域工具描述同步补"order_no 必须取自 search_orders 结果"。
- 把 1101215 的测试从"描述文本存在"升级为"**根操作先于 search 被运行时拒绝**"（假 provider 直接 plan `get_order_overview`，断言 executor 未被调用、下一轮 plan 收到 `ORDER_SEARCH_REQUIRED`）。
- 提交并部署（当前线上没有这段文案，见 P1-6）。

---

### P1-1 工具预算按"调用数"计：一次 plan 返回 8 个调用就耗尽预算，第二轮规划被跳过

**证据**：`agent-orchestrator.ts:23`（`AGENT_MAX_TOOL_STEPS = 8`）、`:90-101` 的 `while (calls.length>0 && executed<8)`：`executed` 每个**工具调用** +1；`:98` 一旦 `executed>=8` 直接 `break`，不再 `planOnce()`。探针 A（首轮 8 调用全部成功）：`planCalls=1`、`executorCalls=8`，模型**从未看到结果后再规划**。设计文档 `docs/design/business-query-agent-v0-phase2-2026-10-25/task-2-context-and-orchestrator.md:21` 写的是"每轮 plan 返回 0 个调用即进入回答；轮数与工具总数受 `MAX_TOOL_STEPS`（8）约束"——实现把"轮数"和"总数"合并成一个只减不增的调用计数。

**触发场景**：模型一次性计划大量调用（线上就是 8 个）。这在 DeepSeek 并行 tool_calls 下是常态，不是异常。

**用户可见影响**：模型没有"先查结果、再决定下一步/再核对"的机会；一旦计划里混了错误调用（如猜测单号），只能靠运气。叠加 P0-1 时故障必然发生；叠加 P0-2 时错误订单会被直接作答。

**最小修复**：拆成两个上限——`MAX_PLAN_ROUNDS`（如 4）与 `MAX_TOOL_CALLS_PER_RUN`（如 8）；轮数用 `modelSteps` 计。预算耗尽时至少再做一次**带全部结果**的 `plan`（或明确进入回答），并在 `completed.usage` 里区分 planned/executed。

---

### P1-2 超出预算的调用被静默丢弃：无事件、无日志、无用户提示

**证据**：`agent-orchestrator.ts:90-98`：`for (const call of calls)` 内 `executed>=8` 时 `break`，`calls` 里剩下的调用**既没执行、也没生成 tool 消息、也没有事件/观测**。探针 B：第二轮 plan 返回 10 个调用（`b-0..b-9`），实际只执行 `a-0,b-0..b-6` 共 8 个，`b-7/b-8/b-9` 完全消失，run 仍 `completed`；`observability` 的 `model_step` 只记 `tool_calls`（`agent-orchestrator.ts:81`）这个"计划数"，没有任何 executed/dropped 字段（`observability.ts:12-20`）。provider 侧也会静默丢调用：`deepseek-llm-provider.ts:113-118`（未授权工具名、缺 `operation` 一律 `continue`），SDK 实证报告已证明真实模型会因畸形历史产出这种调用。

**触发场景**：单轮调用数超过剩余预算（线上 8 个调用刚好卡满）；或模型给出畸形/越权调用。

**用户可见影响**："少查/漏查"但界面显示成功；回答可能声称覆盖了并未执行的查询；运维无法从日志看出发生了截断（只能靠 `tool_calls` 数字心算）。

**最小修复**：按剩余预算截断并向模型回传一条系统/tool 提示（"剩余预算不足，以下调用未执行：..."，只含 operation，不含参数）；对每次丢弃记一条 `tool_dropped` 观测（含 operation、原因枚举），`model_step` 增补 `executed/dropped`。

---

### P1-3 前端终态事件顺序缺陷：`state:failed` 先到、`error` 的真实错误码被终态锁吞掉

**证据**

- 服务端 `state-manager.ts:102-103`：`transitionAndAppend` 会把自动 `state` 事件**放在显式事件之前**；`agent-orchestrator.ts:191` 的 `failRun` 用 `events:[{type:"error",...}]` 写入，落库顺序是 `state(failed)` → `error(码)`。
- 前端 `apps/web/lib/business-query-state.ts:89` 终态锁 `if (TERMINAL_PHASES.has(state.phase)) return state;`；`:95-100` 收到 `state failed` 立刻 `phase:"error", error:{code:"RUN_FAILED"}`；随后真正的 `error` 事件（含 `ORDER_NOT_FOUND`/`订单不存在`）在 `:129-130` 之前就被锁掉。
- 探针结果：先投 `state{failed}` 再投 `error{ORDER_NOT_FOUND}`，最终仍是 `RUN_FAILED/本次查询未完成`。
- 刷新恢复却能看到真实码：`controller.ts:59-69` 快照用 `run.errorCode`，`agent-chat.ts:101` 用 `run.error_code` 兜底 → **live 与刷新后不一致**。
- 测试都直接投 `error` 事件、不投 `state{failed}`：`apps/web/lib/business-query-state.test.mjs:61-67`、`apps/web/test/agent-chat-page.test.tsx:240`，所以没抓到。

**触发场景**：任何一次 run 失败（线上 ORDER_NOT_FOUND 即命中）。

**用户可见影响**：实时界面只显示"本次查询未完成（RUN_FAILED）"，用户看不到真实原因（订单不存在/参数不合法/订单号要搜索），重试也无方向；刷新后反而显示真实码，体验割裂。

**最小修复**：前端 reducer 在 `phase==="error" && error.code==="RUN_FAILED"` 时允许后到的 `error` 事件覆盖（保留 seq 去重）；或后端把 `failed` 的 code 放进自动 `state` 事件 payload，或调整事件顺序。补一条"state failed + error"顺序用例。

---

### P1-4 控制器 fire-and-forget 未处理编排器拒绝：一次 DB 抖动可让进程退出，且 run 永久卡在 planning

**证据**

- `business-query-agent.controller.ts:118-122`：`void this.orchestrator.run(run, principal, abort.signal).finally(() => {...})` —— `.finally` 返回的 promise 被丢弃，没有 `.catch`。
- `agent-orchestrator.ts:48-49`：`const fresh = await this.state.findRun(...)` 在 `try` **之外**；`:55-59` 的 `try/catch` 覆盖不到它。
- 探针：`void Promise.reject(...).finally(...)` 在 Node 24 下打印未处理拒绝并 **exit 1**（Nest 主进程没有 `unhandledRejection` 兜底，仓库 grep 无匹配）。
- 若 `run()` 拒绝，run 不会被写成 failed：仍停在 `planning`。而 `state-manager.ts:75-78` 的 `hasActiveRun` 与 `controller.ts:93-95` 的 `RUN_IN_PROGRESS` 会一直挡住该用户的新提问，直到进程重启（`business-query-agent.module.ts:47-50` 的 `failInterrupted`）。

**触发场景**：`createRun` 之后、编排器刚启动时数据库连接池耗尽/重启（一次 `findRun` 抛错）。

**用户可见影响**：API 进程退出（其他 3 个在跑 run 一起中断）；重启前该用户所有提问都返回 `RUN_IN_PROGRESS`；运维只能看到一条未捕获拒绝。

**最小修复**：把初始 `findRun` 包进 `run()` 的 `try`（失败时用传入的 `run` 行兜底或写 failed）；控制器改为 `void this.orchestrator.run(...).catch((error) => this.logger.error(...)).finally(...)`，保证 run 永远落终态。补一个 `findRun` 抛错的单测。

---

### P1-5 "全部调用被静默丢弃"被当成"本轮不需要工具"：run 无事实进入回答

**证据**：`deepseek-llm-provider.ts:112-121`：越权工具名 `:114 continue`、缺 `operation` `:117 continue`，最后返回 `{toolCalls: []}`；`agent-orchestrator.ts:86` 用 `toolCalls.length>0` 判断是否进入查询阶段，`:102` 到 `:106` 直接以 `planning→responding` 推进并生成回答。全程无事件、无日志、无观测区分"模型本来不需要工具"与"调用被丢掉"。SDK 实证报告 §5.3 证明真实模型在畸形历史下**会**产出这种被丢的调用；报告 §6/§8.3 也指出观测盲区。

**触发场景**：模型本轮只发出越权（`finance_query` on operational）或畸形调用；一次重放/一轮 plan 全被过滤。

**用户可见影响**：`completed` 的回答没有任何工具事实支撑（可能编造/凭历史猜测）；越权尝试也不计入"权限拒绝次数"（`docs/design/business-query-agent-v0-module-design-2026-10-25.md:165` 要求记录，但 `observability.ts:12-20` 没有该事件类型）。

**最小修复**：provider `plan` 返回 `{toolCalls, dropped:[{toolName, reason}]}`；编排器在"有原始调用但全被丢"时先回传一次可恢复错误（`AGENT_TOOL_UNKNOWN`/`AGENT_MODEL_ERROR`）再重规划一次，仍为空才失败；观测新增 `tool_dropped`。

---

### P1-6 生产故障"修复"只停在工作区：HEAD 上测试先于源码（干净检出必红），线上部署版也没有这段文案

**证据**

- `git show 1101215 --stat`：该提交只改 `apps/api/test/unit/agent-deepseek-provider.test.cjs`（+2 行断言）；`apps/api/src/.../deepseek-llm-provider.ts` 未提交（`git diff` 唯一源码改动）。
- `git show 1101215:apps/api/src/.../deepseek-llm-provider.ts` 的 `order_query` 描述为旧文案，`/先调用 search_orders/` 匹配为 **false**（探针输出）。
- 部署版 `git show 738cd66:...` 同为旧文案；`git diff 738cd66..HEAD -- apps/api/src/modules/business-query-agent` 显示这期间源码只改了 provider 的 system prompt/operation schema，**没有任何 orchestrator 变更**（即线上的失败语义=当前源码语义）。

**触发场景**：任何人从 HEAD 干净检出新构建；或按进度文档 `738cd66` 部署。

**用户可见影响**：CI/本地 `npm run test:unit:api` 在 HEAD 必红（工作区未提交改动让它变绿，掩盖了状态）；线上没有提示词修复；P0-1/P0-2 的运行时缺陷在两边都在。

**最小修复**：把描述改动与测试同一次提交；补运行时守卫（P0-2）；重新构建部署；CI 增加"干净检出 + 全量单测"关卡，禁止测试先于实现提交。

---

## 3. 交叉道（不并入上面的编号）

### 3.1 编排器与 provider 的接口保真度

- 工具消息契约 `llm-provider.ts:15` 的 `{role:"tool", id, tool, args, content}` 丢掉了 `operation`（provider 在 `deepseek-llm-provider.ts:118-119` 把它从 args 剥走，编排器 `agent-orchestrator.ts:95` 只回传 `call.args`）。回放给模型的 assistant tool_call 因此不是模型当初发出的形状（保真度问题，SDK 报告 §8.1 已列 P2/P3）。
- 一条 tool 结果合成一条 `assistant(tool_calls)`（`deepseek-llm-provider.ts:63-86`）：同一轮多个结果被拆成多条 assistant 消息。OpenAI 格式允许，但不是原始对话形状；对"模型复现自己历史"的行为有影响（SDK 报告 §8.2）。

### 3.2 SDK 线格式（归 `task-2`，本报告仅登记依存）

- 本报告的探针独立复现了 `docs/review/agent-sdk-wire-proof-2026-10-26.md` 的结论：`deepseek-llm-provider.ts:69` 的 `input: JSON.stringify(message.args ?? {})` 导致 `tool_calls[].function.arguments` 双重编码；真实 DeepSeek **不会 400**，而是让后续 plan 的调用退化为嵌套 `{"arguments": "..."}`（顶层无 `operation`），再被 `plan()` 静默丢弃（`deepseek-llm-provider.ts:113-118`）。
- 对本文档的影响：**P0-1 的恢复路径依赖第二轮 plan**，正好踩在这个缺陷上。因此 P0-1 与 SDK 线格式修复必须同批上线，否则"失败回传后让模型 search"在实际 DeepSeek 下会表现为"第二轮调用消失、无事实作答"（而不是报错）。修复细节与实证见该报告 §7（一行改法）与 §9（可复现脚本）。

---

## 4. P2 清单

### P2-1 `tool_status` 事件没有调用序号/ID，前端按 `tool+operation` 去重会覆盖同 operation 的重复调用

`agent-orchestrator.ts:141,146-152` 只发 `{tool, operation, status, code}`；`apps/web/lib/business-query-state.ts:101-111` 以 `tool+operation` 查重并替换。一次 plan 里对同一 operation 的两次调用（如 `search_orders` 两个关键字、翻页两次）在界面上只留一条，失败/成功互相覆盖。**最小修复**：事件 payload 增 `call_id`（可用 `call.id`）或递增 `step`，reducer 按该键去重。

### P2-2 同一个"run 级超时"会报两种错误码

设计定案是 `failed/AGENT_RUN_TIMEOUT`（`docs/design/business-query-agent-v0-phase2-2026-10-25/task-2-context-and-orchestrator.md:24`）。但若超时发生在模型调用内，`model-errors.ts:22-24` 会把 `TimeoutError/AbortError` 映射成 `AGENT_MODEL_TIMEOUT`，先于编排器 `failRun` 的 `TimeoutError` 判定（`agent-orchestrator.ts:180-181`）生效；`agent-orchestrator.test.cjs:140-159` 只用不映射的假 provider，没覆盖真实 provider。**最小修复**：编排器用独立 controller 区分"用户取消/run 超时/model 超时"，或在 provider 层的 abort 原因里带上来源；前端文案一致但观测口径需统一。

### P2-3 结构化日志双重编码，`run_id` 不是顶层字段

`observability.ts:36-39` 把 `JSON.stringify({run_id,...})` 当 message 传给 `StructuredLogger`；`apps/api/src/platform/logging/structured-logger.ts:4-6` 再 `JSON.stringify({level:"info",message,...})`，输出成 `"message":"{\"run_id\":...}"`。探针已复现。**影响**：按设计"每个 run 可按 ID 追踪"（模块设计 §R-11）做 `jq '.run_id'` 会取不到，日志检索只能子串匹配。**最小修复**：StructuredLogger 对对象 message 直接展开合并，或 observability 写对象而非字符串。

### P2-4 失败轮刷新后丢失执行步骤：快照不返回 `tool_status`

`controller.ts:55-70` 的快照只拼 answer/sources；`apps/web/lib/agent-chat.ts:97-101` 注释也承认"快照不持久化 tool_status，历史轮没有执行步骤"。但事件表里其实有 `tool_status` 事件（`state-manager.ts:18` 的 8 类事件含之）。**影响**：生产故障后用户刷新页面，只看到"本次查询未完成"，看不到"订单全链路查询失败"，也没法据此修改问法。**最小修复**：快照增加 `tool_steps`（从 events 提取 tool_status，只含 tool/operation/status/code），`turnFromSnapshotRun` 映射之。

### P2-5 `ORDER_NOT_FOUND` 等工具错误码没有前端文案，失败步骤只显示"查询没有完成"

`apps/web/lib/agent-tool-labels.ts:112-127` 的映射表没有 `ORDER_NOT_FOUND`（也没有 P0-2 建议新增的 `ORDER_SEARCH_REQUIRED`），`toolErrorReason()` `:129-132` 兜底"查询没有完成"。**影响**：展开失败步骤看不到"订单号不存在/需先搜索确认单号"，用户不知道下一步该做什么。**最小修复**：补两条文案；快照失败 message 也按 code 映射（`agent-chat.ts:101` 目前恒为"本次查询未完成"）。

### P2-6 SSE 重连计数每次成功连接即归零，可无限重连

`apps/web/lib/business-query-stream.ts:45-46` 每次 `onOpen` 后 `retries = 0`；`:83-84` 才判断 `retries > maxRetries`。若服务端建立连接后立刻关闭（代理超时、后端重启窗口、无事件连接被网关切断），客户端会以 1.5s 间隔无限重连且永不报错。**最小修复**：只在收到至少一条事件后归零；或对"打开后 N 秒内无事件即关闭"单独计数。

### P2-7 SSE 拒绝文案与恢复路径不准

`business-query-stream.ts:43` 把 401/403/404 统一抛 `SSE_REFUSED_*`；`:79` 对 404（run 不存在）也提示"当前档位无法读取该回答"；401 只给页面 notice（`page.tsx:76-80`）不跳登录。**影响**：少数恢复场景给用户错误指引。**最小修复**：404 → "查询不存在或已被清理"；401 → 走全局登录失效处理。

### P2-8 SSE 轮询每 200ms 重查一次角色，连接多时放大读放大

`stream-transport.ts:48-53` 每轮 `assertCanReceive` → `roleReader.readActiveRoleKeys`（即一次 `userRole.findMany`）。按并发上限 4 个 run 估算，最坏每秒 20 次角色查询 + 20 次事件查询。**影响**：小规模可用，但这是纯浪费的连接级读放大；降权检测也不缺这 200ms。**最小修复**：角色重查降频（如 2s/次），或在降权时通过事件通知连接；200ms 只轮询事件。

### P2-9 `failInterrupted()` 在多副本/滚动部署下会误杀另一进程正在跑的 run

`state-manager.ts:137-148`：启动时把**所有用户**的活动 run 标 `failed/INTERRUPTED`。V0 单进程假设（`concurrency-gate.ts:4-6` 已声明），但滚动部署会短暂双实例，新实例会终止旧实例正在写的 run。**最小修复**：给 run 增加进程/实例标识或心跳时间，只收编超过阈值的孤儿；至少在部署脚本里显式串行（先停旧实例再起新实例）。

### P2-10 观测字段不足以复盘"计划了哪些、执行了哪些、在哪一步失败"

`observability.ts:12-20` 的 `model_step` 只有 `tool_calls` 计划数，`tool_executed` 只有 operation/status/行数/耗时，`run_failed` 只有 error_code；没有 executed/dropped、调用序号、失败的 step、失败 run 的 usage（`usage` 只在 `run_completed` 记，`agent-orchestrator.ts:122-137`）。另 `tool_executed` 记录的是创建时档位 `principal.accessLevel`（`agent-orchestrator.ts:153,159`），降权后与 `tool-executor.ts:42` 实际使用的 effective 档位不一致。**最小修复**：补 `planned/executed/dropped`、`step`、`tool_call_id`、失败 run 的部分用量，并把档位改成 effective。

---

## 5. 逐问题回答（对应 task-4 的 Q1-Q7）

### Q1 工具调用失败（ORDER_NOT_FOUND）后 run 会发生什么？模型有没有机会先搜索再自纠？

如上 P0-1：**没有任何机会**。链：`provider.plan` 第 1 轮 → `executor.execute` → `assertOrderRoot` 抛 404 → `executeTool` 发失败事件后 `throw` → `queryPhase` 冒泡 → `failRun` 写 `failed` + `error` 事件。模型没收到 tool 结果，`plan()` 不会被再调用（探针：`planCalls=1`）。唯一"恢复"是用户重发一个新 run（`page.tsx` 重试按钮），且会重复同样的猜测。

### Q2 orchestrator 真的强制"search_orders before root"吗？运行时是否保证？

**完全没有强制**（P0-2）。规则只存在于（a）工作区未提交的工具描述；（b）其他 5 个领域工具没有；（c）运行时 `tool-executor.ts:75-78` 对任何 `order_no` 一视同仁。测试 `agent-deepseek-provider.test.cjs:42` 只断言描述文本。因此部署/运行时行为**不保证**：模型可以不搜索直接根查询；甚至可以"猜中"一个存在的订单号而完全无报错地答错订单。

### Q3 多调用步骤怎么执行、>8 怎么截断、被丢调用的消息怎么办、有没有孤儿 tool-call/tool-result 风险？

- 同一 plan 的 N 个调用按顺序执行（`agent-orchestrator.ts:90-97`），每成功一个压一条 tool 消息（`:95`），失败即终止（P0-1）。
- 截断发生在"已执行数"到达 8 时（`:92,98`），剩余调用**静默丢弃**（P1-2），探针 B 证实 3 个调用无任何痕迹。
- 孤儿风险：**当前实现下没有结构化孤儿**——provider 只用 tool 消息反向合成 `assistant(tool_calls)`（`deepseek-llm-provider.ts:63-86`），被丢调用从未进 messages。但这是"靠实现细节兜底"：一旦编排器开始存原始 assistant 调用（修保真度/换 provider 就会），被丢调用立刻变成"assistant 有 tool-call、后续无 tool-result"的非法历史。且对模型而言是**伪造历史**（它实际发过 10 个调用，回放只有 8 个）。
- 额外：单轮 8 个调用会耗尽预算，导致第二轮规划被跳过（P1-1）。

### Q4 消息/历史组装有没有顺序、重复、状态问题？

- system + 8 轮历史 + 当前问题（`agent-orchestrator.ts:66-73`）顺序正确；历史只含 completed 轮、按创建升序、降权过滤（`context-manager.ts:24-34`），无重复。
- 问题在"工具轮"：只有成功结果进 messages（P0-1）；`operation` 在 tool 消息里丢失、provider 回放成单条 assistant 消息（3.1）；回放 `input` 被双重编码（3.2）。这三处叠加就是"第二轮 plan 不可靠"。
- 失败终态事件顺序 `state` 先于 `error` 导致前端丢码（P1-3）。
- 每轮 answer_delta 一次事务（`agent-orchestrator.ts:119`）本身没问题；`completed` 事件又重复全部 sources（`:128`）与逐条 `source` 事件（`:149-151`）叠加，事件体积偏大，属可优化项。

### Q5 失败/可观测性：吞了什么、露出什么码、够不够定位、取消/超时竞态

- 吞掉：可恢复工具错误全部升级为 run 失败（P0-1）；plan 丢弃的调用无痕（P1-2/5）；`failRun` 对业务错误的 transition 失败用 `.catch(()=>{})`（`agent-orchestrator.ts:191`）→ DB 写失败时 run 卡活动态但日志显示已失败；`run()` 的未捕获拒绝（P1-4）。
- 露出：`error` 事件带稳定码与固定文案（`failRun:181-191`），业务异常 message 可读（"订单不存在"）；但前端 live 丢码（P1-3）、快照丢 message（P2-5）。
- 定位：**能**基本定位到"哪个 operation 失败、什么码"，因为 `run_created → model_step(tool_calls=N) → tool_executed(failed, error_code) → run_failed` 都有 `run_id`（`observability.ts:37-39`）；但缺 planned/executed/dropped 与 step 关联（P2-10），且日志被双重编码（P2-3），实际查询成本高。失败 run 不记 usage（成本不可见）。
- 取消/超时竞态：取消→终态条件更新、迟到写入被 `from` 条件拒绝（`state-manager.ts:105-116`）、测试覆盖（`agent-orchestrator.test.cjs:209-223`、`agent-state-manager.test.cjs`、commit `3391e4d`）——**这部分工作正常**。超时口径不一致见 P2-2。

### Q6 Web 客户端：SSE 解析、重连/续接、错误呈现、失败码是否可用

- 解析：按 `\n\n` 切帧、`data:` JSON、`seq` 去重与 `Last-Event-ID` 续接，逻辑正确；组件/单测/e2e 覆盖（`business-query-stream.ts:27-88`、`business-query-state.test.mjs`、`apps/web/test/agent-chat-page.test.tsx`）。
- 重连：有上限重试，但重置计数有缺陷（P2-6）；404 文案不对（P2-7）。
- 错误呈现：**live 失败码基本不可用**（P1-3 只显示 RUN_FAILED）；工具步骤失败原因对 `ORDER_NOT_FOUND` 无文案（P2-5）；刷新后丢失步骤（P2-4）；错误态下仍会展示失败前收到的 sources（`agent-message.tsx:42-50`），有"半截证据 + 未完成"的误导风险（低）。
- 取消/重试按钮、草稿保留、忙碌禁用切会话（`agent-toolbar.tsx:11-12,20-21`）都正常——这部分工作正常。

### Q7 测试覆盖缺口（生产失败模式哪些没有测试）

见第 6 节。核心一句：**现有 112 个 agent 单测 + Web 状态机单测全部是"失败即终态""单一成功调用"的世界观，没有一个用例走"工具失败→模型自纠→完成"或"一次 plan 多调用"。** 而 `agent-orchestrator.test.cjs:176-192` 反过来把缺陷行为锁死了。

---

## 6. 测试覆盖缺口清单

| # | 生产失败模式 | 现有测试 | 缺口 |
|---|---|---|---|
| 1 | 工具 404/400/422 后模型自纠 | `agent-orchestrator.test.cjs:176-192` 断言"run 落 failed"（锁死缺陷） | 无任何恢复路径测试；修 P0-1 必须同步改这条 |
| 2 | 单轮多调用（N>1）执行/截断 | 无（`agent-orchestrator.test.cjs:124-138` 的"多步"是每轮 1 个调用） | 无 N>1；无 >8 截断；无"截断事件/日志"断言 |
| 3 | 根查询前必须 search 的运行时保证 | `agent-deepseek-provider.test.cjs:32-43` 只断言描述文本 | 无运行时守卫测试；无其他 5 个领域工具用例 |
| 4 | 越权/畸形调用被丢后的下游行为 | `agent-deepseek-provider.test.cjs:63-77` 断言"丢弃" | 无"全被丢→不应无事实作答"用例；无权限拒绝计数 |
| 5 | 失败终态事件顺序（state→error） | `business-query-state.test.mjs:61-67`、`agent-chat-page.test.tsx:240` 只投 error | 无 state{failed}→error{code} 顺序用例 → P1-3 漏网 |
| 6 | ORDER_NOT_FOUND 文案/建议 | `agent-tool-labels.test.mjs:64-70` 只测 `AGENT_TOOL_FORBIDDEN` 等 | 无 ORDER_NOT_FOUND/ORDER_SEARCH_REQUIRED |
| 7 | 控制器/编排器启动失败路径 | 无 controller 单测 | 无 findRun 抛错、无未处理拒绝、无"run 卡 planning"断言 |
| 8 | 真实 DeepSeek 多步链路 | HTTP 契约测试用 fake provider（`business-query-contract.test.cjs:100-107`） | 无真实 provider 多步；进度文档也承认"真实双角色验收进行中" |
| 9 | HEAD 测试/源码一致性 | 无 | 干净检出上 `npm run test:unit:api` 必红（P1-6） |
| 10 | 取消/超时/重放竞态 | 有（state-manager、orchestrator、e2e recovery） | 这部分**不是缺口**，见第 7 节 |

---

## 7. 工作正常的部分（避免误伤）

1. **只读工具边界与执行顺序**：registry 校验 → 参数严格校验（多余字段拒绝）→ 身份重查 → 只读查询 → 投影/行数/字节截断（`tools/tool-executor.ts:30-99`、`tools/order-query-tools.ts:22-56`、`tools/order-root.ts:24-57`）；7 个执行器单测全过，覆盖 403/422/400/截断/投影。
2. **状态机不变量**：条件迁移 `where state=from`、终态不可离开、状态与事件同事务、`(run_id,seq)` 唯一（`state-manager.ts:95-117`）；state-manager 单测覆盖；取消与迟到写入竞态有测试（`agent-orchestrator.test.cjs:209-223`）。取消后编排器迟到启动空转也正确（`:225-235`）。
3. **SSE 传输**：先重放后轮询、`Last-Event-ID: <runId>:<seq>` 校验、终态事件后关闭、每批发送前重查档位、ACCESS_REVOKED 控制帧（`stream-transport.ts:23-79`、`controller.ts:131-141,171-179`）；HTTP 契约测试与 e2e recovery 覆盖。
4. **并发与许可**：全进程 4 许可、无排队、429+Retry-After、`finally` 释放、重复释放幂等（`concurrency-gate.ts:13-35`、`controller.ts:98-127`）；有单测与 HTTP 并发测试。
5. **上下文**：最近 8 个 completed、降权时旧 full 轮不进入、旧工具结果不进上下文（`context-manager.ts:24-34`）；`agent-context-manager.test.cjs` 覆盖。
6. **权限**：两档判定、每次请求重查角色、执行前按较低档重查、运行中降权终止（`query-permission.guard.ts:38-54`、`access-level.ts`、`tool-permission.ts`、`agent-orchestrator.ts:164-173`）；有测试。
7. **观测形状脱敏**：事件类型里没有 prompt/答案/参数/结果字段，测试锁定允许键集合（`observability.ts:12-20`、`agent-observability.test.cjs`）；本故障的 `run_id` 链路（run_created→model_step→tool_executed(failed)→run_failed）是可查的（只是被 P2-3 的双重编码降低了可查询性）。
8. **模型错误映射**：4xx/5xx/超时/上下文超限都映射为稳定码、原始响应体不外传（`model-errors.ts:19-43`）；有测试。
9. **前端状态机基础能力**：seq 去重、终态锁、快照恢复不重复拼接、取消/重试、草稿保留、忙碌禁用切会话（`business-query-state.ts`、`agent-chat.ts`、`agent-message.tsx`、`agent-toolbar.tsx`）；11 个 reducer 单测 + 组件测试通过。

---

## 8. 建议修复顺序（给 Lead 的落地顺序）

1. **同批**：SDK 线格式一行修复（`deepseek-llm-provider.ts:69`，见 SDK 报告 §7）+ 把工作区描述改动提交，恢复 HEAD 绿（P1-6）。否则后续任何"多步"修复都无法在真实 DeepSeek 上验证。
2. **P0-1**：工具失败可回传 + 失败预算 + 改测试。
3. **P0-2**：运行时 `ORDER_SEARCH_REQUIRED` 守卫 + 6 个工具描述 + system prompt。
4. **P1-1/P1-2**：轮数/调用数分离，丢弃可观测。
5. **P1-3/P2-5/P2-4**：前端错误码与历史步骤（含快照字段）。
6. **P1-4/P1-5**：控制器拒绝兜底；plan 丢弃语义。
7. P2 其余项按发布节奏处理。

---

## 9. 附：本次审查未修改任何源码

- 只读源码/测试/文档；探针脚本位于 `%TEMP%`（`dilee-chain-probe.cjs`、`dilee-provider-probe.cjs`），不写仓库。
- 工作区已有他人未提交改动（`apps/api/.../deepseek-llm-provider.ts`、`apps/web/*`），本报告未触碰；本文件之外没有新增/修改仓库文件。

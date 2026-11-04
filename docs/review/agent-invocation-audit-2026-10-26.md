# 业务查询 Agent 调用问题排查（Lead 汇总）

- 日期：2026-10-26（Asia/Singapore，UTC+8）
- 范围：`apps/api/src/modules/business-query-agent/**`、Web 端 Agent 会话、AI SDK DeepSeek provider、生产部署与数据库运行记录
- 方式：仓库代码审查 + 安装包源码/类型核对 + 本地 mock 抓包 + 真实 DeepSeek 端点探针 + root SSH 生产取证
- 结论证据：四份子报告（见文末附录），全部可复跑
- 本次未修改源码、未重启/部署生产服务

---

## 0. 直接回答：SDK 参数格式是否和当前不一致？

**不一致，但只不一致在“消息内容格式”这一层；调用参数层是对齐的。**

| 层 | 结论 | 说明 |
|---|---|---|
| 调用参数层 | ✅ 一致 | `generateText` / `streamText` 的 `model / instructions / messages / tools / toolChoice / stopWhen / abortSignal` 与 `ai@7.0.153` 类型定义完全对齐 |
| 消息内容格式层 | ❌ 不一致（2 处） | ① `assistant.tool-call.input` 传了 **JSON 字符串**，v7 要求 **JSON 对象** → 线上 `tool_calls[].function.arguments` 被二次编码；② 回放的 tool-call 丢了 `operation` 字段，与工具 schema 的 required 自相矛盾 |
| usage / abort / 超时 / 错误映射 | ✅ 一致 | `result.usage` 字段名、`AbortSignal` 组合、错误稳定码映射均正确 |

**核心证据（真实 DeepSeek SDK 链路抓包，不是类型推断）：**

```text
线上实际发出的 arguments（双重编码）：
"arguments":"\"{\\\"q\\\":\\\"SO-2026-0001\\\"}\""
→ JSON.parse(arguments) 得到的是 string，而不是 object

修复后（正确）：
"arguments":"{\"q\":\"SO-2026-0001\"}"
→ JSON.parse(arguments) 得到 object
```

根因在 3 处叠加：

1. `deepseek-llm-provider.ts:69` 先手工 `JSON.stringify(message.args ?? {})`；
2. `ai@7.0.153` 的 prompt 转换把 `tool-call.input` 原样透传（`node_modules/ai/dist/index.js:1529-1535`）；
3. `@ai-sdk/deepseek@3.0.73` 再 `JSON.stringify(part.input)` 一次（`node_modules/@ai-sdk/deepseek/dist/index.js:301-308`）。

**为什么 typecheck 和单测都没抓到：** `ToolCallPart.input` 类型是 `unknown`，且代码用了 `as ModelMessage` 断言；现有单测只断言 prompt 字符串里出现过 `tool-call`，没有断言 `input` 的类型或线上 `arguments` 解析后的类型。

**真实影响（已实测）：** `api.deepseek.com` 对双重编码历史返回 **HTTP 200 不报错**，但 temperature=0、生产 system prompt 下 3/3 次，模型会模仿畸形历史、输出 `{"arguments":"{\"operation\":...}"}`（顶层无 `operation`），随后 `plan()` 的 `if (!operation) continue` **静默丢弃**该调用 → 多轮查询少查/漏查，UI 却显示成功且无任何日志。

**上线触发状态：** 该缺陷存在于线上 dist（与 HEAD 相同），但现有 3 次 run 全部在第 1 次 plan 就失败，**尚未进入第 2 次 plan，因此线上还没被真实触发**；它是成功路径上的潜伏缺陷，一旦 P0-1 修好（工具失败可回传、进入第二轮）会立刻变成主要问题。因此 SDK 修复必须与 P0-1 同批上线。

---

## 1. 线上真实调用过程（root 服务器取证）

### 1.1 部署与版本

| 时间（UTC+8） | 事件 | 版本 |
|---|---|---|
| 20:23:15 | 首次部署带 Agent 的版本 | `738cd66` |
| 20:51 | 仅重启 `dilee-web`（API 未换） | — |
| 21:19:19 | 部署 | `7bcdb02`（system prompt 改走 `instructions`） |
| 21:47:33 | 部署（当前线上） | `c5fe88e`（按工具约束 operation 枚举） |

当前 `/opt/dilee/app/RELEASE_VERSION` = `c5fe88e01f9803dd83fc5c5711980a34604e2f97`；PM2 `dilee-api` / `dilee-web` 均 online；生产 `.env` 的 Agent 相关键齐全（`AGENT_READ_DATABASE_URL`、`AGENT_STATE_DATABASE_URL`、`AGENT_LLM_PROVIDER=deepseek`、`DEEPSEEK_API_KEY`、`BUSINESS_QUERY_ENABLED`）。

### 1.2 三次 run 全部失败，且是三个不同版本、三种原因

所有 run 的问题文本相同：**“请查询订单 DL260170-4H 伞头 的当前状态、采购到货、生产进度与库存；只根据系统事实回答并列出来源。”**
（3 次均为冒烟探针临时账号所发；人类账号 `laoban1` 只浏览页面，未发 run。因此这是冒烟复现，不是业务用户真实提问记录。）

| # | 时间（UTC+8） | 线上版本 | 错误码 | 真实原因 |
|---|---|---|---|---|
| 1 | 20:59:46 | `738cd66` | `AGENT_MODEL_ERROR` | provider 把 system 放进 `messages`；`ai@7.0.153` 在发 HTTP 前抛 `InvalidPromptError: System messages are not allowed in the prompt or messages fields`。**不是 DeepSeek 4xx，请求根本没发出。** 由 `7bcdb02`（`instructions` 修复）解决 |
| 2 | 21:22:19 | `7bcdb02` | `AGENT_TOOL_UNKNOWN` | 6 个领域工具共用同一 schema、不限定 operation；模型把 `search_orders` 用到 `procurement_query` → 注册表 422。**此前 `order_query/search_orders` 已成功返回正确来源 `DL260170-4H 伞头`。** 由 `c5fe88e`（按工具生成 operation 枚举）解决 |
| 3 | 21:49:29 | `c5fe88e` | `ORDER_NOT_FOUND` | 描述仍未要求“先 search”，模型第 1 个调用直接 `get_order_overview`；订单号与库中精确值不一致 → `assertOrderRoot` 404。8 个计划调用只执行了 1 个，run 立即 failed |

### 1.3 第 3 次失败的数据库边界证据

`sales_orders` 实际数据：

```text
DL260170-4H 伞头      ← 1 行（单号里包含产品名）
DL260170-4H           ← 0 行（精确匹配失败）
```

也就是说：**用户问题里的“订单 DL260170-4H 伞头”才是完整且精确的 order_no**。只要模型先调 `search_orders`，就能拿到正确单号（第 2 次 run 已经证明搜索能命中）；但它没有搜索，直接根查询，并且 `order_no` 只取了 `DL260170-4H`（或其它变体），于是 404。

### 1.4 运行时放大了故障

- `agent-orchestrator.ts:140-162`：工具失败只发 `tool_status failed` 事件，然后 `throw`（`:160`）→ `run()` 的 catch → `failRun` → 整轮 `failed`。
- 失败没有作为 tool 结果回传给模型，**模型没有第二次 `plan()`**（探针：`planCalls=1`、`executorCalls=1`）。
- 3 次 run 的 `answer` 与 `usage` 全为 NULL；用户只看到错误文案（“订单不存在”），没有部分答案，也不能自愈。

### 1.5 未取得的证据（明确声明）

- 生产 `tool_calls` 的参数没有落库（DB 事件、SSE、observability 均不含 args），**模型实际传入的 `order_no` 原文未取得**；上述结论用“精确匹配 1 行 / 截断后 0 行”的 DB 边界取证。
- 无任何 DeepSeek 4xx / 错误堆栈：PM2 error log 0 字节、全日志 0 条 error 级；`model-errors.ts` 按设计丢弃原始响应体，因此**不存在可摘录的 API 错误报文**。

---

## 2. 当前 Agent 调用过程问题清单

编号沿用子报告；`P0` = 生产直因，`P1` = 高，`P2` = 中低。

### P0-1 单次工具失败直接终结整轮 run，模型没有任何自纠机会

- 证据：`agent-orchestrator.ts:86-101`（只有成功才 push tool 消息）、`:140-162`（`:160 throw`）、`:176-193`（`failRun`）。
- 影响：任何工具 404/400/422 都升级为整轮失败；模型本可以“拿到订单不存在 → 改调 search_orders → 重试”，但代码没有这条路径。线上 ORDER_NOT_FOUND 的直因。
- 现状：`agent-orchestrator.test.cjs:176-192` 把这个行为写成了断言，等于用测试锁死缺陷。

### P0-2 “先 search_orders 再根查询”只写在提示词里，且未提交、未部署、未运行时强制

- `order_query` 的新描述（“先调用 search_orders…精确 order_no”）只存在于**工作区未提交改动**；HEAD 与线上都是旧文案。
- 另外 5 个领域工具描述仍只说“查询某张订单”；`tool-executor.ts:75-78` 对任意 `order_no` 直接查根。
- 后果：模型可以猜单号（线上即如此）；更危险的是“猜中一个存在的单号”，不会 404，会拿错订单作答。
- 修复必须是**运行时守卫**，不能只改提示词。

### P1 SDK 消息格式不一致（本文 §0；跨 provider + 编排器）

- `deepseek-llm-provider.ts:69` 双重编码（高）；
- `plan()` 把 `operation` 从 args 剥掉（`:118-119`），`llm-provider.ts:15` 的 tool 消息无该字段，`agent-orchestrator.ts:95` 只回传剩余 args → 回放历史缺 schema required 字段（中低，但会放大上面的静默丢弃）。

### P1-1 工具预算按“调用数”计，一次 8-call plan 耗尽预算并跳过第二轮规划

- `AGENT_MAX_TOOL_STEPS = 8`（`agent-orchestrator.ts:23`）同时被当作“工具调用总数”和“轮数”；`:90-101` 一旦 `executed>=8` 直接 `break`，不再 `planOnce()`。
- 线上第一次 plan 正好 8 个调用 → 模型从未在“看到结果后再规划”。

### P1-2 超出预算的调用被静默丢弃

- `:90-98` 剩余调用既没执行、也没 tool 消息、也没事件/日志；探针：第二轮 10 个调用只执行 8 个，`b-7..b-9` 完全消失，run 仍 `completed`。
- provider 侧同样静默：未授权工具名、缺 operation 一律 `continue`（`deepseek-llm-provider.ts:113-118`）。

### P1-3 前端终态事件顺序导致真实错误码被吞

- 服务端先写 `state(failed)` 再写 `error(code)`（`state-manager.ts:102-103` + `agent-orchestrator.ts:191`）；
- 前端终态锁（`business-query-state.ts:89,95-100`）先收到 `state failed` 就锁成 `RUN_FAILED`，后到的 `ORDER_NOT_FOUND` 被丢弃。
- 用户 live 只看到“本次查询未完成”，刷新后才能看到真实码，体验割裂。

### P1-4 控制器 fire-and-forget 未处理拒绝，可能让 API 进程退出

- `business-query-agent.controller.ts:118-122`：`void orchestrator.run(...).finally(...)` 没有 `.catch`；`agent-orchestrator.ts:48-49` 的初始 `findRun` 在 try 之外。
- 一次 DB 抖动 → unhandled rejection → Node 24 exit 1；且 run 永久停在 `planning`，该用户后续提问一直 409 `RUN_IN_PROGRESS`，直到进程重启。

### P1-5 “全部调用被静默丢弃”被当成“本轮不需要工具”

- `plan()` 可能返回空（越权/畸形调用被过滤），编排器据此直接进入回答，run `completed` 但没有任何事实支撑；越权尝试也不计入权限拒绝观测。

### P1-6 HEAD 红：测试先于源码提交，修复只停在工作区

- `1101215` 只提交了测试（断言 `/先调用 search_orders/`），源码描述改动未提交 → 干净检出执行 `npm run test:unit:api` 必红；线上也没有这段文案。
- 线上 `c5fe88e` 的 33 个 Agent 源文件与部署包逐哈希一致；HEAD 相对线上只多这个测试提交。

### P2（10 条，按发布节奏处理）

`tool_status` 无调用 ID（同 operation 重复调用会被前端覆盖）；同一 run 超时出现两种错误码；结构化日志 payload 双重编码、`run_id` 非顶层；失败轮刷新后丢执行步骤（快照不含 `tool_status`）；`ORDER_NOT_FOUND` 等无前端文案；SSE 重连计数每次成功即归零；404 文案/401 不跳登录；SSE 每 200ms 重查角色；多副本部署 `failInterrupted()` 误杀在跑 run；观测缺 planned/executed/dropped 与失败 run 用量。

---

## 3. 因果链（一句话版）

```text
用户问“订单 DL260170-4H 伞头…”
  → 模型没先 search，直接 get_order_overview（描述未强制 + 运行时无守卫）
  → 传入的 order_no 与库中精确值不一致
  → assertOrderRoot 404 ORDER_NOT_FOUND
  → executeTool throw → failRun（工具错误不回传、不重规划）
  → 整轮 failed，无部分答案、无自愈
（潜伏）只要工具有一次成功 → 第二轮 plan/最终回答的历史 tool-call 参数双重编码
  → DeepSeek 200 但模型模仿畸形 arguments
  → plan() 静默丢弃 → 少查/漏查，仍显示成功
```

---

## 4. 修复方案（按依赖排序，补丁级）

### 第 1 批：SDK 线格式 + 历史保真（P1，必须最先）

```diff
// apps/api/src/modules/business-query-agent/llm-provider.ts:14-15
- | { role: "tool"; id: string; tool: AgentToolName; args: Record<string, unknown>; content: string };
+ | { role: "tool"; id: string; tool: AgentToolName; operation: string; args: Record<string, unknown>; content: string };

// apps/api/src/modules/business-query-agent/agent-orchestrator.ts:95
- messages.push({ role: "tool", id: call.id, tool: call.tool, args: call.args, content: JSON.stringify(fact) });
+ messages.push({ role: "tool", id: call.id, tool: call.tool, operation: call.operation, args: call.args, content: JSON.stringify(fact) });

// apps/api/src/modules/business-query-agent/deepseek-llm-provider.ts:67-70
- content: [{ type: "tool-call", toolCallId: message.id, toolName: message.tool, input: JSON.stringify(message.args ?? {}) }],
+ content: [{ type: "tool-call", toolCallId: message.id, toolName: message.tool, input: { operation: message.operation, ...message.args } }],
```

`input` 必须是**对象**（`@ai-sdk/provider-utils` 的 `ToolCallPart.input` 文档：*JSON-serializable object that matches the tool's input schema*）；序列化由 `@ai-sdk/deepseek` 负责。Typecheck 仍会通过是正常的（`unknown` + 断言），必须靠线格式测试兜底。

**回归测试**：本地 mock `fetch` 捕获请求体，断言 `typeof JSON.parse(body.messages[i].tool_calls[0].function.arguments) === "object"`，且 `operation` 存在；修复前后应一红一绿。

### 第 2 批：P0-1 工具失败可回传 + 失败预算

- `executeTool` 不再“失败即 throw”：把 `ORDER_NOT_FOUND`、`AGENT_TOOL_ARGUMENT_INVALID`、`AGENT_TOOL_UNKNOWN`、`AGENT_OPERATION_NOT_IMPLEMENTED`、`ORDER_SEARCH_REQUIRED` 作为 **tool 结果** 回传（`tool_status failed` + 一条 `{error:{code,message}}` 的 tool 消息），继续循环；
- `AGENT_ACCESS_REVOKED` / 用户取消 / run 超时 / 非 `HttpException` 仍走 `failRun`；
- 失败预算：同一 run 最多 3 次可回传失败、同一 operation 不得连续失败 2 次，防死循环；
- 改写 `agent-orchestrator.test.cjs:176-192` 的新语义，并新增“失败 → 模型 search → 成功回答”回放用例。

### 第 3 批：P0-2 运行时 ORDER_SEARCH_REQUIRED 守卫

- 编排器维护本轮 `search_orders` 返回过的 `order_no` 集合（事实已在 `facts` 里）；
- 执行任何“以订单为根”的 operation 前，若 `args.order_no` 不在集合内，**不触达数据库**，返回可回传失败 `ORDER_SEARCH_REQUIRED`（“请先用 search_orders 取得精确 order_no”），由第 2 批机制让模型自纠；
- `SYSTEM_PROMPT` 增加硬规则；6 个领域工具描述同步补“order_no 必须取自 search_orders 结果”；
- 测试从“描述文本存在”升级为“根操作先于 search 被运行时拒绝”（断言 executor 未被调用、下一轮 plan 收到 `ORDER_SEARCH_REQUIRED`）。

### 第 4 批：P1-1 / P1-2 预算与丢弃可观测

- 拆成 `MAX_PLAN_ROUNDS`（如 4，用 `modelSteps` 计）与 `MAX_TOOL_CALLS_PER_RUN`（如 8，用 `executed` 计）；预算耗尽后至少再做一次“带全部结果”的 plan 或明确进入回答；
- 丢弃的调用回传一条只含 operation 的提示，并记 `tool_dropped` 观测（含原因枚举）；`model_step` 增补 planned/executed/dropped。

### 第 5 批：P1-3 前端错误码

- 前端 reducer 允许 `phase==="error" && error.code==="RUN_FAILED"` 时被后到的 `error` 事件覆盖（保留 seq 去重）；或后端把 failed code 放进自动 `state` 事件 payload；补“state failed + error”顺序用例。

### 第 6 批：P1-4 / P1-5 / P1-6

- 控制器 `void this.orchestrator.run(...).catch(err => logger.error(...)).finally(...)`；把初始 `findRun` 包进 `run()` 的 try，失败时保证 run 落终态；
- provider `plan` 返回 `{ toolCalls, dropped }`；全被丢时先回传一次可恢复错误并重规划，仍为空才失败；越权计入观测；
- 把工作区 `order_query` 描述改动与 `1101215` 测试同一次提交并部署；CI 增加“干净检出 + 全量单测”关卡。

---

## 5. 验证清单（修复后必须全部通过）

1. `agent-deepseek-provider.test.cjs` 新增 wire 断言：历史 tool-call 的 `arguments` 一次 `JSON.parse` 即对象，且含 `operation`；
2. orchestrator 新增“工具 404 → 回传 → 模型 search → 成功回答”用例（替换旧的“失败即终态”断言）；
3. orchestrator 新增“未 search 直接根查询 → `ORDER_SEARCH_REQUIRED` → 不触达 DB”用例；
4. 单轮 8/10 调用的预算与丢弃事件断言；
5. Web reducer 新增“`state failed` 后到 `error{ORDER_NOT_FOUND}` 覆盖 RUN_FAILED”用例；
6. 干净检出（`git stash`/worktree）执行 `npm run test:unit:api` 必须全绿；
7. 部署后用冒烟账号重跑同一问题：预期先 `search_orders` 得 `DL260170-4H 伞头`，再执行 4 个领域查询，最终回答有来源；失败时前端显示真实错误码。

---

## 6. 局限与未验证项

- 双重编码只在本地 mock + 真实 API 探针中确认；生产因 3 次 run 均未进入第 2 次 plan，**线上尚未真实触发**（但代码在线上 dist 中）。
- 真实模型行为对照是单场景、temperature=0、每变体 3 次，足以证明机理与方向，不是跨 prompt 统计结论。
- 模型实际传入的 `order_no` 未落库，`ORDER_NOT_FOUND` 的具体参数值未取得；用 DB 边界数据反证。
- 未做修复后的真实业务 e2e（需要部署与业务账号，超出本次排查范围）。
- 生产 3 次 run 为冒烟探针账号，尚无人真实业务用户的 Agent 使用记录。

---

## 附录：子报告与证据

| 报告 | 内容 |
|---|---|
| [agent-sdk-format-audit-2026-10-26.md](agent-sdk-format-audit-2026-10-26.md) | AI SDK v7 参数/消息格式逐项审计（file:line 级） |
| [agent-sdk-wire-proof-2026-10-26.md](agent-sdk-wire-proof-2026-10-26.md) | 真实 SDK 链路抓包、真实 API 探针、双重编码与静默丢弃实证；抓包工件在 `agent-sdk-wire-proof-2026-10-26/` |
| [agent-runtime-forensics-2026-10-26.md](agent-runtime-forensics-2026-10-26.md) | 生产 root 取证：部署时间线、3 次 run 的日志/DB 原文、版本比对 |
| [agent-callchain-review-2026-10-26.md](agent-callchain-review-2026-10-26.md) | 调用链缺陷 P0/P1/P2、测试缺口、修复顺序 |

---

## 附录 B：修复落地与上线验证（2026-10-27 00:02 UTC+8 补记）

### B.1 已提交的修复

| 提交 | 内容 |
|---|---|
| `27a47e2` | 主修：tool-call `input` 改为对象并保留 `operation`（消除双重编码）；可回传工具失败 + 失败预算；运行时 `ORDER_SEARCH_REQUIRED` 守卫；6 个工具描述与 system prompt 要求精确 order_no；plan/call 预算拆分与 `tool_dropped` 观测 |
| `8238430` | 补修：最终回答 `streamAnswer` 传 tools + `toolChoice:"none"`（禁止输出 DSML 工具调用标记）；单 run 工具预算 8 → 16 |

### B.2 部署结果

- 线上版本：`823843064bdb091fce98ae40c64ba9451600f925`（2026-10-27 00:01 +08 切换）
- 迁移：104 已应用，失败残留 0
- 健康检查：`status=ok, database=ok, build=8238430…`；`/`、`/login`、`/production`、`/warehouse`、`/procurement`、`/sales`、`/finance`、`/qc` 均 200
- PM2：`dilee-api`、`dilee-web` online；API error log 0 行
- 备注：部署脚本 `remote-switch.sh` 的健康检查在 API 启动约 13 秒时执行，两次都误判失败（实际随后健康）；已用 `remote-verify.sh` 手工完成步骤 6 核验。该脚本竞态建议后续把 curl 改为带重试。

### B.3 生产冒烟（临时账号，验证后已清理）

版本 `8238430` 上执行两句真实问题：

1. **“请查询订单 DL260170-4H 伞头 的当前状态、采购到货、生产进度与库存…”**
   - 状态 `completed`，无 error_code，答案 1383 字，含状态/采购/生产/库存四段与来源；
   - 工具序列：`search_orders` → `get_order_overview/status/alerts` → 采购 4 项 → 生产 2 项 → 库存 4 项 → `get_bom`，共 **15 次全部 completed**，未再出现 `ORDER_NOT_FOUND`、`AGENT_TOOL_UNKNOWN`；
   - 答案明确写出“订单号已通过系统检索确认，精确值为「DL260170-4H 伞头」（含产品名与空格）”，无 DSML 工具调用标记。
2. **“请查询订单 DL999999-ZZ 伞头…”（不存在的单号）**
   - 状态 `completed`，模型先 `search_orders` 得到空结果后给出“查不到、请核对单号”的回答，**不再整轮 failed**，无 error_code。

结论：P0-1（工具失败终结整轮）、P0-2（未搜索直接根查询）、SDK 线格式、最终回答 DSML 泄漏四条主链路均已在生产验证通过。

### B.4 未纳入本次上线的遗留项

P1-3 前端错误码被终态锁吞掉、P1-4 控制器未捕获拒绝、P1-5 全部调用被丢语义、P2 清理项，以及部署脚本健康检查重试，仍建议按原顺序处理。

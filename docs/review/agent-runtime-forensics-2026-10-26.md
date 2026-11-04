# 业务查询 Agent 生产运行时取证（2026-10-26）

- 取证时间：2026-10-26 22:00–22:20（UTC+8）
- 取证对象：生产服务器 `118.178.95.156`（root SSH，只读）
- 取证方式：读 `/opt/dilee/app` 部署物、`/home/ubuntu/.pm2` 日志与备份目录、容器 `app-postgres-1` 数据库 `dilee_erp`；**未重启/未停止 PM2、未写服务器文件、未执行迁移、未发起新的模型请求**，SQL 全部为 SELECT。
- 时区约定：正文主时间 = **UTC+8（Asia/Singapore）**，括号内为该事件日志/数据库中的 UTC 值。日志行内 `timestamp` 与数据库列均按 UTC 存储（已用同一 run 的创建时间交叉验证）。

---

## 0. 结论摘要（先看这一段）

1. **线上部署版本 = `c5fe88e01f9803dd83fc5c5711980a34604e2f97`**；仓库 HEAD `1101215` 只比它多 1 个测试提交（`apps/api/test/unit/agent-deepseek-provider.test.cjs`，2 行）。业务代码上 **dist ≡ c5fe88e ≡ HEAD 的 src**，33 个 Agent 源文件逐一对哈希一致（仅行尾 CRLF/LF 差异）。
2. **生产至今只有 3 次 Agent run，全部 failed**，全部是同一个问题「请查询订单 DL260170-4H 伞头 …」。三次分别跑在**三个连续部署版本**上，各自卡在不同缺陷，形成一条完整的"发布—冒烟—再修—再发布"失败链：
   - **20:59:46（12:59:46Z，部署 `738cd66`）：`AGENT_MODEL_ERROR`**。该版本 provider 把 `system` 消息塞进 `messages`，AI SDK 7.0.153 在发 HTTP 之前就抛 `InvalidPromptError`（"System messages are not allowed in the prompt or messages fields…"），被 `mapModelError` 映射成 `AGENT_MODEL_ERROR`。**这不是 DeepSeek 4xx，请求根本没有发出。**
   - **21:22:19（13:22:19Z，部署 `7bcdb02`）：`AGENT_TOOL_UNKNOWN`**。模型一个 plan 发出 5 个工具调用，第 1 个 `order_query/search_orders` 成功（1 行，来源 business_no = `DL260170-4H 伞头`），第 2 个把 `search_orders` 用到 `procurement_query`，被注册表拒绝；编排器**失败即整轮 failed**，剩余 3 个调用未执行。
   - **21:49:29（13:49:29Z，部署 `c5fe88e`）：`ORDER_NOT_FOUND`**。`c5fe88e` 已按工具枚举 operation（修好第 2 次的问题），但 `order_query` 描述仍允许"直接查某张订单"，模型首个调用直接 `get_order_overview`；数据库里真实单号是 `DL260170-4H 伞头`（精确=1 行），而 `DL260170-4H` 精确=0 行，`assertOrderRoot` 抛 404；**8 个 tool call 只执行了 1 个**就整轮 failed。
3. **设计放大因素**：`executeTool` 一旦抛错就向上冒泡 → `failRun`；**工具错误不回传给模型、模型没有自愈机会、没有部分答案**。三次失败的 `answer`/`usage` 全为 `NULL`，用户侧只看到错误文案（"模型调用失败，请稍后重试" / "未注册的查询能力：procurement_query/search_orders" / "订单不存在"）。
4. **SDK 双重编码隐患在线上"存在但未被触发"**：线上 dist 的 `toModelMessages` 确实有 `input: JSON.stringify(message.args ?? {})`；但 3 次 run 都没进入第 2 个 model step（日志仅 2 条 `model_step`，`step` 均为 1，且都在首个工具失败前中断），工具结果消息从未回传给第二次 plan。
5. **修复未上线**：`order_query` 描述"先调用 search_orders…"只存在于**本地未提交工作区**；HEAD 的测试 `1101215`（提交时间 21:50:58 UTC+8，正好在第 3 次失败之后）已断言该文案，因此 **HEAD 代码对该测试是红的**；生产仍跑旧文案。

---

## 1. 版本、进程与部署时间线

`/opt/dilee/app/RELEASE_VERSION` = `c5fe88e01f9803dd83fc5c5711980a34604e2f97`。
PM2：`dilee-api`（id 0，pid 579904，uptime 14m @22:02，↺0）、`dilee-web`（id 1，pid 579914）均 online。

由 `~/.pm2/pm2.log`、备份目录 `RELEASE_VERSION`、dist 构建时间可还原部署时间线：

| 时间（UTC+8） | UTC | 事件 | 部署前版本（备份） | 部署后版本 | API pid | 证据 |
|---|---|---|---|---|---|---|
| 20:23:12–15 | 12:23 | 双进程重启（首次带 Agent 模块的部署） | `4c2f7ef`（`app.backup-20261026-202314`，**无 business-query-agent 目录**） | `738cd66` | 573590 | pm2.log；备份版本文件；provider 哈希 |
| 20:51:42–43 | 12:51 | **仅 dilee-web 重启**（"Process 1 in a stopped status"），API 进程 573590 未动 | — | `738cd66`（API 未换） | 573590 | pm2.log 21:19 "pid=573590 … killed" 反证 |
| 21:19:17–19 | 13:19 | 双进程重启 | `738cd66`（`app.backup-20261026-211918`） | `7bcdb02` | 578122 | pm2.log；备份版本文件 |
| 21:47:26–33 | 13:47 | 双进程重启 | `7bcdb02`（`app.backup-20261026-214727`） | `c5fe88e`（当前） | 579904 | pm2.log；备份版本文件 |

备份目录指纹（provider 源文件 LF 归一化 SHA256，与本地 git 对象逐一比对）：

| 备份 | RELEASE_VERSION | provider SHA256 | 对应提交 |
|---|---|---|---|
| app.backup-20261026-202314 | `4c2f7ef…` | **文件不存在**（该版本无 Agent 模块） | `4c2f7ef` |
| app.backup-20261026-211918 | `738cd66…` | `10fa3266…` = `git show 738cd66:…deepseek-llm-provider.ts` | `738cd66` |
| app.backup-20261026-214727 | `7bcdb02…` | `0e0c61ee…` = `git show 7bcdb02:…deepseek-llm-provider.ts` | `7bcdb02` |
| app（当前） | `c5fe88e…` | `5c641a72…` = `git show c5fe88e:…deepseek-llm-provider.ts` | `c5fe88e` |

提交祖先关系（`git merge-base --is-ancestor` 全部为真）：
`4c2f7ef → 738cd66 → 7bcdb02 → c5fe88e → 1101215(HEAD)`。

因此三次 run 与运行代码的对应关系是确定的：

| run | 时间（UTC+8） | API pid | 运行版本 | 提交标题 |
|---|---|---|---|---|
| `97da6c85…` | 20:59:46 | 573590（20:23 起） | `738cd66` | docs(business-query): summarize phase6 release readiness |
| `d339bd3e…` | 21:22:19 | 578122（21:19 起） | `7bcdb02` | fix(business-query): send deepseek system prompt as instructions |
| `9a25d508…` | 21:49:29 | 579904（21:47 起） | `c5fe88e` | fix(business-query): scope deepseek operations by tool |

---

## 2. 三次真实 run 总览

| # | run_id | 时间（UTC+8 / UTC） | 运行版本 | 问题 | model_step | 已执行工具 | 错误码 / 文案 | 失败耗时 |
|---|---|---|---|---|---|---|---|---|
| 1 | `97da6c85-b279-4f07-86cb-f6562ae55c51` | 20:59:46.239 / 12:59:46.239Z | `738cd66` | 请查询订单 DL260170-4H 伞头 的当前状态、采购到货、生产进度和库存情况。只根据系统数据回答，并列出来源。 | **无**（plan 在 SDK 校验阶段抛错） | 无 | `AGENT_MODEL_ERROR` / 模型调用失败，请稍后重试 | 1253 ms |
| 2 | `d339bd3e-4ed8-4745-aa39-d595495d15d5` | 21:22:19.546 / 13:22:19.546Z | `7bcdb02` | 请查询订单 DL260170-4H 伞头 的当前状态、采购到货、生产进度与库存；只根据系统事实回答并列出来源。 | step 1（1549 ms，**tool_calls: 5**） | `order_query/search_orders` ✅（1 行）→ `procurement_query/search_orders` ❌ | `AGENT_TOOL_UNKNOWN` / 未注册的查询能力：procurement_query/search_orders | 1667 ms |
| 3 | `9a25d508-f1ec-48b5-bd05-f625f9394e17` | 21:49:29.575 / 13:49:29.575Z | `c5fe88e` | 同上 | step 1（2046 ms，**tool_calls: 8**） | `order_query/get_order_overview` ❌ | `ORDER_NOT_FOUND` / 订单不存在 | 2184 ms |

三个 run 的 `answer`、`usage` 均为 `NULL`，`state` 均为 `failed`，`access_level` 均为 `operational`。
三次 `POST /api/v1/business-query/sessions/{id}/runs` 均返回 **202**（run 已受理），失败通过 run 状态/事件暴露，HTTP 层无 5xx、无 4xx。

> **重要事实（避免误判为"真实业务用户日常使用"）**：这 3 个 run 的用户账号是**生产冒烟探针临时账号**——`agent-smoke-1793019584575-8dbf3063`（显示名 "Agent smoke probe"）、`agent_smoke_1793020938227_8c6632`、`agent_smoke_1793022568159_2d3340`（"Agent production smoke"），账号创建时间分别比 run 早约 1 秒（12:59:44.908 / 13:22:18.763 / 13:49:28.711Z），run 结束后 `is_active=false`，角色 key 均为 `qita`。唯一的人类账号 `laoban1`（老板一，角色 `laoban`）只在 20:44:40–20:46:05（12:44Z）浏览过页面并创建了 2 个空 session（0 个 run），没有发起查询。也就是说：**目前线上 Agent 失败全部来自自动冒烟探针；尚无真实业务用户的 Agent 使用记录。** 上面三种失败模式就是真实用户会遇到的同一套行为。

---

## 3. PM2 原始日志（逐字，已去 ANSI 颜色码）

日志文件与覆盖范围：
- `/home/ubuntu/.pm2/logs/dilee-api-out.log`：6222 行，2026-09-17T10:22Z ～ 2026-10-26T13:58:04Z（最后一次修改 21:58）。全日志中 `business-query-agent` 仅 **11 行**（未截断，见附录 A）。
- `/home/ubuntu/.pm2/logs/dilee-api-error.log`：**0 字节**（自 2026-09-17 起从未写入）。
- 备份目录 `/opt/dilee/app.backup-*` 下**没有 logs 目录**；`~/.pm2/logs` 无轮转文件（无 `*.log.1` 等），因此这 11 行即全部 Agent 事件。
- 全日志 `"level":"error"` 行数 = **0**；`AI_APICallError` / `APICallError` / `statusCode` / `responseBody` / `InvalidPromptError` / `InvalidToolInput` 出现次数均为 **0**。
- `deepseek` 仅出现 2 次，均为 `model_step` 行里的 `"model":"deepseek-chat"`。

三次 run 的关键原始行（`[Nest] PID - 本地时间 … LOG` 为 PM2 前缀；行内 `timestamp` 为 UTC；UTC+8 = 行内 +8 小时）：

```
# run 1（738cd66，20:59 本地）
[Nest] 573590 - 10/26/2026, 8:59:46 PM LOG {"level":"info","message":"{\"run_id\":\"97da6c85-b279-4f07-86cb-f6562ae55c51\",\"kind\":\"run_created\",\"user_id\":\"778b4d2e-29d5-4b96-aa68-bf7d120c929d\",\"access_level\":\"operational\"}","context":"business-query-agent","timestamp":"2026-10-26T12:59:46.239Z"}
[Nest] 573590 - 10/26/2026, 8:59:47 PM LOG {"level":"info","message":"{\"run_id\":\"97da6c85-b279-4f07-86cb-f6562ae55c51\",\"kind\":\"run_failed\",\"user_id\":\"778b4d2e-29d5-4b96-aa68-bf7d120c929d\",\"access_level\":\"operational\",\"error_code\":\"AGENT_MODEL_ERROR\",\"duration_ms\":1253}","context":"business-query-agent","timestamp":"2026-10-26T12:59:47.581Z"}

# run 2（7bcdb02，21:22 本地）
[Nest] 578122 - 10/26/2026, 9:22:19 PM LOG ... {"run_id":"d339bd3e-4ed8-4745-aa39-d595495d15d5","kind":"run_created",...}
[Nest] 578122 - 10/26/2026, 9:22:21 PM LOG ... {"run_id":"d339bd3e-...","kind":"model_step",...,"model":"deepseek-chat","step":1,"duration_ms":1549,"tool_calls":5}
[Nest] 578122 - 10/26/2026, 9:22:21 PM LOG ... {"run_id":"d339bd3e-...","kind":"tool_executed",...,"operation":"search_orders","status":"completed","result_rows":1,"duration_ms":33}
[Nest] 578122 - 10/26/2026, 9:22:21 PM LOG ... {"run_id":"d339bd3e-...","kind":"tool_executed",...,"operation":"search_orders","status":"failed","result_rows":0,"duration_ms":17,"error_code":"AGENT_TOOL_UNKNOWN"}
[Nest] 578122 - 10/26/2026, 9:22:21 PM LOG ... {"run_id":"d339bd3e-...","kind":"run_failed",...,"error_code":"AGENT_TOOL_UNKNOWN","duration_ms":1667}

# run 3（c5fe88e，21:49 本地）
[Nest] 579904 - 10/26/2026, 9:49:29 PM LOG ... {"run_id":"9a25d508-f1ec-48b5-bd05-f625f9394e17","kind":"run_created",...}
[Nest] 579904 - 10/26/2026, 9:49:31 PM LOG ... {"run_id":"9a25d508-...","kind":"model_step",...,"model":"deepseek-chat","step":1,"duration_ms":2046,"tool_calls":8}
[Nest] 579904 - 10/26/2026, 9:49:31 PM LOG ... {"run_id":"9a25d508-...","kind":"tool_executed",...,"operation":"get_order_overview","status":"failed","result_rows":0,"duration_ms":33,"error_code":"ORDER_NOT_FOUND"}
[Nest] 579904 - 10/26/2026, 9:49:31 PM LOG ... {"run_id":"9a25d508-...","kind":"run_failed",...,"error_code":"ORDER_NOT_FOUND","duration_ms":2184}
```

（完整 11 行、未省略字段的原文见附录 A；两次 tool_executed 的 operation 在 observability 里只记 operation，不记 tool 名，tool 名来自数据库事件，见第 4 节。）

**DeepSeek 4xx / 错误堆栈原文：未取得。** 明确理由：
- PM2 error 日志 0 字节，结构化日志里没有任何 error 级行或堆栈；
- `apps/api/src/modules/business-query-agent/model-errors.ts` 的 R-11 设计明确"模型错误只映射为稳定码，原始响应体不外传"，`mapModelError` 只从 `APICallError.responseBody` 里做上下文超限正则判断，**不打印、不落库** `responseBody`/`statusCode`；
- `agent_run_events` 的 `error` 事件只有映射后的 `{code,message}`（见第 4 节），没有 provider 原始报文；
- run 1 的错误在 SDK 本地校验阶段产生（见第 9 节），因此本来就不会有 DeepSeek HTTP 响应。

---

## 4. 数据库行级证据（`dilee_erp`，只读 SELECT）

数据库：容器 `app-postgres-1`（`postgres:16-alpine`，127.0.0.1:15432），库 `dilee_erp`；本机无原生 5432 实例。
Schema：`agent_sessions` / `agent_runs` / `agent_run_events`（`agent_runs(id, session_id, user_id, client_message_id, question, answer, access_level, state, error_code, usage jsonb, created_at, updated_at)`；`agent_run_events(id, run_id, seq, type, payload jsonb, created_at)`）。

### 4.1 `agent_runs`（3 行，全部 failed）

| id | session_id | user_id | state | error_code | created_at (UTC) | updated_at (UTC) | answer | usage |
|---|---|---|---|---|---|---|---|---|
| `97da6c85-b279-4f07-86cb-f6562ae55c51` | `54fed746-bf74-43c4-94b1-8fa60ae0da2d` | `778b4d2e-…` | failed | `AGENT_MODEL_ERROR` | 2026-10-26 12:59:46.179 | 12:59:47.564 | NULL | NULL |
| `d339bd3e-4ed8-4745-aa39-d595495d15d5` | `5c4a3f71-90d2-4309-a361-0c999b9a6cf8` | `ab724fad-…` | failed | `AGENT_TOOL_UNKNOWN` | 2026-10-26 13:22:19.522 | 13:22:21.220 | NULL | NULL |
| `9a25d508-f1ec-48b5-bd05-f625f9394e17` | `cc819662-4548-475a-b986-761eba75f191` | `0a1b9096-…` | failed | `ORDER_NOT_FOUND` | 2026-10-26 13:49:29.536 | 13:49:31.761 | NULL | NULL |

`agent_runs` 合计 **3 行**（最早 12:59:46Z，最晚 13:49:29Z）；`agent_run_events` 合计 **18 行**；`agent_sessions` 合计 **5 行**（其中 2 行属于 `laoban1`，0 run；3 行属于冒烟账号，各 1 run）。按 `(state,error_code)` 聚合：failed/AGENT_MODEL_ERROR=1、failed/AGENT_TOOL_UNKNOWN=1、failed/ORDER_NOT_FOUND=1，**没有任何 completed run**。

### 4.2 `agent_run_events`（18 行，payload 原文）

```
run 97da6c85…（738cd66）：
 seq1 state       {"state": "planning"}
 seq2 state       {"state": "failed"}
 seq3 error       {"code": "AGENT_MODEL_ERROR", "message": "模型调用失败，请稍后重试"}

run d339bd3e…（7bcdb02）：
 seq1 state       {"state": "planning"}
 seq2 state       {"state": "querying"}
 seq3 tool_status {"tool": "order_query", "status": "running", "operation": "search_orders"}
 seq4 tool_status {"tool": "order_query", "status": "completed", "operation": "search_orders"}
 seq5 source      {"as_of": "2026-10-26T13:22:21.171Z", "sources": [{"queried_at": "2026-10-26T13:22:21.157Z", "business_no": "DL260170-4H 伞头", "business_type": "sales_order"}]}
 seq6 tool_status {"tool": "procurement_query", "status": "running", "operation": "search_orders"}
 seq7 tool_status {"code": "AGENT_TOOL_UNKNOWN", "tool": "procurement_query", "status": "failed", "operation": "search_orders"}
 seq8 state       {"state": "failed"}
 seq9 error       {"code": "AGENT_TOOL_UNKNOWN", "message": "未注册的查询能力：procurement_query/search_orders"}

run 9a25d508…（c5fe88e）：
 seq1 state       {"state": "planning"}
 seq2 state       {"state": "querying"}
 seq3 tool_status {"tool": "order_query", "status": "running", "operation": "get_order_overview"}
 seq4 tool_status {"code": "ORDER_NOT_FOUND", "tool": "order_query", "status": "failed", "operation": "get_order_overview"}
 seq5 state       {"state": "failed"}
 seq6 error       {"code": "ORDER_NOT_FOUND", "message": "订单不存在"}
```

### 4.3 工具调用参数是否落库：**没有**

- `agent_run_events.payload` 里的 `tool_status` 只有 `{tool, operation, status, code?}`，**没有 `args`、没有 `input`**；
- `agent_runs` 也没有保存 tool call 参数（`answer`/`usage` 为空）；
- `observability.ts` 的事件类型按设计不含 prompt/工具参数/结果原文（R-11 脱敏靠形状），`agent-orchestrator.ts` 注释也写明"tool_status 只发名称与失败状态，不发原始参数"；
- SSE 只推同样的 tool_status 事件。

**结论：模型实际传给 `get_order_overview` 的 `order_no` 取值未持久化，无法取证具体字符串。** 但可确定它是"非空字符串但不等值"（否则错误码会是 `AGENT_TOOL_ARGUMENT_INVALID` 而不是 `ORDER_NOT_FOUND`）。数据库侧对参数取值做了边界验证：

| 查询（`sales_orders`，`deleted_at IS NULL`） | 结果 |
|---|---|
| `order_no = 'DL260170-4H 伞头'`（精确） | **1 行**（该单确实存在，`confirmed`，100 打，2026-10-26 17:45 UTC+8 创建，未软删） |
| `order_no = 'DL260170-4H'`（截断到第一个空格） | **0 行** |
| `order_no = 'DL260170-4H  伞头'`（双空格） | **0 行** |
| `order_no LIKE '%DL260170%'` | 5 行（`-1 足188T 黑银胶布` / `-27寸折叠伞` / `-2H 伞头` / `-3H 伞头` / `-4H 伞头`） |
| `order_no LIKE '%DL260170-4H%'` | **1 行** |
| `order_no LIKE '%DL260170-4H 伞头%'` | 1 行 |

即：只要模型对单号做了任何"猜测/截断/改写"，`assertOrderRoot` 的**精确匹配**就必然 404；第 2 次 run 的 `search_orders` 返回 1 行（若 `q='DL260170'` 会是 5 行），说明当时模型手里的关键字至少细到 `DL260170-4H`。第 3 次 run 的首个调用却是 `get_order_overview`（而不是 `search_orders`），这正是"没先搜索、直接猜单号"的行为。

---

## 5. 线上 dist 与仓库 HEAD / 未提交工作区的差异

### 5.1 版本关系

- 线上 `RELEASE_VERSION` = `c5fe88e01f9803dd83fc5c5711980a34604e2f97`。
- `git diff --stat c5fe88e HEAD` = **只有 1 个测试文件**（`apps/api/test/unit/agent-deepseek-provider.test.cjs`，+2 行）；`git diff --stat`（工作区）另有 4 个文件未提交：`deepseek-llm-provider.ts`（+1/-1）、3 个 web 文件（页面/CSS/布局）。
- 逐文件哈希（33 个 `apps/api/src/modules/business-query-agent/**/*.ts`，LF 归一化）：**全部 = `c5fe88e` 对象**；与工作区相比，仅 `deepseek-llm-provider.ts` 不同（工作区多了未提交的 `order_query` 描述改写）。

### 5.2 线上 dist 实测内容（`/opt/dilee/app/apps/api/dist/modules/business-query-agent/deepseek-llm-provider.js`，构建时间 21:43，进程 21:47:33 起加载）

- `order_query` 描述（dist 原文）：
  `order_query: "按单号关键字搜索销售订单，或查询某张订单的非财务进展"`
  → 与 `c5fe88e`/HEAD 一致；**不含**"先调用 search_orders…"。
- `toModelMessages` 中**存在** `JSON.stringify`：
  `input: JSON.stringify(message.args ?? {})`（`grep -c JSON.stringify` = 1）；
- `instructions` 处理存在（`grep instructions` = 3 处），即 `c5fe88e` 的"system 走 instructions"修复已在线上；
- `TOOL_CAPABILITIES` 存在（`grep` = 1），即"按工具枚举 operation"的 `c5fe88e` 修复已在线上。

### 5.3 与仓库工作区的差异点

| 项 | 线上 dist | 仓库 HEAD（1101215） | 本地工作区（未提交） |
|---|---|---|---|
| `order_query` 描述 | "按单号关键字搜索销售订单，或查询某张订单的非财务进展" | 同线上（HEAD 未改 provider） | "先调用 search_orders 搜索用户给出的单号或关键字；后续所有订单根查询只能使用搜索结果返回的精确 order_no，不能猜测或改写。…" |
| `toModelMessages` 的 `input: JSON.stringify(...)` | 有 | 有（同一文件，无差异） | 有 |
| HEAD 测试 `1101215`（21:50:58 提交） | 不适用（早于该提交） | 断言 desc 匹配 `/先调用 search_orders/` → **HEAD 代码不满足，测试红** | 满足（但未提交、未部署） |

> 即：**修复文案存在于工作区但未提交、未部署；线上仍是旧文案。** 提交 `1101215` 只是把期望写进测试（时间正好在第 3 次失败 21:49:29 之后 1.5 分钟），实现仍待提交/发布。

---

## 6. 生产 `.env` 键（只列名字与是否设置，值全部掩码）

`/opt/dilee/app/.env` 共 17 行、**15 个键**（2 行为空行）：

```
AGENT_LLM_PROVIDER=deepseek
AGENT_READ_DATABASE_URL=postgresql://***:***@127.0.0.1:15432/dilee_erp?schema=public
AGENT_STATE_DATABASE_URL=postgresql://***:***@127.0.0.1:15432/dilee_erp?schema=public
DEEPSEEK_API_KEY=***MASKED***（存在；为真实 Key 形状而非 `replace-with-...` 占位符；值未回显）
BUSINESS_QUERY_ENABLED=true
DATABASE_URL=postgresql://***:***@127.0.0.1:15432/dilee_erp?schema=public
API_PORT / WEB_PORT / COOKIE_SECURE / INITIAL_ADMIN_USERNAME / INITIAL_ADMIN_PASSWORD / INITIAL_ADMIN_DISPLAY_NAME / POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD（均存在，值掩码）
```

- 三个备份版本的 `.env` 键集合与当前**完全一致**（Agent 键在首次部署前就已配好）。
- 代码期望但 `.env` **未设置**的可选键（走默认值，不是缺陷）：`DEEPSEEK_BASE_URL`（默认官方 endpoint）、`DEEPSEEK_MODEL`（默认 `deepseek-chat`，与日志一致）、`AGENT_LLM_TIMEOUT_MS`（默认 60s）、`AGENT_RUN_TIMEOUT_MS`（默认 120s）、`AGENT_FAKE_DELAY_MS`（0）。
- 数据库角色核实（`pg_roles`）：`agent_read`（非 superuser，可登录，`information_schema.role_table_grants` 显示仅 `public` 上 **99 个 SELECT，无写权限**）、`agent_state` 均存在；即生产用的是 .env.example 设计的"只读账号 + 状态账号"分离，没有复用超级用户 `dilee`。
- `pm2-api-start.sh`/`business-query-agent.module.ts` 读取的键名与 `.env` 一致，未发现命名错配。

---

## 7. 真实失败链（结论）

### 7.1 三次 run 的逐层失败（每一次发布都在修上一次的洞，但又露出下一个洞）

**链 A — 版本 `738cd66`（第 1 次 run，20:59，`AGENT_MODEL_ERROR`）**
该版本 `deepseek-llm-provider.ts` 的 `plan()` 直接 `generateText({ messages: this.toModelMessages(messages), … })`，而 `messages` 里含 `{role:"system", content: SYSTEM_PROMPT}`。线上 `node_modules/ai@7.0.153` 的 `standardizePrompt({ allowSystemInMessages = false, … })` 明确抛：
`"System messages are not allowed in the prompt or messages fields. Use the instructions option instead."`（`InvalidPromptError`，发 HTTP 之前）。
`InvalidPromptError` 属 `AISDKError` → `mapModelError` 返回 `AGENT_MODEL_ERROR` → `failRun` → run failed。**所以第 1 次既不是 DeepSeek 4xx、也不是网络/密钥/限流问题，而是版本自带的 prompt 组装缺陷**（该缺陷在下一个部署 `7bcdb02` "send deepseek system prompt as instructions" 中修复；备份里 `7bcdb02` 的 provider 已出现 `promptFor()`/`instructions`）。
（`duration_ms:1253` 是编排器/DB 侧总耗时，SDK 校验在 provider 调用之前，不能据此推断发生过 HTTP 往返。）

**链 B — 版本 `7bcdb02`（第 2 次 run，21:22，`AGENT_TOOL_UNKNOWN`）**
该版本 provider 的 input schema 是**所有领域工具共用**的一份：
`operation: { type: "string", description: "要执行的内部查询能力，例如 search_orders" }`，没有按工具枚举 operation。
模型在 step 1 一次给出 **5 个工具调用**，把 `search_orders` 同时用到 `order_query` 和 `procurement_query`；执行器顺序执行：
1. `order_query/search_orders` 成功（1 行，`source.business_no = DL260170-4H 伞头`）——说明数据与查询能力本身可用；
2. `procurement_query/search_orders` → `toolRegistry.capability()` 查不到 → 422 `AGENT_TOOL_UNKNOWN`（"未注册的查询能力：procurement_query/search_orders"）。
`AgentOrchestrator.executeTool` 捕获后**重新抛出**，`queryPhase` → `run()` → `failRun`：整轮 failed，**同一批剩余的 3 个 tool call 直接丢弃，也没有把 "这个 operation 不存在" 回传给模型让它改**。`c5fe88e` 用"每个工具只公布自己登记的 operation 枚举"修好了这个洞。

**链 C — 版本 `c5fe88e`（第 3 次 run，21:49，`ORDER_NOT_FOUND`）——当前线上行为**
`c5fe88e` 的 `order_query` 描述仍只有一句"按单号关键字搜索销售订单，或查询某张订单的非财务进展"，既没强制"先 search_orders"，也没说明根查询必须用搜索结果里的精确 `order_no`。模型 step 1 给出 **8 个工具调用**，第一个就是 `order_query/get_order_overview`（数据库事件 seq3/seq4），传入的 `order_no` 是模型自行从问题里取的字符串；`assertOrderRoot` 对 `sales_orders.order_no` 做**精确等值**查询 + `deletedAt:null`，取不到即 404 `ORDER_NOT_FOUND`（"订单不存在"）。
数据库证明真实单号是 `DL260170-4H 伞头`（精确 1 行），`DL260170-4H` 精确 0 行，双空格 0 行 → 只要模型对单号做了截断/改写就必然 404。工具参数未落库，**具体传了什么值未取得**，但"没先搜索、直接猜单号"这一行为由"首个调用是 get_order_overview + 8 个调用只执行 1 个"共同佐证。
编排器同样在第一个工具异常时整轮 failed，**8 个 tool call 只执行了 1 个**。

### 7.2 共同的结构性放大因素（不是偶发）

1. **工具失败即整轮 failed**：`executeTool` 的 catch 里只记事件然后 `throw error`，没有"把错误作为 tool_result 回传模型 → 让模型改参数/换 operation → 再 plan"的路径；`AGENT_MAX_TOOL_STEPS=8` 的多步循环只对"成功的工具"生效。
2. **无自愈、无部分答案**：三次失败的 `answer` 全为 NULL，即使 run 2 已经拿到正确来源（`DL260170-4H 伞头`）也直接整体失败；用户侧看到的是错误气泡（"模型调用失败，请稍后重试" / "未注册的查询能力：procurement_query/search_orders" / "订单不存在"），不是"查不到/我换个问法"的可重试语义。
3. **单号精确匹配 vs 自然语言提问**：`order_no` 在业务库里本身带产品描述（`DL260170-4H 伞头`），模型很容易把 `DL260170-4H` 当单号、把 `伞头` 当产品，而根验证器只认精确值。
4. **发布节奏即修复节奏**：三次部署（738cd66 → 7bcdb02 → c5fe88e）分别对应上一条失败的修复，但每次冒烟都在下一个缺陷处失败；当前 `order_query` 描述的修复只停留在工作区，**线上仍会在同一处失败**。

---

## 8. SDK 双重编码是否在线上被触发：**否（但代码路径存在）**

- 线上 dist 的 `toModelMessages` 对工具结果消息生成 `assistant` 消息时使用
  `content: [{ type: "tool-call", toolCallId: message.id, toolName: message.tool, input: JSON.stringify(message.args ?? {}) }]`
  —— `input` 是**字符串**，而 AI SDK 的 tool-call input 应为 JSON 值；后续转 DeepSeek wire 时会被再次 `JSON.stringify`，形成 `arguments` 双重编码。
- 但**该分支只在"某轮工具全部成功 → 循环进入下一次 plan"时才会产生带 `role:"tool"` 的消息**。线上证据：3 次 run 的日志中 `model_step` 一共只有 **2 条，且 `step` 都是 1**（run 1 连 model_step 都没有）；run 2 在第 2 个工具失败、run 3 在第 1 个工具失败即中止，工具消息从未进入第二次 `plan()`。
- 结论：**双重编码在 2026-10-26 的 3 次生产 run 中未被触发**，属于"下一个成功路径才会暴露"的潜伏缺陷；一旦某次 run 的所有 tool call 都成功并进入第 2 步，就会把双重编码后的 `arguments` 发给 DeepSeek（可能 400 或工具参数解析失败）。建议与本地 SDK 格式审计的结论合并处理。

---

## 9. 未取得 / 取证边界

| 项 | 状态 |
|---|---|
| DeepSeek 4xx/5xx 原始报文、`statusCode`、`responseBody` | **未取得**（设计上不落盘；error 日志 0 字节；无 error 级日志） |
| 模型请求/响应的 wire body | **未取得**（进程内不记录；无抓包） |
| 3 次 run 的 tool call 参数（`order_no`/`q` 具体值） | **未取得**（DB/SSE/observability 均不存参数，见 4.3） |
| 备份版本运行期日志 | 备份目录无 logs；PM2 无轮转，故只有当前 11 行 Agent 事件 |
| 第 1 次 run 的 SDK 原始异常文本 | **未取得**（未落盘）；根因由"该版本源码 + `ai@7.0.153` 的 `standardizePrompt` 校验逻辑 + 下一提交的修复说明"三证交叉推出，非猜测 DeepSeek 报文 |
| 真实业务用户使用记录 | 无（3 次均为冒烟探针账号；`laoban1` 仅浏览页面） |

---

## 附录 A：`business-query-agent` 全量日志原文（11 行，去 ANSI）

```
[Nest] 573590  - 10/26/2026, 8:59:46 PM     LOG {"level":"info","message":"{\"run_id\":\"97da6c85-b279-4f07-86cb-f6562ae55c51\",\"kind\":\"run_created\",\"user_id\":\"778b4d2e-29d5-4b96-aa68-bf7d120c929d\",\"access_level\":\"operational\"}","context":"business-query-agent","timestamp":"2026-10-26T12:59:46.239Z"}
[Nest] 573590  - 10/26/2026, 8:59:47 PM     LOG {"level":"info","message":"{\"run_id\":\"97da6c85-b279-4f07-86cb-f6562ae55c51\",\"kind\":\"run_failed\",\"user_id\":\"778b4d2e-29d5-4b96-aa68-bf7d120c929d\",\"access_level\":\"operational\",\"error_code\":\"AGENT_MODEL_ERROR\",\"duration_ms\":1253}","context":"business-query-agent","timestamp":"2026-10-26T12:59:47.581Z"}
[Nest] 578122  - 10/26/2026, 9:22:19 PM     LOG {"level":"info","message":"{\"run_id\":\"d339bd3e-4ed8-4745-aa39-d595495d15d5\",\"kind\":\"run_created\",\"user_id\":\"ab724fad-28f0-4bc4-8d83-fe0f266c8238\",\"access_level\":\"operational\"}","context":"business-query-agent","timestamp":"2026-10-26T13:22:19.546Z"}
[Nest] 578122  - 10/26/2026, 9:22:21 PM     LOG {"level":"info","message":"{\"run_id\":\"d339bd3e-4ed8-4745-aa39-d595495d15d5\",\"kind\":\"model_step\",\"user_id\":\"ab724fad-28f0-4bc4-8d83-fe0f266c8238\",\"access_level\":\"operational\",\"model\":\"deepseek-chat\",\"step\":1,\"duration_ms\":1549,\"tool_calls\":5}","context":"business-query-agent","timestamp":"2026-10-26T13:22:21.122Z"}
[Nest] 578122  - 10/26/2026, 9:22:21 PM     LOG {"level":"info","message":"{\"run_id\":\"d339bd3e-4ed8-4745-aa39-d595495d15d5\",\"kind\":\"tool_executed\",\"user_id\":\"ab724fad-28f0-4bc4-8d83-fe0f266c8238\",\"access_level\":\"operational\",\"operation\":\"search_orders\",\"status\":\"completed\",\"result_rows\":1,\"duration_ms\":33}","context":"business-query-agent","timestamp":"2026-10-26T13:22:21.185Z"}
[Nest] 578122  - 10/26/2026, 9:22:21 PM     LOG {"level":"info","message":"{\"run_id\":\"d339bd3e-4ed8-4745-aa39-d595495d15d5\",\"kind\":\"tool_executed\",\"user_id\":\"ab724fad-28f0-4bc4-8d83-fe0f266c8238\",\"access_level\":\"operational\",\"operation\":\"search_orders\",\"status\":\"failed\",\"result_rows\":0,\"duration_ms\":17,\"error_code\":\"AGENT_TOOL_UNKNOWN\"}","context":"business-query-agent","timestamp":"2026-10-26T13:22:21.214Z"}
[Nest] 578122  - 10/26/2026, 9:22:21 PM     LOG {"level":"info","message":"{\"run_id\":\"d339bd3e-4ed8-4745-aa39-d595495d15d5\",\"kind\":\"run_failed\",\"user_id\":\"ab724fad-28f0-4bc4-8d83-fe0f266c8238\",\"access_level\":\"operational\",\"error_code\":\"AGENT_TOOL_UNKNOWN\",\"duration_ms\":1667}","context":"business-query-agent","timestamp":"2026-10-26T13:22:21.230Z"}
[Nest] 579904  - 10/26/2026, 9:49:29 PM     LOG {"level":"info","message":"{\"run_id\":\"9a25d508-f1ec-48b5-bd05-f625f9394e17\",\"kind\":\"run_created\",\"user_id\":\"0a1b9096-5e02-434f-a938-4d1b209223cc\",\"access_level\":\"operational\"}","context":"business-query-agent","timestamp":"2026-10-26T13:49:29.575Z"}
[Nest] 579904  - 10/26/2026, 9:49:31 PM     LOG {"level":"info","message":"{\"run_id\":\"9a25d508-f1ec-48b5-bd05-f625f9394e17\",\"kind\":\"model_step\",\"user_id\":\"0a1b9096-5e02-434f-a938-4d1b209223cc\",\"access_level\":\"operational\",\"model\":\"deepseek-chat\",\"step\":1,\"duration_ms\":2046,\"tool_calls\":8}","context":"business-query-agent","timestamp":"2026-10-26T13:49:31.645Z"}
[Nest] 579904  - 10/26/2026, 9:49:31 PM     LOG {"level":"info","message":"{\"run_id\":\"9a25d508-f1ec-48b5-bd05-f625f9394e17\",\"kind\":\"tool_executed\",\"user_id\":\"0a1b9096-5e02-434f-a938-4d1b209223cc\",\"access_level\":\"operational\",\"operation\":\"get_order_overview\",\"status\":\"failed\",\"result_rows\":0,\"duration_ms\":33,\"error_code\":\"ORDER_NOT_FOUND\"}","context":"business-query-agent","timestamp":"2026-10-26T13:49:31.752Z"}
[Nest] 579904  - 10/26/2026, 9:49:31 PM     LOG {"level":"info","message":"{\"run_id\":\"9a25d508-f1ec-48b5-bd05-f625f9394e17\",\"kind\":\"run_failed\",\"user_id\":\"0a1b9096-5e02-434f-a938-4d1b209223cc\",\"access_level\":\"operational\",\"error_code\":\"ORDER_NOT_FOUND\",\"duration_ms\":2184}","context":"business-query-agent","timestamp":"2026-10-26T13:49:31.774Z"}
```

## 附录 B：取证命令与只读证据来源

- 版本/进程：`cat /opt/dilee/app/RELEASE_VERSION`、`su - ubuntu -c 'pm2 list'`、`/home/ubuntu/.pm2/pm2.log`、`/opt/dilee/app.backup-*/RELEASE_VERSION`。
- 代码指纹：`sha256sum` + `tr -d '\r'` 归一化后，与本地 `git show <commit>:<path>` 的 SHA256 逐一比对（33 文件）。
- 日志：`grep business-query-agent /home/ubuntu/.pm2/logs/dilee-api-out.log`、`grep '"event":"http_request"'`、`grep -c` 各错误关键词；`ls -la dilee-api-error.log`（0 字节）。
- DB：`docker exec -e PGPASSWORD=$p -i app-postgres-1 psql -U $u -d dilee_erp`（用户/密码从 `.env` 读取、不回显），全部 SELECT。
- dist：`grep -o 'order_query: "…"' …/deepseek-llm-provider.js`、`grep 'JSON.stringify(message.args'`、`grep TOOL_CAPABILITIES/instructions`。
- SDK 校验原文：`/opt/dilee/app/node_modules/ai/dist/internal/index.js:1421`（`allowSystemInMessages = false`）与 `:1447`（抛 `InvalidPromptError`）、`dist/index.js:5398`（`generateText` 调用 `standardizePrompt`）。

# DeepSeek SDK 线格式实证报告（AI SDK v7 / @ai-sdk/deepseek@3.0.73）

- 任务：shared task `task-2`「Empirically capture DeepSeek SDK wire format and prove mismatches」
- 日期：2026-10-26（Asia/Singapore）
- 被测实现：`apps/api/src/modules/business-query-agent/deepseek-llm-provider.ts`（工作区版本，第 69 行）
- 结论一句话：**怀疑成立。`toModelMessages()` 里的 `input: JSON.stringify(message.args ?? {})` 让线上 `tool_calls[].function.arguments` 变成“被引号包住的 JSON 字符串”（双重编码）；DeepSeek 官方端点不会 400，但真实模型会模仿这种畸形历史、产出嵌套 `{"arguments": "..."}` 的 tool_call，随后 `plan()` 静默丢弃该调用——属于“不报错但少查/漏查”的功能性缺陷，严重度 P1（高）。最小修复是删掉这一处 `JSON.stringify`。**

---

## 0. 结论速览

| # | 结论 | 证据 |
|---|------|------|
| 1 | 第二轮及以后的 `plan` 请求、以及最终 `streamAnswer` 请求，`messages[].tool_calls[].function.arguments` 是**双重编码**的字符串 | 抓包 `captures/02-plan-after-tool.json`、`captures/03-stream-after-tool.json` |
| 2 | 首轮 `plan`（无工具历史）请求完全正常 | 抓包 `captures/01-plan-first.json` |
| 3 | `tools[].function.parameters`（JSON Schema）、`tool_choice`、`role:"tool"`（`tool_call_id` + 字符串 content）、`stream:true` 均符合契约 | 同上三份抓包 |
| 4 | 真实 `api.deepseek.com` **接受**双重编码历史（HTTP 200，不报错），因此该缺陷不会被 4xx 暴露 | `captures/06-real-api-probe.json` |
| 5 | 但在真实模型（temperature=0，生产 system prompt，3/3 次确定性）下：双重编码历史 → 模型输出 `{"arguments": "..."}`（顶层无 `operation`）；修复后 → 输出合法 `{"operation": ..., "order_no": ...}` | `captures/08-behavior-probe-real-prompt.json` |
| 6 | 顶层无 `operation` 的调用会被 `plan()` 静默丢弃（`if (!operation) continue`），导致后续工具步骤消失 | 本地 mock 证明 `captures/09-silent-drop-proof.json` |
| 7 | 修复 = 删除 `JSON.stringify(...)` 一层；已用两条链路（真实 provider + 纯 SDK）验证修复后线格式正确，且 `tsc --strict` 通过 | `captures/04-*`、`captures/05-*`、`typecheck-fix.ts` |

---

## 1. 环境与实验方法

### 1.1 版本

| 组件 | 版本 |
|------|------|
| Node.js | v24.15.0 |
| `ai` | 7.0.153 |
| `@ai-sdk/deepseek` | 3.0.73 |
| `@ai-sdk/provider` | 4.0.34 |
| `@ai-sdk/provider-utils` | 5.0.68 |
| `zod` | 4.6.7 |
| 被测 dist | 由 `npm run build --workspace=@dilee/api` 生成，`apps/api/dist/modules/business-query-agent/deepseek-llm-provider.js`（2026-10-26 21:51:52，含工作区当前 `order_query` 描述） |

说明：`apps/api` 以 CJS 编译（`require("@ai-sdk/deepseek")`），Node 24 的 `require(ESM)` 可直接加载 ESM 依赖，因此脚本可以直接 `require` 编译产物，跑的就是**真实 provider 代码**，不是复刻。

### 1.2 方法（三步，全部可复现）

1. **本地 mock 抓包**：Node `http` 起 `127.0.0.1:<随机端口>` 的 OpenAI 兼容 `/chat/completions`，记录每个请求的原始 body，返回合法 completion（非流式返回带 `tool_calls` 的 JSON，流式返回合法 SSE）。`createDeepSeek({ apiKey:"test", baseURL:"http://127.0.0.1:<port>" })` 的点对点流量全部被捕获。
2. **真实 API 探针**：把抓到的 wire body 原样（仅改 `max_tokens`/`temperature`）发到 `https://api.deepseek.com/chat/completions`，验证“接受/拒绝”与模型行为。密钥取自仓库 `.env` 的 `DEEPSEEK_KEY`（**未打印**，脚本只输出 `keyLength: 35`），请求只含 mock 订单号 `SO-2026-0001`，无业务数据。
3. **修复对照**：同一套消息，只把 `input` 由 `JSON.stringify(args)` 改为 `args` 对象，重跑抓包；另用纯 SDK `generateText` + `input` 对象做第二条独立对照。

### 1.3 场景消息（与生产链路一致）

`agent-orchestrator.ts:69-73,95` 的真实形状：

```ts
messages = [
  { role: "system", content: SYSTEM_PROMPT },
  // history（只有 user/assistant 文本，无工具消息）
  { role: "user", content: "帮我看一下订单 SO-2026-0001 现在的生产进度。" },
  // 第一轮 plan 执行工具后 push（args 是 plan() 剥掉 operation 后的剩余参数）：
  { role: "tool", id: "call_mock_1", tool: "order_query", args: { q: "SO-2026-0001" }, content: "{\"tool\":...}" },
]
```

- 场景 A：首轮 plan，`messages` 只有 system+user。
- 场景 B：第二轮 plan，`messages` 带上面的 assistant(tool_calls)+tool 对（由 `toModelMessages` 合成）。
- 场景 C：`streamAnswer`，同一份带工具历史的 `messages`（**生产链路只要有工具调用就一定会走到**）。

---

## 2. 抓包实证

### 2.1 场景 A：首轮 plan（正常）

`captures/01-plan-first.json`（Authorization 已脱敏）：

```json
{
  "method": "POST",
  "url": "/chat/completions",
  "headers": { "content-type": "application/json", "authorization": "Bearer ***REDACTED***" },
  "body": {
    "model": "deepseek-chat",
    "messages": [
      { "role": "system", "content": "你是 Dilee ERP 的订单查询助手。……" },
      { "role": "user", "content": "帮我看一下订单 SO-2026-0001 现在的生产进度。" }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "order_query",
          "description": "先调用 search_orders 搜索用户给出的单号或关键字；……",
          "parameters": {
            "type": "object",
            "properties": {
              "operation": { "type": "string", "enum": ["search_orders", "get_order_overview", "get_order_status", "get_order_timeline", "get_order_alerts", "get_order_attachments"], "description": "……" },
              "order_no": { "type": "string", "description": "……" },
              "q": { "type": "string", "description": "……" },
              "page": { "type": "number", "description": "……" }
            },
            "required": ["operation"],
            "additionalProperties": false
          }
        }
      }
    ],
    "tool_choice": "auto"
  }
}
```

要点：无历史时**没有** `tool_calls` 字段；`tools`、`tool_choice`、schema 均正常；无 `stream` 字段（`generateText` 默认非流式）。

### 2.2 场景 B：第二轮 plan（缺陷现场）

`captures/02-plan-after-tool.json` 的 `messages[2..3]`：

```json
{
  "role": "assistant",
  "content": "",
  "tool_calls": [
    {
      "id": "call_mock_1",
      "type": "function",
      "function": {
        "name": "order_query",
        "arguments": "\"{\\\"q\\\":\\\"SO-2026-0001\\\"}\""
      }
    }
  ]
},
{
  "role": "tool",
  "tool_call_id": "call_mock_1",
  "content": "{\"tool\":\"order_query\",\"operation\":\"get_order_status\",\"ok\":true,\"rows\":[{\"order_no\":\"SO-2026-0001\",\"status\":\"生产中\"}]}"
}
```

**线上真实字节**（从 `rawBody` 截取，未二次转义）：

```text
"arguments":"\"{\\\"q\\\":\\\"SO-2026-0001\\\"}\""
```

也就是说，服务端若按 OpenAI 规范做一次 `JSON.parse(arguments)`，拿到的是 **`string` 类型**（值 `{"q":"SO-2026-0001"}`），而不是对象：

```text
JSON.parse(arguments) 的 typeof === "string"     // 抓包脚本实测
```

### 2.3 场景 C：最终回答 `streamAnswer`（同样带病）

`captures/03-stream-after-tool.json`：

- body 顶层字段：`model, messages, stream, stream_options`；`stream: true`，`stream_options: { include_usage: true }`。
- `messages` 与场景 B 相同，`arguments` 同样是双重编码：

```text
"arguments":"\"{\\\"q\\\":\\\"SO-2026-0001\\\"}\""
```

即：**只要本轮执行过工具，最终回答请求的回放历史就是畸形的**（生产正常路径必然命中）。

### 2.4 修复对照（两根独立证据）

`captures/04-plan-after-tool-fixed.json`：把 `input` 改为对象后，同一条链路的线上字节：

```text
"arguments":"{\"q\":\"SO-2026-0001\"}"      →  JSON.parse 后 typeof === "object"
```

`captures/05-sdk-object-input-control.json`：不经过 provider、直接用 SDK `generateText` 传 `input` 对象，得到完全相同的单层编码——证明“传对象”才是 SDK 期望的用法，问题只在 provider 那一行。

---

## 3. 逐字段判定

| 字段（场景 B） | 抓包实测 | 判定 |
|---|---|---|
| 请求行/头 | `POST /chat/completions`，`application/json`，`Authorization: Bearer …` | ✅ 符合 |
| `model` | `"deepseek-chat"` | ✅ |
| `messages[0]` | `{"role":"system","content":...}`（来自 `instructions`） | ✅ 符合 AI SDK v7“system 只能放 instructions”的约定 |
| `messages[1]` | `{"role":"user","content":"<string>"}` | ✅ |
| `messages[2].role/content` | `"assistant"` / `""` | ✅（OpenAI 允许 tool_calls 同轮 content 为 null 或字符串） |
| `tool_calls[].id` | `"call_mock_1"`（与 tool 消息的 `tool_call_id` 一致） | ✅ |
| `tool_calls[].type` | `"function"` | ✅ |
| `tool_calls[].function.name` | `"order_query"` | ✅ |
| **`tool_calls[].function.arguments`** | **`"\"{\\\"q\\\":\\\"SO-2026-0001\\\"}\""`（JSON.parse 后是 string）** | ❌ **双重编码（P1，本报告核心缺陷）** |
| `role:"tool"` 的 `tool_call_id` | `"call_mock_1"` | ✅ |
| `role:"tool"` 的 `content` | 字符串（QueryFact JSON） | ✅ 符合规范 |
| `tools[].type / function.name / description` | `"function"` / 工具名 / 中文描述 | ✅ |
| `tools[].function.parameters` | 合法 JSON Schema：`type/properties/enum/required/additionalProperties:false` | ✅ |
| `tool_choice` | `"auto"` | ✅ |
| 非流式请求 `stream` | 字段不存在（默认 false） | ✅ |
| 流式请求 | `stream: true` + `stream_options.include_usage: true` | ✅ |
| `thinking` / `reasoning_content` | 无（`deepseek-chat` 不启用 thinking） | ✅ 与当前模型配置一致（若换 V4 需另测） |

注：`apps/api` 的 `plan()` 用的是 `generateText`（非流式），`streamAnswer` 用 `streamText`（流式），两处均实测。

---

## 4. 根因链（三处代码，均为实测确认）

1. **provider 先手工序列化了一次**（BUG 点）：
   `apps/api/src/modules/business-query-agent/deepseek-llm-provider.ts:66-70`
   ```ts
   result.push({
     role: "assistant",
     content: [{ type: "tool-call", toolCallId: message.id, toolName: message.tool, input: JSON.stringify(message.args ?? {}) }],
   } as ModelMessage);
   ```
   `message.args` 本来就是对象（`Record<string, unknown>`），被 `JSON.stringify` 成**字符串**。

2. **AI SDK v7 原样透传 `input`，不做解包**：
   `node_modules/ai/dist/index.js:1529-1535`
   ```js
   case "tool-call": return {
     type: "tool-call",
     toolCallId: part.toolCallId,
     toolName: part.toolName,
     input: part.input,          // 字符串原样带下去
     ...
   };
   ```
   `ModelMessage` 的 `ToolCallPart.input` 类型是 `unknown`，且注释明确写着 *“This is a JSON-serializable object that matches the tool's input schema”*（`node_modules/@ai-sdk/provider-utils/dist/index.d.ts:328-341`）——即“对象”，不是“JSON 文本”。

3. **DeepSeek provider 又序列化了第二次**：
   `node_modules/@ai-sdk/deepseek/src/chat/convert-to-deepseek-chat-messages.ts:330-338`
   ```ts
   case 'tool-call': {
     toolCalls.push({
       id: part.toolCallId,
       type: 'function',
       function: { name: part.toolName, arguments: JSON.stringify(part.input) },
     });
     break;
   }
   ```

`JSON.stringify(string)` → 带引号、内部转义的字符串 → 线上 `arguments` 双重编码。**provider 只需要传对象，序列化是 SDK 的职责。**

---

## 5. 真实 API 探针（关键：不是 4xx，而是行为退化）

### 5.1 接受/拒绝：HTTP 200，不会报错

`captures/06-real-api-probe.json`：把场景 B 的 body 原样（`max_tokens: 32`）发往官方端点：

| 发送的历史 arguments | HTTP | 结果 |
|---|---|---|
| `"{\"q\":\"SO-2026-0001\"}"`（双重编码） | **200** | 正常返回 completion，无 error |
| `{"q":"SO-2026-0001"}`（修复后） | 200 | 正常返回 completion |

结论：**DeepSeek 官方端点对畸形历史是宽容的，不会 400。** 因此“线上没报错”不能证明这段代码正确——缺陷是静默的。

### 5.2 行为对照：双重编码历史会“教坏”模型（temperature=0，各 3 次）

`captures/08-behavior-probe-real-prompt.json`：同一份对话，system 用生产原文（`agent-orchestrator.ts:22`），用户问题用真实问法，唯一变量是历史 arguments 的编码方式。

| 历史编码 | 3 次运行模型发出的 tool_call `arguments`（原始） | 顶层 `operation` 合法 |
|---|---|---|
| 双重编码 | `{"arguments": "{\"operation\":\"get_order_overview\",\"order_no\":\"SO-2026-0001\"}"}` | ❌ 3/3 全部非法（顶层只有 `arguments` 一个键） |
| 修复后（对象） | `{"operation": "get_order_overview", "order_no": "SO-2026-0001"}` | ✅ 3/3 全部合法 |

即：模型倾向于**复现**历史里那种“arguments 是带引号 JSON 字符串”的形状，再套一层 `arguments`。这不是“请求被拒”，而是“模型下一轮调用被污染”。（另一次默认温度的小样本探针见 `captures/07-behavior-probe.json`，同样出现嵌套 `arguments` 或非法 operation。）

### 5.3 下游后果：`plan()` 静默丢弃这些调用

`deepseek-llm-provider.ts:113-118`：

```ts
const parsed = (typeof call.input === "string" ? safeParse(call.input) : call.input) as { operation?: unknown } | null;
const operation = typeof parsed?.operation === "string" ? parsed.operation : "";
if (!operation) continue;   // 顶层没有 operation → 直接丢弃
```

`captures/09-silent-drop-proof.json`（本地 mock 直接返回两种 arguments）：

| mock 返回的 `arguments` | `provider.plan()` 结果 |
|---|---|
| `{"arguments":"{\"operation\":\"get_order_overview\",…}"}`（模型被带偏后的真实形状） | `{ "toolCalls": [] }` ← **静默丢弃** |
| `{"operation":"get_order_overview","order_no":"SO-2026-0001"}` | `toolCalls: [{ id, tool:"order_query", operation:"get_order_overview", args:{ order_no } }]` |

完整因果链：**双重编码历史 → 模型模仿 → 顶层无 `operation` → 编排器拿不到工具调用 → 循环结束 → 只带着已查到的事实去回答（少查/漏查），且观测里 `tool_calls` 数量变少，没有报错。**

---

## 6. 严重度：P1（高）

- **影响面**：任何一次 run，只要执行过 ≥1 次工具（正常业务几乎必然），第二轮 plan、第三轮 plan、以及最终 `streamAnswer` 的请求都会带畸形历史。
- **为什么不 P0**：请求被官方端点接受（200），不会 5xx/中断。
- **为什么不降级**：
  1. 协议契约确定性违约（`ToolCallPart.input` 明确要求对象；OpenAI 兼容格式要求 `arguments` 是“JSON 格式的对象序列化”）。
  2. 真实模型下行为退化 **3/3 确定性复现**，并已被证明会导致 `plan()` 静默丢调用。
  3. 该缺陷“无错误码、无日志”，只能靠抓包或结果质量发现，排查成本高。
- **额外风险**：若换成校验严格的 OpenAI 兼容网关（自建代理 / vLLM / one-api 等），双重编码 `arguments` 有较大概率被 400 拒绝；本仓库 `baseURL` 可配置，因此这是现实风险。

---

## 7. 最小修复

### 7.1 一行修复

`apps/api/src/modules/business-query-agent/deepseek-llm-provider.ts:69`：

```diff
-          content: [{ type: "tool-call", toolCallId: message.id, toolName: message.tool, input: JSON.stringify(message.args ?? {}) }],
+          content: [{ type: "tool-call", toolCallId: message.id, toolName: message.tool, input: message.args ?? {} }],
```

保留原有的 `as ModelMessage` 断言即可，其余代码**不需要改**。

### 7.2 为什么这就是正确写法

- `ToolCallPart.input: unknown`，文档注释要求“JSON-serializable object”（`@ai-sdk/provider-utils/dist/index.d.ts:328-341`）；
- AI SDK v7 原样透传（`ai/dist/index.js:1529-1535`），序列化由 provider 层负责；
- `@ai-sdk/deepseek` 已经自己做 `JSON.stringify(part.input)`（`convert-to-deepseek-chat-messages.ts:336`）——provider 再序列化一次就多了一层。

### 7.3 已验证

| 验证项 | 结果 |
|---|---|
| 修复后真实 provider 抓包（`captures/04-plan-after-tool-fixed.json`） | `"arguments":"{\"q\":\"SO-2026-0001\"}"`，`JSON.parse` 为 object ✅ |
| 纯 SDK `input` 对象对照（`captures/05-sdk-object-input-control.json`） | 与 04 完全一致 ✅ |
| 修复代码片段 `tsc --noEmit --strict`（`typecheck-fix.ts`） | exit 0 ✅ |
| 真实模型行为（`captures/08-…`） | 修复后 3/3 产出合法 `operation` ✅ |

### 7.4 建议补的回归测试（owner 执行；本任务不改源码）

用本地 mock `fetch` 捕获 body，断言：

```ts
const sent = capturedRequest.messages.find((m) => m.tool_calls);
const args = sent.tool_calls[0].function.arguments;
assert.equal(typeof args, "string");            // 线上本就是字符串
assert.equal(typeof JSON.parse(args), "object"); // 关键：解析后必须是对象
assert.equal(JSON.parse(args).operation ?? JSON.parse(args).q, ...); // 且能拿到参数
// 或直接断言不是双重编码：assert.ok(!args.startsWith('"'));
```

---

## 8. 次要发现（不在本任务修复范围）

1. **P2/P3：回放的 assistant tool_call 丢了 `operation` 字段。**
   `plan()` 在 `deepseek-llm-provider.ts:118-119` 把 `operation` 从 args 剥掉，orchestrator 在 `agent-orchestrator.ts:95` 只把剩余 args 放进 tool 消息，于是下一轮回放给模型的 assistant tool_call 是 `{"q":"…"}`，而模型当初发的是 `{"operation":"search_orders","q":"…"}`。
   实测证据：修复双重编码后（`captures/08-…` 的 fixed 组），模型仍能正常产出合法 `operation`（3/3），所以这是**保真度**问题而非阻断性问题；但严格说历史回放与真实调用不一致。
   可选修法（需 owner 拍板，仅影响回放、不进入 executor）：`agent-orchestrator.ts:95` 改为
   `args: { operation: call.operation, ...call.args }`。
2. **P3：一条 tool 结果单独合成一条 `assistant(tool_calls)` 消息。** 同一轮多个工具结果会生成多条 assistant 消息，OpenAI 格式允许，但不如“一条 assistant 带多个 tool_calls”贴近原始对话。非必须修。
3. **观测盲区**：畸形历史导致 `plan()` 丢调用时，`observability` 里只表现为 `tool_calls: 0`，无法与“模型本来就不需要工具”区分；建议修复后仍保留一条 wire 断言测试。

---

## 9. 复现命令与工件清单

在仓库根目录执行（脚本不修改源码）：

```powershell
# 1) 本地 mock 抓包：生成 captures/01..05 与 summary.json
node docs/review/agent-sdk-wire-proof-2026-10-26/capture-wire.mjs

# 2) 真实 API 接受/拒绝探针：生成 captures/06（读 .env 的 DEEPSEEK_KEY，不打印）
node docs/review/agent-sdk-wire-proof-2026-10-26/probe-real-api.mjs

# 3) 真实模型行为对照（各 3 次，temperature=0）：生成 captures/07、08
node docs/review/agent-sdk-wire-proof-2026-10-26/probe-behavior.mjs
node docs/review/agent-sdk-wire-proof-2026-10-26/probe-behavior-real-prompt.mjs

# 4) 下游静默丢弃证明：生成 captures/09
node docs/review/agent-sdk-wire-proof-2026-10-26/prove-silent-drop.mjs
```

| 文件 | 内容 |
|---|---|
| `captures/01-plan-first.json` | 首轮 plan 的完整 wire body（正常对照） |
| `captures/02-plan-after-tool.json` | 第二轮 plan，**双重编码缺陷现场** |
| `captures/03-stream-after-tool.json` | 最终回答 `streamText`，`stream:true`，同样双重编码 |
| `captures/04-plan-after-tool-fixed.json` | 修复后第二轮 plan（单层编码） |
| `captures/05-sdk-object-input-control.json` | 纯 SDK `input` 对象对照 |
| `captures/06-real-api-probe.json` | 官方 API 接受/拒绝（两种均 200） |
| `captures/07-behavior-probe.json` | 默认温度小样本行为对照 |
| `captures/08-behavior-probe-real-prompt.json` | 生产 prompt、temperature=0、3/3 确定性行为对照 |
| `captures/09-silent-drop-proof.json` | `plan()` 静默丢弃嵌套 arguments 的本地证明 |
| `captures/summary.json` | 抓包汇总（各场景 wire arguments 摘录） |
| `capture-wire.mjs` / `probe-*.mjs` / `prove-silent-drop.mjs` / `extract-snippets.mjs` | 全部可重跑脚本 |
| `typecheck-fix.ts` | 最小修复片段的 `tsc --strict` 通过证明 |

脱敏说明：所有抓包与探针输出中的 `Authorization` 均为 `Bearer ***REDACTED***`，`.env` 密钥从未读取到变量以外、从未打印；请求内容仅含 mock 订单号 `SO-2026-0001` 与“生产中”，无真实业务数据。

---

## 10. 局限与未验证项

- 真实模型返回的 `model` 字段是 `deepseek-flash`（账号/端点把 `deepseek-chat` 路由到 flash），行为结论基于该端点；换模型/换供应商可能不同。
- 行为对照是单场景、temperature=0、每变体 3 次；足以证明“畸形历史会污染下一轮调用”的机理与方向，但不是跨 prompt 的统计结论。
- 未测试严格校验的第三方 OpenAI 兼容网关是否会 400；也未做修复后的真实业务 e2e（需要数据库与业务账号，超出本任务范围）。
- 抓包用的是 `apps/api/dist`（2026-10-26 21:51 构建）。工作区 `src` 相对 HEAD 只差 `order_query` 描述字符串一处非本次相关改动，dist 与工作区 `src` 在该函数上一致（`input: JSON.stringify(message.args ?? {})`）。

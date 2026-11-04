# AI SDK v7 参数/消息格式一致性审计（DeepSeek provider）

- 审计对象：`apps/api/src/modules/business-query-agent/deepseek-llm-provider.ts`（151 行，下称 `provider.ts`）
- 审计问题（用户原话）：「SDK 支持的参数格式是否和当前的参数格式不一致?」
- 环境：`ai@7.0.153`、`@ai-sdk/deepseek@3.0.73`、`@ai-sdk/provider@4.0.34`、`@ai-sdk/provider-utils@5.0.68`、Node v24.15.0、Windows
- 方法：读安装包源码/类型（唯一权威）→ 本地 mock fetch 抓「真实 SDK 生成的请求 body」（不联网）→ `tsc --noEmit` → 交叉引用同轮 `wire-prover` 的抓包与真实 API 探针产物
- 约束声明：本次审计**未修改任何源码、未部署、未重启服务**；仓库内唯一写入文件即本文件；本文不含任何 API key。

---

## 0. 结论（先给答案）

**不完全一致。** 要分三层看，不能一句话概括：

| 层 | 是否一致 | 说明 |
|---|---|---|
| ① 调用参数/选项层：`generateText` / `streamText` 的顶层选项（`model`、`instructions`、`messages`、`tools`、`toolChoice`、`stopWhen`、`abortSignal`） | **一致 ✅** | 每个选项都存在于 v7 类型与实现中，语义也正确；`instructions`（而非 `system`）正是 v7 主推写法 |
| ② 消息内容格式层：`ModelMessage` 的 part 形状 | **不一致 ❌（1 处硬伤 + 1 处语义硬伤）** | 硬伤 A：assistant `tool-call` part 的 `input` 被传入 **JSON 字符串**，而 v7 契约要求「JSON 可序列化**对象**」；NDJSON 链路上 DeepSeek provider 会再 `JSON.stringify` 一次 → **双重编码**。硬伤 B：合成历史里的 tool-call **丢掉了 `operation`**，历史与它自己的工具 schema（`required:["operation"]`）自相矛盾 |
| ③ 行为层：usage 字段、`textStream`、abort/超时映射 | **一致 ✅** | `usage.inputTokens/outputTokens`、`textStream`、`StreamTextResult.usage` Promise 语义均按 v7 用法；abort/超时最终抛 `TimeoutError`/`AbortError`，`mapModelError` 能正确映射 |

- **主问题严重度：高**（格式违规是确定的、不是猜测；且实测会把模型的下一轮工具调用参数「带歪」，服务端却回 200，属**静默正确性风险**，不是崩溃型）。
- **次问题严重度：中低**（不违反 SDK API 契约，但多轮历史不自洽，建议同轮修掉）。
- 其余项无风险。**类型检查抓不到这两个问题**（`input: unknown` + `as ModelMessage` 断言），`npm run typecheck --workspace=@dilee/api` 当前 **EXIT=0**（见 §1.4），所以「typecheck 过了」不能作为格式正确的证据。

---

## 1. 审计方法与可复现证据

### 1.1 版本与安装路径（实测读取 package.json）

| 包 | 版本 |
|---|---|
| ai | 7.0.153 |
| @ai-sdk/deepseek | 3.0.73 |
| @ai-sdk/provider | 4.0.34 |
| @ai-sdk/provider-utils | 5.0.68 |

### 1.2 静态证据：逐行对照安装包实现与类型

- `node_modules/ai/dist/index.js`：`convertToLanguageModelPrompt`（L1398）、`convertToLanguageModelMessage`（L1447）、assistant `tool-call` 转换（L1529-1536）、Zod schema（L2245-2252）、`standardizePrompt`（L2433-2476）
- `node_modules/@ai-sdk/deepseek/dist/index.js`：`convertToDeepSeekChatMessages`（L145）、assistant 转换（L278-318）、tool 转换（L320-394）、`prepareTools`（L534-597）、`getArgs`（L719-821）、`doGenerate`（L822-883）、`doStream`（L884 起）
- `node_modules/@ai-sdk/provider/dist/index.d.ts`：`LanguageModelV4ToolCall`（L563-593，**响应侧** `input: string` L578）、`LanguageModelV4ToolCallPart`（L1258-1283，**提示侧** `input: unknown` L1271）
- `node_modules/@ai-sdk/provider-utils/dist/index.d.ts`：`ToolCallPart`（L328-352，注释 L339「JSON-serializable object」、`input: unknown` L341）、`ToolResultPart`（L356-376）、`Tool` 的 `inputSchema`（L2152）、`tool()`（L2332）、`jsonSchema`（L880）

### 1.3 动态证据（本次自做，可复现）：本地 mock fetch 抓「真实 SDK 请求 body」

不联网：用 `createDeepSeek({ apiKey:"probe-key", baseURL:"http://127.0.0.1:9", fetch: stubFetch })` 注入 stub fetch，真实走 `ai` + `@ai-sdk/deepseek` 的完整转换链路，抓 `init.body` 后返回伪造的 DeepSeek 响应。脚本通过 `node --input-type=module -` 从 stdin 运行，**未写入仓库**（核心片段见附录 A）。这一步证明的是「SDK 实际会发出去的字节」，不是文档推断。

### 1.4 类型检查（只读命令）

```
> npm run typecheck --workspace=@dilee/api
> tsc --noEmit
EXIT=0
```

结论：**即使存在本文的两处格式问题，类型检查也通过**。原因：`ModelMessage` 的 tool-call part `input` 类型是 `unknown`，传字符串合法；而 `provider.ts:70` 与 `:80` 上的 `as ModelMessage` 断言又把形状差异掩盖掉。

### 1.5 交叉证据（同轮 `wire-prover` 产物，非本次编写）

`docs/review/agent-sdk-wire-proof-2026-10-26/captures/` 下有同轮抓包与真实 API 探针，本文只在「服务端真实反应」处引用，并标注证据等级：

- `02-plan-after-tool.json:28`（当前实现 → 双重编码）
- `03-stream-after-tool.json:28`、`:39-42`（streamAnswer 路径；注意该请求**没有** `tools` 字段）
- `04-plan-after-tool-fixed.json:28`（改为对象后 → 单层编码）
- `05-sdk-object-input-control.json`（AI SDK 自己生成的 assistant tool-call part 是对象）
- `06-real-api-probe.json:4-5,20,36`（**真实 `api.deepseek.com` 探针**，n=1，见 §3.4）

---

## 2. 逐项对照总表

> 证据列 `provider.ts:NN` 指仓库源码；`ai/js:NN` 指 `node_modules/ai/dist/index.js`；`ds/js:NN` 指 `node_modules/@ai-sdk/deepseek/dist/index.js`；`provider.d.ts:NN` 指 `node_modules/@ai-sdk/provider/dist/index.d.ts`；`pu.d.ts:NN` 指 `node_modules/@ai-sdk/provider-utils/dist/index.d.ts`。判定「✅」= 与 v7 一致；「⚠️」= 不一致（本文主问题）；「△」= 非 SDK 契约问题但值得修。

### A. 调用参数层（全部一致）

| # | 项目 | v7 期望 | 当前代码 | 证据 | 判定 |
|---|---|---|---|---|---|
| A1 | `generateText` 选项集 | 接受 `model/instructions/messages/tools/toolChoice/stopWhen/abortSignal` | 全部按名传入 | `provider.ts:104-111`；`ai/js:5348` 形参表 | ✅ |
| A2 | `streamText` 选项集 | 接受 `model/instructions/messages/abortSignal` | 全部按名传入 | `provider.ts:129-133`；`ai/js:8882` 形参表 | ✅ |
| A3 | `instructions` vs `system` | v7 以 `instructions` 为主，`system` 标 `@deprecated` | 用 `instructions`，且系统消息被抽出合并（`join("\n\n")`） | `provider.ts:88-92`；`ai/dist/index.d.ts:862-868`（`system?: Instructions` 上的 `@deprecated Use instructions instead.`）；CHANGELOG「feat(ai): add `instructions` as the primary prompt option and deprecate `system`」(`node_modules/ai/CHANGELOG.md:1722`) | ✅ |
| A4 | `messages` 中禁止 `system` | `allowSystemInMessages` 默认 false，出现 system 直接抛 `InvalidPromptError` | `promptFor` 先滤掉所有 `role:"system"` 再进 `messages` | `provider.ts:91`；`ai/js:2459-2462` | ✅ |
| A5 | 工具定义 `tool({description,inputSchema})` | v7 字段名为 `inputSchema: FlexibleSchema<INPUT>`（必填），无 `parameters` | 用 `inputSchema` | `provider.ts:97`；`pu.d.ts:2152`、`tool()` 签名 `pu.d.ts:2332`；CHANGELOG 迁移记录 `node_modules/ai/CHANGELOG.md`「rename continueUntil to stopWhen / maxSteps→isStepCount」(L6330) 时代起的 v5 系列 API | ✅ |
| A6 | `jsonSchema<T>()` | `jsonSchema<OBJECT>(JSONSchema7)` | `jsonSchema<{operation:string;...}>({type:"object",...})` | `provider.ts:32-42`；`pu.d.ts:880` | ✅ |
| A7 | `toolChoice` | `'auto' \| 'none' \| 'required' \| {type:'tool',toolName}`，默认 `auto` | 传 `"auto"` | `provider.ts:108`；`ai/dist/index.d.ts:153`；实测 wire `tool_choice:"auto"` | ✅ |
| A8 | `stopWhen` / `stepCountIs(1)` | `stepCountIs` 是 `isStepCount` 导出别名，非弃用；`generateText` 默认值就是 `isStepCount(1)` | 显式 `stepCountIs(1)` | `provider.ts:109`；`ai/dist/index.d.ts:3308`、`:3817`、`:5374`；`ai/js:5348`（`stopWhen = isStepCount(1)` 默认） | ✅（冗余但正确） |
| A9 | `abortSignal` | `RequestOptions.abortSignal?: AbortSignal` | `AbortSignal.any([signal, AbortSignal.timeout(ms)])` | `provider.ts:58-60,110,132`；`ai/dist/index.d.ts:826-831`（RequestOptions）；实测见 §7.2 | ✅ |
| A10 | `usage` 字段名 | `LanguageModelUsage.inputTokens/outputTokens`（`number \| undefined`），旧名 `promptTokens/completionTokens` 已不用 | 读 `usage.inputTokens/outputTokens` | `provider.ts:137-138`；`ai/dist/index.d.ts:344-348`；`ai/js:2499-2514`；实测 stream usage→`input_tokens:42, output_tokens:7` | ✅ |
| A11 | `textStream` / `usage` 形态 | `readonly textStream: AsyncIterableStream<string>`；`readonly usage: PromiseLike<LanguageModelUsage>` | 先 `for await (const delta of result.textStream)`，后 `await result.usage` | `provider.ts:134-138`；`ai/dist/index.d.ts:2846`、`:2912`；实测见 §7.2 | ✅ |

### B. 消息内容格式层（发现问题）

| # | 项目 | v7 期望 | 当前代码 | 证据 | 判定 |
|---|---|---|---|---|---|
| B1 | assistant `tool-call` part 的 `input` | **「JSON 可序列化对象」**，例如 `{operation:"search_orders"}`；provider 负责序列化成 wire 上的 `arguments` **字符串** | 传 `JSON.stringify(message.args ?? {})` → 字符串 | 期望：`pu.d.ts:328-352`（L339 注释、L341 `input: unknown`）、`provider.d.ts:1258-1283`（L1269-1270 注释、L1271 `input: unknown`）；当前：`provider.ts:69`；`ai/js:1529-1536` 原样透传（L1533 `input: part.input`）；`ai/js:2249` 仅 `z.unknown()` 校验；`ds/js:301-308`（L306 `arguments: JSON.stringify(part.input)`） | **⚠️ 不一致（主问题）** |
| B2 | `tool-result` 的 `output: {type:"json", value}` | 合法枚举，`value` 为 `JSONValue` | `{type:"json", value: parsed}` | `provider.ts:79`；`pu.d.ts:390-396`（json + JSONValue）；`ai/js:2256-2266`；DeepSeek 侧转成 `contentValue = JSON.stringify(output.value)`（`ds/js:337-340`），wire 实测 `content:"{\"ok\":true,...}"` | ✅ |
| B3 | 合成 assistant 消息 `content` | `content` 允许字符串（空串亦可）或 parts 数组 | 合成时只有 tool-call part，DeepSeek 侧落成 `content:""` | `provider.ts:67-70`；`ds/js:310-318`；wire 实测 `"content":""` + `tool_calls` | ✅（合法，见 §7.4 备注） |
| B4 | `tool` 消息字段 | `role:"tool"`、`toolCallId`、`toolName`、`output` | 全部给出；多次结果被合并成一条 tool 消息 | `provider.ts:77-80`；`ai/js:1556-1584`；`ds/js:388-392` 落成 `{role:"tool",tool_call_id,content}` | ✅ |
| B5 | tool-call / tool-result 配对 | 每个 assistant tool-call 必须有对应 tool-result，否则 `MissingToolResultsError` | 逐条成对插入，顺序为 assistant→tool，满足约束 | `provider.ts:63-86`；`ai/js:1426-1438`；实测两轮 plan 均通过 | ✅ |
| B6 | 历史 tool-call 的语义完整性 | 合成的 assistant 调用应等于模型当初的调用（含 `operation`） | `plan()` 把 `operation` 拆出后只保存 `rest` 进 `args`；重建时用 `args` → **历史缺 `operation`** | `provider.ts:115-119`（L118 `const { operation: _omitted, ...rest }`，L119 `args: rest`）；`llm-provider.ts:15`（tool 消息变体无 `operation` 字段）；`agent-orchestrator.ts:95`（只传 `args`）；`provider.ts:69`（用 `args` 重建） | **△ 语义不一致（次问题，建议同轮修）** |

### C. 行为层（一致，含两个「不是不一致但要知道」的点）

| # | 项目 | v7 行为 | 当前代码 | 证据 | 判定 |
|---|---|---|---|---|---|
| C1 | 超时/中断的异常身份 | abort/超时最终以 `DOMException`（`name:"TimeoutError"` / `"AbortError"`）冒泡；`streamText` 的 abort 不会从 `textStream` 抛，而是在后续 `await result.usage` reject | `mapModelError` 按 `error.name` 命中 `TimeoutError/AbortError` → `AGENT_MODEL_TIMEOUT` | 探针实测 §7.2；`agent-orchestrator.ts:111-120`、`provider.ts:137-138`；`model-errors.ts:21-24` | ✅（见 §7.2 顺序依赖） |
| C2 | 测试能否发现 B1 | 应能断言 assistant tool-call part 的 `input` 是对象 | 现有单测用 `MockLanguageModelV4`，只断言 prompt JSON 串里「有 tool-call / 有 SO-001」 | `apps/api/test/unit/agent-deepseek-provider.test.cjs:8`（MockLanguageModelV4）、`:18`（`modelOverride` 绕过真实 DeepSeek provider）、`:145-164`（断言太弱） | 覆盖盲区（非不一致） |

---

## 3. 主问题详解：assistant tool-call 的 `input` 被双重编码

### 3.1 契约层：两个 `input` 不是同一个东西，方向相反

v7 在同一套类型里对 `input` 有两个方向相反的约定，这是最容易被误读的地方：

1. **模型 → SDK（响应侧）**：`LanguageModelV4ToolCall.input` 是 **JSON 字符串**
   - `provider.d.ts:563-593`，其中 `:574` 注释「JSON-encoded tool input. Must match the input schema of the tool. String inputs must also be JSON-encoded.」、`:578` `input: string;`
   - DeepSeek 实现如实回传字符串：`ds/js:847-852`（`:851` `input: toolCall.function.arguments`）；SDK 再解析成对象（`parseToolCall`，`ai/js:4078` 起），因此 `result.toolCalls[n].input` 是**对象**（`ai/dist/index.d.ts:1327-1336` `StaticToolCall.input = InferToolInput<...>`；`ai/js` 生成结果对象；本审计实测见 §3.3 的 `typeof call.input = object`）。
2. **SDK → 模型（提示侧，即仓库这里）**：`ModelMessage` 的 `ToolCallPart.input` 是 **对象**
   - `pu.d.ts:328-352`，其中 `:339` 注释「Arguments of the tool call. This is a JSON-serializable object that matches the tool's input schema.」、`:341` `input: unknown;`
   - provider 层对应类型同样写对象：`provider.d.ts:1258-1283`（`:1269-1270` 注释、`:1271` `input: unknown;`）
   - 序列化成 wire 字符串是**provider 的职责**：DeepSeek 在 `ds/js:301-308` 做 `arguments: JSON.stringify(part.input)`。

所以仓库 `provider.ts:69` 传 `JSON.stringify(...)` 给提示侧，等于把「已经是字符串的输入」当成对象交给 provider 再 stringify 一次。

### 3.2 完整链路上没有任何一层会纠正它（4 步证据）

1. 仓库生成字符串：`provider.ts:69` `input: JSON.stringify(message.args ?? {})`；`:70` 用 `as ModelMessage` 断言压掉类型差异。
2. `ai` 的 prompt 转换原样透传，不解析、不归一化：`ai/js:1529-1536`，`:1533` `input: part.input`。
3. `ai` 的运行时校验允许任意值：`ai/js:2245-2252` 的 `toolCallPartSchema`，`:2249` `input: z.unknown()` —— 字符串通过，**不告警**。
4. DeepSeek provider 再做一次序列化：`ds/js:301-308`，`:306` `arguments: JSON.stringify(part.input)`。

结论：**没有任何一层做 JSON 解析或类型归一化**，字符串会被再包一层引号/转义发出去。这不是「可能」——§3.3 是抓到的真实请求 body。

### 3.3 实测：同一场景，改动一行前后的 wire 字节（本地 mock，确定性）

构造与 `provider.ts` 完全同构的消息（`order_query` 调用 + 工具结果），调用真实 `generateText`（`instructions` + `messages` + `tools` + `toolChoice:"auto"` + `stopWhen:stepCountIs(1)`），抓请求 body：

**当前实现（`input: JSON.stringify({operation,q})`）→ 双重编码：**

```json
{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"order_query","arguments":"\"{\\\"operation\\\":\\\"search_orders\\\",\\\"order_no\\\":\\\"PO-2026-001\\\"}\""}}]}
```

- `arguments` 的 JSON 值 = `"\"{\\\"operation\\\"...}\""`
- 对它做一次 `JSON.parse` 的结果是**字符串** `"{\"operation\":\"search_orders\",...}"`（还带着外层引号），**不是参数对象**。

**符合契约（`input: {operation,q}` 对象）→ 单层编码：**

```json
{"role":"assistant","content":"","tool_calls":[{"id":"call_1","type":"function","function":{"name":"order_query","arguments":"{\"operation\":\"search_orders\",\"order_no\":\"PO-2026-001\"}"}}]}
```

- `JSON.parse(arguments)` = `{"operation":"search_orders","order_no":"PO-2026-001"}`（参数对象，符合 DeepSeek/OpenAI 协议对该字段的定义）。

同一次探针里还确认了：`streamText` 路径（`streamAnswer` 用的就是它）**同样**双重编码，见 §7.1；且 `result.toolCalls[n].input` 的类型是 `object`（响应侧已解析），所以 `provider.ts:115` 那个 `typeof call.input === "string" ? safeParse(...) : call.input` 分支只在「模型输出非法 JSON、走 `parseToolCall` 容错分支」时才用得上，正常调用走对象分支。

### 3.4 服务端真实反应（证据等级：外部实测，n=1，需注意样本局限）

同轮 `wire-prover` 把 `02`（双重编码）与 `04`（改对象后）的 body 原样发往 `https://api.deepseek.com/chat/completions`（`max_tokens:32`），结果见 `docs/review/agent-sdk-wire-proof-2026-10-26/captures/06-real-api-probe.json`：

| 历史里的 `arguments` | HTTP | 模型返回的工具调用参数 |
|---|---|---|
| 双重编码 `"\"{\\\"q\\\":\\\"SO-2026-0001\\\"}\""`（`:4`） | **200** | `{"arguments": "\"{\\\"operation\\\"...` —— 模型把参数又包了一层 `arguments` 字符串（`:20`） |
| 正常单层 `{"q":"SO-2026-0001"}`（`:5`） | **200** | `{"operation": "get_order_overview"` —— 结构正常（`:36`） |

**判读（重要）：**

- **服务端不会 400 拒绝**——它只要求 `arguments` 是字符串，不校验其内容是否可再解析。这意味着问题是**静默的**，不会进错误码，也不会被 `mapModelError` 抓到。
- 双重编码会让模型在下一轮把「参数」写成 `{"arguments":"<字符串>"}` 这类**多包一层的结构**。对仓库而言具体后果是：`plan()` 里 `parsed.operation` 取不到（`provider.ts:115-117`）→ 该调用被 `continue` 丢弃 → 本轮 `toolCalls` 为空 → 编排器 `agent-orchestrator.ts:99-101` 结束查询循环 → 最终回答缺少事实支撑。
- 样本局限：n=1、模型非确定、`max_tokens:32` 截断。**建议由 `wire-prover` 做 20 次重复对比（双重 vs 修复）统计「有效 tool call 率 / 参数结构正确率 / 答案正确率」**，但格式违规本身已由 §3.3 的确定性抓包证明，不依赖这个统计。

### 3.5 影响面（哪些 run 会被污染）

| 场景 | 是否受影响 | 原因 |
|---|---|---|
| 第一次 `plan()`（历史里还没有 tool 消息） | 否 | `toModelMessages` 只对 `role:"tool"` 合成 tool-call |
| 第 2 次及以后 `plan()`（每查到一次事实后） | **是** | 每个 tool 消息对都带双重编码的 `arguments` |
| `streamAnswer()`（只要本轮执行过工具） | **是** | 同一份 `messages` 直接进 `streamText`；实测见 §7.1 |
| 直接作答、零工具调用的 run | 否 | 没有 tool 消息 |
| `FakeLlmProvider`（无密钥环境） | 否 | 不经过 AI SDK |

即：**所有「多轮查询」的主路径都会带上这个畸形历史**，这正是该功能的主要工作方式。

### 3.6 严重度评级

**高。** 理由：① 与安装包的类型契约直接冲突（对象 vs 字符串不是一个风格问题）；② 静默——HTTP 200、无警告、typecheck 通过、日志无异常；③ 命中主路径（多轮查询）；④ 已在真实 DeepSeek API 上观察到模型行为被带歪（n=1，方向明确）。尚不至于「必然请求失败」，所以定级高而不是最高。

---

## 4. 次问题详解：合成历史丢掉了 `operation`

- 模型当初的真实调用是 `order_query({operation:"search_orders", q:"SO-2026-0001"})`；`toModelMessages` 重建时必须**还原同样的输入**。
- 现状：`provider.ts:118-119` 把 `operation` 从参数里拆出来（供编排器用），只把 `rest` 存入 `args`；`llm-provider.ts:15` 的 tool 消息变体没有 `operation` 字段；`agent-orchestrator.ts:95` 只把 `args` 写回消息；于是 `provider.ts:69` 重建出的历史是 `{q:"SO-2026-0001"}`——**缺少工具 schema 的必填字段**（`provider.ts:40` `required: ["operation"]`）。
- wire 侧可见：`docs/review/agent-sdk-wire-proof-2026-10-26/captures/02-plan-after-tool.json:28` `arguments` 只有 `{"q":"SO-2026-0001"}`；而 AI SDK 自己生成的 tool-call part 是带 `operation` 的对象（`05-sdk-object-input-control.json`，或 `summary.json:144-147`）——说明「SDK 原生形态」与「仓库合成形态」不一致。
- 影响：模型看到「自己上一次调用不符合它自己的 schema」，多轮时可能重复调用、补齐参数或降低遵循度；它也让工具的「调用历史」与「结果」失去可追溯的一致性（结果对应 `get_order_status`，但历史参数看不出这点）。
- 严重度：**中低**（不违反 SDK API 契约，不必然报错；真实探针的 fixed 场景仍能正常出参数）。属「同一轮应该顺手修掉」的正确性问题。

---

## 5. 修复建议（精确到行）

> 审计任务只允许写本文件，因此以下为**建议改动**，由 source owner / chain-reviewer 执行。两处建议一起做，`toModelMessages` 只改一次即可覆盖。

### 5.1 主修复：`input` 传对象，不传 JSON 字符串

```ts
// apps/api/src/modules/business-query-agent/deepseek-llm-provider.ts:63-70（建议）
private toModelMessages(messages: AgentLlmMessage[]): ModelMessage[] {
  const result: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      // v7 契约（@ai-sdk/provider LanguageModelV4ToolCallPart.input / provider-utils ToolCallPart.input）：
      // input 是「JSON 可序列化对象」，provider 自己会 JSON.stringify 成 wire 上的 arguments 字符串。
      // 因此这里绝不能先 JSON.stringify。
      const input = { operation: message.operation, ...(message.args ?? {}) };
      result.push({
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: message.id, toolName: message.tool, input }],
      });
      // ↓ tool-result 部分保持现状（type:"json" 是正确的）
      // ...
```

最小热修（若不想动 `AgentLlmMessage` 类型，可先只做这一行；`operation` 缺失按 §5.2）：

```diff
-        content: [{ type: "tool-call", toolCallId: message.id, toolName: message.tool, input: JSON.stringify(message.args ?? {}) }],
+        content: [{ type: "tool-call", toolCallId: message.id, toolName: message.tool, input: message.args ?? {} }],
```

顺带建议：主修复完成后删除 `:70`、`:80` 的 `as ModelMessage` 断言（用 `satisfies AssistantModelMessage` / `satisfies ToolModelMessage` 或直接让 TS 推导），否则将来同类形状错误仍会被断言静默吞掉。

### 5.2 次修复：把 `operation` 带回历史（跨 3 个文件的字段扩展）

```ts
// llm-provider.ts:15
-  | { role: "tool"; id: string; tool: AgentToolName; args: Record<string, unknown>; content: string };
+  | { role: "tool"; id: string; tool: AgentToolName; operation: string; args: Record<string, unknown>; content: string };
```

```ts
// agent-orchestrator.ts:95
- messages.push({ role: "tool", id: call.id, tool: call.tool, args: call.args, content: JSON.stringify(fact) });
+ messages.push({ role: "tool", id: call.id, tool: call.tool, operation: call.operation, args: call.args, content: JSON.stringify(fact) });
```

（`plan()` 已经知道 `call.operation`，`provider.ts:119` 的 `toolCalls.push({operation, args: rest})` 无需改。）

### 5.3 测试补强（让回归能抓到这个 bug）

现有单测抓不到（见 §2 C2）。建议在 `apps/api/test/unit/agent-deepseek-provider.test.cjs` 增加/改造断言：

```js
// 断言 1：交给模型的 assistant tool-call part.input 必须是对象，且完整包含 operation
const prompt = model.doGenerateCalls[0].prompt;
const assistant = prompt.find((m) => m.role === "assistant");
const part = assistant.content.find((p) => p.type === "tool-call");
assert.equal(typeof part.input, "object", "tool-call input 必须是对象，不能是 JSON 字符串");
assert.deepEqual(part.input, { operation: "search_orders", q: "SO-2026-0001" });
```

```js
// 断言 2（wire 级，真 provider + stub fetch）：抓 body 后只解析一次 arguments
const args = JSON.parse(body.messages.find((m) => m.role === "assistant").tool_calls[0].function.arguments);
assert.equal(typeof args, "object");              // 不是 string
assert.equal(args.operation, "search_orders");
```

### 5.4 修复后的一次性验证

```powershell
npm run typecheck --workspace=@dilee/api   # 期望仍 EXIT=0
npm run build --workspace=@dilee/api
node --test apps/api/test/unit/agent-deepseek-provider.test.cjs
# 另用附录 A 的抓包脚本复跑：wire arguments 应为 {"operation":...} 单层 JSON
```

---

## 6. 已确认正确的项（无需改）

1. 用 `instructions` 承载系统提示，且把 `messages` 里的 system 全量抽出——正是 v7 要求（`provider.ts:88-92`；`ai/js:2459-2462`；`ai/dist/index.d.ts:866` 的 `@deprecated` 证明反过来用 `system` 才是旧写法）。
2. 6 个领域工具的 `tool({description,inputSchema})` 写法、`jsonSchema` 的 JSON Schema 结构（`type/properties/required/additionalProperties:false`）正确；wire 上落成 `tools[].function.parameters`（`ds/js:557-565`，实测见 §7.1）。
3. `toolChoice:"auto"` + `stopWhen:stepCountIs(1)` 的「单步 planner」用法正确：工具不写 `execute`、由编排器外部执行，SDK 会把 tool-call 返回在 `result.toolCalls` 并停止（实测 §7.3）。
4. `tool-result` 用 `{type:"json", value}` 正确，DeepSeek 侧转成 JSON 文本进 `tool` 消息（`ds/js:337-340`，wire 实测 `content:"{\"ok\":true,...}"`）。
5. tool-call / tool-result 成对、`toolCallId` 对齐，满足 SDK 的 `MissingToolResultsError` 约束（`ai/js:1426-1438`）。
6. `usage` 字段名与取值方式正确（`inputTokens/outputTokens`，`provider.ts:137-138`；实测 stream 路径 `input_tokens:42, output_tokens:7`）。
7. `textStream` + `await result.usage` 的用法正确（`ai/dist/index.d.ts:2846,2912`；实测输出逐段文本与 usage）。
8. abort/超时最终异常能被 `mapModelError` 正确识别为 `AGENT_MODEL_TIMEOUT`（实测 §7.2）。
9. 错误路径：`APICallError`/`AISDKError` 只映射稳定码、不外传原始响应体，符合模块设计（`model-errors.ts:19-43`）——非格式问题，一并确认无碍。

---

## 7. 其他观察（非「不一致」，但会影响判断/排障）

### 7.1 streamAnswer 路径实测（本地 SSE stub，完整链路）

用本地 HTTP SSE 模拟 DeepSeek 流式响应、`createDeepSeek` 真实链路，复现 `streamAnswer` 的调用参数：

- 文本：`result.textStream` 产出 `"你"`、`"好"` → 拼接 `"你好"`
- usage：`{"inputTokens":42,...,"outputTokens":7,...}` → 仓库映射 `{model:"deepseek-chat",input_tokens:42,output_tokens:7}` ✅
- wire：`stream:true`、`stream_options:{include_usage:true}`、`messages` 里 assistant tool-call 的 `arguments` **同样是双重编码**（与 plan 一致）→ 证明 `streamAnswer` 也被主问题覆盖。
- 该请求**没有** `tools` 字段（`streamAnswer` 本来就不传工具）：SDK 允许历史里出现 tool 消息；同轮真实抓包 `03-stream-after-tool.json` 显示 DeepSeek 返回 200 并正常出文（`summary.json:86-107`）。所以「最终回答轮不带 tools 但带工具历史」**不是**不一致。

### 7.2 超时/中断行为实测（本地挂起服务器，真实 fetch）

| 场景 | `textStream` 迭代 | 后续 `await result.usage` | 结论 |
|---|---|---|---|
| `AbortSignal.timeout(200)`（`composeSignal` 的行为） | 静默结束，不抛 | reject `DOMException name="TimeoutError"` | 仓库「先 for-await、后 await usage」的顺序恰好能捕获并映射为 `AGENT_MODEL_TIMEOUT` ✅ |
| v7 内置 `timeout:{totalMs:200}` | 同上 | reject `TimeoutError` | 与 ↑ 等价；可选用内置 `timeout` 替代手工 `AbortSignal.timeout`，非必需 |
| 手工 `controller.abort()` | 静默结束，不抛 | reject `AbortError` | 映射为 `AGENT_MODEL_TIMEOUT`——语义上「用户取消」被记成「超时」，属产品文案问题，不是 SDK 不一致 |

**注意（脆弱点，不算当前缺陷）：** `streamAnswer` 的异常捕获依赖「`for await` 之后 `await result.usage`」这个顺序（`provider.ts:134-138`）。若未来有人把 `await result.usage` 挪到循环前、或删掉这一行，abort/超时就会**静默完成**并产出空回答，而不是报 `AGENT_MODEL_TIMEOUT`。建议加注释或在测试里锁住。

### 7.3 plan 路径实测

- 本地 mock 响应含一个 `tool_calls`，工具无 `execute`：`generateText` 发出 **1** 次请求后停止，`result.toolCalls[0].input` 是**对象** `{operation:"search_orders",q:"PO-1"}`、`finishReason:"tool-calls"`、`warnings:[]`——与 `plan()` 的假设一致。
- `plan()` 对 `result.text` 不取用：若模型同一步既出文本又出工具调用，文本会被丢弃，下一轮历史里只剩工具调用。功能上可接受（编排器的回答由 `streamAnswer` 负责），仅提示。

### 7.4 一些边界/风险

- **`deepseek-reasoner` 兼容性（若切换模型需复核）**：DeepSeek provider 对 thinking 模型会写 `reasoning_content`（`ds/js:315`；`getArgs` 的 `isThinkingEnabled` 判定在 `ds/js:766`）。仓库合成的 assistant 历史不带 reasoning，若把 `AGENT_DEEPSEEK_MODEL` 换成 reasoner 系模型，需实测是否要求历史回传 `reasoning_content`。默认 `deepseek-chat` 不受影响（抓包中 assistant 消息无 `reasoning_content`）。
- **空 messages 边界**：若某次调用只有 system 消息，`promptFor` 会产出 `messages: []`，`standardizePrompt` 抛 `InvalidPromptError("messages must not be empty")`（`ai/js:2455-2458`）→ 被映射成 `AGENT_MODEL_ERROR`。实际编排器始终带 `user` 问题（`agent-orchestrator.ts:69-73`），不会触发，仅记录。
- **`provider.ts:1` 的 `HttpException` 未被使用**（该文件只调 `mapModelError`）：卫生问题；仓库 tsconfig 未开 `noUnusedLocals`，所以 typecheck 不报。
- **`plan()` 不上报 usage**：只有 `streamAnswer` 产出 usage chunk（`provider.ts:137-138` → `agent-orchestrator.ts:111-122`）。不是格式问题，但会让 `usage.input_tokens` 只覆盖最终回答轮，做成本观测时要知情。
- 仓库内 **AI SDK 的唯一调用点**就是本文件（另有 `model-errors.ts` 引类型、`test` 用 `ai/test`）；无其他 provider/调用点需要同步修改。

---

## 8. 待确认 / 建议后续

1. **由 `wire-prover` 做重复实验**：双重编码 vs 修复后，各 20 次真实调用，统计有效 tool call 率、参数结构正确率、答案正确率（当前 06 探针 n=1，仅作方向佐证）。
2. 修复后回归多轮场景：≥2 个工具调用的 run，确认第二、三轮 plan 的 `operation` 不再丢失、回答有事实支撑。
3. 若计划支持 `deepseek-reasoner`，单独验证历史 `reasoning_content` 要求（见 §7.4）。
4. 线上如果已有失败样本，按「多轮查询 / 第二轮 plan」筛选，与该机制对照（预期：没有 4xx 错误码，只有回答质量下降）。

---

## 附录 A：本地 mock 抓包脚本（未写入仓库，经 stdin 执行）

```js
// node --input-type=module -  （cwd = 仓库根，保证 node 能解析 ai / @ai-sdk/deepseek）
import { generateText, jsonSchema, stepCountIs, tool as defineTool } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";

const captured = [];
const stubFetch = async (url, init) => {
  captured.push(JSON.parse(init.body));                       // ← 抓真实请求 body
  return new Response(JSON.stringify({
    id: "chatcmpl-x", object: "chat.completion", created: 1, model: "deepseek-chat",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  }), { status: 200, headers: { "content-type": "application/json" } });
};

const model = createDeepSeek({ apiKey: "probe-key", baseURL: "http://127.0.0.1:9", fetch: stubFetch })("deepseek-chat");
const tools = { order_query: defineTool({ description: "d", inputSchema: jsonSchema({ type: "object", properties: { operation: { type: "string" } }, required: ["operation"], additionalProperties: false }) }) };

const messages = [
  { role: "user", content: "查询订单 PO-2026-001" },
  // 与 provider.ts:69 同构：当前实现传字符串；改为对象即修复
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_1", toolName: "order_query", input: JSON.stringify({ operation: "search_orders" }) }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "order_query", output: { type: "json", value: { ok: true } } }] },
];

const r = await generateText({ model, instructions: "SYS", messages, tools, toolChoice: "auto", stopWhen: stepCountIs(1) });
console.log(JSON.stringify(captured[0].messages.find(m => m.role === "assistant").tool_calls));
```

- 换成 `input: { operation: "search_orders" }` 即得到 §3.3 的「修复后」字节。
- API key 用假值；`baseURL` 指向必然连不上的本地端口也无需真的连通，因为 `fetch` 已被替换。

## 附录 B：证据文件:行号索引（供复核）

| 结论 | 证据位置 |
|---|---|
| 提示侧 `input` 必须是对象 | `node_modules/@ai-sdk/provider-utils/dist/index.d.ts:328-352`（L339 注释、L341 类型）；`node_modules/@ai-sdk/provider/dist/index.d.ts:1258-1283`（L1269-1271） |
| 响应侧 `input` 是 JSON 字符串 | `node_modules/@ai-sdk/provider/dist/index.d.ts:563-593`（L574 注释、L578 类型） |
| ai 层原样透传 | `node_modules/ai/dist/index.js:1529-1536`（L1533） |
| ai 层不校验 | `node_modules/ai/dist/index.js:2245-2252`（L2249 `z.unknown()`） |
| DeepSeek 再 stringify | `node_modules/@ai-sdk/deepseek/dist/index.js:301-308`（L306） |
| 仓库当前实现 | `apps/api/src/modules/business-query-agent/deepseek-llm-provider.ts:69`（`:70` 断言） |
| tool-result json 正确 | `deepseek-llm-provider.ts:79`；`@ai-sdk/deepseek/dist/index.js:337-340`；`@ai-sdk/provider-utils/dist/index.d.ts:390-396` |
| 系统消息禁止进 messages | `node_modules/ai/dist/index.js:2459-2462`；`deepseek-llm-provider.ts:91` |
| `system` 已弃用 | `node_modules/ai/dist/index.d.ts:862-868`（L862 `instructions`、L866 `@deprecated`、L868 `system`）；`node_modules/ai/CHANGELOG.md:1722` |
| 默认 stopWhen | `node_modules/ai/dist/index.js:5348`；`node_modules/ai/dist/index.d.ts:3817` |
| usage 字段 | `node_modules/ai/dist/index.d.ts:344-348`；`deepseek-llm-provider.ts:137-138` |
| textStream/usage Promise | `node_modules/ai/dist/index.d.ts:2846,2912` |
| 响应侧 input 被解析成对象 | `node_modules/ai/dist/index.d.ts:1327-1336,1652`；`node_modules/ai/dist/index.js:4078-4152` |
| operation 丢失 | `deepseek-llm-provider.ts:115-119`；`llm-provider.ts:15`；`agent-orchestrator.ts:95`；`deepseek-llm-provider.ts:40` |
| 抓包（当前/修复/流式/真实 API） | `docs/review/agent-sdk-wire-proof-2026-10-26/captures/02-plan-after-tool.json:28`、`03-stream-after-tool.json:28,39-42`、`04-plan-after-tool-fixed.json:28`、`05-sdk-object-input-control.json`、`06-real-api-probe.json:4-5,20,36` |
| 测试盲区 | `apps/api/test/unit/agent-deepseek-provider.test.cjs:8,18,145-164` |

## 附录 C：命令与输出摘录

```
# 版本
ai@7.0.153 / @ai-sdk/deepseek@3.0.73 / @ai-sdk/provider@4.0.34 / @ai-sdk/provider-utils@5.0.68

# 类型检查（只读）
> npm run typecheck --workspace=@dilee/api
> tsc --noEmit
EXIT=0

# 本地 wire 抓包（附录 A）关键输出
wire assistant.tool_calls（当前实现）:
[{"id":"call_1","type":"function","function":{"name":"order_query","arguments":"\"{\\\"operation\\\":\\\"search_orders\\\",\\\"order_no\\\":\\\"PO-2026-001\\\"}\""}}]
JSON.parse(arguments) => "{\"operation\":\"search_orders\",\"order_no\":\"PO-2026-001\"}"   ← 字符串（双重编码）

wire assistant.tool_calls（对象输入，修复后）:
[{"id":"call_1","type":"function","function":{"name":"order_query","arguments":"{\"operation\":\"search_orders\",\"order_no\":\"PO-2026-001\"}"}}]
JSON.parse(arguments) => {"operation":"search_orders","order_no":"PO-2026-001"}           ← 对象（正确）

# 同一抓包里的 tools/tool_choice（均正确）
tools = [{"type":"function","function":{"name":"order_query","description":"d","parameters":{...}}}]
tool_choice = "auto"
```

---

**审计结论一句话：调用参数层与 v7 完全对齐；消息格式层有 1 处确定的 v7 契约违规（assistant tool-call 的 `input` 应传对象却传了 JSON 字符串 → DeepSeek provider 再 stringify 造成双重编码，静默影响所有多轮查询）和 1 处历史语义不一致（重建的 tool-call 丢了 `operation`）。前者优先级高，建议按 §5.1 修正并补 §5.3 的断言。**

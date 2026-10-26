// DeepSeek provider 的单元测试（ai/test 的 MockLanguageModelV4，不发真实请求）。
//
// 证明四条契约：plan 单步取 toolCalls（operation 从参数里拆出、未授权工具丢弃）、
// streamAnswer 分片产出 + usage chunk、工具结果消息合成 assistant(tool_calls)+tool 对、
// 模型错误经 mapModelError 只出稳定码。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { simulateReadableStream, MockLanguageModelV4 } = require("ai/test");
const { APICallError } = require("ai");
const { DeepSeekLlmProvider } = require("../../dist/modules/business-query-agent/deepseek-llm-provider.js");
const { createAgentLlmProvider } = require("../../dist/modules/business-query-agent/llm-provider-factory.js");

const USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const FINISH_TOOL_CALLS = { unified: "tool-calls", raw: "tool_calls" };
const FINISH_STOP = { unified: "stop", raw: "stop" };
const SIGNAL = new AbortController().signal;

const makeProvider = (model) => new DeepSeekLlmProvider({ apiKey: "test-key", model: "deepseek-chat", timeoutMs: 0, modelOverride: model });

test("plan：单步返回工具调用，operation 从参数拆出、其余参数进 args", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "tool-call", toolCallId: "call-1", toolName: "order_query", input: JSON.stringify({ operation: "search_orders", q: "SO" }) }],
      finishReason: FINISH_TOOL_CALLS,
      usage: USAGE,
    },
  });
  const plan = await makeProvider(model).plan([{ role: "user", content: "SO 有哪些订单" }], ["order_query"], SIGNAL);
  assert.deepEqual(plan.toolCalls, [{ id: "call-1", tool: "order_query", operation: "search_orders", args: { q: "SO" } }]);
});

test("plan：每个领域工具的 operation schema 只允许本领域登记能力", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: { content: [], finishReason: FINISH_STOP, usage: USAGE },
  });
  await makeProvider(model).plan([{ role: "user", content: "查询订单采购进度" }], ["order_query", "procurement_query"], SIGNAL);
  const schemas = Object.fromEntries(model.doGenerateCalls[0].tools.map((tool) => [tool.name, tool.inputSchema]));
  assert.deepEqual(schemas.order_query.properties.operation.enum, ["search_orders", "get_order_overview", "get_order_status", "get_order_timeline", "get_order_alerts", "get_order_attachments"]);
  assert.deepEqual(schemas.procurement_query.properties.operation.enum, ["get_purchase_plans", "get_purchase_orders", "get_receipts", "get_incoming_inspections"]);
  assert.ok(!schemas.procurement_query.properties.operation.enum.includes("search_orders"), "采购工具不得接受订单搜索 operation");
});

test("plan：系统指令经 instructions 进入模型，不能混入 messages", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: { content: [], finishReason: FINISH_STOP, usage: USAGE },
  });
  await makeProvider(model).plan(
    [
      { role: "system", content: "只按系统事实回答" },
      { role: "user", content: "查询订单进度" },
    ],
    ["order_query"],
    SIGNAL,
  );
  assert.equal(model.doGenerateCalls.length, 1, "AI SDK 必须接受系统指令并实际调用模型");
  const [system, user] = model.doGenerateCalls[0].prompt;
  assert.deepEqual(system, { role: "system", content: "只按系统事实回答" });
  assert.deepEqual(user.content, [{ type: "text", text: "查询订单进度" }]);
});

test("plan：未授权工具名被丢弃；缺 operation 的调用被丢弃", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [
        { type: "tool-call", toolCallId: "call-bad", toolName: "drop_table", input: JSON.stringify({ operation: "search_orders" }) },
        { type: "tool-call", toolCallId: "call-noop", toolName: "order_query", input: JSON.stringify({ q: "无 operation" }) },
        { type: "tool-call", toolCallId: "call-ok", toolName: "order_query", input: JSON.stringify({ operation: "search_orders", q: "SO" }) },
      ],
      finishReason: FINISH_TOOL_CALLS,
      usage: USAGE,
    },
  });
  const plan = await makeProvider(model).plan([{ role: "user", content: "q" }], ["order_query"], SIGNAL);
  assert.deepEqual(plan.toolCalls.map((call) => call.id), ["call-ok"]);
});

test("streamAnswer：文本增量逐段产出，结尾给 usage chunk", async () => {
  const model = new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "找到 " },
          { type: "text-delta", id: "t1", delta: "1 张订单" },
          { type: "text-end", id: "t1" },
          { type: "finish", usage: USAGE, finishReason: FINISH_STOP },
        ],
      }),
    },
  });
  const chunks = [];
  for await (const chunk of makeProvider(model).streamAnswer([{ role: "user", content: "q" }], SIGNAL)) chunks.push(chunk);
  assert.deepEqual(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text), ["找到 ", "1 张订单"]);
  const usage = chunks.at(-1);
  assert.equal(usage.type, "usage");
  assert.equal(usage.usage.model, "deepseek-chat");
  assert.equal(usage.usage.input_tokens, 10);
  assert.equal(usage.usage.output_tokens, 5);
});

test("streamAnswer：系统指令经 instructions 进入流式模型调用", async () => {
  const model = new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "系统事实" },
          { type: "text-end", id: "t1" },
          { type: "finish", usage: USAGE, finishReason: FINISH_STOP },
        ],
      }),
    },
  });
  const chunks = [];
  for await (const chunk of makeProvider(model).streamAnswer(
    [
      { role: "system", content: "只按系统事实回答" },
      { role: "user", content: "总结订单进度" },
    ],
    SIGNAL,
  )) chunks.push(chunk);
  assert.equal(chunks[0].type, "text");
  assert.equal(model.doStreamCalls.length, 1, "AI SDK 必须接受系统指令并实际启动流式模型调用");
  const [system, user] = model.doStreamCalls[0].prompt;
  assert.deepEqual(system, { role: "system", content: "只按系统事实回答" });
  assert.deepEqual(user.content, [{ type: "text", text: "总结订单进度" }]);
});

test("plan：mock 抛上下文超限错误 → 稳定码 AGENT_MODEL_CONTEXT_EXCEEDED，原文不外传", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: () => {
      throw new APICallError({ message: "Invalid request", url: "https://api.deepseek.com/chat/completions", requestBodyValues: {}, statusCode: 400, responseBody: JSON.stringify({ error: { code: "context_length_exceeded", customer: "客户甲" } }), isRetryable: false });
    },
  });
  await assert.rejects(
    makeProvider(model).plan([{ role: "user", content: "q" }], ["order_query"], SIGNAL),
    (error) => error.getResponse().code === "AGENT_MODEL_CONTEXT_EXCEEDED" && !error.getResponse().message.includes("客户甲"),
  );
});

test("工具结果消息合成为 assistant(tool_calls) + tool(tool_result) 对（发到模型的请求形状）", async () => {
  const seen = [];
  const model = new MockLanguageModelV4({
    doGenerate: (options) => {
      seen.push(options.prompt);
      return { content: [], finishReason: FINISH_STOP, usage: USAGE };
    },
  });
  await makeProvider(model).plan(
    [
      { role: "user", content: "查订单" },
      { role: "tool", id: "call-9", tool: "order_query", args: { q: "SO" }, content: JSON.stringify({ operation: "search_orders", data: [{ order_no: "SO-001" }] }) },
    ],
    ["order_query"],
    SIGNAL,
  );
  const prompt = JSON.stringify(seen[0]);
  assert.ok(prompt.includes('"tool_calls"') || prompt.includes("tool-call"), "assistant 侧必须有 tool-call");
  assert.ok(prompt.includes("SO-001"), "工具结果必须随消息对回传");
});

test("工厂：deepseek 缺密钥启动即报错；fake 带 AGENT_FAKE_DELAY_MS", () => {
  assert.throws(() => createAgentLlmProvider({ provider: "deepseek" }), /DEEPSEEK_API_KEY/);
  assert.throws(() => createAgentLlmProvider({ provider: "claude" }), /未知 AGENT_LLM_PROVIDER/);
  const fake = createAgentLlmProvider({ provider: "fake", fakeDelayMs: 2000 });
  assert.equal(fake.constructor.name, "FakeLlmProvider");
  const real = createAgentLlmProvider({ provider: "deepseek", deepseekApiKey: "k" });
  assert.equal(real.constructor.name, "DeepSeekLlmProvider");
});

/**
 * 经验性抓包脚本：用本地 OpenAI 兼容 mock server 记录 @ai-sdk/deepseek 真实发出的 HTTP body。
 *
 * 用法（在仓库根目录）：node docs/review/agent-sdk-wire-proof-2026-10-26/capture-wire.mjs
 * 产物：./captures/*.json
 *
 * 注意：只读仓库源码/编译产物，不修改任何源文件；仅创建本目录下的 capture 文件。
 */
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateText, stepCountIs } from 'ai';
import { createDeepSeek } from '@ai-sdk/deepseek';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const outDir = path.join(here, 'captures');
mkdirSync(outDir, { recursive: true });

const require = createRequire(import.meta.url);
const providerModulePath = path.join(repoRoot, 'apps', 'api', 'dist', 'modules', 'business-query-agent', 'deepseek-llm-provider.js');
const { DeepSeekLlmProvider } = require(providerModulePath);

// ---------------------------------------------------------------------------
// mock server：记录请求体，按 stream 标志回 OpenAI-compatible 响应
// ---------------------------------------------------------------------------
const captured = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    const record = {
      method: req.method,
      url: req.url,
      headers: {
        'content-type': req.headers['content-type'],
        authorization: req.headers.authorization ? 'Bearer ***REDACTED***' : undefined,
      },
      body,
      rawBody: raw,
    };
    captured.push(record);

    const isStream = body && body.stream === true;
    if (isStream) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      const base = { id: 'chatcmpl-mock', created: 1700000000, model: body.model, object: 'chat.completion.chunk' };
      const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
      res.write(chunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '已收到' }, finish_reason: null }] }));
      res.write(chunk({ ...base, choices: [{ index: 0, delta: { content: '工具结果。' }, finish_reason: null }] }));
      res.write(
        chunk({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 120, completion_tokens: 9, total_tokens: 129, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 120 },
        }),
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const payload = {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: 1700000000,
      model: body?.model ?? 'deepseek-chat',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_mock_1',
                type: 'function',
                function: { name: 'order_query', arguments: '{"operation":"search_orders","q":"SO-2026"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseURL = `http://127.0.0.1:${port}`;
console.log(`[mock] listening on ${baseURL}`);

// ---------------------------------------------------------------------------
// 与 agent-orchestrator 完全一致的消息形状
// ---------------------------------------------------------------------------
const SYSTEM = '你是 Dilee ERP 的订单查询助手。只允许通过给定工具查询事实，不得编造。';
const USER = '帮我看一下订单 SO-2026-0001 现在的生产进度。';

const plainMessages = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: USER },
];

// 第二轮 plan：上一轮已执行 order_query(search_orders)，编排器 push 的 tool 消息
// 见 agent-orchestrator.ts:95 —— args 是 plan() 里剥掉 operation 之后的剩余参数
const toolArgs = { q: 'SO-2026-0001' };
const toolFact = { tool: 'order_query', operation: 'get_order_status', ok: true, rows: [{ order_no: 'SO-2026-0001', status: '生产中' }] };
const withToolResult = [...plainMessages, { role: 'tool', id: 'call_mock_1', tool: 'order_query', args: toolArgs, content: JSON.stringify(toolFact) }];

const provider = new DeepSeekLlmProvider({ apiKey: 'test', baseURL, model: 'deepseek-chat', timeoutMs: 30_000 });
const visibleTools = ['order_query', 'sales_query', 'procurement_query'];

const results = {};

async function takeCapture(name, fn) {
  const before = captured.length;
  let error = null;
  let value = null;
  try {
    value = await fn();
  } catch (e) {
    error = { name: e?.name, message: e?.message, cause: e?.cause?.message };
  }
  const newRecords = captured.slice(before);
  if (newRecords.length !== 1) {
    throw new Error(`scenario ${name}: expected exactly 1 captured request, got ${newRecords.length}`);
  }
  const record = newRecords[0];
  const file = path.join(outDir, `${name}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');
  results[name] = { file: path.relative(repoRoot, file), error, value };
  return { record, error, value };
}

// (a) 第一轮 plan：无历史工具结果
const planFirst = await takeCapture('01-plan-first', () => provider.plan(plainMessages, visibleTools, AbortSignal.timeout(20_000)));

// (b) 第二轮 plan：消息里带 assistant(tool_calls)+tool 的历史（由 toModelMessages 合成）
const planAfterTool = await takeCapture('02-plan-after-tool', () => provider.plan(withToolResult, visibleTools, AbortSignal.timeout(20_000)));

// (c) 最终回答：streamAnswer 用同一份含工具历史的 messages（真实链路一定会走到这里）
const streamAfterTool = await takeCapture('03-stream-after-tool', async () => {
  const chunks = [];
  for await (const chunk of provider.streamAnswer(withToolResult, AbortSignal.timeout(20_000))) chunks.push(chunk);
  return chunks;
});

// (d) 对照：把 toModelMessages 的 input 改成对象（即最小修复），其余完全不变
const fixedProvider = new DeepSeekLlmProvider({ apiKey: 'test', baseURL, model: 'deepseek-chat', timeoutMs: 30_000 });
fixedProvider.toModelMessages = function fixed(messages) {
  const result = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      result.push({
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: message.id, toolName: message.tool, input: message.args ?? {} }],
      });
      let parsed = message.content;
      try {
        parsed = JSON.parse(message.content);
      } catch {
        /* 原文传 */
      }
      result.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: message.id, toolName: message.tool, output: { type: 'json', value: parsed } }] });
      continue;
    }
    result.push({ role: message.role, content: message.content });
  }
  return result;
};
const planAfterToolFixed = await takeCapture('04-plan-after-tool-fixed', () => fixedProvider.plan(withToolResult, visibleTools, AbortSignal.timeout(20_000)));

// (e) 对照 2：直接用 SDK 走一遍「input 为对象」的 generateText（不经过 provider）
const model = createDeepSeek({ apiKey: 'test', baseURL })('deepseek-chat');
const sdkControl = await takeCapture('05-sdk-object-input-control', async () => {
  const tools = fixedProvider.toolSetFor(visibleTools);
  return generateText({
    model,
    instructions: SYSTEM,
    messages: [
      { role: 'user', content: USER },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call_mock_1', toolName: 'order_query', input: toolArgs }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call_mock_1', toolName: 'order_query', output: { type: 'json', value: toolFact } }],
      },
    ],
    tools,
    toolChoice: 'auto',
    stopWhen: stepCountIs(1),
  });
});

server.close();
await new Promise((resolve) => server.close(resolve));

// ---------------------------------------------------------------------------
// 结果摘要
// ---------------------------------------------------------------------------
function wireToolCallArguments(record) {
  const msgs = record.body.messages ?? [];
  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) return { messageIndex: msgs.indexOf(m), id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments };
    }
  }
  return null;
}

const summary = {
  baseURL,
  generatedAt: new Date().toISOString(),
  scenarios: {},
  wireArguments: {},
  results,
};
for (const [name, r] of Object.entries(results)) {
  summary.scenarios[name] = { file: r.file, error: r.error };
}
for (const [name, rec] of Object.entries({ planFirst, planAfterTool, streamAfterTool, planAfterToolFixed, sdkControl })) {
  summary.wireArguments[name] = wireToolCallArguments(rec.record);
}
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

console.log(JSON.stringify(summary, null, 2));

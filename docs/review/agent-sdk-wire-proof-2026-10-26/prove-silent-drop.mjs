/**
 * 证明下游后果：DeepSeek 把「双编码历史」学成嵌套 arguments 的 tool_call 后，
 * provider.plan() 会因 parsed.operation 不是顶层字符串而 **静默丢弃** 该调用（deepseek-llm-provider.ts:115-118）。
 * 用本地 mock server 直接返回两种 tool_call arguments，比较 plan() 的返回。
 */
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const require = createRequire(import.meta.url);
const { DeepSeekLlmProvider } = require(path.join(repoRoot, 'apps', 'api', 'dist', 'modules', 'business-query-agent', 'deepseek-llm-provider.js'));

// 模型在「双编码历史」下实际生成的形状（来自真实 API 探针 08）：{"arguments":"{\"operation\":...}"}
const NESTED = JSON.stringify({ arguments: JSON.stringify({ operation: 'get_order_overview', order_no: 'SO-2026-0001' }) });
// 正常形状
const NORMAL = JSON.stringify({ operation: 'get_order_overview', order_no: 'SO-2026-0001' });

const responses = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    responses.push(body);
    const args = responses.length === 1 ? NESTED : NORMAL;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: 1700000000,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_mock_1', type: 'function', function: { name: 'order_query', arguments: args } }] },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    );
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const provider = new DeepSeekLlmProvider({ apiKey: 'test', baseURL: `http://127.0.0.1:${port}`, model: 'deepseek-chat' });

const messages = [
  { role: 'system', content: '你是工厂业务系统的查询助手。' },
  { role: 'user', content: '订单 SO-2026-0001 现在生产到哪一步了？' },
  { role: 'tool', id: 'call_mock_1', tool: 'order_query', args: { q: 'SO-2026-0001' }, content: JSON.stringify({ ok: true }) },
];

const nestedPlan = await provider.plan(messages, ['order_query'], AbortSignal.timeout(10_000));
const normalPlan = await provider.plan(messages, ['order_query'], AbortSignal.timeout(10_000));
server.close();

const out = {
  note: 'plan() 收到的 tool_call arguments（wire）对比与解析结果',
  nestedArgumentsWire: NESTED,
  normalArgumentsWire: NORMAL,
  nestedPlan,
  normalPlan,
  verdict: {
    nestedDropped: nestedPlan.toolCalls.length === 0,
    normalAccepted: normalPlan.toolCalls.length === 1,
  },
};
writeFileSync(path.join(here, 'captures', '09-silent-drop-proof.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));

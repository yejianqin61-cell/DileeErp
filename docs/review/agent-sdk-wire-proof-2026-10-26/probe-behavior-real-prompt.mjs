/**
 * 行为对照 2：把 system prompt 与用户问题换成生产链路的原文（agent-orchestrator.ts:22 的 SYSTEM_PROMPT），
 * 唯一变量仍是历史 assistant tool_call 的 arguments 编码（双重编码 vs 修复后）。
 * temperature=0，各 3 次。数据仍为 mock 订单号，无业务数据。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

function readEnvKey(name) {
  const envText = readFileSync(path.join(repoRoot, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}
const key = readEnvKey('DEEPSEEK_KEY');
if (!key) {
  console.log(JSON.stringify({ skipped: true }));
  process.exit(0);
}

// 生产原文（apps/api/src/modules/business-query-agent/agent-orchestrator.ts:22）
const SYSTEM_PROMPT = '你是工厂业务系统的查询助手。只根据本轮工具返回的事实回答；引用数字时说明来自哪张单据；查不到就明确说查不到，不得编造业务结论。';
const QUESTION = '订单 SO-2026-0001 现在生产到哪一步了？';

const OPERATIONS = ['search_orders', 'get_order_overview', 'get_order_status', 'get_order_timeline', 'get_order_alerts', 'get_order_attachments'];

function variantBody(file) {
  const record = JSON.parse(readFileSync(path.join(here, 'captures', file), 'utf8'));
  const body = JSON.parse(JSON.stringify(record.body));
  delete body.stream;
  delete body.stream_options;
  body.temperature = 0;
  body.max_tokens = 200;
  body.messages[0].content = SYSTEM_PROMPT;
  body.messages[1].content = QUESTION;
  return body;
}

async function call(body) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  const parsed = JSON.parse(text);
  const message = parsed.choices?.[0]?.message ?? {};
  return {
    httpStatus: res.status,
    finishReason: parsed.choices?.[0]?.finish_reason ?? null,
    content: message.content ?? null,
    toolCalls: (message.tool_calls ?? []).map((tc) => {
      const raw = tc.function?.arguments ?? null;
      let decoded = null;
      let decodedKind = 'invalid-json';
      try {
        decoded = JSON.parse(raw);
        decodedKind = typeof decoded;
      } catch {}
      return {
        name: tc.function?.name,
        rawArguments: raw,
        decodedKind,
        decodedKeys: decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? Object.keys(decoded) : null,
        topLevelOperationValid: Boolean(decoded && typeof decoded === 'object' && OPERATIONS.includes(decoded.operation)),
      };
    }),
  };
}

const out = { endpoint: 'https://api.deepseek.com/chat/completions', systemPrompt: SYSTEM_PROMPT, question: QUESTION, temperature: 0, maxTokens: 200, runs: [] };
for (let i = 1; i <= 3; i += 1) {
  out.runs.push({ variant: 'double-encoded-history', run: i, result: await call(variantBody('02-plan-after-tool.json')) });
  out.runs.push({ variant: 'fixed-object-input-history', run: i, result: await call(variantBody('04-plan-after-tool-fixed.json')) });
}
writeFileSync(path.join(here, 'captures', '08-behavior-probe-real-prompt.json'), JSON.stringify(out, null, 2), 'utf8');
for (const r of out.runs) {
  console.log(r.variant, 'run', r.run, '->', JSON.stringify(r.result.toolCalls.map((t) => ({ raw: t.rawArguments, kind: t.decodedKind, keys: t.decodedKeys, opValid: t.topLevelOperationValid }))));
}

/**
 * 可选行为对照：同一份对话（system/user/assistant(tool_call)/tool(result)），唯一变量是
 * 历史里 assistant tool_call 的 arguments 编码方式（双重编码 vs 修复后单层编码）。
 * 用 DEEPSEEK_KEY 真实调用，temperature=0，各 3 次，看模型下一轮 tool_call 的 arguments 是否仍正常。
 * 只使用 mock 订单号 SO-2026-0001，无业务数据；不打印密钥。
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
  console.log(JSON.stringify({ skipped: true, reason: 'no DEEPSEEK_KEY' }));
  process.exit(0);
}

const OPERATIONS = ['search_orders', 'get_order_overview', 'get_order_status', 'get_order_timeline', 'get_order_alerts', 'get_order_attachments'];

function variantBody(file) {
  const record = JSON.parse(readFileSync(path.join(here, 'captures', file), 'utf8'));
  const body = { ...record.body, temperature: 0, max_tokens: 150 };
  delete body.stream;
  delete body.stream_options;
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
  const toolCalls = (message.tool_calls ?? []).map((tc) => {
    const raw = tc.function?.arguments ?? null;
    let decoded = null;
    let decodedKind = null;
    try {
      decoded = JSON.parse(raw);
      decodedKind = typeof decoded;
    } catch {
      decodedKind = 'invalid-json';
    }
    return {
      name: tc.function?.name,
      rawArguments: raw,
      decodedKind,
      decodedHasOperation: decoded && typeof decoded === 'object' && typeof decoded.operation === 'string',
      decodedOperationValid: decoded && typeof decoded === 'object' && OPERATIONS.includes(decoded.operation),
      decoded,
    };
  });
  return { httpStatus: res.status, finishReason: parsed.choices?.[0]?.finish_reason ?? null, model: parsed.model, content: message.content ?? null, toolCalls };
}

const out = { endpoint: 'https://api.deepseek.com/chat/completions', temperature: 0, maxTokens: 150, runs: [] };
for (let i = 1; i <= 3; i += 1) {
  out.runs.push({ variant: 'double-encoded-history', run: i, result: await call(variantBody('02-plan-after-tool.json')) });
  out.runs.push({ variant: 'fixed-object-input-history', run: i, result: await call(variantBody('04-plan-after-tool-fixed.json')) });
}
writeFileSync(path.join(here, 'captures', '07-behavior-probe.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));

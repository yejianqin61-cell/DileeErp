/**
 * 可选实验：把本地抓到的真实 body（双重编码 vs 修复后）原样发往 api.deepseek.com，
 * 看服务端是接受还是拒绝。不打印密钥；请求体只含 mock 的订单号 SO-2026-0001 与「生产中」，无业务数据。
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
    if (m && m[1] === name) {
      return m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

const key = readEnvKey('DEEPSEEK_KEY');
if (!key) {
  console.log(JSON.stringify({ skipped: true, reason: '.env 未找到 DEEPSEEK_KEY' }));
  process.exit(0);
}
console.log(JSON.stringify({ keyFound: true, keyLength: key.length, looksLikePlaceholder: /x{6,}|your|placeholder|changeme/i.test(key) }));

function loadBody(name, { stripStream } = {}) {
  const record = JSON.parse(readFileSync(path.join(here, 'captures', name), 'utf8'));
  const body = { ...record.body };
  if (stripStream) {
    delete body.stream;
    delete body.stream_options;
  }
  body.max_tokens = 32;
  return body;
}

async function post(label, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const summary = {
      label,
      httpStatus: res.status,
      ok: res.ok,
      errorMessage: parsed?.error?.message ?? null,
      errorType: parsed?.error?.type ?? null,
      errorCode: parsed?.error?.code ?? null,
      choiceFinishReason: parsed?.choices?.[0]?.finish_reason ?? null,
      choiceMessage: parsed?.choices?.[0]?.message
        ? {
            role: parsed.choices[0].message.role,
            content: typeof parsed.choices[0].message.content === 'string' ? parsed.choices[0].message.content.slice(0, 120) : parsed.choices[0].message.content,
            hasToolCalls: Array.isArray(parsed.choices[0].message.tool_calls),
            toolCallArguments: parsed.choices[0].message.tool_calls?.[0]?.function?.arguments ?? null,
          }
        : null,
      rawSnippet: text.slice(0, 400),
    };
    return summary;
  } catch (e) {
    return { label, networkError: `${e?.name}: ${e?.message}` };
  } finally {
    clearTimeout(timer);
  }
}

const doubleEncoded = loadBody('02-plan-after-tool.json', { stripStream: true });
const fixed = loadBody('04-plan-after-tool-fixed.json', { stripStream: true });

const out = {
  endpoint: 'https://api.deepseek.com/chat/completions',
  sentArguments: {
    doubleEncoded: doubleEncoded.messages.find((m) => m.tool_calls)?.tool_calls?.[0]?.function?.arguments,
    fixed: fixed.messages.find((m) => m.tool_calls)?.tool_calls?.[0]?.function?.arguments,
  },
  results: [],
};
out.results.push(await post('double-encoded-history', doubleEncoded));
out.results.push(await post('fixed-object-input-history', fixed));
writeFileSync(path.join(here, 'captures', '06-real-api-probe.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));

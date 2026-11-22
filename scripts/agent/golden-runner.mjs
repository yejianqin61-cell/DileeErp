import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadCases, selectCases, turnsOf } from "./golden-cases.mjs";

const TERMINAL_TYPES = new Set(["completed", "error", "cancelled"]);
const DEFAULT_RUN_TIMEOUT_MS = 180_000;

export class RunnerError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunnerError";
  }
}

async function readEnvelope(response, what) {
  if (response.status === 401 || response.status === 403) {
    throw new RunnerError(`${what} 被拒绝（HTTP ${response.status}）：登录态或权限不足`);
  }
  if (!response.ok) throw new RunnerError(`${what} 失败（HTTP ${response.status}）`);
  const body = await response.json();
  if (!body || typeof body !== "object" || !("data" in body)) throw new RunnerError(`${what} 响应缺少 data 信封`);
  return body.data;
}

export async function login({ fetchImpl, apiBase, username, password }) {
  const response = await fetchImpl(`${apiBase}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new RunnerError(`登录失败（HTTP ${response.status}）`);
  const raw = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const session = raw.map((line) => line.split(";")[0]).find((line) => line.startsWith("dilee_session="));
  if (!session) throw new RunnerError("登录成功但响应没有 dilee_session Cookie");
  return session;
}

export function collectDocNumbers(sources) {
  const docs = new Set();
  for (const rows of sources) {
    for (const row of Array.isArray(rows) ? rows : []) {
      for (const key of ["order_no", "purchase_order_no", "production_order_no"]) {
        if (typeof row?.[key] === "string") docs.add(row[key]);
      }
    }
  }
  return docs;
}

export async function fetchBaselineDocs({ fetchImpl, apiBase, cookie }) {
  const headers = { cookie };
  const sources = [];
  for (const [path, what] of [
    ["/order-workbench/orders?page_size=200", "读取销售单基线"],
    ["/purchase-orders", "读取采购单基线"],
    ["/production/orders", "读取生产单基线"],
  ]) {
    sources.push(await readEnvelope(await fetchImpl(`${apiBase}${path}`, { headers }), what));
  }
  return collectDocNumbers(sources);
}

function normalizeSource(value) {
  return {
    business_type: typeof value?.business_type === "string" ? value.business_type : "",
    business_no: typeof value?.business_no === "string" ? value.business_no : "",
  };
}

export function emptyRunOutcome(runId) {
  return {
    runId,
    terminal: "unknown",
    errorCode: null,
    ops: [],
    failureCodes: [],
    sources: [],
    answer: "",
    toolCalls: 0,
    answerChunks: 0,
  };
}

export function applyEvent(outcome, event) {
  const payload = event.data && typeof event.data === "object" ? event.data : {};
  if (event.type === "tool_status") {
    const operation = typeof payload.operation === "string" ? payload.operation : "";
    if (payload.status === "running" && operation && !outcome.ops.includes(operation)) outcome.ops.push(operation);
    if (payload.status === "failed" && typeof payload.code === "string") outcome.failureCodes.push(payload.code);
    return outcome;
  }
  if (event.type === "source" && Array.isArray(payload.sources)) {
    outcome.sources.push(...payload.sources.map(normalizeSource));
    return outcome;
  }
  if (event.type === "answer_delta" && typeof payload.text === "string") {
    outcome.answer += payload.text;
    outcome.answerChunks += 1;
    return outcome;
  }
  if (event.type === "error") {
    outcome.terminal = "error";
    outcome.errorCode = typeof payload.code === "string" ? payload.code : "UNKNOWN_ERROR";
    if (outcome.errorCode !== "UNKNOWN_ERROR") outcome.failureCodes.push(outcome.errorCode);
    return outcome;
  }
  if (event.type === "cancelled") {
    outcome.terminal = "cancelled";
    return outcome;
  }
  if (event.type === "completed") {
    outcome.terminal = "completed";
    const usage = payload.usage && typeof payload.usage === "object" ? payload.usage : {};
    if (Number.isInteger(usage.tool_calls)) outcome.toolCalls = usage.tool_calls;
    if (Number.isInteger(usage.answer_chunks)) outcome.answerChunks = usage.answer_chunks;
    if (Array.isArray(payload.sources)) outcome.sources.push(...payload.sources.map(normalizeSource));
  }
  return outcome;
}

export function splitFrames(buffer) {
  const frames = [];
  let rest = buffer;
  let boundary = rest.indexOf("\n\n");
  while (boundary >= 0) {
    frames.push(rest.slice(0, boundary));
    rest = rest.slice(boundary + 2);
    boundary = rest.indexOf("\n\n");
  }
  return { frames, rest };
}

export function parseFrame(frame) {
  const events = [];
  for (const line of frame.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const payload = JSON.parse(line.slice(5).trim());
      if (typeof payload?.type === "string") {
        events.push({
          seq: typeof payload.seq === "number" ? payload.seq : 0,
          type: payload.type,
          data: payload.data && typeof payload.data === "object" ? payload.data : {},
        });
      }
    } catch {
      continue;
    }
  }
  return events;
}

export async function followRun({ fetchImpl, apiBase, cookie, runId, signal, timeoutMs = DEFAULT_RUN_TIMEOUT_MS }) {
  const composed = timeoutMs > 0 && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : signal;
  const response = await fetchImpl(`${apiBase}/business-query/runs/${encodeURIComponent(runId)}/events`, {
    headers: { cookie, accept: "text/event-stream" },
    signal: composed,
  });
  if (response.status === 404) throw new RunnerError(`run ${runId} 不存在或不属于当前账号`);
  if (!response.ok || !response.body) throw new RunnerError(`事件流打不开（HTTP ${response.status}）`);

  const outcome = emptyRunOutcome(runId);
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const split = splitFrames(buffer);
    buffer = split.rest;
    for (const frame of split.frames) {
      for (const event of parseFrame(frame)) {
        applyEvent(outcome, event);
        if (TERMINAL_TYPES.has(event.type)) done = true;
      }
    }
    if (done) break;
  }
  if (!done) {
    buffer += decoder.decode();
    for (const frame of splitFrames(`${buffer}\n\n`).frames) {
      for (const event of parseFrame(frame)) {
        applyEvent(outcome, event);
        if (TERMINAL_TYPES.has(event.type)) done = true;
      }
    }
  }
  if (outcome.terminal === "unknown") throw new RunnerError(`run ${runId} 的流在终态之前结束`);
  if (outcome.terminal === "error") outcome.terminal = "failed";
  return outcome;
}

export function mergeOutcomes(parts) {
  const terminal = parts.find((part) => part.terminal !== "completed")?.terminal ?? "completed";
  const failed = parts.find((part) => part.terminal === "failed");
  return {
    terminal,
    errorCode: failed?.errorCode ?? null,
    ops: [...new Set(parts.flatMap((part) => part.ops))],
    failureCodes: parts.flatMap((part) => part.failureCodes),
    sources: parts.flatMap((part) => part.sources),
    answer: parts.at(-1)?.answer ?? "",
    toolCalls: parts.reduce((sum, part) => sum + part.toolCalls, 0),
    answerChunks: parts.reduce((sum, part) => sum + part.answerChunks, 0),
  };
}

export async function runCase({ fetchImpl, apiBase, cookie, caseDef, signal, timeoutMs }) {
  const startedAt = Date.now();
  const turns = turnsOf(caseDef);
  const headers = { cookie, "content-type": "application/json" };
  const sessionData = await readEnvelope(
    await fetchImpl(`${apiBase}/business-query/sessions`, { method: "POST", headers }),
    "建会话",
  );
  const sessionId = sessionData.session_id;
  const parts = [];
  for (const question of turns) {
    const runData = await readEnvelope(
      await fetchImpl(`${apiBase}/business-query/sessions/${encodeURIComponent(sessionId)}/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ question, client_message_id: randomUUID() }),
      }),
      "提交提问",
    );
    parts.push(await followRun({ fetchImpl, apiBase, cookie, runId: runData.run_id, signal, timeoutMs }));
  }
  return { id: caseDef.id, group: caseDef.group, turns, sessionId, durationMs: Date.now() - startedAt, ...mergeOutcomes(parts) };
}

export function missingBaseline(caseDef, present) {
  return caseDef.baselineDocs.filter((doc) => !present.has(doc));
}

async function main() {
  const argv = process.argv.slice(2);
  const groups = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--group") groups.push(argv[index + 1]);
  }
  const apiBase = process.env.GOLDEN_API_BASE ?? "http://127.0.0.1:3111/api/v1";
  const username = process.env.GOLDEN_USERNAME ?? "admin";
  const password = process.env.GOLDEN_PASSWORD;
  if (!password) {
    console.error("缺少 GOLDEN_PASSWORD");
    process.exit(2);
  }
  const casesDir = fileURLToPath(new URL("../../apps/api/test/agent-golden/cases/", import.meta.url));
  const cases = selectCases(loadCases(casesDir), groups);
  const cookie = await login({ fetchImpl: fetch, apiBase, username, password });
  const present = await fetchBaselineDocs({ fetchImpl: fetch, apiBase, cookie });
  const results = [];
  for (const caseDef of cases) {
    const missing = missingBaseline(caseDef, present);
    const outcome = await runCase({ fetchImpl: fetch, apiBase, cookie, caseDef, signal: AbortSignal.timeout(600_000) });
    results.push({ caseDef, outcome, missing });
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("golden-runner.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
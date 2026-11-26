import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const GROUPS = ["entry", "miss", "relation", "followup", "permission", "finance_positive", "known_answer", "gap"];

export const GAP_CLASSES = ["gap", "decoy"];

export const FULL_ACCOUNT_GROUPS = ["finance_positive"];

export const EXPECT_KEYS = [
  "terminal",
  "sourcesInclude",
  "sourcesExcludeTypes",
  "opsInclude",
  "failureCodesExclude",
  "maxToolCalls",
  "answerExclude",
  "answerIncludesDigits",
];

const TERMINALS = ["completed", "failed", "cancelled"];
const CASE_ID = /^[a-z0-9][a-z0-9-]*$/;

export class CaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "CaseError";
  }
}

function fail(message) {
  throw new CaseError(message);
}

function requireArrayOfStrings(value, where) {
  if (!Array.isArray(value) || value.length === 0) fail(`${where} 必须是非空字符串数组`);
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) fail(`${where} 含非字符串或空串项`);
  }
  return value.map((item) => item.trim());
}

function requireString(value, where) {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${where} 必须是非空字符串`);
  return value.trim();
}

function parseExpect(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("expect 必须是 JSON 对象");
  const keys = Object.keys(raw);
  if (keys.length === 0) fail("expect 至少要有一条期望");
  const unknown = keys.filter((key) => !EXPECT_KEYS.includes(key));
  if (unknown.length > 0) fail(`expect 不接受字段：${unknown.join(", ")}（允许：${EXPECT_KEYS.join(", ")}）`);

  const expect = {};
  for (const key of keys) {
    if (key === "terminal") {
      const terminal = requireString(raw.terminal, "expect.terminal");
      if (!TERMINALS.includes(terminal)) fail(`expect.terminal 必须是 ${TERMINALS.join(" / ")}，收到 ${terminal}`);
      expect.terminal = terminal;
      continue;
    }
    if (key === "maxToolCalls") {
      const value = raw.maxToolCalls;
      if (!Number.isInteger(value) || value < 1) fail("expect.maxToolCalls 必须是正整数");
      expect.maxToolCalls = value;
      continue;
    }
    if (key === "answerIncludesDigits") {
      const value = raw.answerIncludesDigits;
      if (!Array.isArray(value) || value.length === 0) fail("expect.answerIncludesDigits 必须是非空数组");
      const digits = value.map((item) => {
        const text = typeof item === "number" ? String(item) : item;
        if (typeof text !== "string" || !/^\d+(\.\d+)?$/.test(text.trim())) fail(`expect.answerIncludesDigits 含非法数字：${String(item)}`);
        return text.trim();
      });
      expect.answerIncludesDigits = digits;
      continue;
    }
    expect[key] = requireArrayOfStrings(raw[key], `expect.${key}`);
  }
  return expect;
}

function parseBaselineDocs(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail("baselineDocs 必须是字符串数组");
  return raw.map((item, index) => requireString(item, `baselineDocs[${index}]`));
}

function parseGap(raw, id, group) {
  if (group !== "gap") {
    if (raw !== undefined) fail(`用例 ${id} 不是 gap 组，不能带 gap 字段`);
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(`用例 ${id} 属于 gap 组，必须给 gap 字段`);
  const unknown = Object.keys(raw).filter((key) => key !== "class" && key !== "nearest");
  if (unknown.length > 0) fail(`用例 ${id} 的 gap 不接受字段：${unknown.join(", ")}`);
  if (!GAP_CLASSES.includes(raw.class)) fail(`用例 ${id} 的 gap.class 必须是 ${GAP_CLASSES.join(" / ")}`);
  return { class: raw.class, nearest: requireString(raw.nearest, `用例 ${id} 的 gap.nearest`) };
}

export function parseCase(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("用例必须是 JSON 对象");
  const allowed = ["id", "group", "question", "turns", "baselineDocs", "expect", "gap"];
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(`用例不接受字段：${unknown.join(", ")}（允许：${allowed.join(", ")}）`);

  if (raw.id === undefined) fail("用例缺少 id");
  const id = requireString(raw.id, "id");
  if (!CASE_ID.test(id)) fail(`id 必须是 kebab-case：${id}`);

  if (raw.group === undefined) fail(`用例 ${id} 缺少 group`);
  const group = requireString(raw.group, "group");
  if (!GROUPS.includes(group)) fail(`用例 ${id} 的 group 未知：${group}（允许：${GROUPS.join(", ")}）`);

  const hasQuestion = raw.question !== undefined;
  const hasTurns = raw.turns !== undefined;
  if (hasQuestion && hasTurns) fail(`用例 ${id} 不能同时给 question 与 turns`);
  if (!hasQuestion && !hasTurns) fail(`用例 ${id} 必须给 question 或 turns`);

  const gap = parseGap(raw.gap, id, group);
  const parsed = { id, group, baselineDocs: parseBaselineDocs(raw.baselineDocs), expect: parseExpect(raw.expect), ...(gap ? { gap } : {}) };
  if (hasQuestion) {
    parsed.question = requireString(raw.question, "question");
    return parsed;
  }
  if (!Array.isArray(raw.turns) || raw.turns.length < 2) fail(`用例 ${id} 的 turns 至少两轮`);
  parsed.turns = raw.turns.map((item, index) => requireString(item, `turns[${index}]`));
  return parsed;
}

export function turnsOf(caseDef) {
  return caseDef.turns ?? [caseDef.question];
}

export function loadCases(dir) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const seen = new Map();
  const cases = [];
  for (const file of files) {
    const path = join(dir, file);
    let raw;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (cause) {
      fail(`${file} 不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`);
    }
    const list = Array.isArray(raw) ? raw : fail(`${file} 顶层必须是数组`);
    for (const item of list) {
      const parsed = parseCase(item);
      const previous = seen.get(parsed.id);
      if (previous !== undefined) fail(`用例 id 重复：${parsed.id}（${previous} 与 ${file}）`);
      seen.set(parsed.id, file);
      cases.push(parsed);
    }
  }
  return cases.sort((left, right) => left.id.localeCompare(right.id));
}

export function selectCases(cases, groups) {
  if (!groups || groups.length === 0) return cases;
  const unknown = groups.filter((group) => !GROUPS.includes(group));
  if (unknown.length > 0) fail(`未知分组：${unknown.join(", ")}（允许：${GROUPS.join(", ")}）`);
  return cases.filter((item) => groups.includes(item.group));
}
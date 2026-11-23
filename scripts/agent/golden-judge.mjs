export const VERDICTS = ["pass", "fail", "baseline_missing"];

function checkTerminal(expect, outcome, reasons) {
  if (expect.terminal !== undefined && outcome.terminal !== expect.terminal) {
    reasons.push(`终态期望 ${expect.terminal}，实际 ${outcome.terminal}`);
  }
}

function checkSourcesInclude(expect, outcome, reasons) {
  const wanted = expect.sourcesInclude;
  if (wanted === undefined) return;
  const present = new Set(outcome.sources.map((source) => source.business_no));
  for (const doc of wanted) {
    if (!present.has(doc)) reasons.push(`来源缺少 ${doc}`);
  }
}

function checkSourcesExcludeTypes(expect, outcome, reasons) {
  const banned = expect.sourcesExcludeTypes;
  if (banned === undefined) return;
  const present = new Set(outcome.sources.map((source) => source.business_type));
  for (const type of banned) {
    if (present.has(type)) reasons.push(`来源含被排除的类型 ${type}`);
  }
}

function checkOpsInclude(expect, outcome, reasons) {
  const wanted = expect.opsInclude;
  if (wanted === undefined) return;
  for (const operation of wanted) {
    if (!outcome.ops.includes(operation)) reasons.push(`未调用 operation ${operation}`);
  }
}

function checkFailureCodesExclude(expect, outcome, reasons) {
  const banned = expect.failureCodesExclude;
  if (banned === undefined) return;
  for (const code of banned) {
    if (outcome.failureCodes.includes(code)) reasons.push(`出现被禁用的失败码 ${code}`);
  }
}

function checkMaxToolCalls(expect, outcome, reasons) {
  const limit = expect.maxToolCalls;
  if (limit === undefined) return;
  if (outcome.toolCalls > limit) reasons.push(`工具调用 ${outcome.toolCalls} 次，超过上限 ${limit}`);
}

function checkAnswerExclude(expect, outcome, reasons) {
  const banned = expect.answerExclude;
  if (banned === undefined) return;
  for (const text of banned) {
    if (outcome.answer.includes(text)) reasons.push(`答案含被排除的文本「${text}」`);
  }
}

/**
 * 数字断言：只判「这个数出现在答案里」，不判措辞。
 *
 * 两件必须做的事，否则会假通过：
 *   1. 先把单号从答案里剥掉 —— `MOCK-ORD-1000` 里的 1000 不是数量；
 *   2. 匹配带数字边界 —— 否则 1000 会被 10000 命中。
 */
function stripDocumentNumbers(answer, caseDef, outcome) {
  const docs = new Set([
    ...(Array.isArray(caseDef.baselineDocs) ? caseDef.baselineDocs : []),
    ...outcome.sources.map((source) => source.business_no),
  ].filter((value) => typeof value === "string" && value.length > 0));
  let stripped = answer;
  for (const doc of docs) stripped = stripped.split(doc).join(" ");
  return stripped;
}

function checkAnswerIncludesDigits(expect, outcome, reasons, caseDef) {
  const wanted = expect.answerIncludesDigits;
  if (wanted === undefined) return;
  const haystack = stripDocumentNumbers(outcome.answer, caseDef, outcome);
  for (const value of wanted) {
    const pattern = new RegExp(`(?<![0-9])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`);
    if (!pattern.test(haystack)) reasons.push(`答案缺少数字 ${value}`);
  }
}

export function judge({ caseDef, outcome, missingBaseline: missing = [] }) {
  const id = caseDef.id;
  if (missing.length > 0) {
    return { id, group: caseDef.group, verdict: "baseline_missing", reasons: [`基线缺少单号：${missing.join(", ")}`] };
  }
  const reasons = [];
  checkTerminal(caseDef.expect, outcome, reasons);
  checkSourcesInclude(caseDef.expect, outcome, reasons);
  checkSourcesExcludeTypes(caseDef.expect, outcome, reasons);
  checkOpsInclude(caseDef.expect, outcome, reasons);
  checkFailureCodesExclude(caseDef.expect, outcome, reasons);
  checkMaxToolCalls(caseDef.expect, outcome, reasons);
  checkAnswerExclude(caseDef.expect, outcome, reasons);
  checkAnswerIncludesDigits(caseDef.expect, outcome, reasons, caseDef);
  return { id, group: caseDef.group, verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}

export function judgeAll(entries) {
  return entries.map((entry) => judge(entry));
}
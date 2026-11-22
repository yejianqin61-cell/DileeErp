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
  return { id, group: caseDef.group, verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}

export function judgeAll(entries) {
  return entries.map((entry) => judge(entry));
}
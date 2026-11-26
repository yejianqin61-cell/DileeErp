import { gapMetrics } from "./golden-gap-metrics.mjs";
import { judge } from "./golden-judge.mjs";

const TARGET_MEDIAN = 2;
const FAILURE_LIMIT_PER = 70;

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
};

const stepsOf = (value) => (Number.isInteger(value) && value > 0 ? value : null);
const unique = (values) => [...new Set(values)];

function byGroup(rows) {
  return unique(rows.map((row) => row.group)).sort().map((group) => ({
    group,
    cases: rows.filter((row) => row.group === group).length,
    median: median(rows.filter((row) => row.group === group && row.steps !== null).map((row) => row.steps)),
  }));
}

export function evaluate({ entries, baseline }) {
  const baselineRows = baseline.judged.map((row) => ({ id: row.id, group: row.group, steps: stepsOf(row.modelSteps) }));
  const baselineIds = new Set(baselineRows.map((row) => row.id));
  const judged = entries.map((entry) => ({ ...judge(entry), rep: entry.rep ?? 1 }));
  const reps = unique(judged.map((row) => row.rep)).sort((left, right) => left - right);
  const caseIds = unique(entries.map((entry) => entry.caseDef.id));

  const caseRows = caseIds.map((id) => {
    const own = entries.filter((entry) => entry.caseDef.id === id);
    return { id, group: own[0].caseDef.group, steps: median(own.map((entry) => stepsOf(entry.outcome.modelSteps)).filter((value) => value !== null)) };
  });
  const comparable = caseRows.filter((row) => baselineIds.has(row.id));
  const inBaseline = entries.filter((entry) => baselineIds.has(entry.caseDef.id));
  const baselineComplete = reps.length > 0 && inBaseline.length === baselineIds.size * reps.length;
  const complete = baselineComplete && entries.length === caseIds.length * reps.length;

  const current = median(comparable.filter((row) => row.steps !== null).map((row) => row.steps));
  const failed = judged.filter((row) => row.verdict !== "pass");
  const withCodes = inBaseline.filter((entry) => entry.outcome.failureCodes.length > 0).length;
  const codes = new Map();
  for (const entry of entries) for (const code of entry.outcome.failureCodes) codes.set(code, (codes.get(code) ?? 0) + 1);

  return {
    baseline: { median: median(baselineRows.filter((row) => row.steps !== null).map((row) => row.steps)), byGroup: byGroup(baselineRows) },
    median: current,
    byGroup: byGroup(comparable),
    otherGroups: byGroup(caseRows.filter((row) => !baselineIds.has(row.id))),
    caseSteps: Object.fromEntries(comparable.map((row) => [row.id, row.steps])),
    missingSteps: entries.filter((entry) => stepsOf(entry.outcome.modelSteps) === null).length,
    caseCount: caseIds.length,
    baselineCount: baselineIds.size,
    reps: reps.map((rep) => ({ rep, total: judged.filter((row) => row.rep === rep).length, pass: judged.filter((row) => row.rep === rep && row.verdict === "pass").length })),
    failed,
    failureCodes: [...codes.entries()].map(([code, count]) => ({ code, count })).sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)),
    failureRuns: { withCodes, total: inBaseline.length },
    gap: gapMetrics(entries),
    criteria: [
      { id: 1, name: "判据一", met: baselineComplete && current !== null && current <= TARGET_MEDIAN, measured: `P1 同批用例步数中位数 ${current ?? "未记录"}（要求 ≤ ${TARGET_MEDIAN}）` },
      { id: 2, name: "判据二", met: complete && failed.length === 0, measured: `${judged.length - failed.length} / ${judged.length} 个用例轮次通过（要求全过）` },
      { id: 3, name: "判据三", met: baselineComplete && withCodes * FAILURE_LIMIT_PER <= inBaseline.length, measured: `P1 同批 ${withCodes} / ${inBaseline.length} 个用例轮次带失败码（要求 ≤ 1/${FAILURE_LIMIT_PER}）` },
    ],
  };
}

const percent = (rate) => (rate === null ? "—" : `${(rate * 100).toFixed(1)}%`);
const table = (header, rows) => [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)];

export function renderP2(result, meta = {}) {
  const unmet = result.criteria.filter((item) => !item.met).length;
  const before = new Map(result.baseline.byGroup.map((row) => [row.group, row.median]));
  const gap = result.gap;
  const lines = [
    "# 顾问查询工具黄金集 P2 报告",
    "",
    `生成时间：${meta.runAt ?? "未记录"}｜API：${meta.apiBase ?? "未记录"}｜模型：${meta.model ?? "未记录"}`,
    "",
    "## 1. 结论",
    "",
    `**${result.caseCount} 条用例跑 ${result.reps.length} 轮，三条判据${unmet === 0 ? "全部达成" : `有 ${unmet} 条未达成`}。**`,
    "",
    ...result.criteria.map((item) => `- ${item.name}：${item.met ? "达成" : "未达成"}。${item.measured}。`),
    "",
    "## 2. 模型步数（与 P1 同批用例）",
    "",
    `每条取各轮中间值，再取各条中位数。总体：P1 ${result.baseline.median ?? "—"}，本轮 ${result.median ?? "—"}。缺步数的用例轮次 ${result.missingSteps} 个。`,
    "",
    ...table(["分组", "条数", "P1 中位数", "本轮中位数"], result.byGroup.map((row) => [row.group, row.cases, before.get(row.group) ?? "—", row.median ?? "—"])),
    "",
    "P1 之外新增的用例：",
    "",
    ...table(["分组", "条数", "本轮中位数"], result.otherGroups.map((row) => [row.group, row.cases, row.median ?? "—"])),
    "",
    "## 3. 逐轮通过数",
    "",
    ...table(["轮次", "总数", "通过"], result.reps.map((row) => [row.rep, row.total, row.pass])),
    "",
    "## 4. 失败码分布",
    "",
    ...(result.failureCodes.length ? table(["失败码", "出现次数"], result.failureCodes.map((row) => [row.code, row.count])) : ["本次运行没有出现任何失败码。"]),
    "",
    "## 5. 缺口声明",
    "",
    `- 漂移率 ${percent(gap.driftRate)}：最近邻与题集标注不一致 ${gap.mismatched} / ${gap.declarations} 条放行声明。`,
    `- 真缺口题用例轮次 ${gap.gapRuns} 个，其中 ${gap.undeclared} 个没有任何放行声明。`,
    `- 误报率 ${percent(gap.falsePositiveRate)}：干扰题出现放行声明 ${gap.falsePositives} / ${gap.decoyRuns} 个用例轮次。`,
    ...(gap.permissionRuns ? [`- 权限题出现放行声明 ${gap.permissionDeclared} / ${gap.permissionRuns} 个用例轮次，应为 0。`] : []),
    "",
    "## 6. 未通过清单",
    "",
    ...(result.failed.length ? table(["用例", "轮次", "判定", "原因"], result.failed.map((row) => [row.id, row.rep, row.verdict, row.reasons.join("；") || "（无）"])) : ["全部通过。"]),
    "",
    "## 7. 数据基线",
    "",
    meta.baselineNote ?? "由 scripts/seed-mock-data.mjs 生成的 MOCK-* 幂等种子数据。",
    "",
  ];
  if (typeof meta.analysis === "string" && meta.analysis.trim()) lines.push("## 8. 缺陷分析（人工撰写，不由脚本生成）", "", meta.analysis.trim(), "");
  return lines.join("\n");
}

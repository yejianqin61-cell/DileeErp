export function summarize(judged) {
  const rows = judged.map((entry) => ({
    id: entry.id,
    group: entry.group,
    verdict: entry.verdict,
    reasons: Array.isArray(entry.reasons) ? entry.reasons : [],
    failureCodes: Array.isArray(entry.failureCodes) ? entry.failureCodes : [],
  }));

  const total = rows.length;
  const pass = rows.filter((row) => row.verdict === "pass").length;
  const fail = rows.filter((row) => row.verdict === "fail").length;
  const baselineMissing = rows.filter((row) => row.verdict === "baseline_missing").length;
  const scored = total - baselineMissing;
  const passRate = scored > 0 ? pass / scored : null;

  const groups = [...new Set(rows.map((row) => row.group))].sort();
  const byGroup = groups.map((group) => {
    const members = rows.filter((row) => row.group === group);
    const groupPass = members.filter((row) => row.verdict === "pass").length;
    const groupMissing = members.filter((row) => row.verdict === "baseline_missing").length;
    const groupScored = members.length - groupMissing;
    return {
      group,
      total: members.length,
      pass: groupPass,
      fail: members.filter((row) => row.verdict === "fail").length,
      baselineMissing: groupMissing,
      passRate: groupScored > 0 ? groupPass / groupScored : null,
    };
  });

  const counts = new Map();
  for (const row of rows) {
    for (const code of row.failureCodes) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const failureCodes = [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => (right.count - left.count) || left.code.localeCompare(right.code));

  const withFailureCodes = rows.filter((row) => row.failureCodes.length > 0);
  const selfHealed = withFailureCodes.filter((row) => row.verdict === "pass");
  const processSignal = {
    casesWithFailureCodes: withFailureCodes.length,
    selfHealedCases: selfHealed.length,
    selfHealedCaseIds: selfHealed.map((row) => row.id).sort(),
    toolCallFailureRate: total > 0 ? withFailureCodes.length / total : null,
  };

  return { total, pass, fail, baselineMissing, passRate, byGroup, failureCodes, processSignal, rows };
}

function percent(rate) {
  return rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
}

function reasonsOf(row) {
  return row.reasons.length === 0 ? "（无）" : row.reasons.join("；");
}

export function renderMarkdown(summary, meta = {}) {
  const lines = [];
  lines.push("# 顾问查询工具黄金集基线报告");
  lines.push("");
  lines.push(`生成时间：${meta.runAt ?? "未记录"}｜API：${meta.apiBase ?? "未记录"}｜模型：${meta.model ?? "未记录"}`);
  lines.push("");
  lines.push("## 1. 结论");
  lines.push("");
  lines.push(`**${summary.total} 条用例，通过 ${summary.pass} 条，未通过 ${summary.fail} 条，基线缺失 ${summary.baselineMissing} 条，通过率 ${percent(summary.passRate)}。**`);
  lines.push("");
  if (summary.processSignal.casesWithFailureCodes > 0) {
    lines.push(
      `另一条独立的数：**${summary.processSignal.casesWithFailureCodes} 条用例过程中出现过工具失败（${percent(summary.processSignal.toolCallFailureRate)}），其中 ${summary.processSignal.selfHealedCases} 条靠模型自纠拿到结论。**`,
    );
    lines.push("");
  }
  lines.push("通过率的分母是「总数 − 基线缺失」：缺数据的用例不算工具失败，但要单独计数。");
  lines.push("");
  lines.push("## 2. 分组");
  lines.push("");
  lines.push("| 分组 | 总数 | 通过 | 未通过 | 基线缺失 | 通过率 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const group of summary.byGroup) {
    lines.push(`| ${group.group} | ${group.total} | ${group.pass} | ${group.fail} | ${group.baselineMissing} | ${percent(group.passRate)} |`);
  }
  lines.push("");
  lines.push("## 3. 失败码分布");
  lines.push("");
  if (summary.failureCodes.length === 0) {
    lines.push("本次运行没有出现任何失败码。");
  } else {
    lines.push("| 失败码 | 出现次数 |");
    lines.push("| --- | --- |");
    for (const item of summary.failureCodes) lines.push(`| ${item.code} | ${item.count} |`);
  }
  lines.push("");
  const signal = summary.processSignal;
  lines.push("### 3.1 工具调用失败率（过程信号）");
  lines.push("");
  lines.push(
    `**${signal.casesWithFailureCodes} / ${summary.total} 条用例（${percent(signal.toolCallFailureRate)}）在过程中出现过至少一次工具失败；其中 ${signal.selfHealedCases} 条被模型自行纠正后仍拿到终态 completed。**`,
  );
  lines.push("");
  lines.push("这条才是「工具调用失败率高」的直接度量：结论对了，不等于调用过程是干净的。每次失败都在消耗模型的失败预算（上限 3 次），也在拉长时延。");
  lines.push("");
  if (signal.selfHealedCaseIds.length > 0) {
    lines.push(`自纠成功的用例：${signal.selfHealedCaseIds.join("、")}`);
    lines.push("");
  }
  lines.push("## 4. 未通过清单");
  lines.push("");
  const failed = summary.rows.filter((row) => row.verdict !== "pass");
  if (failed.length === 0) {
    lines.push("全部通过。");
  } else {
    lines.push("| 用例 | 分组 | 判定 | 原因 |");
    lines.push("| --- | --- | --- | --- |");
    for (const row of failed) lines.push(`| ${row.id} | ${row.group} | ${row.verdict} | ${reasonsOf(row)} |`);
  }
  lines.push("");
  lines.push("## 5. 数据基线");
  lines.push("");
  lines.push(meta.baselineNote ?? "未记录数据基线。");
  lines.push("");
  lines.push("## 6. 未覆盖");
  lines.push("");
  const gaps = Array.isArray(meta.uncovered) && meta.uncovered.length > 0 ? meta.uncovered : ["未记录未覆盖项。"];
  for (const gap of gaps) lines.push(`- ${gap}`);
  lines.push("");
  lines.push("## 7. 附录：本次观测（不参与判定）");
  lines.push("");
  const observations = Array.isArray(meta.observations) ? meta.observations : [];
  if (observations.length === 0) {
    lines.push("未记录观测数据。");
  } else {
    for (const item of observations) lines.push(`- ${item}`);
  }
  lines.push("");
  return `${lines.join("\n")}`;
}
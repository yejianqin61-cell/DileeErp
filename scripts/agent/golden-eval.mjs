import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadCases, selectCases } from "./golden-cases.mjs";
import { judgeAll } from "./golden-judge.mjs";
import { renderMarkdown, summarize } from "./golden-report.mjs";
import { fetchBaselineDocs, login, missingBaseline, runCase } from "./golden-runner.mjs";

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readGroups(argv) {
  const groups = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--group") {
      for (const value of String(argv[index + 1] ?? "").split(",")) {
        if (value.trim()) groups.push(value.trim());
      }
    }
  }
  return groups;
}

async function main() {
  const argv = process.argv.slice(2);
  const groups = readGroups(argv);
  const outPath = readFlag(argv, "--out");
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

  const entries = [];
  for (const [index, caseDef] of cases.entries()) {
    const missing = missingBaseline(caseDef, present);
    const outcome = missing.length > 0
      ? { terminal: "unknown", errorCode: null, ops: [], failureCodes: [], sources: [], answer: "", toolCalls: 0, answerChunks: 0, durationMs: 0 }
      : await runCase({ fetchImpl: fetch, apiBase, cookie, caseDef, signal: AbortSignal.timeout(600_000) });
    entries.push({ caseDef, outcome, missing });
    process.stderr.write(`[${index + 1}/${cases.length}] ${caseDef.id} -> ${outcome.terminal}${missing.length > 0 ? " (baseline_missing)" : ""}\n`);
  }

  const judged = entries.map((entry) => {
    const verdict = judgeAll([entry])[0];
    return { ...verdict, failureCodes: entry.outcome.failureCodes };
  });
  const jsonOut = readFlag(argv, "--json-out");
  if (jsonOut) {
    writeFileSync(
      jsonOut,
      `${JSON.stringify({ runAt: new Date().toISOString(), apiBase, judged, entries }, null, 2)}\n`,
      "utf8",
    );
    process.stderr.write(`原始结果已写入 ${jsonOut}\n`);
  }
  const summary = summarize(judged);
  const markdown = renderMarkdown(summary, {
    runAt: new Date().toISOString(),
    apiBase,
    model: process.env.GOLDEN_MODEL ?? "deepseek-chat（AGENT_LLM_PROVIDER=deepseek）",
    baselineNote: process.env.GOLDEN_BASELINE_NOTE ?? "由 scripts/seed-mock-data.mjs 生成的 MOCK-* 幂等种子数据。",
    uncovered: [
      "正向财务用例未覆盖：本地库只有 administrator（数据档位 operational），没有 laoban/caiwu 账号，财务读取的通过路径本批无法验证。",
      "model_steps 未采集：SSE 协议不下发该字段，只有服务端观测日志有；本批只用 tool_calls 与 answer_chunks 做预算判断。",
      "permission 组用的是负向断言（来源不得含财务类 business_type）；若模型根本不去碰财务工具，该断言恒真，信息量偏弱。",
      "答案数值正确性未断言：本批只断言终态、来源单据、调用的 operation、失败码与工具次数预算。通过率高说明链路能跑通、单据能定位，不等于答案里的数字都对。数值正确性要另设一组「已知口径」用例，P1 再做。",
      "失败码是过程信号不是终局：非空失败码的用例只要模型自纠成功仍判通过。所以失败码分布比通过率更能反映工具接口的粗糙程度。",
    ],
    observations: [
      `用例总数：${summary.total}（entry/miss/relation/followup/permission 五组）`,
      `基线单号池：${present.size} 个可识别单号（销售 / 采购 / 生产三源合并）`,
      `未调用模型即判定的用例：${summary.baselineMissing} 条（基线缺单号）`,
      "满宽、全角、部分单号（ORD-001）三条用例都把归一化交给了模型：模型自己把 ＭＯＣＫ－ＯＲＤ－００１ 转成 MOCK-ORD-001 再检索。服务端归一化仍是空白，模型换版本就会变。",
    ],
  });

  if (outPath) {
    writeFileSync(outPath, markdown, "utf8");
    process.stderr.write(`报告已写入 ${outPath}\n`);
  } else {
    process.stdout.write(markdown);
  }
  process.exit(summary.fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
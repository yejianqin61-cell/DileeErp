import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MockLanguageModelV4 } from "ai/test";

import { GROUP_NAMES } from "./gap-experiment/groups.mjs";
import { computeMetrics, decide } from "./gap-experiment/metrics.mjs";
import { runOne as realRunOne } from "./gap-experiment/run-one.mjs";

const QUESTIONS = fileURLToPath(new URL("../../apps/api/test/agent-golden/gap-cases/gap-questions.json", import.meta.url));
const MODEL = "deepseek-chat";
const RUN_TIMEOUT_MS = 180_000;

const readFlag = (argv, name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const positiveInteger = (value) => Number.isInteger(value) && value > 0;

const dryModel = () => new MockLanguageModelV4({
  doGenerate: async () => ({
    content: [{ type: "text", text: "干跑回答" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
    warnings: [],
  }),
});

export async function main(argv, env, { questionsPath = QUESTIONS, runOne = realRunOne, model, log = console.error } = {}) {
  const dry = argv.includes("--dry");
  const out = readFlag(argv, "--out");
  const groups = (readFlag(argv, "--group") ?? GROUP_NAMES.join(",")).split(",").map((name) => name.trim());
  const reps = Number(readFlag(argv, "--reps") ?? 3);
  const limitFlag = readFlag(argv, "--limit");
  const limit = limitFlag === undefined ? undefined : Number(limitFlag);
  if (!out || groups.some((name) => !GROUP_NAMES.includes(name)) || !positiveInteger(reps) || (limit !== undefined && !positiveInteger(limit))) {
    log("用法：node scripts/agent/gap-experiment.mjs [--dry] [--group A,B,C] [--reps 3] [--limit N] --out <目录>");
    return 2;
  }
  const file = JSON.parse(readFileSync(questionsPath, "utf8"));
  if (!dry && !file.reviewedBy) {
    log("题集未审，不实跑");
    return 2;
  }
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!dry && !apiKey) {
    log("缺少 DEEPSEEK_API_KEY");
    return 2;
  }
  let languageModel = model ?? (dry ? dryModel() : undefined);
  if (!languageModel) {
    const { createDeepSeek } = await import("@ai-sdk/deepseek");
    languageModel = createDeepSeek({ apiKey })(MODEL);
  }

  const questions = file.questions.slice(0, limit);
  const directory = resolve(out);
  mkdirSync(directory, { recursive: true });
  const save = (name, value) => writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  const records = [];
  for (const question of questions) {
    for (const group of groups) {
      for (let rep = 1; rep <= reps; rep += 1) {
        try {
          records.push(await runOne({ group, question, model: languageModel, rep, abortSignal: AbortSignal.timeout(RUN_TIMEOUT_MS) }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          records.push({ group, id: question.id, rep, error: apiKey ? message.replaceAll(apiKey, "***") : message });
        }
        save("records.json", records);
        log(`[${records.length}/${questions.length * groups.length * reps}] ${question.id} ${group}#${rep}${records.at(-1).error ? " error" : ""}`);
      }
    }
  }
  const metrics = computeMetrics(records, questions);
  save("metrics.json", { ...metrics, decision: decide(metrics) });
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}

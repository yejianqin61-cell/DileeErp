import { isDeepStrictEqual } from "node:util";

const keyOf = (caseId, rep) => `${caseId}#${rep}`;

const finished = (entry) => entry.missing.length > 0 || entry.outcome.terminal !== "unknown";

function brokenOutcome(error) {
  return {
    terminal: "unknown",
    errorCode: "GOLDEN_RUN_ERROR",
    errorMessage: error instanceof Error ? error.message : String(error),
    ops: [],
    failureCodes: [],
    sources: [],
    answer: "",
    toolCalls: 0,
    answerChunks: 0,
    modelSteps: 0,
    runIds: [],
  };
}

export async function runReps({ cases, reps, previous = [], runOne, save }) {
  const current = new Map(cases.map((caseDef) => [caseDef.id, caseDef]));
  const kept = new Map();
  for (const entry of previous) {
    const caseDef = current.get(entry.caseDef.id);
    if (!caseDef) continue;
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(caseDef)), entry.caseDef)) {
      throw new Error(`快照里的用例 ${entry.caseDef.id} 与当前定义不一致，不能续跑`);
    }
    if (finished(entry)) kept.set(keyOf(caseDef.id, entry.rep), entry);
  }

  const results = new Map(kept);
  const ordered = () => {
    const list = [];
    for (let rep = 1; rep <= reps; rep += 1) {
      for (const caseDef of cases) {
        const entry = results.get(keyOf(caseDef.id, rep));
        if (entry) list.push(entry);
      }
    }
    return list;
  };

  for (let rep = 1; rep <= reps; rep += 1) {
    for (const caseDef of cases) {
      const key = keyOf(caseDef.id, rep);
      if (results.has(key)) continue;
      let result;
      try {
        result = await runOne(caseDef, rep);
      } catch (error) {
        result = { outcome: brokenOutcome(error), missing: [] };
      }
      results.set(key, { caseDef, rep, outcome: result.outcome, missing: result.missing });
      await save(ordered());
    }
  }
  return ordered();
}

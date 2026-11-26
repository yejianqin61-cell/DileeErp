import assert from "node:assert/strict";
import { test } from "node:test";

import { runReps } from "./golden-reps.mjs";
import { mergeOutcomes } from "./golden-runner.mjs";

const cases = [
  { id: "a", group: "entry", question: "问甲", baselineDocs: [], expect: { terminal: "completed" } },
  { id: "b", group: "entry", question: "问乙", baselineDocs: [], expect: { terminal: "completed" } },
];
const done = (caseDef, rep) => ({ caseDef, rep, outcome: { terminal: "completed" }, missing: [] });

function recorder(failOn) {
  const calls = [];
  const saved = [];
  return {
    calls,
    saved,
    runOne: async (caseDef, rep) => {
      calls.push(`${caseDef.id}${rep}`);
      if (failOn === `${caseDef.id}${rep}`) throw new Error("断流");
      return { outcome: { terminal: "completed" }, missing: [] };
    },
    save: async (entries) => saved.push(entries.length),
  };
}

test("从头跑：按轮推进，每项都落盘", async () => {
  const deps = recorder();
  const entries = await runReps({ cases, reps: 3, previous: [], runOne: deps.runOne, save: deps.save });
  assert.deepEqual(deps.calls, ["a1", "b1", "a2", "b2", "a3", "b3"]);
  assert.deepEqual(deps.saved, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(entries.map((entry) => `${entry.caseDef.id}${entry.rep}`), deps.calls);
});

test("续跑只补缺的项", async () => {
  const deps = recorder();
  const previous = [done(cases[0], 1), done(cases[1], 1), done(cases[0], 2), done(cases[1], 2)];
  const entries = await runReps({ cases, reps: 3, previous, runOne: deps.runOne, save: deps.save });
  assert.deepEqual(deps.calls, ["a3", "b3"]);
  assert.equal(entries.length, 6);
});

test("单项抛错记为 unknown 其余照跑，续跑只重跑它", async () => {
  const first = recorder("b1");
  const entries = await runReps({ cases, reps: 2, previous: [], runOne: first.runOne, save: first.save });
  assert.equal(first.calls.length, 4);
  const broken = entries.find((entry) => entry.caseDef.id === "b" && entry.rep === 1);
  assert.equal(broken.outcome.terminal, "unknown");
  assert.equal(broken.outcome.errorCode, "GOLDEN_RUN_ERROR");
  assert.deepEqual(broken.outcome.failureCodes, []);
  const second = recorder();
  const resumed = await runReps({ cases, reps: 2, previous: entries, runOne: second.runOne, save: second.save });
  assert.deepEqual(second.calls, ["b1"]);
  assert.equal(resumed.length, 4);
  assert.equal(resumed.every((entry) => entry.outcome.terminal === "completed"), true);
});

test("基线缺单号的项算有结果，续跑不重跑", async () => {
  const deps = recorder();
  const previous = [{ caseDef: cases[0], rep: 1, outcome: { terminal: "unknown" }, missing: ["MOCK-1"] }];
  await runReps({ cases: [cases[0]], reps: 1, previous, runOne: deps.runOne, save: deps.save });
  assert.deepEqual(deps.calls, []);
});

test("快照里的用例定义与现在不一致时拒绝续跑", async () => {
  const deps = recorder();
  const previous = [done({ ...cases[0], question: "旧问法" }, 1)];
  await assert.rejects(runReps({ cases, reps: 1, previous, runOne: deps.runOne, save: deps.save }), /a/);
  assert.deepEqual(deps.calls, []);
});

test("多问用例保留每一问的轮次号", () => {
  const part = (runId) => ({ runId, terminal: "completed", errorCode: null, ops: [], failureCodes: [], sources: [], answer: "", toolCalls: 0, answerChunks: 0, modelSteps: 1 });
  assert.deepEqual(mergeOutcomes([part("a"), part("b")]).runIds, ["a", "b"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeMetrics, decide } from "./metrics.mjs";

const questions = [
  { id: "g1", class: "gap", nearest: "a" },
  { id: "g2", class: "gap", nearest: "c" },
  { id: "d1", class: "decoy", nearest: "x" },
  { id: "d2", class: "decoy", nearest: "y" },
];
const run = (group, id, rep, nearest, domainCallsBeforeGap = null) => ({
  group, id, rep, domainCallsBeforeGap,
  gap: nearest === null ? null : { nearest_operation: nearest },
});
const records = (group) => [
  run(group, "g1", 1, "a", 1), run(group, "g1", 2, "a", 1), run(group, "g1", 3, "b", 3),
  run(group, "g2", 1, "c", 0), run(group, "g2", 2, "c", 2), run(group, "g2", 3, null),
  run(group, "d1", 1, null), run(group, "d1", 2, null), run(group, "d1", 3, null),
  run(group, "d2", 1, "y", 0), run(group, "d2", 2, null), run(group, "d2", 3, null),
];

test("召回与诱饵误报按该类运行次数计", () => {
  const { C } = computeMetrics(records("C"), questions);
  assert.deepEqual(C.recall, { count: 5, total: 6 });
  assert.deepEqual(C.decoyFp, { count: 1, total: 6 });
});

test("判缺口前调用次数只平均真缺口里判出缺口的运行", () => {
  assert.equal(computeMetrics(records("C"), questions).C.callsBeforeGap, 1.4);
});

test("一致率分母是题数", () => {
  assert.deepEqual(computeMetrics(records("C"), questions).C.consistency, { count: 2, total: 4 });
});

test("最近邻一致率：C 组只算有标注最近邻的缺口运行，A、B 为 null", () => {
  const gapRecords = records("C").filter((item) => item.id.startsWith("g"));
  const metrics = computeMetrics([...gapRecords, ...records("A"), ...records("B")], questions);
  assert.deepEqual(metrics.C.nearestAgree, { count: 4, total: 5 });
  assert.equal(metrics.A.nearestAgree, null);
  assert.equal(metrics.B.nearestAgree, null);
});

test("缺数据与无结构单列；带 error 的记录不进任何分母", () => {
  const extra = [...questions, { id: "n1", class: "nodata", nearest: "z" }, { id: "u1", class: "unstructured", nearest: "w" }];
  const metrics = computeMetrics([run("C", "n1", 1, "z", 0), run("C", "n1", 2, null), run("C", "u1", 1, null), { group: "C", id: "n1", rep: 3, error: "超时" }], extra);
  assert.deepEqual(metrics.C.nodataFp, { count: 1, total: 2 });
  assert.deepEqual(metrics.C.unstructuredGapRate, { count: 0, total: 1 });
  assert.deepEqual(metrics.C.recall, { count: 0, total: 0 });
  assert.equal(metrics.C.callsBeforeGap, null);
  assert.equal(metrics.C.errors, 1);
});

const group = (recall, decoy) => ({ recall: { count: recall, total: 30 }, decoyFp: { count: decoy, total: 30 } });

test("C 恰好达底线且 B 领先不到 10 点：采用 C", () => {
  assert.equal(decide({ A: group(15, 0), B: group(25, 2), C: group(24, 3) }), "adopt_C");
});

test("B 在召回与误报上同时领先 10 点：重开矩阵", () => {
  assert.equal(decide({ A: group(15, 0), B: group(24, 2), C: group(20, 6) }), "reopen_matrix");
});

test("C 达底线但 B 同时领先 10 点：仍重开矩阵", () => {
  assert.equal(decide({ A: group(15, 0), B: group(28, 0), C: group(24, 3) }), "reopen_matrix");
});

test("三组都未达底线：停在观测层", () => {
  assert.equal(decide({ A: group(15, 0), B: group(15, 0), C: group(15, 0) }), "observe_only");
});

test("C 未达底线、B 只在召回上领先：判据未覆盖", () => {
  assert.equal(decide({ A: group(15, 0), B: group(25, 3), C: group(20, 3) }), "undecided");
});

test("缺组或某项分母为 0 时不下结论", () => {
  assert.equal(decide({ C: group(30, 0) }), "undecided");
  const empty = { recall: { count: 0, total: 0 }, decoyFp: { count: 0, total: 0 } };
  assert.equal(decide({ A: empty, B: empty, C: empty }), "undecided");
});

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { GapCandidateService } = require("../../dist/modules/business-query-agent/gap-candidates.js");
const { createPrisma } = require("../helpers/agent-fake-prisma.cjs");

const GAP = { nearest_operation: "list_low_stock_materials", missing: "group_by", missing_detail: "按仓库分组", needed_fields: [], unverified_fields: ["仓库"] };
const report = (session, run, patch = {}) => ({ sessionId: session, runId: run, gap: { ...GAP, ...patch } });
const make = (builder = { async build() { return { dispatched: false }; } }) => {
  const db = createPrisma();
  return { db, service: new GapCandidateService(db, builder) };
};

test("首次声明：一条候选一条记录，会话数 1", async () => {
  const { db, service } = make();
  const result = await service.record(report("s1", "r1"));
  assert.equal(db.store.gapCandidates.length, 1);
  assert.equal(db.store.gapCandidates[0].status, "accumulating");
  assert.equal(db.store.gapReports.length, 1);
  assert.deepEqual(result, { candidateId: db.store.gapCandidates[0].id, sessionCount: 1 });
});

test("同键短语不同仍是同一条候选", async () => {
  const { db, service } = make();
  await service.record(report("s1", "r1"));
  const result = await service.record(report("s2", "r2", { missing_detail: "分仓库看" }));
  assert.equal(db.store.gapCandidates.length, 1);
  assert.equal(db.store.gapReports.length, 2);
  assert.equal(result.sessionCount, 2);
});

test("异键产生不同候选", async () => {
  const { db, service } = make();
  await service.record(report("s1", "r1"));
  await service.record(report("s2", "r3", { missing: "filter" }));
  assert.equal(db.store.gapCandidates.length, 2);
});

test("同会话再报不加会话数，同一轮重复不加记录", async () => {
  const { db, service } = make();
  await service.record(report("s1", "r1"));
  await service.record(report("s2", "r2"));
  const again = await service.record(report("s1", "r4"));
  assert.equal(db.store.gapReports.length, 3);
  assert.equal(again.sessionCount, 2);
  await service.record(report("s1", "r4"));
  assert.equal(db.store.gapReports.length, 3);
});

test("记录行只含约定字段，不含问题原文", async () => {
  const { db, service } = make();
  await service.record(report("s1", "r1", { missing_param: "status" }));
  const { id, createdAt, ...row } = db.store.gapReports[0];
  assert.deepEqual(Object.keys(row).sort(), ["candidateId", "missingDetail", "missingParam", "neededFields", "runId", "sessionId", "unverifiedFields"]);
  assert.equal(row.missingParam, "status");
});

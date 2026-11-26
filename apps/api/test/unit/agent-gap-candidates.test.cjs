const assert = require("node:assert/strict");
const { test } = require("node:test");
const { GapCandidateService, LoggingGapTicketBuilder, GAP_PROMOTION_THRESHOLD } = require("../../dist/modules/business-query-agent/gap-candidates.js");
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

const recorder = (outcome = { dispatched: false }) => ({ tickets: [], async build(ticket) { this.tickets.push(ticket); return outcome; } });

test("两个不同会话未达门槛 3", async () => {
  const builder = recorder();
  const { db, service } = make(builder);
  await service.record(report("s1", "r1"));
  await service.record(report("s2", "r2"));
  assert.equal(builder.tickets.length, 0);
  assert.equal(db.store.gapCandidates[0].status, "accumulating");
});

test("同一会话三个轮次不算三次", async () => {
  const builder = recorder();
  const { service } = make(builder);
  for (const run of ["r1", "r2", "r3"]) await service.record(report("s1", run));
  assert.equal(builder.tickets.length, 0);
});

test("第三个会话：调一次建单器，工单只含约定内容", async () => {
  assert.equal(GAP_PROMOTION_THRESHOLD, 3);
  const builder = recorder();
  const { db, service } = make(builder);
  await service.record(report("s1", "r1", { needed_fields: ["SalesOrder.orderNo"] }));
  await service.record(report("s2", "r2", { missing_detail: "分仓库看", missing_param: "q" }));
  await service.record(report("s3", "r3", { needed_fields: ["SalesOrder.orderNo"] }));
  assert.deepEqual(builder.tickets, [{
    candidate_id: db.store.gapCandidates[0].id,
    nearest_operation: "list_low_stock_materials",
    missing: "group_by",
    missing_details: ["按仓库分组", "分仓库看"],
    missing_params: ["q"],
    needed_fields: ["SalesOrder.orderNo"],
    unverified_fields: ["仓库"],
    session_count: 3,
  }]);
});

for (const dispatched of [true, false]) {
  test(`升级后再报不重复调用；送出结果 ${dispatched}`, async () => {
    const builder = recorder({ dispatched });
    const { db, service } = make(builder);
    for (const n of [1, 2, 3, 4]) await service.record(report(`s${n}`, `r${n}`));
    assert.equal(builder.tickets.length, 1);
    assert.equal(db.store.gapCandidates[0].status, "ready");
    assert.equal(db.store.gapCandidates[0].dispatchedAt instanceof Date, dispatched);
  });
}

test("建单器抛错：声明照常记下，候选停在待开工未送出", async () => {
  const { db, service } = make({ async build() { throw new Error("通道不可用"); } });
  for (const n of [1, 2]) await service.record(report(`s${n}`, `r${n}`));
  const result = await service.record(report("s3", "r3"));
  assert.equal(result.sessionCount, 3);
  assert.equal(db.store.gapCandidates[0].status, "ready");
  assert.equal(db.store.gapCandidates[0].dispatchedAt, null);
});

test("默认建单器只记日志，返回未送出", async () => {
  assert.deepEqual(await new LoggingGapTicketBuilder().build({ candidate_id: "c", nearest_operation: "x", missing: "filter" }), { dispatched: false });
});

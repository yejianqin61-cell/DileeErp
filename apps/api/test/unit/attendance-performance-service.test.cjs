const assert = require("node:assert/strict");
const test = require("node:test");
const { AttendancePerformanceService } = require("../../dist/modules/hr/attendance-performance.service.js");

test("attendance update locks and rechecks the current record", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "attendance-1", workStartTime: "09:00", workEndTime: "18:00" };
  const prisma = { attendanceRecord: { findFirst: async () => ({ ...row, deletedAt: null }), update: async () => { updateCount += 1; return row; } }, $transaction: async (fn) => fn({ $queryRaw: async () => { lockCount += 1; }, attendanceRecord: prisma.attendanceRecord }) };
  const service = new AttendancePerformanceService(prisma, { update: () => ({}), record: async () => {} });
  const result = await service.updateAttendance(row.id, { work_start_time: "10:00" }, { id: "user-1" });
  assert.equal(result.id, row.id);
  assert.equal(lockCount, 1); assert.equal(updateCount, 1);
});

test("performance update locks and rechecks the current record", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "performance-1", score: null, grade: null, rewardAmount: null };
  const prisma = { performanceRecord: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } }, $transaction: async (fn) => fn({ $queryRaw: async () => { lockCount += 1; }, performanceRecord: prisma.performanceRecord }) };
  const service = new AttendancePerformanceService(prisma, { update: () => ({}), record: async () => {} });
  const result = await service.updatePerformance(row.id, { grade: "A" }, { id: "user-1" });
  assert.equal(result.id, row.id);
  assert.equal(lockCount, 1); assert.equal(updateCount, 1);
});

test("attendance deletion locks and rechecks the current record", async () => {
  let lockCount = 0;
  let updateCount = 0;
  const row = { id: "attendance-1", deletedAt: null };
  const prisma = { attendanceRecord: { findFirst: async () => row, update: async () => { updateCount += 1; return row; } }, $transaction: async (fn) => fn({ $queryRaw: async () => { lockCount += 1; }, attendanceRecord: prisma.attendanceRecord }) };
  const service = new AttendancePerformanceService(prisma, { update: () => ({}), record: async () => {} });
  const result = await service.removeAttendance(row.id, "录入错误", { id: "user-1" });
  assert.equal(result.id, row.id);
  assert.equal(lockCount, 1); assert.equal(updateCount, 1);
});

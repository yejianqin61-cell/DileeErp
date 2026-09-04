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

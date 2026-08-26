const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { AttendancePerformanceService } = require("../dist/modules/hr/attendance-performance.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => {} };

test("attendance summary stores work start and end times", async () => {
  let data;
  const service = new AttendancePerformanceService({ employee: { findFirst: async () => ({ id: "employee-1" }) }, attendanceRecord: { create: async ({ data: input }) => { data = input; return { id: "attendance-1", ...input }; } } }, audit);
  await service.createAttendance({ employee_id: "employee-1", attendance_date: "2026-08-26", attendance_type: "出勤", work_start_time: "09:00", work_end_time: "18:00" }, user);
  assert.equal(data.workStartTime, "09:00");
  assert.equal(data.workEndTime, "18:00");
});

test("attendance summary rejects an end time before the start time", async () => {
  const service = new AttendancePerformanceService({ employee: { findFirst: async () => ({ id: "employee-1" }) } }, audit);
  await assert.rejects(() => service.createAttendance({ employee_id: "employee-1", attendance_date: "2026-08-26", attendance_type: "出勤", work_start_time: "18:00", work_end_time: "09:00" }, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INVALID_ATTENDANCE_WORK_TIME");
});

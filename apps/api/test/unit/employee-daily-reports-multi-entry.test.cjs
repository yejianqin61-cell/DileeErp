const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { UnprocessableEntityException } = require("@nestjs/common");
const { EmployeeDailyReportsService } = require("../../dist/modules/production/employee-daily-reports.service.js");

// 本文件锁定本轮三项生产需求的后端契约：
// 1) 同一员工在同一生产单同一工序同一天可以重复登记多条日报（不再合并、不再拦截重复目标/混合计薪方式）；
// 2) 计时单位统一为小时（duration_hours 录入，落库仍为分钟；金额 = 小时 × 元/小时）；
// 3) 备注（remark）可写入、可在更正时清空。

const order = { id: "order-1", orderNo: "SO-1", productionOrderNo: "MO-1", executionMode: "in_house", status: "in_progress" };
const operation = { id: "operation-1", productionOrderId: "order-1", operationNameSnapshot: "缝制", status: "active", targetQuantity: new Prisma.Decimal("500") };
const employee = { id: "employee-1", name: "张三", employeeNo: "E001", employmentStatus: "active", employeeType: "workshop", hiredOn: null, leftOn: null };

function auditStub() {
  return { create: () => ({}), update: () => ({}), softDelete: () => ({}), record: async () => undefined };
}

/** 内存版 Prisma 替身：只实现员工日报写入路径真正会碰到的方法。 */
function buildClient(rows) {
  return {
    $queryRaw: async () => [],
    productionOrder: { findFirst: async () => order, findUniqueOrThrow: async () => order },
    productionOrderOperation: { findFirst: async () => operation, findUniqueOrThrow: async () => operation },
    employee: { findFirst: async () => employee },
    operationDailyReport: { aggregate: async () => ({ _sum: { completedQuantity: null } }) },
    productionDailyAlert: { findUnique: async () => null, upsert: async () => ({}), update: async () => ({}) },
    productionPayrollSource: { findFirst: async () => null, upsert: async () => ({}), update: async () => ({}) },
    payrollLedger: { findMany: async () => [] },
    auditEvent: { create: async () => ({}) },
    employeeDailyReport: {
      findFirst: async ({ where }) => {
        if (where.id) return rows.find((row) => row.id === where.id && !row.deletedAt) ?? null;
        if (where.idempotencyKey) return rows.find((row) => row.idempotencyKey === where.idempotencyKey) ?? null;
        return null;
      },
      findMany: async () => rows.filter((row) => !row.deletedAt),
      create: async ({ data }) => {
        const row = { id: `report-${rows.length + 1}`, version: 1, ...data, durationMinutes: data.durationMinutes ?? null, remark: data.remark ?? null };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        const row = rows.find((item) => item.id === where.id);
        Object.assign(row, data);
        return row;
      },
      aggregate: async () => ({ _sum: { quantity: null, calculatedAmount: null } }),
    },
  };
}

function buildService() {
  const rows = [];
  const client = buildClient(rows);
  const prisma = { ...client, $transaction: async (fn) => fn(client) };
  const progress = { recalculateInTransaction: async () => undefined };
  return { rows, service: new EmployeeDailyReportsService(prisma, auditStub(), progress) };
}

const pieceInput = (overrides = {}) => ({ production_order_id: "order-1", production_order_operation_id: "operation-1", employee_id: "employee-1", report_date: "2026-09-03", wage_mode: "piece_rate", quantity: "10", unit_price: "2", ...overrides });

test("同一员工同一天同一工序同一计薪方式可以重复登记多条日报（不再合并/去重）", async () => {
  const { rows, service } = buildService();
  const user = { id: "user-1" };
  const first = await service.create(pieceInput({ remark: "上午" }), user);
  const second = await service.create(pieceInput({ remark: "下午" }), user);
  assert.equal(rows.length, 2, "两次登记必须生成两条独立日报，而不是合并成一条");
  assert.notEqual(first.id, second.id);
  assert.equal(first.quantity.toString(), "10");
  assert.equal(second.quantity.toString(), "10");
  assert.equal(first.remark, "上午");
  assert.equal(second.remark, "下午");
});

test("未填写备注时落库为 null（而不是空串），保持历史数据口径一致", async () => {
  const { service } = buildService();
  const blank = await service.create(pieceInput({ remark: "   " }), { id: "user-1" });
  assert.equal(blank.remark, null);
  const omitted = await service.create(pieceInput(), { id: "user-1" });
  assert.equal(omitted.remark, null);
});

test("同一员工同一天同一工序可以混合使用计件与计时（两条独立日报）", async () => {
  const { rows, service } = buildService();
  const user = { id: "user-1" };
  await service.create(pieceInput({ quantity: "10", unit_price: "2" }), user);
  const timed = await service.create(pieceInput({ wage_mode: "time_rate", quantity: "0", duration_hours: "2", unit_price: "30" }), user);
  assert.equal(rows.length, 2, "计件与计时必须能同时存在");
  assert.equal(timed.wageMode, "time_rate");
  assert.equal(timed.calculatedAmount.toString(), "60");
});

test("计时按小时录入：1.5 小时 × 40 元/小时 = 60 元，落库仍为 90 分钟", async () => {
  const { service } = buildService();
  const created = await service.create(pieceInput({ wage_mode: "time_rate", quantity: "0", duration_hours: "1.5", unit_price: "40" }), { id: "user-1" });
  assert.equal(created.durationMinutes.toString(), "90");
  assert.equal(created.calculatedAmount.toString(), "60");
  assert.equal(created.unitPrice.toString(), "40");
});

test("历史 duration_minutes 仍按分钟解释，金额与小时口径一致（90 分钟 = 1.5 小时 × 40）", async () => {
  const { service } = buildService();
  const created = await service.create(pieceInput({ wage_mode: "time_rate", quantity: "0", duration_minutes: "90", unit_price: "40" }), { id: "user-1" });
  assert.equal(created.durationMinutes.toString(), "90");
  assert.equal(created.calculatedAmount.toString(), "60", "历史分钟入参也必须按小时单价折算，不能再用 分钟 × 单价");
});

test("同时提交 duration_hours 与 duration_minutes 必须被拒绝（避免单位歧义）", async () => {
  const { rows, service } = buildService();
  await assert.rejects(
    () => service.create(pieceInput({ wage_mode: "time_rate", quantity: "0", duration_hours: "1", duration_minutes: "60", unit_price: "40" }), { id: "user-1" }),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INVALID_EMPLOYEE_REPORT_DURATION",
  );
  assert.equal(rows.length, 0);
});

test("计时日报仍必须填写时长，且小时数不接受 0/负数/科学计数法", async () => {
  const { service } = buildService();
  const expectCode = (code) => (error) => error instanceof UnprocessableEntityException && error.getResponse().code === code;
  await assert.rejects(() => service.create(pieceInput({ wage_mode: "time_rate", quantity: "0", unit_price: "40" }), { id: "user-1" }), expectCode("TIME_REPORT_DURATION_REQUIRED"));
  await assert.rejects(() => service.create(pieceInput({ wage_mode: "time_rate", quantity: "0", duration_hours: "0", unit_price: "40" }), { id: "user-1" }), expectCode("INVALID_EMPLOYEE_REPORT_DURATION"));
  await assert.rejects(() => service.create(pieceInput({ wage_mode: "time_rate", quantity: "0", duration_hours: "1e2", unit_price: "40" }), { id: "user-1" }), expectCode("INVALID_EMPLOYEE_REPORT_DURATION"));
});

test("更正日报：目标日期已存在同员工同日记录也不再被拦截（允许重复条目）", async () => {
  const rows = [
    { id: "report-1", version: 1, productionOrderId: "order-1", productionOrderOperationId: "operation-1", employeeId: "employee-1", orderNo: "SO-1", reportDate: new Date("2026-09-03T00:00:00.000Z"), wageMode: "piece_rate", quantity: new Prisma.Decimal("10"), durationMinutes: null, unitPrice: new Prisma.Decimal("2"), calculatedAmount: new Prisma.Decimal("20"), remark: null },
    { id: "report-2", version: 1, productionOrderId: "order-1", productionOrderOperationId: "operation-1", employeeId: "employee-1", orderNo: "SO-1", reportDate: new Date("2026-09-03T00:00:00.000Z"), wageMode: "piece_rate", quantity: new Prisma.Decimal("5"), durationMinutes: null, unitPrice: new Prisma.Decimal("2"), calculatedAmount: new Prisma.Decimal("10"), remark: null },
  ];
  const client = buildClient(rows);
  const service = new EmployeeDailyReportsService({ ...client, $transaction: async (fn) => fn(client) }, auditStub(), { recalculateInTransaction: async () => undefined });
  const updated = await service.update("report-1", { quantity: "12", reason: "补录错误" }, { id: "user-1" });
  assert.equal(updated.quantity.toString(), "12");
  assert.equal(rows.length, 2, "更正不得删除或合并同一员工的另一条日报");
});

test("更正日报：同一员工同一天可以改成与另一条不同的计薪方式（不再有单计薪方式限制）", async () => {
  const rows = [
    { id: "report-1", version: 1, productionOrderId: "order-1", productionOrderOperationId: "operation-1", employeeId: "employee-1", orderNo: "SO-1", reportDate: new Date("2026-09-03T00:00:00.000Z"), wageMode: "piece_rate", quantity: new Prisma.Decimal("10"), durationMinutes: null, unitPrice: new Prisma.Decimal("2"), calculatedAmount: new Prisma.Decimal("20"), remark: null },
    { id: "report-2", version: 1, productionOrderId: "order-1", productionOrderOperationId: "operation-1", employeeId: "employee-1", orderNo: "SO-1", reportDate: new Date("2026-09-03T00:00:00.000Z"), wageMode: "time_rate", quantity: new Prisma.Decimal("0"), durationMinutes: new Prisma.Decimal("60"), unitPrice: new Prisma.Decimal("40"), calculatedAmount: new Prisma.Decimal("40"), remark: null },
  ];
  const client = buildClient(rows);
  const service = new EmployeeDailyReportsService({ ...client, $transaction: async (fn) => fn(client) }, auditStub(), { recalculateInTransaction: async () => undefined });
  const updated = await service.update("report-1", { wage_mode: "time_rate", duration_hours: "2", unit_price: "40", reason: "改按计时" }, { id: "user-1" });
  assert.equal(updated.wageMode, "time_rate");
  assert.equal(updated.calculatedAmount.toString(), "80", "改为计时后应按 2 小时 × 40 元/小时 重算");
  assert.equal(updated.durationMinutes.toString(), "120");
});

test("更正日报备注：空串表示清空（落库 null），未提交则保持原值", async () => {
  const make = () => ({
    id: "report-1", version: 1, productionOrderId: "order-1", productionOrderOperationId: "operation-1", employeeId: "employee-1", orderNo: "SO-1", reportDate: new Date("2026-09-03T00:00:00.000Z"), wageMode: "piece_rate", quantity: new Prisma.Decimal("10"), durationMinutes: null, unitPrice: new Prisma.Decimal("2"), calculatedAmount: new Prisma.Decimal("20"), remark: "原始备注",
  });
  const rows = [make()];
  const client = buildClient(rows);
  const service = new EmployeeDailyReportsService({ ...client, $transaction: async (fn) => fn(client) }, auditStub(), { recalculateInTransaction: async () => undefined });
  const kept = await service.update("report-1", { quantity: "11", reason: "只改件数" }, { id: "user-1" });
  assert.equal(kept.remark, "原始备注", "未提交备注时不得清空原备注");
  const cleared = await service.update("report-1", { remark: "", reason: "清空备注" }, { id: "user-1" });
  assert.equal(cleared.remark, null, "提交空串表示清空备注");
});

// 用户已确认的口径：切到小时单价后不得回溯重算历史日报金额（历史台账/薪资来源不能被改写）。
// 因此“只改备注/只改件数以外字段”的 PATCH 必须保留原 calculated_amount 快照。
test("只改备注的更正不得重算历史计时日报金额（历史快照保持不变）", async () => {
  const rows = [{
    id: "report-1", version: 1, productionOrderId: "order-1", productionOrderOperationId: "operation-1", employeeId: "employee-1", orderNo: "SO-1", reportDate: new Date("2026-09-03T00:00:00.000Z"), wageMode: "time_rate", quantity: new Prisma.Decimal("0"), durationMinutes: new Prisma.Decimal("90"), unitPrice: new Prisma.Decimal("2"), calculatedAmount: new Prisma.Decimal("180"), remark: null,
  }];
  const client = buildClient(rows);
  const service = new EmployeeDailyReportsService({ ...client, $transaction: async (fn) => fn(client) }, auditStub(), { recalculateInTransaction: async () => undefined });
  const kept = await service.update("report-1", { remark: "补备注", reason: "补备注" }, { id: "user-1" });
  assert.equal(kept.remark, "补备注");
  assert.equal(kept.calculatedAmount.toString(), "180", "历史金额快照不得被静默重算");
  assert.equal(kept.durationMinutes.toString(), "90", "历史分钟数不得被改写");
});

test("显式修改计时时长/单价时才按 小时 × 元/小时 重算金额", async () => {
  const rows = [{
    id: "report-1", version: 1, productionOrderId: "order-1", productionOrderOperationId: "operation-1", employeeId: "employee-1", orderNo: "SO-1", reportDate: new Date("2026-09-03T00:00:00.000Z"), wageMode: "time_rate", quantity: new Prisma.Decimal("0"), durationMinutes: new Prisma.Decimal("90"), unitPrice: new Prisma.Decimal("2"), calculatedAmount: new Prisma.Decimal("180"), remark: null,
  }];
  const client = buildClient(rows);
  const service = new EmployeeDailyReportsService({ ...client, $transaction: async (fn) => fn(client) }, auditStub(), { recalculateInTransaction: async () => undefined });
  const updated = await service.update("report-1", { unit_price: "40", reason: "改用元/小时单价" }, { id: "user-1" });
  assert.equal(updated.calculatedAmount.toString(), "60", "1.5 小时 × 40 元/小时 = 60");
  assert.equal(updated.durationMinutes.toString(), "90", "只改单价不得改动时长");
});

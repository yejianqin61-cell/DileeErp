const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { UnprocessableEntityException } = require("@nestjs/common");
const { EmployeeDailyReportsService } = require("../../dist/modules/production/employee-daily-reports.service.js");
const { EmployeeDailyReportsController } = require("../../dist/modules/production/employee-daily-reports.controller.js");

// 本文件锁定本轮三项生产需求的后端契约：
// 1) 同一员工在同一生产单同一工序同一天可以重复登记多条日报（不再合并、不再拦截重复目标/混合计薪方式）；
// 2) 计时单位统一为小时（duration_hours 录入，落库仍为分钟；金额 = 小时 × 元/小时）；
// 3) 备注（remark）可写入、可在更正时清空。

const order = { id: "order-1", orderNo: "SO-1", productionOrderNo: "MO-1", executionMode: "in_house", status: "in_progress" };
const operation = { id: "operation-1", productionOrderId: "order-1", operationNameSnapshot: "缝制", status: "active", targetQuantity: new Prisma.Decimal("500") };
const employee = { id: "employee-1", name: "张三", employeeNo: "E001", employmentStatus: "active", employeeType: "workshop", hiredOn: null, leftOn: null };

function auditStub() {
  // softDelete 必须真的写入 deletedAt，否则替身里的“已删除”行仍会被 findMany 取到，掩盖重算逻辑。
  return { create: () => ({}), update: () => ({}), softDelete: () => ({ deletedAt: new Date(), deletedBy: "user-1" }), record: async () => undefined };
}

/** 内存版 Prisma 替身：只实现员工日报写入路径真正会碰到的方法。 */
function buildClient(rows) {
  const client = {
    /** 每次薪资来源 upsert 的写入内容，用于验证“重复条目是否被聚合并进入工资结算”。 */
    payrollSourceWrites: [],
    $queryRaw: async () => [],
    productionOrder: { findFirst: async () => order, findUniqueOrThrow: async () => order },
    productionOrderOperation: { findFirst: async () => operation, findUniqueOrThrow: async () => operation },
    employee: { findFirst: async () => employee },
    operationDailyReport: { aggregate: async () => ({ _sum: { completedQuantity: null } }) },
    productionDailyAlert: { findUnique: async () => null, upsert: async () => ({}), update: async () => ({}) },
    productionPayrollSource: { findFirst: async () => null, upsert: async ({ update }) => { client.payrollSourceWrites.push(update); return {}; }, update: async () => ({}) },
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
  return client;
}

function buildService() {
  const rows = [];
  const client = buildClient(rows);
  const prisma = { ...client, $transaction: async (fn) => fn(client) };
  const progress = { recalculateInTransaction: async () => undefined };
  return { rows, client, service: new EmployeeDailyReportsService(prisma, auditStub(), progress) };
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

// 工资结算链路：同一员工同一天的多条日报必须被聚合进同一条薪资来源（唯一键 = 员工+生产单+日期+计薪方式），
// 金额求和而不是覆盖，且快照里保留每一条日报，工资侧才能逐条追溯。
test("重复登记的多条日报会被聚合进同一条薪资来源（金额求和、快照留全量明细）", async () => {
  const { rows, client, service } = buildService();
  const user = { id: "user-1" };
  const first = await service.create(pieceInput({ quantity: "10", unit_price: "2" }), user);
  const second = await service.create(pieceInput({ quantity: "15", unit_price: "2" }), user);
  const latest = client.payrollSourceWrites[client.payrollSourceWrites.length - 1];
  assert.equal(rows.length, 2);
  assert.equal(latest.quantity.toString(), "25", "件数必须求和：10 + 15");
  assert.equal(latest.amount.toString(), "50", "金额必须求和：20 + 30，不得只保留最后一条");
  assert.deepEqual(latest.sourceSnapshot.map((item) => item.id).sort(), [first.id, second.id].sort(), "快照必须包含全部重复日报，便于追溯");
});

test("计时薪资来源同时给出分钟（落库）与小时（对外）口径", async () => {
  const { client, service } = buildService();
  await service.create(pieceInput({ wage_mode: "time_rate", quantity: "0", duration_hours: "1.5", unit_price: "40" }), { id: "user-1" });
  await service.create(pieceInput({ wage_mode: "time_rate", quantity: "0", duration_hours: "0.5", unit_price: "40" }), { id: "user-1" });
  const latest = client.payrollSourceWrites[client.payrollSourceWrites.length - 1];
  assert.equal(latest.durationMinutes.toString(), "120", "1.5 + 0.5 小时 = 120 分钟（落库口径）");
  assert.equal(latest.amount.toString(), "80", "2 小时 × 40 元/小时 = 80 元");
  assert.deepEqual(latest.sourceSnapshot.map((item) => item.duration_hours), ["1.5", "0.5"], "快照按小时给出每条日报时长");
});

test("删除重复条目中的一条后，薪资来源按剩余条目重算（不会残留已删条目的金额）", async () => {
  const { client, service } = buildService();
  const user = { id: "user-1" };
  await service.create(pieceInput({ quantity: "10", unit_price: "2" }), user);
  const second = await service.create(pieceInput({ quantity: "15", unit_price: "2" }), user);
  await service.remove(second.id, "重复登记，删除一条", user);
  const latest = client.payrollSourceWrites[client.payrollSourceWrites.length - 1];
  assert.equal(latest.amount.toString(), "20", "删除后只应保留第一条的 20 元");
  assert.equal(latest.sourceSnapshot.length, 1);
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

test("更正日报备注：空串或 null 都表示清空（落库 null），未提交则保持原值", async () => {
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
  // DTO 的 @IsOptional() 会放过 null（不是 undefined），必须同样安全而不是抛 TypeError 变成 500。
  await service.update("report-1", { remark: "再写一次", reason: "写回备注" }, { id: "user-1" });
  const nulled = await service.update("report-1", { remark: null, reason: "清空备注" }, { id: "user-1" });
  assert.equal(nulled.remark, null, "提交 null 也必须被当作清空而不是 500");
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

test("前端“只改备注”实际发出的整包字段也不得重算历史计时日报金额（回归：只比字段是否存在会误判）", async () => {
  // 旧口径的历史数据：90 分钟 × 2 元/分钟 = 180 元。切到小时单价后，若仅因为“请求里带了 unit_price”
  // 就按 90/60 × 2 重算，会把 180 元静默改成 3 元并波及工资台账。
  const rows = [{
    id: "report-1", version: 1, productionOrderId: "order-1", productionOrderOperationId: "operation-1", employeeId: "employee-1", orderNo: "SO-1", reportDate: new Date("2026-09-03T00:00:00.000Z"), wageMode: "time_rate", quantity: new Prisma.Decimal("0"), durationMinutes: new Prisma.Decimal("90"), unitPrice: new Prisma.Decimal("2"), calculatedAmount: new Prisma.Decimal("180"), remark: null,
  }];
  const client = buildClient(rows);
  const service = new EmployeeDailyReportsService({ ...client, $transaction: async (fn) => fn(client) }, auditStub(), { recalculateInTransaction: async () => undefined });
  const kept = await service.update("report-1", { quantity: "0", duration_hours: "1.5", unit_price: "2", remark: "补备注", reason: "补备注" }, { id: "user-1" });
  assert.equal(kept.calculatedAmount.toString(), "180", "同值字段回传不得触发重算");
  assert.equal(kept.durationMinutes.toString(), "90", "小时文案与当前展示值一致时不得改写历史分钟数");
});

test("历史 100 分钟的展示往返（1.6667 小时）回传时不得把时长改成 100.002 分钟", async () => {
  const rows = [{
    id: "report-1", version: 1, productionOrderId: "order-1", productionOrderOperationId: "operation-1", employeeId: "employee-1", orderNo: "SO-1", reportDate: new Date("2026-09-03T00:00:00.000Z"), wageMode: "time_rate", quantity: new Prisma.Decimal("0"), durationMinutes: new Prisma.Decimal("100"), unitPrice: new Prisma.Decimal("2"), calculatedAmount: new Prisma.Decimal("200"), remark: null,
  }];
  const client = buildClient(rows);
  const service = new EmployeeDailyReportsService({ ...client, $transaction: async (fn) => fn(client) }, auditStub(), { recalculateInTransaction: async () => undefined });
  const kept = await service.update("report-1", { duration_hours: "1.6667", remark: "补备注", reason: "补备注" }, { id: "user-1" });
  assert.equal(kept.durationMinutes.toString(), "100", "展示值回传必须识别为未修改");
  assert.equal(kept.calculatedAmount.toString(), "200", "不得因展示往返而重算金额");
});

// 半值处 JS 的 Number.toFixed 与 decimal.js 的 ROUND_HALF_UP 会分歧（33.333 分钟：前端曾显示 0.5555、后端算 0.5556），
// 早期实现用“文案是否相等”判断时长是否被改动，这类历史值会被误判成已修改 → 改写时长并重算金额。
test("半值历史分钟（33.333 / 100.005 / 1.005）在“更正弹窗不改任何值”的整包回传下不得改写时长或金额", async () => {
  const cases = [
    { minutes: "33.333", clientText: "0.5555", serverText: "0.5556", unitPrice: "40", amount: "1333.32" },
    { minutes: "100.005", clientText: "1.6667", serverText: "1.6668", unitPrice: "40", amount: "4000.2" },
    { minutes: "1.005", clientText: "0.0167", serverText: "0.0168", unitPrice: "40", amount: "40.2" },
  ];
  for (const item of cases) {
    for (const durationText of [item.clientText, item.serverText]) {
      const rows = [{
        id: "report-1", version: 1, productionOrderId: "order-1", productionOrderOperationId: "operation-1", employeeId: "employee-1", orderNo: "SO-1", reportDate: new Date("2026-09-03T00:00:00.000Z"), wageMode: "time_rate", quantity: new Prisma.Decimal("0"), durationMinutes: new Prisma.Decimal(item.minutes), unitPrice: new Prisma.Decimal(item.unitPrice), calculatedAmount: new Prisma.Decimal(item.amount), remark: null,
      }];
      const client = buildClient(rows);
      const service = new EmployeeDailyReportsService({ ...client, $transaction: async (fn) => fn(client) }, auditStub(), { recalculateInTransaction: async () => undefined });
      const kept = await service.update("report-1", { quantity: "0", duration_hours: durationText, unit_price: item.unitPrice, remark: "", reason: "只改备注" }, { id: "user-1" });
      assert.equal(kept.durationMinutes.toString(), item.minutes, `${item.minutes} 分钟回传 ${durationText} 后时长不得被改写`);
      assert.equal(kept.calculatedAmount.toString(), item.amount, `${item.minutes} 分钟回传 ${durationText} 后金额不得被重算`);
    }
  }
});

test("服务端小时文案与前端 hoursText 在半值处完全一致（否则守卫依赖的文案比较会失效）", async () => {
  const cases = [["0.009", "0.0002"], ["1.005", "0.0168"], ["30.003", "0.5001"], ["33.333", "0.5556"], ["100.005", "1.6668"], ["120.015", "2.0003"]];
  for (const [minutes, expected] of cases) {
    const rows = [{
      id: "report-1", version: 1, productionOrderId: "order-1", productionOrderOperationId: "operation-1", employeeId: "employee-1", orderNo: "SO-1", reportDate: new Date("2026-09-03T00:00:00.000Z"), wageMode: "time_rate", quantity: new Prisma.Decimal("0"), durationMinutes: new Prisma.Decimal(minutes), unitPrice: new Prisma.Decimal("1"), calculatedAmount: new Prisma.Decimal("0"), remark: null,
    }];
    const client = buildClient(rows);
    const service = new EmployeeDailyReportsService({ ...client, $transaction: async (fn) => fn(client) }, auditStub(), { recalculateInTransaction: async () => undefined });
    const sources = await service.payrollSources({ from: "2026-09-01", to: "2026-09-30" });
    assert.equal(sources[0].duration_hours, expected, `${minutes} 分钟 -> ${expected} 小时（必须与前端 hoursText 一致）`);
  }
});

test("时长（小时）× 60 溢出 Decimal(18,4) 时必须 422，不能落到数据库 500", async () => {
  const { service } = buildService();
  await assert.rejects(
    () => service.create(pieceInput({ wage_mode: "time_rate", quantity: "0", duration_hours: "99999999999999.9999", unit_price: "1" }), { id: "user-1" }),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INVALID_EMPLOYEE_REPORT_DURATION",
  );
});

test("金额溢出 Decimal(18,4) 时必须 422，不能落到数据库 500", async () => {
  const { service } = buildService();
  await assert.rejects(
    () => service.create(pieceInput({ quantity: "99999999999999", unit_price: "99999999999999" }), { id: "user-1" }),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INVALID_EMPLOYEE_REPORT_AMOUNT",
  );
});

// 批量明细是原始 JSON 字符串（rows），绕过 DTO 的 @MaxLength(1000)，必须在控制器单独兜住，
// 否则超长备注会直接撞上 varchar(1000) 变成 500。
test("批量日报备注超过 1000 字必须 422（DTO 长度限制对 rows 无效）", async () => {
  let called = 0;
  const controller = new EmployeeDailyReportsController({ createBatch: async () => { called += 1; return []; } });
  const body = (remark) => ({ production_order_id: "order-1", production_order_operation_id: "operation-1", report_date: "2026-09-03", rows: JSON.stringify([{ employee_id: "employee-1", wage_mode: "piece_rate", remark }]) });
  await assert.rejects(
    () => controller.createBatch(body("字".repeat(1001)), { id: "user-1" }),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INVALID_EMPLOYEE_DAILY_REPORT_ROW",
  );
  assert.equal(called, 0, "超长备注不得进入服务层");
  await controller.createBatch(body("字".repeat(1000)), { id: "user-1" });
  assert.equal(called, 1, "正好 1000 字必须放行");
});

test("批量日报字段类型不是字符串时必须 422（否则会在服务层抛 TypeError 变成 500）", async () => {
  let called = 0;
  const controller = new EmployeeDailyReportsController({ createBatch: async () => { called += 1; return []; } });
  for (const row of [{ employee_id: "employee-1", wage_mode: "piece_rate", remark: 123 }, { employee_id: "employee-1", wage_mode: "piece_rate", quantity: 10 }, { employee_id: "employee-1", wage_mode: "piece_rate", unit_price: 2 }]) {
    await assert.rejects(
      () => controller.createBatch({ production_order_id: "order-1", production_order_operation_id: "operation-1", report_date: "2026-09-03", rows: JSON.stringify([row]) }, { id: "user-1" }),
      (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INVALID_EMPLOYEE_DAILY_REPORT_ROW",
      `非字符串字段必须被拒绝：${JSON.stringify(row)}`,
    );
  }
  assert.equal(called, 0);
});

// 单行各自合法，但当日合计可能超出 Decimal(18,4)（整数部分 14 位）。原先会写库失败变成 500，
// 现在必须在服务层提前 422，并让整笔事务回滚（不留下半条日报）。
test("当日薪资合计超出 Decimal(18,4) 时必须 422 而不是数据库 500", async () => {
  const seeded = [1, 2].map((index) => ({
    id: `report-${index}`, version: 1, productionOrderId: "order-1", productionOrderOperationId: "operation-1", employeeId: "employee-1", orderNo: "SO-1", reportDate: new Date("2026-09-03T00:00:00.000Z"), wageMode: "piece_rate", quantity: new Prisma.Decimal("1"), durationMinutes: null, unitPrice: new Prisma.Decimal("1"), calculatedAmount: new Prisma.Decimal("99999999999999.9999"), remark: null,
  }));
  const client = buildClient(seeded);
  const service = new EmployeeDailyReportsService({ ...client, $transaction: async (fn) => fn(client) }, auditStub(), { recalculateInTransaction: async () => undefined });
  await assert.rejects(
    () => service.create(pieceInput({ quantity: "1", unit_price: "1" }), { id: "user-1" }),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PAYROLL_SOURCE_AMOUNT_OUT_OF_RANGE",
  );
});

test("更正日报同时提交两种时长单位必须被拒绝（与新增口径一致）", async () => {
  const rows = [{
    id: "report-1", version: 1, productionOrderId: "order-1", productionOrderOperationId: "operation-1", employeeId: "employee-1", orderNo: "SO-1", reportDate: new Date("2026-09-03T00:00:00.000Z"), wageMode: "time_rate", quantity: new Prisma.Decimal("0"), durationMinutes: new Prisma.Decimal("90"), unitPrice: new Prisma.Decimal("40"), calculatedAmount: new Prisma.Decimal("60"), remark: null,
  }];
  const client = buildClient(rows);
  const service = new EmployeeDailyReportsService({ ...client, $transaction: async (fn) => fn(client) }, auditStub(), { recalculateInTransaction: async () => undefined });
  await assert.rejects(
    () => service.update("report-1", { duration_hours: "2", duration_minutes: "120", reason: "改时长" }, { id: "user-1" }),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INVALID_EMPLOYEE_REPORT_DURATION",
  );
  assert.equal(rows[0].durationMinutes.toString(), "90", "被拒绝的请求不得写入任何时长");
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

// 生产工资汇总口径的单元测试（纯函数，不需要数据库）。
//
// 这一层承载用户需求里最硬的一条：「不能漏掉任何一单任何一个工序任何一天」。
// 因此用例重点不是算术，而是**分组与覆盖度**：跨订单、跨工序、跨日期、跨计薪方式、
// 同日同工序多条日报都必须各自留下痕迹，且金额与日报逐条求和一致。
const assert = require("node:assert/strict");
const test = require("node:test");
const { Prisma } = require("@prisma/client");
const { aggregateProductionPayroll, emptyProductionPayroll, groupProductionPayroll, hoursText } = require("../../dist/modules/hr/production-payroll.domain.js");

const dec = (value) => new Prisma.Decimal(value);

function dailyReport(overrides = {}) {
  return {
    id: "report-1",
    employeeId: "employee-1",
    reportDate: new Date("2026-09-01T00:00:00.000Z"),
    productionOrderId: "order-1",
    orderNo: "SO-1",
    operationId: "op-1",
    operationName: "裁剪",
    wageMode: "piece_rate",
    quantity: dec("20"),
    durationMinutes: dec("0"),
    amount: dec("40"),
    ...overrides,
  };
}

test("没有任何日报时金额为 0、明细为空（非车间员工与空月份都走这条）", () => {
  const empty = emptyProductionPayroll("employee-1");
  assert.equal(empty.employee_id, "employee-1");
  assert.equal(empty.amount.toString(), "0");
  assert.deepEqual(empty.lines, []);
  assert.equal(empty.report_count, 0);
  assert.equal(aggregateProductionPayroll([]).lines.length, 0);
});

test("跨订单、跨工序、跨日期、跨计薪方式的日报一条都不漏", () => {
  const summary = aggregateProductionPayroll([
    dailyReport({ id: "r1", reportDate: new Date("2026-09-01T00:00:00.000Z"), productionOrderId: "o1", orderNo: "SO-1", operationId: "op1", operationName: "裁剪", amount: dec("40") }),
    dailyReport({ id: "r2", reportDate: new Date("2026-09-01T00:00:00.000Z"), productionOrderId: "o1", orderNo: "SO-1", operationId: "op2", operationName: "缝制", amount: dec("35.5") }),
    dailyReport({ id: "r3", reportDate: new Date("2026-09-02T00:00:00.000Z"), productionOrderId: "o1", orderNo: "SO-1", operationId: "op1", operationName: "裁剪", amount: dec("12") }),
    dailyReport({ id: "r4", reportDate: new Date("2026-09-02T00:00:00.000Z"), productionOrderId: "o2", orderNo: "SO-2", operationId: "op9", operationName: "包装", wageMode: "time_rate", quantity: dec("0"), durationMinutes: dec("90"), amount: dec("60") }),
  ]);
  assert.equal(summary.lines.length, 4, "四天×单×工序的组合必须各自成行");
  assert.equal(summary.amount.toString(), "147.5", "金额是日报逐条求和（40 + 35.5 + 12 + 60）");
  assert.equal(summary.report_count, 4);
  assert.equal(summary.day_count, 2);
  assert.equal(summary.order_count, 2);
  assert.equal(summary.operation_count, 3, "同一工序在不同日期只算一个工序");
  assert.equal(summary.quantity.toString(), "60", "件数逐条累加（计时日报填 0 件）");
  assert.equal(summary.duration_minutes.toString(), "90");
});

test("同一员工同日同工序的多条日报合并成一行：条数与日报 ID 全留，金额按各笔累加", () => {
  const summary = aggregateProductionPayroll([
    dailyReport({ id: "r1", quantity: dec("10"), amount: dec("50") }),
    dailyReport({ id: "r2", quantity: dec("10"), amount: dec("70") }),
  ]);
  assert.equal(summary.lines.length, 1);
  assert.equal(summary.lines[0].report_count, 2);
  assert.deepEqual(summary.lines[0].report_ids, ["r1", "r2"]);
  assert.equal(summary.lines[0].amount, "120", "10@5 + 10@7 = 120，不能被末次单价覆盖成 140 或 70");
  assert.equal(summary.lines[0].quantity, "20");
  assert.equal(summary.amount.toString(), "120");
  assert.equal(summary.report_count, 2);
});

test("同一单同一天的不同计薪方式分行（计件与计时不能混成一个金额）", () => {
  const summary = aggregateProductionPayroll([
    dailyReport({ id: "r1", wageMode: "piece_rate", amount: dec("40") }),
    dailyReport({ id: "r2", wageMode: "time_rate", quantity: dec("0"), durationMinutes: dec("480"), amount: dec("360") }),
  ]);
  assert.equal(summary.lines.length, 2);
  assert.deepEqual(summary.lines.map((line) => line.wage_mode), ["piece_rate", "time_rate"]);
  assert.deepEqual(summary.lines.map((line) => line.duration_hours), ["0", "8"]);
  assert.equal(summary.amount.toString(), "400");
});

test("明细按日期、订单号、工序排序，金额与逐行之和一致", () => {
  const summary = aggregateProductionPayroll([
    dailyReport({ id: "r3", reportDate: new Date("2026-09-03T00:00:00.000Z"), productionOrderId: "o2", orderNo: "SO-2", operationId: "op9", operationName: "包装", amount: dec("5") }),
    dailyReport({ id: "r1", reportDate: new Date("2026-09-01T00:00:00.000Z"), productionOrderId: "o1", orderNo: "SO-1", operationId: "op1", operationName: "裁剪", amount: dec("7") }),
    dailyReport({ id: "r2", reportDate: new Date("2026-09-01T00:00:00.000Z"), productionOrderId: "o1", orderNo: "SO-1", operationId: "op1", operationName: "裁剪", amount: dec("11") }),
  ]);
  assert.deepEqual(summary.lines.map((line) => line.report_date), ["2026-09-01", "2026-09-03"]);
  const total = summary.lines.reduce((sum, line) => sum.plus(line.amount), dec("0"));
  assert.equal(total.toString(), summary.amount.toString(), "台账金额必须等于快照逐行之和，否则财务核对时对不上");
  assert.equal(summary.amount.toString(), "23");
});

test("月度导入按员工分组：每个员工各得一份汇总，未出现的员工不凭空产生台账", () => {
  const grouped = groupProductionPayroll([
    dailyReport({ id: "r1", employeeId: "e1", amount: dec("40") }),
    dailyReport({ id: "r2", employeeId: "e2", productionOrderId: "o2", orderNo: "SO-2", amount: dec("60") }),
    dailyReport({ id: "r3", employeeId: "e1", reportDate: new Date("2026-09-05T00:00:00.000Z"), amount: dec("10") }),
  ]);
  assert.deepEqual([...grouped.keys()].sort(), ["e1", "e2"]);
  assert.equal(grouped.get("e1").amount.toString(), "50");
  assert.equal(grouped.get("e1").day_count, 2);
  assert.equal(grouped.get("e2").amount.toString(), "60");
});

test("时长换算与生产侧同一口径（分钟 → 小时，去尾随零，极小非零值提升精度）", () => {
  assert.equal(hoursText(dec("90")), "1.5");
  assert.equal(hoursText(dec("480")), "8");
  assert.equal(hoursText(dec("0")), "0");
  assert.equal(hoursText(null), "");
  assert.equal(hoursText(undefined), "");
  assert.equal(hoursText(dec("1")), "0.0167");
  assert.notEqual(hoursText(dec("0.0001")), "0", "极小非零时长不能显示成 0");
});

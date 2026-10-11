const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const XLSX = require("xlsx");
const { ProductionPayrollExportService, ROW_TOTAL_LABEL, MONTHLY_OPERATION_SUMMARY_SHEET } = require("../dist/modules/production/production-payroll-export.service.js");

// 生产月报表（`GET /production/reports/monthly-production-report.xlsx`）：总表＝订单 × 工序矩阵，
// 第二张「工序月度汇总」＝一行一个工序（全月跨所有订单），另给每道工序一张明细 sheet。
// 形状照用户手工台账 example/财务/2026.6月同安.xlsx。
//
// 这里要钉住的都是**静默出错**的口径，错了界面看不出来、只会把错的数印到车间墙上：
//   1) 数量＝max(工序日报, 员工日报) **逐日**取大后累加：同一天不能相加（重复计数），
//      也不能整月取大（3 号录工序日报、7 号录员工日报时会丢掉一半）；
//   2) 总表单元格、工序明细 sheet 的汇总列、工序月度汇总三处必须来自**同一份逐日取大结果**：
//      总表格子 = 该工序明细的「汇总数量」；而工序汇总按 (工序, 单位, 执行方式) 切成明细行，
//      所以它是**加总关系** —— 同一道工序各行相加 = 总表该工序列各订单格子相加（不是逐行相等）；
//   3) 拉边按生产单执行方式分本厂/外发（本厂与外发是两批不同的活）；
//   4) 数量**不跨单位合计**（全站纪律，reorder.domain.ts:11）：多单位时按单位分行列出，绝不相加；
//   5) 模板外的工序（剪线头）只要有数据就要有一列，不能因为不在模板里就丢掉数量；
//   6) 所有数量/单价/金额都必须是 Excel 数值单元格（文本型数字在 Excel 里不能求和/筛选/排序）；
//   7) 软删除的日报两个面都不能进表；
//   8) 审计事件照旧记在 production_payroll_export / employee_daily_report 上。
//
// 这个文件直接 new 服务并喂一个**按 where 真的过滤**的假 prisma：只有真的执行 deletedAt/月份边界，
// 「软删除被排除」这种断言才算断言，而不是断言「我把 where 传下去了」。

const MONTH = "2026-06";

function day(text) {
  return new Date(`${text}T00:00:00.000Z`);
}

/** 员工日报行：只给本导出真正读到的列（employee/department 关系这条路径不用）。 */
function employeeReport(overrides) {
  return {
    id: overrides.id ?? `er-${Math.random().toString(36).slice(2)}`,
    orderNo: "SO-2026-001",
    operationNameSnapshot: "缝伞",
    productionOrderOperationId: "opr-sew-1",
    employeeNameSnapshot: "张三",
    reportDate: day("2026-06-03"),
    wageMode: "piece_rate",
    quantity: new Prisma.Decimal("0"),
    unitPrice: new Prisma.Decimal("0.3"),
    calculatedAmount: new Prisma.Decimal("0"),
    deletedAt: null,
    createdBy: "user-1",
    updatedBy: "user-2",
    ...overrides,
  };
}

/** 工序日报行（没有员工维度）。 */
function operationReport(overrides) {
  return { orderNo: "SO-2026-001", operationNameSnapshot: "缝伞", productionOrderOperationId: "opr-sew-1", reportDate: day("2026-06-10"), completedQuantity: new Prisma.Decimal("0"), deletedAt: null, ...overrides };
}

/** 夹具：两张订单、八道生产单工序（含一个外包拉边、一个异单位包装）、员工面与工序面各若干。 */
function fixture() {
  return {
    catalog: ["大裁", "拉边", "小裁", "验片", "合片", "剪线头", "打顶打带", "打珠尾", "缝伞", "品检", "折伞", "外发加工", "其他", "包装"].map((operationName) => ({ operationName, deletedAt: null })),
    operations: [
      { id: "opr-cut-1", unit: { name: "支" }, productionOrder: { executionMode: "in_house" } },
      { id: "opr-sew-1", unit: { name: "支" }, productionOrder: { executionMode: "in_house" } },
      { id: "opr-edge-in", unit: { name: "支" }, productionOrder: { executionMode: "in_house" } },
      { id: "opr-edge-out", unit: { name: "支" }, productionOrder: { executionMode: "outsourced" } },
      { id: "opr-trim", unit: { name: "支" }, productionOrder: { executionMode: "in_house" } },
      { id: "opr-sew-2", unit: { name: "支" }, productionOrder: { executionMode: "in_house" } },
      { id: "opr-pack-pc", unit: { name: "支" }, productionOrder: { executionMode: "in_house" } },
      { id: "opr-pack-dz", unit: { name: "打" }, productionOrder: { executionMode: "in_house" } },
    ],
    salesOrders: [
      { orderNo: "SO-2026-001", quantity: new Prisma.Decimal("1000"), productSpec: "30*8K 自动伞", deletedAt: null },
      { orderNo: "SO-2026-002", quantity: new Prisma.Decimal("500"), productSpec: "21*8K 三折伞", deletedAt: null },
    ],
    employeeReports: [
      // 缝伞（SO-001）：3 号只有员工面、10 号两面都填（40 / 60，取大 60）、20 号只有工序面 30 => 100 + 60 + 30 = 190
      employeeReport({ id: "er-1", reportDate: day("2026-06-03"), employeeNameSnapshot: "张三", quantity: new Prisma.Decimal("100"), calculatedAmount: new Prisma.Decimal("30") }),
      employeeReport({ id: "er-2", reportDate: day("2026-06-10"), employeeNameSnapshot: "李四", quantity: new Prisma.Decimal("40"), calculatedAmount: new Prisma.Decimal("12") }),
      // 大裁（SO-001）：同一天员工面 200 / 工序面 150，取大 200（相加会是 350）
      employeeReport({ id: "er-3", operationNameSnapshot: "大裁", productionOrderOperationId: "opr-cut-1", reportDate: day("2026-06-05"), quantity: new Prisma.Decimal("200"), unitPrice: new Prisma.Decimal("0.035"), calculatedAmount: new Prisma.Decimal("7") }),
      // 拉边（SO-001）：本厂 50（工序面 55 => 取大 55）、外发 70（只有员工面）
      employeeReport({ id: "er-4", operationNameSnapshot: "拉边", productionOrderOperationId: "opr-edge-in", reportDate: day("2026-06-06"), employeeNameSnapshot: "王五", quantity: new Prisma.Decimal("50"), unitPrice: new Prisma.Decimal("0.05"), calculatedAmount: new Prisma.Decimal("2.5") }),
      employeeReport({ id: "er-5", operationNameSnapshot: "拉边", productionOrderOperationId: "opr-edge-out", reportDate: day("2026-06-06"), employeeNameSnapshot: "赵六", quantity: new Prisma.Decimal("70"), unitPrice: new Prisma.Decimal("0.05"), calculatedAmount: new Prisma.Decimal("3.5") }),
      // 剪线头：模板里没有这道工序，但字典里有、当月有数据 => 必须出现一列
      employeeReport({ id: "er-6", operationNameSnapshot: "剪线头", productionOrderOperationId: "opr-trim", reportDate: day("2026-06-07"), quantity: new Prisma.Decimal("33"), unitPrice: new Prisma.Decimal("0.02"), calculatedAmount: new Prisma.Decimal("0.66") }),
      // 第二张订单：缝伞 20
      employeeReport({ id: "er-7", orderNo: "SO-2026-002", operationNameSnapshot: "缝伞", productionOrderOperationId: "opr-sew-2", reportDate: day("2026-06-08"), employeeNameSnapshot: "孙七", quantity: new Prisma.Decimal("20"), calculatedAmount: new Prisma.Decimal("6") }),
      // 包装（SO-002）：同一个工人同一天在**两个单位**下各报一次（支 60 / 打 4）=> 不合计
      employeeReport({ id: "er-8", orderNo: "SO-2026-002", operationNameSnapshot: "包装", productionOrderOperationId: "opr-pack-pc", reportDate: day("2026-06-09"), employeeNameSnapshot: "周八", quantity: new Prisma.Decimal("60"), unitPrice: new Prisma.Decimal("2.4"), calculatedAmount: new Prisma.Decimal("144") }),
      employeeReport({ id: "er-9", orderNo: "SO-2026-002", operationNameSnapshot: "包装", productionOrderOperationId: "opr-pack-dz", reportDate: day("2026-06-09"), employeeNameSnapshot: "周八", quantity: new Prisma.Decimal("4"), unitPrice: new Prisma.Decimal("2.4"), calculatedAmount: new Prisma.Decimal("9.6") }),
      // 软删除：任何一面都不该进表（999 一旦出现，缝伞就会变成 1189）
      employeeReport({ id: "er-10", reportDate: day("2026-06-11"), employeeNameSnapshot: "张三", quantity: new Prisma.Decimal("999"), deletedAt: day("2026-06-12") }),
      // 上个月的日报：月份边界（5 月 31 日）不能漏进来
      employeeReport({ id: "er-11", reportDate: new Date("2026-05-31T00:00:00.000Z"), employeeNameSnapshot: "张三", quantity: new Prisma.Decimal("777") }),
    ],
    operationReports: [
      operationReport({ reportDate: day("2026-06-10"), completedQuantity: new Prisma.Decimal("60") }),
      operationReport({ reportDate: day("2026-06-20"), completedQuantity: new Prisma.Decimal("30") }),
      operationReport({ operationNameSnapshot: "大裁", productionOrderOperationId: "opr-cut-1", reportDate: day("2026-06-05"), completedQuantity: new Prisma.Decimal("150") }),
      operationReport({ operationNameSnapshot: "拉边", productionOrderOperationId: "opr-edge-in", reportDate: day("2026-06-06"), completedQuantity: new Prisma.Decimal("55") }),
      operationReport({ orderNo: "SO-2026-002", operationNameSnapshot: "包装", productionOrderOperationId: "opr-pack-pc", reportDate: day("2026-06-09"), completedQuantity: new Prisma.Decimal("60") }),
      operationReport({ reportDate: day("2026-06-12"), completedQuantity: new Prisma.Decimal("888"), deletedAt: day("2026-06-13") }),
    ],
  };
}

/** 假 prisma：只实现本导出用到的查询，但 where（deletedAt / 月份边界 / orderNo / id）与 orderBy 都真的执行。 */
function createPrisma(state) {
  const matchWhere = (row, where = {}) => {
    if ("deletedAt" in where && where.deletedAt === null && row.deletedAt !== null) return false;
    if (where.orderNo) {
      if (where.orderNo.in) { if (!where.orderNo.in.includes(row.orderNo)) return false; }
      else if (row.orderNo !== where.orderNo) return false;
    }
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (where.reportDate) {
      if (where.reportDate.gte && row.reportDate < where.reportDate.gte) return false;
      if (where.reportDate.lt && row.reportDate >= where.reportDate.lt) return false;
    }
    return true;
  };
  const applyOrderBy = (rows, orderBy = []) => [...rows].sort((left, right) => {
    for (const clause of Array.isArray(orderBy) ? orderBy : [orderBy]) {
      const [field, direction] = Object.entries(clause)[0];
      const a = left[field];
      const b = right[field];
      if (a === b) continue;
      const result = a < b ? -1 : 1;
      return direction === "desc" ? -result : result;
    }
    return 0;
  });
  const groupBy = (rows, { by, where }, sumField) => {
    const groups = new Map();
    for (const row of rows.filter((item) => matchWhere(item, where))) {
      const key = by.map((field) => (row[field] instanceof Date ? row[field].toISOString() : String(row[field]))).join("|");
      const group = groups.get(key) ?? { row, sum: new Prisma.Decimal(0) };
      group.sum = group.sum.plus(row[sumField] ?? 0);
      groups.set(key, group);
    }
    return [...groups.values()].map((group) => ({ ...Object.fromEntries(by.map((field) => [field, group.row[field]])), _sum: { [sumField]: group.sum } }));
  };
  return {
    employeeDailyReport: { findMany: async ({ where, orderBy, take }) => { const rows = applyOrderBy(state.employeeReports.filter((row) => matchWhere(row, where)), orderBy); return typeof take === "number" ? rows.slice(0, take) : rows; } },
    operationDailyReport: { groupBy: async ({ by, where }) => groupBy(state.operationReports, { by, where }, "completedQuantity") },
    operationCatalog: { findMany: async ({ where, orderBy }) => applyOrderBy(state.catalog.filter((row) => matchWhere(row, where)), orderBy) },
    salesOrder: { findMany: async ({ where }) => state.salesOrders.filter((row) => matchWhere(row, where)) },
    productionOrderOperation: { findMany: async ({ where }) => state.operations.filter((row) => matchWhere(row, where)) },
  };
}

/** 导出一次，返回 { book, audit }；audit 收下每一次审计事件（断言审计真的记了）。 */
async function exportMonthlyProduction(state = fixture()) {
  const audit = { calls: [], record: async (...args) => { audit.calls.push(args); } };
  const service = new ProductionPayrollExportService(createPrisma(state), audit, { namesOf: async () => new Map() });
  const buffer = await service.exportMonthlyProduction({ month: MONTH }, { id: "user-1", username: "admin" });
  return { book: XLSX.read(buffer, { type: "buffer" }), audit, buffer };
}

function rowsOf(book, sheetName) {
  return XLSX.utils.sheet_to_json(book.Sheets[sheetName], { header: 1, raw: true, defval: null });
}

/** 总表里某个订单号那一行。 */
function summaryRow(book, orderNo) {
  return rowsOf(book, "生产月报表").find((row) => Array.isArray(row) && row[1] === orderNo);
}

/** 明细 sheet 里某个订单号那一行（明细的首列就是订单号）。 */
function detailRow(book, sheetName, orderNo) {
  return rowsOf(book, sheetName).find((row) => Array.isArray(row) && row[0] === orderNo);
}

function tableHeader(book, sheetName) {
  const rows = rowsOf(book, sheetName);
  return rows.find((row) => Array.isArray(row) && row[0] === "订单号");
}

/** 总表表头（首列是「月份」，与明细的「订单号」区分开）。 */
function summaryHeader(book) {
  return rowsOf(book, "生产月报表").find((row) => Array.isArray(row) && row[0] === "月份");
}

function lastRow(book, sheetName) {
  const rows = rowsOf(book, sheetName);
  return rows[rows.length - 1];
}

/**
 * 不变量：任何「看起来是数字」的单元格都必须是数值型（t === "n"）。
 * 文本型数字在 Excel 里是一格文字：SUM 得 0、筛选分不出区间、排序按字典序（"100" < "20"）。
 * 覆盖**整个工作簿的每一张 sheet**，新增列只要写成字符串就会被抓住。
 *
 * 唯一豁免是**标识符列**（订单号 / 工序）：订单号是标识符不是数量（车间台账里就是 240206 这种纯数字写法），
 * 写成文本才不会丢前导零、也不会被 Excel 当成科学计数法，且它永远不参与求和。
 * 工序月度汇总表的「工序」列同理（工序名本身不会是纯数字，但它是这一行的标识符）。
 */
function assertNoTextNumbers(book, label) {
  const offenders = [];
  const HEADER_FIRST_CELLS = ["月份", "订单号", "工序"];
  for (const sheetName of book.SheetNames) {
    const rows = rowsOf(book, sheetName);
    const headerRow = rows.findIndex((row) => Array.isArray(row) && HEADER_FIRST_CELLS.includes(row[0]));
    const orderColumn = rows[headerRow][0] === "月份" ? 1 : 0;
    const range = XLSX.utils.decode_range(book.Sheets[sheetName]["!ref"]);
    for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
      for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
        const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
        const cell = book.Sheets[sheetName][address];
        if (!cell || cell.t !== "s" || typeof cell.v !== "string") continue;
        if (rowIndex > headerRow && columnIndex === orderColumn) continue;
        if (/^-?\d+(\.\d+)?$/.test(cell.v.trim())) offenders.push(`${sheetName}!${address}=${cell.v}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `${label}：不允许把数字写成文本单元格（Excel 里无法求和/筛选/排序）`);
}

function cellType(book, sheetName, rowIndex, columnIndex) {
  const cell = book.Sheets[sheetName][XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
  return cell ? cell.t : undefined;
}

// ------------------------------------------------------------------ 口径：逐日取大

test("月报数量＝两源逐日取大后累加：不是整月取大，也不是两面相加", async () => {
  const { book } = await exportMonthlyProduction();
  const header = summaryHeader(book);
  const row = summaryRow(book, "SO-2026-001");
  const sewIndex = header.indexOf("缝伞");
  // 6-03 只有员工面 100；6-10 员工面 40 / 工序面 60 => 60；6-20 只有工序面 30 => 100 + 60 + 30 = 190
  assert.equal(row[sewIndex], 190, "缝伞应为逐日取大后累加 190");
  // 三个「看起来都合理」的错答案，钉住它们不会悄悄回来：
  assert.notEqual(row[sewIndex], 230, "两面相加会双重计数（100+40+60+30）");
  assert.notEqual(row[sewIndex], 140, "整月取大会丢掉「另一天才录的那个面」（max(140, 90)）");
  assert.notEqual(row[sewIndex], 1189, "软删除的 999 与上月的 777 都不该进来");
});

test("同一天两个面都报了数时取大，绝不相加", async () => {
  const { book } = await exportMonthlyProduction();
  const header = summaryHeader(book);
  const row = summaryRow(book, "SO-2026-001");
  // 大裁：6-05 员工面 200、工序面 150
  assert.equal(row[header.indexOf("大裁")], 200, "大裁同日两面应取大 200");
  assert.notEqual(row[header.indexOf("大裁")], 350, "同日两面相加会重复计数");
  // 拉边本厂：6-06 员工面 50、工序面 55
  assert.equal(row[header.indexOf("拉边-本厂")], 55, "拉边本厂同日两面应取大 55");
});

test("软删除的日报两个面都不进表（月份边界同样）", async () => {
  const { book } = await exportMonthlyProduction();
  const sew = rowsOf(book, "缝伞");
  const text = JSON.stringify(sew);
  assert.equal(text.includes("999"), false, "软删除的员工日报不得出现");
  assert.equal(text.includes("888"), false, "软删除的工序日报不得出现（工序面也不进汇总）");
  assert.equal(text.includes("777"), false, "上个月的日报不得出现（月份边界是 [当月1日, 下月1日)）");
});

// ------------------------------------------------------------------ 总表 ↔ 明细一致性

test("总表单元格与对应工序明细 sheet 的汇总列同源同值", async () => {
  const { book } = await exportMonthlyProduction();
  const header = summaryHeader(book);
  const pairs = [
    ["大裁", "SO-2026-001"],
    ["拉边-本厂", "SO-2026-001"],
    ["拉边-外发", "SO-2026-001"],
    ["剪线头", "SO-2026-001"],
    ["缝伞", "SO-2026-001"],
    ["缝伞", "SO-2026-002"],
    ["包装", "SO-2026-002"],
  ];
  for (const [column, orderNo] of pairs) {
    const summaryValue = summaryRow(book, orderNo)[header.indexOf(column)];
    const detail = detailRow(book, column, orderNo);
    const detailHeader = tableHeader(book, column);
    const value = detail[detailHeader.indexOf("汇总数量")];
    assert.equal(value, summaryValue, `${column} / ${orderNo}：明细汇总必须与总表同值`);
  }
});

test("明细的工人列之和可能小于汇总数量（工序日报多于员工日报），并在备注里说明", async () => {
  const { book } = await exportMonthlyProduction();
  const rows = rowsOf(book, "缝伞");
  const header = rows.find((row) => Array.isArray(row) && row[0] === "订单号");
  const detail = detailRow(book, "缝伞", "SO-2026-001");
  // 工人列：张三 100（6-03）、李四 40（6-10）=> 140；汇总 190（6-20 的 30 只有工序日报）
  assert.equal(detail[header.indexOf("张三 数量")], 100);
  assert.equal(detail[header.indexOf("李四 数量")], 40);
  assert.equal(detail[header.indexOf("汇总数量")], 190);
  assert.match(String(detail[header.indexOf("备注")]), /工序日报与员工日报同日不一致/, "两源同日不一致必须写在备注里");
});

test("明细 sheet 的元信息写明口径与「工人列只来自员工日报」", async () => {
  const { book } = await exportMonthlyProduction();
  const rows = rowsOf(book, "缝伞");
  const scope = rows.find((row) => row[0] === "数据范围")[1];
  const caliber = rows.find((row) => row[0] === "口径说明")[1];
  assert.match(scope, /员工日报/);
  assert.match(caliber, /max\(工序日报日合计, 员工日报日合计\)/);
  assert.match(caliber, /工人列之和可能小于汇总数量/);
  assert.match(caliber, /不跨单位合计/);
});

// ------------------------------------------------------------------ 列集合：拉边拆分 / 模板外工序

test("拉边按生产单执行方式拆成本厂/外发两列两张 sheet", async () => {
  const { book } = await exportMonthlyProduction();
  const header = summaryHeader(book);
  assert.ok(header.includes("拉边-本厂") && header.includes("拉边-外发"), "总表必须有拉边-本厂 / 拉边-外发两列");
  assert.equal(header.includes("拉边"), false, "不得再有一个混合的执行方式不清的「拉边」列");
  const row = summaryRow(book, "SO-2026-001");
  assert.equal(row[header.indexOf("拉边-本厂")], 55, "本厂取大 55（员工 50 / 工序 55）");
  assert.equal(row[header.indexOf("拉边-外发")], 70, "外发只有员工面 70，不能被本厂的数掩盖");
  assert.equal(detailRow(book, "拉边-本厂", "SO-2026-001")[tableHeader(book, "拉边-本厂").indexOf("汇总数量")], 55);
  assert.equal(detailRow(book, "拉边-外发", "SO-2026-001")[tableHeader(book, "拉边-外发").indexOf("汇总数量")], 70);
});

test("模板外的工序（剪线头）只要有数据就出现一列一张 sheet，数量不被丢掉", async () => {
  const { book } = await exportMonthlyProduction();
  const header = summaryHeader(book);
  assert.ok(header.includes("剪线头"), "模板没写、字典有、当月有数据的工序必须补一列");
  assert.ok(book.SheetNames.includes("剪线头"), "该工序必须有明细 sheet");
  assert.equal(summaryRow(book, "SO-2026-001")[header.indexOf("剪线头")], 33);
});

test("工序字典删掉某道工序后，当月数据仍占一列（列集合读字典，但数量绝不静默丢掉）", async () => {
  const state = fixture();
  state.catalog = state.catalog.filter((row) => row.operationName !== "包装");
  const { book } = await exportMonthlyProduction(state);
  const header = summaryHeader(book);
  assert.ok(header.includes("包装"), "字典里已没有包装，但当月有数据 => 仍须出列，否则 64 件产量凭空消失");
  // 它会从模板段掉到末尾的「已不在字典里的历史工序名」段：排在字典里还有的工序（剪线头）之后。
  assert.ok(header.indexOf("包装") > header.indexOf("剪线头"));
  assert.equal(summaryRow(book, "SO-2026-002")[header.indexOf("包装")], "4 打 + 60 支");
  assert.ok(book.SheetNames.includes("包装"));
});

// ------------------------------------------------------------------ 数值 / 单位

test("数量、单价、金额都是数值单元格：整个工作簿不允许出现文本型数字", async () => {
  const { book } = await exportMonthlyProduction();
  assertNoTextNumbers(book, "生产月报表");
  const header = summaryHeader(book);
  const summaryRows = rowsOf(book, "生产月报表");
  const headerIndex = summaryRows.findIndex((row) => Array.isArray(row) && row[0] === "月份");
  for (const column of ["大裁", "拉边-本厂", "缝伞", "剪线头"]) {
    assert.equal(cellType(book, "生产月报表", headerIndex + 1, header.indexOf(column)), "n", `总表 ${column} 必须是数值单元格`);
  }
  // 明细：单价与金额也必须是数值
  const detailHeader = tableHeader(book, "缝伞");
  const detailIndex = rowsOf(book, "缝伞").findIndex((row) => Array.isArray(row) && row[0] === "订单号");
  for (const column of ["单价", "张三 数量", "张三 金额", "汇总数量", "汇总金额"]) {
    assert.equal(cellType(book, "缝伞", detailIndex + 1, detailHeader.indexOf(column)), "n", `明细 ${column} 必须是数值单元格`);
  }
});

test("多单位不静默相加：包装一格拆成两个单位分行写，末列标「单位不一致，不合计」", async () => {
  const { book } = await exportMonthlyProduction();
  const header = summaryHeader(book);
  const value = summaryRow(book, "SO-2026-002")[header.indexOf("包装")];
  assert.equal(typeof value, "string", "多单位格必须是文字（给数字就等于跨单位合计）");
  assert.match(value, /60 支/);
  assert.match(value, /4 打/);
  assert.notEqual(value, 64, "60 支 + 4 打 不能加起来变成 64");
  assert.equal(summaryRow(book, "SO-2026-002")[header.indexOf(ROW_TOTAL_LABEL)], "单位不一致，不合计", "跨单位的行不给合计数字");
  // 单单位的行仍然给数值合计：200 大裁 + 55 拉边本厂 + 70 拉边外发 + 190 缝伞 + 33 剪线头
  assert.equal(summaryRow(book, "SO-2026-001")[header.indexOf(ROW_TOTAL_LABEL)], 548);
  // 列名本身必须写明「非完工量」：横向相加会把同一批货数好几遍（缝伞 218 + 包装 218 = 436，而订单只有 218），
  // 写在备注里的口径没人会读，列名是唯一一定会被看到的地方。
  assert.equal(ROW_TOTAL_LABEL, "各工序合计（非完工量）");
  // 明细 sheet 的工人数量列同样不跨单位合计；金额是元，照常相加
  const packHeader = tableHeader(book, "包装");
  const packTotal = lastRow(book, "包装");
  assert.equal(typeof packTotal[packHeader.indexOf("周八 数量")], "string", "工人数量格也必须按单位分行");
  assert.match(packTotal[packHeader.indexOf("周八 数量")], /60 支/);
  assert.equal(packTotal[packHeader.indexOf("周八 金额")], 153.6, "金额是元，跨单位也要照常相加");
});

// ------------------------------------------------------------------ 工序月度汇总（一行一个工序）

// 2026-10-11 用户转述财务：「月报表就是工序的汇总表」。
// 总表是「一个订单一行 × 工序横向展开」，财务要的是「一行一个工序 × 全月跨所有订单」——
// 核算表的「计件人工」就是按工序逐道累加出来的，她拿这张表才能和账对上。

function operationSummaryHeader(book) {
  return rowsOf(book, MONTHLY_OPERATION_SUMMARY_SHEET).find((row) => Array.isArray(row) && row[0] === "工序");
}

/** 工序汇总表里某一行的某列（同一道工序有多行时按执行方式区分）。 */
function operationSummaryRow(book, operationName, executionMode = null) {
  return rowsOf(book, MONTHLY_OPERATION_SUMMARY_SHEET).find(
    (row) => Array.isArray(row) && row[0] === operationName && (executionMode === null || row[1] === executionMode),
  );
}

test("工序月度汇总：一行一个工序，数量是全月跨所有订单的产量汇总额", async () => {
  const { book } = await exportMonthlyProduction();
  const header = operationSummaryHeader(book);
  assert.deepEqual(header, ["工序", "执行方式", "单位", "数量", "计件金额（元）", "工时（小时，仅计时）"]);

  // 缝伞：SO-001 的 190 + SO-002 的 20 = 210（**跨订单相加**，这正是总表做不到的那件事）
  const sew = operationSummaryRow(book, "缝伞");
  assert.equal(sew[header.indexOf("数量")], 210, "工序汇总必须把全月所有订单的同一道工序加到一起");
  assert.equal(sew[header.indexOf("单位")], "支");
  // 金额来自员工日报：30 + 12 + 6 = 48
  assert.equal(sew[header.indexOf("计件金额（元）")], 48);

  assert.equal(operationSummaryRow(book, "大裁")[header.indexOf("数量")], 200);
  assert.equal(operationSummaryRow(book, "剪线头")[header.indexOf("数量")], 33);
});

test("工序月度汇总：拉边按执行方式分两行（本厂与外发是两批不同的活，不能合成一行）", async () => {
  const { book } = await exportMonthlyProduction();
  const header = operationSummaryHeader(book);
  // 总表把拉边拆成「拉边-本厂」「拉边-外发」两列；本表的工序列取总表列名（`拉边-本厂`），
  // 执行方式另占一列 —— 所以同一道工序的两批活各占一行，且两行的工序名相同。
  const inHouse = operationSummaryRow(book, "拉边-本厂", "本厂");
  const outsourced = operationSummaryRow(book, "拉边-本厂", "外发");
  assert.ok(inHouse && outsourced, "同一道工序的本厂 / 外发必须各占一行");
  assert.equal(inHouse[header.indexOf("数量")], 55, "本厂取大 55");
  assert.equal(outsourced[header.indexOf("数量")], 70, "外发 70，不能被本厂的行掩盖");
  // 两行相加 = 总表两列各订单之和（拉边只有 SO-001 有数据）
  assert.equal(inHouse[header.indexOf("数量")] + outsourced[header.indexOf("数量")], 125);
});

test("工序月度汇总：多单位的包装拆成两行，绝不相加成一个数", async () => {
  const { book } = await exportMonthlyProduction();
  const header = operationSummaryHeader(book);
  const rows = rowsOf(book, MONTHLY_OPERATION_SUMMARY_SHEET).filter((row) => Array.isArray(row) && row[0] === "包装");
  assert.equal(rows.length, 2, "60 支与 4 打是两个单位，必须两行");
  const byUnit = new Map(rows.map((row) => [row[header.indexOf("单位")], row[header.indexOf("数量")]]));
  assert.equal(byUnit.get("支"), 60);
  assert.equal(byUnit.get("打"), 4);
  // 金额是元，跨单位照常各自累计（不受「不跨单位」约束）
  assert.equal(rows.reduce((sum, row) => sum + row[header.indexOf("计件金额（元）")], 0), 153.6);
});

/** 某个工序在「工序月度汇总」里的**全部行**（同一道工序可能按单位/执行方式分成多行）。 */
function operationSummaryRows(book, operationLabel) {
  return rowsOf(book, MONTHLY_OPERATION_SUMMARY_SHEET).filter((row) => Array.isArray(row) && row[0] === operationLabel);
}

test("工序月度汇总：同一道工序各行相加 = 总表该工序列各订单格子相加（跨订单的加总关系）", async () => {
  const { book } = await exportMonthlyProduction();
  const summaryHeaderRow = summaryHeader(book);
  const operationHeader = operationSummaryHeader(book);
  for (const operation of ["缝伞", "大裁", "剪线头"]) {
    const summarySum = operationSummaryRows(book, operation).reduce((sum, row) => sum + (row[operationHeader.indexOf("数量")] ?? 0), 0);
    const perOrder = rowsOf(book, "生产月报表")
      .filter((row) => Array.isArray(row) && row[0] === MONTH)
      .map((row) => row[summaryHeaderRow.indexOf(operation)])
      .filter((value) => typeof value === "number");
    assert.equal(summarySum, perOrder.reduce((sum, value) => sum + value, 0), `${operation}：工序汇总各行相加必须等于总表该列各订单相加`);
  }
});

test("工序月度汇总：客户叫法（验伞面）并进字典名那一行，与总表同一列同一个数", async () => {
  // 总表的一列可能同时装字典名（验片）与客户叫法（验伞面）：`MONTHLY_TEMPLATE_COLUMNS` 的 aliases
  // 就是为这种历史数据准备的。本表若按原始名字分组，同一道工序会被拆成两行，而总表只有一格 ——
  // 财务拿着两张表怎么加都对不上。所以工序列必须取**总表列名**。
  const state = fixture();
  state.operations.push({ id: "opr-inspect", unit: { name: "支" }, productionOrder: { executionMode: "in_house" } });
  state.employeeReports.push(
    employeeReport({ id: "er-alias-1", operationNameSnapshot: "验片", productionOrderOperationId: "opr-inspect", reportDate: day("2026-06-14"), quantity: new Prisma.Decimal("200"), unitPrice: new Prisma.Decimal("0.05"), calculatedAmount: new Prisma.Decimal("10") }),
    // 同一个生产单工序（opr-inspect），但快照是客户叫法
    employeeReport({ id: "er-alias-2", operationNameSnapshot: "验伞面", productionOrderOperationId: "opr-inspect", reportDate: day("2026-06-15"), employeeNameSnapshot: "李四", quantity: new Prisma.Decimal("100"), unitPrice: new Prisma.Decimal("0.05"), calculatedAmount: new Prisma.Decimal("5") }),
  );
  const { book } = await exportMonthlyProduction(state);

  // 总表：验片那一格是两者之和（该列 names 同时含 验片 与 验伞面）
  const mainCell = summaryRow(book, "SO-2026-001")[summaryHeader(book).indexOf("验片")];
  assert.equal(mainCell, 300, "总表把字典名与客户叫法并进同一列同一格");

  // 工序汇总：只能有**一行**「验片」，数量与总表那一格相等；绝不能出现一行「验伞面」
  const rows = operationSummaryRows(book, "验片");
  assert.equal(rows.length, 1, "客户叫法必须并进字典名那一行，不能另起一行");
  const operationHeader = operationSummaryHeader(book);
  assert.equal(rows[0][operationHeader.indexOf("数量")], mainCell, "并成一行之后，两者才真的是同一个数");
  assert.equal(operationSummaryRows(book, "验伞面").length, 0, "绝不出「验伞面」这一行");
  // 明细 sheet 与总表仍然逐格相等（原来那条不变量不能因为本表而变）
  assert.equal(detailRow(book, "验片", "SO-2026-001")[tableHeader(book, "验片").indexOf("汇总数量")], mainCell);
});

test("工序月度汇总：未按执行方式拆分的工序（缝伞）分行后相加等于总表该列各订单之和", async () => {
  // 总表只有拉边按执行方式拆列；缝伞是本厂/外发混在一格的。本表按执行方式分行，
  // 所以单看一行会小于总表那一格 —— 这是要**说清加总关系**而不是「单格相等」的原因。
  const state = fixture();
  state.operations.push({ id: "opr-sew-out", unit: { name: "支" }, productionOrder: { executionMode: "outsourced" } });
  state.employeeReports.push(employeeReport({ id: "er-sew-out", orderNo: "SO-2026-001", operationNameSnapshot: "缝伞", productionOrderOperationId: "opr-sew-out", reportDate: day("2026-06-18"), employeeNameSnapshot: "外发工", quantity: new Prisma.Decimal("70"), calculatedAmount: new Prisma.Decimal("21") }));
  const { book } = await exportMonthlyProduction(state);

  const header = summaryHeader(book);
  const operationHeader = operationSummaryHeader(book);
  const rows = operationSummaryRows(book, "缝伞");
  const byMode = new Map(rows.map((row) => [row[operationHeader.indexOf("执行方式")], row[operationHeader.indexOf("数量")]]));
  // 缝伞跨两张订单：本厂 = SO-001 的 190 + SO-002 的 20 = 210；外发只有这次新加的 70
  assert.equal(byMode.get("本厂"), 210, "本厂是两张订单的和（190 + 20）");
  assert.equal(byMode.get("外发"), 70, "外发单独一行，不能被本厂那行掩盖");
  // 正确的不变量：**该工序在总表各订单格子之和 = 本表各行之和**。
  // 刻意不断言「某一张订单的格子 = 某一行」—— 那两者本来就不同：
  // 本表一行是**全月跨所有订单**的汇总，而总表一格只是**一张订单**；
  // 而且总表那一格还把本厂/外发并在一起，所以单看一行必然小于所有订单加起来的那格。
  const perOrderTotal = rowsOf(book, "生产月报表")
    .filter((row) => Array.isArray(row) && row[0] === MONTH)
    .reduce((sum, row) => sum + (row[header.indexOf("缝伞")] ?? 0), 0);
  const summaryTotal = rows.reduce((sum, row) => sum + row[operationHeader.indexOf("数量")], 0);
  assert.equal(summaryTotal, perOrderTotal, "工序汇总各行相加 = 总表该列各订单相加");
  assert.equal(summaryTotal, 280, "190（SO-001 本厂）+ 70（SO-001 外发）+ 20（SO-002 本厂）");
  assert.ok(byMode.get("本厂") < perOrderTotal, "单看一行本来就小于各订单之和：本表一行是全月汇总，总表那格只是其中一张单");
});

test("工序月度汇总的三处数量必须来自同一份结果：总表格子 = 工序明细汇总，且工序汇总各行相加 = 总表该列各订单相加", async () => {
  // 这三处的关系不是「三个数逐格相等」：
  //   · 总表格子 与 该工序明细 sheet 的「汇总数量」是**逐格相等**（同一个 (工序, 订单)，必须一模一样）；
  //   · 工序汇总按 (工序, 单位, 执行方式) 切行，所以它是**加总关系**（同一工序各行相加 = 总表该列各订单相加）。
  // 这一条把两半都走了：明细 sheet 真的打开来读表头定位（不是只看总表）。
  const { book } = await exportMonthlyProduction();
  const summaryHeaderRow = summaryHeader(book);
  const operationHeader = operationSummaryHeader(book);
  for (const operation of ["缝伞", "大裁", "剪线头"]) {
    const orders = rowsOf(book, "生产月报表").filter((row) => Array.isArray(row) && row[0] === MONTH).map((row) => row[1]);
    // 逐格：总表格子 = 该工序明细的「汇总数量」
    const detailHeader = tableHeader(book, operation);
    for (const orderNo of orders) {
      // 两边都可能「没有这一格」：SO-2026-002 在剪线头/大裁上没有产量，明细里就没有那一行。
      // 「两边都没有」是相等的，所以要按 null 比 —— 用 undefined 会让 deepEqual 假红，
      // 用不存在的行去 indexOf 则直接抛异常。
      const summaryLine = summaryRow(book, orderNo);
      const mainCell = summaryLine ? summaryLine[summaryHeaderRow.indexOf(operation)] ?? null : null;
      const detailLine = detailRow(book, operation, orderNo);
      const detailValue = detailLine && detailHeader ? detailLine[detailHeader.indexOf("汇总数量")] ?? null : null;
      assert.deepEqual(detailValue, mainCell, `${operation} / ${orderNo}：明细汇总必须与总表同格相等`);
    }
    // 加总：工序汇总同一工序各行相加 = 总表该列各订单相加
    const summarySum = operationSummaryRows(book, operation).reduce((sum, row) => sum + (row[operationHeader.indexOf("数量")] ?? 0), 0);
    const perOrder = orders.map((orderNo) => summaryRow(book, orderNo)?.[summaryHeaderRow.indexOf(operation)] ?? null).filter((value) => typeof value === "number");
    assert.equal(summarySum, perOrder.reduce((sum, value) => sum + value, 0), `${operation}：工序汇总各行相加必须等于总表该列各订单相加`);
  }
});

test("工序月度汇总：工时只统计计时行，计件行不产生工时；合计行的数量留空", async () => {
  const { book } = await exportMonthlyProduction();
  const header = operationSummaryHeader(book);
  const hoursColumn = header.indexOf("工时（小时，仅计时）");
  // 夹具里全是计件行（piece_rate），所以没有工时 —— 留空而不是 0（0 是「确实零工时」这个事实）
  assert.equal(operationSummaryRow(book, "缝伞")[hoursColumn], null);
  const last = lastRow(book, MONTHLY_OPERATION_SUMMARY_SHEET);
  assert.equal(last[0], "合计");
  assert.equal(last[header.indexOf("数量")], null, "合计行的数量必须留空：跨行相加会跨单位");
  // 合计金额＝夹具里全部员工日报的金额快照之和：30+12+7+2.5+3.5+0.66+6+144+9.6 = 215.26
  // （独立用 node -e 加过一遍；写错了这条断言会掩盖「金额漏算了一部分」这个真缺陷）
  assert.equal(last[header.indexOf("计件金额（元）")], 215.26, "金额是元，不受「不跨单位」约束，照常合计");
});

test("工序月度汇总：计时行按小时给工时（落库是分钟，导出统一换算成小时）", async () => {
  const state = fixture();
  state.employeeReports.push(employeeReport({ id: "er-time", operationNameSnapshot: "缝伞", productionOrderOperationId: "opr-sew-1", reportDate: day("2026-06-25"), employeeNameSnapshot: "计时工", wageMode: "time_rate", durationMinutes: new Prisma.Decimal("90"), quantity: new Prisma.Decimal("15"), unitPrice: new Prisma.Decimal("20"), calculatedAmount: new Prisma.Decimal("30") }));
  const { book } = await exportMonthlyProduction(state);
  const header = operationSummaryHeader(book);
  const sew = operationSummaryRow(book, "缝伞");
  assert.equal(sew[header.indexOf("工时（小时，仅计时）")], 1.5, "90 分钟 = 1.5 小时");
  assert.notEqual(sew[header.indexOf("工时（小时，仅计时）")], 90, "表头写的是小时，单元格就不能还是分钟");
});

test("工序月度汇总：软删除与上月的日报不进汇总（与总表同一批数据）", async () => {
  const { book } = await exportMonthlyProduction();
  const text = JSON.stringify(rowsOf(book, MONTHLY_OPERATION_SUMMARY_SHEET));
  assert.equal(text.includes("999"), false, "软删除的员工日报不得进工序汇总");
  assert.equal(text.includes("888"), false, "软删除的工序日报不得进工序汇总");
  assert.equal(text.includes("777"), false, "上个月的日报不得进工序汇总（月份边界是 [当月1日, 下月1日)）");
});

test("工序月度汇总：数量/金额/工时都是数值单元格，工序名与单位是文本", async () => {
  const { book } = await exportMonthlyProduction();
  const header = operationSummaryHeader(book);
  const rows = rowsOf(book, MONTHLY_OPERATION_SUMMARY_SHEET);
  const headerIndex = rows.findIndex((row) => Array.isArray(row) && row[0] === "工序");
  const dataIndex = rows.findIndex((row) => Array.isArray(row) && row[0] === "缝伞");
  assert.ok(headerIndex > 0 && dataIndex > headerIndex);
  for (const column of ["数量", "计件金额（元）"]) {
    assert.equal(cellType(book, MONTHLY_OPERATION_SUMMARY_SHEET, dataIndex, header.indexOf(column)), "n", `工序汇总 ${column} 必须是数值单元格`);
  }
  assert.equal(cellType(book, MONTHLY_OPERATION_SUMMARY_SHEET, dataIndex, header.indexOf("工序")), "s");
  assert.equal(cellType(book, MONTHLY_OPERATION_SUMMARY_SHEET, dataIndex, header.indexOf("执行方式")), "s");
});

test("工序月度汇总的元信息写明「一行一个工序 / 加总关系 / 合计行数量留空的原因」", async () => {
  const { book } = await exportMonthlyProduction();
  const rows = rowsOf(book, MONTHLY_OPERATION_SUMMARY_SHEET);
  const scope = rows.find((row) => row[0] === "数据范围")[1];
  const caliber = rows.find((row) => row[0] === "口径说明")[1];
  assert.match(scope, /一行一个工序/);
  assert.match(scope, /验伞面/, "数据范围要写明客户叫法并到字典名那一行");
  assert.match(caliber, /逐日取大/);
  assert.match(caliber, /全月跨所有订单/);
  assert.match(caliber, /各行相加/, "与总表的关系必须写成加总关系（写成「同一个数」是假话）");
  assert.match(caliber, /合计行的数量留空/);
  // 旧版的错句不能再回来：它在别名与未拆分执行方式的列上不成立
  assert.equal(caliber.includes("对应工序列**同一个数**"), false);
});

test("工序月度汇总：工序行序跟随总表列序，历史工序（不在字典里）也照样出现", async () => {
  const state = fixture();
  state.catalog = state.catalog.filter((row) => row.operationName !== "包装");
  const { book } = await exportMonthlyProduction(state);
  const names = rowsOf(book, MONTHLY_OPERATION_SUMMARY_SHEET)
    .filter((row) => Array.isArray(row) && row[0] !== "合计" && row[0] !== "工序" && row[0] !== "（本月无生产日报数据）")
    .map((row) => row[0]);
  // 包装已不在字典里，但当月有 64 件产量 —— 汇总里同样不能丢
  assert.ok(names.includes("包装"), "字典删掉工序后，当月数据仍须出现在工序汇总里");
  // 行序跟随总表列序：大裁在缝伞之前，缝伞在包装之前
  assert.ok(names.indexOf("大裁") < names.indexOf("缝伞"));
  assert.ok(names.indexOf("缝伞") < names.indexOf("包装"));
});

// ------------------------------------------------------------------ sheet 结构 / 顺序 / 审计

test("sheet 数量与名称：总表 → 工序月度汇总 → 其余按工序一列一张", async () => {
  const { book } = await exportMonthlyProduction();
  assert.deepEqual(book.SheetNames, ["生产月报表", MONTHLY_OPERATION_SUMMARY_SHEET, "大裁", "拉边-本厂", "拉边-外发", "缝伞", "包装", "剪线头"]);
});

test("总表：标题 + 元信息 + 表头 + 一行一个订单号（订单号升序）", async () => {
  const { book } = await exportMonthlyProduction();
  const rows = rowsOf(book, "生产月报表");
  assert.equal(rows[0][0], "生产月报表");
  assert.deepEqual(rows[1].slice(0, 2), ["统计月份", MONTH]);
  assert.equal(rows[2][0], "数据范围");
  assert.equal(rows[3][0], "口径说明");
  assert.match(String(rows[3][1]), /逐日取大/, "口径说明必须写明逐日取大");
  assert.equal(rows[4][0], "生成时间");
  assert.deepEqual(rows[5].slice(0, 2), ["导出人", "admin"]);
  // 元信息与表头之间留一个空行（空行本身在 SheetJS 里读出来是全 null，只断言「没有任何内容」）
  assert.deepEqual(rows[6].filter((value) => value !== null), [], "元信息与表头之间必须留一个空行");
  assert.deepEqual(rows[7], ["月份", "订单号", "订单数量", "规格", "大裁", "拉边-本厂", "拉边-外发", "小裁", "合片", "验片", "打顶打带", "打珠尾", "缝伞", "品检", "包装", "剪线头", "各工序合计（非完工量）"]);
  assert.deepEqual(rows[8], [MONTH, "SO-2026-001", 1000, "30*8K 自动伞", 200, 55, 70, null, null, null, null, null, 190, null, null, 33, 548]);
  assert.deepEqual(rows[9], [MONTH, "SO-2026-002", 500, "21*8K 三折伞", null, null, null, null, null, null, null, null, 20, null, "4 打 + 60 支", null, "单位不一致，不合计"]);
  assert.equal(rows.length, 10, "总表不得多出合计行（末列是各工序横向合计；明细 sheet 才有合计行）");
});

test("明细 sheet：工人列按首次出现排序，末尾有合计行", async () => {
  const { book } = await exportMonthlyProduction();
  const rows = rowsOf(book, "缝伞");
  assert.equal(rows[0][0], "缝伞 生产月报明细");
  const header = tableHeader(book, "缝伞");
  // 出现顺序＝员工日报顺序（生产日期 → 订单号 → 工序 → 姓名）：6-03 张三、6-08 孙七、6-10 李四
  assert.deepEqual(header, ["订单号", "订单数量", "规格", "单价", "张三 数量", "张三 金额", "孙七 数量", "孙七 金额", "李四 数量", "李四 金额", "汇总数量", "汇总金额", "备注"]);
  const last = lastRow(book, "缝伞");
  assert.equal(last[0], "合计");
  assert.equal(last[header.indexOf("张三 数量")], 100);
  assert.equal(last[header.indexOf("孙七 数量")], 20);
  assert.equal(last[header.indexOf("李四 数量")], 40);
  assert.equal(last[header.indexOf("汇总数量")], 210, "合计行汇总数量＝190 + 20");
  assert.equal(last[header.indexOf("汇总金额")], 48);
  assert.match(String(last[header.indexOf("备注")]), /房补/, "模板的房补/总合计行为什么不生成要写在表里");
  // 明细没有单价那一格时不得瞎猜：唯一计件单价给数值
  assert.equal(detailRow(book, "缝伞", "SO-2026-001")[header.indexOf("单价")], 0.3);
});

test("空月份：仍然出一张有表头的总表，并写明「本月无生产日报数据」", async () => {
  const state = fixture();
  state.employeeReports = [];
  state.operationReports = [];
  const { book } = await exportMonthlyProduction(state);
  assert.deepEqual(book.SheetNames, ["生产月报表", MONTHLY_OPERATION_SUMMARY_SHEET], "没有数据的工序不该出一堆空 sheet，但工序汇总仍要在（它是「本月确实为零」的证据）");
  const rows = rowsOf(book, "生产月报表");
  assert.equal(rows[8][1], "（本月无生产日报数据）");
  // 字典里的工序列仍在（表头稳定，读者能确定「确实是 0」而不是漏了列）
  assert.ok(rows[7].includes("缝伞"));
  // 工序汇总在空月份给一行说明，而不是一张只有表头的空表（空表分不清「没数据」和「导错了」）
  const summaryRows = rowsOf(book, MONTHLY_OPERATION_SUMMARY_SHEET);
  const emptyNote = summaryRows.find((row) => Array.isArray(row) && String(row[0]).includes("本月无生产日报数据"));
  assert.ok(emptyNote, "空月份的工序汇总必须有一行说明，而不是一张只有表头的空表");
  // 空月份：金额/工时合计是 0，数量留空（一行一个单位的纪律在空表上也成立）
  const emptyTotal = lastRow(book, MONTHLY_OPERATION_SUMMARY_SHEET);
  assert.equal(emptyTotal[0], "合计");
  assert.equal(emptyTotal[1], null);
});

test("审计：记 production_payroll_export / employee_daily_report，并带上报表类型与筛选项", async () => {
  const { audit } = await exportMonthlyProduction();
  assert.equal(audit.calls.length, 1, "一次导出记一条审计");
  const [action, entity, actorId, entityId, details] = audit.calls[0];
  assert.equal(action, "production_payroll_export");
  assert.equal(entity, "employee_daily_report");
  assert.equal(actorId, "user-1");
  assert.equal(entityId, undefined);
  assert.equal(details.report_type, "生产月报表");
  assert.deepEqual(details.filters, { month: MONTH });
  assert.equal(details.sheet_count, 8, "总表 + 工序月度汇总 + 6 张工序明细");
});

test("月份格式非法直接 422，不产出文件", async () => {
  const audit = { record: async () => undefined };
  const service = new ProductionPayrollExportService(createPrisma(fixture()), audit, { namesOf: async () => new Map() });
  await assert.rejects(() => service.exportMonthlyProduction({ month: "2026/06" }, { id: "user-1", username: "admin" }), (error) => error.getStatus?.() === 422);
});

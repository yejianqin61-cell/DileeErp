const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { ReportsService } = require("../../dist/modules/reports/reports.service.js");

const MODELS = [
  ["salesOrder", "salesOrderRows", { orderNo: true, productName: true, quantity: true, unit: true, status: true, deliveryDate: true, updatedAt: true }],
  ["purchaseOrder", "purchaseOrderRows", { purchaseOrderNo: true, orderNo: true, supplierSnapshot: true, status: true, totalAmount: true, currency: true, updatedAt: true }],
  ["inventoryFact", "inventoryFactRows", { id: true, orderNo: true, inventoryCategory: true, quantityDelta: true, sourceType: true, sourceId: true, createdAt: true }],
  ["finishedGoodsQcRecord", "finishedGoodsQcRecordRows", { qcNo: true, orderNo: true, conclusion: true, status: true, inspectedQuantity: true, qualifiedQuantity: true, rejectedQuantity: true, inspectionDate: true }],
  ["payrollLedger", "payrollLedgerRows", { ledgerNo: true, employeeId: true, periodStart: true, periodEnd: true, status: true, baseSalary: true, productionSourceAmount: true }],
];

/** 手写假 Prisma：只读模型记录调用形状，任何写操作都会记录并抛错（报表模块不应写库）。 */
function fakePrisma(overrides = {}) {
  const calls = [];
  const writes = [];
  const data = {};
  const prisma = { calls, writes, data };
  for (const [model, rowsKey] of MODELS) {
    data[rowsKey] = [];
    data[`${model}Count`] = 0;
    const guard = (op) => async () => {
      writes.push(`${model}.${op}`);
      throw new Error(`ReportsService must not call ${model}.${op}`);
    };
    prisma[model] = {
      async findMany(args) { calls.push({ model, op: "findMany", args }); return data[rowsKey]; },
      async count(args) { calls.push({ model, op: "count", args }); return data[`${model}Count`]; },
      create: guard("create"),
      createMany: guard("createMany"),
      update: guard("update"),
      updateMany: guard("updateMany"),
      upsert: guard("upsert"),
      delete: guard("delete"),
      deleteMany: guard("deleteMany"),
    };
  }
  prisma.$transaction = async (fn) => fn(prisma);
  prisma.$queryRaw = async () => [];
  prisma.$queryRawUnsafe = async () => [];
  prisma.$executeRaw = async () => 0;
  prisma.$executeRawUnsafe = async () => 0;
  return Object.assign(prisma, overrides);
}

function service(overrides = {}) {
  const prisma = fakePrisma(overrides);
  return { prisma, reports: new ReportsService(prisma) };
}

const readCall = (prisma, model, op = "findMany") => prisma.calls.find((call) => call.model === model && call.op === op);
const readCount = (prisma, model, op) => prisma.calls.filter((call) => call.model === model && call.op === op).length;
const noWrites = (prisma) => assert.deepEqual(prisma.writes, [], "失败路径不应产生任何写入");
const noReads = (prisma) => assert.deepEqual(prisma.calls, [], "失败路径不应触碰任何查询");

// ---------------------------------------------------------------- orders

test("reports.orders_returns_snake_case_rows_and_uses_count_for_total", async () => {
  const { prisma, reports } = service();
  prisma.data.salesOrderRows = [{
    orderNo: "SO-1", productName: "外壳", quantity: new Prisma.Decimal("12.50"), unit: "件",
    status: "confirmed", deliveryDate: new Date("2026-03-01T00:00:00.000Z"), updatedAt: new Date("2026-02-01T00:00:00.000Z"),
  }];
  prisma.data.salesOrderCount = 7;

  const result = await reports.orders({});

  assert.deepEqual(result.data, [{
    order_no: "SO-1", product_name: "外壳", quantity: "12.5", unit: "件",
    status: "confirmed", delivery_date: new Date("2026-03-01T00:00:00.000Z"), updated_at: new Date("2026-02-01T00:00:00.000Z"),
  }]);
  assert.equal(result.total, 7, "orders 的 total 必须来自 count(where)，而不是本页行数");
  noWrites(prisma);
});

test("reports.orders_applies_filters_order_by_and_pagination_shape", async () => {
  const { prisma, reports } = service();

  await reports.orders({ order_no: "SO-1", status: "confirmed", from: "2026-01-01", to: "2026-01-31", page: 3, page_size: 50 });

  const list = readCall(prisma, "salesOrder", "findMany");
  const count = readCall(prisma, "salesOrder", "count");
  assert.deepEqual(list.args.where, {
    deletedAt: null,
    orderNo: "SO-1",
    status: "confirmed",
    updatedAt: { gte: new Date("2026-01-01"), lte: new Date("2026-01-31") },
  });
  assert.deepEqual(list.args.orderBy, { updatedAt: "desc" });
  assert.equal(list.args.skip, 100);
  assert.equal(list.args.take, 50);
  assert.deepEqual(list.args.select, MODELS[0][2]);
  assert.deepEqual(count.args.where, list.args.where, "count 必须复用同一 where");
  assert.equal(readCount(prisma, "salesOrder", "count"), 1);
  noWrites(prisma);
});

test("reports.orders_supports_single_sided_created_at_ranges", async () => {
  const lower = service();
  await lower.reports.orders({ from: "2026-01-01" });
  assert.deepEqual(readCall(lower.prisma, "salesOrder").args.where.updatedAt, { gte: new Date("2026-01-01") });
  assert.equal("lte" in readCall(lower.prisma, "salesOrder").args.where.updatedAt, false);

  const upper = service();
  await upper.reports.orders({ to: "2026-01-31" });
  assert.deepEqual(readCall(upper.prisma, "salesOrder").args.where.updatedAt, { lte: new Date("2026-01-31") });
  assert.equal("gte" in readCall(upper.prisma, "salesOrder").args.where.updatedAt, false);
  noWrites(lower.prisma);
  noWrites(upper.prisma);
});

test("reports.orders_page_size_is_clamped_into_1..200", async () => {
  for (const [page_size, expected] of [[0, 1], [-100, 1], [1, 1], [20, 20], [200, 200], [201, 200], [5000, 200], [99999, 200], [undefined, 20], [null, 20], ["50", 50]]) {
    const { prisma, reports } = service();
    await reports.orders({ page_size });
    assert.equal(readCall(prisma, "salesOrder").args.take, expected, `page_size=${String(page_size)} 应被收敛为 ${expected}`);
    noWrites(prisma);
  }
});

test("reports.orders_empty_string_filters_are_dropped_instead_of_filtering", async () => {
  const { prisma, reports } = service();

  await reports.orders({ order_no: "", status: "" });

  assert.deepEqual(readCall(prisma, "salesOrder").args.where, { deletedAt: null }, "空串是 falsy，被当成「未筛选」而不是「筛选空值」");
  noWrites(prisma);
});

test("reports.orders_service_layer_has_no_page_lower_bound_guard", async () => {
  const { prisma, reports } = service();

  // NOTE(未验证的调用方): HTTP 路径由 ReportQueryDto 的 @Min(1) 拦住 page=0；
  // 服务层自身不做校验，page=0 会产生负数 skip 直接交给 Prisma。
  await reports.orders({ page: 0, page_size: 20 });

  assert.equal(readCall(prisma, "salesOrder").args.skip, -20);
  noWrites(prisma);
});

test("reports.orders_service_layer_does_not_validate_date_strings", async () => {
  const { prisma, reports } = service();

  // NOTE(未验证的调用方): 服务层不校验日期格式，非法日期以 Invalid Date 透传给 Prisma；
  // HTTP 路径由 ReportQueryDto 的 @IsDateString 拦住。
  await reports.orders({ from: "not-a-date" });

  const gte = readCall(prisma, "salesOrder").args.where.updatedAt.gte;
  assert.ok(gte instanceof Date);
  assert.ok(Number.isNaN(gte.getTime()), "非法日期字符串会变成 Invalid Date 而非抛错");
  noWrites(prisma);
});

test("reports.orders_coerces_numeric_strings_but_passes_nan_through", async () => {
  const numeric = service();
  await numeric.reports.orders({ page: "3", page_size: "50" });
  assert.equal(readCall(numeric.prisma, "salesOrder").args.skip, 100);
  assert.equal(readCall(numeric.prisma, "salesOrder").args.take, 50);

  const nan = service();
  await nan.reports.orders({ page_size: Number.NaN });
  assert.ok(Number.isNaN(readCall(nan.prisma, "salesOrder").args.take), "NaN 不会被兜底成默认值");
  noWrites(numeric.prisma);
  noWrites(nan.prisma);
});

test("reports.orders_keeps_full_decimal_precision_in_quantity_string", async () => {
  const { prisma, reports } = service();
  prisma.data.salesOrderRows = [{ orderNo: "SO-1", productName: "P", quantity: new Prisma.Decimal("12345678901234.5678"), unit: "kg", status: "draft", deliveryDate: null, updatedAt: null }];

  const result = await reports.orders({});

  assert.equal(result.data[0].quantity, "12345678901234.5678");
  assert.equal(typeof result.data[0].quantity, "string");
  noWrites(prisma);
});

// ------------------------------------------------------------ procurement

test("reports.procurement_filters_order_supplier_and_status", async () => {
  const { prisma, reports } = service();
  prisma.data.purchaseOrderRows = [{ purchaseOrderNo: "PO-1", orderNo: "SO-1", supplierSnapshot: { name: "ACME" }, status: "confirmed", totalAmount: new Prisma.Decimal("100.5"), currency: "CNY", updatedAt: new Date("2026-02-01T00:00:00.000Z") }];

  const result = await reports.procurement({ order_no: "SO-1", supplier_id: "sup-1", status: "confirmed", page: 2, page_size: 10 });

  const args = readCall(prisma, "purchaseOrder").args;
  assert.deepEqual(args.where, { deletedAt: null, orderNo: "SO-1", supplierId: "sup-1", status: "confirmed" });
  assert.deepEqual(args.orderBy, { updatedAt: "desc" });
  assert.equal(args.skip, 10);
  assert.equal(args.take, 10);
  assert.deepEqual(Object.keys(args.select).sort(), Object.keys(MODELS[1][2]).sort());
  assert.deepEqual(result.data, [{ purchase_order_no: "PO-1", order_no: "SO-1", supplier: { name: "ACME" }, status: "confirmed", amount: "100.5", currency: "CNY", updated_at: new Date("2026-02-01T00:00:00.000Z") }]);
  noWrites(prisma);
});

test("KNOWN_DEFECT D7: reports.procurement_total_reports_page_length", async () => {
  const { prisma, reports } = service();
  const row = { purchaseOrderNo: "PO-1", orderNo: "SO-1", supplierSnapshot: null, status: "confirmed", totalAmount: new Prisma.Decimal("1"), currency: "CNY", updatedAt: new Date("2026-02-01T00:00:00.000Z") };
  prisma.data.purchaseOrderRows = [row, { ...row, purchaseOrderNo: "PO-2" }];
  prisma.data.purchaseOrderCount = 9;

  // KNOWN_DEFECT (recon D7 / reports.service.ts:12)：该端点用 rows.length 当 total，
  // 传入 page_size 时客户端分页器会把「本页行数」当成总条数，误判只有一页。
  // 修复后此断言应变红（应改为 count(where) 且 total=9），请同步更新 recon 记录。
  const result = await reports.procurement({ page_size: 2 });

  assert.equal(result.total, 2);
  assert.equal(result.total, result.data.length);
  assert.equal(readCount(prisma, "purchaseOrder", "count"), 0, "当前实现根本不会调用 count");
  noWrites(prisma);
});

// -------------------------------------------------------------- inventory

test("reports.inventory_filters_created_at_range_and_maps_delta", async () => {
  const { prisma, reports } = service();
  prisma.data.inventoryFactRows = [{ id: "fact-1", orderNo: "SO-1", inventoryCategory: "raw_material", quantityDelta: new Prisma.Decimal("-2.25"), sourceType: "outbound", sourceId: "OB-1", createdAt: new Date("2026-01-15T00:00:00.000Z") }];

  const result = await reports.inventory({ order_no: "SO-1", from: "2026-01-01", to: "2026-01-31" });

  const args = readCall(prisma, "inventoryFact").args;
  assert.deepEqual(args.where, { orderNo: "SO-1", createdAt: { gte: new Date("2026-01-01"), lte: new Date("2026-01-31") } });
  assert.deepEqual(args.orderBy, { createdAt: "desc" });
  assert.deepEqual(result.data, [{ id: "fact-1", order_no: "SO-1", inventory_category: "raw_material", quantity_delta: "-2.25", source_type: "outbound", source_id: "OB-1", created_at: new Date("2026-01-15T00:00:00.000Z") }]);
  assert.equal(result.total, 1);
  noWrites(prisma);
});

test("KNOWN_DEFECT D7: reports.inventory_total_reports_page_length", async () => {
  const { prisma, reports } = service();
  const row = { id: "fact-1", orderNo: "SO-1", inventoryCategory: "raw_material", quantityDelta: new Prisma.Decimal("1"), sourceType: "inbound", sourceId: "IB-1", createdAt: new Date("2026-01-15T00:00:00.000Z") };
  prisma.data.inventoryFactRows = [row, { ...row, id: "fact-2" }, { ...row, id: "fact-3" }];
  prisma.data.inventoryFactCount = 9;

  // KNOWN_DEFECT (recon D7 / reports.service.ts:13)：total = rows.length。
  const result = await reports.inventory({ page_size: 3 });

  assert.equal(result.total, 3);
  assert.equal(readCount(prisma, "inventoryFact", "count"), 0);
  noWrites(prisma);
});

test("reports.inventory_without_date_range_omits_created_at_filter", async () => {
  const { prisma, reports } = service();

  await reports.inventory({});

  assert.deepEqual(readCall(prisma, "inventoryFact").args.where, {});
  noWrites(prisma);
});

// ---------------------------------------------------------- production-qc

test("reports.production_qc_filters_order_and_status_and_maps_quantities", async () => {
  const { prisma, reports } = service();
  prisma.data.finishedGoodsQcRecordRows = [{ qcNo: "QC-1", orderNo: "SO-1", conclusion: "qualified", status: "confirmed", inspectedQuantity: new Prisma.Decimal("10"), qualifiedQuantity: new Prisma.Decimal("9"), rejectedQuantity: new Prisma.Decimal("1"), inspectionDate: new Date("2026-02-10T00:00:00.000Z") }];

  const result = await reports.productionQc({ order_no: "SO-1", status: "confirmed" });

  const args = readCall(prisma, "finishedGoodsQcRecord").args;
  assert.deepEqual(args.where, { deletedAt: null, orderNo: "SO-1", status: "confirmed" });
  assert.deepEqual(args.orderBy, { updatedAt: "desc" });
  assert.deepEqual(result.data, [{ qc_no: "QC-1", order_no: "SO-1", conclusion: "qualified", status: "confirmed", inspected_quantity: "10", qualified_quantity: "9", rejected_quantity: "1", inspection_date: new Date("2026-02-10T00:00:00.000Z") }]);
  noWrites(prisma);
});

test("KNOWN_DEFECT D7: reports.production_qc_total_reports_page_length", async () => {
  const { prisma, reports } = service();
  prisma.data.finishedGoodsQcRecordRows = [{ qcNo: "QC-1", orderNo: "SO-1", conclusion: "qualified", status: "confirmed", inspectedQuantity: new Prisma.Decimal("1"), qualifiedQuantity: new Prisma.Decimal("1"), rejectedQuantity: new Prisma.Decimal("0"), inspectionDate: new Date("2026-02-10T00:00:00.000Z") }];
  prisma.data.finishedGoodsQcRecordCount = 9;

  // KNOWN_DEFECT (recon D7 / reports.service.ts:14)：total = rows.length。
  const result = await reports.productionQc({ page_size: 1 });

  assert.equal(result.total, 1);
  assert.equal(readCount(prisma, "finishedGoodsQcRecord", "count"), 0);
  noWrites(prisma);
});

// ---------------------------------------------------------------- payroll

test("reports.payroll_filters_employee_and_status_and_orders_by_period_start", async () => {
  const { prisma, reports } = service();
  prisma.data.payrollLedgerRows = [{ ledgerNo: "PL-1", employeeId: "emp-1", periodStart: new Date("2026-01-01T00:00:00.000Z"), periodEnd: new Date("2026-01-31T00:00:00.000Z"), status: "confirmed", baseSalary: new Prisma.Decimal("5000"), productionSourceAmount: new Prisma.Decimal("120.75") }];

  const result = await reports.payroll({ employee_id: "emp-1", status: "confirmed" });

  const args = readCall(prisma, "payrollLedger").args;
  assert.deepEqual(args.where, { deletedAt: null, employeeId: "emp-1", status: "confirmed" });
  assert.deepEqual(args.orderBy, { periodStart: "desc" });
  assert.deepEqual(result.data, [{ ledger_no: "PL-1", employee_id: "emp-1", period_start: new Date("2026-01-01T00:00:00.000Z"), period_end: new Date("2026-01-31T00:00:00.000Z"), status: "confirmed", base_salary: "5000", production_source_amount: "120.75" }]);
  noWrites(prisma);
});

test("KNOWN_DEFECT D7: reports.payroll_total_reports_page_length", async () => {
  const { prisma, reports } = service();
  const row = { ledgerNo: "PL-1", employeeId: "emp-1", periodStart: new Date("2026-01-01T00:00:00.000Z"), periodEnd: new Date("2026-01-31T00:00:00.000Z"), status: "confirmed", baseSalary: new Prisma.Decimal("5000"), productionSourceAmount: new Prisma.Decimal("1") };
  prisma.data.payrollLedgerRows = [row, { ...row, ledgerNo: "PL-2" }];
  prisma.data.payrollLedgerCount = 9;

  // KNOWN_DEFECT (recon D7 / reports.service.ts:15)：total = rows.length。
  const result = await reports.payroll({ page_size: 2 });

  assert.equal(result.total, 2);
  assert.equal(readCount(prisma, "payrollLedger", "count"), 0);
  noWrites(prisma);
});

// ------------------------------------------------------------ query 路由

test("reports.query_routes_each_supported_report_name_to_its_model", async () => {
  const routes = [
    ["orders", "salesOrder"],
    ["procurement-payables", "purchaseOrder"],
    ["inventory", "inventoryFact"],
    ["production-qc", "finishedGoodsQcRecord"],
    ["payroll", "payrollLedger"],
  ];

  for (const [report, model] of routes) {
    const { prisma, reports } = service();
    const result = await reports.query(report, {});
    assert.equal(readCount(prisma, model, "findMany"), 1, `${report} 应查询 ${model}`);
    assert.ok(Array.isArray(result.data));
    assert.equal(typeof result.total, "number");
    noWrites(prisma);
  }
});

test("reports.query_unknown_report_is_rejected_without_touching_any_model", async () => {
  const { prisma, reports } = service();

  for (const report of ["unknown", "procurement", "ORDERS", "", "orders "]) {
    await assert.rejects(
      () => reports.query(report, {}),
      (error) => error.getResponse().code === "REPORT_NOT_FOUND" && error.getStatus() === 422,
      `report=${JSON.stringify(report)} 应被拒绝`,
    );
  }
  noReads(prisma);
  noWrites(prisma);
});

// ---------------------------------------------------------------- export

test("reports.export_overrides_caller_pagination_and_hits_the_take_cap", async () => {
  const { prisma, reports } = service();
  prisma.data.payrollLedgerRows = [{ ledgerNo: "PL-1", employeeId: "e", periodStart: "p", periodEnd: "p", status: "draft", baseSalary: "1", productionSourceAmount: "0" }];

  await reports.export("payroll", { page: 9, page_size: 1 });

  const args = readCall(prisma, "payrollLedger").args;
  assert.equal(args.skip, 0, "导出固定从第一页开始");
  // KNOWN_DEFECT (reports.service.ts:16 + :20)：export 请求 page_size=5000，但 take() 把上限夹到 200，
  // 于是 findMany 最多返回 200 行，第 16 行的 `>= 5000` 判断永远不成立（见下一个用例）。
  assert.equal(args.take, 200, "调用方的 page_size 被忽略，实际 take 被夹到 200");
  noWrites(prisma);
});

test("KNOWN_DEFECT: reports.export_silently_truncates_to_200_rows", async () => {
  const { prisma, reports } = service();
  prisma.data.salesOrderRows = Array.from({ length: 200 }, (_, index) => ({ orderNo: `SO-${index}`, productName: "P", quantity: "1", unit: "件", status: "draft", deliveryDate: null, updatedAt: null }));

  const body = await reports.export("orders", {});

  // KNOWN_DEFECT (reports.service.ts:16 与 :20)：take() 上限 200，而导出上限检测写成 `>= 5000`，
  // 因此在真实（遵守 take 的）数据库上 EXPORT_LIMIT_EXCEEDED 永远不会触发，
  // 超过 200 行的导出会被静默截断成 200 行，用户拿到不完整 CSV 且没有任何提示。
  // 修复后（导出上限与 take 上限对齐，例如 take 上限放宽到 5000+）此断言应变红。
  assert.equal(readCall(prisma, "salesOrder", "findMany").args.take, 200);
  assert.equal(body.split("\r\n").filter((line) => line.length > 0).length, 201, "200 行数据 + 1 行表头，未报错也未提示截断");
  noWrites(prisma);
});

test("reports.export_rejects_when_the_result_set_reaches_5000_rows", async () => {
  const { prisma, reports } = service();
  prisma.data.salesOrderRows = Array.from({ length: 5000 }, () => ({ orderNo: "SO", productName: "P", quantity: "1", unit: "件", status: "draft", deliveryDate: null, updatedAt: null }));

  await assert.rejects(
    () => reports.export("orders", {}),
    (error) => error.getResponse().code === "EXPORT_LIMIT_EXCEEDED" && error.getStatus() === 422,
  );
  noWrites(prisma);
});

test("reports.export_unknown_report_is_rejected_before_touching_any_model", async () => {
  const { prisma, reports } = service();

  await assert.rejects(
    () => reports.export("not-a-report", {}),
    (error) => error.getResponse().code === "REPORT_NOT_FOUND",
  );
  noReads(prisma);
  noWrites(prisma);
});

test("reports.export_empty_result_returns_bom_only", async () => {
  const { prisma, reports } = service();

  const body = await reports.export("inventory", {});

  assert.equal(body, "\uFEFF");
  assert.equal(body.length, 1);
  noWrites(prisma);
});

// ------------------------------------------------------------------- csv

test("reports.export_csv_escapes_commas_quotes_and_newlines_with_crlf_rows", async () => {
  const { prisma, reports } = service();
  prisma.data.payrollLedgerRows = [
    { ledgerNo: "L1", employeeId: "E1", periodStart: "2026-01-01", periodEnd: "2026-01-31", status: "draft", baseSalary: "1000", productionSourceAmount: "0" },
    { ledgerNo: "L,2", employeeId: 'E"2', periodStart: "", periodEnd: "", status: "draft\nx", baseSalary: "1", productionSourceAmount: "2" },
  ];

  const body = await reports.export("payroll", {});

  const header = ["ledger_no", "employee_id", "period_start", "period_end", "status", "base_salary", "production_source_amount"].join(",");
  const line1 = ["L1", "E1", "2026-01-01", "2026-01-31", "draft", "1000", "0"].join(",");
  const line2 = ['"L,2"', '"E""2"', "", "", '"draft\nx"', "1", "2"].join(",");
  assert.equal(body, `\uFEFF${header}\r\n${line1}\r\n${line2}\r\n`);
  noWrites(prisma);
});

test("reports.export_csv_json_stringifies_objects_decimals_and_dates", async () => {
  const { prisma, reports } = service();
  prisma.data.purchaseOrderRows = [{
    purchaseOrderNo: "PO-1", orderNo: "SO-1", supplierSnapshot: { name: "ACME", code: "S,1" }, status: "confirmed",
    totalAmount: new Prisma.Decimal("12345.6789"), currency: "CNY", updatedAt: new Date("2026-02-03T04:05:06.000Z"),
  }];

  const body = await reports.export("procurement-payables", {});

  const header = ["purchase_order_no", "order_no", "supplier", "status", "amount", "currency", "updated_at"].join(",");
  const supplierCell = '"{""name"":""ACME"",""code"":""S,1""}"';
  const updatedCell = '"""2026-02-03T04:05:06.000Z"""';
  const line = ["PO-1", "SO-1", supplierCell, "confirmed", "12345.6789", "CNY", updatedCell].join(",");
  assert.equal(body, `\uFEFF${header}\r\n${line}\r\n`);
  noWrites(prisma);
});

test("reports.export_csv_renders_null_and_missing_values_as_empty_cells", async () => {
  const { prisma, reports } = service();
  prisma.data.salesOrderRows = [{ orderNo: "SO-1", productName: "P", quantity: "1", status: "draft", deliveryDate: null, updatedAt: undefined }];

  const body = await reports.export("orders", {});

  const header = ["order_no", "product_name", "quantity", "unit", "status", "delivery_date", "updated_at"].join(",");
  assert.equal(body, `\uFEFF${header}\r\nSO-1,P,1,,draft,,\r\n`);
  noWrites(prisma);
});

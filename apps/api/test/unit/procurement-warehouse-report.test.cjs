// 采购与仓储报表（2026-11-04，设计文档 docs/design/procurement-warehouse-report-2026-11-04.md）。
//
// 本文件钉住设计文档 §5 的 API 单测清单：
//   · 五列口径：草稿/已取消采购单不计、草稿入库不计、已冲销净额、退料抵减、报废不计领用、超收→未入库为负；
//   · 行集合 = 三类来源并集，且剔除五个数量全为 0 的行；
//   · 排序：订单号数字感知倒序 + 同订单物料名升序、单位升序；
//   · 两个模糊筛选（order_no / material）走数据库且不区分大小写；
//   · 5000 行上限 → 422 REPORT_ROW_LIMIT_EXCEEDED（不截断）；
//   · 数量字符串去尾零与 "-0" → "0"；
//   · xlsx：工作表名、九列表头、数量是数值单元格、A4 横向、文件名、空数据也导出表头但行数为 0；
//   · 控制器：两条路由、DTO、权限元数据、Content-Disposition。
//
// 风格照 `reports-service.test.cjs`：假 Prisma 手写，只记录调用形状、任何写操作直接抛错；
// 测试 require 的是 `dist`，所以跑之前必须先 `npm run build --workspace=@dilee/api`。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { Prisma } = require("@prisma/client");
// 装饰器元数据（PATH_METADATA / REQUIRED_ANY_MODULES）要能读出来，必须先装 reflect-metadata。
require("reflect-metadata");
const { RequestMethod } = require("@nestjs/common");
const { PATH_METADATA, METHOD_METADATA } = require("@nestjs/common/constants");
const { validate } = require("class-validator");
const { plainToInstance } = require("class-transformer");

const {
  buildProcurementWarehouseRows,
  compareOrderNoDesc,
  formatQuantity,
  PROCUREMENT_WAREHOUSE_ROW_LIMIT
} = require("../../dist/modules/reports/procurement-warehouse-report.domain.js");
const { ProcurementWarehouseReportService } = require("../../dist/modules/reports/procurement-warehouse-report.service.js");
const { ProcurementWarehouseReportExportService } = require("../../dist/modules/reports/procurement-warehouse-report-export.service.js");
const { ReportsController, ProcurementWarehouseQueryDto } = require("../../dist/modules/reports/reports.controller.js");
const { REQUIRED_ANY_MODULES } = require("../../dist/platform/authorization/require-any-modules.decorator.js");

const ROOT = path.join(__dirname, "..", "..");
const dec = (value) => new Prisma.Decimal(value);
const NO_WRITE_METHODS = ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"];

/** 手写假 Prisma：只实现本报表用到的读方法；写操作记录后抛错（报表模块不该写库）。 */
function fakePrisma(seed = {}) {
  const calls = [];
  const writes = [];
  const data = {
    purchaseItemGroups: [],
    inboundGroups: [],
    issueGroups: [],
    stockGroups: [],
    orders: [],
    materials: [],
    units: [],
    ...seed
  };
  // 物料表有两种查询：`where.OR` 是「material 筛选条件解析 id」；`where.id.in` 是展示列。
  // 筛选条件的返回值也复用为展示列（省一条查询），所以默认与 materials 同源。
  data.filterMaterials = seed.filterMaterials ?? data.materials;
  const prisma = { calls, writes, data };
  const readModel = (name, read) => {
    const model = { groupBy: undefined, findMany: undefined };
    for (const op of NO_WRITE_METHODS) model[op] = async () => { writes.push(`${name}.${op}`); throw new Error(`报表不应写库：${name}.${op}`); };
    return Object.assign(model, read);
  };
  const groupBy = (name, resolve) => async (args) => {
    calls.push({ model: name, op: "groupBy", args });
    return resolve(args);
  };
  const findMany = (name, resolve) => async (args) => {
    calls.push({ model: name, op: "findMany", args });
    return resolve(args);
  };
  prisma.purchaseOrderItem = readModel("purchaseOrderItem", { groupBy: groupBy("purchaseOrderItem", () => data.purchaseItemGroups) });
  prisma.rawMaterialInbound = readModel("rawMaterialInbound", { groupBy: groupBy("rawMaterialInbound", () => data.inboundGroups) });
  // 同一个模型两种聚合：by 里有 orderNo 的是「生产领用」，只有 materialId/unitId 的是「库存量」。
  prisma.inventoryFact = readModel("inventoryFact", {
    groupBy: groupBy("inventoryFact", (args) => (args.by.includes("orderNo") ? data.issueGroups : data.stockGroups))
  });
  prisma.purchaseOrder = readModel("purchaseOrder", { findMany: findMany("purchaseOrder", () => data.orders) });
  prisma.material = readModel("material", { findMany: findMany("material", (args) => (args.where?.OR ? data.filterMaterials : data.materials)) });
  prisma.unit = readModel("unit", { findMany: findMany("unit", () => data.units) });
  return prisma;
}

/** 拆 `{ prisma, report }`：report 就是被检的取数服务。 */
function harness(seed = {}) {
  const prisma = fakePrisma(seed);
  return { prisma, report: new ProcurementWarehouseReportService(prisma) };
}

const purchaseGroup = (purchaseOrderId, materialId, unitId, quantity) => ({ purchaseOrderId, materialId, unitId, _sum: { quantity: dec(quantity) } });
const inboundGroup = (orderNo, materialId, unitId, quantity) => ({ orderNo, materialId, unitId, _sum: { quantity: dec(quantity) } });
const issueGroup = (orderNo, materialId, unitId, quantityDelta) => ({ orderNo, materialId, unitId, _sum: { quantityDelta: dec(quantityDelta) } });
const stockGroup = (materialId, unitId, quantityDelta) => ({ materialId, unitId, _sum: { quantityDelta: dec(quantityDelta) } });
const orderRow = (id, orderNo) => ({ id, orderNo });
// 主数据行带 materialType / deletedAt：展示列不过滤软删，但库存量口径要用这两个字段筛「未删的原料物料」。
const materialRow = (id, name, color = "") => ({ id, name, color, materialType: "raw_material", deletedAt: null });
const unitRow = (id, name) => ({ id, name, deletedAt: null });

const callsOf = (prisma, model, op = "groupBy") => prisma.calls.filter((call) => call.model === model && call.op === op);
const noWrites = (prisma) => assert.deepEqual(prisma.writes, [], "报表是只读的，任何写操作都不该发生");

/** 设计文档 §3.1 的示例数据：订单 260119 / 58cm*8k自动直骨伞 / 打 / 4700 / 4700 / 0 / 3050 / 1650。 */
function designExample() {
  return {
    purchaseItemGroups: [purchaseGroup("po-1", "m-1", "u-1", "4700.0000")],
    inboundGroups: [inboundGroup("260119", "m-1", "u-1", "4700.0000")],
    issueGroups: [issueGroup("260119", "m-1", "u-1", "-3050.0000")],
    stockGroups: [stockGroup("m-1", "u-1", "1650.0000")],
    orders: [orderRow("po-1", "260119")],
    materials: [materialRow("m-1", "58cm*8k自动直骨伞", "黑色")],
    units: [unitRow("u-1", "打")]
  };
}

// =============================================================== 五列口径

test("五列口径：设计文档的示例行逐字段相同，且 screen 与 export 走同一个取数结果", async () => {
  const { prisma, report } = harness(designExample());

  const result = await report.report({ order_no: "260119" });

  assert.deepEqual(result.data, [{
    order_no: "260119",
    material_name: "58cm*8k自动直骨伞",
    color: "黑色",
    unit: "打",
    purchase_quantity: "4700",
    inbound_quantity: "4700",
    pending_inbound_quantity: "0",
    production_issue_quantity: "3050",
    stock_quantity: "1650"
  }]);
  assert.equal(result.meta.row_count, 1);
  assert.equal(result.meta.row_limit, PROCUREMENT_WAREHOUSE_ROW_LIMIT);
  assert.match(result.meta.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(result.meta.filters, { order_no: "260119", material: null }, "筛选条件原样回给前端（用于提示「当前看的是什么范围」）");
  noWrites(prisma);
});

test("采购数量：只算「已下单」的采购明细；草稿与已取消不计（两张表都要求未删除）", async () => {
  const { prisma, report } = harness(designExample());

  await report.build({});

  // 「已下单/未删除」是**采购单表**的标量条件（groupBy 不能写关联过滤，见服务里的查询清单注释）。
  const ordersArgs = callsOf(prisma, "purchaseOrder", "findMany")[0].args;
  assert.equal(ordersArgs.where.deletedAt, null, "采购单被删除时它的明细也不该出现在报表里");
  assert.deepEqual(ordersArgs.where.status.in, ["ordered", "partially_arrived", "arrived_complete"], "草稿（draft）与已取消（cancelled）不是下单承诺，不计入采购数量");
  assert.deepEqual(Object.keys(ordersArgs.select).sort(), ["id", "orderNo"], "只取 id + 单号两列");
  assert.equal("orderNo" in ordersArgs.where, false, "未筛选时不带单号条件");

  const args = callsOf(prisma, "purchaseOrderItem")[0].args;
  assert.deepEqual(args.by, ["purchaseOrderId", "materialId", "unitId"], "采购明细没有 order_no 列，只能按采购单 id 分组、回表取单号");
  assert.deepEqual(args._sum, { quantity: true });
  assert.equal(args.where.deletedAt, null, "明细行本身的 soft delete 要排除");
  assert.deepEqual(args.where.purchaseOrderId, { in: ["po-1"] }, "已下单的采购单 id 集合（纯标量条件）");
  noWrites(prisma);
});

test("采购入库量：只算已过账（status=posted）；草稿与已冲销（reversed）都不算", async () => {
  const { prisma, report } = harness(designExample());

  await report.build({});

  const args = callsOf(prisma, "rawMaterialInbound")[0].args;
  assert.deepEqual(args.by, ["orderNo", "materialId", "unitId"]);
  assert.deepEqual(args._sum, { quantity: true });
  assert.deepEqual(args.where, { deletedAt: null, status: "posted" }, "草稿入库还没生效、已冲销入库单的状态是 reversed —— 两者都不是「已入库」");
  noWrites(prisma);
});

test("生产领用：五个来源类型都算（冲销/撤销过账参与净额），且必须来自原料移动单据明细", async () => {
  const { prisma, report } = harness(designExample());

  await report.build({});

  const args = callsOf(prisma, "inventoryFact")[0].args;
  assert.deepEqual(args.by, ["orderNo", "materialId", "unitId"], "按单据自己的订单号归集");
  assert.deepEqual(args._sum, { quantityDelta: true }, "领用数由 quantity_delta 求和后取负，方向判断交给数据库");
  assert.deepEqual(args.where.sourceType.in, [
    "material_issue",
    "material_replenishment",
    "material_return",
    "material_movement_reversal",
    "material_movement_reopen"
  ]);
  assert.equal(args.where.sourceType.in.includes("material_scrap"), false, "报废不算领用：它在库存量那一列体现为减少");
  assert.deepEqual(args.where.rawMaterialMovementLineId, { not: null }, "只算原料移动单据明细产生的事实（盘点/成品进出库没有这个外键）");
  noWrites(prisma);
});

test("库存量：与 GET /inventory/raw-material-balances 同口径（原料仓+报废仓、原料类物料、物料与单位未删）", async () => {
  const { prisma, report } = harness(designExample());

  await report.build({});

  const stockArgs = callsOf(prisma, "inventoryFact")[1].args;
  assert.deepEqual(stockArgs.by, ["materialId", "unitId"], "库存是物料+单位级结存，不按订单拆账");
  // 三个条件都从主数据查询结果里筛成 id 集合（groupBy 的 where 只写标量）：
  //   inventory_category ∈ {raw_material, scrap}；物料 material_type='raw_material' 且未删；单位未删。
  assert.deepEqual(stockArgs.where, {
    materialId: { in: ["m-1"] },
    unitId: { in: ["u-1"] },
    inventoryCategory: { in: ["raw_material", "scrap"] }
  });
  assert.equal("orderNo" in stockArgs.where, false, "同一物料出现在多张订单时，每行库存量都是同一个数");
  noWrites(prisma);
});

test("库存量口径：物料/单位被软删时库存按 0 算（与余额接口一致），但展示列仍显示名字", async () => {
  const deletedAt = new Date("2026-10-01T00:00:00.000Z");
  const { prisma, report } = harness({
    ...designExample(),
    materials: [{ ...materialRow("m-1", "已被删除的物料", "黑"), deletedAt }],
    units: [{ ...unitRow("u-1", "件"), deletedAt }]
  });

  const result = await report.build({});

  assert.equal(result.rows[0].material_name, "已被删除的物料", "软删物料的历史单据行仍要显示名字，不能变成空白");
  assert.equal(result.rows[0].stock_quantity, "0", "余额接口不算已删物料/单位的结存，本表同口径");
  assert.equal(callsOf(prisma, "inventoryFact").length, 1, "筛完库存物料/单位 id 为空时跳过库存聚合，不发 in: []");
});

test("已冲销净额 + 退料抵减：领用 = 领料 + 补料 − 退料 ± 冲销/撤销过账的净额", async () => {
  // 同一（订单, 物料, 单位）在同一 groupBy 里只会返回一行；这里刻意给两行模拟
  // 「领了 3050、退了 50、又冲销了 50」在数据库 SUM 里的净额：−3050 + 50 + 50 = −2950 → 领用 2950。
  const { prisma, report } = harness({
    issueGroups: [
      issueGroup("260119", "m-1", "u-1", "-3050.0000"),
      issueGroup("260119", "m-1", "u-1", "50.0000"),
      issueGroup("260119", "m-1", "u-1", "50.0000")
    ],
    materials: [materialRow("m-1", "伞骨", "银")],
    units: [unitRow("u-1", "支")]
  });

  const result = await report.build({});

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].production_issue_quantity, "2950", "退料与冲销必须从领用里扣掉（净额）");
  noWrites(prisma);
});

test("行集合并集：三个来源各自单独出行，且「采购未入库数」允许为负（超收）", async () => {
  const { prisma, report } = harness({
    purchaseItemGroups: [purchaseGroup("po-1", "m-1", "u-1", "100.0000")],
    inboundGroups: [inboundGroup("260118", "m-2", "u-1", "120.0000")],
    issueGroups: [issueGroup("260117", "m-3", "u-1", "-50.0000")],
    orders: [orderRow("po-1", "260119")],
    materials: [materialRow("m-1", "只下单的料"), materialRow("m-2", "只入库的料"), materialRow("m-3", "只领用的料")],
    units: [unitRow("u-1", "件")]
  });

  const result = await report.build({});

  assert.deepEqual(result.rows.map((row) => [row.order_no, row.purchase_quantity, row.inbound_quantity, row.pending_inbound_quantity, row.production_issue_quantity]), [
    ["260119", "100", "0", "100", "0"],
    // 只有已过账入库、没有已下单采购明细：未入库 = 0 − 120 = −120（超收）
    ["260118", "0", "120", "-120", "0"],
    ["260117", "0", "0", "0", "50"]
  ]);
});

test("超收：采购 100、入库 120 → 采购未入库数 -20（负数就是超收量，前端标红）", async () => {
  const { prisma, report } = harness({
    purchaseItemGroups: [purchaseGroup("po-1", "m-1", "u-1", "100.0000")],
    inboundGroups: [inboundGroup("260119", "m-1", "u-1", "120.0000")],
    orders: [orderRow("po-1", "260119")],
    materials: [materialRow("m-1", "超收的料")],
    units: [unitRow("u-1", "件")]
  });

  const result = await report.build({});

  assert.equal(result.rows[0].pending_inbound_quantity, "-20");
  assert.notEqual(result.rows[0].pending_inbound_quantity, "-0", "相等时不能输出 -0");
  noWrites(prisma);
});

test("库存量不按订单拆账：同一物料出现在两张订单时，两行库存量是同一个当前结存", async () => {
  const { prisma, report } = harness({
    purchaseItemGroups: [purchaseGroup("po-1", "m-1", "u-1", "100.0000"), purchaseGroup("po-2", "m-1", "u-1", "200.0000")],
    stockGroups: [stockGroup("m-1", "u-1", "1650.0000")],
    orders: [orderRow("po-1", "260119"), orderRow("po-2", "260118")],
    materials: [materialRow("m-1", "同一物料")],
    units: [unitRow("u-1", "件")]
  });

  const result = await report.build({});

  assert.deepEqual(result.rows.map((row) => [row.order_no, row.purchase_quantity, row.stock_quantity]), [
    ["260119", "100", "1650"],
    ["260118", "200", "1650"]
  ]);
});

// ------------------------------------------------------------ 行集合与剔除规则

test("全 0 行剔除：领料被冲销干净（净额 0）且无库存时不出行；库存非 0 时保留该行", async () => {
  const { prisma, report } = harness({
    issueGroups: [
      // m-1：领 100 + 冲销 +100 → 净 0，且没有库存 → 五个数量全 0 → 不出行
      issueGroup("260119", "m-1", "u-1", "-100.0000"),
      issueGroup("260119", "m-1", "u-1", "100.0000"),
      // m-2：同样冲销干净，但该物料+单位还有结存 500 → 五个数量不全为 0 → 保留（库存量单独有意义）
      issueGroup("260119", "m-2", "u-1", "-100.0000"),
      issueGroup("260119", "m-2", "u-1", "100.0000")
    ],
    stockGroups: [stockGroup("m-2", "u-1", "500.0000")],
    materials: [materialRow("m-1", "冲销干净的料"), materialRow("m-2", "还有库存的料")],
    units: [unitRow("u-1", "件")]
  });

  const result = await report.build({});

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].material_name, "还有库存的料");
  assert.equal(result.rows[0].production_issue_quantity, "0");
  assert.equal(result.rows[0].stock_quantity, "500");
  noWrites(prisma);
});

test("行集合只来自三类事实：只有库存、没有采购/入库/领用时不出行，也不去查库存", async () => {
  const { prisma, report } = harness({
    stockGroups: [stockGroup("m-1", "u-1", "999.0000")],
    materials: [materialRow("m-1", "有库存但没单据")],
    units: [unitRow("u-1", "件")]
  });

  const result = await report.build({});

  assert.deepEqual(result.rows, []);
  assert.equal(result.rows.length, 0);
  assert.equal(prisma.calls.length, 3, "采购单查询 + 入库/领用两个 groupBy（采购单为空时采购 groupBy 跳过）；来源全空时直接返回，不再做展示列/库存查询");
  assert.equal(callsOf(prisma, "inventoryFact").length, 1, "库存量不参与建行（否则所有有库存的物料都会长出一行）");
  noWrites(prisma);
});

test("空数据：data 是空数组、meta 行数 0，xlsx 也照样导出表头（不是导出失败）", async () => {
  const { report } = harness();
  const exportWithEmpty = new ProcurementWarehouseReportExportService(report);

  const result = await report.report({});
  assert.deepEqual(result.data, []);
  assert.equal(result.meta.row_count, 0);

  const { buffer, rowCount } = await exportWithEmpty.exportWorkbook({});
  assert.equal(rowCount, 0);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.getCell("A3").value, "订单号", "0 行也要有表头：能确定「确实是 0 行」而不是文件坏了");
  assert.ok(String(sheet.getCell("A4").value).startsWith("口径说明："), "空数据的第 4 行直接是口径说明");
});

// =============================================================== 排序

test("排序：订单号数字感知倒序（260119 > 26012 > 2602，不是字符串比较）", async () => {
  const { prisma, report } = harness({
    purchaseItemGroups: [
      purchaseGroup("po-1", "m-1", "u-1", "1.0000"),
      purchaseGroup("po-2", "m-2", "u-1", "1.0000"),
      purchaseGroup("po-3", "m-3", "u-1", "1.0000")
    ],
    orders: [orderRow("po-1", "26012"), orderRow("po-2", "260119"), orderRow("po-3", "2602")],
    materials: [materialRow("m-1", "物料一"), materialRow("m-2", "物料二"), materialRow("m-3", "物料三")],
    units: [unitRow("u-1", "件")]
  });

  const result = await report.build({});

  assert.deepEqual(result.rows.map((row) => row.order_no), ["260119", "26012", "2602"]);
  noWrites(prisma);
});

test("排序：同订单内物料名称升序、单位升序（按码位比，跨机器顺序不变）", async () => {
  const { prisma, report } = harness({
    purchaseItemGroups: [
      purchaseGroup("po-1", "m-1", "u-1", "1.0000"),
      purchaseGroup("po-1", "m-2", "u-1", "1.0000"),
      purchaseGroup("po-1", "m-3", "u-2", "1.0000"),
      purchaseGroup("po-1", "m-3", "u-1", "1.0000")
    ],
    orders: [orderRow("po-1", "260119")],
    // 「手柄」U+624B > 「伞骨」U+4F1E → 伞骨在前；同一物料两个单位：打 U+6253 < 支 U+652F → 打在前。
    materials: [materialRow("m-1", "手柄"), materialRow("m-2", "伞骨"), materialRow("m-3", "伞面")],
    units: [unitRow("u-1", "打"), unitRow("u-2", "支")]
  });

  const result = await report.build({});

  assert.deepEqual(result.rows.map((row) => [row.material_name, row.unit]), [
    ["伞面", "打"],
    ["伞面", "支"],
    ["伞骨", "打"],
    ["手柄", "打"]
  ], "物料名称升序：伞面 < 伞骨 < 手柄（U+4F1E < U+9AA8... 按码位）；同一物料内单位升序：打 < 支");
  noWrites(prisma);
});

test("排序纯函数：compareOrderNoDesc 数字段按数值比，字母数字混合也不会把单号比错", () => {
  const sortDesc = (values) => [...values].sort(compareOrderNoDesc);

  assert.deepEqual(sortDesc(["26012", "260119", "2602"]), ["260119", "26012", "2602"]);
  assert.deepEqual(sortDesc(["DL26012", "DL260119"]), ["DL260119", "DL26012"], "前缀相同也能按数字段比");
  assert.equal(compareOrderNoDesc("260119", "260119"), 0);
});

// =============================================================== 筛选

test("筛选：order_no / material 都是数据库侧的大小写不敏感包含匹配（解析成 id 集合后传给三个来源）", async () => {
  const { prisma, report } = harness(designExample());

  await report.build({ order_no: "260119", material: "伞" });

  const ordersArgs = callsOf(prisma, "purchaseOrder", "findMany")[0].args;
  assert.deepEqual(ordersArgs.where.orderNo, { contains: "260119", mode: "insensitive" }, "订单号筛选走采购单表的标量列");

  const filterMaterialArgs = callsOf(prisma, "material", "findMany")[0].args;
  assert.deepEqual(filterMaterialArgs.where, {
    OR: [
      { name: { contains: "伞", mode: "insensitive" } },
      { materialCode: { contains: "伞", mode: "insensitive" } }
    ]
  }, "物料筛选是「名称 或 编码」包含（物料表自己的条件，不是关联过滤）");

  const purchaseArgs = callsOf(prisma, "purchaseOrderItem")[0].args;
  assert.deepEqual(purchaseArgs.where.purchaseOrderId, { in: ["po-1"] }, "订单筛选 → 已下单采购单 id 集合");
  assert.deepEqual(purchaseArgs.where.materialId, { in: ["m-1"] }, "物料筛选 → 物料 id 集合");

  const inboundArgs = callsOf(prisma, "rawMaterialInbound")[0].args;
  assert.deepEqual(inboundArgs.where.orderNo, { contains: "260119", mode: "insensitive" });
  assert.deepEqual(inboundArgs.where.materialId, { in: ["m-1"] });

  const issueArgs = callsOf(prisma, "inventoryFact")[0].args;
  assert.deepEqual(issueArgs.where.orderNo, { not: null, contains: "260119", mode: "insensitive" });
  assert.deepEqual(issueArgs.where.materialId, { in: ["m-1"] });

  const stockArgs = callsOf(prisma, "inventoryFact")[1].args;
  assert.equal("orderNo" in stockArgs.where, false, "库存量是物料级结存，订单号筛选不该影响它（否则同一物料多订单的库存会变成 0）");
  assert.equal("OR" in stockArgs.where, false, "库存量按收窄后的 materialId 取，不重复拼物料名条件");

  // 有筛选时仍是 7 条查询：物料筛选那条同时就是展示列（不重复查物料表）。
  assert.deepEqual(prisma.calls.map((call) => `${call.model}.${call.op}`), [
    "purchaseOrder.findMany",
    "material.findMany",
    "purchaseOrderItem.groupBy",
    "rawMaterialInbound.groupBy",
    "inventoryFact.groupBy",
    "unit.findMany",
    "inventoryFact.groupBy"
  ]);
  noWrites(prisma);
});

test("筛选：物料一个都没匹配上时直接出空表，不白跑三条聚合", async () => {
  const { prisma, report } = harness({ ...designExample(), filterMaterials: [] });

  const result = await report.build({ material: "不存在的物料" });

  assert.deepEqual(result.rows, []);
  assert.deepEqual(prisma.calls.map((call) => `${call.model}.${call.op}`), ["purchaseOrder.findMany", "material.findMany"]);
  noWrites(prisma);
});

test("筛选：空串/空白串等于「未筛选」，不往 where 里塞 contains 或空 id 集合", async () => {
  const { prisma, report } = harness(designExample());

  const result = await report.build({ order_no: "   ", material: "" });

  const ordersArgs = callsOf(prisma, "purchaseOrder", "findMany")[0].args;
  const purchaseArgs = callsOf(prisma, "purchaseOrderItem")[0].args;
  const inboundArgs = callsOf(prisma, "rawMaterialInbound")[0].args;
  const issueArgs = callsOf(prisma, "inventoryFact")[0].args;
  assert.equal("orderNo" in ordersArgs.where, false);
  assert.equal("materialId" in purchaseArgs.where, false);
  assert.deepEqual(inboundArgs.where, { deletedAt: null, status: "posted" });
  assert.deepEqual(issueArgs.where.orderNo, { not: null });
  assert.equal("materialId" in issueArgs.where, false);
  assert.deepEqual(result.filters, { order_no: null, material: null });
});

test("筛选：前后空白被 trim 后用于查询与回显", async () => {
  const { prisma, report } = harness(designExample());

  const result = await report.build({ order_no: " 260119 ", material: " 伞 " });

  assert.deepEqual(callsOf(prisma, "purchaseOrder", "findMany")[0].args.where.orderNo, { contains: "260119", mode: "insensitive" });
  assert.deepEqual(callsOf(prisma, "material", "findMany")[0].args.where.OR[0].name, { contains: "伞", mode: "insensitive" });
  assert.deepEqual(result.filters, { order_no: "260119", material: "伞" });
});

test("守卫：所有 groupBy 的 where 只含标量字段，不使用未经验证的关联过滤", async () => {
  const { prisma, report } = harness(designExample());

  await report.build({ order_no: "260119", material: "伞" });

  const groupByCalls = prisma.calls.filter((call) => call.op === "groupBy");
  assert.equal(groupByCalls.length, 4, "采购/入库/领用/库存四个聚合");
  // 本仓库既有 20 处 groupBy 全是纯标量 where；关联过滤（purchaseOrder / material / unit ...）
  // 在本项目里没有运行先例，而本机没有 PostgreSQL，单元测试证明不了引擎支持它 ——
  // 这条守卫保证它不会被「顺手优化」回去。
  const SCALAR_KEYS = new Set(["deletedAt", "purchaseOrderId", "materialId", "unitId", "status", "orderNo", "sourceType", "rawMaterialMovementLineId", "inventoryCategory"]);
  for (const call of groupByCalls) {
    for (const key of Object.keys(call.args.where)) {
      assert.ok(SCALAR_KEYS.has(key), `${call.model}.groupBy 的 where 出现了非标量键「${key}」，应当是 id 集合等标量条件`);
    }
  }
  noWrites(prisma);
});

// =============================================================== 行数上限与查询预算

/** N 行数据：每行一个不同的物料（同一订单、同一单位），用于上限测试。 */
function bulkSeed(count) {
  const purchaseItemGroups = [];
  const orders = [orderRow("po-1", "260119")];
  const materials = [];
  for (let index = 0; index < count; index += 1) {
    purchaseItemGroups.push(purchaseGroup("po-1", `m-${index}`, "u-1", "1.0000"));
    materials.push(materialRow(`m-${index}`, `物料${index}`));
  }
  return { purchaseItemGroups, orders, materials, units: [unitRow("u-1", "件")] };
}

test("行数上限：5000 行正常返回，5001 行 422 REPORT_ROW_LIMIT_EXCEEDED（不截断）", async () => {
  const allowed = harness(bulkSeed(5000));
  const allowedResult = await allowed.report.build({});
  assert.equal(allowedResult.rows.length, 5000, "正好 5000 行是允许的（上限而不是上限-1）");

  const rejected = harness(bulkSeed(5001));
  await assert.rejects(
    () => rejected.report.build({}),
    (error) => {
      assert.equal(error.getStatus(), 422, "超上限是业务规则冲突，不是 500");
      assert.equal(error.getResponse().code, "REPORT_ROW_LIMIT_EXCEEDED");
      assert.match(error.getResponse().message, /5000/);
      assert.deepEqual(error.getResponse().details, [{ row_count: 5001, row_limit: 5000 }]);
      return true;
    }
  );
  noWrites(allowed.prisma);
  noWrites(rejected.prisma);
});

test("查询预算：固定 7 条查询，行数从 1 到 5000 都不增加（禁止按行循环查库）", async () => {
  const small = harness(designExample());
  await small.report.build({});
  const expected = [
    "purchaseOrder.findMany",
    "purchaseOrderItem.groupBy",
    "rawMaterialInbound.groupBy",
    "inventoryFact.groupBy",
    "material.findMany",
    "unit.findMany",
    "inventoryFact.groupBy"
  ];
  assert.deepEqual(small.prisma.calls.map((call) => `${call.model}.${call.op}`), expected);

  const large = harness(bulkSeed(5000));
  await large.report.build({});
  assert.equal(large.prisma.calls.length, 7, "5000 行也只有 7 条查询：聚合全部发生在数据库侧");
});

// =============================================================== 数量字符串

test("数量字符串：去掉无意义尾零、-0 归一成 0、负数与四位小数保留", () => {
  assert.equal(formatQuantity(dec("4700.0000")), "4700");
  assert.equal(formatQuantity(dec("0.0000")), "0");
  assert.equal(formatQuantity(dec("-0.0000")), "0", "-0 会让界面把「没欠」标成一笔负数");
  assert.equal(formatQuantity(dec("-0")), "0");
  assert.equal(formatQuantity(dec("12.5000")), "12.5");
  assert.equal(formatQuantity(dec("-20.0000")), "-20", "负数（超收/负库存）必须带符号");
  assert.equal(formatQuantity(dec("0.0001")), "0.0001", "列是 DECIMAL(18,4)，不能把有效小数也删掉");
  assert.equal(formatQuantity(dec("12345678901234.5678")), "12345678901234.5678", "大数量不走指数记法");
  assert.equal(formatQuantity(null), "0");
  assert.equal(formatQuantity(undefined), "0");
  assert.equal(formatQuantity("3050.0000"), "3050");
  assert.equal(formatQuantity(100), "100");
});

test("组装纯函数：五列由 sources 直接算出，颜色为空给空串（展示符 `-` 是前端的事）", () => {
  const rows = buildProcurementWarehouseRows({
    purchase: [{ orderNo: "260119", materialId: "m-1", unitId: "u-1", quantity: dec("10.0000") }],
    inbound: [{ orderNo: "260119", materialId: "m-1", unitId: "u-1", quantity: dec("4.0000") }],
    issue: [{ orderNo: "260119", materialId: "m-1", unitId: "u-1", quantity: dec("-2.0000") }],
    stock: [{ materialId: "m-1", unitId: "u-1", quantity: dec("8.0000") }],
    materials: new Map([["m-1", { name: "无颜色物料", color: null }]]),
    units: new Map([["u-1", "件"]])
  });

  assert.deepEqual(rows, [{
    order_no: "260119",
    material_name: "无颜色物料",
    color: "",
    unit: "件",
    purchase_quantity: "10",
    inbound_quantity: "4",
    pending_inbound_quantity: "6",
    production_issue_quantity: "2",
    stock_quantity: "8"
  }]);
});

// =============================================================== xlsx

/** 导出服务桩：取数结果直接给定，用来单独测版式（取数口径由上面的用例覆盖）。 */
function stubReportService(result) {
  const calls = [];
  return {
    calls,
    build: async (filter) => {
      calls.push(filter);
      return result;
    }
  };
}

const sampleRow = (over = {}) => ({
  order_no: "260119",
  material_name: "58cm*8k自动直骨伞",
  color: "黑色",
  unit: "打",
  purchase_quantity: "4700",
  inbound_quantity: "4700",
  pending_inbound_quantity: "0",
  production_issue_quantity: "3050",
  stock_quantity: "1650",
  ...over
});

const sampleResult = (over = {}) => ({
  rows: over.rows ?? [sampleRow()],
  generatedAt: over.generatedAt ?? new Date("2026-11-04T14:30:00.000Z"),
  filters: over.filters ?? { order_no: "260119", material: null }
});

async function exportAndRead(service, filter = {}) {
  const exported = await service.exportWorkbook(filter);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(exported.buffer);
  return { exported, workbook, sheet: workbook.worksheets[0] };
}

test("xlsx：一个工作表「采购与仓储报表」，A4 横向 + fitToPage，标题/筛选行/九列表头都在", async () => {
  const service = new ProcurementWarehouseReportExportService(stubReportService(sampleResult()));
  const { exported, workbook, sheet } = await exportAndRead(service);

  assert.deepEqual(workbook.worksheets.map((worksheet) => worksheet.name), ["采购与仓储报表"]);
  assert.equal(sheet.pageSetup.paperSize, 9, "A4");
  assert.equal(sheet.pageSetup.orientation, "landscape", "九列在 A4 纵向会被压成半页宽");
  assert.equal(sheet.pageSetup.fitToPage, true);
  assert.equal(sheet.pageSetup.fitToWidth, 1, "一页宽印下");
  assert.equal(sheet.pageSetup.horizontalCentered, true);

  assert.equal(sheet.getCell("A1").value, "迪礼ERP　采购与仓储报表");
  const infoText = String(sheet.getCell("A2").value);
  assert.match(infoText, /订单号包含「260119」/, "筛选条件要印在文件里（文件会被单独转发）");
  assert.match(infoText, /全部物料/);
  assert.match(infoText, /生成时间：2026-11-04 22:30:00/, "生成时间固定北京时间（与文件名同口径）");
  assert.match(infoText, /共 1 行/);

  assert.deepEqual(
    ["A3", "B3", "C3", "D3", "E3", "F3", "G3", "H3", "I3"].map((address) => sheet.getCell(address).value),
    ["订单号", "物料名称", "颜色", "单位", "采购数量", "采购入库量", "采购未入库数", "生产领用数量", "库存量"],
    "表头与屏幕同序同名"
  );
  assert.match(exported.fileName, /^迪礼ERP-采购与仓储报表-\d{14}\.xlsx$/, "文件名 = 报表名 + 北京时间戳");
  assert.deepEqual([...exported.buffer.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], "xlsx 是 zip 容器");
});

test("xlsx：数量写数值单元格（用户在 Excel 里能直接求和），不是文本", async () => {
  const service = new ProcurementWarehouseReportExportService(stubReportService(sampleResult()));
  const { sheet } = await exportAndRead(service);

  assert.equal(sheet.getCell("A4").value, "260119");
  assert.equal(sheet.getCell("B4").value, "58cm*8k自动直骨伞");
  assert.equal(sheet.getCell("C4").value, "黑色");
  assert.equal(sheet.getCell("D4").value, "打");
  for (const [address, expected] of [["E4", 4700], ["F4", 4700], ["G4", 0], ["H4", 3050], ["I4", 1650]]) {
    assert.equal(sheet.getCell(address).value, expected, `${address} 必须是 number`);
    assert.equal(typeof sheet.getCell(address).value, "number");
    assert.equal(sheet.getCell(address).numFmt, "0.####");
  }
});

test("xlsx：负数照样是数值单元格（超收/负库存），末尾一行是整行合并的口径说明", async () => {
  const service = new ProcurementWarehouseReportExportService(stubReportService(sampleResult({
    rows: [sampleRow({ pending_inbound_quantity: "-20", stock_quantity: "-5" })]
  })));
  const { sheet } = await exportAndRead(service);

  assert.equal(sheet.getCell("G4").value, -20);
  assert.equal(sheet.getCell("I4").value, -5);
  const note = String(sheet.getCell("A5").value);
  assert.ok(note.startsWith("口径说明："), "数据行之后紧跟口径说明");
  for (const required of ["不跨单位相加", "库存量不按订单拆账", "不设合计行", "报废不计入领用"]) {
    assert.ok(note.includes(required), `口径说明里必须有「${required}」：文件脱离页面后没人解释就会变成误解`);
  }
});

test("xlsx：行高按长物料名折行算，长名字不被截成一行", async () => {
  const longName = "超长物料名称".repeat(8); // 48 个汉字 ≈ 96 个列宽单位，34 个单位宽 → 至少 3 行
  const service = new ProcurementWarehouseReportExportService(stubReportService(sampleResult({
    rows: [sampleRow({ material_name: longName })]
  })));
  const { sheet } = await exportAndRead(service);

  assert.equal(sheet.getCell("B4").value, longName, "名字原样写入（不截断）");
  assert.ok(sheet.getRow(4).height > 20, `长名字要折行加高（实际 ${sheet.getRow(4).height}），写死 20 会把第二行压在行线上`);
});

test("xlsx：行数超 5000 时导出同样 422（与屏幕同一个取数函数，不另算一套）", async () => {
  const { report } = harness(bulkSeed(5001));
  const service = new ProcurementWarehouseReportExportService(report);

  await assert.rejects(
    () => service.exportWorkbook({}),
    (error) => error.getStatus() === 422 && error.getResponse().code === "REPORT_ROW_LIMIT_EXCEEDED"
  );
});

test("xlsx：导出只取数一次，且筛选条件与屏幕完全相同地传下去", async () => {
  const stub = stubReportService(sampleResult());
  const service = new ProcurementWarehouseReportExportService(stub);

  await service.exportWorkbook({ order_no: "260119", material: "伞" });

  assert.deepEqual(stub.calls, [{ order_no: "260119", material: "伞" }], "取数只发生一次（导出自算一遍是最经典的翻车点）");
});

// =============================================================== 控制器：路由 / DTO / 权限 / 响应头

function stubResponse() {
  return {
    headers: {},
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    send(body) {
      this.body = body;
      return body;
    }
  };
}

function controllerHarness() {
  const reportCalls = [];
  const exportCalls = [];
  const reportResult = { data: [{ order_no: "260119" }], meta: { row_count: 1, row_limit: 5000, generated_at: "2026-11-04T14:30:00.000Z", filters: { order_no: "260119", material: null } } };
  const controller = new ReportsController(
    {},
    { report: async (filter) => { reportCalls.push(filter); return reportResult; } },
    {
      exportWorkbook: async (filter) => {
        exportCalls.push(filter);
        return { buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]), fileName: "迪礼ERP-采购与仓储报表-20261104223000.xlsx", rowCount: 1 };
      }
    }
  );
  return { controller, reportCalls, exportCalls, reportResult };
}

test("控制器：两条路由的路径/方法/权限元数据正确，且声明在 :report/export 之前", () => {
  const prototype = ReportsController.prototype;
  for (const [handler, expectedPath] of [
    [prototype.procurementWarehouse, "procurement-warehouse"],
    [prototype.exportProcurementWarehouse, "procurement-warehouse/export.xlsx"]
  ]) {
    assert.equal(Reflect.getMetadata(PATH_METADATA, handler), expectedPath);
    assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.GET);
    assert.deepEqual(Reflect.getMetadata(REQUIRED_ANY_MODULES, handler), ["procurement", "warehouse"], "采购或仓库任一模组可看");
  }

  // Nest/Express 按声明顺序匹配，静态路由必须在参数路由之前，否则会被 `:report` 吃掉。
  // 注意：文档注释里也会提到 `@Get(":report/export")`，所以参数路由要用「带方法签名」的锚点匹配。
  const controllerSource = fs.readFileSync(path.join(ROOT, "src", "modules", "reports", "reports.controller.ts"), "utf8");
  const exportRouteIndex = controllerSource.indexOf('@Get("procurement-warehouse/export.xlsx")');
  const reportRouteIndex = controllerSource.indexOf('@Get("procurement-warehouse")');
  const paramRouteIndex = controllerSource.indexOf('@Get(":report/export") async export(');
  assert.ok(reportRouteIndex >= 0 && exportRouteIndex >= 0);
  assert.ok(reportRouteIndex < paramRouteIndex, "屏幕路由要排在 :report/export 之前");
  assert.ok(exportRouteIndex < paramRouteIndex, "导出路由要排在 :report/export 之前");
});

test("控制器：屏幕接口把筛选条件交给取数服务，并原样返回 data/meta", async () => {
  const { controller, reportCalls, reportResult } = controllerHarness();

  const response = await controller.procurementWarehouse({ order_no: "260119", material: "伞" });

  assert.deepEqual(reportCalls, [{ order_no: "260119", material: "伞" }]);
  assert.equal(response, reportResult);
});

test("控制器：导出是 xlsx 附件（中文文件名 UTF-8 编码 + no-store），body 是二进制", async () => {
  const { controller, exportCalls } = controllerHarness();
  const response = stubResponse();

  await controller.exportProcurementWarehouse({ order_no: "260119" }, response);

  assert.deepEqual(exportCalls, [{ order_no: "260119" }]);
  assert.equal(response.headers["Content-Type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(response.headers["Cache-Control"], "no-store");
  const disposition = response.headers["Content-Disposition"];
  assert.match(disposition, /^attachment; filename\*=UTF-8''/);
  const fileName = decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(disposition)[1]);
  assert.match(fileName, /^迪礼ERP-采购与仓储报表-\d{14}\.xlsx$/);
  assert.deepEqual([...response.body.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
});

test("DTO：order_no / material 可选、只收字符串、限长与库里的列宽对齐", async () => {
  const validateDto = async (payload) => (await validate(plainToInstance(ProcurementWarehouseQueryDto, payload))).map((error) => error.property);

  assert.deepEqual(await validateDto({}), [], "两个筛选都是可选的（不给＝全部）");
  assert.deepEqual(await validateDto({ order_no: "260119", material: "伞" }), []);
  assert.deepEqual(await validateDto({ order_no: "x".repeat(100) }), [], "订单号列 VARCHAR(100)，100 字以内合法");
  assert.deepEqual(await validateDto({ order_no: "x".repeat(101) }), ["order_no"]);
  assert.deepEqual(await validateDto({ material: "x".repeat(200) }), [], "物料名称列 VARCHAR(200)");
  assert.deepEqual(await validateDto({ material: "x".repeat(201) }), ["material"]);
  assert.deepEqual(await validateDto({ order_no: 123 }), ["order_no"], "数字不是字符串");
});

test("模块：两个新 provider 已注册进 ReportsModule", () => {
  const moduleSource = fs.readFileSync(path.join(ROOT, "src", "modules", "reports", "reports.module.ts"), "utf8");
  assert.match(moduleSource, /providers:\s*\[[^\]]*ProcurementWarehouseReportService/);
  assert.match(moduleSource, /providers:\s*\[[^\]]*ProcurementWarehouseReportExportService/);
});

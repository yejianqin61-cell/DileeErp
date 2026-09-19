// 库存盘点（仓库）：导入盘点表 → 草稿校核 → 确认时生成库存调整事实 → 冲销。
//
// 用户 2026-09-16：「仓库模块增加一个盘点管理，可以将每月一次的盘点数据导入系统，调整库存物料数量。
// 物料的产品代码作为唯一性，在新建物料时自动生成一个物料代码。物料导入模板，需要有这些 column：
// 产品名称 / 产品规格 / 产品代码 / 仓位 / 货位 / 实际数量」。
//
// 两层：
//   1. 纯函数层（stocktake-import.ts）：表头按名字认列、逐行校验、行级错误不连坐、
//      「产品代码在一份表里唯一」、实盘数允许 0 但留空报错、模板闭环（模板能被自己的解析器读回）；
//   2. 服务层（StocktakeService）：产品代码匹配物料（不自动建档）、一个事务写草稿单、
//      确认时**按确认当时的账面数重算**差额、冲销写反向事实、只有草稿能改能删。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException, ValidationPipe } = require("@nestjs/common");
const { Prisma } = require("@prisma/client");
const XLSX = require("xlsx");
const { parseStocktakeRows, stocktakeTemplateWorkbook, normalizeQuantityCell, STOCKTAKE_MAX_ROWS } = require("../../dist/modules/warehouse/stocktake-import.js");
const { StocktakeService } = require("../../dist/modules/warehouse/stocktake.service.js");
const { StocktakeImportDto, StocktakeLineDto } = require("../../dist/modules/warehouse/stocktake.controller.js");

const user = { id: "00000000-0000-0000-0000-000000000001", username: "tester" };
const decimal = (value) => new Prisma.Decimal(value);
/** 自动编码的前缀带当天日期（平台统一规则），断言里必须用当天，否则第二天就红。 */
const TODAY = new Date().toISOString().slice(0, 10).replaceAll("-", "");

/** 用真实 xlsx 打一次往返：解析器吃的就是 Excel 里读出来的形状，而不是手搓的数组。 */
function workbookBuffer(rows, sheetName = "库存盘点导入") {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

function sheetRows(buffer, sheetName) {
  const book = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheet = sheetName ? book.Sheets[sheetName] : book.Sheets[book.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
}

const HEADER = ["产品名称", "产品规格", "产品代码", "仓位", "货位", "实际数量"];
const parse = (rows) => parseStocktakeRows(sheetRows(workbookBuffer([HEADER, ...rows])));

// ---------------------------------------------------------------------------
// 纯函数：模板、表头与逐行校验
// ---------------------------------------------------------------------------

test("模板闭环：下载的模板能被自己的解析器读回，两行示例都通过校验", () => {
  const parsed = parseStocktakeRows(sheetRows(stocktakeTemplateWorkbook()));

  assert.equal(parsed.status, "ok");
  assert.equal(parsed.total, 2);
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.ignoredColumns, []); // 模板列必须全部属于口径，否则操作员会以为填了没用
  assert.equal(parsed.headerRow, 1);
  // 第二行示例的实盘数是 0：模板要示范「盘没了就填 0」这件最容易写错的事
  assert.equal(parsed.rows[1].actualQuantity, "0");
  // 模板没有「差异原因」列，必须提示可以自己加一列（用户点名的就是 6 列，不擅自改模板）
  assert.match(parsed.hints.join(" "), /差异原因/);
});

test("按表头名认列：列顺序打乱、多余列被忽略、备注列当作差异原因", () => {
  const parsed = parseStocktakeRows(sheetRows(workbookBuffer([
    ["实际数量", "仓位", "产品代码", "盘点人", "产品名称", "备注", "产品规格", "货位"],
    ["120", "A区", "MAT-1", "老王", "涤纶布", "受潮报废", "150D", "A-01"],
  ])));

  assert.equal(parsed.status, "ok");
  assert.deepEqual(parsed.ignoredColumns, ["盘点人"]);
  assert.deepEqual(parsed.rows[0], {
    row: 2, productCode: "MAT-1", productName: "涤纶布", specification: "150D",
    warehouseZone: "A区", binLocation: "A-01", actualQuantity: "120", differenceReason: "受潮报废",
  });
});

test("缺必需列：只回一条整体错误、一行都不解析（不是把每行都报一遍）", () => {
  const parsed = parseStocktakeRows(sheetRows(workbookBuffer([
    ["产品名称", "仓位", "实际数量"],
    ["涤纶布", "A区", "120"],
  ])));

  assert.equal(parsed.status, "failed");
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0].reason, /产品代码/);
  assert.deepEqual(parsed.missingColumns, ["产品代码"]);
});

test("缺实际数量列同样是整批失败：没有实盘数就没有盘点这回事", () => {
  const parsed = parseStocktakeRows(sheetRows(workbookBuffer([["产品名称", "产品代码"], ["涤纶布", "MAT-1"]])));

  assert.equal(parsed.status, "failed");
  assert.deepEqual(parsed.missingColumns, ["实际数量"]);
  assert.equal(parsed.errors.length, 1);
});

test("表头下面没有数据行：报在表头下一行，不假装成功", () => {
  const parsed = parseStocktakeRows(sheetRows(workbookBuffer([HEADER])));

  assert.equal(parsed.status, "failed");
  assert.equal(parsed.total, 0);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].row, 2);
});

test("实盘数允许 0，但留空必须报错——留空多半是漏填，静默当 0 会凭空盘亏一整行", () => {
  const parsed = parse([
    ["涤纶布", "150D", "MAT-1", "A区", "A-01", "0"],
    ["松紧带", "5mm", "MAT-2", "B区", "B-01", ""],
  ]);

  assert.equal(parsed.status, "partial");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].actualQuantity, "0");
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].row, 3);
  assert.match(parsed.errors[0].reason, /填 0/);
});

test("实盘数归一化：千分位、货币符号、全角数字、数字单元格都认；负数与 1e3 与 5 位小数不认", () => {
  assert.equal(normalizeQuantityCell("1,200.50"), "1200.50");
  assert.equal(normalizeQuantityCell("￥1200"), "1200");
  assert.equal(normalizeQuantityCell("１２０"), "120");
  assert.equal(normalizeQuantityCell(120.5), "120.5");
  assert.equal(normalizeQuantityCell(""), "");
  assert.equal(normalizeQuantityCell("abc"), "");

  for (const bad of ["-1", "1e3", "0.00004", "100000000000000000"]) {
    const parsed = parse([["涤纶布", "150D", "MAT-1", "A区", "A-01", bad]]);
    assert.equal(parsed.rows.length, 0, `实盘数 ${bad} 必须被拒绝`);
    assert.equal(parsed.errors.length, 1);
  }
});

test("产品代码在一份表里唯一：同一产品分两行会让账面被减两遍，必须拒绝并指向首次出现的行", () => {
  const parsed = parse([
    ["涤纶布", "150D", "MAT-1", "A区", "A-01", "30"],
    ["涤纶布", "150D", "mat-1", "B区", "B-01", "40"],
  ]);

  assert.equal(parsed.status, "partial");
  assert.equal(parsed.rows.length, 1, "只保留第一行");
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].row, 3);
  assert.match(parsed.errors[0].reason, /第 2 行/);
  // 大小写与空格不影响判定（'mat-1' 与 'MAT-1' 是同一个物料）
  assert.match(parsed.errors[0].reason, /相加/);
});

test("产品代码为空的行报错；仓位/货位/产品名称/产品规格 缺失只提示不拦", () => {
  const missingCode = parse([["涤纶布", "150D", "", "A区", "A-01", "30"]]);
  assert.equal(missingCode.errors.length, 1);
  assert.match(missingCode.errors[0].reason, /产品代码/);

  const lean = parseStocktakeRows(sheetRows(workbookBuffer([["产品代码", "实际数量"], ["MAT-1", "30"]])));
  assert.equal(lean.status, "ok");
  assert.equal(lean.rows.length, 1);
  assert.match(lean.hints.join(" "), /产品名称/);
  assert.match(lean.hints.join(" "), /仓位/);
});

test("文档形态（表头不在第一行）：数据块到第一个空行为止，表尾说明行不会被当成数据", () => {
  const parsed = parseStocktakeRows(sheetRows(workbookBuffer([
    ["2026 年 9 月库存盘点表"],
    HEADER,
    ["涤纶布", "150D", "MAT-1", "A区", "A-01", "30"],
    ["", "", "", "", "", ""],
    ["盘点人：老王", "", "", "", "", ""],
  ])));

  assert.equal(parsed.status, "ok");
  assert.equal(parsed.headerRow, 2);
  assert.equal(parsed.dataStartRow, 3);
  assert.equal(parsed.total, 1);
  assert.equal(parsed.ignoredTrailingRows, 2);
});

test("单次导入的行数上限是常量（服务层据此挡住误传的整本台账）", () => {
  assert.equal(typeof STOCKTAKE_MAX_ROWS, "number");
  assert.ok(STOCKTAKE_MAX_ROWS >= 500);
});

// ---------------------------------------------------------------------------
// 服务层
// ---------------------------------------------------------------------------

const MATERIALS = [
  { id: "m-1", materialCode: "MAT-1", name: "涤纶布", specificationModel: "150D", defaultUnitId: "u-1" },
  { id: "m-2", materialCode: "MAT-2", name: "松紧带", specificationModel: "5mm", defaultUnitId: "u-2" },
];

function stocktakeService(overrides = {}) {
  const created = { headers: [], lines: [], facts: [], lineUpdates: [], headerUpdates: [], audits: [] };
  const tx = {
    $queryRawUnsafe: async () => undefined,
    stocktake: {
      create: async ({ data }) => { created.headers.push(data); return { id: "st-1", ...data }; },
      update: async ({ data }) => { created.headerUpdates.push(data); return { id: "st-1", ...data }; },
      findFirst: async () => overrides.stocktake ?? null,
    },
    stocktakeLine: {
      create: async ({ data }) => { created.lines.push(data); return { id: `line-${created.lines.length}`, ...data }; },
      update: async ({ where, data }) => { created.lineUpdates.push({ where, data }); return { id: where.id, ...data }; },
    },
    inventoryFact: { create: async ({ data }) => { created.facts.push(data); return data; } },
  };
  const prisma = {
    material: { findMany: async () => overrides.materials ?? MATERIALS },
    stocktake: {
      findMany: async (args) => (args?.where?.stocktakeNo ? (overrides.existingCodes ?? []) : (overrides.headers ?? [])),
      findFirst: async () => overrides.stocktake ?? null,
      update: async ({ data }) => { created.headerUpdates.push(data); return { id: "st-1", ...data }; },
    },
    stocktakeLine: {
      groupBy: async (args) => (args?.where?.differenceSnapshot ? (overrides.differingCounts ?? []) : (overrides.lineCounts ?? [])),
      findFirst: async () => overrides.line ?? null,
      delete: async ({ where }) => { created.deletedLine = where.id; return { id: where.id }; },
      update: async ({ where, data }) => { created.lineUpdates.push({ where, data }); return { id: where.id, ...data }; },
    },
    $transaction: async (fn) => fn(tx),
  };
  const inventory = {
    rawMaterialBalances: async () => overrides.balances ?? [],
    rawMaterialBalance: async (_client, materialId) => overrides.liveBooks?.[materialId] ?? overrides.liveBook ?? decimal(0),
  };
  const audit = {
    create: () => ({ createdBy: user.id, updatedBy: user.id }),
    update: () => ({ updatedBy: user.id }),
    softDelete: () => ({ deletedAt: new Date("2026-09-16T00:00:00.000Z"), deletedBy: user.id, updatedBy: user.id }),
    record: async (...args) => { created.audits.push(args); },
  };
  return { service: new StocktakeService(prisma, audit, inventory), created };
}

function importFile(rows, originalname = "2026-09库存盘点.xlsx") {
  return { buffer: workbookBuffer([HEADER, ...rows]), originalname };
}

test("导入：按产品代码匹配物料（忽略大小写与空格），账面数取导入当时的原料库存，差异 = 实盘 − 账面", async () => {
  const { service, created } = stocktakeService({
    existingCodes: [{ stocktakeNo: `PD-${TODAY}-0004` }],
    balances: [{ material_id: "m-1", unit_id: "u-1", quantity: "100" }],
  });

  const result = await service.import(importFile([
    ["涤纶布", "150D", "mat-1", "A区", "A-01", "90"],
    ["松紧带", "5mm", "MAT-2", "B区", "B-01", "0"],
  ]), { period_month: "2026-09" }, user);

  assert.equal(result.status, "ok");
  assert.equal(result.imported, 2);
  assert.equal(result.errorCount, 0);
  // 单号 = PD-当天日期-序号（当天已有 0004 → 本次 0005），与物料/供应商/客户共用同一套自动编码
  assert.equal(result.stocktakeNo, `PD-${TODAY}-0005`, "单号按当天已有编码的序号 +1");
  assert.equal(created.headers.length, 1);
  assert.equal(created.headers[0].status, "draft");
  assert.equal(created.headers[0].periodMonth, "2026-09");
  assert.equal(created.headers[0].sourceFileName, "2026-09库存盘点.xlsx");

  // 快照以**物料主数据**为准（表里写的是小写 mat-1，落库的是 MAT-1），行号按文件顺序
  assert.equal(created.lines[0].productCodeSnapshot, "MAT-1");
  assert.equal(created.lines[0].productNameSnapshot, "涤纶布");
  assert.equal(created.lines[0].specificationSnapshot, "150D");
  assert.equal(created.lines[0].unitId, "u-1");
  assert.equal(created.lines[0].lineNo, 1);
  assert.equal(created.lines[0].bookQuantitySnapshot.toString(), "100");
  assert.equal(created.lines[0].differenceSnapshot.toString(), "-10", "盘亏 = 90 − 100");
  // 没有库存事实的物料 m-2 账面按 0，实盘 0 → 差异 0
  assert.equal(created.lines[1].bookQuantitySnapshot.toString(), "0");
  assert.equal(created.lines[1].differenceSnapshot.toString(), "0");
  assert.equal(created.lines[1].lineNo, 2);
  // 草稿阶段不写任何库存事实
  assert.equal(created.facts.length, 0);
  assert.ok(created.audits.some(([action]) => action === "stocktake.import"));
});

test("导入：产品代码在物料清单里找不到时逐行报错、不自动建档；其余行照常入单（partial）", async () => {
  const { service, created } = stocktakeService({ balances: [{ material_id: "m-1", unit_id: "u-1", quantity: "100" }] });

  const result = await service.import(importFile([
    ["涤纶布", "150D", "MAT-1", "A区", "A-01", "90"],
    ["没建过的料", "", "MAT-404", "C区", "C-01", "5"],
  ]), { period_month: "2026-09" }, user);

  assert.equal(result.status, "partial");
  assert.equal(result.imported, 1);
  assert.equal(result.errorCount, 1);
  assert.equal(result.errors[0].row, 3);
  assert.match(result.errors[0].reason, /物料清单/);
  assert.match(result.errors[0].reason, /新建这个物料/);
  // 只建了匹配到的那一行，且没有偷偷建物料
  assert.equal(created.lines.length, 1);
  assert.equal(created.lines[0].materialId, "m-1");
});

test("导入：全部行都匹配不到物料时一行都不写（不生成空盘点单）", async () => {
  const { service, created } = stocktakeService();

  const result = await service.import(importFile([["甲", "", "MAT-404", "", "", "5"]]), { period_month: "2026-09" }, user);

  assert.equal(result.status, "failed");
  assert.equal(result.imported, 0);
  assert.equal(result.stocktakeId, null);
  assert.equal(created.headers.length, 0);
  assert.equal(created.lines.length, 0);
  assert.match(result.hints.join(" "), /没有生成盘点单/);
});

test("导入：没有文件 / 不是 Excel → 422，提示去看模板", async () => {
  const { service } = stocktakeService();
  await assert.rejects(() => service.import(undefined, { period_month: "2026-09" }, user), (error) => error.getResponse().code === "STOCKTAKE_IMPORT_FILE_REQUIRED");
  await assert.rejects(
    () => service.import({ buffer: Buffer.from("x"), originalname: "盘点.csv" }, { period_month: "2026-09" }, user),
    (error) => error.getResponse().code === "STOCKTAKE_IMPORT_INVALID_FILE",
  );
});

test("导入：同一个月份已有单子时给出提示（不拦），并说明差异都按各自确认当时的账面算", async () => {
  const { service } = stocktakeService({ headers: [{ stocktakeNo: "PD-20260901-0001", status: "confirmed" }] });

  const result = await service.import(importFile([["涤纶布", "150D", "MAT-1", "A区", "A-01", "1"]]), { period_month: "2026-09" }, user);

  assert.equal(result.status, "ok");
  assert.match(result.hints.join(" "), /2026-09 已有 1 张盘点单/);
  assert.match(result.hints.join(" "), /确认当时的账面数/);
});

// ---------- 确认 ----------

const draftStocktake = (lines) => ({
  id: "st-1",
  stocktakeNo: "PD-20260916-0001",
  status: "draft",
  periodMonth: "2026-09",
  lines: lines.map((line, index) => ({
    id: `line-${index + 1}`,
    lineNo: line.lineNo ?? index + 1,
    materialId: line.materialId,
    unitId: line.unitId,
    productCodeSnapshot: line.productCodeSnapshot ?? "MAT-1",
    actualQuantity: decimal(line.actualQuantity),
    bookQuantitySnapshot: decimal(line.bookQuantitySnapshot),
    differenceSnapshot: decimal(line.differenceSnapshot),
    differenceReason: line.differenceReason ?? null,
    material: { name: line.materialName ?? "涤纶布", materialCode: line.productCodeSnapshot ?? "MAT-1", deletedAt: line.materialDeletedAt ?? null },
  })),
});

test("确认：差额按**确认当时**的账面数重算（导入后仓库又发过料，那笔发料不会被盘点冲掉）", async () => {
  // 导入时账面 100、实盘 90 → 看上去是盘亏 10；确认时账面已经变成 80（其间发料 20）→ 实际是盘盈 10
  const { service, created } = stocktakeService({
    stocktake: draftStocktake([{ materialId: "m-1", unitId: "u-1", actualQuantity: "90", bookQuantitySnapshot: "100", differenceSnapshot: "-10" }]),
    liveBooks: { "m-1": decimal(80) },
  });

  const result = await service.confirm("st-1", user);

  assert.equal(result.adjusted, 1);
  assert.equal(result.unchanged, 0);
  assert.equal(created.facts.length, 1);
  assert.equal(created.facts[0].quantityDelta.toString(), "10", "差额 = 实盘 90 − 确认时账面 80");
  assert.equal(created.facts[0].sourceType, "stocktake_adjustment");
  assert.equal(created.facts[0].sourceId, "line-1");
  assert.equal(created.facts[0].stocktakeLineId, "line-1");
  assert.equal(created.facts[0].inventoryCategory, "raw_material");
  // 两个账面数都留下：导入时（操作员看到的）与确认时（真正参与计算的）
  const lineUpdate = created.lineUpdates[0].data;
  assert.equal(lineUpdate.bookQuantityAtConfirm.toString(), "80");
  assert.equal(lineUpdate.appliedQuantity.toString(), "10");
  // 「导入后有变动」要如实回报，否则操作员不知道差异为什么和文件里不一样
  assert.equal(result.changedAfterImport.length, 1);
  assert.equal(result.changedAfterImport[0].book_quantity_snapshot, "100");
  assert.equal(result.changedAfterImport[0].book_quantity_at_confirm, "80");
  assert.equal(created.headerUpdates[0].status, "confirmed");
  assert.ok(created.audits.some(([action]) => action === "stocktake.confirm"));
});

test("确认：实盘与账面相等时不写 0 差额事实；差异行没有原因仍可确认，但要回报条数", async () => {
  const { service, created } = stocktakeService({
    stocktake: draftStocktake([
      { materialId: "m-1", unitId: "u-1", actualQuantity: "50", bookQuantitySnapshot: "50", differenceSnapshot: "0" },
      { materialId: "m-2", unitId: "u-2", productCodeSnapshot: "MAT-2", actualQuantity: "30", bookQuantitySnapshot: "25", differenceSnapshot: "5", differenceReason: "上月漏记" },
      { materialId: "m-3", unitId: "u-1", productCodeSnapshot: "MAT-3", actualQuantity: "10", bookQuantitySnapshot: "12", differenceSnapshot: "-2" },
    ]),
    liveBooks: { "m-1": decimal(50), "m-2": decimal(25), "m-3": decimal(12) },
  });

  const result = await service.confirm("st-1", user);

  assert.equal(result.adjusted, 2);
  assert.equal(result.unchanged, 1);
  assert.equal(created.facts.length, 2, "0 差额不写事实（写进去只是噪音）");
  assert.deepEqual(created.facts.map((fact) => fact.quantityDelta.toString()), ["5", "-2"]);
  assert.equal(result.differingWithoutReason.length, 1, "MAT-3 没有填差异原因");
  assert.equal(result.differingWithoutReason[0].product_code, "MAT-3");
});

test("确认：物料在导入之后被删除 → 422 并指明行号（否则差额会等于实盘数，平白给已删物料加库存）", async () => {
  const { service, created } = stocktakeService({
    stocktake: draftStocktake([{ materialId: "m-1", unitId: "u-1", actualQuantity: "90", bookQuantitySnapshot: "100", differenceSnapshot: "-10", materialDeletedAt: new Date("2026-09-16T00:00:00.000Z") }]),
    liveBooks: { "m-1": decimal(0) },
  });

  await assert.rejects(() => service.confirm("st-1", user), (error) => error.getResponse().code === "STOCKTAKE_MATERIAL_UNAVAILABLE" && /第 1 行/.test(error.getResponse().message));
  assert.equal(created.facts.length, 0);
});

test("确认：只有草稿能确认（重复确认必须是 409，而不是把同一批差额再调一遍）", async () => {
  const { service, created } = stocktakeService({ stocktake: { ...draftStocktake([{ materialId: "m-1", unitId: "u-1", actualQuantity: "90", bookQuantitySnapshot: "100", differenceSnapshot: "-10" }]), status: "confirmed" } });

  await assert.rejects(() => service.confirm("st-1", user), (error) => error.getResponse().code === "STOCKTAKE_NOT_DRAFT");
  assert.equal(created.facts.length, 0);
});

test("确认：没有明细行的空盘点单不允许确认", async () => {
  const { service } = stocktakeService({ stocktake: draftStocktake([]) });
  await assert.rejects(() => service.confirm("st-1", user), (error) => error.getResponse().code === "STOCKTAKE_EMPTY");
});

// ---------- 冲销 ----------

test("冲销：按行等额反向写回（不删历史事实），状态置为已冲销并留下原因", async () => {
  const confirmed = draftStocktake([
    { materialId: "m-1", unitId: "u-1", actualQuantity: "90", bookQuantitySnapshot: "100", differenceSnapshot: "-10" },
    { materialId: "m-2", unitId: "u-2", productCodeSnapshot: "MAT-2", actualQuantity: "25", bookQuantitySnapshot: "25", differenceSnapshot: "0" },
  ]);
  confirmed.status = "confirmed";
  confirmed.lines[0].appliedQuantity = decimal("-10");
  confirmed.lines[1].appliedQuantity = decimal(0);
  const { service, created } = stocktakeService({ stocktake: confirmed });

  const result = await service.reverse("st-1", "仓管点错了一行", user);

  assert.equal(result.reverted, 1, "0 差额的行没有事实可冲，跳过");
  assert.equal(created.facts.length, 1);
  assert.equal(created.facts[0].quantityDelta.toString(), "10");
  assert.equal(created.facts[0].sourceType, "stocktake_reversal");
  assert.equal(created.headerUpdates[0].status, "reversed");
  assert.equal(created.headerUpdates[0].reversalReason, "仓管点错了一行");
  assert.ok(created.audits.some(([action]) => action === "stocktake.reverse"));
});

test("冲销：草稿不能冲销（没确认过就没有调整可冲）", async () => {
  const { service } = stocktakeService({ stocktake: draftStocktake([{ materialId: "m-1", unitId: "u-1", actualQuantity: "90", bookQuantitySnapshot: "100", differenceSnapshot: "-10" }]) });
  await assert.rejects(() => service.reverse("st-1", "x", user), (error) => error.getResponse().code === "STOCKTAKE_NOT_CONFIRMED");
});

test("冲销：原因必填且在查单子之前校验（空原因永远是可解释的 422，不是 404）", async () => {
  // 单子故意不存在：如果实现先查单子，这里会得到 404，操作员会以为是单号错了
  const { service, created } = stocktakeService({ stocktake: null });

  for (const reason of ["", "   "]) {
    await assert.rejects(() => service.reverse("st-1", reason, user), (error) => error.getResponse().code === "STOCKTAKE_REVERSAL_REASON_REQUIRED");
  }
  assert.equal(created.facts.length, 0);
  assert.equal(created.headerUpdates.length, 0);
});

// ---------- 草稿行编辑 ----------

test("改明细：草稿可以改实盘数与差异原因，差异随之重算", async () => {
  const { service, created } = stocktakeService({
    line: { id: "line-1", lineNo: 1, actualQuantity: decimal(90), bookQuantitySnapshot: decimal(100), differenceSnapshot: decimal(-10), differenceReason: null, stocktake: { id: "st-1", status: "draft", stocktakeNo: "PD-1" } },
  });

  const updated = await service.updateLine("line-1", { actual_quantity: "105", difference_reason: "上一次盘错了" }, user);

  assert.equal(updated.actual_quantity, "105");
  assert.equal(updated.difference_snapshot, "5");
  assert.equal(updated.difference_reason, "上一次盘错了");
  assert.ok(created.audits.some(([action]) => action === "stocktake.line_update"));
});

test("改明细：实盘数走平台数量守卫（负数、1e3、5 位小数一律 422）", async () => {
  const { service } = stocktakeService({
    line: { id: "line-1", lineNo: 1, actualQuantity: decimal(90), bookQuantitySnapshot: decimal(100), differenceSnapshot: decimal(-10), differenceReason: null, stocktake: { id: "st-1", status: "draft", stocktakeNo: "PD-1" } },
  });

  for (const value of ["-1", "1e3", "0.00004", ""]) {
    await assert.rejects(() => service.updateLine("line-1", { actual_quantity: value }, user), (error) => error instanceof UnprocessableEntityException, `实盘数 ${value} 必须被拒绝`);
  }
});

test("改明细 / 删明细 / 删单头：已确认的单子一律 409，只能冲销", async () => {
  const confirmedLine = { id: "line-1", lineNo: 1, stocktake: { id: "st-1", status: "confirmed", stocktakeNo: "PD-1" } };
  const { service, created } = stocktakeService({ line: confirmedLine, stocktake: { id: "st-1", stocktakeNo: "PD-1", status: "confirmed", periodMonth: "2026-09" } });

  await assert.rejects(() => service.updateLine("line-1", { difference_reason: "改一下" }, user), (error) => error.getResponse().code === "STOCKTAKE_NOT_DRAFT");
  await assert.rejects(() => service.removeLine("line-1", user), (error) => error.getResponse().code === "STOCKTAKE_NOT_DRAFT");
  await assert.rejects(() => service.remove("st-1", user), (error) => error.getResponse().code === "STOCKTAKE_NOT_DRAFT");
  assert.equal(created.deletedLine, undefined);
});

test("删明细：草稿行是物理删除（草稿不是业务事实，留着只会让行号对不上）", async () => {
  const { service, created } = stocktakeService({
    line: { id: "line-1", lineNo: 3, productCodeSnapshot: "MAT-1", actualQuantity: decimal(90), stocktake: { id: "st-1", status: "draft", stocktakeNo: "PD-1" } },
  });

  await service.removeLine("line-1", user);

  assert.equal(created.deletedLine, "line-1");
  assert.ok(created.audits.some(([action]) => action === "stocktake.line_delete"));
});

test("删单头：草稿走软删除并审计", async () => {
  const { service, created } = stocktakeService({ stocktake: { id: "st-1", stocktakeNo: "PD-1", status: "draft", periodMonth: "2026-09" } });

  await service.remove("st-1", user);

  assert.equal(created.headerUpdates[0].deletedBy, user.id);
  assert.ok(created.headerUpdates[0].deletedAt instanceof Date);
  assert.ok(created.audits.some(([action]) => action === "stocktake.delete"));
});

// ---------- 列表与汇总 ----------

test("列表：明细数与差异行数按行统计（不做跨单位数量合计）", async () => {
  const { service } = stocktakeService({
    headers: [{ id: "st-1", stocktakeNo: "PD-1", periodMonth: "2026-09", status: "confirmed", sourceFileName: null, importedAt: null, confirmedAt: null, reversedAt: null, reversalReason: null, remark: null, createdAt: new Date("2026-09-16T00:00:00.000Z") }],
    lineCounts: [{ stocktakeId: "st-1", _count: { _all: 12 } }],
    differingCounts: [{ stocktakeId: "st-1", _count: { _all: 3 } }],
  });

  const [row] = await service.list("2026-09");

  assert.equal(row.stocktake_no, "PD-1");
  assert.equal(row.status_label, "已确认");
  assert.equal(row.line_count, 12);
  assert.equal(row.differing_line_count, 3);
});

test("汇总：调增/调减按单位分开给，并数清「导入后有变动」「差异没有原因」的行", async () => {
  const lines = [
    { unit_id: "u-1", unit_name: "米", difference_snapshot: "5", book_quantity_at_confirm: null, book_quantity_snapshot: "95", applied_quantity: "5", difference_reason: null },
    { unit_id: "u-1", unit_name: "米", difference_snapshot: "-2", book_quantity_at_confirm: "80", book_quantity_snapshot: "100", applied_quantity: "-2", difference_reason: "受潮" },
    { unit_id: "u-2", unit_name: "条", difference_snapshot: "0", book_quantity_at_confirm: "80", book_quantity_snapshot: "80", applied_quantity: "0", difference_reason: null },
  ];
  const { service } = stocktakeService({
    stocktake: { id: "st-1", stocktakeNo: "PD-1", periodMonth: "2026-09", status: "confirmed", sourceFileName: null, importedAt: null, confirmedAt: null, reversedAt: null, reversalReason: null, remark: null, createdAt: new Date("2026-09-16T00:00:00.000Z"), lines: lines.map((line, index) => ({ id: `line-${index}`, lineNo: index + 1, materialId: `m-${index}`, unitId: line.unit_id, productCodeSnapshot: `MAT-${index}`, productNameSnapshot: "料", specificationSnapshot: null, warehouseZone: null, binLocation: null, actualQuantity: decimal(1), bookQuantitySnapshot: decimal(line.book_quantity_snapshot), differenceSnapshot: decimal(line.difference_snapshot), bookQuantityAtConfirm: line.book_quantity_at_confirm === null ? null : decimal(line.book_quantity_at_confirm), appliedQuantity: decimal(line.applied_quantity), differenceReason: line.difference_reason, material: { materialCode: `MAT-${index}`, name: "料", specificationModel: null }, unit: { name: line.unit_name } })) },
  });

  const detail = await service.get("st-1");

  assert.equal(detail.summary.line_count, 3);
  assert.equal(detail.summary.differing_line_count, 2);
  assert.equal(detail.summary.increased_line_count, 1);
  assert.equal(detail.summary.decreased_line_count, 1);
  assert.equal(detail.summary.applied_line_count, 2, "实际写了调整事实的行数（0 差额不写）");
  assert.equal(detail.summary.changed_after_import_count, 1, "确认时账面与导入时账面不同的行数（未确认的行没有确认时账面，不计）");
  assert.equal(detail.summary.differing_without_reason_count, 1);
  assert.deepEqual(detail.summary.units, [
    { unit_id: "u-1", unit_name: "米", increase_quantity: "5", decrease_quantity: "2" },
    { unit_id: "u-2", unit_name: "条", increase_quantity: "0", decrease_quantity: "0" },
  ]);
  // 数量一律以字符串出参（前端不做 Number 累加）
  assert.equal(detail.lines[0].actual_quantity, "1");
  assert.equal(detail.lines[1].book_quantity_at_confirm, "80");
  assert.equal(detail.lines[2].applied_quantity, "0");
});

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

test("导入 DTO：盘点月份必须是 YYYY-MM", async () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const validate = (body) => pipe.transform(body, { type: "body", metatype: StocktakeImportDto });

  assert.equal((await validate({ period_month: "2026-09" })).period_month, "2026-09");
  for (const period_month of ["2026-9", "2026-13", "2026-00", "202609", "", "2026-09-16"]) {
    await assert.rejects(() => validate({ period_month }), `盘点月份 ${period_month} 应被拒绝`);
  }
});

test("明细 DTO：实盘数允许 0、空串按未填写处理；负数 / 科学计数 / 非数字被拒", async () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const validate = (body) => pipe.transform(body, { type: "body", metatype: StocktakeLineDto });

  assert.equal((await validate({ actual_quantity: "0" })).actual_quantity, "0");
  assert.equal((await validate({ actual_quantity: "120.5" })).actual_quantity, "120.5");
  assert.equal((await validate({ actual_quantity: "" })).actual_quantity, undefined);
  assert.equal((await validate({ difference_reason: "受潮" })).actual_quantity, undefined);
  for (const actual_quantity of ["-1", "1e3", "abc", " 20 "]) {
    await assert.rejects(() => validate({ actual_quantity }), `实盘数 ${actual_quantity} 应在 DTO 层被拒绝`);
  }
});

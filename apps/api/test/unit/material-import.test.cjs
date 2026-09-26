// 「物料清单批量导入」的单元测试（手写假 Prisma，不连数据库）。
//
// 用户 2026-09-20：「针对采购模块，物料清单，我们新增一个批量导入物料。我们提供模板，用户填写并上传。
// 模板的 column 口径你来定」。column 口径与逐行规则见
// `apps/api/src/modules/procurement/material-import.ts` 的文件头注释。
//
// 本文件钉住四件事：
//   1. **表头按名字认列**：列顺序随便调、多余的列如实上报，不按列序号错位；
//   2. **行级错误不连坐**：只有「找不到表头 / 缺必需列 / 没有数据行」整批失败，其余行照常建档；
//   3. **两条唯一口径都查**（物料编码 / 名称+规格型号+颜色），而且必须把**已软删**的记录一起查 ——
//      数据库的唯一索引不看 deletedAt，漏查就会以 P2002 整批失败、还说不清是哪一行；
//   4. **自动编码**沿用平台规则（MAT-当天日期-序号），批内连续、不与库里已有编码撞号。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const XLSX = require("xlsx");
const {
  MATERIAL_TEMPLATE_HEADERS, MATERIAL_IMPORT_MAX_ROWS,
  materialCodeKey, materialComboKey, materialUnitKey, parseMaterialRows, materialTemplateWorkbook,
} = require("../../dist/modules/procurement/material-import.js");
const { ProcurementMasterDataService } = require("../../dist/modules/procurement/procurement-master-data.service.js");
const { dailyCodePrefix } = require("../../dist/platform/database/daily-sequence-code.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "procurement", display_name: "采购测试" };
const TODAY = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const MAT_PREFIX = dailyCodePrefix("MAT");

const HEADER = [...MATERIAL_TEMPLATE_HEADERS];

function workbookBuffer(rows, sheetName = "物料清单导入") {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

function sheetRows(buffer) {
  const book = XLSX.read(buffer, { type: "buffer", cellDates: false });
  const sheet = book.Sheets[book.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
}

const parse = (rows) => parseMaterialRows(sheetRows(workbookBuffer([HEADER, ...rows])));
const parseRaw = (rows) => parseMaterialRows(sheetRows(workbookBuffer(rows)));

// ------------------------------------------------------------------ 解析：表头

test("模板格式：7 列表头能被自己的模板认出来（模板与解析器不许分叉）", () => {
  const parsed = parseRaw([HEADER, ["", "涤纶布", "150D", "米白", "米", "原料", ""]]);
  assert.equal(parsed.headerRow, 1);
  assert.equal(parsed.dataStartRow, 2);
  assert.equal(parsed.missingColumns.length, 0);
  assert.equal(parsed.ignoredColumns.length, 0);
  assert.equal(parsed.rows.length, 1);
});

test("表头按名字认列：列顺序打乱、多一列无关列都不影响结果", () => {
  const parsed = parseRaw([
    ["默认单位", "无关列", "物料名称", "物料编码", "物料类型"],
    ["米", "忽略我", "涤纶布", "MAT-9", "原料"],
  ]);
  assert.equal(parsed.status, "ok");
  assert.deepEqual(parsed.ignoredColumns, ["无关列"]);
  assert.equal(parsed.rows[0].name, "涤纶布");
  assert.equal(parsed.rows[0].materialCode, "MAT-9");
  assert.equal(parsed.rows[0].unitName, "米");
});

test("表头同义词：产品代码 / 产品名称 / 单位 这些写法都认", () => {
  const parsed = parseRaw([
    ["产品代码", "产品名称", "规格", "颜色", "单位", "类型", "说明"],
    ["MAT-1", "涤纶布", "150D", "米白", "米", "成品", "备注内容"],
  ]);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.rows[0].materialCode, "MAT-1");
  assert.equal(parsed.rows[0].materialType, "finished_product");
  assert.equal(parsed.rows[0].remark, "备注内容");
});

test("缺必需列（默认单位）时整批失败，并说清缺哪一列", () => {
  const parsed = parseRaw([["物料名称", "规格型号"], ["涤纶布", "150D"]]);
  assert.equal(parsed.status, "failed");
  assert.deepEqual(parsed.missingColumns, ["默认单位"]);
  assert.match(parsed.errors[0].reason, /缺少必需列：默认单位/);
  assert.equal(parsed.rows.length, 0);
});

test("误传别的表（表头完全对不上）只回一条整体错误，不把它当成一堆行级错误", () => {
  const parsed = parseRaw([["订单号", "数量", "金额"], ["SO-1", "10", "100"]]);
  assert.equal(parsed.status, "failed");
  assert.equal(parsed.errors.length, 1, "整批只回一条原因，而不是逐行报错");
  // 一列都没认出来时走的是「缺少必需列」分支（与盘点导入同一实现），提示同样指向「下载模板」。
  assert.match(parsed.errors[0].reason, /缺少必需列：物料名称、默认单位|找不到表头行/);
  assert.match(parsed.errors[0].reason, /下载模板/);
  assert.equal(parsed.rows.length, 0);
});

test("表头不在第一行（文档形态）：前 10 行里找表头，数据块到第一个空行为止", () => {
  const parsed = parseRaw([
    ["物料清单导入表", "", "", "", "", "", ""],
    HEADER,
    ["", "涤纶布", "150D", "", "米", "", ""],
    ["", "松紧带", "5mm", "", "米", "", ""],
    ["", "", "", "", "", "", ""],
    ["说明：以上为示例", "", "", "", "", "", ""],
  ]);
  assert.equal(parsed.documentLayout, true);
  assert.equal(parsed.headerRow, 2);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.ignoredTrailingRows, 2, "数据块之后的说明文字不算数据行");
});

test("没有数据行时整批失败并给出明确原因", () => {
  const parsed = parseRaw([HEADER]);
  assert.equal(parsed.status, "failed");
  assert.match(parsed.errors[0].reason, /表头下面没有数据行/);
});

// ------------------------------------------------------- 解析：逐行校验与文件内重复

test("文件内物料编码重复：报后一行的错并指出前一行行号", () => {
  const parsed = parse([
    ["MAT-1", "涤纶布", "150D", "", "米", "", ""],
    ["mat-1", "松紧带", "5mm", "", "米", "", ""],
  ]);
  assert.equal(parsed.status, "partial");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].row, 3);
  assert.match(parsed.errors[0].reason, /已出现在第 2 行/);
});

test("文件内「名称+规格型号+颜色」完全相同时报错，改了规格或颜色就能并存", () => {
  const parsed = parse([
    ["", "涤纶布", "150D", "米白", "米", "", ""],
    ["", "涤纶布", "150D", "米白", "米", "", ""],
    ["", "涤纶布", "300D", "米白", "米", "", ""],
    ["", "涤纶布", "150D", "黑色", "米", "", ""],
  ]);
  assert.equal(parsed.rows.length, 3, "只有完全同款的那一行被拒");
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].row, 3);
  assert.match(parsed.errors[0].reason, /同名同规格同颜色只能有一条/);
});

test("物料类型：留空默认原料、『成品』归一、写别的字直接报错（不猜）", () => {
  const parsed = parse([
    ["", "甲", "", "", "米", "", ""],
    ["", "乙", "", "", "米", "成品", ""],
    ["", "丙", "", "", "米", "finished_product", ""],
    ["", "丁", "", "", "米", "半成品", ""],
  ]);
  assert.equal(parsed.rows[0].materialType, "raw_material");
  assert.equal(parsed.rows[1].materialType, "finished_product");
  assert.equal(parsed.rows[2].materialType, "finished_product");
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0].reason, /物料类型「半成品」无法识别/);
});

test("必填与长度：物料名称/默认单位必填，各列超出库宽逐条报错", () => {
  const parsed = parse([
    ["", "", "", "", "", "", ""],                       // 整行空 → 跳过，不算数据行也不算错
    ["", "", "150D", "", "米", "", ""],                  // 缺名称
    ["", "涤纶布", "", "", "", "", ""],                  // 缺单位
    ["X".repeat(81), "涤纶布", "", "", "米", "", ""],     // 编码过长
    ["", "Y".repeat(201), "", "", "米", "", ""],         // 名称过长
    ["", "短", "", "", "Z".repeat(31), "", ""],          // 单位过长
  ]);
  assert.equal(parsed.total, 5, "整行空的不计入数据行");
  assert.equal(parsed.rows.length, 0);
  const reasons = parsed.errors.map((error) => error.reason).join("\n");
  assert.match(reasons, /请填写物料名称/);
  assert.match(reasons, /请填写默认单位/);
  assert.match(reasons, /物料编码过长/);
  assert.match(reasons, /物料名称过长/);
  assert.match(reasons, /单位名称过长/);
});

test("提示：没填编码的行会被自动生成，含成品时会提醒成品不在物料清单页", () => {
  const parsed = parse([
    ["", "甲", "", "", "米", "", ""],
    ["MAT-1", "乙", "", "", "米", "成品", ""],
  ]);
  assert.match(parsed.hints.join("\n"), /有 1 行没有填物料编码/);
  assert.match(parsed.hints.join("\n"), /本批含「成品」/);
});

test("归一键与库层口径一致：编码/单位忽略大小写与空格，组合**区分**大小写", () => {
  assert.equal(materialCodeKey(" MAT-1 "), "mat-1");
  assert.equal(materialUnitKey(" 米 "), "米");
  // 组合键跟着数据库的唯一索引走：库层区分大小写，所以这里也区分（否则会拒掉库层允许的记录）。
  assert.notEqual(materialComboKey("ABC", "", ""), materialComboKey("abc", "", ""));
  assert.equal(materialComboKey(" 涤纶布 ", " 150D ", " 米白 "), "涤纶布|150D|米白");
});

// ------------------------------------------------------------------ 模板工作簿

test("模板工作簿：数据页表头 = 口径，含两行示例，且有独立的填写说明页", () => {
  const book = XLSX.read(materialTemplateWorkbook(), { type: "buffer" });
  assert.deepEqual(book.SheetNames, ["物料清单导入", "填写说明"]);

  const rows = XLSX.utils.sheet_to_json(book.Sheets["物料清单导入"], { header: 1, raw: true, defval: "" });
  assert.deepEqual(rows[0], HEADER);
  assert.equal(rows.length, 3, "表头 + 2 行示例");
  // 第二行示例的编码必须留空，用来示范「留空 = 自动生成」。
  assert.equal(rows[2][0], "", "示例行要示范自动编码");

  const notes = XLSX.utils.sheet_to_json(book.Sheets["填写说明"], { header: 1, raw: true, defval: "" });
  assert.equal(notes[0][0], "填写说明");
  assert.ok(notes.length >= 10);
  assert.match(notes.flat().join("\n"), new RegExp(`单次最多 ${MATERIAL_IMPORT_MAX_ROWS} 行`));
});

test("模板自洽：把模板里的示例行原样放进解析器，除占位符编码外都能通过", () => {
  const book = XLSX.read(materialTemplateWorkbook(), { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(book.Sheets["物料清单导入"], { header: 1, raw: true, defval: "" });
  const parsed = parseMaterialRows(rows);
  assert.equal(parsed.status, "ok", `模板示例行必须自己能通过：${JSON.stringify(parsed.errors)}`);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[1].materialCode, "", "第二行示例的编码留空 → 走自动生成");
});

// ------------------------------------------------------------------ 服务层（假 Prisma）

const UNITS = [
  { id: "u-1", name: "米", isActive: true },
  { id: "u-2", name: "打", isActive: true },
  { id: "u-3", name: "码", isActive: false },
];

function materialService(overrides = {}) {
  const created = { rows: [], audits: [] };
  const prisma = {
    unit: { findMany: async () => overrides.units ?? UNITS },
    material: {
      findMany: async () => overrides.materials ?? [],
      count: async () => 0,
      findFirst: async () => null,
      create: async ({ data }) => ({ id: "m-new", ...data }),
    },
    $transaction: async (fn) => fn({
      material: {
        createMany: async ({ data }) => { created.rows.push(...data); return { count: data.length }; },
        create: async ({ data }) => { created.rows.push(data); return { id: "m-new", ...data }; },
      },
    }),
  };
  const audit = {
    create: () => ({ createdBy: user.id, updatedBy: user.id }),
    update: () => ({ updatedBy: user.id }),
    softDelete: () => ({ deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id }),
    record: async (...args) => { created.audits.push(args); },
  };
  return { service: new ProcurementMasterDataService(prisma, audit), created };
}

function importFile(rows, originalname = "物料清单.xlsx") {
  return { buffer: workbookBuffer([HEADER, ...rows]), originalname };
}

test("导入成功：手工编码原样落库、自动编码按 MAT-当天日期-序号生成，规格/颜色去空格且空值落空串", async () => {
  const { service, created } = materialService();
  const result = await service.importMaterials(importFile([
    ["MAT-1001", " 涤纶布 ", " 150D ", " 米白 ", "米", "原料", "备注"],
    ["", "松紧带", "5mm", "", "米", "", ""],
    ["", "伞骨", "", "", "打", "成品", ""],
  ]), user);

  assert.equal(result.status, "ok");
  assert.equal(result.imported, 3);
  assert.equal(result.errorCount, 0);
  assert.equal(created.rows.length, 3);

  assert.equal(created.rows[0].materialCode, "MAT-1001");
  assert.equal(created.rows[0].name, "涤纶布", "名称去空格");
  assert.equal(created.rows[0].specificationModel, "150D");
  assert.equal(created.rows[0].color, "米白");
  assert.equal(created.rows[0].defaultUnitId, "u-1");
  assert.equal(created.rows[0].materialType, "raw_material");
  assert.equal(created.rows[0].remark, "备注");
  assert.equal(created.rows[0].createdBy, user.id);

  assert.equal(created.rows[1].materialCode, `${MAT_PREFIX}0001`, "自动编码 = MAT-当天日期-0001");
  assert.equal(created.rows[1].name, "松紧带");
  assert.equal(created.rows[1].color, "", "空颜色落成空串（NULL 会让组合唯一索引失效）");
  assert.equal(created.rows[1].remark, null, "空备注落 NULL");
  assert.equal(created.rows[2].materialCode, `${MAT_PREFIX}0002`, "批内序号连续");
  assert.equal(created.rows[2].specificationModel, "", "空规格落成空串");
  assert.equal(created.rows[2].materialType, "finished_product");

  // 新增清单要回显编码，否则操作员不知道后续该引用哪个码
  assert.deepEqual(result.created.map((item) => item.auto_code), [false, true, true]);
  assert.equal(result.created[1].material_code, `${MAT_PREFIX}0001`);
  assert.equal(result.created[2].material_code, `${MAT_PREFIX}0002`);

  const audit = created.audits.find(([action]) => action === "material.import");
  assert.ok(audit, "批量导入要留审计");
  assert.equal(audit[4].imported, 3);
  assert.equal(audit[4].auto_code_count, 2);
  // `audit.record(action, entityType, actorId, entityId, details)` 的第 4 个参数落进
  // `audit_events.entity_id` —— **一个 UUID 列**。这里原本传的是物料编码（或字面量 "batch"），
  // 于是 Prisma 建行时报 `Error creating UUID ... found 'M' at 1`，**整个导入请求 500**
  // （实测 2026-09-22 生产两次：数据在一个事务里写好了，用户看到的却是失败）。
  // 物料编码不是实体 id，它属于 details。
  assert.equal(audit[3], undefined, "审计 entityId 必须是 undefined 或 UUID：传物料编码会让整个导入 500");
  assert.equal(audit[4].material_code, "MAT-1001", "物料编码改记到 details 里（别丢掉这条信息）");
});

test("自动编码接在库里已有编码之后，并跳过被占用的号（含已软删的记录）", async () => {
  const { service, created } = materialService({
    materials: [
      { materialCode: `${MAT_PREFIX}0007`, name: "已有", specificationModel: "", color: "", deletedAt: null },
      // 已软删的 0008：唯一索引不看删除标记，所以这一号也不能用
      { materialCode: `${MAT_PREFIX}0008`, name: "删过的", specificationModel: "", color: "", deletedAt: new Date("2026-01-01") },
    ],
  });
  await service.importMaterials(importFile([["", "新的", "", "", "米", "", ""]]), user);
  assert.equal(created.rows[0].materialCode, `${MAT_PREFIX}0009`, "接在 0007 之后、跳过被软删的 0008");
});

test("默认单位找不到：逐行报错，并列出单位表里现有的单位；不自动新建单位", async () => {
  const { service, created } = materialService();
  const result = await service.importMaterials(importFile([
    ["", "涤纶布", "", "", "包", "", ""],
    ["", "松紧带", "", "", "米", "", ""],
  ]), user);

  assert.equal(result.status, "partial");
  assert.equal(result.imported, 1);
  assert.equal(result.errorCount, 1);
  assert.equal(result.errors[0].field, "默认单位");
  assert.match(result.errors[0].reason, /默认单位「包」在单位表里找不到/);
  assert.match(result.hints.join("\n"), /单位表里现有的单位：米、打、码（已停用）/);
  assert.equal(created.rows.length, 1, "只有能建档的那一行被写入");
});

test("单位已停用：逐行报错，提示启用或换一个（与单条新建的 requireActiveUnit 同一口径）", async () => {
  const { service } = materialService();
  const result = await service.importMaterials(importFile([["", "涤纶布", "", "", "码", "", ""]]), user);
  assert.equal(result.status, "failed");
  assert.match(result.errors[0].reason, /已停用/);
});

test("编码已存在：逐行报错并指明是哪条物料；已软删的编码另给一句解释", async () => {
  const { service, created } = materialService({
    materials: [
      { materialCode: "MAT-1001", name: "在用的涤纶布", specificationModel: "150D", color: "", deletedAt: null },
      { materialCode: "MAT-2002", name: "删过的松紧带", specificationModel: "", color: "", deletedAt: new Date("2026-01-01") },
    ],
  });
  const result = await service.importMaterials(importFile([
    ["mat-1001", "另一个名字", "", "", "米", "", ""],
    ["MAT-2002", "又一个名字", "", "", "米", "", ""],
    ["MAT-3003", "能进来的", "", "", "米", "", ""],
  ]), user);

  assert.equal(result.status, "partial");
  assert.equal(result.imported, 1);
  assert.equal(result.errorCount, 2);
  assert.match(result.errors[0].reason, /已存在（物料「在用的涤纶布」）/);
  assert.match(result.errors[1].reason, /已删除的物料「删过的松紧带」/);
  assert.equal(created.rows[0].materialCode, "MAT-3003");
});

test("「名称+规格型号+颜色」已存在：逐行报错并给出占用者的编码", async () => {
  const { service, created } = materialService({
    materials: [{ materialCode: "MAT-1001", name: "涤纶布", specificationModel: "150D", color: "米白", deletedAt: null }],
  });
  const result = await service.importMaterials(importFile([
    ["", "涤纶布", "150D", "米白", "米", "", ""],
    ["", "涤纶布", "300D", "米白", "米", "", ""],
  ]), user);

  assert.equal(result.status, "partial");
  assert.equal(result.imported, 1);
  assert.match(result.errors[0].reason, /已存在（物料编码 MAT-1001）/);
  assert.equal(created.rows[0].specificationModel, "300D", "改了规格型号就能并存");
});

test("全部行都失败时整批 failed，一条都不写库", async () => {
  const { service, created } = materialService();
  const result = await service.importMaterials(importFile([["", "涤纶布", "", "", "包", "", ""]]), user);
  assert.equal(result.status, "failed");
  assert.equal(result.imported, 0);
  assert.equal(created.rows.length, 0);
  assert.match(result.hints.join("\n"), /都没能建档/);
});

test("文件缺失 / 扩展名不对：给明确的 422，而不是「找不到表头」", async () => {
  const { service } = materialService();
  await assert.rejects(() => service.importMaterials(undefined, user), (error) => error.getResponse().code === "MATERIAL_IMPORT_FILE_REQUIRED");
  await assert.rejects(
    () => service.importMaterials({ buffer: Buffer.from("x"), originalname: "物料.csv" }, user),
    (error) => error.getResponse().code === "MATERIAL_IMPORT_INVALID_FILE",
  );
});

test("内容根本不是表格时不抛 500：回一条「按模板填写」的整批失败（SheetJS 很少抛异常，靠表头判据兜底）", async () => {
  const { service, created } = materialService();
  const result = await service.importMaterials({ buffer: Buffer.from("not an excel file"), originalname: "物料.xlsx" }, user);
  assert.equal(result.status, "failed");
  assert.equal(result.imported, 0);
  assert.equal(created.rows.length, 0);
  assert.match(result.errors[0].reason, /下载模板/);
});

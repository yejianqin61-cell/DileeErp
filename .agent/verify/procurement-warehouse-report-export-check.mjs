/**
 * 采购与仓储报表（2026-11-04）—— 导出件独立核验（B 部分）。
 *
 * 约束：不改源码；只 require 已经构建好的 `apps/api/dist/modules/reports/*`，用手写假 Prisma
 * 喂「用户截图里那张真实的表」11 行对应的采购 / 入库 / 领用 / 库存事实，调 `exportWorkbook()`
 * 拿到**真实 xlsx 字节**，再用 exceljs 打开核验工作表名、表头、数值单元格、A4 横向版式与口径说明。
 *
 * 运行：node .agent\verify\procurement-warehouse-report-export-check.mjs
 * 产物：
 *   docs/test/results/procurement-warehouse-report/采购与仓储报表-样例.xlsx
 *   docs/test/results/procurement-warehouse-report/采购与仓储报表-样例.png（若 LibreOffice 可用）
 *   .agent/verify/procurement-warehouse-report-export-results.json
 */
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DIST = path.join(REPO_ROOT, "apps", "api", "dist", "modules", "reports");
const OUT_DIR = path.join(REPO_ROOT, "docs", "test", "results", "procurement-warehouse-report");
const RESULTS_JSON = path.join(REPO_ROOT, ".agent", "verify", "procurement-warehouse-report-export-results.json");
const SAMPLE_XLSX = path.join(OUT_DIR, "采购与仓储报表-样例.xlsx");

const ExcelJS = require("exceljs");
const { Prisma } = require("@prisma/client");
const {
  ProcurementWarehouseReportService
} = require(path.join(DIST, "procurement-warehouse-report.service.js"));
const {
  ProcurementWarehouseReportExportService
} = require(path.join(DIST, "procurement-warehouse-report-export.service.js"));

const dec = (value) => new Prisma.Decimal(value);

// ---------------------------------------------------------------------------
// 用户截图里那张真实的表（11 行、订单号全为 260119）。
// 字段：物料名称 / 颜色 / 单位 / 采购数量 / 采购入库量 / 生产领用数量 / 库存量
// （采购未入库数是计算列 = 采购数量 − 采购入库量，由代码算，不在种子里给。）
// ---------------------------------------------------------------------------
const REAL_ROWS = [
  ["58cm*8k自动直骨伞", "黑色", "打", "4700", "4700", "3050", "1650"],
  ["75D 190T灰色XPG-23535黑胶自然光黑胶碰击布B色号", "灰色", "码", "9800", "9730", "9660", "70"],
  ["75D 190T天蓝色XPG-23637自然光黑胶碰击布A色号", "天蓝色", "码", "8495", "8495", "9040", "-545"],
  ["75D 190T粉色自然光黑胶碰击布", "粉色", "码", "6200", "5778", "4800", "978"],
  ["75D 190T卡其色C色号素色黑胶自然光", "卡其色", "码", "8130", "8130", "7850", "280"],
  ["75D 190T白色素色黑胶自然光", "白色", "码", "19405", "19405", "17025", "2380"],
  ["ABS料伞头（TF1076）", "同客户提供的颜色", "打", "4700", "2178", "2046", "132"],
  ["配8MM金色伞签", "金色", "打", "4700", "4700", "2700", "2000"],
  ["配3.0金色伞珠", "金色", "打", "4700", "4700", "4700", "0"],
  ["1.2金色带LOGO全铜平面扣", "金色", "打", "4700", "4700", "4700", "0"],
  ["内标（1*6CM）", "白色", "打", "4700", "0", "0", "0"]
];

const UNIT_BY_NAME = new Map([["打", "u-da"], ["码", "u-ma"]]);

/** 11 行 → 假 Prisma 的聚合结果（采购 / 入库 / 领用 / 库存四类事实）。 */
function seedFromRealRows() {
  const purchaseItemGroups = [];
  const inboundGroups = [];
  const issueGroups = [];
  const stockGroups = [];
  const materials = [];
  const units = [...UNIT_BY_NAME].map(([name, id]) => ({ id, name, deletedAt: null }));
  REAL_ROWS.forEach(([name, color, unitName, purchase, inbound, issue, stock], index) => {
    const materialId = `m-${index + 1}`;
    const unitId = UNIT_BY_NAME.get(unitName);
    materials.push({ id: materialId, name, color, materialType: "raw_material", deletedAt: null });
    if (dec(purchase).gt(0)) purchaseItemGroups.push({ purchaseOrderId: "po-1", materialId, unitId, _sum: { quantity: dec(purchase) } });
    if (dec(inbound).gt(0)) inboundGroups.push({ orderNo: "260119", materialId, unitId, _sum: { quantity: dec(inbound) } });
    // 生产领用：事实里的 quantity_delta 是负数（领料减少库存），报表取负后输出正数。
    if (dec(issue).gt(0)) issueGroups.push({ orderNo: "260119", materialId, unitId, _sum: { quantityDelta: dec(`-${issue}`) } });
    if (dec(stock).abs().gt(0)) stockGroups.push({ materialId, unitId, _sum: { quantityDelta: dec(stock) } });
  });
  return {
    purchaseItemGroups,
    inboundGroups,
    issueGroups,
    stockGroups,
    orders: [{ id: "po-1", orderNo: "260119" }],
    materials,
    units
  };
}

/**
 * 手写假 Prisma（照 apps/api/test/unit/procurement-warehouse-report.test.cjs 的桩写法）：
 * 只实现读方法；任何写操作直接抛错，证明报表导出不写库。
 */
function fakePrisma(seed) {
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
  data.filterMaterials = seed.filterMaterials ?? data.materials;
  const readModel = (name, read) => {
    const model = {};
    for (const op of ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]) {
      model[op] = async () => { writes.push(`${name}.${op}`); throw new Error(`报表不应写库：${name}.${op}`); };
    }
    return Object.assign(model, read);
  };
  const groupBy = (name, resolve) => async (args) => { calls.push({ model: name, op: "groupBy", args }); return resolve(args); };
  const findMany = (name, resolve) => async (args) => { calls.push({ model: name, op: "findMany", args }); return resolve(args); };
  const prisma = { calls, writes, data };
  prisma.purchaseOrderItem = readModel("purchaseOrderItem", { groupBy: groupBy("purchaseOrderItem", () => data.purchaseItemGroups) });
  prisma.rawMaterialInbound = readModel("rawMaterialInbound", { groupBy: groupBy("rawMaterialInbound", () => data.inboundGroups) });
  prisma.inventoryFact = readModel("inventoryFact", {
    groupBy: groupBy("inventoryFact", (args) => (args.by.includes("orderNo") ? data.issueGroups : data.stockGroups))
  });
  prisma.purchaseOrder = readModel("purchaseOrder", { findMany: findMany("purchaseOrder", () => data.orders) });
  prisma.material = readModel("material", { findMany: findMany("material", (args) => (args.where?.OR ? data.filterMaterials : data.materials)) });
  prisma.unit = readModel("unit", { findMany: findMany("unit", () => data.units) });
  return prisma;
}

// ---------------------------------------------------------------------------
// 断言收集
// ---------------------------------------------------------------------------
const checks = [];
function assert(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail: detail ?? null });
  if (!condition) throw new Error(`断言失败：${name}（${JSON.stringify(detail)}）`);
  return true;
}

const SHEET_NAME = "采购与仓储报表";
const HEADERS = ["订单号", "物料名称", "颜色", "单位", "采购数量", "采购入库量", "采购未入库数", "生产领用数量", "库存量"];
const HEADER_ROW = 3;
const FIRST_DATA_ROW = 4;

/** 从 exceljs 工作表读出一行九列（数量列必须是 number 才合格）。 */
function readSheetRow(sheet, rowNumber) {
  const values = [];
  for (let column = 1; column <= 9; column += 1) values.push(sheet.getRow(rowNumber).getCell(column).value);
  return values;
}

function expectedRowOf([name, color, unitName, purchase, inbound, issue, stock]) {
  return ["260119", name, color, unitName, Number(purchase), Number(inbound), Number(purchase) - Number(inbound), Number(issue), Number(stock)];
}

/** LibreOffice 第一次启动要建用户配置目录；不带独立 profile 时 `soffice --version` 会挂住（实测）。 */
const LO_PROFILE_URL = "file:///C:/Users/USER/AppData/Local/Temp/lo_verify_profile";
const LO_ARGS = ["--headless", "--norestore", `-env:UserInstallation=${LO_PROFILE_URL}`];

async function findSoffice() {
  const candidates = [
    process.env.SOFFICE,
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    "soffice",
    "/usr/bin/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice"
  ].filter(Boolean);
  for (const candidate of candidates) {
    const isPath = candidate.includes("\\") || candidate.includes("/");
    if (isPath && !fs.existsSync(candidate)) continue;
    try {
      const result = await execFileAsync(candidate, [...LO_ARGS, "--version"], { timeout: 90000 });
      return { command: candidate, version: String(result.stdout ?? "").trim() };
    } catch {
      // 继续找下一个
    }
  }
  return null;
}

async function renderSample(soffice) {
  if (!soffice) return { rendered: false, reason: "未找到可用的 soffice（LibreOffice）——未渲染" };
  const note = { rendered: false, soffice: soffice.command, version: soffice.version, attempts: [], outputs: [] };
  // 先转 PDF（保留版式证据），再转 PNG（「导出件长什么样」的一眼证据）。
  for (const target of ["pdf", "png"]) {
    try {
      const result = await execFileAsync(soffice.command, [
        ...LO_ARGS,
        "--convert-to", target,
        "--outdir", OUT_DIR,
        SAMPLE_XLSX
      ], { timeout: 180000 });
      note.attempts.push({ target, stdout: String(result.stdout ?? "").trim(), stderr: String(result.stderr ?? "").trim() });
    } catch (error) {
      note.attempts.push({ target, error: String(error?.message ?? error) });
    }
  }
  const expected = [path.join(OUT_DIR, "采购与仓储报表-样例.pdf"), path.join(OUT_DIR, "采购与仓储报表-样例.png")];
  note.outputs = expected.filter((file) => fs.existsSync(file));
  note.rendered = note.outputs.length > 0;
  if (!note.rendered) note.reason = "soffice 可用但转换没有产出文件——未渲染";
  return note;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(RESULTS_JSON), { recursive: true });

  const prisma = fakePrisma(seedFromRealRows());
  const reportService = new ProcurementWarehouseReportService(prisma);
  const exportService = new ProcurementWarehouseReportExportService(reportService);
  const generatedAt = new Date();

  // 1. 真实导出：走 dist 里的正式实现（同一份取数 + ExcelJS 版式）。
  const exported = await exportService.exportWorkbook({ order_no: "260119" });
  fs.writeFileSync(SAMPLE_XLSX, exported.buffer);
  assert("生成 xlsx 字节（ZIP 容器 PK\\x03\\x04）", exported.buffer.length > 0 && exported.buffer[0] === 0x50 && exported.buffer[1] === 0x4b, { bytes: exported.buffer.length });
  assert("导出文件名是「迪礼ERP-采购与仓储报表-<北京时间戳>.xlsx」", /^迪礼ERP-采购与仓储报表-\d{14}\.xlsx$/.test(exported.fileName), exported.fileName);
  assert("导出报告 rowCount = 11", exported.rowCount === 11, exported.rowCount);
  assert("导出过程没有写库", prisma.writes.length === 0, prisma.writes);

  // 2. 打开这份真实 xlsx 核验内容/版式。
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(exported.buffer);
  assert("只有一个工作表且名字是「采购与仓储报表」", workbook.worksheets.length === 1 && workbook.worksheets[0].name === SHEET_NAME, workbook.worksheets.map((sheet) => sheet.name));
  const sheet = workbook.worksheets[0];

  const headerCells = [];
  for (let column = 1; column <= 9; column += 1) headerCells.push(sheet.getRow(HEADER_ROW).getCell(column).value);
  assert("第 3 行九列表头同名同序", JSON.stringify(headerCells) === JSON.stringify(HEADERS), headerCells);

  const titleText = String(sheet.getCell("A1").value ?? "");
  assert("标题行含「采购与仓储报表」", titleText.includes("采购与仓储报表"), titleText);
  const infoText = String(sheet.getCell("A2").value ?? "");
  assert("信息行含筛选条件 / 生成时间 / 行数", infoText.includes("订单号包含「260119」") && infoText.includes("生成时间：") && infoText.includes("共 11 行"), infoText);

  const rowHeight = sheet.rowCount;
  const dataRows = [];
  for (let rowNumber = FIRST_DATA_ROW; rowNumber < FIRST_DATA_ROW + 11; rowNumber += 1) dataRows.push(readSheetRow(sheet, rowNumber));
  assert("数据行 = 11 行", dataRows.length === 11 && exported.rowCount === 11, { dataRows: dataRows.length });

  // 数量列（E~I）必须是 number 类型，不是文本。
  const numericTypes = [];
  for (let index = 0; index < dataRows.length; index += 1) {
    for (let columnIndex = 4; columnIndex <= 8; columnIndex += 1) {
      const value = dataRows[index][columnIndex];
      numericTypes.push({ row: index + 1, column: "EFGHI"[columnIndex - 4], value, type: typeof value, numFmt: sheet.getRow(FIRST_DATA_ROW + index).getCell(columnIndex + 1).numFmt });
    }
  }
  assert("数量列 55 个单元格全部是 number（不是文本）", numericTypes.every((cell) => cell.type === "number"), numericTypes.filter((cell) => cell.type !== "number"));
  assert("数量列数字格式是 0.####", numericTypes.every((cell) => cell.numFmt === "0.####"), [...new Set(numericTypes.map((cell) => cell.numFmt))]);

  // 逐行核对 11 行内容（后端按「订单号倒序→物料名→单位」排序，所以按物料名建索引比对）。
  const byName = new Map(dataRows.map((row) => [row[1], row]));
  assert("11 行物料名与截图完全一致（集合相等）", REAL_ROWS.every(([name]) => byName.has(name)) && byName.size === REAL_ROWS.length, [...byName.keys()]);
  const mismatches = [];
  for (const realRow of REAL_ROWS) {
    const actual = byName.get(realRow[0]);
    const expected = expectedRowOf(realRow);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push({ material: realRow[0], expected, actual });
  }
  assert("11 行逐列数值全部与截图一致（含负数库存 -545 与超收/未入库）", mismatches.length === 0, mismatches);
  const negativeStock = dataRows.find((row) => row[1] === "75D 190T天蓝色XPG-23637自然光黑胶碰击布A色号");
  assert("第 3 行库存量写入 -545（数值单元格，不是文本/0）", negativeStock && negativeStock[8] === -545 && typeof negativeStock[8] === "number", negativeStock);
  const row11 = dataRows.find((row) => row[1] === "内标（1*6CM）");
  assert("第 11 行：采购 4700 / 入库 0 / 未入库 4700 / 领用 0 / 库存 0", row11 && row11[4] === 4700 && row11[5] === 0 && row11[6] === 4700 && row11[7] === 0 && row11[8] === 0, row11);

  // 版式：A4 横向 + fitToPage。
  const pageSetup = {
    paperSize: sheet.pageSetup.paperSize,
    orientation: sheet.pageSetup.orientation,
    fitToPage: sheet.pageSetup.fitToPage,
    fitToWidth: sheet.pageSetup.fitToWidth,
    fitToHeight: sheet.pageSetup.fitToHeight,
    horizontalCentered: sheet.pageSetup.horizontalCentered,
    margins: sheet.pageSetup.margins
  };
  assert("pageSetup.orientation = landscape（A4 横向）", pageSetup.orientation === "landscape", pageSetup);
  assert("pageSetup.paperSize = 9（A4）", pageSetup.paperSize === 9, pageSetup);
  assert("pageSetup.fitToPage = true 且 fitToWidth = 1", pageSetup.fitToPage === true && pageSetup.fitToWidth === 1, pageSetup);

  // 表尾口径说明（数据行之后紧跟一行整行合并的说明）。
  const noteRowNumber = FIRST_DATA_ROW + 11;
  const noteCell = sheet.getRow(noteRowNumber).getCell(1);
  const noteText = String(noteCell.value ?? "");
  const noteMerges = sheet.model.merges ?? [];
  assert("表尾口径说明在数据行之后（第 " + noteRowNumber + " 行）", noteText.startsWith("口径说明："), { noteRowNumber, noteText: noteText.slice(0, 80) });
  for (const required of ["不跨单位相加", "不按订单拆账", "不设合计行"]) {
    assert(`口径说明含「${required}」`, noteText.includes(required), noteText.slice(0, 120));
  }
  assert("口径说明整行合并 A..I", noteMerges.includes(`A${noteRowNumber}:I${noteRowNumber}`), noteMerges.filter((merge) => String(merge).endsWith(String(noteRowNumber))));

  // 3. 屏幕 JSON（report()）与导出件必须是同一份取数：逐字段比对。
  const screen = await reportService.report({ order_no: "260119" });
  assert("屏幕 JSON data 与导出件行数一致（11 行）", screen.data.length === 11 && dataRows.length === 11, { screen: screen.data.length, export: dataRows.length });
  const screenMismatch = screen.data.filter((row) => {
    const exportedRow = byName.get(row.material_name);
    return !exportedRow
      || exportedRow[0] !== row.order_no
      || exportedRow[2] !== row.color
      || exportedRow[3] !== row.unit
      || exportedRow[4] !== Number(row.purchase_quantity)
      || exportedRow[5] !== Number(row.inbound_quantity)
      || exportedRow[6] !== Number(row.pending_inbound_quantity)
      || exportedRow[7] !== Number(row.production_issue_quantity)
      || exportedRow[8] !== Number(row.stock_quantity);
  });
  assert("屏幕 JSON 每一行与 xlsx 同一行逐列相同（屏幕=导出）", screenMismatch.length === 0, screenMismatch);
  assert("屏幕 JSON 数量字符串无尾零（无 /\\d\\.\\d*0$/ 形态）", screen.data.every((row) => [row.purchase_quantity, row.inbound_quantity, row.pending_inbound_quantity, row.production_issue_quantity, row.stock_quantity].every((value) => !/\.\d*0$/.test(value) && value !== "-0")), screen.data.map((row) => row.stock_quantity));
  assert("屏幕 JSON 生成时间与导出同一次取数（秒级一致）", Math.abs(new Date(screen.meta.generated_at).getTime() - generatedAt.getTime()) < 60000, screen.meta);

  // 4. LibreOffice 渲染（有就用，没有就在报告里写「未渲染」）。
  const soffice = await findSoffice();
  const render = await renderSample(soffice);

  const result = {
    generatedAt: new Date().toISOString(),
    script: path.relative(REPO_ROOT, import.meta.filename),
    distModules: [
      path.join("apps/api/dist/modules/reports", "procurement-warehouse-report.service.js"),
      path.join("apps/api/dist/modules/reports", "procurement-warehouse-report-export.service.js")
    ],
    sample: { xlsx: SAMPLE_XLSX, bytes: exported.buffer.length, fileName: exported.fileName },
    render,
    checks,
    details: {
      sheetName: sheet.name,
      headers: headerCells,
      dataRows,
      expectedRows: REAL_ROWS.map(expectedRowOf),
      numericTypes: numericTypes.slice(0, 9),
      pageSetup,
      title: titleText,
      info: infoText,
      note: noteText,
      noteRowNumber,
      screenRows: screen.data,
      screenMeta: screen.meta
    }
  };
  fs.writeFileSync(RESULTS_JSON, JSON.stringify(result, null, 2), "utf8");

  for (const check of checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail === null ? "" : `  ${JSON.stringify(check.detail)}`}`);
  console.log(`\n通过 ${checks.filter((check) => check.ok).length}/${checks.length} 条断言`);
  console.log(`样例 xlsx：${SAMPLE_XLSX}（${exported.buffer.length} bytes）`);
  console.log(`渲染：${render.rendered ? render.outputs.join(", ") : `未渲染（${render.reason ?? "unknown"}）`}`);
  console.log(`结果 JSON：${RESULTS_JSON}`);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

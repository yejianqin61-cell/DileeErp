/**
 * 采购与仓储报表（2026-11-04）—— 后端口径独立复核 + 单测加固性探针（C 部分）。
 *
 * 约束：不改源码、不改 dist。本脚本只 require 已构建的 `apps/api/dist/modules/reports/*`，
 * 用一个**按 where 语义真的过滤**的手写内存假库（不是「记录调用形状、无视 where」的形状桩）
 * 重放设计文档 §1/§2 的业务场景，检查报表行为（不只是查询长什么样）。
 *
 * 运行：node .agent\verify\procurement-warehouse-report-caliber-probes.mjs
 * 产物：.agent/verify/procurement-warehouse-report-caliber-probes.json
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DIST = path.join(REPO_ROOT, "apps", "api", "dist", "modules", "reports");
const RESULTS_JSON = path.join(REPO_ROOT, ".agent", "verify", "procurement-warehouse-report-caliber-probes.json");

require("reflect-metadata");
const { Prisma } = require("@prisma/client");
const { RequestMethod } = require("@nestjs/common");
const { PATH_METADATA, METHOD_METADATA } = require("@nestjs/common/constants");
const domain = require(path.join(DIST, "procurement-warehouse-report.domain.js"));
const { ProcurementWarehouseReportService } = require(path.join(DIST, "procurement-warehouse-report.service.js"));
const { ProcurementWarehouseReportExportService } = require(path.join(DIST, "procurement-warehouse-report-export.service.js"));
const { ReportsController } = require(path.join(DIST, "reports.controller.js"));
const { REQUIRED_ANY_MODULES } = require(path.join(REPO_ROOT, "apps/api/dist/platform/authorization/require-any-modules.decorator.js"));

const dec = (value) => new Prisma.Decimal(value);
const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail: detail ?? null });
  return Boolean(condition);
}
function checkThrows(name, fn, verify) {
  try {
    fn();
  } catch (error) {
    if (verify) verify(error);
    checks.push({ name, ok: true, detail: null });
    return;
  }
  checks.push({ name, ok: false, detail: "预期抛错但没有" });
}

// ===========================================================================
// 手写内存假库：按 Prisma where 语义**真的过滤**（支持本报表用到的全部条件形状）
// ===========================================================================
const isPlainObject = (value) => value !== null && typeof value === "object" && !(value instanceof Date) && !(value instanceof Prisma.Decimal);

function matchCondition(value, condition, key) {
  if (condition === null) return value === null || value === undefined;
  if (isPlainObject(condition)) {
    if ("in" in condition) return condition.in.includes(value);
    let ok = true;
    if ("not" in condition) ok = ok && value !== condition.not && !(condition.not === null && (value === null || value === undefined));
    if ("contains" in condition) {
      const hay = String(value ?? "").toLowerCase();
      ok = ok && hay.includes(String(condition.contains).toLowerCase());
    }
    if (condition.mode !== undefined && "contains" in condition && condition.mode !== "insensitive") {
      throw new Error(`假库只实现了 insensitive contains（key=${key}）`);
    }
    return ok;
  }
  return value === condition;
}

function matchWhere(row, where) {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      if (!condition.some((sub) => matchWhere(row, sub))) return false;
      continue;
    }
    if (!(key in row)) throw new Error(`假库不认识字段「${key}」的 where 条件：实现改用了未支持的查询形状`);
    if (!matchCondition(row[key], condition, key)) return false;
  }
  return true;
}

const WRITE_OPS = ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"];

/** 建内存库。decorateGroupByArgs 只用于「模拟实现被改坏后守卫能否抓住」。 */
function createPrisma(seed = {}, { decorateGroupByArgs } = {}) {
  const db = {
    purchaseOrders: [],
    purchaseOrderItems: [],
    rawMaterialInbounds: [],
    inventoryFacts: [],
    materials: [],
    units: [],
    ...seed
  };
  const calls = [];
  const writes = [];
  const prisma = { calls, writes, db };
  for (const name of ["purchaseOrder", "purchaseOrderItem", "rawMaterialInbound", "inventoryFact", "material", "unit"]) {
    const rowsOf = () => db[`${name}s`] ?? db[name];
    const model = {
      findMany: async (args = {}) => {
        calls.push({ model: name, op: "findMany", args });
        return rowsOf().filter((row) => matchWhere(row, args.where ?? {}));
      },
      groupBy: async (args) => {
        const recordedArgs = decorateGroupByArgs ? decorateGroupByArgs(name, args) : args;
        calls.push({ model: name, op: "groupBy", args: recordedArgs });
        const rows = rowsOf().filter((row) => matchWhere(row, args.where ?? {}));
        const groups = new Map();
        for (const row of rows) {
          const key = args.by.map((field) => row[field] ?? "\u0000null").join("\u0000");
          let group = groups.get(key);
          if (!group) {
            group = {};
            for (const field of args.by) group[field] = row[field];
            group._sum = {};
            for (const field of Object.keys(args._sum ?? {})) group._sum[field] = null;
            groups.set(key, group);
          }
          for (const field of Object.keys(args._sum ?? {})) {
            if (!args._sum[field] || row[field] === null || row[field] === undefined) continue;
            group._sum[field] = group._sum[field] ? group._sum[field].plus(row[field]) : dec(row[field]);
          }
        }
        return [...groups.values()];
      }
    };
    for (const op of WRITE_OPS) model[op] = async () => { writes.push(`${name}.${op}`); throw new Error(`报表不应写库：${name}.${op}`); };
    prisma[name] = model;
  }
  return prisma;
}

function harness(seed = {}, options = {}) {
  const prisma = createPrisma(seed, options);
  return { prisma, report: new ProcurementWarehouseReportService(prisma) };
}

// ---------------------------------------------------------------------------
// 用户截图那张表（11 行）→ 内存库事实（采购 / 入库 / 领用 / 库存四类）
// ---------------------------------------------------------------------------
const REAL_ROWS = [
  ["58cm*8k自动直骨伞", "黑色", "打", 4700, 4700, 3050, 1650],
  ["75D 190T灰色XPG-23535黑胶自然光黑胶碰击布B色号", "灰色", "码", 9800, 9730, 9660, 70],
  ["75D 190T天蓝色XPG-23637自然光黑胶碰击布A色号", "天蓝色", "码", 8495, 8495, 9040, -545],
  ["75D 190T粉色自然光黑胶碰击布", "粉色", "码", 6200, 5778, 4800, 978],
  ["75D 190T卡其色C色号素色黑胶自然光", "卡其色", "码", 8130, 8130, 7850, 280],
  ["75D 190T白色素色黑胶自然光", "白色", "码", 19405, 19405, 17025, 2380],
  ["ABS料伞头（TF1076）", "同客户提供的颜色", "打", 4700, 2178, 2046, 132],
  ["配8MM金色伞签", "金色", "打", 4700, 4700, 2700, 2000],
  ["配3.0金色伞珠", "金色", "打", 4700, 4700, 4700, 0],
  ["1.2金色带LOGO全铜平面扣", "金色", "打", 4700, 4700, 4700, 0],
  ["内标（1*6CM）", "白色", "打", 4700, 0, 0, 0]
];
const UNIT_BY_NAME = new Map([["打", "u-da"], ["码", "u-ma"]]);

/**
 * 11 行 → 内存库。
 * 库存量 = inventory_facts 在（原料仓+报废仓）上的总和，所以「让总和等于截图库存量」：
 *   领用事实 delta = −领用量；
 *   再加一条非领用来源的调整事实，delta = 目标库存 + 领用量（现实里它来自入库过账/盘点等）。
 * 这样库存列既与截图一致，又真的来自 inventory_facts 求和（而不是从采购/入库列推）。
 */
function seedRealRows() {
  const purchaseOrders = [{ id: "po-1", orderNo: "260119", status: "ordered", deletedAt: null }];
  const materials = [];
  const units = [...UNIT_BY_NAME].map(([name, id]) => ({ id, name, deletedAt: null, materialCode: `YL-${id}` }));
  const purchaseOrderItems = [];
  const rawMaterialInbounds = [];
  const inventoryFacts = [];
  REAL_ROWS.forEach(([name, color, unitName, purchase, inbound, issue, stock], index) => {
    const materialId = `m-${index + 1}`;
    const unitId = UNIT_BY_NAME.get(unitName);
    materials.push({ id: materialId, name, color, materialType: "raw_material", deletedAt: null, materialCode: `YL-${String(index + 1).padStart(2, "0")}` });
    if (purchase) purchaseOrderItems.push({ purchaseOrderId: "po-1", materialId, unitId, quantity: dec(purchase), deletedAt: null });
    if (inbound) rawMaterialInbounds.push({ orderNo: "260119", materialId, unitId, quantity: dec(inbound), status: "posted", deletedAt: null });
    if (issue) inventoryFacts.push({ orderNo: "260119", materialId, unitId, quantityDelta: dec(-issue), sourceType: "material_issue", rawMaterialMovementLineId: `line-${index + 1}`, inventoryCategory: "raw_material" });
    const adjustment = dec(stock).plus(dec(issue));
    if (!adjustment.isZero()) inventoryFacts.push({ orderNo: "260119", materialId, unitId, quantityDelta: adjustment, sourceType: "raw_material_inbound", rawMaterialMovementLineId: null, inventoryCategory: "raw_material" });
  });
  return { purchaseOrders, purchaseOrderItems, rawMaterialInbounds, inventoryFacts, materials, units };
}

/** 模拟 `GET /inventory/raw-material-balances` 的取数（同一个 inventory_facts + 同组过滤）。 */
function rawMaterialBalances(db) {
  const materialById = new Map(db.materials.map((row) => [row.id, row]));
  const unitById = new Map(db.units.map((row) => [row.id, row]));
  const sums = new Map();
  for (const fact of db.inventoryFacts) {
    if (!fact.materialId || !fact.unitId) continue;
    if (!["raw_material", "scrap"].includes(fact.inventoryCategory)) continue;
    const material = materialById.get(fact.materialId);
    const unit = unitById.get(fact.unitId);
    if (!material || material.materialType !== "raw_material" || material.deletedAt !== null) continue;
    if (!unit || unit.deletedAt !== null) continue;
    const key = `${fact.materialId}|${fact.unitId}`;
    sums.set(key, (sums.get(key) ?? dec(0)).plus(fact.quantityDelta));
  }
  return sums;
}

const formatView = (row) => row && {
  order_no: row.order_no,
  material_name: row.material_name,
  color: row.color,
  unit: row.unit,
  purchase_quantity: row.purchase_quantity,
  inbound_quantity: row.inbound_quantity,
  pending_inbound_quantity: row.pending_inbound_quantity,
  production_issue_quantity: row.production_issue_quantity,
  stock_quantity: row.stock_quantity
};

// ===========================================================================
async function main() {
  // =========================================================================
  // 1) 用户截图 11 行：五列逐行、排序、行集、库存与余额接口同口径
  // =========================================================================
  const seed = seedRealRows();
  const { prisma, report } = harness(seed);
  const screen = await report.report({ order_no: "260119" });
  check("11 行：报表返回 11 行", screen.data.length === 11, { rows: screen.data.length });
  check("11 行：meta.row_limit = 5000 / row_count = 11 / filters 回显", screen.meta.row_limit === 5000 && screen.meta.row_count === 11 && screen.meta.filters.order_no === "260119", screen.meta);

  const expectedRows = REAL_ROWS.map(([name, color, unitName, purchase, inbound, issue, stock]) => ({
    order_no: "260119", material_name: name, color, unit: unitName,
    purchase_quantity: String(purchase), inbound_quantity: String(inbound),
    pending_inbound_quantity: String(purchase - inbound), production_issue_quantity: String(issue), stock_quantity: String(stock)
  }));
  const expectedByName = new Map(expectedRows.map((row) => [row.material_name, row]));
  const rowMismatches = screen.data.map(formatView).filter((row) => JSON.stringify(row) !== JSON.stringify(expectedByName.get(row.material_name)));
  check("11 行逐列（九列）与截图完全一致（含 -545 负数库存、第 11 行未入库 4700）", rowMismatches.length === 0 && screen.data.length === expectedRows.length, rowMismatches);

  // 排序：订单号数字感知倒序 → 物料名码位升序 → 单位升序（这里同订单，按名排序）
  const sortedNames = [...REAL_ROWS].map((row) => row[0]).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  check("同订单内按物料名称码位升序", JSON.stringify(screen.data.map((row) => row.material_name)) === JSON.stringify(sortedNames), { actual: screen.data.map((row) => row.material_name), expected: sortedNames });

  // 库存量 = 余额接口同口径（同一批 inventory_facts，按（物料,单位）求和；原料仓+报废仓；物料/单位未删）
  const balances = rawMaterialBalances(seed);
  const stockMismatch = screen.data.filter((row, index) => {
    const materialId = `m-${REAL_ROWS.findIndex((real) => real[0] === row.material_name) + 1}`;
    const unitId = UNIT_BY_NAME.get(row.unit);
    const expected = balances.get(`${materialId}|${unitId}`) ?? dec(0);
    return dec(row.stock_quantity).comparedTo(expected) !== 0;
  });
  check("库存量 = 余额接口同口径逐行一致（同一 inventory_facts 求和集合）", stockMismatch.length === 0, { balances: [...balances.entries()].map(([key, value]) => `${key}=${value.toFixed()}`), mismatches: stockMismatch });
  check("库存量不按订单拆账：库存事实里有 orderNo 也不参与分组（groupBy.by 无 orderNo）", prisma.calls.filter((call) => call.model === "inventoryFact" && call.op === "groupBy").length === 2 && prisma.calls.filter((call) => call.model === "inventoryFact" && call.op === "groupBy")[1].args.by.join(",") === "materialId,unitId", prisma.calls.filter((call) => call.model === "inventoryFact").map((call) => call.args.by));

  // 报废仓事实参与库存量、成品事实不参与；软删物料/单位按 0
  const edgeMaterialId = "m-1";
  seed.inventoryFacts.push({ orderNo: null, materialId: edgeMaterialId, unitId: "u-da", quantityDelta: dec(-10), sourceType: "material_scrap", rawMaterialMovementLineId: null, inventoryCategory: "scrap" });
  seed.inventoryFacts.push({ orderNo: null, materialId: edgeMaterialId, unitId: "u-da", quantityDelta: dec(10), sourceType: "raw_material_inbound", rawMaterialMovementLineId: null, inventoryCategory: "raw_material" });
  seed.inventoryFacts.push({ orderNo: null, materialId: edgeMaterialId, unitId: "u-da", quantityDelta: dec(999), sourceType: "finished_goods_inbound", rawMaterialMovementLineId: null, inventoryCategory: "finished_goods" });
  seed.materials.push({ id: "m-deleted", name: "已删物料", color: "黑", materialType: "raw_material", deletedAt: new Date(), materialCode: "YL-DEL" });
  seed.units.push({ id: "u-deleted", name: "已删单位", deletedAt: new Date() });
  seed.inventoryFacts.push({ orderNo: null, materialId: "m-deleted", unitId: "u-da", quantityDelta: dec(500), sourceType: "raw_material_inbound", rawMaterialMovementLineId: null, inventoryCategory: "raw_material" });
  seed.inventoryFacts.push({ orderNo: null, materialId: edgeMaterialId, unitId: "u-deleted", quantityDelta: dec(700), sourceType: "raw_material_inbound", rawMaterialMovementLineId: null, inventoryCategory: "raw_material" });
  const edge = await harness(seed).report.build({});
  const row1 = edge.rows.find((row) => row.material_name === REAL_ROWS[0][0]);
  check("报废仓事实计入库存量、成品类别事实不计入（净变化 0）", row1 && row1.stock_quantity === "1650", row1);
  check("只有库存、没有采购/入库/领用事实的物料不出行（软删物料不建行）", !edge.rows.some((row) => row.material_name === "已删物料"), edge.rows.map((row) => row.material_name));
  const balancesEdge = rawMaterialBalances(seed);
  check("余额接口同口径也把已删物料/单位排除（报表与余额一致）", !balancesEdge.has("m-deleted|u-da") && !balancesEdge.has(`${edgeMaterialId}|u-deleted`), [...balancesEdge.keys()]);

  // 屏幕 JSON 与 xlsx 同一份取数（同一取数服务）
  const exportService = new ProcurementWarehouseReportExportService(new ProcurementWarehouseReportService(createPrisma(seedRealRows())));
  const exported = await exportService.exportWorkbook({ order_no: "260119" });
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(exported.buffer);
  const sheet = workbook.worksheets[0];
  const xlsxRows = [];
  for (let rowNumber = 4; rowNumber <= 14; rowNumber += 1) {
    const values = [];
    for (let column = 1; column <= 9; column += 1) values.push(sheet.getRow(rowNumber).getCell(column).value);
    xlsxRows.push(values);
  }
  const xlsxMismatch = screen.data.filter((row) => {
    const exportedRow = xlsxRows.find((candidate) => candidate[1] === row.material_name);
    return !exportedRow || exportedRow[0] !== row.order_no || exportedRow[4] !== Number(row.purchase_quantity) || exportedRow[5] !== Number(row.inbound_quantity) || exportedRow[6] !== Number(row.pending_inbound_quantity) || exportedRow[7] !== Number(row.production_issue_quantity) || exportedRow[8] !== Number(row.stock_quantity);
  });
  check("xlsx 与屏幕 JSON 逐行逐列相同（同一份取数）", xlsxMismatch.length === 0, xlsxMismatch);

  // =========================================================================
  // 2) 行为级口径：草稿/已取消采购单不计、草稿/冲销入库不计、领用五来源净额与报废不计
  // =========================================================================
  const base = { materials: [{ id: "m-1", name: "伞骨", color: "银", materialType: "raw_material", deletedAt: null, materialCode: "YL-01" }], units: [{ id: "u-1", name: "支", deletedAt: null }] };
  for (const status of ["draft", "cancelled"]) {
    const { report: statusReport } = harness({
      ...base,
      purchaseOrders: [{ id: "po-1", orderNo: "260119", status, deletedAt: null }],
      purchaseOrderItems: [{ purchaseOrderId: "po-1", materialId: "m-1", unitId: "u-1", quantity: dec(100), deletedAt: null }]
    });
    const result = await statusReport.build({});
    check(`行为级：采购单 status=${status} 时采购数量不计（不出行）`, result.rows.length === 0, result.rows);
  }
  {
    const { report: orderedReport } = harness({
      ...base,
      purchaseOrders: [{ id: "po-1", orderNo: "260119", status: "ordered", deletedAt: null }],
      purchaseOrderItems: [{ purchaseOrderId: "po-1", materialId: "m-1", unitId: "u-1", quantity: dec(100), deletedAt: null }]
    });
    const result = await orderedReport.build({});
    check("行为级：采购单 status=ordered 时计入（采购数量 100）", result.rows.length === 1 && result.rows[0].purchase_quantity === "100", result.rows);
  }
  {
    // 入库：posted 4700 计入；draft 100、reversed 50 不计。
    const { report: inboundReport } = harness({
      ...base,
      purchaseOrders: [{ id: "po-1", orderNo: "260119", status: "ordered", deletedAt: null }],
      purchaseOrderItems: [{ purchaseOrderId: "po-1", materialId: "m-1", unitId: "u-1", quantity: dec(4700), deletedAt: null }],
      rawMaterialInbounds: [
        { orderNo: "260119", materialId: "m-1", unitId: "u-1", quantity: dec(4700), status: "posted", deletedAt: null },
        { orderNo: "260119", materialId: "m-1", unitId: "u-1", quantity: dec(100), status: "draft", deletedAt: null },
        { orderNo: "260119", materialId: "m-1", unitId: "u-1", quantity: dec(50), status: "reversed", deletedAt: null }
      ]
    });
    const result = await inboundReport.build({});
    check("行为级：入库只算 posted（4700），草稿/已冲销不计", result.rows[0] && result.rows[0].inbound_quantity === "4700", result.rows[0]);
  }
  {
    // 领用：五个来源类型都参与净额；报废与无原料移动明细外键的事实不计。
    const facts = [
      ["material_issue", -3050, "line-1"],
      ["material_replenishment", -100, "line-2"],
      ["material_return", 50, "line-3"],
      ["material_movement_reversal", -30, "line-4"],
      ["material_movement_reopen", 10, "line-5"],
      ["material_scrap", -200, "line-6"],
      [null, -999, null]
    ].map(([sourceType, delta, lineId]) => ({ orderNo: "260119", materialId: "m-1", unitId: "u-1", quantityDelta: dec(delta), sourceType, rawMaterialMovementLineId: lineId, inventoryCategory: "raw_material" }));
    const { report: issueReport } = harness({ ...base, inventoryFacts: facts });
    const result = await issueReport.build({});
    // 领用 = −(−3050 −100 +50 −30 +10) = 3120；报废 −200 与无外键 −999 都不计入。
    check("行为级：生产领用 = 领料+补料−退料+冲销/撤销净额 = 3120；报废与无原料移动明细不计", result.rows[0] && result.rows[0].production_issue_quantity === "3120", result.rows[0]);
  }
  {
    // 超收：采购 100、入库 120 → 未入库 −20；相等时不能出 -0。
    const { report: overReport } = harness({
      ...base,
      purchaseOrders: [{ id: "po-1", orderNo: "260119", status: "arrived_complete", deletedAt: null }],
      purchaseOrderItems: [{ purchaseOrderId: "po-1", materialId: "m-1", unitId: "u-1", quantity: dec(100), deletedAt: null }],
      rawMaterialInbounds: [{ orderNo: "260119", materialId: "m-1", unitId: "u-1", quantity: dec(120), status: "posted", deletedAt: null }]
    });
    const result = await overReport.build({});
    check("行为级：超收 → 采购未入库数 -20（允许为负）", result.rows[0] && result.rows[0].pending_inbound_quantity === "-20", result.rows[0]);
  }
  {
    // 行集并集 + 全 0 剔除：只有入库的行、只有领用的行、领用净额 0 且无库存的行剔除、有库存则保留。
    const { report: unionReport } = harness({
      ...base,
      materials: [
        { id: "m-1", name: "只入库的料", color: "", materialType: "raw_material", deletedAt: null },
        { id: "m-2", name: "只领用的料", color: "", materialType: "raw_material", deletedAt: null },
        { id: "m-3", name: "冲销干净的料", color: "", materialType: "raw_material", deletedAt: null },
        { id: "m-4", name: "还有库存的料", color: "", materialType: "raw_material", deletedAt: null }
      ],
      rawMaterialInbounds: [{ orderNo: "260118", materialId: "m-1", unitId: "u-1", quantity: dec(120), status: "posted", deletedAt: null }],
      inventoryFacts: [
        { orderNo: "260117", materialId: "m-2", unitId: "u-1", quantityDelta: dec(-50), sourceType: "material_issue", rawMaterialMovementLineId: "l1", inventoryCategory: "raw_material" },
        { orderNo: "260119", materialId: "m-3", unitId: "u-1", quantityDelta: dec(-100), sourceType: "material_issue", rawMaterialMovementLineId: "l2", inventoryCategory: "raw_material" },
        { orderNo: "260119", materialId: "m-3", unitId: "u-1", quantityDelta: dec(100), sourceType: "material_movement_reversal", rawMaterialMovementLineId: "l3", inventoryCategory: "raw_material" },
        { orderNo: "260119", materialId: "m-4", unitId: "u-1", quantityDelta: dec(-100), sourceType: "material_issue", rawMaterialMovementLineId: "l4", inventoryCategory: "raw_material" },
        { orderNo: "260119", materialId: "m-4", unitId: "u-1", quantityDelta: dec(100), sourceType: "material_movement_reversal", rawMaterialMovementLineId: "l5", inventoryCategory: "raw_material" },
        { orderNo: "260119", materialId: "m-4", unitId: "u-1", quantityDelta: dec(500), sourceType: "raw_material_inbound", rawMaterialMovementLineId: null, inventoryCategory: "raw_material" }
      ]
    });
    const result = await unionReport.build({});
    check("行为级：行集 = 三类来源并集（只有入库/只有领用也出行）", result.rows.map((row) => row.material_name).sort().join(",") === ["只入库的料", "只领用的料", "还有库存的料"].sort().join(","), result.rows.map((row) => [row.material_name, row.inbound_quantity, row.production_issue_quantity, row.stock_quantity]));
    check("行为级：五列全 0 的行被剔除（领用冲销干净且无库存）", !result.rows.some((row) => row.material_name === "冲销干净的料"), result.rows);
  }
  // 排序：订单号数字感知倒序
  {
    const { report: sortReport } = harness({
      ...base,
      materials: [{ id: "m-1", name: "料", color: "", materialType: "raw_material", deletedAt: null }],
      purchaseOrders: [
        { id: "po-1", orderNo: "26012", status: "ordered", deletedAt: null },
        { id: "po-2", orderNo: "260119", status: "ordered", deletedAt: null },
        { id: "po-3", orderNo: "2602", status: "ordered", deletedAt: null }
      ],
      purchaseOrderItems: [
        { purchaseOrderId: "po-1", materialId: "m-1", unitId: "u-1", quantity: dec(1), deletedAt: null },
        { purchaseOrderId: "po-2", materialId: "m-1", unitId: "u-1", quantity: dec(1), deletedAt: null },
        { purchaseOrderId: "po-3", materialId: "m-1", unitId: "u-1", quantity: dec(1), deletedAt: null }
      ]
    });
    const result = await sortReport.build({});
    check("行为级：订单号数字感知倒序 260119 > 26012 > 2602", JSON.stringify(result.rows.map((row) => row.order_no)) === JSON.stringify(["260119", "26012", "2602"]), result.rows.map((row) => row.order_no));
  }
  // 两个模糊筛选：包含匹配 + 大小写不敏感（名称或编码）
  {
    const filterSeed = {
      purchaseOrders: [
        { id: "po-1", orderNo: "PO-260119", status: "ordered", deletedAt: null },
        { id: "po-2", orderNo: "PO-260120", status: "ordered", deletedAt: null }
      ],
      materials: [
        { id: "m-1", name: "伞骨", color: "", materialType: "raw_material", deletedAt: null, materialCode: "YL-001" },
        { id: "m-2", name: "手柄", color: "", materialType: "raw_material", deletedAt: null, materialCode: "SB-002" }
      ],
      units: [{ id: "u-1", name: "支", deletedAt: null }],
      purchaseOrderItems: [
        { purchaseOrderId: "po-1", materialId: "m-1", unitId: "u-1", quantity: dec(1), deletedAt: null },
        { purchaseOrderId: "po-2", materialId: "m-2", unitId: "u-1", quantity: dec(1), deletedAt: null }
      ]
    };
    const byOrder = await harness(filterSeed).report.build({ order_no: "po-260119" });
    check("行为级：订单号包含匹配且大小写不敏感（po-260119 → PO-260119）", byOrder.rows.length === 1 && byOrder.rows[0].order_no === "PO-260119", byOrder.rows);
    const byName = await harness(filterSeed).report.build({ material: "伞" });
    check("行为级：物料名称包含匹配（伞 → 伞骨）", byName.rows.length === 1 && byName.rows[0].material_name === "伞骨", byName.rows);
    const byCode = await harness(filterSeed).report.build({ material: "yl-0" });
    check("行为级：物料编码包含匹配且大小写不敏感（yl-0 → YL-001）", byCode.rows.length === 1 && byCode.rows[0].material_name === "伞骨", byCode.rows);
    const blank = await harness(filterSeed).report.build({ order_no: "  ", material: "" });
    check("行为级：空白串按未筛选（两个条件都不生效，2 行）", blank.rows.length === 2, blank.rows.length);
  }
  // 5000 行上限：5000 允许、5001 抛 422 REPORT_ROW_LIMIT_EXCEEDED（不截断）
  const bulkSeed = (count) => {
    const materials = [];
    const purchaseOrderItems = [];
    for (let index = 0; index < count; index += 1) {
      materials.push({ id: `m-${index}`, name: `物料${index}`, color: "", materialType: "raw_material", deletedAt: null });
      purchaseOrderItems.push({ purchaseOrderId: "po-1", materialId: `m-${index}`, unitId: "u-1", quantity: dec(1), deletedAt: null });
    }
    return { purchaseOrders: [{ id: "po-1", orderNo: "260119", status: "ordered", deletedAt: null }], purchaseOrderItems, materials, units: [{ id: "u-1", name: "件", deletedAt: null }] };
  };
  const allowed = await harness(bulkSeed(5000)).report.build({});
  check("行为级：5000 行正常返回（上限不是上限−1）", allowed.rows.length === 5000, { rows: allowed.rows.length });
  let limitError = null;
  try {
    await harness(bulkSeed(5001)).report.build({});
  } catch (error) {
    limitError = error;
  }
  check("行为级：5001 行抛 422 REPORT_ROW_LIMIT_EXCEEDED，且 details 报 5001/5000（不截断）", limitError && limitError.getStatus && limitError.getStatus() === 422 && limitError.getResponse().code === "REPORT_ROW_LIMIT_EXCEEDED" && limitError.getResponse().details?.[0]?.row_count === 5001 && /5000/.test(limitError.getResponse().message), limitError?.getResponse?.() ?? null);
  check("查询预算：固定 7 条查询（1 到 5000 行不增加，禁止按行循环查库）", await (async () => {
    const small = harness(seedRealRows());
    await small.report.build({});
    const large = harness(bulkSeed(5000));
    await large.report.build({});
    return small.prisma.calls.length === 7 && large.prisma.calls.length === 7;
  })(), null);

  // =========================================================================
  // 3) 守卫：所有 groupBy 的 where 只含标量键（实现真用关联过滤时会怎样）
  // =========================================================================
  const scalarGuard = (calls) => {
    const SCALAR_KEYS = new Set(["deletedAt", "purchaseOrderId", "materialId", "unitId", "status", "orderNo", "sourceType", "rawMaterialMovementLineId", "inventoryCategory"]);
    const offenders = [];
    for (const call of calls.filter((item) => item.op === "groupBy")) {
      for (const key of Object.keys(call.args.where)) if (!SCALAR_KEYS.has(key)) offenders.push(`${call.model}.${key}`);
    }
    return offenders;
  };
  const guardHarness = harness(seedRealRows());
  await guardHarness.report.build({ order_no: "260119", material: "伞" });
  check("守卫：真实实现的 4 条 groupBy where 全为标量键", scalarGuard(guardHarness.prisma.calls).length === 0, guardHarness.prisma.calls.filter((call) => call.op === "groupBy").map((call) => Object.keys(call.args.where)));

  // =========================================================================
  // 4) 控制器：路由路径/方法/方法级权限/静态路由在参数路由之前
  // =========================================================================
  const prototype = ReportsController.prototype;
  check("控制器：屏幕路由 GET procurement-warehouse、方法级权限 procurement|warehouse", Reflect.getMetadata(PATH_METADATA, prototype.procurementWarehouse) === "procurement-warehouse" && Reflect.getMetadata(METHOD_METADATA, prototype.procurementWarehouse) === RequestMethod.GET && JSON.stringify(Reflect.getMetadata(REQUIRED_ANY_MODULES, prototype.procurementWarehouse)) === JSON.stringify(["procurement", "warehouse"]), { path: Reflect.getMetadata(PATH_METADATA, prototype.procurementWarehouse), modules: Reflect.getMetadata(REQUIRED_ANY_MODULES, prototype.procurementWarehouse) });
  check("控制器：导出路由 GET procurement-warehouse/export.xlsx、方法级权限 procurement|warehouse", Reflect.getMetadata(PATH_METADATA, prototype.exportProcurementWarehouse) === "procurement-warehouse/export.xlsx" && Reflect.getMetadata(METHOD_METADATA, prototype.exportProcurementWarehouse) === RequestMethod.GET && JSON.stringify(Reflect.getMetadata(REQUIRED_ANY_MODULES, prototype.exportProcurementWarehouse)) === JSON.stringify(["procurement", "warehouse"]), null);
  const controllerSource = fs.readFileSync(path.join(REPO_ROOT, "apps/api/src/modules/reports/reports.controller.ts"), "utf8");
  const reportRouteAt = controllerSource.indexOf('@Get("procurement-warehouse")');
  const exportRouteAt = controllerSource.indexOf('@Get("procurement-warehouse/export.xlsx")');
  const paramRouteAt = controllerSource.indexOf('@Get(":report/export") async export(');
  check("控制器：两条静态路由都声明在 :report/export 之前（否则被参数路由吃掉）", reportRouteAt >= 0 && exportRouteAt >= 0 && paramRouteAt > 0 && reportRouteAt < paramRouteAt && exportRouteAt < paramRouteAt, { reportRouteAt, exportRouteAt, paramRouteAt });

  // =========================================================================
  // 5) 数量字符串：去尾零 / -0 / 四位小数
  // =========================================================================
  check("formatQuantity：4700.0000→4700、-0.0000→0、-20.0000→-20、0.0001→0.0001、大数不走指数", domain.formatQuantity(dec("4700.0000")) === "4700" && domain.formatQuantity(dec("-0.0000")) === "0" && domain.formatQuantity(dec("-20.0000")) === "-20" && domain.formatQuantity(dec("0.0001")) === "0.0001" && domain.formatQuantity(dec("12345678901234.5678")) === "12345678901234.5678", { a: domain.formatQuantity(dec("4700.0000")), b: domain.formatQuantity(dec("-0.0000")), c: domain.formatQuantity(dec("-20.0000")) });

  // =========================================================================
  // 6) 单测「加固性」探针：在内存里把实现改坏，看单测那几条断言会不会真的失败
  //    （只改 require 进来的模块对象的运行期属性，不改任何文件）
  // =========================================================================
  const probes = [];

  // P1：把「已下单状态」列表改成含 draft（模拟「草稿采购单也计入」的实现错误），
  //     单测的 where.status.in 断言 + 行为都应变化。
  {
    const draftSeed = {
      ...base,
      purchaseOrders: [{ id: "po-1", orderNo: "260119", status: "draft", deletedAt: null }],
      purchaseOrderItems: [{ purchaseOrderId: "po-1", materialId: "m-1", unitId: "u-1", quantity: dec(100), deletedAt: null }]
    };
    const before = await harness(draftSeed).report.build({});
    domain.EFFECTIVE_PURCHASE_ORDER_STATUSES.push("draft");
    let after = null;
    let shapeAssertionFails = false;
    try {
      const probeHarness = harness(draftSeed);
      after = await probeHarness.report.build({});
      const ordersArgs = probeHarness.prisma.calls.find((call) => call.model === "purchaseOrder" && call.op === "findMany").args;
      // 这就是单测里那条断言（deepEqual 三个状态）：
      shapeAssertionFails = JSON.stringify(ordersArgs.where.status.in) !== JSON.stringify(["ordered", "partially_arrived", "arrived_complete"]);
    } finally {
      domain.EFFECTIVE_PURCHASE_ORDER_STATUSES.pop();
    }
    const restored = await harness(draftSeed).report.build({});
    probes.push({
      probe: "P1 草稿采购单不计",
      mutated: "EFFECTIVE_PURCHASE_ORDER_STATUSES.push('draft')（内存）",
      before: before.rows.length,
      mutatedRows: after.rows.length,
      shapeAssertionFails,
      restoredRows: restored.rows.length,
      caughtByAssertion: before.rows.length === 0 && after.rows.length === 1 && shapeAssertionFails && restored.rows.length === 0,
      note: "单测的 where.status.in deepEqual 断言会失败；行为级桩（本脚本）也会看到 draft 行流出 → 该断言不是空转。"
    });
  }

  // P2：把行数上限改成 6000（模拟「上限失效/实现截断」），5001 行不再抛 422。
  {
    const savedLimit = domain.PROCUREMENT_WAREHOUSE_ROW_LIMIT;
    domain.PROCUREMENT_WAREHOUSE_ROW_LIMIT = 6000;
    let threwAfterMutation = null;
    try {
      await harness(bulkSeed(5001)).report.build({});
      threwAfterMutation = false;
    } catch {
      threwAfterMutation = true;
    } finally {
      domain.PROCUREMENT_WAREHOUSE_ROW_LIMIT = savedLimit;
    }
    probes.push({
      probe: "P2 5001 行 422 不截断",
      mutated: "PROCUREMENT_WAREHOUSE_ROW_LIMIT = 6000（内存）",
      threwAfterMutation,
      restoredLimit: domain.PROCUREMENT_WAREHOUSE_ROW_LIMIT,
      caughtByAssertion: threwAfterMutation === false,
      note: "单测的 assert.rejects(…getStatus()===422) 会因「没有抛错」而失败 → 该断言依赖真实上限检查，不是恒真。"
    });
  }

  // P3：让假库记录一条带关联键的 groupBy（模拟实现改用了 `material: {...}` 关联过滤），守卫应能抓到。
  {
    const offenderHarness = harness(seedRealRows(), {
      decorateGroupByArgs: (name, args) => (name === "inventoryFact" ? { ...args, where: { ...args.where, material: { deletedAt: null } } } : args)
    });
    await offenderHarness.report.build({ order_no: "260119" });
    const offenders = scalarGuard(offenderHarness.prisma.calls);
    probes.push({
      probe: "P3 groupBy 标量守卫",
      mutated: "假库把一条 groupBy 的 where 记录成 { material: { deletedAt: null } }（模拟关联过滤实现）",
      offenders,
      caughtByAssertion: offenders.length > 0 && offenders.includes("inventoryFact.material"),
      note: "守卫对 where 键做白名单，关联过滤会被判为违规 → 守卫能抓住「顺手优化回关联过滤」。"
    });
  }
  check("P1 探针：草稿采购单不计的断言能抓住改坏的状态清单", probes[0].caughtByAssertion, probes[0]);
  check("P2 探针：5001 行 422 的断言能抓住上限失效（不是恒真）", probes[1].caughtByAssertion, probes[1]);
  check("P3 探针：groupBy 标量守卫能抓住关联过滤", probes[2].caughtByAssertion, probes[2]);

  // =========================================================================
  const failed = checks.filter((item) => !item.ok);
  const result = {
    generatedAt: new Date().toISOString(),
    script: path.relative(REPO_ROOT, import.meta.filename),
    checks,
    probes,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length }
  };
  fs.writeFileSync(RESULTS_JSON, JSON.stringify(result, null, 2), "utf8");
  for (const item of checks) console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.ok || item.detail === null ? "" : `  ${JSON.stringify(item.detail)}`}`);
  console.log(`\n通过 ${result.summary.passed}/${result.summary.total} 条行为/口径断言`);
  for (const probe of probes) console.log(`PROBE ${probe.caughtByAssertion ? "OK" : "NOT-CAUGHT"}  ${probe.probe}`);
  console.log(`结果 JSON：${RESULTS_JSON}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

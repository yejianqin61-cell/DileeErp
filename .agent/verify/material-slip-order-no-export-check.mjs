/**
 * A. 领料单/补料单导出件「订单号」独立核验（2026-11-07）。
 *
 * 不信任实现者测试、也不只读源码：**直接 require `apps/api/dist` 的 MaterialSlipExportService**，
 * 用自造桩（参照 scripts/make-export-samples.cjs 与 apps/api/test/material-slip-export.test.cjs）
 * 生成真实 xlsx 字节，再用 ExcelJS 打开逐格核对：
 *   1. 单张领料单：G5=「订单号：」、H5=订单号（H5:J5 合并、master=H5）；既有字段位置不变；
 *      明细表头第 6 行仍 10 列原样；小计行/备注行不挪。
 *   2. 单张补料单：E7=「订单号：」、F7=订单号；G7=「补料原因：」、H7=原因（位置不挪）；
 *      明细表头第 8 行仍 8 列原样。
 *   3. 批量导出（exportSlips，与 GET production/reports/material-slips.xlsx 同一实现）：领料+补料各一张，
 *      每张工作表都带订单号，且各自用各自版式、订单号互不串。
 *   4. docs/samples/领料单-样例.xlsx、补料单-样例.xlsx：必须已重生成（与当前导出服务逐格一致，不是旧样例）。
 *   5. 打印件（web lib 的 materialSlipHeadRows）与导出件**同位置同顺序**：取 dist 组装的同一份单据
 *      （buildDocument / buildReplenishmentDocument），把打印件的标签/值序列与 xlsx 对应格子序列逐项比对。
 *
 * 运行：node .agent\verify\material-slip-order-no-export-check.mjs
 * 产物：.agent/verify/material-slip-order-no-export-results.json
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DIST = path.join(REPO_ROOT, "apps", "api", "dist", "modules", "production");
const SAMPLES = path.join(REPO_ROOT, "docs", "samples");
const RESULTS_JSON = path.join(REPO_ROOT, ".agent", "verify", "material-slip-order-no-export-results.json");

const ExcelJS = require("exceljs");
const { Prisma } = require("@prisma/client");
const { MaterialSlipExportService } = require(path.join(DIST, "material-slip-export.service.js"));

const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail: detail ?? null });
  return Boolean(condition);
}

// ---------------------------------------------------------------------------
// 自造桩：与 scripts/make-export-samples.cjs 同构，但**订单号故意用两个不同值**，
// 用来证明订单号来自「每张单据自己的生产单所属销售订单」，不是写死的常量。
// ---------------------------------------------------------------------------
const ORDER_NO_ISSUE = "SO-20261107-0007";
const ORDER_NO_REPLENISHMENT = "SO-20261107-0008";

const baseProductionOrder = {
  productionOrderNo: "MO-20261107-0001",
  plannedQuantity: new Prisma.Decimal("500"),
  productSpecification: "22寸×8K",
  unit: { name: "把" },
  executionLocation: { name: "一车间" },
  salesOrder: { productName: "自动雨伞", productSpec: "22寸" },
  bom: {
    items: [
      { materialId: "m1", approvedUsage: new Prisma.Decimal("2500"), requiredQuantity: new Prisma.Decimal("2500"), specificationModel: "58cm", model: null, color: "黑色" },
      { materialId: "m2", approvedUsage: new Prisma.Decimal("500"), requiredQuantity: new Prisma.Decimal("500"), specificationModel: "EVA", model: null, color: "透明" }
    ]
  }
};

const issueMovement = {
  productionOrderId: "order-1",
  createdBy: "user-1",
  productionOrder: { ...baseProductionOrder, orderNo: ORDER_NO_ISSUE },
  productionOrderOperation: null,
  movementNo: "MI-20261107-AAAA1111",
  documentType: "issue",
  status: "posted",
  createdAt: new Date("2026-11-07T02:30:00Z"),
  reason: null,
  remark: "第一批领料，裁剪工序",
  lines: [
    { materialId: "m1", unitId: "u1", quantity: new Prisma.Decimal("1200"), bomReferenceQuantity: new Prisma.Decimal("2500"), material: { name: "伞骨", materialCode: "M-001", specificationModel: "58cm", color: "黑色" }, unit: { name: "根" } },
    { materialId: "m2", unitId: "u2", quantity: new Prisma.Decimal("200"), bomReferenceQuantity: new Prisma.Decimal("500"), material: { name: "伞布", materialCode: "M-002", specificationModel: "EVA", color: "透明" }, unit: { name: "米" } },
    { materialId: "m3", unitId: "u3", quantity: new Prisma.Decimal("15"), bomReferenceQuantity: null, material: { name: "手柄", materialCode: "M-003", specificationModel: null, color: null }, unit: { name: "个" } }
  ]
};

const replenishmentMovement = {
  productionOrderId: "order-1",
  createdBy: "user-1",
  productionOrder: { ...baseProductionOrder, orderNo: ORDER_NO_REPLENISHMENT },
  productionOrderOperation: null,
  movementNo: "MC-20261107-BBBB2222",
  documentType: "replenishment",
  status: "posted",
  createdAt: new Date("2026-11-07T03:10:00Z"),
  reason: "伞布原始坏片 12 米",
  remark: null,
  lines: [
    { materialId: "m2", unitId: "u2", quantity: new Prisma.Decimal("12"), bomReferenceQuantity: new Prisma.Decimal("500"), material: { name: "伞布", materialCode: "M-002", specificationModel: "EVA", color: "透明" }, unit: { name: "米" } }
  ]
};

const inventoryFacts = { m1: new Prisma.Decimal("-1500"), m2: new Prisma.Decimal("-320"), m3: new Prisma.Decimal("-15") };

const fakeActors = { namesOf: async (ids) => new Map(ids.filter(Boolean).map((id) => [id, "张三"])) };

function fakePrisma(movements) {
  const calls = [];
  return {
    calls,
    rawMaterialMovement: {
      findFirst: async (args) => {
        calls.push(args);
        const id = args?.where?.id;
        const movement = movements.find((item) => item.movementNo === id || item.id === id) ?? movements[0];
        if (args?.select?.documentType) return { documentType: movement.documentType };
        return movement;
      },
      findMany: async () => movements
    },
    inventoryFact: { aggregate: async ({ where }) => ({ _sum: { quantityDelta: inventoryFacts[where.materialId] ?? new Prisma.Decimal(0) } }) }
  };
}

const service = () => new MaterialSlipExportService(fakePrisma([issueMovement, replenishmentMovement]), fakeActors);
/** 单张导出用：假库只含这一张单据（否则 findFirst 会按 id 落到第一张，测错版式）。 */
const serviceWith = (movements) => new MaterialSlipExportService(fakePrisma(movements), fakeActors);

async function loadWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

const cellText = (sheet, address) => {
  const value = sheet.getCell(address).value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "formula" in value) return `=${value.formula}`;
  return String(value);
};

const rowValues = (sheet, rowNumber) => {
  const values = [];
  for (let column = 1; column <= 12; column += 1) values.push(sheet.getRow(rowNumber).getCell(column).value);
  return values;
};

const mergesOf = (sheet) => (sheet.model?.merges ?? []).slice();

/** 某工作表里「表头区 3 行 × 4 组」逐组的 (标签, 值) 序列。 */
function headGroups(sheet, rowNumbers, labelColumns) {
  return rowNumbers.map((rowNumber) => labelColumns.map((labelColumn) => {
    const label = cellText(sheet, `${labelColumn}${rowNumber}`);
    const valueColumn = String.fromCharCode(labelColumn.charCodeAt(0) + 1);
    return [label, cellText(sheet, `${valueColumn}${rowNumber}`)];
  }));
}

// ---------------------------------------------------------------------------
async function main() {
  // =========================================================================
  // 1) 单张领料单
  // =========================================================================
  const issueWorkbook = await loadWorkbook(await serviceWith([issueMovement]).exportSlip("issue-1"));
  check("领料单：只生成 1 张工作表且表名 = 单据号", issueWorkbook.worksheets.length === 1 && issueWorkbook.worksheets[0].name === issueMovement.movementNo, issueWorkbook.worksheets.map((sheet) => sheet.name));
  const issueSheet = issueWorkbook.worksheets[0];
  check("领料单：标题 A1 = 【领料单】", cellText(issueSheet, "A1") === "【领料单】", cellText(issueSheet, "A1"));

  const issueHead = headGroups(issueSheet, [3, 4, 5], ["A", "C", "E", "G"]);
  const expectedIssueHead = [
    [["生产单号：", "MO-20261107-0001"], ["成品名称：", "自动雨伞"], ["成品代码：", ""], ["规格型号：", "22寸×8K"]],
    [["颜色：", ""], ["领料单号：", "MI-20261107-AAAA1111"], ["领料工序：", ""], ["领料单位：", "一车间"]],
    [["生产数量：", "500 把"], ["操作人：", "张三"], ["操作时间：", cellText(issueSheet, "F5")], ["订单号：", ORDER_NO_ISSUE]]
  ];
  check("领料单：表头三行 12 组标签/值 = 模板原样 + 第 3 行第 4 组订单号", JSON.stringify(issueHead) === JSON.stringify(expectedIssueHead), issueHead);
  check("领料单：既有字段位置不变（A3 生产单号/B3 值/A4 颜色/D4 领料单号/B5 生产数量/D5 操作人）",
    cellText(issueSheet, "A3") === "生产单号：" && cellText(issueSheet, "B3") === "MO-20261107-0001"
    && cellText(issueSheet, "A4") === "颜色：" && cellText(issueSheet, "D4") === "MI-20261107-AAAA1111"
    && cellText(issueSheet, "B5") === "500 把" && cellText(issueSheet, "D5") === "张三",
    { A3: cellText(issueSheet, "A3"), B3: cellText(issueSheet, "B3"), A4: cellText(issueSheet, "A4"), D4: cellText(issueSheet, "D4"), B5: cellText(issueSheet, "B5"), D5: cellText(issueSheet, "D5") });
  check("领料单：G5 = 「订单号：」、H5 = 订单号", cellText(issueSheet, "G5") === "订单号：" && cellText(issueSheet, "H5") === ORDER_NO_ISSUE, { G5: cellText(issueSheet, "G5"), H5: cellText(issueSheet, "H5") });
  check("领料单：H5:J5 合并，I5/J5 都属于 H5 合并区（值只在 H5 主格，不是独立单元格）", issueSheet.getCell("H5").isMerged && issueSheet.getCell("J5").isMerged && issueSheet.getCell("J5").master.address === "H5" && issueSheet.getCell("I5").master.address === "H5" && mergesOf(issueSheet).includes("H5:J5"), { H5Merged: issueSheet.getCell("H5").isMerged, J5Master: issueSheet.getCell("J5").master?.address, I5Master: issueSheet.getCell("I5").master?.address, merge5: mergesOf(issueSheet).filter((merge) => merge.includes("5")) });
  check("领料单：第 3/4 行第 4 组仍合并到 J（H3:J3 / H4:J4）", mergesOf(issueSheet).includes("H3:J3") && mergesOf(issueSheet).includes("H4:J4"), mergesOf(issueSheet));

  const issueHeaderRow = rowValues(issueSheet, 6).slice(0, 10);
  check("领料单：明细表头第 6 行仍是 10 列原样", JSON.stringify(issueHeaderRow) === JSON.stringify(["序号", "产品名称", "产品代码", "规格型号", "颜色", "单位", "配料数量", "已领数量", "本次领料量", "余下数量"]), issueHeaderRow);
  const issueSubtotalRowNumber = 6 + issueMovement.lines.length + 1;
  check(`领料单：小计行仍在第 ${issueSubtotalRowNumber} 行（表头 + 明细行 + 1，未被订单号挤动）`, cellText(issueSheet, `A${issueSubtotalRowNumber}`) === "小计", { row: issueSubtotalRowNumber, A: cellText(issueSheet, `A${issueSubtotalRowNumber}`), all: rowValues(issueSheet, issueSubtotalRowNumber) });
  const issueRemarkRowNumber = issueSubtotalRowNumber + 1;
  check(`领料单：备注行仍在第 ${issueRemarkRowNumber} 行、合并 A:J`, cellText(issueSheet, `A${issueRemarkRowNumber}`) === "备注：第一批领料，裁剪工序" && mergesOf(issueSheet).includes(`A${issueRemarkRowNumber}:J${issueRemarkRowNumber}`), { row: issueRemarkRowNumber, A: cellText(issueSheet, `A${issueRemarkRowNumber}`), merges: mergesOf(issueSheet).filter((merge) => merge.startsWith(`A${issueRemarkRowNumber}`)) });
  check("领料单：第 1..5 行仍是标题 + 3 行表头（没有多插行）", cellText(issueSheet, "A1") === "【领料单】" && cellText(issueSheet, "A3") === "生产单号：" && cellText(issueSheet, "A4") === "颜色：" && cellText(issueSheet, "A5") === "生产数量：", rowValues(issueSheet, 1));

  // =========================================================================
  // 2) 单张补料单
  // =========================================================================
  const replenishmentWorkbook = await loadWorkbook(await serviceWith([replenishmentMovement]).exportSlip("replenishment-1"));
  check("补料单：只生成 1 张工作表且表名 = 单据号", replenishmentWorkbook.worksheets.length === 1 && replenishmentWorkbook.worksheets[0].name === replenishmentMovement.movementNo, replenishmentWorkbook.worksheets.map((sheet) => sheet.name));
  const replenishmentSheet = replenishmentWorkbook.worksheets[0];
  check("补料单：标题 A2 = 【补料单】", cellText(replenishmentSheet, "A2") === "【补料单】", cellText(replenishmentSheet, "A2"));
  const replenishmentHead = headGroups(replenishmentSheet, [5, 6, 7], ["A", "C", "E", "G"]);
  const expectedReplenishmentHead = [
    [["生产单号：", "MO-20261107-0001"], ["成品名称：", "自动雨伞"], ["成品代码：", ""], ["规格型号：", "22寸×8K"]],
    [["颜色：", ""], ["领料单号：", "MC-20261107-BBBB2222"], ["领料单位：", "一车间"], ["领料工序：", ""]],
    [["操作人：", "张三"], ["操作时间：", cellText(replenishmentSheet, "D7")], ["订单号：", ORDER_NO_REPLENISHMENT], ["补料原因：", "伞布原始坏片 12 米"]]
  ];
  check("补料单：表头三行 12 组标签/值 = 模板原样 + 第 3 行第 3 组订单号", JSON.stringify(replenishmentHead) === JSON.stringify(expectedReplenishmentHead), replenishmentHead);
  check("补料单：E7=「订单号：」、F7=订单号", cellText(replenishmentSheet, "E7") === "订单号：" && cellText(replenishmentSheet, "F7") === ORDER_NO_REPLENISHMENT, { E7: cellText(replenishmentSheet, "E7"), F7: cellText(replenishmentSheet, "F7") });
  check("补料单：G7=「补料原因：」、H7=原因（补料原因位置不挪）", cellText(replenishmentSheet, "G7") === "补料原因：" && cellText(replenishmentSheet, "H7") === "伞布原始坏片 12 米", { G7: cellText(replenishmentSheet, "G7"), H7: cellText(replenishmentSheet, "H7") });
  check("补料单：明细表头第 8 行仍是 8 列原样", JSON.stringify(rowValues(replenishmentSheet, 8).slice(0, 8)) === JSON.stringify(["序号", "图片", "产品名称", "产品代码", "规格型号", "颜色", "单位", "补领数量"]), rowValues(replenishmentSheet, 8).slice(0, 8));
  const replenishmentSubtotalRowNumber = 8 + replenishmentMovement.lines.length + 1;
  check(`补料单：小计行仍在第 ${replenishmentSubtotalRowNumber} 行`, cellText(replenishmentSheet, `A${replenishmentSubtotalRowNumber}`) === "小计", { row: replenishmentSubtotalRowNumber, A: cellText(replenishmentSheet, `A${replenishmentSubtotalRowNumber}`) });

  // =========================================================================
  // 3) 批量导出（混合：领料 + 补料各一张）
  // =========================================================================
  const batch = await service().exportSlips({});
  check("批量导出：count = 2（领料 + 补料）", batch.count === 2, batch.count);
  const batchWorkbook = await loadWorkbook(batch.buffer);
  check("批量导出：两张工作表、表名 = 各自单据号", JSON.stringify(batchWorkbook.worksheets.map((sheet) => sheet.name)) === JSON.stringify([issueMovement.movementNo, replenishmentMovement.movementNo]), batchWorkbook.worksheets.map((sheet) => sheet.name));
  const batchIssue = batchWorkbook.getWorksheet(issueMovement.movementNo);
  const batchReplenishment = batchWorkbook.getWorksheet(replenishmentMovement.movementNo);
  check("批量导出（领料单）：G5/H5 带订单号、表头第 6 行 10 列", Boolean(batchIssue) && cellText(batchIssue, "G5") === "订单号：" && cellText(batchIssue, "H5") === ORDER_NO_ISSUE && cellText(batchIssue, "J6") === "余下数量", { G5: batchIssue && cellText(batchIssue, "G5"), H5: batchIssue && cellText(batchIssue, "H5") });
  check("批量导出（补料单）：E7/F7 带订单号、G7/H7 补料原因、表头第 8 行 8 列", Boolean(batchReplenishment) && cellText(batchReplenishment, "E7") === "订单号：" && cellText(batchReplenishment, "F7") === ORDER_NO_REPLENISHMENT && cellText(batchReplenishment, "G7") === "补料原因：" && cellText(batchReplenishment, "H7") === "伞布原始坏片 12 米" && cellText(batchReplenishment, "H8") === "补领数量", { E7: batchReplenishment && cellText(batchReplenishment, "E7"), F7: batchReplenishment && cellText(batchReplenishment, "F7"), G7: batchReplenishment && cellText(batchReplenishment, "G7"), H7: batchReplenishment && cellText(batchReplenishment, "H7") });
  check("批量导出：两张单据的订单号互不串（各取自己的销售订单号）", cellText(batchIssue, "H5") === ORDER_NO_ISSUE && cellText(batchReplenishment, "F7") === ORDER_NO_REPLENISHMENT && ORDER_NO_ISSUE !== ORDER_NO_REPLENISHMENT, { issue: cellText(batchIssue, "H5"), replenishment: cellText(batchReplenishment, "F7") });

  // =========================================================================
  // 4) docs/samples 两张样例：必须已重生成（与当前导出服务逐格一致）
  // =========================================================================
  const sampleIssuePath = path.join(SAMPLES, "领料单-样例.xlsx");
  const sampleReplenishmentPath = path.join(SAMPLES, "补料单-样例.xlsx");
  check("样例文件存在：领料单-样例.xlsx", fs.existsSync(sampleIssuePath), sampleIssuePath);
  check("样例文件存在：补料单-样例.xlsx", fs.existsSync(sampleReplenishmentPath), sampleReplenishmentPath);
  if (fs.existsSync(sampleIssuePath) && fs.existsSync(sampleReplenishmentPath)) {
    const sampleIssue = (await loadWorkbook(fs.readFileSync(sampleIssuePath))).worksheets[0];
    const sampleReplenishment = (await loadWorkbook(fs.readFileSync(sampleReplenishmentPath))).worksheets[0];
    check("样例（领料单）：G5=「订单号：」、H5=DL260001（样例已重生成）", cellText(sampleIssue, "G5") === "订单号：" && cellText(sampleIssue, "H5") === "DL260001", { G5: cellText(sampleIssue, "G5"), H5: cellText(sampleIssue, "H5") });
    check("样例（补料单）：E7=「订单号：」、F7=DL260001、G7=「补料原因：」、H7 原样", cellText(sampleReplenishment, "E7") === "订单号：" && cellText(sampleReplenishment, "F7") === "DL260001" && cellText(sampleReplenishment, "G7") === "补料原因：" && cellText(sampleReplenishment, "H7") === "伞布原始坏片 12 米，需补领", { E7: cellText(sampleReplenishment, "E7"), F7: cellText(sampleReplenishment, "F7"), G7: cellText(sampleReplenishment, "G7"), H7: cellText(sampleReplenishment, "H7") });
    check("样例（领料单）：明细表头第 6 行 10 列、小计「小计」", JSON.stringify(rowValues(sampleIssue, 6).slice(0, 10)) === JSON.stringify(["序号", "产品名称", "产品代码", "规格型号", "颜色", "单位", "配料数量", "已领数量", "本次领料量", "余下数量"]) && cellText(sampleIssue, "A10") === "小计", { row6: rowValues(sampleIssue, 6).slice(0, 10), A10: cellText(sampleIssue, "A10") });
    check("样例（补料单）：明细表头第 8 行 8 列、小计「小计」", JSON.stringify(rowValues(sampleReplenishment, 8).slice(0, 8)) === JSON.stringify(["序号", "图片", "产品名称", "产品代码", "规格型号", "颜色", "单位", "补领数量"]) && cellText(sampleReplenishment, "A10") === "小计", { row8: rowValues(sampleReplenishment, 8).slice(0, 8), A10: cellText(sampleReplenishment, "A10") });

    // 「样例 = 当前导出件」：用 make-export-samples.cjs 的同一组固定样例数据重新导出，逐格 + 合并区比对。
    const sampleProductionOrder = { ...baseProductionOrder, productionOrderNo: "MO-20260910-0001", orderNo: "DL260001" };
    const sampleIssueFixture = {
      ...issueMovement,
      movementNo: "MI-20260910-8F3A21C7",
      createdAt: new Date("2026-09-10T02:30:00Z"),
      lines: [
        { materialId: "m1", unitId: "u1", quantity: new Prisma.Decimal("1200"), bomReferenceQuantity: new Prisma.Decimal("2500"), material: { name: "伞骨", materialCode: "M-001", specificationModel: "58cm", color: "黑色" }, unit: { name: "根" } },
        { materialId: "m2", unitId: "u2", quantity: new Prisma.Decimal("200"), bomReferenceQuantity: new Prisma.Decimal("500"), material: { name: "伞布", materialCode: "M-002", specificationModel: "EVA", color: "透明" }, unit: { name: "米" } },
        { materialId: "m3", unitId: "u3", quantity: new Prisma.Decimal("15"), bomReferenceQuantity: null, material: { name: "手柄", materialCode: "M-003", specificationModel: null, color: null }, unit: { name: "个" } }
      ],
      productionOrder: sampleProductionOrder
    };
    const sampleReplenishmentFixture = {
      ...replenishmentMovement,
      movementNo: "MC-20260910-5B7C9D01",
      createdAt: new Date("2026-09-10T03:10:00Z"),
      reason: "伞布原始坏片 12 米，需补领",
      lines: [
        { materialId: "m2", unitId: "u2", quantity: new Prisma.Decimal("12"), bomReferenceQuantity: new Prisma.Decimal("500"), material: { name: "伞布", materialCode: "M-002", specificationModel: "EVA", color: "透明" }, unit: { name: "米" } }
      ],
      productionOrder: sampleProductionOrder
    };
    const regeneratedIssue = (await loadWorkbook(await serviceWith([sampleIssueFixture]).exportSlip("issue-1"))).worksheets[0];
    const regeneratedReplenishment = (await loadWorkbook(await serviceWith([sampleReplenishmentFixture]).exportSlip("replenishment-1"))).worksheets[0];
    const sameCells = (left, right, maxRow = 16, maxColumn = 12) => {
      for (let row = 1; row <= maxRow; row += 1) {
        for (let column = 1; column <= maxColumn; column += 1) {
          const a = cellText(left, `${String.fromCharCode(64 + column)}${row}`);
          const b = cellText(right, `${String.fromCharCode(64 + column)}${row}`);
          if (a !== b) return { row, column, sample: a, regenerated: b };
        }
      }
      return null;
    };
    const issueDiff = sameCells(sampleIssue, regeneratedIssue);
    const replenishmentDiff = sameCells(sampleReplenishment, regeneratedReplenishment);
    check("样例（领料单）= 当前导出服务的输出（逐格一致）", issueDiff === null, issueDiff);
    check("样例（补料单）= 当前导出服务的输出（逐格一致）", replenishmentDiff === null, replenishmentDiff);
    check("样例（领料单）合并区与导出件一致", JSON.stringify(mergesOf(sampleIssue).sort()) === JSON.stringify(mergesOf(regeneratedIssue).sort()), { sample: mergesOf(sampleIssue), regenerated: mergesOf(regeneratedIssue) });
    check("样例（补料单）合并区与导出件一致", JSON.stringify(mergesOf(sampleReplenishment).sort()) === JSON.stringify(mergesOf(regeneratedReplenishment).sort()), { sample: mergesOf(sampleReplenishment), regenerated: mergesOf(regeneratedReplenishment) });
  }

  // =========================================================================
  // 5) 打印件（web lib 纯函数）与导出件同位置同顺序
  //    打印件用 dist buildDocument/buildReplenishmentDocument 组装的**同一份单据**，
  //    与导出 xlsx 的表头区逐组比对（顺序与位置必须完全一致）。
  // =========================================================================
  const printModule = await import(pathToFileURL(path.join(REPO_ROOT, "apps", "web", "lib", "material-slip-print.ts")).href).catch(() => null);
  if (printModule) {
    const issueDocument = await serviceWith([issueMovement]).buildDocument("issue-1");
    const issueHeadRows = printModule.materialSlipHeadRows({ document_type: "issue", document: issueDocument });
    const issueXlsxHead = headGroups(issueSheet, [3, 4, 5], ["A", "C", "E", "G"]);
    check("打印件（领料单）与导出件：三行 × 4 组标签/值完全同位置同顺序", JSON.stringify(issueHeadRows) === JSON.stringify(issueXlsxHead), { print: issueHeadRows, xlsx: issueXlsxHead });
    check("打印件（领料单）第 3 行第 4 组 = 订单号（与导出件 G5/H5 同一位置）", issueHeadRows[2][3][0] === "订单号：" && issueHeadRows[2][3][1] === ORDER_NO_ISSUE, issueHeadRows[2]);

    const replenishmentDocument = await serviceWith([replenishmentMovement]).buildReplenishmentDocument("replenishment-1");
    const replenishmentHeadRows = printModule.materialSlipHeadRows({ document_type: "replenishment", document: replenishmentDocument });
    const replenishmentXlsxHead = headGroups(replenishmentSheet, [5, 6, 7], ["A", "C", "E", "G"]);
    check("打印件（补料单）与导出件：三行 × 4 组标签/值完全同位置同顺序", JSON.stringify(replenishmentHeadRows) === JSON.stringify(replenishmentXlsxHead), { print: replenishmentHeadRows, xlsx: replenishmentXlsxHead });
    check("打印件（补料单）第 3 行第 3 组 = 订单号、第 4 组 = 补料原因", replenishmentHeadRows[2][2][0] === "订单号：" && replenishmentHeadRows[2][3][0] === "补料原因：", replenishmentHeadRows[2]);
    check("打印件：订单号为空时该组仍占位（标签在、值为空串，与导出件空格一致）", JSON.stringify(printModule.materialSlipHeadRows({ document_type: "issue", document: { ...issueDocument, orderNo: "" } })[2][3]) === JSON.stringify(["订单号：", ""]), null);
  } else {
    check("打印件纯函数可被 node 直接 import（.ts 经类型擦除）", false, "import material-slip-print.ts 失败（Node 版本不支持 TS 类型擦除？）");
  }

  // =========================================================================
  const failed = checks.filter((item) => !item.ok);
  const result = {
    generatedAt: new Date().toISOString(),
    script: path.relative(REPO_ROOT, import.meta.filename),
    fixtures: { orderNoIssue: ORDER_NO_ISSUE, orderNoReplenishment: ORDER_NO_REPLENISHMENT },
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    checks
  };
  fs.mkdirSync(path.dirname(RESULTS_JSON), { recursive: true });
  fs.writeFileSync(RESULTS_JSON, JSON.stringify(result, null, 2), "utf8");
  for (const item of checks) console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.ok || item.detail === null ? "" : `  ${JSON.stringify(item.detail)}`}`);
  console.log(`\nA 导出件核验：${result.summary.passed}/${result.summary.total} 条断言通过`);
  console.log(`结果 JSON：${RESULTS_JSON}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

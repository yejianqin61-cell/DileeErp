// 领料单 / 补料单打印件口径的纯函数测试（node --test，不是 vitest）。
//
// 纸面版式必须与 `docs/samples/领料单-样例.xlsx` / `补料单-样例.xlsx` 以及服务端导出的 xlsx 逐行一致：
// 标题（含状态）、三行表头、明细列、小计。仓库拿纸跟车间对料，纸与 Excel 对不上就白做了。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  materialSlipHeadRows, materialSlipPrintColumns, materialSlipPrintHeading, materialSlipPrintSubtotal,
} from "./material-slip-print.ts";

const issueDocument = {
  movementNo: "MI-20260910-8F3A21C7",
  status: "posted",
  productionOrderNo: "MO-20260910-0001",
  orderNo: "SO-1",
  productName: "自动雨伞",
  productCode: "",
  productSpecification: "22寸×8K",
  productColor: "",
  operationName: "",
  issueUnit: "一车间",
  plannedQuantity: 500,
  unitName: "把",
  operatorName: "张三",
  operatedAt: "2026/9/10 10:30:00",
  remark: "第一批领料，裁剪工序",
  lines: [
    { sequence: 1, materialName: "伞骨", materialCode: "M-001", specificationModel: "58cm", color: "黑色", unit: "根", bomQuantity: 2500, issuedQuantity: 300, currentQuantity: 1200, remainingQuantity: 1000 },
    { sequence: 2, materialName: "伞布", materialCode: "M-002", specificationModel: "EVA", color: "透明", unit: "米", bomQuantity: 500, issuedQuantity: 120, currentQuantity: 200, remainingQuantity: 180 },
  ],
};

const issueSlip = { document_type: "issue", document: issueDocument };
const replenishmentSlip = {
  document_type: "replenishment",
  document: { ...issueDocument, movementNo: "MC-1", status: "draft", reason: "伞布坏片 12 米", lines: [{ sequence: 1, materialName: "伞布", materialCode: "M-002", specificationModel: "EVA", color: "透明", unit: "米", replenishQuantity: 12 }] },
};

test("标题：草稿 / 待仓库出库 / 已冲销写进纸头（与导出 xlsx 同一口径）", () => {
  assert.equal(materialSlipPrintHeading({ document_type: "issue", document: { ...issueDocument, status: "posted" } }), "【领料单】");
  assert.equal(materialSlipPrintHeading({ document_type: "issue", document: { ...issueDocument, status: "draft" } }), "【领料单】（草稿）");
  assert.equal(materialSlipPrintHeading({ document_type: "issue", document: { ...issueDocument, status: "pending_outbound" } }), "【领料单】（待仓库出库）");
  assert.equal(materialSlipPrintHeading({ document_type: "replenishment", document: { ...issueDocument, status: "reversed" } }), "【补料单】（已冲销）");
});

test("明细列：领料单四个数量；补料单只有补领数量 + 一个图片列（与样例 xlsx 同序）", () => {
  assert.deepEqual(materialSlipPrintColumns("issue").map((column) => column.label), ["序号", "产品名称", "产品代码", "规格型号", "颜色", "单位", "配料数量", "已领数量", "本次领料量", "余下数量"]);
  assert.deepEqual(materialSlipPrintColumns("replenishment").map((column) => column.label), ["序号", "图片", "产品名称", "产品代码", "规格型号", "颜色", "单位", "补领数量"]);
});

test("小计：领料单合计「本次领料量」，补料单合计「补领数量」（与导出件同口径）", () => {
  assert.equal(materialSlipPrintSubtotal("issue", issueDocument.lines), 1400);
  assert.equal(materialSlipPrintSubtotal("replenishment", replenishmentSlip.document.lines), 12);
  assert.equal(materialSlipPrintSubtotal("issue", []), 0);
});

test("表头三行：补料单第 2 行是「领料单位」在前、「领料工序」在后（样例如此）", () => {
  const issueRows = materialSlipHeadRows(issueSlip);
  assert.equal(issueRows.length, 3);
  assert.deepEqual(issueRows[0].map(([label]) => label), ["生产单号：", "成品名称：", "成品代码：", "规格型号："]);
  assert.deepEqual(issueRows[1].map(([label]) => label), ["颜色：", "领料单号：", "领料工序：", "领料单位："]);
  assert.equal(issueRows[2][0][1], "500 把", "生产数量要带单位");
  const replenishmentRows = materialSlipHeadRows(replenishmentSlip);
  assert.deepEqual(replenishmentRows[1].map(([label]) => label), ["颜色：", "领料单号：", "领料单位：", "领料工序："]);
  assert.deepEqual(replenishmentRows[2][2], ["补料原因：", "伞布坏片 12 米"]);
});

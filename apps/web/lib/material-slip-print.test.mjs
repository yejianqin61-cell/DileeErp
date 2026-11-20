// 领料单 / 补料单打印件口径的纯函数测试（node --test，不是 vitest）。
//
// 纸面版式必须与 `docs/samples/领料单-样例.xlsx` / `补料单-样例.xlsx` 以及服务端导出的 xlsx 逐行一致：
// 标题（含状态）、三行表头、明细列、小计。仓库拿纸跟车间对料，纸与 Excel 对不上就白做了。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  materialSlipHeadRows, materialSlipPrintColumns, materialSlipPrintHeading, materialSlipPrintSubtotal, materialSlipSpecification,
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
    { sequence: 1, materialName: "伞骨", materialCode: "M-001", specificationModel: "58cm", color: "黑色", unit: "根", bomQuantity: 2500, actualInboundQuantity: 2500, issuedQuantity: 300, currentQuantity: 1200, remainingQuantity: 1000 },
    { sequence: 2, materialName: "伞布", materialCode: "M-002", specificationModel: "EVA", color: "透明", unit: "米", bomQuantity: 500, actualInboundQuantity: 500, issuedQuantity: 120, currentQuantity: 200, remainingQuantity: 180 },
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

test("明细列：领料单配料/实际入库/已领/本次/余下；补料单只有补领数量 + 一个图片列（与样例 xlsx 同序）", () => {
  assert.deepEqual(materialSlipPrintColumns("issue").map((column) => column.label), ["序号", "产品名称", "产品代码", "规格型号", "颜色", "单位", "配料数量", "实际入库数量", "已领数量", "本次领料量", "余下数量"]);
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
  assert.deepEqual(replenishmentRows[2][3], ["补料原因：", "伞布坏片 12 米"]);
});

test("订单号：与导出 xlsx 同位置印在纸头第 3 行（领料单第 4 组 / 补料单第 3 组，补料原因不挪）", () => {
  // 领料单第 3 行 = 生产数量 / 操作人 / 操作时间 / **订单号**
  const issueRows = materialSlipHeadRows(issueSlip);
  assert.equal(issueRows[2].length, 4, "领料单第 3 行补完订单号后是 4 组");
  assert.deepEqual(issueRows[2].map(([label]) => label), ["生产数量：", "操作人：", "操作时间：", "订单号："]);
  assert.deepEqual(issueRows[2][3], ["订单号：", "SO-1"]);

  // 补料单第 3 行 = 操作人 / 操作时间 / **订单号** / 补料原因（第 4 组仍是补料原因）
  const replenishmentRows = materialSlipHeadRows(replenishmentSlip);
  assert.equal(replenishmentRows[2].length, 4, "补料单第 3 行仍是 4 组（订单号插在第 3 组）");
  assert.deepEqual(replenishmentRows[2].map(([label]) => label), ["操作人：", "操作时间：", "订单号：", "补料原因："]);
  assert.deepEqual(replenishmentRows[2][2], ["订单号：", "SO-1"]);
  // 订单号为空时也留出这一组（纸面格子不能整格消失，导出件里那格是空的）。
  assert.deepEqual(materialSlipHeadRows({ document_type: "issue", document: { ...issueDocument, orderNo: "" } })[2][3], ["订单号：", ""]);
});

test("规格型号：去掉重复列头与备注/附注，压平换行，不打印冗余参数（T-0023）", () => {
  assert.equal(materialSlipSpecification("58cm"), "58cm");
  assert.equal(materialSlipSpecification(" 58cm\r\n×8K\t黑色电着 "), "58cm ×8K 黑色电着", "换行/制表符压成空格，不能带进纸面");
  assert.equal(materialSlipSpecification("规格型号：58cm×8K"), "58cm×8K", "列头已经写着规格型号，值里不再重复");
  assert.equal(materialSlipSpecification("58cm×8K（备注：客户指定加厚）"), "58cm×8K", "括号里的备注整段不打印");
  assert.equal(materialSlipSpecification("58cm×8K（备注）"), "58cm×8K", "括号里只有「备注」也要整段剔除");
  assert.equal(materialSlipSpecification("58cm×8K (说明: 加厚)"), "58cm×8K", "半角括号/说明同样剔除");
  assert.equal(materialSlipSpecification("58cm；58cm；黑色"), "58cm；黑色", "重复参数只留一份");
  assert.equal(materialSlipSpecification("58cm/备注：加厚"), "58cm", "斜杠后的备注不打印");
  assert.equal(materialSlipSpecification("说明书 210×140"), "说明书 210×140", "「说明书」是规格本身，不能当成「说明」备注误删");
  assert.equal(materialSlipSpecification("备注：只有备注"), "", "整格都是备注时留空，不印无意义内容");
  assert.equal(materialSlipSpecification(null), "");
  assert.equal(materialSlipSpecification("   "), "");
});

test("规格型号：超过列宽自动截断加省略号，长度不超过上限（T-0023）", () => {
  const long = "58cm×8K 黑色电着 加厚款 双面 防紫外线 客户指定";
  const brief = materialSlipSpecification(long);
  assert.ok(Array.from(brief).length <= 18, "截断后总字数（含省略号）不超过 18");
  assert.ok(brief.endsWith("…"), "截断必须有省略号");
  assert.equal(brief.includes("\n"), false, "纸面不允许换行");
  assert.equal(materialSlipSpecification(long, 6), "58cm×…", "上限可传参，便于其它列复用");
});

test("规格型号：打印件单元格保证单行省略，不能换成多行（T-0023）", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.material-slip-table td\.material-slip-spec \{[^}]*white-space: nowrap;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*\}/, "规格型号格必须 nowrap + 省略号，否则长规格会把行撑高/折行");
});

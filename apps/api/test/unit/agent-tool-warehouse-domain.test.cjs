// 仓库领域 6 个 operation：假只读 client 故意带财务、附件与自由文本字段，
// 断言 Agent 只投影业务进度事实。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  getRawMaterialBalance, getInventoryFacts, getMaterialMovements,
  getFinishedGoodsQc, getFinishedGoodsInbounds, getFinishedGoodsOutbounds,
} = require("../../dist/modules/business-query-agent/tools/warehouse-query-tools.js");

const ROOT = { id: "root-1", orderNo: "SO-TEST-001", quantity: { toString: () => "100" }, unit: "把", status: "confirmed", updatedAt: new Date() };
const decimal = (value) => ({ toString: () => String(value), plus(other) { return decimal(Number(value) + Number(other.toString())); } });

function fakeClient() {
  return {
    bom: { findMany: async () => [{ id: "bom-1" }] },
    bomItem: { findMany: async () => [{ materialId: "material-1" }] },
    inventoryFact: { findMany: async () => [
      { materialId: "material-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: decimal("12"), sourceType: "raw_material_inbound", sourceId: "fact-raw", createdAt: new Date("2026-10-01"), material: { materialCode: "MAT-1", name: "伞布" }, unit: { name: "米" } },
      { materialId: "material-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: decimal("-2"), sourceType: "material_issue", sourceId: "fact-order", createdAt: new Date("2026-10-02"), material: { materialCode: "MAT-1", name: "伞布" }, unit: { name: "米" } },
    ] },
    rawMaterialMovement: { findMany: async () => [{ movementNo: "RM-1", documentType: "issue", status: "posted", businessDate: new Date("2026-10-03"), reason: "自由原因", remark: "内部备注", attachment: [{ url: "secret" }], lines: [{ quantity: decimal("5"), material: { materialCode: "MAT-1", name: "伞布", referenceUnitPrice: "9" }, unit: { name: "米" } }] }] },
    finishedGoodsQcRecord: { findMany: async () => [{ qcNo: "FGQC-1", conclusion: "qualified", status: "active", inspectedQuantity: decimal("10"), qualifiedQuantity: decimal("8"), conditionalAcceptQuantity: decimal("1"), rejectedQuantity: decimal("1"), inspectionDate: new Date("2026-10-04"), rejectionReason: "自由原因", remark: "内部备注" }] },
    finishedGoodsInboundNotice: { findMany: async () => [{ noticeNo: "FGN-1", status: "pending", noticeQuantity: decimal("8"), noticeDate: new Date("2026-10-05"), batchNo: "B-1", remark: "内部备注" }] },
    finishedGoodsInbound: { findMany: async () => [{ inboundNo: "FGI-1", status: "posted", quantity: decimal("8"), createdAt: new Date("2026-10-06"), qcRecord: { qcNo: "FGQC-1", remark: "内部" }, remark: "内部备注" }] },
    finishedGoodsOutbound: { findMany: async () => [{ outboundNo: "FGO-1", status: "posted", quantity: decimal("6"), shipmentDate: new Date("2026-10-07"), createdAt: new Date("2026-10-07"), salesOrder: { unitPrice: "8", settlementUnitPrice: "7", receivableAmount: "48", currency: "CNY" }, outboundNotice: { noticeNo: "FGON-1", remark: "内部" }, attachment: [{ url: "secret" }], remark: "内部备注" }] },
  };
}

test("get_raw_material_balance：只给订单 BOM 物料的全局实存量，明确不是订单余额", async () => {
  const result = await getRawMaterialBalance(fakeClient(), ROOT);
  assert.deepEqual(result.data, [{ material_code: "MAT-1", material_name: "伞布", unit: "米", quantity: "10", scope: "全局实存量，非订单专属" }]);
});

test("get_inventory_facts：订单范围流水只给增减量和来源，不误称余额", async () => {
  const result = await getInventoryFacts(fakeClient(), ROOT, 1);
  assert.equal(result.data[0].quantity_delta, "12");
  assert.equal(result.data[0].source_type, "raw_material_inbound");
  assert.ok(!Object.keys(result.data[0]).includes("balance"));
});

test("get_material_movements：领退补报废单只投影单号/类型/状态/行数量/时间", async () => {
  const result = await getMaterialMovements(fakeClient(), ROOT, 1);
  assert.equal(result.data[0].movement_no, "RM-1");
  assert.equal(result.data[0].lines[0].quantity, "5");
  assert.doesNotMatch(JSON.stringify(result), /自由原因|内部备注|referenceUnitPrice|secret|price/i);
});

test("get_finished_goods_qc：只投影 QC 结论、状态、四类数量和日期", async () => {
  const result = await getFinishedGoodsQc(fakeClient(), ROOT, 1);
  assert.equal(result.data[0].qc_no, "FGQC-1");
  assert.equal(result.data[0].qualified_quantity, "8");
  assert.doesNotMatch(JSON.stringify(result), /自由原因|内部备注|remark/i);
});

test("get_finished_goods_inbounds：通知与实际入库以 chain 区分，草稿/过账状态保留", async () => {
  const result = await getFinishedGoodsInbounds(fakeClient(), ROOT, 1);
  assert.deepEqual(result.data.map((row) => row.chain).sort(), ["inbound", "notice"]);
  assert.equal(result.data.find((row) => row.chain === "notice").status, "pending");
  assert.equal(result.data.find((row) => row.chain === "inbound").status, "posted");
  assert.doesNotMatch(JSON.stringify(result), /内部备注|remark/i);
});

test("get_finished_goods_outbounds：重建窄 DTO，销售单价格/结算/应收及附件不出", async () => {
  const result = await getFinishedGoodsOutbounds(fakeClient(), ROOT, 1);
  assert.deepEqual(result.data[0], { outbound_no: "FGO-1", status: "posted", quantity: "6", shipment_date: new Date("2026-10-07"), created_at: new Date("2026-10-07"), outbound_notice_no: "FGON-1" });
  assert.doesNotMatch(JSON.stringify(result), /unitPrice|settlementUnitPrice|receivableAmount|currency|secret|内部备注|remark/i);
});

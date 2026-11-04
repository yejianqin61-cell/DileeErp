const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RawMaterialInboundsService } = require("../../dist/modules/procurement/raw-material-inbounds.service.js");

test("raw material inbound list exposes purchase and batch traceability", async () => {
  const service = new RawMaterialInboundsService({ rawMaterialInbound: { findMany: async () => [{ id: "inbound-1", purchaseOrder: { purchaseOrderNo: "PO-1" }, purchaseReceipt: { receiptNo: "GR-2", extensionData: { batch_sequence: 2 } }, incomingInspection: { extensionData: {}, status: "accepted" } }] } }, {}, {});
  const rows = await service.list();
  assert.deepEqual({ purchase_order_no: rows[0].purchase_order_no, receipt_no: rows[0].receipt_no, batch_sequence: rows[0].batch_sequence, inspection_status: rows[0].inspection_status }, { purchase_order_no: "PO-1", receipt_no: "GR-2", batch_sequence: 2, inspection_status: "accepted" });
});

/**
 * 2026-11-04「原料入库单双击看详情」：详情弹窗不再自己 join 物料/单位/供应商/质检单，
 * 由列表接口一次带齐（扁平字段，与已有的 purchase_order_no / receipt_no 同风格）。
 * 这条钉的是「接口真的把它们吐出来了」——少了哪个，两个页面的详情就会同时缺一格。
 */
test("raw material inbound list carries what the detail dialog shows", async () => {
  const service = new RawMaterialInboundsService({
    rawMaterialInbound: {
      findMany: async () => [{
        id: "inbound-1",
        purchaseOrder: { purchaseOrderNo: "PO-1" },
        purchaseReceipt: { receiptNo: "GR-2", extensionData: { batch_sequence: 2 } },
        incomingInspection: { orderNo: "QCS-1", inspectedQuantity: { toString: () => "9.0000" }, extensionData: {}, status: "accepted" },
        material: { materialCode: "M-001", name: "涤纶布", specificationModel: "150D", color: "本白" },
        unit: { name: "米" },
        supplier: { name: "苏州织造一厂", supplierCode: "S-001" },
      }]
    }
  }, {}, {});
  const [row] = await service.list();
  assert.deepEqual({
    material_code: row.material_code,
    material_name: row.material_name,
    material_specification: row.material_specification,
    material_color: row.material_color,
    unit_name: row.unit_name,
    supplier_name: row.supplier_name,
    inspection_no: row.inspection_no,
    inspected_quantity: row.inspected_quantity,
  }, {
    material_code: "M-001",
    material_name: "涤纶布",
    material_specification: "150D",
    material_color: "本白",
    unit_name: "米",
    supplier_name: "苏州织造一厂",
    inspection_no: "QCS-1",
    inspected_quantity: "9.0000",
  });
});

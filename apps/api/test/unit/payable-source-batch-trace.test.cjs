const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RawMaterialInboundsService } = require("../../dist/modules/procurement/raw-material-inbounds.service.js");
const { OutsourceLogisticsService } = require("../../dist/modules/production/outsource-logistics.service.js");

// 客户反馈：财务「原料入库应付来源」列表看不出是什么原料（只有批次号和金额）。
// 因此应付来源接口必须带出物料名称/编码/规格/颜色与单位名称。
test("pending payable sources expose purchase order and receipt batch sequence", async () => {
  const service = new RawMaterialInboundsService({ payableSource: { findMany: async () => [{ id: "source-1", purchaseOrder: { purchaseOrderNo: "PO-1" }, purchaseReceipt: { extensionData: { batch_sequence: 3 } } }] } }, {}, {});
  const rows = await service.payableSources();
  assert.equal(rows[0].purchase_order_no, "PO-1");
  assert.equal(rows[0].batch_sequence, 3);
});

test("原料应付来源带出物料名称/编码/规格/颜色与单位", async () => {
  const service = new RawMaterialInboundsService({
    payableSource: {
      findMany: async () => [{
        id: "source-1",
        purchaseOrder: { purchaseOrderNo: "PO-1" },
        purchaseReceipt: { extensionData: { batch_sequence: 1 } },
        purchaseOrderItem: { materialId: "material-1", unitId: "unit-1", material: { materialCode: "MAT-1", name: "伞布", specificationModel: "190T", color: "红色" }, unit: { name: "米" } },
      }],
    },
  }, {}, {});
  const rows = await service.payableSources();
  assert.equal(rows[0].material_name, "伞布");
  assert.equal(rows[0].material_code, "MAT-1");
  assert.equal(rows[0].material_specification, "190T");
  assert.equal(rows[0].material_color, "红色");
  assert.equal(rows[0].unit_name, "米");
});

test("物料主数据被软删除时用采购明细的快照兜底，不留空", async () => {
  const service = new RawMaterialInboundsService({
    payableSource: { findMany: async () => [{ id: "source-1", purchaseOrderItem: { materialId: "material-1", unitId: "unit-1", materialSnapshot: { name: "旧伞布" } } }] },
  }, {}, {});
  const rows = await service.payableSources();
  assert.equal(rows[0].material_name, "旧伞布");
  assert.equal(rows[0].material_code, null);
});

test("外加工应付来源同样带出物料名称与单位", async () => {
  const service = new OutsourceLogisticsService({
    outsourcePayableSource: {
      findMany: async () => [{ id: "source-2", logisticsBatch: { batchNo: "OB-1", material: { materialCode: "MAT-2", name: "伞骨", specificationModel: "8K", color: "银色" }, unit: { name: "支" } } }],
    },
  }, {}, {}, {});
  const rows = await service.payableSources();
  assert.equal(rows[0].material_name, "伞骨");
  assert.equal(rows[0].material_code, "MAT-2");
  assert.equal(rows[0].material_specification, "8K");
  assert.equal(rows[0].material_color, "银色");
  assert.equal(rows[0].unit_name, "支");
});

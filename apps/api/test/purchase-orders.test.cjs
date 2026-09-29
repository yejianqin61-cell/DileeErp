const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PurchaseOrdersService } = require("../dist/modules/procurement/purchase-orders.service.js");
const { NotFoundException, UnprocessableEntityException } = require("@nestjs/common");

test("purchase order accepts the editable BOM belonging to its confirmed sales order", async () => {
  const prisma = {
    salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1" }) },
    bom: { findFirst: async () => ({ id: "bom-1", salesOrderId: "order-1", orderNo: "SO-1", version: 1, status: "draft" }) },
    supplier: { findMany: async () => [{ id: "supplier-1" }] },
    material: { findMany: async () => [{ id: "material-1" }] },
    unit: { findMany: async () => [{ id: "unit-1" }] },
    bomItem: { findMany: async () => [] },
  };
  const service = new PurchaseOrdersService(prisma, {});
  const refs = await service.refs({ order_no: "SO-1", bom_id: "bom-1", supplier_id: "supplier-1", purchase_date: new Date().toISOString(), currency: "USD", items: [{ material_id: "material-1", unit_id: "unit-1", supplier_id: "supplier-1", quantity: "1", unit_price: "0", extension_data: { outside_bom_reason: "临时替代料" } }] });
  assert.equal(refs.bom.id, "bom-1");
  assert.equal(refs.order.id, "order-1");
});

test("purchase order requires a reason for material outside the BOM", async () => {
  const prisma = {
    salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1" }) },
    bom: { findFirst: async () => ({ id: "bom-1", salesOrderId: "order-1", orderNo: "SO-1", version: 1 }) },
    supplier: { findMany: async () => [{ id: "supplier-1" }] },
    material: { findMany: async () => [{ id: "material-1" }] },
    unit: { findMany: async () => [{ id: "unit-1" }] },
    bomItem: { findMany: async () => [] },
  };
  const service = new PurchaseOrdersService(prisma, {});
  await assert.rejects(() => service.refs({ order_no: "SO-1", bom_id: "bom-1", supplier_id: "supplier-1", purchase_date: new Date().toISOString(), currency: "CNY", items: [{ material_id: "material-1", unit_id: "unit-1", supplier_id: "supplier-1", quantity: "1", unit_price: "1" }] }), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_OUTSIDE_BOM_REASON_REQUIRED");
});

test("purchase order rejects a BOM item belonging to another BOM", async () => {
  const prisma = {
    salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1" }) },
    bom: { findFirst: async () => ({ id: "bom-1", salesOrderId: "order-1", orderNo: "SO-1", version: 1 }) },
    supplier: { findMany: async () => [{ id: "supplier-1" }] },
    material: { findMany: async () => [{ id: "material-1" }] },
    unit: { findMany: async () => [{ id: "unit-1" }] },
    bomItem: { findMany: async () => [] },
  };
  const service = new PurchaseOrdersService(prisma, {});
  await assert.rejects(() => service.refs({ order_no: "SO-1", bom_id: "bom-1", supplier_id: "supplier-1", purchase_date: new Date().toISOString(), currency: "CNY", items: [{ material_id: "material-1", bom_item_id: "other-item", unit_id: "unit-1", supplier_id: "supplier-1", quantity: "1", unit_price: "1" }] }), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_BOM_ITEM_MISMATCH");
});

test("purchase order rejects finished products even with an outside-BOM reason", async () => {
  const prisma = {
    salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1" }) },
    bom: { findFirst: async () => ({ id: "bom-1", salesOrderId: "order-1", orderNo: "SO-1", version: 1 }) },
    supplier: { findMany: async () => [{ id: "supplier-1" }] },
    material: { findMany: async ({ where }) => (where.materialType === "raw_material" ? [] : [{ id: "product-1", materialType: "finished_product" }]) },
    unit: { findMany: async () => [{ id: "unit-1" }] },
    bomItem: { findMany: async () => [] },
  };
  const service = new PurchaseOrdersService(prisma, {});
  await assert.rejects(
    () => service.refs({ order_no: "SO-1", bom_id: "bom-1", supplier_id: "supplier-1", purchase_date: new Date().toISOString(), currency: "CNY", items: [{ material_id: "product-1", unit_id: "unit-1", supplier_id: "supplier-1", quantity: "1", unit_price: "1", extension_data: { outside_bom_reason: "测试" } }] }),
    (error) => error instanceof NotFoundException,
  );
});

// 2026-09-27（口径 7）：采购单**明细**的编辑已经关闭。
//
// 2026-09-17 曾经允许「已下单未到货的单直接改明细，填个原因就行」，现在不给了：
// 数量/单价/供应商的唯一编辑点是**采购计划**，否则同一批货会有两份数字，
// 而「这张 BOM 还差什么没买」立刻失真。要改一张已下单的单，走「退回采购计划」。
//
// 这个端点的行为（包括"已经有到货事实的单也一样只认打印字段"）现在钉在
// `apps/api/test/unit/purchase-order-detail-readonly.test.cjs`；
// 「已有到货事实不能退回采购计划」钉在 `apps/api/test/unit/purchase-plans-service.test.cjs`。
// 本文件不再重复这两条，只保留下面这条**仍然存在**的写入路径：按供应商收束。

test("completed receipt totals remain closable until arrival closure is recorded", async () => {
  const rows = [
    { id: "open", status: "arrived_complete", extensionData: { over_order: true } },
    { id: "closed", status: "arrived_complete", extensionData: { arrival_closed: true } },
  ];
  const service = new PurchaseOrdersService({ purchaseOrder: { findMany: async () => rows } }, {});
  const result = await service.list();
  assert.equal(result.find((row) => row.id === "open").status, "partially_arrived");
  assert.equal(result.find((row) => row.id === "closed").status, "arrived_complete");
});

test("closed arrival batches reject correction and cancellation", async () => {
  const service = new PurchaseOrdersService({ purchaseReceipt: { findFirst: async () => ({ purchaseOrder: { extensionData: { arrival_closed: true } } }) } }, {});
  await assert.rejects(() => service.updateReceiptV2("receipt-1", { quantity: "1", reason: "修正" }, {}), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_ARRIVALS_CLOSED");
  await assert.rejects(() => service.cancelReceiptV2("receipt-1", "撤销", {}), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_ARRIVALS_CLOSED");
});

test("receipt correction rechecks arrival closure after locking the purchase order", async () => {
  const tx = {
    $queryRaw: async () => [],
    purchaseReceipt: {
      findFirst: async () => ({
        id: "receipt-1",
        purchaseOrderId: "purchase-1",
        orderNo: "SO-1",
        extensionData: {},
        purchaseOrderItemId: "item-1",
        purchaseOrderItem: { quantity: new (require("@prisma/client").Prisma.Decimal)("10"), unitPrice: new (require("@prisma/client").Prisma.Decimal)("2") },
        inspections: [],
        rawMaterialInbounds: [],
        payableSources: [],
      }),
    },
    purchaseOrder: { findFirst: async () => ({ extensionData: { arrival_closed: true } }) },
  };
  const service = new PurchaseOrdersService({ $transaction: async (fn) => fn(tx) }, { record: async () => {} });
  await assert.rejects(
    () => service.updateReceipt("receipt-1", { quantity: "1", reason: "修正" }, {}),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_ARRIVALS_CLOSED",
  );
});

test("receipt update rejects every downstream fact that would make correction unsafe", async () => {
  const cases = [
    { name: "positive inspection", inspections: [{ inspectedQuantity: new (require("@prisma/client").Prisma.Decimal)("1") }], rawMaterialInbounds: [], payableSources: [] },
    { name: "raw material inbound", inspections: [], rawMaterialInbounds: [{ id: "inbound-1" }], payableSources: [] },
    { name: "posted payable", inspections: [], rawMaterialInbounds: [], payableSources: [{ status: "posted" }] },
  ];
  for (const scenario of cases) {
    const tx = {
      $queryRaw: async () => [],
      purchaseReceipt: { findFirst: async () => ({ id: "receipt-1", purchaseOrderId: "purchase-1", orderNo: "SO-1", purchaseOrderItemId: "item-1", purchaseOrderItem: { quantity: new (require("@prisma/client").Prisma.Decimal)("10"), unitPrice: new (require("@prisma/client").Prisma.Decimal)("2") }, inspections: scenario.inspections, rawMaterialInbounds: scenario.rawMaterialInbounds, payableSources: scenario.payableSources }) },
      purchaseOrder: { findFirst: async () => ({ extensionData: {} }) },
    };
    // Keep the mock intentionally minimal: the guard must run before any write.
    tx.purchaseReceipt.findFirst = async () => ({ id: "receipt-1", purchaseOrderId: "purchase-1", orderNo: "SO-1", purchaseOrderItemId: "item-1", purchaseOrderItem: { quantity: new (require("@prisma/client").Prisma.Decimal)("10"), unitPrice: new (require("@prisma/client").Prisma.Decimal)("2") }, inspections: scenario.inspections, rawMaterialInbounds: scenario.rawMaterialInbounds, payableSources: scenario.payableSources });
    const service = new PurchaseOrdersService({ $transaction: async (fn) => fn(tx) }, { record: async () => {} });
    await assert.rejects(() => service.updateReceipt("receipt-1", { quantity: "2", reason: `修正-${scenario.name}` }, {}), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "RECEIPT_DOWNSTREAM_EXISTS");
  }
});

test("receipt cancellation rejects downstream facts instead of soft-deleting the batch", async () => {
  let writes = 0;
  const tx = {
    $queryRaw: async () => [],
    purchaseReceipt: { findFirst: async () => ({ id: "receipt-1", purchaseOrderId: "purchase-1", purchaseOrder: {}, inspections: [], rawMaterialInbounds: [{ id: "inbound-1" }], payableSources: [] }), update: async () => { writes += 1; } },
    purchaseOrder: { findFirst: async () => ({ extensionData: {} }) },
  };
  const service = new PurchaseOrdersService({ $transaction: async (fn) => fn(tx) }, { record: async () => {} });
  await assert.rejects(() => service.cancelReceipt("receipt-1", "撤销", {}), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "RECEIPT_DOWNSTREAM_EXISTS");
  assert.equal(writes, 0);
});

test("arrival rollback rejects inspection, inbound, and posted payable downstream facts", async () => {
  const downstreamCases = [
    { name: "inspection", inspections: [{ inspectedQuantity: new (require("@prisma/client").Prisma.Decimal)("1") }], rawMaterialInbounds: [], payableSources: [] },
    { name: "inbound", inspections: [], rawMaterialInbounds: [{ id: "inbound-1" }], payableSources: [] },
    { name: "posted payable", inspections: [], rawMaterialInbounds: [], payableSources: [{ status: "posted" }] },
  ];
  for (const scenario of downstreamCases) {
    const tx = {
      $queryRaw: async () => [],
      purchaseOrder: {
        findFirst: async () => ({ id: "purchase-1", status: "arrived_complete", extensionData: {}, items: [{ receipts: [{ inspections: scenario.inspections, rawMaterialInbounds: scenario.rawMaterialInbounds, payableSources: scenario.payableSources }] }] }),
      },
    };
    const service = new PurchaseOrdersService({ $transaction: async (fn) => fn(tx) }, { record: async () => {} });
    await assert.rejects(() => service.revertArrivals("purchase-1", `回退-${scenario.name}`, {}), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_ARRIVAL_DOWNSTREAM_EXISTS");
  }
});

test("arrived-complete orders accept another receipt before close", async () => {
  const created = { id: "receipt-2", quantity: new (require("@prisma/client").Prisma.Decimal)("2"), extensionData: {} };
  const tx = {
    $queryRaw: async () => [],
    purchaseOrder: { findFirst: async () => ({ id: "purchase-1", orderNo: "SO-1", status: "arrived_complete", extensionData: {}, supplierId: "supplier-1", currency: "CNY", items: [{ id: "item-1", quantity: new (require("@prisma/client").Prisma.Decimal)("10"), unitPrice: new (require("@prisma/client").Prisma.Decimal)("2"), material: { materialType: "raw_material" }, receipts: [{ id: "receipt-1", quantity: new (require("@prisma/client").Prisma.Decimal)("10"), extensionData: {} }] }] }), update: async ({ data }) => ({ id: "purchase-1", orderNo: "SO-1", extensionData: data.extensionData }) },
    purchaseReceipt: { create: async () => created },
    incomingInspection: { create: async () => ({ id: "inspection-2" }) },
    payableSource: { create: async () => ({ id: "payable-2" }) },
    purchaseOrderItem: { findMany: async () => [] },
  };
  tx.purchaseOrderItem.findMany = async () => [{ quantity: new (require("@prisma/client").Prisma.Decimal)("10"), receipts: [{ quantity: new (require("@prisma/client").Prisma.Decimal)("10") }, { quantity: new (require("@prisma/client").Prisma.Decimal)("2") }] }];
  const audit = { create: () => ({}), update: () => ({}), record: async () => undefined };
  const service = new PurchaseOrdersService({ $transaction: async (fn) => fn(tx) }, audit);
  const result = await service.receiptV2("purchase-1", "item-1", { quantity: "2", received_date: "2026-09-03", over_receipt_reason: "追加到货" }, { id: "user-1" });
  assert.equal(result.id, "receipt-2");
});

const refsPrisma = (suppliers) => ({
  salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "SO-1" }) },
  bom: { findFirst: async () => ({ id: "bom-1", salesOrderId: "order-1", orderNo: "SO-1", version: 1 }) },
  // 假 Prisma **真的按 `select` 投影**：`refs()` 的供应商那一行是原样写进 `supplier_snapshot` 的，
  // 所以"给它加个 select: {id, name}"这种改动必须能被断言抓到 —— 恒返回整行的桩会让
  // 「地址/联系人要冻住」那条用例永远通过。
  supplier: { findMany: async ({ select } = {}) => suppliers.map((row) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : row)) },
  material: { findMany: async () => [{ id: "material-1" }, { id: "material-2" }] },
  unit: { findMany: async () => [{ id: "unit-1" }, { id: "unit-2" }] },
  bomItem: { findMany: async () => [{ id: "bomItem-1", materialId: "material-1" }] },
});

// 2026-09-17：明细行的供应商变成可空（草稿要能存下刚导入、还没定供应商的 BOM 明细），
// 「每行必须有供应商」从 refs() 挪到了**下单门禁** assertOrderableItems。
test("refs accepts items without a supplier so an unfinished draft can be saved", async () => {
  const service = new PurchaseOrdersService(refsPrisma([{ id: "supplier-1" }]), {});
  const refs = await service.refs({ order_no: "SO-1", bom_id: "bom-1", purchase_date: new Date().toISOString(), currency: "CNY", items: [{ material_id: "material-1", unit_id: "unit-1", bom_item_id: "bomItem-1", quantity: "1", unit_price: "1" }] });
  assert.equal(refs.supplier, undefined, "整单还没有供应商");
  assert.equal(refs.items[0].supplier_id, undefined);
});

test("ordering still requires a supplier on every item", async () => {
  const service = new PurchaseOrdersService({}, {});
  // assertOrderableItems 是**同步**抛错，所以用 assert.throws 而不是 assert.rejects
  // （rejects 收到同步异常会把它当成断言自身出错，验证函数根本不会被调用）。
  assert.throws(
    () => service.assertOrderableItems("bom-1", [{ materialId: "material-1", unitId: "unit-1", supplierId: "", quantity: "1", unitPrice: "1" }]),
    (error) => error instanceof UnprocessableEntityException
      && error.getResponse().code === "PURCHASE_ORDER_INCOMPLETE"
      && error.getResponse().details.some((detail) => detail.code === "ITEM_INCOMPLETE" && detail.message.includes("供应商")),
  );
});

// 用户 2026-09-17：「一个采购单内，一个供应商下一个单」。
// 这条以前只靠界面保证（界面走 /split，一组一个供应商），现在写进 refs()，
// 因为头部供应商/币种/金额一旦混了，到货、应付、对账都失去单一口径。
test("a purchase order may hold items from at most one supplier", async () => {
  const service = new PurchaseOrdersService(refsPrisma([{ id: "supplier-2" }, { id: "supplier-3" }]), {});
  await assert.rejects(
    () => service.refs({
      order_no: "SO-1", bom_id: "bom-1", purchase_date: new Date().toISOString(), currency: "USD",
      items: [
        { material_id: "material-1", unit_id: "unit-1", bom_item_id: "bomItem-1", supplier_id: "supplier-2", quantity: "1", unit_price: "2" },
        { material_id: "material-2", unit_id: "unit-2", supplier_id: "supplier-3", quantity: "1", unit_price: "2", extension_data: { outside_bom_reason: "临时新增" } },
      ],
    }),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_ORDER_MULTIPLE_SUPPLIERS",
  );
});

test("the header supplier counts towards the one-supplier rule", async () => {
  const service = new PurchaseOrdersService(refsPrisma([{ id: "supplier-2" }, { id: "supplier-3" }]), {});
  await assert.rejects(
    () => service.refs({
      order_no: "SO-1", bom_id: "bom-1", supplier_id: "supplier-2", purchase_date: new Date().toISOString(), currency: "USD",
      items: [{ material_id: "material-1", unit_id: "unit-1", bom_item_id: "bomItem-1", supplier_id: "supplier-3", quantity: "1", unit_price: "2" }],
    }),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "PURCHASE_ORDER_MULTIPLE_SUPPLIERS",
  );
});

test("purchase order rejects unknown or disabled item suppliers", async () => {
  const service = new PurchaseOrdersService(refsPrisma([]), {});
  await assert.rejects(
    () => service.refs({ order_no: "SO-1", bom_id: "bom-1", purchase_date: new Date().toISOString(), currency: "CNY", items: [{ material_id: "material-1", unit_id: "unit-1", supplier_id: "supplier-missing", quantity: "1", unit_price: "1", extension_data: { outside_bom_reason: "临时" } }] }),
    (error) => error instanceof NotFoundException && error.getResponse().code === "SUPPLIER_NOT_FOUND",
  );
});

test("refs resolves the item supplier and keeps an order-level snapshot compatible", async () => {
  const service = new PurchaseOrdersService(refsPrisma([{ id: "supplier-2", name: "乙供应商" }]), {});
  const refs = await service.refs({
    order_no: "SO-1", bom_id: "bom-1", purchase_date: new Date().toISOString(), currency: "USD",
    items: [
      { material_id: "material-1", unit_id: "unit-1", bom_item_id: "bomItem-1", supplier_id: "supplier-2", expected_date: "2026-09-10", quantity: "1", unit_price: "2" },
      { material_id: "material-2", unit_id: "unit-2", supplier_id: "supplier-2", expected_date: "2026-09-12", quantity: "1", unit_price: "2", extension_data: { outside_bom_reason: "临时新增" } },
    ],
  });
  assert.equal(refs.supplier.id, "supplier-2");
  assert.equal(refs.supplierMap.get("supplier-2").name, "乙供应商");
  assert.equal(refs.supplierMap.size, 1);
});

test("create writes the item supplier snapshot and derives the order-level supplier and expected date", async () => {
  let captured = null;
  const created = { id: "purchase-1", orderNo: "SO-1", status: "draft", items: [], extensionData: {} };
  const tx = { purchaseOrder: { create: async ({ data }) => { captured = data; return created; } } };
  const prisma = { ...refsPrisma([{ id: "supplier-2", name: "乙供应商" }]), $transaction: async (fn) => fn(tx), purchaseOrder: { findFirst: async () => created } };
  const audit = { create: () => ({}), update: () => ({}), record: async () => {} };
  const service = new PurchaseOrdersService(prisma, audit);
  await service.create({
    order_no: "SO-1", bom_id: "bom-1", purchase_date: "2026-09-08", currency: "USD",
    items: [
      { material_id: "material-1", unit_id: "unit-1", bom_item_id: "bomItem-1", supplier_id: "supplier-2", expected_date: "2026-09-10", quantity: "2", unit_price: "3" },
      { material_id: "material-2", unit_id: "unit-2", supplier_id: "supplier-2", expected_date: "2026-09-12", quantity: "1", unit_price: "2", extension_data: { outside_bom_reason: "临时新增" } },
    ],
  }, { id: "user-1" });
  assert.equal(captured.supplierId, "supplier-2");
  assert.equal(captured.supplierSnapshot.name, "乙供应商");
  assert.equal(captured.expectedDate.getTime(), new Date("2026-09-12").getTime());
  assert.equal(captured.items.create[0].supplierId, "supplier-2");
  assert.equal(captured.items.create[0].supplierSnapshot.name, "乙供应商");
  assert.equal(captured.items.create[0].expectedDate.getTime(), new Date("2026-09-10").getTime());
  assert.equal(captured.items.create[1].supplierId, "supplier-2");
  assert.equal(captured.items.create[1].expectedDate.getTime(), new Date("2026-09-12").getTime());
});

test("下单时把供应商的**地址与联系人**一起冻进快照（改档案不影响已发出的单）", async () => {
  // 口径 4：地址/联系人是主数据的事实，但在下单那一刻要**冻结**在采购单上——
  // 供应商以后搬了厂、换了业务员，去年的单上仍要看得见当时那一句。
  //
  // 这条是**回归**：`refs()` 里那句 `supplier.findMany` 一旦被"优化"成
  // `select: { id, name }`，快照就会悄悄少掉这三格，而且不会有任何报错。
  let captured = null;
  const created = { id: "purchase-1", orderNo: "SO-1", status: "ordered", items: [], extensionData: {} };
  const tx = { purchaseOrder: { create: async ({ data }) => { captured = data; return created; } } };
  const supplierRow = { id: "supplier-1", supplierCode: "SUP-001", name: "五金厂", contactName: "张伟", phone: "13800000000", address: "浙江省金华市婺城区某路 1 号" };
  const prisma = { ...refsPrisma([supplierRow]), $transaction: async (fn) => fn(tx), purchaseOrder: { findFirst: async () => created } };
  const service = new PurchaseOrdersService(prisma, { create: () => ({}), update: () => ({}), record: async () => {} });

  await service.create({
    order_no: "SO-1", bom_id: "bom-1", purchase_date: "2026-09-28", currency: "CNY",
    items: [{ material_id: "material-1", unit_id: "unit-1", bom_item_id: "bomItem-1", supplier_id: "supplier-1", quantity: "2", unit_price: "3" }],
  }, { id: "user-1" });

  for (const snapshot of [captured.supplierSnapshot, captured.items.create[0].supplierSnapshot]) {
    assert.equal(snapshot.supplierCode, "SUP-001");
    assert.equal(snapshot.contactName, "张伟", "联系人要冻住");
    assert.equal(snapshot.phone, "13800000000");
    assert.equal(snapshot.address, "浙江省金华市婺城区某路 1 号", "地址要冻住");
  }
});

test("a draft created without any supplier keeps the item supplier empty", async () => {
  let captured = null;
  const created = { id: "purchase-1", orderNo: "SO-1", status: "draft", items: [], extensionData: {} };
  const tx = { purchaseOrder: { create: async ({ data }) => { captured = data; return created; } } };
  const prisma = { ...refsPrisma([]), $transaction: async (fn) => fn(tx), purchaseOrder: { findFirst: async () => created } };
  const audit = { create: () => ({}), update: () => ({}), record: async () => {} };
  const service = new PurchaseOrdersService(prisma, audit);
  await service.create({
    order_no: "SO-1", bom_id: "bom-1", currency: "CNY",
    items: [{ material_id: "material-1", unit_id: "unit-1", bom_item_id: "bomItem-1", quantity: "2", unit_price: "3" }],
  }, { id: "user-1" });
  assert.equal(captured.supplierId, null, "整单还没有供应商");
  assert.equal(captured.items.create[0].supplierId, null, "明细行也没有供应商");
  assert.equal(captured.items.create[0].supplierSnapshot, undefined);
});

test("按供应商收束（splitExisting）把明细的供应商写进去，并保持整单供应商同步", async () => {
  let createManyData = null;
  let orderUpdateData = null;
  const row = { id: "purchase-1", purchaseOrderNo: "PO-1", status: "draft", orderNo: "SO-1", items: [], extensionData: {} };
  const tx = {
    purchaseOrderItem: { updateMany: async () => {}, createMany: async ({ data }) => { createManyData = data; } },
    purchaseOrder: { update: async ({ data }) => { orderUpdateData = data; return row; } },
  };
  const prisma = { ...refsPrisma([{ id: "supplier-1", name: "甲供应商" }]), $transaction: async (fn) => fn(tx), purchaseOrder: { findFirst: async () => row } };
  const audit = { create: () => ({}), update: () => ({}), record: async () => {} };
  const service = new PurchaseOrdersService(prisma, audit);
  await service.splitExisting("purchase-1", {
    order_no: "SO-1", bom_id: "bom-1", purchase_date: "2026-09-08",
    groups: [{ supplier_id: "supplier-1", currency: "USD", expected_date: "2026-09-15", items: [{ material_id: "material-1", unit_id: "unit-1", bom_item_id: "bomItem-1", expected_date: "2026-09-15", quantity: "2", unit_price: "3" }] }],
  }, { id: "user-1" });
  assert.equal(createManyData[0].supplierId, "supplier-1");
  assert.equal(createManyData[0].supplierSnapshot.name, "甲供应商");
  assert.equal(createManyData[0].expectedDate.getTime(), new Date("2026-09-15").getTime());
  assert.equal(orderUpdateData.supplierId, "supplier-1");
  assert.equal(orderUpdateData.supplierSnapshot.name, "甲供应商");
  assert.equal(orderUpdateData.expectedDate.getTime(), new Date("2026-09-15").getTime());
});

test("order expected date falls back to the latest item date when the order does not send one", async () => {
  const service = new PurchaseOrdersService({}, {});
  const derived = service.orderExpectedDate({ order_no: "SO-1", bom_id: "bom-1", purchase_date: "2026-09-08", currency: "USD", items: [
    { material_id: "material-1", unit_id: "unit-1", supplier_id: "supplier-1", expected_date: "2026-09-18", quantity: "1", unit_price: "1" },
    { material_id: "material-2", unit_id: "unit-2", supplier_id: "supplier-2", expected_date: "2026-09-14", quantity: "1", unit_price: "1" },
  ] });
  assert.equal(derived.getTime(), new Date("2026-09-18").getTime());
  assert.equal(service.orderExpectedDate({ order_no: "SO-1", bom_id: "bom-1", purchase_date: "2026-09-08", currency: "USD", items: [{ material_id: "material-1", unit_id: "unit-1", supplier_id: "supplier-1", quantity: "1", unit_price: "1" }] }), undefined);
});

// ---- 草稿（编辑一半先保存）----
const draftRow = (overrides = {}) => ({
  id: "purchase-1", purchaseOrderNo: "PO-1", status: "draft", orderNo: "SO-1",
  bomId: null, supplierId: null, purchaseDate: null, currency: null,
  expectedDate: null, extensionData: {}, remark: null, items: [], supplier: null, bom: null,
  ...overrides,
});
const fullItem = (overrides = {}) => ({
  id: "item-1", materialId: "material-1", unitId: "unit-1", supplierId: "supplier-1",
  quantity: new (require("@prisma/client").Prisma.Decimal)("2"),
  unitPrice: new (require("@prisma/client").Prisma.Decimal)("3"),
  receipts: [], ...overrides,
});

test("draft purchase order saves with only a sales order and no BOM or items", async () => {
  let captured = null;
  const tx = { purchaseOrder: { create: async ({ data }) => { captured = data; return { id: "purchase-1", orderNo: "SO-1" }; } } };
  const prisma = { ...refsPrisma([]), $transaction: async (fn) => fn(tx), purchaseOrder: { findFirst: async () => draftRow() } };
  const service = new PurchaseOrdersService(prisma, { create: () => ({}), record: async () => {} });
  await service.create({ order_no: "SO-1" }, { id: "user-1" });
  assert.equal(captured.bomId, null);
  assert.equal(captured.bomVersion, null);
  assert.equal(captured.supplierId, null);
  assert.equal(captured.currency, "CNY");
  assert.equal(captured.totalAmount, "0.0000");
  assert.deepEqual(captured.items.create, []);
  assert.ok(captured.purchaseDate instanceof Date);
});

test("draft items without a BOM skip the outside-BOM reason rule", async () => {
  let captured = null;
  const tx = { purchaseOrder: { create: async ({ data }) => { captured = data; return { id: "purchase-1", orderNo: "SO-1" }; } } };
  const prisma = { ...refsPrisma([{ id: "supplier-1", name: "supplier" }]), $transaction: async (fn) => fn(tx), purchaseOrder: { findFirst: async () => draftRow() } };
  const service = new PurchaseOrdersService(prisma, { create: () => ({}), record: async () => {} });
  await service.create({
    order_no: "SO-1",
    items: [{ material_id: "material-1", unit_id: "unit-1", supplier_id: "supplier-1", quantity: "2", unit_price: "3" }],
  }, { id: "user-1" });
  assert.equal(captured.items.create.length, 1);
  assert.equal(captured.items.create[0].amount, "6.0000");
  assert.equal(captured.bomId, null);
});

test("incomplete draft cannot be ordered and lists what is missing", async () => {
  const prisma = { purchaseOrder: { findFirst: async () => draftRow({ items: [fullItem({ supplierId: null, quantity: new (require("@prisma/client").Prisma.Decimal)("0") })] }) } };
  const service = new PurchaseOrdersService(prisma, {});
  await assert.rejects(
    () => service.order("purchase-1", { id: "user-1" }),
    (error) => error.getResponse().code === "PURCHASE_ORDER_INCOMPLETE"
      && error.getResponse().details.some((detail) => detail.code === "BOM_REQUIRED")
      && error.getResponse().details.some((detail) => detail.code === "ITEM_INCOMPLETE"),
  );
});

test("complete draft can be ordered and fills head supplier from the first item", async () => {
  let updated = null;
  const prisma = {
    purchaseOrder: {
      findFirst: async () => draftRow({ bomId: "bom-1", items: [fullItem()] }),
      update: async ({ data }) => { updated = data; return { id: "purchase-1", status: data.status }; },
    },
  };
  const service = new PurchaseOrdersService(prisma, { update: () => ({}), record: async () => {} });
  await service.order("purchase-1", { id: "user-1" });
  assert.equal(updated.status, "ordered");
  assert.equal(updated.supplierId, "supplier-1");
  assert.equal(updated.currency, "CNY");
  assert.ok(updated.purchaseDate instanceof Date);
});

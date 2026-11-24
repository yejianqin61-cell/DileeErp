// 工单 T-0028：跨仓库调拨（源仓固定同安，目标仓大田/晋江，完成后双边库存联动，记录可追溯）。
//
// 这里钉住四件事：
//   1. 一张调拨单写两条库存事实：同安仓 −数量（warehouse_transfer_out）、目标仓 +数量（warehouse_transfer_in），
//      两者 sourceId 都指向同一条不可变审计单头；
//   2. 同安仓余量不足时整单拒绝，一条事实都不写（不允许负库存）；
//   3. 源仓不是同安、目标仓不是大田/晋江，在进入事务前就拒绝；
//   4. 三仓库存汇总能把到货仓库（purchase_receipts.extension_data）与调拨路由分别归仓。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { WarehouseTransferService } = require("../../dist/modules/warehouse/warehouse-transfer.service.js");

const user = { id: "00000000-0000-0000-0000-000000000001", username: "tester" };
const decimal = (value) => new Prisma.Decimal(value);
const MATERIAL = {
  id: "11111111-1111-1111-1111-111111111111",
  materialCode: "M-001",
  name: "涤纶布",
  specificationModel: "150D",
  defaultUnitId: "22222222-2222-2222-2222-222222222222",
  defaultUnit: { name: "米" },
};

function inboundFact(quantity, warehouseCode) {
  return {
    quantityDelta: decimal(quantity),
    sourceType: "raw_material_inbound",
    sourceVersion: null,
    rawMaterialInbound: { purchaseReceipt: { extensionData: { warehouse_code: warehouseCode } } },
  };
}

function transferFact(quantity, sourceType, route) {
  return { quantityDelta: decimal(quantity), sourceType, sourceVersion: route, rawMaterialInbound: null };
}

/** 最小 Prisma 事务替身：只实现本服务用到的调用。 */
function transactionFor({ facts = [], materials = [MATERIAL], todayRows = [], existing = null } = {}) {
  const writes = { events: [], facts: [] };
  const tx = {
    $queryRawUnsafe: async () => [],
    auditEvent: {
      findFirst: async () => existing,
      findMany: async () => todayRows,
      create: async ({ data }) => { writes.events.push(data); return { id: "event-1", createdAt: new Date("2026-11-24T02:00:00.000Z"), ...data }; },
    },
    material: { findMany: async () => materials },
    inventoryFact: {
      findMany: async () => facts,
      create: async ({ data }) => { writes.facts.push(data); return data; },
    },
  };
  return { tx, writes };
}

function serviceWith(tx, root = {}) {
  return new WarehouseTransferService({ $transaction: async (fn) => fn(tx), ...root });
}

test("调拨到晋江仓：写两条库存事实，同安减、晋江加，单头记录源仓/目标仓/用途/明细", async () => {
  const { tx, writes } = transactionFor({ facts: [inboundFact("10", "tongan")] });
  const service = serviceWith(tx);

  const result = await service.create({
    source_warehouse: "tongan",
    target_warehouse: "jinjiang",
    purpose: "target_production",
    remark: "大田车间补料",
    idempotency_key: "web-transfer-1",
    lines: [{ material_id: MATERIAL.id, quantity: "2.5" }],
  }, user);

  assert.equal(result.transfer_no.startsWith("DB-"), true);
  assert.equal(result.source_warehouse, "tongan");
  assert.equal(result.source_warehouse_name, "同安仓");
  assert.equal(result.target_warehouse, "jinjiang");
  assert.equal(result.target_warehouse_name, "晋江仓");
  assert.equal(result.purpose_label, "供目标仓库生产使用");
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].quantity, "2.5");

  assert.equal(writes.events.length, 1);
  const header = writes.events[0];
  assert.equal(header.entityType, "warehouse_transfer");
  assert.equal(header.action, "warehouse_transfer.posted");
  assert.equal(header.details.target_warehouse, "jinjiang");
  assert.equal(header.details.target_warehouse_name, "晋江仓");
  assert.equal(header.details.purpose, "target_production");
  assert.equal(header.details.idempotency_key, "web-transfer-1");
  assert.equal(header.details.lines[0].material_code, "M-001");

  assert.equal(writes.facts.length, 2);
  const [outFact, inFact] = writes.facts;
  assert.equal(outFact.sourceType, "warehouse_transfer_out");
  assert.equal(outFact.quantityDelta.toString(), "-2.5");
  assert.equal(outFact.sourceVersion, "tongan>jinjiang");
  assert.equal(outFact.sourceId, header.entityId);
  assert.equal(outFact.unitId, MATERIAL.defaultUnitId);
  assert.equal(inFact.sourceType, "warehouse_transfer_in");
  assert.equal(inFact.quantityDelta.toString(), "2.5");
  assert.equal(inFact.sourceVersion, "tongan>jinjiang");
  assert.equal(inFact.sourceId, header.entityId);
});

test("同安仓余量不足：整单 422，一条单头/库存事实都不写", async () => {
  const { tx, writes } = transactionFor({ facts: [inboundFact("1", "tongan")] });
  const service = serviceWith(tx);

  await assert.rejects(
    () => service.create({ target_warehouse: "daitan", lines: [{ material_id: MATERIAL.id, quantity: "2" }] }, user),
    (error) => error.getResponse().code === "TRANSFER_SOURCE_STOCK_INSUFFICIENT",
  );
  assert.equal(writes.events.length, 0);
  assert.equal(writes.facts.length, 0);
});

test("源仓/目标仓白名单：源仓不是同安、目标仓是同安或未知编码都在事务前拒绝", async () => {
  const { tx, writes } = transactionFor();
  let transactions = 0;
  const service = new WarehouseTransferService({
    $transaction: async (fn) => { transactions += 1; return fn(tx); },
  });

  await assert.rejects(
    () => service.create({ source_warehouse: "daitan", target_warehouse: "daitan", lines: [{ material_id: MATERIAL.id, quantity: "1" }] }, user),
    (error) => error.getResponse().code === "INVALID_TRANSFER_SOURCE",
  );
  await assert.rejects(
    () => service.create({ target_warehouse: "tongan", lines: [{ material_id: MATERIAL.id, quantity: "1" }] }, user),
    (error) => error.getResponse().code === "INVALID_TRANSFER_TARGET",
  );
  assert.equal(transactions, 0);
  assert.equal(writes.facts.length, 0);
});

test("同一物料重复行与非法数量在事务前拒绝", async () => {
  const { tx, writes } = transactionFor();
  const service = serviceWith(tx);

  await assert.rejects(
    () => service.create({ target_warehouse: "daitan", lines: [{ material_id: MATERIAL.id, quantity: "1" }, { material_id: MATERIAL.id, quantity: "2" }] }, user),
    (error) => error.getResponse().code === "TRANSFER_MATERIAL_DUPLICATED",
  );
  await assert.rejects(
    () => service.create({ target_warehouse: "daitan", lines: [{ material_id: MATERIAL.id, quantity: "0" }] }, user),
    (error) => error.getResponse().code === "INVALID_TRANSFER_QUANTITY",
  );
  assert.equal(writes.facts.length, 0);
});

test("调拨记录列表：从不可变审计单头解析并补操作人姓名", async () => {
  const row = {
    id: "event-1",
    entityId: "33333333-3333-3333-3333-333333333333",
    actorId: "44444444-4444-4444-4444-444444444444",
    createdAt: new Date("2026-11-24T03:04:05.000Z"),
    details: {
      transfer_no: "DB-20261124-0001",
      source_warehouse: "tongan",
      source_warehouse_name: "同安仓",
      target_warehouse: "daitan",
      target_warehouse_name: "大田仓",
      purpose: "target_production",
      purpose_label: "供目标仓库生产使用",
      status: "posted",
      remark: null,
      lines: [{ material_id: MATERIAL.id, material_code: "M-001", material_name: "涤纶布", unit_id: MATERIAL.defaultUnitId, unit_name: "米", quantity: "2" }],
    },
  };
  const service = new WarehouseTransferService({
    auditEvent: { findMany: async () => [row] },
    user: { findMany: async () => [{ id: row.actorId, displayName: "仓库小王" }] },
  });

  const data = await service.list({ targetWarehouse: "daitan" });
  assert.equal(data.length, 1);
  assert.equal(data[0].transfer_no, "DB-20261124-0001");
  assert.equal(data[0].target_warehouse_name, "大田仓");
  assert.equal(data[0].created_by_name, "仓库小王");
  assert.equal(data[0].line_count, 1);
});

test("三仓库存汇总：到货仓库按 extension_data 归属，调拨按 source_version 归属", async () => {
  const facts = [
    { ...inboundFact("10", "tongan") },
    { ...inboundFact("5", "daitan") },
    { ...transferFact("-2", "warehouse_transfer_out", "tongan>daitan") },
    { ...transferFact("2", "warehouse_transfer_in", "tongan>daitan") },
  ].map((fact) => ({
    ...fact,
    materialId: MATERIAL.id,
    unitId: MATERIAL.defaultUnitId,
    material: { materialCode: "M-001", name: "涤纶布", specificationModel: "150D" },
    unit: { name: "米" },
  }));
  const service = new WarehouseTransferService({ inventoryFact: { findMany: async () => facts } });

  const rows = await service.balances();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tongan, "8");
  assert.equal(rows[0].daitan, "7");
  assert.equal(rows[0].jinjiang, "0");
});

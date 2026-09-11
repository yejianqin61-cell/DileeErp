const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { RawMaterialMovementsService } = require("../dist/modules/production/raw-material-movements.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "operator", display_name: "操作员" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => {} };

// 领料单必须落到具体工序：订单号 - 生产单 - 工序 - 领料表。
function harness(operation) {
  const created = [];
  const prisma = {
    productionOrder: { findFirst: async () => ({ id: "order-1", orderNo: "DL260001", executionMode: "in_house", status: "in_progress" }) },
    productionOrderOperation: { findFirst: async () => operation },
    rawMaterialMovement: { create: async ({ data }) => { created.push(data); return { id: "movement-1", ...data }; } }
  };
  const service = new RawMaterialMovementsService(prisma, audit, {});
  service.previewLines = async () => ({ lines: [{ material_id: "material-1", unit_id: "unit-1", quantity: "2", bom_reference_quantity: "5", remark: undefined }] });
  return { service, created };
}

const activeOperation = { id: "operation-1", productionOrderId: "order-1", operationNameSnapshot: "裁剪", status: "active" };

test("新建领料单必须选择工序", async () => {
  const { service, created } = harness(activeOperation);
  await assert.rejects(
    () => service.createIssue({ production_order_id: "order-1", lines: [{ material_id: "material-1", quantity: "2" }] }, user),
    (error) => error.getResponse().code === "MATERIAL_ISSUE_OPERATION_REQUIRED"
  );
  assert.equal(created.length, 0, "缺工序时不得写入");
});

test("工序必须属于该生产单，且不能是已取消的工序", async () => {
  const foreign = harness(null);
  await assert.rejects(
    () => foreign.service.createIssue({ production_order_id: "order-1", production_order_operation_id: "operation-x", lines: [{ material_id: "material-1", quantity: "2" }] }, user),
    (error) => error.getResponse().code === "PRODUCTION_OPERATION_NOT_FOUND"
  );
  const cancelled = harness({ ...activeOperation, status: "cancelled" });
  await assert.rejects(
    () => cancelled.service.createIssue({ production_order_id: "order-1", production_order_operation_id: "operation-1", lines: [{ material_id: "material-1", quantity: "2" }] }, user),
    (error) => error.getResponse().code === "PRODUCTION_OPERATION_CANCELLED"
  );
  assert.equal(foreign.created.length + cancelled.created.length, 0);
});

test("带上有效工序后领料单写入工序归属", async () => {
  const { service, created } = harness(activeOperation);
  await service.createIssue({ production_order_id: "order-1", production_order_operation_id: "operation-1", lines: [{ material_id: "material-1", quantity: "2" }] }, user);
  assert.equal(created.length, 1);
  assert.equal(created[0].productionOrderOperationId, "operation-1");
  assert.equal(created[0].productionOrderId, "order-1");
  assert.match(created[0].movementNo, /^MI-/);
});

// 退料/报废继承来源领料单的工序，保证反向下游也能挂到层级上。
test("退料/报废继承来源领料单的工序", async () => {
  const created = [];
  const prisma = {
    productionOrder: { findFirst: async () => ({ id: "order-1", orderNo: "DL260001", executionMode: "in_house", status: "in_progress" }) },
    rawMaterialMovementLine: { findFirst: async () => ({ id: "line-1", movement: { productionOrderOperationId: "operation-1" } }) },
    rawMaterialMovement: { create: async ({ data }) => { created.push(data); return { id: "return-1", ...data }; } }
  };
  const service = new RawMaterialMovementsService(prisma, audit, {});
  service.derivedLines = async () => [{ materialId: "material-1", unitId: "unit-1", quantity: "1", bomReferenceQuantity: new Prisma.Decimal("5"), sourceIssueLineId: "line-1", remark: undefined }];
  await service.createReturn({ production_order_id: "order-1", lines: [{ source_issue_line_id: "line-1", quantity: "1" }] }, user);
  assert.equal(created.length, 1);
  assert.equal(created[0].productionOrderOperationId, "operation-1");
  assert.match(created[0].movementNo, /^MR-/);
});

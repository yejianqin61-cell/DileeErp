const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { SalesOrdersService } = require("../dist/modules/sales/sales-orders.service.js");
const { BomsService } = require("../dist/modules/sales/boms.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "sales", display_name: "销售测试" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => {} };

test("sales.order.confirm_preserves_order_identity_and_audit_fields", async () => {
  const order = { id: "order-1", orderNo: "TEST-SO-001", status: "draft", customerId: "customer-1", currentVersion: 1, extensionData: {}, orderDate: new Date(), productName: "雨伞", quantity: "10", unit: "个", currency: "USD", contactId: null, boms: [], versions: [] };
  let updateData;
  const prisma = { salesOrder: { findFirst: async () => order, update: async ({ data }) => { updateData = data; return { ...order, ...data }; } } };
  const service = new SalesOrdersService(prisma, audit);
  const result = await service.confirm(order.id, user);
  assert.equal(result.status, "confirmed");
  assert.equal(updateData.updatedBy, user.id);
});

test("sales.order.rejects_confirming_a_non_draft_order", async () => {
  const order = { id: "order-1", orderNo: "TEST-SO-001", status: "confirmed", customerId: "customer-1", currentVersion: 1, extensionData: {}, orderDate: new Date(), productName: "雨伞", quantity: "10", unit: "个", currency: "USD", contactId: null, boms: [], versions: [] };
  const service = new SalesOrdersService({ salesOrder: { findFirst: async () => order } }, audit);
  await assert.rejects(() => service.confirm(order.id, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INVALID_STATE_TRANSITION");
});

test("sales.order.list_uses_default_pagination_when_query_parameters_are_absent", async () => {
  let findManyArguments;
  const prisma = {
    salesOrder: {
      findMany: (arguments_) => { findManyArguments = arguments_; return Promise.resolve([]); },
      count: () => Promise.resolve(0),
    },
    $transaction: async (operations) => Promise.all(operations),
  };
  const service = new SalesOrdersService(prisma, audit);
  await service.list();
  assert.equal(findManyArguments.skip, 0);
  assert.equal(findManyArguments.take, 20);
});

test("sales.bom.created_from_confirmed_order_keeps_order_no_and_source_version", async () => {
  const order = { id: "order-1", orderNo: "TEST-SO-001", status: "confirmed", versions: [{ id: "version-1", version: 2 }], boms: [] };
  let createData;
  const prisma = { salesOrder: { findFirst: async () => order }, bom: { create: async ({ data }) => { createData = data; return { id: "bom-1" }; }, findFirst: async () => ({ id: "bom-1", orderNo: order.orderNo, status: "draft", items: [], salesOrder: order, salesOrderVersion: order.versions[0] }) } };
  const service = new BomsService(prisma, audit);
  const result = await service.createFromSalesOrder(order.id, {}, user);
  assert.equal(result.orderNo, order.orderNo);
  assert.equal(createData.salesOrderVersionId, "version-1");
  assert.equal(createData.createdBy, user.id);
});

test("sales.bom_cannot_be_created_from_an_unconfirmed_order", async () => {
  const service = new BomsService({ salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "TEST-SO-001", status: "draft", versions: [], boms: [] }) } }, audit);
  await assert.rejects(() => service.createFromSalesOrder("order-1", {}, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "SALES_ORDER_NOT_CONFIRMED");
});

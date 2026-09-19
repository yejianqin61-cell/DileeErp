const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { SalesOrdersService } = require("../dist/modules/sales/sales-orders.service.js");
const { BomsService } = require("../dist/modules/sales/boms.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "sales", display_name: "销售测试" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => {} };

test("sales.order.confirm_preserves_order_identity_and_audit_fields", async () => {
  const order = { id: "order-1", orderNo: "TEST-SO-001", status: "draft", customerId: "customer-1", currentVersion: 1, extensionData: {}, orderDate: new Date(), productName: "雨伞", quantity: "10", unit: "个", currency: "USD", contactId: null, boms: [], versions: [], specDetails: [] };
  let updateData;
  const prisma = { salesOrder: { findFirst: async () => order, update: async ({ data }) => { updateData = data; return { ...order, ...data }; } } };
  const service = new SalesOrdersService(prisma, audit);
  const result = await service.confirm(order.id, user);
  assert.equal(result.status, "confirmed");
  assert.equal(updateData.updatedBy, user.id);
});

test("sales.order.rejects_confirming_a_non_draft_order", async () => {
  const order = { id: "order-1", orderNo: "TEST-SO-001", status: "confirmed", customerId: "customer-1", currentVersion: 1, extensionData: {}, orderDate: new Date(), productName: "雨伞", quantity: "10", unit: "个", currency: "USD", contactId: null, boms: [], versions: [], specDetails: [] };
  const service = new SalesOrdersService({ salesOrder: { findFirst: async () => order } }, audit);
  await assert.rejects(() => service.confirm(order.id, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INVALID_STATE_TRANSITION");
});

test("sales.order.revert_rechecks_downstream_facts inside the locked transaction", async () => {
  const order = { id: "order-1", orderNo: "TEST-SO-001", status: "confirmed", customerId: "customer-1", currentVersion: 1, extensionData: {}, orderDate: new Date(), productName: "雨伞", quantity: "10", unit: "个", currency: "USD", contactId: null, boms: [], versions: [], specDetails: [] };
  let updateData;
  const tx = { $queryRaw: async () => undefined, salesOrder: { findFirst: async () => ({ status: "confirmed" }), update: async ({ data }) => { updateData = data; return { ...order, ...data }; } }, bom: { count: async () => 1 }, purchaseOrder: { count: async () => 0 }, productionOrder: { count: async () => 0 } };
  const prisma = { salesOrder: { findFirst: async () => order }, $transaction: async (fn) => fn(tx) };
  const service = new SalesOrdersService(prisma, audit);
  await assert.rejects(() => service.revertToDraft(order.id, "修正资料", user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "SALES_ORDER_DOWNSTREAM_EXISTS");
  assert.equal(updateData, undefined);
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
  const service = new BomsService({ salesOrder: { findFirst: async () => ({ id: "order-1", orderNo: "TEST-SO-001", status: "draft", versions: [], boms: [], specDetails: [] }) } }, audit);
  await assert.rejects(() => service.createFromSalesOrder("order-1", {}, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "SALES_ORDER_NOT_CONFIRMED");
});

// 销售单新增的结算口径：结算币价 / 应收金额 / 结算方式 / 本币金额，
// 必须落库、进版本快照，并且在有下游事实时与其它核心字段一样被锁住。
test("sales.order.create persists settlement fields and keeps them in the version snapshot", async () => {
  const customer = { id: "customer-1", customerCode: "CUS-1", name: "海外客户", isActive: true };
  let createData;
  let versionData;
  const created = { id: "order-1", orderNo: "TEST-SO-002", status: "draft", currentVersion: 1, productName: "雨伞", quantity: "10", unit: "个", currency: "USD" };
  const tx = {
    salesOrder: { create: async ({ data }) => { createData = data; return created; } },
    salesOrderVersion: { create: async ({ data }) => { versionData = data; return data; } },
  };
  const prisma = {
    customer: { findFirst: async () => customer },
    customerContact: { findFirst: async () => null },
    salesOrder: { findFirst: async () => ({ ...created, customer, contact: null, versions: [], boms: [], specDetails: [] }) },
    $transaction: async (fn) => fn(tx),
  };
  const service = new SalesOrdersService(prisma, audit);
  await service.create({
    order_no: "TEST-SO-002",
    customer_id: customer.id,
    order_date: "2026-09-12T00:00:00.000Z",
    product_name: "雨伞",
    quantity: "10",
    unit: "个",
    currency: "USD",
    unit_price: "12",
    settlement_unit_price: "1.7",
    receivable_amount: "17",
    settlement_method: "tt",
    local_currency_amount: "122.4",
  }, user);
  assert.equal(createData.settlementUnitPrice, "1.7");
  assert.equal(createData.receivableAmount, "17");
  assert.equal(createData.settlementMethod, "tt");
  assert.equal(createData.localCurrencyAmount, "122.4");
  assert.equal(versionData.snapshot.settlement_unit_price, "1.7");
  assert.equal(versionData.snapshot.settlement_method, "tt");
});

test("sales.order.update writes settlement fields only when provided", async () => {
  const order = { id: "order-1", orderNo: "TEST-SO-001", status: "draft", customerId: "customer-1", currentVersion: 1, extensionData: {}, orderDate: new Date(), productName: "雨伞", quantity: "10", unit: "个", currency: "USD", contactId: null, boms: [], versions: [], specDetails: [] };
  const customer = { id: "customer-1", name: "海外客户", isActive: true };
  let updateData;
  const tx = {
    salesOrder: { update: async ({ data }) => { updateData = data; return { ...order, ...data }; } },
    salesOrderVersion: { create: async ({ data }) => data },
  };
  const prisma = {
    customer: { findFirst: async () => customer },
    customerContact: { findFirst: async () => null },
    salesOrder: { findFirst: async () => order },
    $transaction: async (fn) => fn(tx),
  };
  const service = new SalesOrdersService(prisma, audit);
  await service.update("order-1", { settlement_method: "monthly" }, user);
  assert.equal(updateData.settlementMethod, "monthly");
  assert.equal("settlementUnitPrice" in updateData, false, "没传的结算字段不应被改写");
});

test("销售单有下游事实时，改结算金额（核心字段）必须先回退下游", async () => {
  const order = { id: "order-1", orderNo: "TEST-SO-001", status: "confirmed", customerId: "customer-1", currentVersion: 1, extensionData: {}, orderDate: new Date(), productName: "雨伞", quantity: "10", unit: "个", currency: "USD", contactId: null, boms: [], versions: [], specDetails: [] };
  const prisma = {
    salesOrder: { findFirst: async () => order },
    purchaseOrder: { count: async () => 1 },
    productionOrder: { count: async () => 0 },
  };
  const service = new SalesOrdersService(prisma, audit);
  await assert.rejects(
    () => service.update("order-1", { settlement_unit_price: "1.9", reason: "调价" }, user),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "SALES_ORDER_CORE_FIELDS_LOCKED",
  );
});

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

// ---- 货号（2026-09-26）：老板要求「每个销售单多一个字段，叫做货号」 ----
// 口径见 docs/design/reorder-item-no-and-summary-2026-09-26.md 与
// docs/task/0926-reorder-item-no-and-summary/02-sales-order-item-no-api.md。

/** 一个最小可用的销售单行（`get()` 的形状），测试里只覆盖关心的字段。 */
function salesOrderRow(overrides = {}) {
  return { id: "order-1", orderNo: "TEST-SO-001", status: "draft", customerId: "customer-1", currentVersion: 1, extensionData: {}, orderDate: new Date("2026-09-12T00:00:00.000Z"), productName: "雨伞", quantity: "10", unit: "个", currency: "USD", contactId: null, itemNo: null, reorderFromOrderNo: null, boms: [], versions: [], specDetails: [], ...overrides };
}

/** 造一个只在事务里被调用的假 Prisma（update 路径）。 */
function updateHarness(order, { withBom = false } = {}) {
  const captured = { updateData: undefined, versionData: undefined };
  const tx = {
    salesOrder: { update: async ({ data }) => { captured.updateData = data; return { ...order, ...data }; } },
    salesOrderVersion: { create: async ({ data }) => { captured.versionData = data; return data; } },
  };
  const prisma = {
    customer: { findFirst: async () => ({ id: "customer-1", name: "海外客户", isActive: true }) },
    customerContact: { findFirst: async () => null },
    salesOrder: { findFirst: async () => order },
    ...(withBom ? { bom: { count: async () => 1 } } : {}),
    $transaction: async (fn) => fn(tx),
  };
  return { service: new SalesOrdersService(prisma, audit), captured };
}

test("货号：新建销售单入库前先归一（去首尾空白、全角空格折成半角），并进版本快照", async () => {
  const customer = { id: "customer-1", customerCode: "CUS-1", name: "海外客户", isActive: true };
  let createData;
  let versionData;
  const created = salesOrderRow({ orderNo: "TEST-SO-010" });
  const tx = {
    salesOrder: { create: async ({ data }) => { createData = data; return created; } },
    salesOrderVersion: { create: async ({ data }) => { versionData = data; return data; } },
  };
  const prisma = {
    customer: { findFirst: async () => customer },
    customerContact: { findFirst: async () => null },
    salesOrder: { findFirst: async () => ({ ...created, customer, contact: null }) },
    $transaction: async (fn) => fn(tx),
  };
  await new SalesOrdersService(prisma, audit).create({
    order_no: "TEST-SO-010", customer_id: customer.id, order_date: "2026-09-12T00:00:00.000Z",
    product_name: "雨伞", quantity: "10", unit: "个", currency: "USD",
    item_no: "　27621　流水花扇 ", // 全角空格 + 首尾空白，现场抄单的典型形状
  }, user);
  assert.equal(createData.itemNo, "27621 流水花扇", "库里存归一后的原样（保留大小写与内部空格）");
  assert.equal(createData.reorderFromOrderNo, null, "不是返单建的就不该有来源单号");
  assert.equal(versionData.snapshot.item_no, "27621 流水花扇", "快照里记的必须与库里存的是同一个值");
});

test("货号：留空 / 只填空格 → 落 null（不是空串）", async () => {
  const customer = { id: "customer-1", name: "海外客户", isActive: true };
  let createData;
  const created = salesOrderRow({ orderNo: "TEST-SO-011" });
  const tx = { salesOrder: { create: async ({ data }) => { createData = data; return created; } }, salesOrderVersion: { create: async ({ data }) => data } };
  const prisma = {
    customer: { findFirst: async () => customer },
    customerContact: { findFirst: async () => null },
    salesOrder: { findFirst: async () => ({ ...created, customer, contact: null }) },
    $transaction: async (fn) => fn(tx),
  };
  await new SalesOrdersService(prisma, audit).create({
    order_no: "TEST-SO-011", customer_id: customer.id, order_date: "2026-09-12T00:00:00.000Z",
    product_name: "雨伞", quantity: "10", unit: "个", currency: "USD", item_no: "   ",
  }, user);
  assert.equal(createData.itemNo, null, "空串在库里没有意义：没有货号就是 null（历史单全是这一种）");
});

test("货号：更新只动传了的键 —— 空串是「清除」，没传是「不动」", async () => {
  const order = salesOrderRow({ itemNo: "27621" });
  const harness = updateHarness(order);
  await harness.service.update("order-1", { item_no: "  DL27621 " }, user);
  assert.equal(harness.captured.updateData.itemNo, "DL27621", "传了货号就写归一后的值");
  assert.equal(harness.captured.versionData.snapshot.item_no, "DL27621");

  const clearing = updateHarness(order);
  await clearing.service.update("order-1", { item_no: "" }, user);
  assert.equal(clearing.captured.updateData.itemNo, null, "空串 = 清除这一格（落 null），不是「不动」");

  const untouched = updateHarness(order);
  await untouched.service.update("order-1", { product_spec: "50cm 三折" }, user);
  assert.equal("itemNo" in untouched.captured.updateData, false, "没传货号就不该写这一列");
  assert.equal(untouched.captured.versionData.snapshot.item_no, "27621", "但快照仍要记当前货号：每版快照都是全量口径");
});

test("货号：返单来源不可被更新接口改写（返单链的出处必须永远答得出来）", async () => {
  const order = salesOrderRow({ status: "confirmed", reorderFromOrderNo: "DL260001-1", itemNo: "27621" });
  const harness = updateHarness(order);
  // 用 `reorder_from_order_no` 硬塞（外部请求走 DTO 会被白名单挡掉；这里同时验证服务层自己也不认它）。
  // 注意改的是 `attention_note`（工艺说明，不在 coreFields 里）：coreFields 会先撞下游锁，测不到这里想测的东西。
  await harness.service.update("order-1", { attention_note: "补一句工艺", reason: "补工艺", reorder_from_order_no: "DL999999-1" }, user);
  assert.equal("reorderFromOrderNo" in harness.captured.updateData, false, "更新接口不能改写返单来源");
  assert.equal(harness.captured.versionData.snapshot.reorder_from_order_no, "DL260001-1", "快照记的是当前来源，不是这次塞进来的值");
});

test("货号：已确认单改货号不锁下游（它不在 coreFields 里），但仍需填修改原因", async () => {
  // 已有 BOM 的已确认单：改货号必须放行 —— 否则「下单后发现货号打错」要先回退 BOM/采购/生产才能修。
  const order = salesOrderRow({ status: "confirmed", itemNo: "27621", boms: [{ id: "bom-1", version: 1, status: "draft" }] });
  const allowed = updateHarness(order, { withBom: true });
  await allowed.service.update("order-1", { item_no: "27621 修正", reason: "货号抄错" }, user);
  assert.equal(allowed.captured.updateData.itemNo, "27621 修正");

  // 但「已确认单改动必须填原因」这条既有守卫仍然生效。
  const missingReason = updateHarness(order, { withBom: true });
  await assert.rejects(
    () => missingReason.service.update("order-1", { item_no: "27621 修正" }, user),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "CORRECTION_REASON_REQUIRED",
  );
});

test("货号：已关闭单**只放行补货号**这一种改动（历史单补录的唯一出路），其余字段照旧拒绝", async () => {
  // 为什么必须放行：返单来源必须是「已确认或已关闭」，而来源没货号就不能返单 ——
  // 不放行的话那些单会永远卡在「既不能返单、又不能补货号」里（T12 的补录面板就点不动它们）。
  const closed = salesOrderRow({ status: "closed", itemNo: null, boms: [{ id: "bom-1", version: 1, status: "draft" }] });
  const allowed = updateHarness(closed);
  await allowed.service.update("order-1", { item_no: "27621 补录", reason: "历史单补货号" }, user);
  assert.equal(allowed.captured.updateData.itemNo, "27621 补录");

  // 但要留痕：只改货号也得填原因。
  const missingReason = updateHarness(closed);
  await assert.rejects(
    () => missingReason.service.update("order-1", { item_no: "27621 补录" }, user),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "CORRECTION_REASON_REQUIRED",
  );

  // 其余字段（哪怕同时带了货号）仍然是「已关闭不可编辑」。
  for (const patch of [{ product_spec: "改规格", reason: "x" }, { item_no: "27621", product_spec: "改规格", reason: "x" }]) {
    const blocked = updateHarness(closed);
    await assert.rejects(
      () => blocked.service.update("order-1", patch, user),
      (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "SALES_ORDER_CLOSED",
    );
    assert.equal(blocked.captured.updateData, undefined, "拒绝的请求不该写库");
  }
});

test("货号：销售单列表搜索命中货号", async () => {
  let findManyArguments;
  const prisma = {
    salesOrder: {
      findMany: (arguments_) => { findManyArguments = arguments_; return Promise.resolve([]); },
      count: () => Promise.resolve(0),
    },
    $transaction: async (operations) => Promise.all(operations),
  };
  await new SalesOrdersService(prisma, audit).list(1, 20, "27621");
  const or = findManyArguments.where.OR ?? [];
  assert.ok(or.some((clause) => clause.itemNo && clause.itemNo.contains === "27621"), "搜索必须能按货号命中（现场常常只记得货号）");
  assert.equal(or.find((clause) => clause.itemNo).itemNo.mode, "insensitive", "货号搜索不区分大小写");
});

test("货号候选：按单数降序、空货号不进候选、带上归一键", async () => {
  let groupByArguments;
  const prisma = {
    salesOrder: {
      groupBy: (arguments_) => {
        groupByArguments = arguments_;
        return Promise.resolve([
          { itemNo: "27621", _count: { _all: 3 } },
          { itemNo: "DL27621", _count: { _all: 1 } },
          { itemNo: "27621 流水花扇", _count: { _all: 5 } },
        ]);
      },
    },
  };
  const options = await new SalesOrdersService(prisma, audit).itemNoOptions();
  assert.deepEqual(options.map((option) => option.item_no), ["27621 流水花扇", "27621", "DL27621"], "按单数降序（常用的排在前面）");
  assert.equal(options[0].item_no_key, "27621流水花扇", "匹配键由服务端给，前端不自己算");
  assert.equal(groupByArguments.by[0], "itemNo");
  assert.equal(groupByArguments.where.itemNo.not, null, "空货号不是候选：它是「还没填」，不是可选项");
});

test("货号候选：q 先 trim 且不区分大小写；limit 有上限（默认 50 / 最大 200）", async () => {
  let groupByArguments;
  const prisma = { salesOrder: { groupBy: (arguments_) => { groupByArguments = arguments_; return Promise.resolve([]); } } };
  const service = new SalesOrdersService(prisma, audit);
  await service.itemNoOptions("  dl27621  ", 20);
  assert.equal(groupByArguments.where.itemNo.contains, "dl27621", "入参先 trim");
  assert.equal(groupByArguments.where.itemNo.mode, "insensitive");
  // 候选列表不是导出接口：给一个能一次拉爆页面的上限没有意义。
  const many = Array.from({ length: 260 }, (_, index) => ({ itemNo: `A${String(index).padStart(3, "0")}`, _count: { _all: 1 } }));
  const capped = new SalesOrdersService({ salesOrder: { groupBy: async () => many } }, audit);
  assert.equal((await capped.itemNoOptions(undefined, 9999)).length, 200, "limit 上限 200");
  assert.equal((await capped.itemNoOptions(undefined, 0)).length, 50, "limit 传 0 落到默认 50（不是 0 条）");
});

test("货号候选：路由必须声明在 @Get(\":id\") 之前（否则会被当成销售单 id 吃掉）", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "modules", "sales", "sales-orders.controller.ts"), "utf8");
  const itemNos = source.indexOf('@Get("item-nos")');
  // 找的是**真正的路由声明**（带 ` async`），不是注释里提到 `@Get(":id")` 的那几处说明文字 ——
  // 上面两个路由的注释里都写着「必须声明在 @Get(":id") 之前」，纯搜字符串会命中注释、断言反过来失败。
  const byId = source.indexOf('@Get(":id") async');
  assert.ok(itemNos > 0, "item-nos 路由必须存在");
  assert.ok(byId > 0, "预期控制器里仍有一条 @Get(\":id\") 路由");
  assert.ok(itemNos < byId, "Nest 按声明顺序匹配：item-nos 必须在 :id 之前，否则建议列表永远是空的");
});

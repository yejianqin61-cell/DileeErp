const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { Prisma } = require("@prisma/client");
const { FinishedGoodsOutboundNoticeService } = require("../../dist/modules/sales/finished-goods-outbound-notice.service.js");
const { FinishedGoodsOutboundService } = require("../../dist/modules/warehouse/finished-goods-outbound.service.js");

// 成品出库通知链路（需求 4/6，第三批需求 1 改为支持分批出库）：
//   成品入库 → 销售「通知仓库出库」 → 仓库按通知**分批**生成出库单 → 每张过账生成各自应收（通知财务收款）
// 口径：
//   - 可出库 = 库存余额（入库 − 出库 + 退货回仓） − 待办通知的「通知量 − 已出库量」之和；
//   - 仓库可按剩余量分批建单（也可只出一部分），数量必须 ≤ 剩余量且 ≤ 库存余额；
//   - 通知状态按累计出库推导：pending → outbound_created（有草稿）→ partially_outbound（部分出库）→ completed（发完）。
const user = { id: "00000000-0000-0000-0000-000000000001", username: "tester" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => undefined };

function decimal(value) { return new Prisma.Decimal(value); }

// ---------- 销售侧：可出库量与通知 ----------
function salesService(overrides = {}) {
  const balance = overrides.balance ?? decimal(50);
  const prisma = {
    salesOrder: { findFirst: async () => ({ id: "so-1", orderNo: "SO-1", customerId: "customer-1", productName: "折叠伞", productSpec: "8K", quantity: decimal(100), unit: "把", settlementUnitPrice: decimal("12.5"), customer: { id: "customer-1", name: "海外客户" } }) },
    productionOrder: {
      findMany: async () => [{ id: "po-1", productionOrderNo: "MO-1", status: "completed", executionMode: "in_house", executionLocation: { name: "一车间" }, unitId: "unit-1", unit: { name: "把" }, plannedQuantity: decimal(100), productSpecification: "8K" }],
      findFirst: async () => ("productionOrderFindFirst" in overrides ? overrides.productionOrderFindFirst : { id: "po-1", productionOrderNo: "MO-1", unitId: "unit-1", productSpecification: "8K", unit: { name: "把" } }),
    },
    finishedGoodsInbound: { aggregate: async () => ({ _sum: { quantity: overrides.inbound ?? decimal(60) } }) },
    finishedGoodsOutbound: { aggregate: async () => ({ _sum: { quantity: overrides.outbound ?? decimal(0) } }), count: async () => overrides.draftCount ?? 0 },
    finishedGoodsOutboundNotice: {
      findMany: async (args) => {
        if (args?.where?.idempotencyKey) { overrides.onReplayQuery?.(args); return overrides.replayed ?? []; }
        if (args?.select?.noticeQuantity) return overrides.openNotices ?? [];
        return overrides.notices ?? [];
      },
      findFirst: async () => overrides.existingNotice ?? null,
      create: async ({ data }) => { overrides.created?.push(data); return { id: "notice-1", ...data }; },
      update: async ({ data }) => ({ id: "notice-1", ...data }),
      updateMany: async (args) => { overrides.noticeUpdates?.push(args.data); overrides.noticeUpdateWheres?.push(args.where); return { count: overrides.cancelUpdated ?? 1 }; },
    },
    $transaction: async (fn) => fn({
      $queryRaw: async () => undefined,
      productionOrder: { findFirst: async () => ({ id: "po-1", unitId: "unit-1", productSpecification: "8K", unit: { name: "把" } }) },
      finishedGoodsInbound: { aggregate: async () => ({ _sum: { quantity: overrides.inbound ?? decimal(60) } }) },
      finishedGoodsOutbound: { aggregate: async () => ({ _sum: { quantity: overrides.outbound ?? decimal(0) } }) },
      finishedGoodsOutboundNotice: {
        findMany: async (args) => (args?.select?.noticeQuantity ? (overrides.openNotices ?? []) : (overrides.notices ?? [])),
        create: async ({ data }) => { overrides.created?.push(data); return { id: "notice-1", ...data }; },
        updateMany: async (args) => { overrides.noticeUpdates?.push(args.data); overrides.noticeUpdateWheres?.push(args.where); return { count: overrides.cancelUpdated ?? 1 }; },
        findFirst: async () => overrides.existingNotice ?? null,
      },
    }),
  };
  return new FinishedGoodsOutboundNoticeService(prisma, { finishedGoodsBalance: async () => balance }, audit);
}

test("销售订单成品情况：可出库 = 库存余额 − 待办通知的未出库部分", async () => {
  // 余额 50；一张通知 60 已出库 20 → 仍占用 40 → 可出库 10
  const service = salesService({ inbound: decimal(60), outbound: decimal(10), balance: decimal(50), openNotices: [{ noticeQuantity: decimal(60), shippedQuantity: decimal(20) }] });
  const summary = await service.summary("so-1");
  const row = summary.production_orders[0];
  assert.equal(row.inbound_quantity, "60");
  assert.equal(row.outbound_quantity, "10");
  assert.equal(row.pending_notice_quantity, "40", "待办占用 = 通知量 − 已出库量");
  assert.equal(row.available_quantity, "10");
  assert.equal(summary.settlement_unit_price, "12.5");
});

test("通知全部出库后不再占用额度；退货回仓后可出库量随之增加", async () => {
  const shipped = salesService({ balance: decimal(50), openNotices: [{ noticeQuantity: decimal(50), shippedQuantity: decimal(50) }] });
  assert.equal((await shipped.summary("so-1")).production_orders[0].available_quantity, "50", "发完的通知不再占用额度");

  const returned = salesService({ balance: decimal(55), openNotices: [{ noticeQuantity: decimal(20), shippedQuantity: decimal(5) }] });
  assert.equal((await returned.summary("so-1")).production_orders[0].available_quantity, "40", "余额 55 − 占用 15 = 40");
});

test("通知出库按可出库量建通知", async () => {
  const created = [];
  const service = salesService({ inbound: decimal(60), outbound: decimal(10), balance: decimal(50), created });
  const notices = await service.createNotices("so-1", { remark: "分批发货" }, user);
  assert.equal(notices.length, 1);
  assert.equal(created[0].noticeQuantity.toString(), "50");
  assert.equal(created[0].status, "pending");
});

test("没有可出库成品时给出可执行的 422，而不是静默成功", async () => {
  const service = salesService({ balance: decimal(50), openNotices: [{ noticeQuantity: decimal(50), shippedQuantity: decimal(0) }] });
  await assert.rejects(
    () => service.createNotices("so-1", {}, user),
    (error) => {
      assert.ok(error instanceof UnprocessableEntityException);
      assert.equal(error.getResponse().code, "OUTBOUND_NOTICE_NOTHING_TO_NOTIFY");
      assert.match(error.getResponse().message, /成品入库/);
      return true;
    },
  );
});

test("通知出库支持幂等键：重放精确查回原通知（不会重复建单，也不会跨单串号）", async () => {
  const existing = { id: "notice-1", noticeNo: "OGN-1" };
  let replayQuery;
  const service = salesService({ replayed: [existing], onReplayQuery: (args) => { replayQuery = args; } });
  const notices = await service.createNotices("so-1", { idempotency_key: "web-1" }, user);
  assert.deepEqual(notices, [existing]);
  assert.deepEqual(replayQuery.where.idempotencyKey.in, ["web-1:po-1"], "存储键是「客户端键:生产单ID」，重放要精确匹配候选键");
  assert.equal(replayQuery.where.salesOrderId, "so-1", "重放必须限定在本销售单内");
});

test("指定了不属于本销售单的生产单时给出明确 422", async () => {
  const service = salesService({ productionOrderFindFirst: null });
  await assert.rejects(
    () => service.createNotices("so-1", { production_order_id: "po-other" }, user),
    (error) => error.getResponse().code === "OUTBOUND_NOTICE_PRODUCTION_ORDER_MISMATCH",
  );
});

test("取消通知带状态条件：并发生成出库单后不能再取消", async () => {
  const noticeUpdates = [];
  const service = salesService({ existingNotice: { id: "notice-1", salesOrderId: "so-1", status: "pending", orderNo: "SO-1", remark: null }, noticeUpdates, cancelUpdated: 0 });
  await assert.rejects(
    () => service.cancelNotice("so-1", "notice-1", "客户取消订单", user),
    (error) => error.getResponse().code === "OUTBOUND_NOTICE_NOT_CANCELLABLE",
  );
  assert.equal(noticeUpdates[0].status, "cancelled");
});

test("已部分出库的通知可以取消剩余量（否则剩余量永久占用可出库额度）", async () => {
  const noticeUpdates = [];
  const noticeUpdateWheres = [];
  const service = salesService({ existingNotice: { id: "notice-1", salesOrderId: "so-1", status: "partially_outbound", orderNo: "SO-1", remark: null }, noticeUpdates, noticeUpdateWheres, draftCount: 0 });
  const result = await service.cancelNotice("so-1", "notice-1", "客户取消尾单", user);
  assert.equal(noticeUpdates[0].status, "cancelled");
  assert.deepEqual(noticeUpdateWheres[0].status, { in: ["pending", "partially_outbound"] }, "CAS 必须同时覆盖 pending 与 partially_outbound");
  assert.equal(noticeUpdates.length, 1, "只改一次状态");
});

test("已部分出库但还有在途草稿时不能取消：先取消草稿，避免草稿变成悬空单", async () => {
  const noticeUpdates = [];
  const service = salesService({ existingNotice: { id: "notice-1", salesOrderId: "so-1", status: "partially_outbound", orderNo: "SO-1", remark: null }, noticeUpdates, draftCount: 1 });
  await assert.rejects(
    () => service.cancelNotice("so-1", "notice-1", "客户取消尾单", user),
    (error) => error.getResponse().code === "OUTBOUND_NOTICE_NOT_CANCELLABLE" && error.getResponse().details[0].draft_count === 1,
  );
  assert.equal(noticeUpdates.length, 0, "有草稿时不得改状态");
});

// ---------- 仓库侧：分批出库 ----------
function warehouseService(overrides = {}) {
  const notice = {
    id: "notice-1", noticeNo: "OGN-1", status: overrides.noticeStatus ?? "pending", orderNo: "SO-1", salesOrderId: "so-1", productionOrderId: "po-1",
    unitId: "unit-1", noticeQuantity: overrides.noticeQuantity ?? decimal(50), shippedQuantity: overrides.shippedQuantity ?? decimal(0),
    productNameSnapshot: "折叠伞", productSpecificationSnapshot: "8K",
  };
  const balance = overrides.balance ?? decimal(50);
  const outboundCreates = [];
  const noticeUpdates = [];
  const aggregateFor = (args) => (args?.where?.status === "draft" ? { _sum: { quantity: overrides.draftQuantity ?? decimal(0) } } : { _sum: { quantity: overrides.postedQuantity ?? decimal(0) } });
  const tx = {
    $queryRaw: async () => undefined,
    finishedGoodsOutboundNotice: {
      findFirst: async () => (overrides.noticeMissing ? null : notice),
      update: async ({ data }) => { noticeUpdates.push(data); return { ...notice, ...data }; },
    },
    finishedGoodsOutbound: { create: async ({ data }) => { outboundCreates.push(data); return { id: "outbound-1", ...data }; }, aggregate: async (args) => aggregateFor(args) },
    salesOrder: { findUnique: async () => ({ quantity: overrides.plannedQuantity ?? decimal(100) }) },
    receivableSource: { create: async () => undefined },
    inventoryFact: { findFirst: async () => null, create: async () => undefined },
  };
  const prisma = {
    finishedGoodsOutboundNotice: { findFirst: async () => (overrides.noticeMissing ? null : notice) },
    finishedGoodsOutbound: { findFirst: async () => overrides.currentOutbound ?? null, aggregate: async (args) => aggregateFor(args) },
    $transaction: async (fn) => fn(tx),
  };
  const service = new FinishedGoodsOutboundService(prisma, audit, { finishedGoodsBalance: async () => balance });
  return { service, outboundCreates, noticeUpdates, notice };
}

test("按通知建出库单：不传数量就按剩余量建单，并挂到通知上", async () => {
  const { service, outboundCreates, noticeUpdates } = warehouseService({ noticeQuantity: decimal(50), shippedQuantity: decimal(20) });
  const outbound = await service.createOutboundFromNotice("notice-1", {}, user);
  assert.equal(outbound.quantity.toString(), "30", "剩余量 = 通知量 50 − 已出库 20");
  assert.equal(outboundCreates[0].outboundNoticeId, "notice-1");
  assert.match(outboundCreates[0].idempotencyKey, /^notice:notice-1:/, "每张分批出库单的幂等键都必须唯一");
});

test("按通知分批出库：只出一部分时数量按传入值，且不能超过剩余量", async () => {
  const { service, outboundCreates } = warehouseService({ noticeQuantity: decimal(50) });
  const outbound = await service.createOutboundFromNotice("notice-1", { quantity: "20" }, user);
  assert.equal(outbound.quantity.toString(), "20");
  assert.equal(outboundCreates[0].outboundNoticeId, "notice-1");

  const { service: second } = warehouseService({ noticeQuantity: decimal(50) });
  await assert.rejects(
    () => second.createOutboundFromNotice("notice-1", { quantity: "60" }, user),
    (error) => {
      assert.equal(error.getResponse().code, "OUTBOUND_NOTICE_QUANTITY_EXCEEDED");
      assert.deepEqual(error.getResponse().details, [{ remaining_quantity: "50", requested_quantity: "60" }]);
      return true;
    },
  );
});

test("通知已发完或已取消时不能再建出库单", async () => {
  for (const status of ["completed", "cancelled"]) {
    const { service } = warehouseService({ noticeStatus: status });
    await assert.rejects(
      () => service.createOutboundFromNotice("notice-1", {}, user),
      (error) => error.getResponse().code === "OUTBOUND_NOTICE_NOT_PENDING",
    );
  }
});

test("按通知建出库单支持幂等重放：同一个 key 重复提交返回同一张单，不再建第二张", async () => {
  const { service, outboundCreates } = warehouseService({ noticeQuantity: decimal(50) });
  const first = await service.createOutboundFromNotice("notice-1", { quantity: "20", idempotency_key: "web-abc" }, user);
  assert.equal(outboundCreates.length, 1);
  assert.equal(outboundCreates[0].idempotencyKey, "notice:notice-1:web-abc", "调用方给的 key 决定幂等键");

  // 同一个 key 的重试：查到已有单直接返回，不再 create
  const { service: replayed, outboundCreates: replayedCreates } = warehouseService({ noticeQuantity: decimal(50), currentOutbound: { id: first.id, idempotencyKey: "notice:notice-1:web-abc" } });
  const again = await replayed.createOutboundFromNotice("notice-1", { quantity: "20", idempotency_key: "web-abc" }, user);
  assert.equal(again.id, first.id);
  assert.equal(replayedCreates.length, 0, "重放不得再建草稿");
});

test("没传幂等键时只能退化为随机后缀（前端漏传就等于没有幂等）", async () => {
  const a = warehouseService({ noticeQuantity: decimal(50) });
  const b = warehouseService({ noticeQuantity: decimal(50) });
  await a.service.createOutboundFromNotice("notice-1", { quantity: "20" }, user);
  await b.service.createOutboundFromNotice("notice-1", { quantity: "20" }, user);
  assert.notEqual(a.outboundCreates[0].idempotencyKey, b.outboundCreates[0].idempotencyKey);
});

test("出库数量不能超过当前成品可用量（分批也要看库存）", async () => {
  const { service } = warehouseService({ noticeQuantity: decimal(50), balance: decimal(10) });
  await assert.rejects(
    () => service.createOutboundFromNotice("notice-1", { quantity: "30" }, user),
    (error) => error.getResponse().code === "FINISHED_GOODS_OUTBOUND_INVENTORY_INSUFFICIENT",
  );
});

test("手动建出库单支持分批：数量不超过可用量即可", async () => {
  const refs = { sales: { id: "so-1", orderNo: "SO-1", quantity: decimal(100), unit: "把", productName: "折叠伞", productSpec: "8K" }, production: { id: "po-1", unitId: "unit-1", salesOrderId: "so-1", orderNo: "SO-1" } };
  const created = [];
  const prisma = {
    salesOrder: { findFirst: async () => refs.sales },
    productionOrder: { findFirst: async () => refs.production },
    finishedGoodsOutbound: { findFirst: async () => null, create: async ({ data }) => { created.push(data); return { id: "outbound-1", ...data }; }, aggregate: async () => ({ _sum: { quantity: decimal(0) } }) },
    finishedGoodsOutboundNotice: { findMany: async () => [] },
  };
  const service = new FinishedGoodsOutboundService(prisma, audit, { finishedGoodsBalance: async () => decimal(60) });
  await service.createOutbound({ sales_order_id: "so-1", production_order_id: "po-1", quantity: "30" }, user);
  assert.equal(created[0].quantity.toString(), "30", "分批出库允许小于可用量");
  await assert.rejects(
    () => service.createOutbound({ sales_order_id: "so-1", production_order_id: "po-1", quantity: "61" }, user),
    (error) => error.getResponse().code === "FINISHED_GOODS_OUTBOUND_INVENTORY_INSUFFICIENT",
  );
});

test("手动建出库单必须让开待办通知占用的量（否则通知的草稿过账时才发现没货）", async () => {
  const refs = { sales: { id: "so-1", orderNo: "SO-1", quantity: decimal(100), unit: "把", productName: "折叠伞", productSpec: "8K" }, production: { id: "po-1", unitId: "unit-1", salesOrderId: "so-1", orderNo: "SO-1" } };
  const created = [];
  const prisma = {
    salesOrder: { findFirst: async () => refs.sales },
    productionOrder: { findFirst: async () => refs.production },
    finishedGoodsOutbound: { findFirst: async () => null, create: async ({ data }) => { created.push(data); return { id: "outbound-1", ...data }; }, aggregate: async () => ({ _sum: { quantity: decimal(0) } }) },
    // 一张待办通知：通知 50、已出 20 → 占用 30；余额 50 → 手工可用只剩 20。
    finishedGoodsOutboundNotice: { findMany: async () => [{ noticeNo: "OGN-1", noticeQuantity: decimal(50), shippedQuantity: decimal(20) }] },
  };
  const service = new FinishedGoodsOutboundService(prisma, audit, { finishedGoodsBalance: async () => decimal(50) });

  const error = await service.createOutbound({ sales_order_id: "so-1", production_order_id: "po-1", quantity: "21" }, user).then(() => null, (cause) => cause);
  assert.equal(error?.getResponse().code, "FINISHED_GOODS_OUTBOUND_NOTICE_RESERVED", "吃进预留量必须被拦下");
  assert.equal(error?.getResponse().details[0].pending_notice_quantity, "30");
  assert.equal(error?.getResponse().details[0].free_quantity, "20", "报错要给出还能手工出多少");
  assert.deepEqual(error?.getResponse().details[0].notices, ["OGN-1（待出 30）"], "报错要指名占用方");
  assert.equal(created.length, 0);

  // 不越过预留量的部分正常放行
  await service.createOutbound({ sales_order_id: "so-1", production_order_id: "po-1", quantity: "20" }, user);
  assert.equal(created[0].quantity.toString(), "20", "预留量之外的可用量仍可手工出库");
});

test("数量入口守卫拒绝 NaN / 指数写法 / 超过 4 位小数（NaN 会绕过所有数量比较）", async () => {
  const refs = { sales: { id: "so-1", orderNo: "SO-1", quantity: decimal(100), unit: "把", productName: "折叠伞", productSpec: "8K" }, production: { id: "po-1", unitId: "unit-1", salesOrderId: "so-1", orderNo: "SO-1" } };
  const prisma = {
    salesOrder: { findFirst: async () => refs.sales },
    productionOrder: { findFirst: async () => refs.production },
    finishedGoodsOutbound: { findFirst: async () => null, create: async ({ data }) => ({ id: "outbound-1", ...data }), aggregate: async () => ({ _sum: { quantity: decimal(0) } }) },
    finishedGoodsOutboundNotice: { findMany: async () => [] },
  };
  const service = new FinishedGoodsOutboundService(prisma, audit, { finishedGoodsBalance: async () => decimal(60) });
  for (const quantity of ["NaN", "1e3", "0.00004", "-1", "0", "", "  "]) {
    await assert.rejects(
      () => service.createOutbound({ sales_order_id: "so-1", production_order_id: "po-1", quantity }, user),
      (error) => error.getResponse().code === "INVALID_FINISHED_GOODS_OUTBOUND_QUANTITY",
      `数量 ${JSON.stringify(quantity)} 必须在入口被拒绝`,
    );
  }
});

test("过账按累计出库推进通知状态：部分出库 → partially_outbound，发完 → completed", async () => {
  const outbound = { id: "outbound-1", status: "draft", productionOrderId: "po-1", unitId: "unit-1", quantity: decimal(20), orderNo: "SO-1", salesOrderId: "so-1", outboundNoticeId: "notice-1", signedAt: null, riskReason: null, productNameSnapshot: "折叠伞", productSpecificationSnapshot: "8K" };
  const noticeNotices = { findFirst: async () => ({ id: "notice-1", noticeQuantity: decimal(50), status: "outbound_created" }) };
  const buildPost = (postedQuantity, collected) => {
    const tx = {
      $queryRaw: async () => undefined,
      inventoryFact: { findFirst: async () => null, create: async () => undefined },
      finishedGoodsOutbound: { findFirst: async () => outbound, update: async ({ data }) => ({ ...outbound, ...data }), aggregate: async (args) => (args?.where?.status === "draft" ? { _sum: { quantity: decimal(0) } } : { _sum: { quantity: postedQuantity } }) },
      salesOrder: { findUnique: async () => ({ id: "so-1", customerId: "customer-1", unit: "把", unitPrice: decimal(10), settlementUnitPrice: decimal("12.5"), taxRate: null, currency: "CNY", quantity: decimal(100) }) },
      receivableSource: { create: async () => undefined },
      finishedGoodsOutboundNotice: { ...noticeNotices, update: async ({ data }) => { collected.push(data); return data; } },
    };
    return new FinishedGoodsOutboundService({ finishedGoodsOutbound: { findFirst: async () => outbound, aggregate: async () => ({ _sum: { quantity: decimal(0) } }) }, $transaction: async (fn) => fn(tx) }, audit, { finishedGoodsBalance: async () => decimal(50) });
  };
  const complete = [];
  await buildPost(decimal(50), complete).postOutbound("outbound-1", user);
  assert.equal(complete[0].shippedQuantity.toString(), "50");
  assert.equal(complete[0].status, "completed");

  const partial = [];
  await buildPost(decimal(20), partial).postOutbound("outbound-1", user);
  assert.equal(partial[0].shippedQuantity.toString(), "20");
  assert.equal(partial[0].status, "partially_outbound");
});

test("草稿出库单可以取消：释放幂等键并按剩余量重新推导通知状态", async () => {
  const current = { id: "outbound-1", status: "draft", productionOrderId: "po-1", unitId: "unit-1", orderNo: "SO-1", outboundNoticeId: "notice-1" };
  const outboundUpdates = [];
  const noticeUpdates = [];
  const tx = {
    $queryRaw: async () => undefined,
    finishedGoodsOutbound: { findFirst: async () => current, update: async ({ data }) => { outboundUpdates.push(data); return { ...current, ...data }; }, aggregate: async () => ({ _sum: { quantity: decimal(0) } }) },
    finishedGoodsOutboundNotice: { findFirst: async () => ({ id: "notice-1", noticeQuantity: decimal(50), status: "outbound_created" }), update: async ({ data }) => { noticeUpdates.push(data); return data; } },
  };
  const prisma = { finishedGoodsOutbound: { findFirst: async () => current, aggregate: async () => ({ _sum: { quantity: decimal(0) } }) }, $transaction: async (fn) => fn(tx) };
  const service = new FinishedGoodsOutboundService(prisma, audit, {});
  await service.cancelOutbound("outbound-1", "库存不一致", user);
  assert.equal(outboundUpdates[0].status, "cancelled");
  assert.match(outboundUpdates[0].idempotencyKey, /^cancelled:/, "必须释放 notice:<id> 幂等键，允许重新建单");
  assert.equal(noticeUpdates[0].status, "pending", "没有已出库量时回到 pending");
  assert.equal(noticeUpdates[0].shippedQuantity.toString(), "0");
});

test("已过账出库单不能取消（必须先冲销）", async () => {
  const service = new FinishedGoodsOutboundService({ finishedGoodsOutbound: { findFirst: async () => ({ id: "outbound-1", status: "posted" }) } }, audit, {});
  await assert.rejects(
    () => service.cancelOutbound("outbound-1", "误操作", user),
    (error) => error.getResponse().code === "FINISHED_GOODS_OUTBOUND_NOT_CANCELLABLE",
  );
});

test("冲销一张分批出库单：已出库量下降，通知回到可继续出库的状态", async () => {
  const outbound = { id: "outbound-1", status: "posted", productionOrderId: "po-1", unitId: "unit-1", quantity: decimal(20), orderNo: "SO-1", salesOrderId: "so-1", outboundNoticeId: "notice-1", remark: null };
  const noticeUpdates = [];
  const tx = {
    $queryRaw: async () => undefined,
    inventoryFact: { findFirst: async () => null, create: async () => undefined },
    finishedGoodsOutbound: { update: async ({ data }) => ({ ...outbound, ...data }), aggregate: async () => ({ _sum: { quantity: decimal(0) } }) },
    receivableSource: { findFirst: async () => null },
    finishedGoodsOutboundNotice: { findFirst: async () => ({ id: "notice-1", noticeQuantity: decimal(50), status: "partially_outbound" }), update: async ({ data }) => { noticeUpdates.push(data); return data; } },
  };
  const prisma = { finishedGoodsOutbound: { findFirst: async () => outbound, aggregate: async () => ({ _sum: { quantity: decimal(0) } }) }, $transaction: async (fn) => fn(tx) };
  const service = new FinishedGoodsOutboundService(prisma, audit, {});
  await service.reverseOutbound("outbound-1", "发错货", user);
  assert.equal(noticeUpdates[0].shippedQuantity.toString(), "0");
  assert.equal(noticeUpdates[0].status, "pending", "冲销后剩余量回来，仓库可以重新建单");
});

test("过账生成应收（按结算币价）并把通知推进为 completed", async () => {
  const outbound = { id: "outbound-1", status: "draft", productionOrderId: "po-1", unitId: "unit-1", quantity: decimal(50), orderNo: "SO-1", salesOrderId: "so-1", outboundNoticeId: "notice-1", signedAt: null, riskReason: null, productNameSnapshot: "折叠伞", productSpecificationSnapshot: "8K" };
  const receivableWrites = [];
  const noticeUpdates = [];
  const tx = {
    $queryRaw: async () => undefined,
    inventoryFact: { findFirst: async () => null, create: async () => undefined },
    finishedGoodsOutbound: { findFirst: async () => outbound, update: async ({ data }) => ({ ...outbound, ...data }), aggregate: async (args) => (args?.where?.status === "draft" ? { _sum: { quantity: decimal(0) } } : { _sum: { quantity: decimal(50) } }) },
    salesOrder: { findUnique: async () => ({ id: "so-1", customerId: "customer-1", unit: "把", unitPrice: decimal(10), settlementUnitPrice: decimal("12.5"), taxRate: null, currency: "CNY", quantity: decimal(100) }) },
    receivableSource: { create: async ({ data }) => { receivableWrites.push(data); return data; } },
    finishedGoodsOutboundNotice: { findFirst: async () => ({ id: "notice-1", noticeQuantity: decimal(50), status: "outbound_created" }), update: async ({ data }) => { noticeUpdates.push(data); return data; } },
  };
  const prisma = { finishedGoodsOutbound: { findFirst: async () => outbound, aggregate: async () => ({ _sum: { quantity: decimal(0) } }) }, $transaction: async (fn) => fn(tx) };
  const service = new FinishedGoodsOutboundService(prisma, audit, { finishedGoodsBalance: async () => decimal(50) });
  await service.postOutbound("outbound-1", user);
  assert.equal(receivableWrites.length, 1, "每张分批出库单各自生成应收（通知财务收款）");
  assert.equal(receivableWrites[0].unitPrice.toString(), "12.5");
  assert.equal(receivableWrites[0].amount.toString(), "625");
  assert.equal(noticeUpdates[0].status, "completed");
});

test("填写了「应收金额」时，应收按 应收金额 ÷ 订单数量 计价（整单出库总额与销售填写一致）", async () => {
  const outbound = { id: "outbound-1", status: "draft", productionOrderId: "po-1", unitId: "unit-1", quantity: decimal(100), orderNo: "SO-1", salesOrderId: "so-1", signedAt: null, riskReason: null, productNameSnapshot: "折叠伞", productSpecificationSnapshot: "8K" };
  const receivableWrites = [];
  const tx = {
    $queryRaw: async () => undefined,
    inventoryFact: { findFirst: async () => null, create: async () => undefined },
    finishedGoodsOutbound: { findFirst: async () => outbound, update: async ({ data }) => ({ ...outbound, ...data }), aggregate: async () => ({ _sum: { quantity: decimal(0) } }) },
    salesOrder: { findUnique: async () => ({ id: "so-1", customerId: "customer-1", unit: "把", unitPrice: decimal(10), settlementUnitPrice: decimal("12.5"), receivableAmount: decimal(1300), settlementMethod: "tt", localCurrencyAmount: decimal("9360"), taxRate: null, currency: "USD", quantity: decimal(100) }) },
    receivableSource: { create: async ({ data }) => { receivableWrites.push(data); return data; } },
  };
  const prisma = { finishedGoodsOutbound: { findFirst: async () => outbound, aggregate: async () => ({ _sum: { quantity: decimal(0) } }) }, $transaction: async (fn) => fn(tx) };
  const service = new FinishedGoodsOutboundService(prisma, audit, { finishedGoodsBalance: async () => decimal(100) });
  await service.postOutbound("outbound-1", user);
  assert.equal(receivableWrites[0].amount.toString(), "1300");
  assert.match(receivableWrites[0].remark, /结算方式 T\/T 电汇/);
  assert.match(receivableWrites[0].remark, /本币金额 9360/);
});

test("应收计价全为 0 时拒绝过账（不能让出库生成 0 元应收）", async () => {
  const outbound = { id: "outbound-1", status: "draft", productionOrderId: "po-1", unitId: "unit-1", quantity: decimal(50), orderNo: "SO-1", salesOrderId: "so-1", signedAt: null, riskReason: null };
  const tx = {
    $queryRaw: async () => undefined,
    inventoryFact: { findFirst: async () => null },
    finishedGoodsOutbound: { findFirst: async () => outbound, aggregate: async () => ({ _sum: { quantity: decimal(0) } }) },
    salesOrder: { findUnique: async () => ({ id: "so-1", customerId: "customer-1", unit: "把", unitPrice: decimal(0), settlementUnitPrice: decimal(0), receivableAmount: null, taxRate: null, currency: "USD", quantity: decimal(100) }) },
    receivableSource: { create: async () => { throw new Error("不应写入应收"); } },
  };
  const prisma = { finishedGoodsOutbound: { findFirst: async () => outbound, aggregate: async () => ({ _sum: { quantity: decimal(0) } }) }, $transaction: async (fn) => fn(tx) };
  const service = new FinishedGoodsOutboundService(prisma, audit, { finishedGoodsBalance: async () => decimal(50) });
  await assert.rejects(
    () => service.postOutbound("outbound-1", user),
    (error) => error.getResponse().code === "SALES_UNIT_PRICE_REQUIRED",
  );
});

test("维护发货与登记签收都带状态条件：已冲销的出库单既被前置拦截，也无法被 CAS 覆盖", async () => {
  const reversed = { id: "outbound-1", status: "reversed", orderNo: "SO-1", shipmentDate: null, signedAt: null };
  const updateCalls = [];
  const prisma = {
    finishedGoodsOutbound: {
      findFirst: async () => reversed,
      updateMany: async ({ where, data }) => { updateCalls.push({ where, data }); return { count: 0 }; },
    },
  };
  const service = new FinishedGoodsOutboundService(prisma, audit, {});
  await assert.rejects(() => service.updateShipping("outbound-1", { carrier: "顺丰" }, user), (error) => error.getResponse().code === "INVALID_OUTBOUND_SHIPPING_STATE");
  assert.equal(updateCalls.length, 0, "状态不允许时不应发起任何写入");

  const shipped = { ...reversed, status: "shipped" };
  const racing = {
    finishedGoodsOutbound: { findFirst: async () => shipped, updateMany: async ({ where, data }) => { updateCalls.push({ where, data }); return { count: 0 }; } },
  };
  const racingService = new FinishedGoodsOutboundService(racing, audit, {});
  await assert.rejects(
    () => racingService.signOutbound("outbound-1", { signed_at: new Date().toISOString() }, user),
    (error) => error.getResponse().code === "INVALID_OUTBOUND_SIGN_STATE",
  );
  assert.deepEqual(updateCalls[0].where.status, { in: ["shipped", "signed"] }, "写入必须限定在可签收状态");
});

test("过账时才发现超计划：自动写入可追溯原因并放行（不再让单据永远过不了账）", async () => {
  const outbound = { id: "outbound-1", status: "draft", productionOrderId: "po-1", unitId: "unit-1", quantity: decimal(10), orderNo: "SO-1", salesOrderId: "so-1", signedAt: null, riskReason: null, productNameSnapshot: "折叠伞", productSpecificationSnapshot: "8K" };
  let postedData;
  const tx = {
    $queryRaw: async () => undefined,
    inventoryFact: { findFirst: async () => null, create: async () => undefined },
    finishedGoodsOutbound: {
      findFirst: async () => outbound,
      aggregate: async () => ({ _sum: { quantity: decimal(5) } }),
      update: async ({ data }) => { postedData = data; return { ...outbound, ...data }; },
    },
    salesOrder: { findUnique: async () => ({ id: "so-1", customerId: "customer-1", unit: "把", unitPrice: decimal(10), settlementUnitPrice: null, receivableAmount: null, taxRate: null, currency: "CNY", quantity: decimal(12) }) },
    receivableSource: { create: async () => undefined },
  };
  const prisma = { finishedGoodsOutbound: { findFirst: async () => outbound, aggregate: async () => ({ _sum: { quantity: decimal(5) } }) }, $transaction: async (fn) => fn(tx) };
  const service = new FinishedGoodsOutboundService(prisma, audit, { finishedGoodsBalance: async () => decimal(10) });
  await service.postOutbound("outbound-1", user);
  assert.equal(postedData.status, "posted");
  assert.match(postedData.riskReason, /超过订单计划量/);
});

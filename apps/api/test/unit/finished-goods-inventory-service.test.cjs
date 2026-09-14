const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { FinishedGoodsInventoryService } = require("../../dist/modules/warehouse/finished-goods-inventory.service.js");

// 成品入库/不良品单据：创建、过账、冲销与库存事实。
// 全部用手写假 Prisma（含 $queryRaw 行锁桩），不连数据库；断言返回值、异常机器码与传给 Prisma 的查询形状。

const USER = { id: "user-1" };
const dec = (value) => new Prisma.Decimal(value);

function qcRow(overrides = {}) {
  return {
    id: "qc-1",
    qcNo: "QC-0001",
    orderNo: "SO-1",
    productionOrderId: "po-1",
    submissionId: "sub-1",
    status: "active",
    deletedAt: null,
    qualifiedQuantity: dec("10"),
    conditionalAcceptQuantity: dec("2"),
    rejectedQuantity: dec("3"),
    submission: {
      id: "sub-1",
      status: "qc_completed",
      unitId: "unit-1",
      productNameSnapshot: "蓝色折叠伞",
      productSpecificationSnapshot: "24骨",
      sourceType: "manual",
      sourceId: null,
    },
    ...overrides,
  };
}

function inboundRow(overrides = {}) {
  return {
    id: "inbound-1",
    inboundNo: "FGI-20260101-AAAAAAAA",
    orderNo: "SO-1",
    productionOrderId: "po-1",
    qcRecordId: "qc-1",
    submissionId: "sub-1",
    unitId: "unit-1",
    productNameSnapshot: "蓝色折叠伞",
    productSpecificationSnapshot: "24骨",
    quantity: dec("4"),
    status: "draft",
    remark: null,
    deletedAt: null,
    inventoryFacts: [],
    qcRecord: qcRow(),
    ...overrides,
  };
}

function defectiveRow(overrides = {}) {
  return {
    id: "defective-1",
    defectiveNo: "FGD-20260101-BBBBBBBB",
    orderNo: "SO-1",
    productionOrderId: "po-1",
    qcRecordId: "qc-1",
    submissionId: "sub-1",
    unitId: "unit-1",
    productNameSnapshot: "蓝色折叠伞",
    productSpecificationSnapshot: "24骨",
    quantity: dec("2"),
    status: "draft",
    remark: null,
    deletedAt: null,
    inventoryFacts: [],
    ...overrides,
  };
}

/** 手写假 Prisma：记录每次调用的入参，便于断言 where / data 形状与「失败时不写入」。 */
function harness(config = {}) {
  const qc = config.qc === undefined ? qcRow() : config.qc;
  const current = config.current === undefined ? inboundRow() : config.current;
  const locked = config.locked === undefined ? current : config.locked;
  const currentDefective = config.currentDefective === undefined ? defectiveRow() : config.currentDefective;
  const lockedDefective = config.lockedDefective === undefined ? currentDefective : config.lockedDefective;
  const resolve = (value, where) => (typeof value === "function" ? value(where) : value);

  const calls = {
    locks: [], transactions: 0, qcWhere: [], inboundWhere: [], defectiveWhere: [],
    inboundAggregate: [], defectiveAggregate: [], inboundCreate: [], defectiveCreate: [],
    inboundUpdate: [], defectiveUpdate: [], inboundFindMany: [], defectiveFindMany: [],
    factFindFirst: [], factCreate: [], noticeFindFirst: [], noticeUpdate: [],
    submissionFindMany: [], balances: [], audits: [],
  };

  const audit = {
    create: () => ({ createdBy: USER.id, updatedBy: USER.id }),
    update: () => ({ updatedBy: USER.id }),
    record: async (...args) => { calls.audits.push(args); },
  };
  const inventory = {
    finishedGoodsBalance: async (_client, productionOrderId, unitId, category) => {
      calls.balances.push({ productionOrderId, unitId, category });
      return config.balance === undefined ? dec("0") : config.balance;
    },
  };

  const tx = {
    $queryRaw: async (strings) => { calls.locks.push(Array.isArray(strings) ? strings.join(" ? ") : String(strings)); return []; },
    finishedGoodsQcRecord: {
      // 替身必须像数据库一样执行 where：qc 被停用/软删/换 id 时不能命中
      findFirst: async ({ where }) => {
        calls.qcWhere.push({ scope: "tx", where });
        if (!qc) return null;
        if (where?.id && qc.id !== where.id) return null;
        if (where?.deletedAt === null && qc.deletedAt) return null;
        if (where?.status && qc.status !== where.status) return null;
        return qc;
      },
    },
    finishedGoodsInbound: {
      findFirst: async ({ where }) => { calls.inboundWhere.push({ scope: "tx", where }); return locked; },
      aggregate: async ({ where }) => { calls.inboundAggregate.push({ scope: "tx", where }); return { _sum: { quantity: resolve(config.inboundUsed, where) ?? null } }; },
      create: async ({ data }) => { calls.inboundCreate.push(data); return { id: "inbound-new", ...data }; },
      update: async ({ where, data }) => {
        calls.inboundUpdate.push({ scope: "tx", where, data });
        return { id: where.id, orderNo: current.orderNo, quantity: current.quantity, ...data };
      },
    },
    finishedGoodsDefective: {
      findFirst: async ({ where }) => { calls.defectiveWhere.push({ scope: "tx", where }); return lockedDefective; },
      aggregate: async ({ where }) => { calls.defectiveAggregate.push({ scope: "tx", where }); return { _sum: { quantity: resolve(config.defectiveUsed, where) ?? null } }; },
      create: async ({ data }) => { calls.defectiveCreate.push(data); return { id: "defective-new", ...data }; },
      update: async ({ where, data }) => {
        calls.defectiveUpdate.push({ scope: "tx", where, data });
        return { id: where.id, orderNo: currentDefective.orderNo, quantity: currentDefective.quantity, ...data };
      },
    },
    inventoryFact: {
      findFirst: async ({ where }) => { calls.factFindFirst.push(where); return config.existingFact ?? null; },
      create: async ({ data }) => { calls.factCreate.push(data); return { id: "fact-new", ...data }; },
    },
    finishedGoodsInboundNotice: {
      findFirst: async (args) => { calls.noticeFindFirst.push(args); return config.notice ?? null; },
      update: async ({ where, data }) => { calls.noticeUpdate.push({ where, data }); return { id: where.id, ...data }; },
    },
    finishedGoodsInspectionSubmission: {
      findMany: async ({ where }) => { calls.submissionFindMany.push(where); return config.submissions ?? []; },
    },
  };

  const prisma = {
    ...tx,
    finishedGoodsInbound: {
      ...tx.finishedGoodsInbound,
      findFirst: async ({ where }) => { calls.inboundWhere.push({ scope: "root", where }); return current; },
      findMany: async (args) => { calls.inboundFindMany.push(args); return config.inboundList ?? [current]; },
    },
    finishedGoodsDefective: {
      ...tx.finishedGoodsDefective,
      findFirst: async ({ where }) => { calls.defectiveWhere.push({ scope: "root", where }); return currentDefective; },
      findMany: async (args) => { calls.defectiveFindMany.push(args); return config.defectiveList ?? [currentDefective]; },
    },
    $transaction: async (fn) => { calls.transactions += 1; return fn(tx); },
  };

  return { calls, service: new FinishedGoodsInventoryService(prisma, audit, inventory) };
}

const assertCode = (code) => (error) => {
  assert.equal(error.getResponse().code, code);
  return true;
};

// ---------------------------------------------------------------- 列表查询

test("finished-goods-inventory.listInbounds_scopes_to_live_rows", async () => {
  const h = harness();
  const rows = await h.service.listInbounds();
  assert.equal(rows.length, 1);
  assert.deepEqual(h.calls.inboundFindMany[0], {
    where: { deletedAt: null },
    include: { inventoryFacts: true, qcRecord: true },
    orderBy: { createdAt: "desc" },
  });
});

test("finished-goods-inventory.listInbounds_filters_by_order_no", async () => {
  const h = harness();
  await h.service.listInbounds("SO-9");
  assert.deepEqual(h.calls.inboundFindMany[0].where, { deletedAt: null, orderNo: "SO-9" });
  // 空订单号不得生成 orderNo 过滤（否则列表会被空串过滤成空）
  const empty = harness();
  await empty.service.listInbounds("");
  assert.deepEqual(empty.calls.inboundFindMany[0].where, { deletedAt: null });
});

test("finished-goods-inventory.listDefectives_filters_by_order_no", async () => {
  const h = harness();
  await h.service.listDefectives("SO-9");
  assert.deepEqual(h.calls.defectiveFindMany[0], {
    where: { deletedAt: null, orderNo: "SO-9" },
    include: { inventoryFacts: true, qcRecord: true },
    orderBy: { createdAt: "desc" },
  });
});

// ---------------------------------------------------------------- 创建成品入库单

test("finished-goods-inventory.createInbound_persists_qc_snapshot_and_locks_qc_row", async () => {
  const h = harness({ inboundUsed: dec("2") });
  const row = await h.service.createInbound({ qc_record_id: "qc-1", quantity: "4", remark: "首批" }, USER);

  // 先锁 QC 行再读取（并发下保证可用量判定串行）
  assert.match(h.calls.locks[0], /finished_goods_qc_records/);
  assert.match(h.calls.locks[0], /FOR UPDATE/);
  assert.deepEqual(h.calls.qcWhere[0].where, { id: "qc-1", deletedAt: null, status: "active" });

  // 可用量口径：合格 10 + 条件接收 2 − 已用（草稿+已过账）2 = 10
  assert.deepEqual(h.calls.inboundAggregate[0].where, {
    qcRecordId: "qc-1", deletedAt: null, status: { in: ["draft", "posted"] },
  });

  const data = h.calls.inboundCreate[0];
  assert.match(data.inboundNo, /^FGI-\d{8}-[0-9A-F]{8}$/);
  assert.equal(data.orderNo, "SO-1");
  assert.equal(data.productionOrderId, "po-1");
  assert.equal(data.qcRecordId, "qc-1");
  assert.equal(data.submissionId, "sub-1");
  assert.equal(data.unitId, "unit-1");
  assert.equal(data.productNameSnapshot, "蓝色折叠伞");
  assert.equal(data.productSpecificationSnapshot, "24骨");
  assert.equal(data.quantity.toString(), "4");
  assert.equal(data.remark, "首批");
  assert.equal(data.createdBy, "user-1");
  assert.equal(data.updatedBy, "user-1");
  // 草稿态由 schema 默认值给出（FinishedGoodsInbound.status @default("draft")），服务不显式传
  assert.equal("status" in data, false);
  assert.match(data.idempotencyKey, /^draft:/);

  assert.equal(row.id, "inbound-new");
  assert.deepEqual(h.calls.audits, [[
    "finished_goods_inbound.create", "finished_goods_inbound", "user-1", "inbound-new",
    { order_no: "SO-1", qc_record_id: "qc-1", quantity: "4" },
  ]]);
  // 来源不是入库通知时不得触碰通知状态
  assert.equal(h.calls.noticeFindFirst.length, 0);
  assert.equal(h.calls.noticeUpdate.length, 0);
});

test("finished-goods-inventory.createInbound_trims_idempotency_key", async () => {
  const h = harness();
  await h.service.createInbound({ qc_record_id: "qc-1", quantity: "1", idempotency_key: "  key-1  " }, USER);
  assert.equal(h.calls.inboundCreate[0].idempotencyKey, "key-1");
});

test("finished-goods-inventory.createInbound_blank_idempotency_key_falls_back_to_draft_uuid", async () => {
  for (const key of [undefined, "", "   "]) {
    const h = harness();
    await h.service.createInbound({ qc_record_id: "qc-1", quantity: "1", idempotency_key: key }, USER);
    const generated = h.calls.inboundCreate[0].idempotencyKey;
    assert.match(generated, /^draft:[0-9a-f-]{36}$/, `idempotency_key=${JSON.stringify(key)} 应回落到 draft:uuid`);
  }
});

test("finished-goods-inventory.createInbound_passes_long_remark_through_without_truncation", async () => {
  // 边界（超长）：备注长度上限 MaxLength(1000) 只声明在 controller DTO
  // （finished-goods-inventory.controller.ts:10），服务层不校验、不截断——直接调用服务可写入超长备注。
  const longRemark = "备".repeat(5000);
  const h = harness();
  await h.service.createInbound({ qc_record_id: "qc-1", quantity: "1", remark: longRemark }, USER);
  assert.equal(h.calls.inboundCreate[0].remark.length, 5000);
  assert.equal(h.calls.inboundCreate[0].remark, longRemark);
});

test("finished-goods-inventory.createInbound_rejects_non_positive_and_non_numeric_quantity_without_write", async () => {
  for (const value of ["0", "0.0", "-1", "-0.5", "", "   ", "abc", "5,5", null, undefined]) {
    const h = harness();
    await assert.rejects(
      () => h.service.createInbound({ qc_record_id: "qc-1", quantity: value }, USER),
      assertCode("INVALID_FINISHED_GOODS_INBOUND_QUANTITY"),
      `quantity=${JSON.stringify(value)} 必须被拒绝`,
    );
    assert.equal(h.calls.transactions, 0, "数量非法时不应开启事务");
    assert.equal(h.calls.inboundCreate.length, 0, "数量非法时不得写入");
    assert.equal(h.calls.audits.length, 0, "数量非法时不得记审计");
  }
});

test("finished-goods-inventory.createInbound_accepts_quantity_equal_to_available_boundary", async () => {
  // 可用量 12，取满 12 应通过（边界是 gt 而非 gte）
  const h = harness({ inboundUsed: dec("0") });
  await h.service.createInbound({ qc_record_id: "qc-1", quantity: "12" }, USER);
  assert.equal(h.calls.inboundCreate[0].quantity.toString(), "12");
});

test("finished-goods-inventory.createInbound_rejects_quantity_over_available_without_write", async () => {
  const h = harness({ inboundUsed: dec("2") }); // 可用 10
  await assert.rejects(
    () => h.service.createInbound({ qc_record_id: "qc-1", quantity: "10.0001" }, USER),
    (error) => {
      assert.equal(error.getResponse().code, "FINISHED_GOODS_INBOUND_QUANTITY_EXCEEDED");
      assert.deepEqual(error.getResponse().details, [{ available_quantity: "10" }]);
      return true;
    },
  );
  assert.equal(h.calls.inboundCreate.length, 0, "超量时不得写入");
  assert.equal(h.calls.audits.length, 0);
});

test("finished-goods-inventory.createInbound_uses_exact_decimal_precision_for_available", async () => {
  // 合格 0.3、已用 0.1 → 可用 0.2；0.2 通过，0.200000000000000000001 被拒（十进制定点，不是浮点）
  const lowQc = () => qcRow({ qualifiedQuantity: dec("0.3"), conditionalAcceptQuantity: dec("0") });
  const exact = harness({ qc: lowQc(), inboundUsed: dec("0.1") });
  await exact.service.createInbound({ qc_record_id: "qc-1", quantity: "0.2" }, USER);
  assert.equal(exact.calls.inboundCreate[0].quantity.toString(), "0.2");

  const over = harness({ qc: lowQc(), inboundUsed: dec("0.1") });
  await assert.rejects(
    () => over.service.createInbound({ qc_record_id: "qc-1", quantity: "0.200000000000000000001" }, USER),
    assertCode("FINISHED_GOODS_INBOUND_QUANTITY_EXCEEDED"),
  );
  assert.equal(over.calls.inboundCreate.length, 0);
});

test("finished-goods-inventory.createInbound_passes_sub_scale_quantity_through_unrounded", async () => {
  // 边界：服务不做小数位截断，>4 位小数原样传给 Prisma（列为 Decimal(18,4)，落库是否会四舍五入未验证）
  const h = harness();
  await h.service.createInbound({ qc_record_id: "qc-1", quantity: "0.00001" }, USER);
  assert.equal(h.calls.inboundCreate[0].quantity.toString(), "0.00001");
});

test("finished-goods-inventory.createInbound_rejects_infinite_quantity_with_exceeded_code", async () => {
  // 非法但被拒绝：完全部落在 gt(available) 分支，错误码是「超额」而不是「数量非法」
  const h = harness();
  await assert.rejects(
    () => h.service.createInbound({ qc_record_id: "qc-1", quantity: "Infinity" }, USER),
    assertCode("FINISHED_GOODS_INBOUND_QUANTITY_EXCEEDED"),
  );
  assert.equal(h.calls.inboundCreate.length, 0);
});

// NaN 必须与 "abc" 一样被拒绝：裸 `new Prisma.Decimal(value)` 会接受 "NaN"（NaN.lte(0) 为 false），
// 写进库存事实后该生产单的成品余额恒为 NaN，出库侧所有数量校验一起失效。
// 注意：亚标度数量（>4 位小数）与 Infinity 仍按原契约处理（原样通过 / 落到可用量比较），
// 本服务刻意不套用出库侧的 B13 四小数正则。
test("finished-goods-inventory.createInbound_rejects_nan_quantity", async () => {
  for (const value of ["NaN"]) {
    const h = harness();
    await assert.rejects(
      () => h.service.createInbound({ qc_record_id: "qc-1", quantity: value }, USER),
      assertCode("INVALID_FINISHED_GOODS_INBOUND_QUANTITY"),
      `quantity=${JSON.stringify(value)} 必须被拒绝`,
    );
    assert.equal(h.calls.inboundCreate.length, 0, "数量非法时不得写入");
  }
});

test("finished-goods-inventory.createInbound_rejects_unavailable_qc_without_write", async () => {
  const cases = [
    ["qc 不存在", null],
    ["qc 已停用", qcRow({ status: "corrected" })],
    ["送检单未提交", qcRow({ submission: { ...qcRow().submission, status: "draft" } })],
    ["送检单已取消", qcRow({ submission: { ...qcRow().submission, status: "cancelled" } })],
  ];
  for (const [label, qc] of cases) {
    const h = harness({ qc });
    await assert.rejects(
      () => h.service.createInbound({ qc_record_id: "qc-1", quantity: "1" }, USER),
      assertCode("FINISHED_GOODS_QC_NOT_AVAILABLE"),
      label,
    );
    assert.equal(h.calls.inboundCreate.length, 0, `${label}：不得写入`);
    assert.equal(h.calls.locks.length, 1, `${label}：读取 QC 前已对该行加锁`);
  }
});

test("finished-goods-inventory.createInbound_syncs_source_notice_status", async () => {
  const sourceSubmission = { ...qcRow().submission, sourceType: "finished_goods_inbound_notice", sourceId: "notice-1" };
  const h = harness({
    qc: qcRow({ submission: sourceSubmission }),
    notice: { id: "notice-1", status: "pending", noticeQuantity: dec("10") },
    submissions: [{ id: "sub-1", submittedQuantity: dec("10"), status: "qc_completed" }],
    // 通知量已全部送检，但本单是草稿（在途 4）→ 通知必须保持「进行中」而不是已完成
    inboundUsed: (where) => (where.submissionId ? dec("4") : dec("0")),
  });
  await h.service.createInbound({ qc_record_id: "qc-1", quantity: "4" }, USER);

  assert.deepEqual(h.calls.noticeFindFirst[0], { where: { id: "notice-1", deletedAt: null }, select: { id: true, status: true, noticeQuantity: true } });
  assert.equal(h.calls.noticeUpdate.length, 1);
  assert.deepEqual(h.calls.noticeUpdate[0].where, { id: "notice-1" });
  assert.equal(h.calls.noticeUpdate[0].data.status, "partially_inbound");
  assert.deepEqual(h.calls.noticeUpdate[0].data.version, { increment: 1 });
  assert.equal(h.calls.noticeUpdate[0].data.updatedBy, "user-1");
});

// ---------------------------------------------------------------- 创建不良品单

test("finished-goods-inventory.createDefective_persists_qc_snapshot_and_no_notice_side_effect", async () => {
  const sourceSubmission = { ...qcRow().submission, sourceType: "finished_goods_inbound_notice", sourceId: "notice-1" };
  const h = harness({ qc: qcRow({ submission: sourceSubmission }), defectiveUsed: dec("1") }); // 不合格 3 − 已登记 1 = 2
  const row = await h.service.createDefective({ qc_record_id: "qc-1", quantity: "2", remark: "划伤" }, USER);

  assert.match(h.calls.locks[0], /finished_goods_qc_records/);
  assert.deepEqual(h.calls.defectiveAggregate[0].where, {
    qcRecordId: "qc-1", deletedAt: null, status: { in: ["draft", "posted"] },
  });
  const data = h.calls.defectiveCreate[0];
  assert.match(data.defectiveNo, /^FGD-\d{8}-[0-9A-F]{8}$/);
  assert.equal(data.orderNo, "SO-1");
  assert.equal(data.qcRecordId, "qc-1");
  assert.equal(data.submissionId, "sub-1");
  assert.equal(data.unitId, "unit-1");
  assert.equal(data.quantity.toString(), "2");
  assert.equal(data.remark, "划伤");
  assert.equal("status" in data, false);
  assert.match(data.idempotencyKey, /^draft:/);
  assert.equal(row.id, "defective-new");
  assert.deepEqual(h.calls.audits, [[
    "finished_goods_defective.create", "finished_goods_defective", "user-1", "defective-new",
    { order_no: "SO-1", qc_record_id: "qc-1", quantity: "2" },
  ]]);
  // 次品草稿不是「在途入库」，不得改动来源通知状态
  assert.equal(h.calls.noticeFindFirst.length, 0);
  assert.equal(h.calls.noticeUpdate.length, 0);
});

test("finished-goods-inventory.createDefective_rejects_quantity_over_rejected_available_without_write", async () => {
  const h = harness({ defectiveUsed: dec("1") }); // 可用 2
  await assert.rejects(
    () => h.service.createDefective({ qc_record_id: "qc-1", quantity: "2.01" }, USER),
    (error) => {
      assert.equal(error.getResponse().code, "FINISHED_GOODS_DEFECTIVE_QUANTITY_EXCEEDED");
      assert.deepEqual(error.getResponse().details, [{ available_quantity: "2" }]);
      return true;
    },
  );
  assert.equal(h.calls.defectiveCreate.length, 0);
  assert.equal(h.calls.audits.length, 0);
});

test("finished-goods-inventory.createDefective_rejects_non_positive_quantity_without_write", async () => {
  for (const value of ["0", "-2", "", "abc"]) {
    const h = harness();
    await assert.rejects(
      () => h.service.createDefective({ qc_record_id: "qc-1", quantity: value }, USER),
      assertCode("INVALID_FINISHED_GOODS_DEFECTIVE_QUANTITY"),
      `quantity=${JSON.stringify(value)} 必须被拒绝`,
    );
    assert.equal(h.calls.transactions, 0);
    assert.equal(h.calls.defectiveCreate.length, 0, "数量非法时不得写入");
  }
});

// 不良品登记同样走 B13 守卫：NaN 不得写进次品库存事实。
test("finished-goods-inventory.createDefective_rejects_nan_quantity", async () => {
  const h = harness();
  await assert.rejects(
    () => h.service.createDefective({ qc_record_id: "qc-1", quantity: "NaN" }, USER),
    assertCode("INVALID_FINISHED_GOODS_DEFECTIVE_QUANTITY"),
  );
  assert.equal(h.calls.defectiveCreate.length, 0, "数量非法时不得写入");
});

// ---------------------------------------------------------------- 入库过账

test("finished-goods-inventory.postInbound_rejects_unknown_id_without_transaction", async () => {
  const h = harness({ current: null });
  await assert.rejects(() => h.service.postInbound("inbound-404", USER), assertCode("FINISHED_GOODS_INBOUND_NOT_FOUND"));
  assert.equal(h.calls.transactions, 0, "单据不存在时不应开启事务");
  assert.equal(h.calls.locks.length, 0);
  assert.equal(h.calls.inboundUpdate.length, 0);
  assert.equal(h.calls.factCreate.length, 0);
});

test("finished-goods-inventory.postInbound_rejects_non_draft_status_without_write", async () => {
  for (const status of ["posted", "reversed", "cancelled"]) {
    const h = harness({ current: inboundRow({ status }) });
    await assert.rejects(
      () => h.service.postInbound("inbound-1", USER),
      assertCode("FINISHED_GOODS_INBOUND_NOT_POSTABLE"),
      `status=${status} 不可过账`,
    );
    assert.equal(h.calls.transactions, 0);
    assert.equal(h.calls.factCreate.length, 0, `${status}：不得写库存事实`);
  }
});

test("finished-goods-inventory.postInbound_rejects_when_inventory_fact_exists_without_write", async () => {
  const h = harness({ existingFact: { id: "fact-1" } });
  await assert.rejects(() => h.service.postInbound("inbound-1", USER), assertCode("FINISHED_GOODS_INBOUND_ALREADY_POSTED"));
  assert.deepEqual(h.calls.factFindFirst[0], { finishedGoodsInboundId: "inbound-1", sourceType: "finished_goods_inbound" });
  assert.equal(h.calls.inboundUpdate.length, 0, "已过账时不得再更新单据");
  assert.equal(h.calls.factCreate.length, 0);
});

test("finished-goods-inventory.postInbound_rejects_status_race_after_lock", async () => {
  const h = harness({ current: inboundRow({ status: "draft" }), locked: inboundRow({ status: "posted" }) });
  await assert.rejects(() => h.service.postInbound("inbound-1", USER), assertCode("FINISHED_GOODS_INBOUND_ALREADY_POSTED"));
  assert.equal(h.calls.inboundUpdate.length, 0);
  assert.equal(h.calls.factCreate.length, 0);
});

test("finished-goods-inventory.postInbound_rejects_quantity_over_available_excluding_self", async () => {
  // 合格 12，其他单已用 10 → 排除本单后可用 2；本单 3 超量
  const h = harness({ current: inboundRow({ quantity: dec("3") }), inboundUsed: dec("10") });
  await assert.rejects(
    () => h.service.postInbound("inbound-1", USER),
    (error) => {
      assert.equal(error.getResponse().code, "FINISHED_GOODS_INBOUND_QUANTITY_EXCEEDED");
      assert.deepEqual(error.getResponse().details, [{ available_quantity: "2" }]);
      return true;
    },
  );
  // 关键回归：过账校验必须排除本单自己，否则任何草稿单都过不了账
  assert.deepEqual(h.calls.inboundAggregate[0].where, {
    qcRecordId: "qc-1", deletedAt: null, status: { in: ["draft", "posted"] }, id: { not: "inbound-1" },
  });
  assert.equal(h.calls.inboundUpdate.length, 0, "超量时不得过账");
  assert.equal(h.calls.factCreate.length, 0, "超量时不得写库存事实");
});

test("finished-goods-inventory.postInbound_posts_and_writes_finished_goods_fact", async () => {
  const h = harness({ current: inboundRow({ status: "draft", quantity: dec("4") }) });
  const row = await h.service.postInbound("inbound-1", USER);

  // 先锁单据行、再锁 QC 行
  assert.match(h.calls.locks[0], /finished_goods_inbounds/);
  assert.match(h.calls.locks[1], /finished_goods_qc_records/);
  assert.deepEqual(h.calls.inboundUpdate[0], {
    scope: "tx",
    where: { id: "inbound-1" },
    data: { status: "posted", idempotencyKey: "post:inbound-1", updatedBy: "user-1" },
  });
  assert.deepEqual(h.calls.factCreate[0], {
    finishedGoodsInboundId: "inbound-1",
    materialId: null,
    unitId: "unit-1",
    inventoryCategory: "finished_goods",
    quantityDelta: dec("4"),
    sourceType: "finished_goods_inbound",
    sourceId: "inbound-1",
    orderNo: "SO-1",
    productionOrderId: "po-1",
    productNameSnapshot: "蓝色折叠伞",
    productSpecificationSnapshot: "24骨",
    createdBy: "user-1",
  });
  assert.equal(row.status, "posted");
  assert.deepEqual(h.calls.audits, [[
    "finished_goods_inbound.post", "finished_goods_inbound", "user-1", "inbound-1",
    { order_no: "SO-1", quantity: "4" },
  ]]);
  assert.equal(h.calls.noticeUpdate.length, 0, "来源不是通知时不得改动通知状态");
});

test("finished-goods-inventory.postInbound_allows_quantity_equal_to_remaining_available", async () => {
  const h = harness({ current: inboundRow({ quantity: dec("12") }), inboundUsed: dec("0") }); // 12 − 0 = 12
  await h.service.postInbound("inbound-1", USER);
  assert.equal(h.calls.factCreate.length, 1);
  assert.equal(h.calls.factCreate[0].quantityDelta.toString(), "12");
});

test("finished-goods-inventory.postInbound_syncs_source_notice_after_posting", async () => {
  const sourceSubmission = { ...qcRow().submission, sourceType: "finished_goods_inbound_notice", sourceId: "notice-1" };
  const h = harness({
    current: inboundRow({ status: "draft", quantity: dec("4"), qcRecord: qcRow({ submission: sourceSubmission }) }),
    notice: { id: "notice-1", status: "partially_inbound", noticeQuantity: dec("10") },
    submissions: [{ id: "sub-1", submittedQuantity: dec("10"), status: "qc_completed" }],
    inboundUsed: (where) => (where.submissionId ? dec("0") : dec("0")),
  });
  await h.service.postInbound("inbound-1", USER);
  assert.deepEqual(h.calls.noticeFindFirst[0].where, { id: "notice-1", deletedAt: null });
  assert.equal(h.calls.noticeUpdate[0].data.status, "completed", "无在途草稿且已全部送检 → 通知完成");
});

// ---------------------------------------------------------------- 不良品过账

test("finished-goods-inventory.postDefective_rejects_unknown_id_without_transaction", async () => {
  const h = harness({ currentDefective: null });
  await assert.rejects(() => h.service.postDefective("defective-404", USER), assertCode("FINISHED_GOODS_DEFECTIVE_NOT_FOUND"));
  assert.equal(h.calls.transactions, 0);
  assert.equal(h.calls.factCreate.length, 0);
});

test("finished-goods-inventory.postDefective_rejects_non_draft_status_without_write", async () => {
  const h = harness({ currentDefective: defectiveRow({ status: "reversed" }) });
  await assert.rejects(() => h.service.postDefective("defective-1", USER), assertCode("FINISHED_GOODS_DEFECTIVE_NOT_POSTABLE"));
  assert.equal(h.calls.transactions, 0);
  assert.equal(h.calls.defectiveUpdate.length, 0);
  assert.equal(h.calls.factCreate.length, 0);
});

test("finished-goods-inventory.postDefective_rejects_quantity_over_rejected_available", async () => {
  const h = harness({ currentDefective: defectiveRow({ quantity: dec("3") }), defectiveUsed: dec("1") }); // 3 − 1 = 2
  await assert.rejects(
    () => h.service.postDefective("defective-1", USER),
    (error) => {
      assert.equal(error.getResponse().code, "FINISHED_GOODS_DEFECTIVE_QUANTITY_EXCEEDED");
      assert.deepEqual(error.getResponse().details, [{ available_quantity: "2" }]);
      return true;
    },
  );
  assert.deepEqual(h.calls.defectiveAggregate[0].where, {
    qcRecordId: "qc-1", deletedAt: null, status: { in: ["draft", "posted"] }, id: { not: "defective-1" },
  });
  assert.equal(h.calls.defectiveUpdate.length, 0);
  assert.equal(h.calls.factCreate.length, 0);
});

test("finished-goods-inventory.postDefective_writes_defective_goods_fact", async () => {
  const h = harness({ currentDefective: defectiveRow({ status: "draft", quantity: dec("2") }), defectiveUsed: dec("0") });
  const row = await h.service.postDefective("defective-1", USER);

  assert.match(h.calls.locks[0], /finished_goods_defectives/);
  assert.match(h.calls.locks[1], /finished_goods_qc_records/);
  assert.deepEqual(h.calls.defectiveUpdate[0].data, { status: "posted", idempotencyKey: "post:defective-1", updatedBy: "user-1" });
  assert.deepEqual(h.calls.factCreate[0], {
    finishedGoodsDefectiveId: "defective-1",
    materialId: null,
    unitId: "unit-1",
    inventoryCategory: "defective_goods",
    quantityDelta: dec("2"),
    sourceType: "finished_goods_defective",
    sourceId: "defective-1",
    orderNo: "SO-1",
    productionOrderId: "po-1",
    productNameSnapshot: "蓝色折叠伞",
    productSpecificationSnapshot: "24骨",
    createdBy: "user-1",
  });
  assert.equal(row.status, "posted");
  assert.deepEqual(h.calls.audits, [[
    "finished_goods_defective.post", "finished_goods_defective", "user-1", "defective-1",
    { order_no: "SO-1", quantity: "2" },
  ]]);
});

// ---------------------------------------------------------------- 入库冲销

test("finished-goods-inventory.reverseInbound_rejects_blank_reason_before_any_read", async () => {
  for (const reason of [undefined, null, "", "   "]) {
    const h = harness({ current: inboundRow({ status: "posted" }) });
    await assert.rejects(
      () => h.service.reverseInbound("inbound-1", { reason }, USER),
      assertCode("REVERSAL_REASON_REQUIRED"),
      `reason=${JSON.stringify(reason)} 必须被拒绝`,
    );
    assert.equal(h.calls.inboundWhere.length, 0, "理由缺失时连单据都不该读");
    assert.equal(h.calls.transactions, 0);
    assert.equal(h.calls.inboundUpdate.length, 0, "理由缺失时不得冲销");
    assert.equal(h.calls.factCreate.length, 0, "理由缺失时不得写冲销事实");
  }
});

test("finished-goods-inventory.reverseInbound_rejects_unknown_id_without_transaction", async () => {
  const h = harness({ current: null });
  await assert.rejects(
    () => h.service.reverseInbound("inbound-404", { reason: "登记错误" }, USER),
    assertCode("FINISHED_GOODS_INBOUND_NOT_FOUND"),
  );
  assert.equal(h.calls.transactions, 0);
  assert.equal(h.calls.factCreate.length, 0);
});

test("finished-goods-inventory.reverseInbound_rejects_unposted_status_without_write", async () => {
  for (const status of ["draft", "reversed"]) {
    const h = harness({ current: inboundRow({ status }) });
    await assert.rejects(
      () => h.service.reverseInbound("inbound-1", { reason: "登记错误" }, USER),
      assertCode("FINISHED_GOODS_INBOUND_NOT_REVERSIBLE"),
      `status=${status} 不可冲销`,
    );
    assert.equal(h.calls.transactions, 0);
    assert.equal(h.calls.inboundUpdate.length, 0, `${status}：不得更新单据`);
  }
});

test("finished-goods-inventory.reverseInbound_rejects_insufficient_balance_without_write", async () => {
  const h = harness({ current: inboundRow({ status: "posted", quantity: dec("5") }), balance: dec("4") });
  await assert.rejects(
    () => h.service.reverseInbound("inbound-1", { reason: "登记错误" }, USER),
    assertCode("INVENTORY_INSUFFICIENT"),
  );
  assert.deepEqual(h.calls.balances, [{ productionOrderId: "po-1", unitId: "unit-1", category: "finished_goods" }]);
  assert.equal(h.calls.inboundUpdate.length, 0, "库存不足时不得冲销");
  assert.equal(h.calls.factCreate.length, 0, "库存不足时不得写负数事实");
  assert.equal(h.calls.audits.length, 0);
});

test("finished-goods-inventory.reverseInbound_allows_exact_balance_boundary_and_writes_negated_fact", async () => {
  // 库存 5、单据 5 → 冲销后为 0（isNegative 才拒绝），允许冲销
  const h = harness({
    current: inboundRow({ status: "posted", quantity: dec("5"), remark: "首次入库" }),
    balance: dec("5"),
  });
  const row = await h.service.reverseInbound("inbound-1", { reason: "登记错误" }, USER);

  assert.match(h.calls.locks[0], /finished_goods_inbounds/);
  assert.deepEqual(h.calls.inboundUpdate[0].data, {
    status: "reversed", remark: "首次入库\n冲销：登记错误", updatedBy: "user-1",
  });
  assert.deepEqual(h.calls.factCreate[0], {
    finishedGoodsInboundId: "inbound-1",
    materialId: null,
    unitId: "unit-1",
    inventoryCategory: "finished_goods",
    quantityDelta: dec("-5"),
    sourceType: "finished_goods_inbound_reversal",
    sourceId: "inbound-1",
    orderNo: "SO-1",
    productionOrderId: "po-1",
    productNameSnapshot: "蓝色折叠伞",
    productSpecificationSnapshot: "24骨",
    createdBy: "user-1",
  });
  assert.equal(row.status, "reversed");
  assert.deepEqual(h.calls.audits, [[
    "finished_goods_inbound.reverse", "finished_goods_inbound", "user-1", "inbound-1",
    { order_no: "SO-1", reason: "登记错误" },
  ]]);
});

test("finished-goods-inventory.reverseInbound_rejects_status_race_after_lock", async () => {
  const h = harness({
    current: inboundRow({ status: "posted", quantity: dec("1") }),
    locked: { status: "draft" },
    balance: dec("10"),
  });
  await assert.rejects(
    () => h.service.reverseInbound("inbound-1", { reason: "登记错误" }, USER),
    assertCode("FINISHED_GOODS_INBOUND_NOT_REVERSIBLE"),
  );
  assert.equal(h.calls.inboundUpdate.length, 0);
  assert.equal(h.calls.factCreate.length, 0);
});

test("finished-goods-inventory.reverseInbound_syncs_source_notice_back_to_completed", async () => {
  const sourceSubmission = { ...qcRow().submission, sourceType: "finished_goods_inbound_notice", sourceId: "notice-1" };
  const h = harness({
    current: inboundRow({
      status: "posted", quantity: dec("4"), remark: null,
      qcRecord: qcRow({ submission: sourceSubmission }),
    }),
    balance: dec("4"),
    notice: { id: "notice-1", status: "partially_inbound", noticeQuantity: dec("10") },
    submissions: [{ id: "sub-1", submittedQuantity: dec("10"), status: "qc_completed" }],
  });
  await h.service.reverseInbound("inbound-1", { reason: "登记错误" }, USER);
  assert.equal(h.calls.noticeUpdate.length, 1);
  assert.equal(h.calls.noticeUpdate[0].data.status, "completed", "冲销后没有在途入库 → 通知回到已完成");
});

// ---------------------------------------------------------------- 不良品冲销

test("finished-goods-inventory.reverseDefective_rejects_blank_reason_before_any_read", async () => {
  for (const reason of [undefined, "", "  "]) {
    const h = harness({ currentDefective: defectiveRow({ status: "posted" }) });
    await assert.rejects(
      () => h.service.reverseDefective("defective-1", { reason }, USER),
      assertCode("REVERSAL_REASON_REQUIRED"),
      `reason=${JSON.stringify(reason)} 必须被拒绝`,
    );
    assert.equal(h.calls.defectiveWhere.length, 0);
    assert.equal(h.calls.transactions, 0);
    assert.equal(h.calls.defectiveUpdate.length, 0, "理由缺失时不得冲销");
    assert.equal(h.calls.factCreate.length, 0);
  }
});

test("finished-goods-inventory.reverseDefective_rejects_unposted_status_without_write", async () => {
  const h = harness({ currentDefective: defectiveRow({ status: "draft" }) });
  await assert.rejects(
    () => h.service.reverseDefective("defective-1", { reason: "登记错误" }, USER),
    assertCode("FINISHED_GOODS_DEFECTIVE_NOT_REVERSIBLE"),
  );
  assert.equal(h.calls.transactions, 0);
  assert.equal(h.calls.defectiveUpdate.length, 0);
});

test("finished-goods-inventory.reverseDefective_rejects_insufficient_balance_without_write", async () => {
  const h = harness({ currentDefective: defectiveRow({ status: "posted", quantity: dec("3") }), balance: dec("2") });
  await assert.rejects(
    () => h.service.reverseDefective("defective-1", { reason: "登记错误" }, USER),
    assertCode("INVENTORY_INSUFFICIENT"),
  );
  assert.deepEqual(h.calls.balances, [{ productionOrderId: "po-1", unitId: "unit-1", category: "defective_goods" }]);
  assert.equal(h.calls.defectiveUpdate.length, 0);
  assert.equal(h.calls.factCreate.length, 0, "不良品库存不足时不得写负数事实");
});

test("finished-goods-inventory.reverseDefective_writes_negated_defective_fact", async () => {
  const h = harness({
    currentDefective: defectiveRow({ status: "posted", quantity: dec("3"), remark: null }),
    balance: dec("3"),
  });
  const row = await h.service.reverseDefective("defective-1", { reason: "误登记" }, USER);

  assert.deepEqual(h.calls.defectiveUpdate[0].data, {
    status: "reversed", remark: "\n冲销：误登记", updatedBy: "user-1",
  });
  assert.deepEqual(h.calls.factCreate[0], {
    finishedGoodsDefectiveId: "defective-1",
    materialId: null,
    unitId: "unit-1",
    inventoryCategory: "defective_goods",
    quantityDelta: dec("-3"),
    sourceType: "finished_goods_defective_reversal",
    sourceId: "defective-1",
    orderNo: "SO-1",
    productionOrderId: "po-1",
    productNameSnapshot: "蓝色折叠伞",
    productSpecificationSnapshot: "24骨",
    createdBy: "user-1",
  });
  assert.equal(row.status, "reversed");
  assert.deepEqual(h.calls.audits, [[
    "finished_goods_defective.reverse", "finished_goods_defective", "user-1", "defective-1",
    { order_no: "SO-1", reason: "误登记" },
  ]]);
  // 不良品冲销不参与入库通知状态推导
  assert.equal(h.calls.noticeFindFirst.length, 0);
});

// ---------------------------------------------------------------- 影响预览

test("finished-goods-inventory.impactPreview_reports_available_quantities", async () => {
  const h = harness({ inboundUsed: dec("4"), defectiveUsed: dec("1") });
  const preview = await h.service.impactPreview("qc-1");
  assert.deepEqual(preview, {
    qc_id: "qc-1",
    qc_no: "QC-0001",
    order_no: "SO-1",
    accepted_quantity: "12",
    rejected_quantity: "3",
    inbound_quantity: "4",
    defective_quantity: "1",
    available_for_inbound_quantity: "8",
    available_for_defective_quantity: "2",
  });
  assert.deepEqual(h.calls.inboundAggregate[0].where, { qcRecordId: "qc-1", deletedAt: null, status: { in: ["draft", "posted"] } });
  assert.deepEqual(h.calls.defectiveAggregate[0].where, { qcRecordId: "qc-1", deletedAt: null, status: { in: ["draft", "posted"] } });
});

test("finished-goods-inventory.impactPreview_without_usage_reports_full_availability", async () => {
  const h = harness(); // 聚合返回 null → 视为 0
  const preview = await h.service.impactPreview("qc-1");
  assert.equal(preview.inbound_quantity, "0");
  assert.equal(preview.defective_quantity, "0");
  assert.equal(preview.available_for_inbound_quantity, "12");
  assert.equal(preview.available_for_defective_quantity, "3");
});

test("finished-goods-inventory.impactPreview_rejects_unavailable_qc_without_reading_facts", async () => {
  const cases = [
    ["qc 不存在", null],
    ["qc 已更正", qcRow({ status: "corrected" })],
    ["送检单仍是草稿", qcRow({ submission: { ...qcRow().submission, status: "draft" } })],
  ];
  for (const [label, qc] of cases) {
    const h = harness({ qc });
    await assert.rejects(() => h.service.impactPreview("qc-1"), assertCode("FINISHED_GOODS_QC_NOT_AVAILABLE"), label);
    assert.equal(h.calls.inboundAggregate.length, 0, `${label}：不得聚合入库量`);
    assert.equal(h.calls.defectiveAggregate.length, 0, `${label}：不得聚合次品量`);
  }
});

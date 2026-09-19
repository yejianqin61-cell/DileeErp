// 销售单「下单口径细化」的单元测试（手写假 Prisma，不连数据库）。
//
// 依据：example/销售单 里的工艺单模板（两张样本），设计见
// docs/design/sales-order-spec-refinement-and-production-sheet-export-2026-09-16.md。
// 用户拍板：材料/工艺做成**固定字段**（两样本并集）、明细做成「一张通用表 + 分组名」。
//
// 本文件钉住五件事：
//   1. 字段清单本身（37 个标量）——顺序就是导出印刷顺序，少一个只会在 Excel 上变成一个空格子；
//   2. 创建时每个细化键都进 v1 快照（没填记 null），否则回看版本会以为当时没填过；
//   3. 更新语义：**没传 = 不动，空串 = 清除**（两者写反的后果正好相反）；
//   4. 明细是整体替换（老的软删 + 新的批量建），没传就整块不动；
//   5. 明细数量合计 vs 单头数量：不等要提示，单位不一致要说「无法核对」，都不硬拦。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { SalesOrdersService, SPEC_SCALAR_FIELDS, normalizeSpecUnit } = require("../../dist/modules/sales/sales-orders.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "sales", display_name: "销售测试" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => undefined };

const baseInput = (extra = {}) => ({
  order_no: "SO-SPEC-1", customer_id: "customer-1", order_date: "2026-09-16",
  product_name: "折叠伞", quantity: "1960", unit: "支", currency: "USD", ...extra,
});

/** 假 Prisma：salesOrder 的读写 + 版本 + 明细子表，全部记录入参。 */
function fakePrisma(options = {}) {
  const calls = { orderCreate: [], orderUpdate: [], versions: [], detailUpdateMany: [], detailCreateMany: [], findFirst: [] };
  const order = { id: "order-1", orderNo: "SO-SPEC-1", ...(options.order ?? {}) };
  const tx = {
    salesOrder: {
      create: async ({ data }) => { calls.orderCreate.push(data); return { id: "order-1", ...data }; },
      update: async ({ data }) => { calls.orderUpdate.push(data); return { id: "order-1", ...data }; },
    },
    salesOrderVersion: { create: async ({ data }) => { calls.versions.push(data); return data; } },
    salesOrderSpecDetail: {
      updateMany: async (args) => { calls.detailUpdateMany.push(args); return { count: 1 }; },
      createMany: async (args) => { calls.detailCreateMany.push(args); return { count: args.data.length }; },
    },
  };
  const prisma = {
    calls,
    customer: { findFirst: async () => ({ id: "customer-1", name: "客户甲", isActive: true }) },
    salesOrder: {
      findFirst: async (args) => {
        calls.findFirst.push(args);
        return {
          id: "order-1", orderNo: "SO-SPEC-1", customerId: "customer-1", contactId: null, status: "draft",
          currentVersion: 1, orderDate: new Date("2026-09-16"), productName: "折叠伞", productSpec: null,
          quantity: new Prisma.Decimal("1960"), unit: "支", currency: "USD", extensionData: {},
          customerSnapshot: {}, contactSnapshot: null, boms: [], versions: [], specDetails: [],
          ...(options.row ?? {}),
        };
      },
    },
    $transaction: async (fn) => fn(tx),
  };
  return prisma;
}

const service = (prisma) => new SalesOrdersService(prisma, audit);

// ---------------------------------------------------------------- 字段清单

test("细化字段清单：37 个标量、键与列都不重复，顺序就是导出印刷顺序", () => {
  assert.equal(SPEC_SCALAR_FIELDS.length, 37);
  const keys = SPEC_SCALAR_FIELDS.map(([key]) => key);
  const columns = SPEC_SCALAR_FIELDS.map(([, column]) => column);
  assert.equal(new Set(keys).size, keys.length, "请求键不能重复");
  assert.equal(new Set(columns).size, columns.length, "数据库列不能重复");
  // 顺序按模板：表头 → 布量 → 材料明细 → 工艺要求
  assert.equal(keys[0], "factory");
  assert.equal(keys[5], "fabric_usage_canopy");
  assert.equal(keys[10], "rib_spec", "伞骨是材料明细第一行（模板两张样本都是）");
  assert.equal(keys.at(-1), "qc_requirement", "质检报告是工艺要求最后一条");
  // 样本1/样本2 各自独有的字段都要在（并集才是完整清单）
  for (const key of ["handle_strap_spec", "strap_fastener_spec", "woven_label_spec", "top_fabric_spec", "wood_ear_spec", "keychain_spec", "printing_spec"]) {
    assert.ok(keys.includes(key), `两样本并集缺字段 ${key}`);
  }
});

// ------------------------------------------------------------------ 创建

test("创建：细化标量落列、明细建行、v1 快照每个键都在（没填记 null）", async () => {
  const prisma = fakePrisma();
  await service(prisma).create(baseInput({
    rib_spec: "50cm*5K三折手开双碳纤骨",
    wood_ear_spec: "本布木耳花+防水垫",
    fabric_usage_canopy: "1.2000",
    spec_details: [
      { group_name: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", quantity: "100", unit: "pcs" },
      { group_name: "伞布明细", name: "27621 花屋辻NV", color: "NV", quantity: "200", unit: "pcs" },
    ],
  }), user);

  const created = prisma.calls.orderCreate[0];
  assert.equal(created.ribSpec, "50cm*5K三折手开双碳纤骨");
  assert.equal(created.woodEarSpec, "本布木耳花+防水垫");
  assert.equal(created.fabricUsageCanopy, "1.2000");
  assert.equal(created.tailSpec, undefined, "没传的材料字段不进 create data（由列默认 null 兜底）");

  const rows = prisma.calls.detailCreateMany[0].data;
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { group: rows[0].groupName, name: rows[0].name, color: rows[0].color, quantity: rows[0].quantity, unit: rows[0].unit, sort: rows[0].sortOrder },
    { group: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", quantity: "100", unit: "pcs", sort: 0 },
  );
  assert.equal(rows[1].sortOrder, 1, "没给 sort_order 时按数组顺序补");
  assert.equal(rows[0].createdBy, user.id);

  const snapshot = prisma.calls.versions[0].snapshot;
  assert.equal(snapshot.version === undefined, true);
  for (const [key] of SPEC_SCALAR_FIELDS) assert.ok(key in snapshot, `v1 快照缺 ${key}`);
  assert.equal(snapshot.rib_spec, "50cm*5K三折手开双碳纤骨");
  assert.equal(snapshot.tail_spec, null, "没填的细化字段在快照里记 null，而不是缺键");
  assert.equal(snapshot.spec_details.length, 2, "这次请求带了明细，明细也进快照");
});

// ------------------------------------------------------------------ 更新

test("更新：没传的细化键不动，传空串 = 清除这一格", async () => {
  const prisma = fakePrisma({ row: { ribSpec: "旧伞骨", canopySpec: "旧伞布" } });
  await service(prisma).update("order-1", { rib_spec: "新伞骨", canopy_spec: "" }, user);

  const data = prisma.calls.orderUpdate[0];
  assert.equal(data.ribSpec, "新伞骨");
  assert.equal(data.canopySpec, null, "空串 = 清除这一格");
  assert.equal("tailSpec" in data, false, "没传的字段不许出现在 update data 里");
});

test("更新：传了明细就整块替换（老行软删 + 新行批量建），没传就不动", async () => {
  const replaced = fakePrisma();
  await service(replaced).update("order-1", { spec_details: [{ group_name: "伞头配色", name: "Hawái", barcode: "4894300069500", quantity: "167", unit: "打" }] }, user);
  assert.equal(replaced.calls.detailUpdateMany.length, 1, "先软删老行");
  assert.equal(replaced.calls.detailUpdateMany[0].where.salesOrderId, "order-1");
  assert.ok(replaced.calls.detailUpdateMany[0].data.deletedAt instanceof Date);
  assert.equal(replaced.calls.detailUpdateMany[0].data.deletedBy, user.id);
  assert.equal(replaced.calls.detailCreateMany[0].data[0].barcode, "4894300069500");

  const untouched = fakePrisma();
  await service(untouched).update("order-1", { rib_spec: "只改伞骨" }, user);
  assert.equal(untouched.calls.detailUpdateMany.length, 0, "没传明细时不许动子表");
  assert.equal(untouched.calls.detailCreateMany.length, 0);
});

test("更新：传空数组是把明细清空（与「没传」区分开）", async () => {
  const prisma = fakePrisma();
  await service(prisma).update("order-1", { spec_details: [] }, user);
  assert.equal(prisma.calls.detailUpdateMany.length, 1, "软删老行");
  assert.equal(prisma.calls.detailCreateMany.length, 0, "没有新行要建");
});

// ------------------------------------------------------ 明细合计 vs 单头数量

const detail = (quantity, unit) => ({ quantity: quantity === null ? null : new Prisma.Decimal(quantity), unit });

test("明细合计 = 单头数量时不提示（模板两张样本都成立）", async () => {
  const prisma = fakePrisma({ row: { quantity: new Prisma.Decimal("1960"), unit: "支", specDetails: [detail("100", "pcs"), detail("1860", "pcs")] } });
  const order = await service(prisma).get("order-1");
  assert.equal(order.spec_quantity_notice, null);
});

test("明细合计 ≠ 单头数量时提示，但**不拦**（单位可能是支也可能是打）", async () => {
  const prisma = fakePrisma({ row: { quantity: new Prisma.Decimal("1960"), unit: "支", specDetails: [detail("100", "pcs"), detail("200", "pcs")] } });
  const order = await service(prisma).get("order-1");
  assert.match(order.spec_quantity_notice, /明细数量合计 300 与单头数量 1960 支 不一致/);
});

test("单位与单头不一致时说「无法核对」，而不是硬算一个错的合计", async () => {
  const prisma = fakePrisma({ row: { quantity: new Prisma.Decimal("5"), unit: "打", specDetails: [detail("60", "支")] } });
  const order = await service(prisma).get("order-1");
  assert.match(order.spec_quantity_notice, /无法核对/);
  assert.match(order.spec_quantity_notice, /跨单位不做合计/);
});

test("明细没写单位时按单头单位算（模板里明细分单位列常常留空）", async () => {
  const prisma = fakePrisma({ row: { quantity: new Prisma.Decimal("1960"), unit: "支", specDetails: [detail("1960", null)] } });
  const order = await service(prisma).get("order-1");
  assert.equal(order.spec_quantity_notice, null);
});

test("没有明细或明细都没填数量时不提示", async () => {
  const none = fakePrisma({ row: { quantity: new Prisma.Decimal("10"), unit: "支", specDetails: [] } });
  assert.equal((await service(none).get("order-1")).spec_quantity_notice, null);

  const blank = fakePrisma({ row: { quantity: new Prisma.Decimal("10"), unit: "支", specDetails: [detail(null, "支")] } });
  assert.equal((await service(blank).get("order-1")).spec_quantity_notice, null);
});

test("get 会带上未被删除的明细行并按 sortOrder 取", async () => {
  const prisma = fakePrisma();
  await service(prisma).get("order-1");
  assert.deepEqual(prisma.calls.findFirst[0].include.specDetails, { where: { deletedAt: null }, orderBy: { sortOrder: "asc" } });
});

// ------------------------------------------------------------ 单位归一

test("单位归一：支 / pcs / 个 是同一个单位，打 / dz 是同一个单位", () => {
  for (const unit of ["支", "pcs", "PCS", "pc", "pieces", "个", " 支 "]) assert.equal(normalizeSpecUnit(unit), "piece", unit);
  for (const unit of ["打", "dz", "doz", "Dozen"]) assert.equal(normalizeSpecUnit(unit), "dozen", unit);
  assert.equal(normalizeSpecUnit("米"), "米", "不认识的原样返回，不同单位照样判不一致");
  assert.equal(normalizeSpecUnit(null), null);
  assert.equal(normalizeSpecUnit("  "), null);
});

test("模板样本1 的真实数字：12 款花色 100+200+200+100+120+120+200+200+120+200+200+200 = 1960支", async () => {
  // 表头是「支」、明细写的是「pcs」——不做单位归一这条真规则就会被误判成「跨单位无法核对」。
  const quantities = ["100", "200", "200", "100", "120", "120", "200", "200", "120", "200", "200", "200"];
  const prisma = fakePrisma({
    row: { quantity: new Prisma.Decimal("1960"), unit: "支", specDetails: quantities.map((quantity) => detail(quantity, "pcs")) },
  });
  assert.equal((await service(prisma).get("order-1")).spec_quantity_notice, null);
});

test("模板样本2 的情形：15 款伞头 × 167打 = 2505打", async () => {
  const prisma = fakePrisma({
    row: { quantity: new Prisma.Decimal("2505"), unit: "打", specDetails: Array.from({ length: 15 }, () => detail("167", "打")) },
  });
  assert.equal((await service(prisma).get("order-1")).spec_quantity_notice, null);
});

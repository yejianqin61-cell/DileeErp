// 销售单行图「一条物料最多 3 张」（2026-11-05）。
//
// 用户原话：「现在，销售单那边，一条物料支持导入 3 张图片，现在只有 1 张。改一下」。
// 设计契约：docs/design/sales-order-row-images-x3-2026-11-05.md §3.1–§3.4。
//
// 上一轮（2026-11-04）是「每个位置 1 张」，本文件钉住升级到 3 张之后的**形状与边界**：
//   ① 三处载荷（细分明细行 / 「其它」「再加一款」行 / 18 个材料格）都能存 3 张，顺序 = 用户看到的顺序；
//   ② 超过 3 张 → 422 `SALES_ORDER_IMAGE_LIMIT`（details: scope/key/count），且**一个字节都不写**；
//   ③ 只填 2 张：第 3 列为 NULL / 那一格只有两行，不能把空位挤掉或补到最后；
//   ④ 旧形状 `image_id`（单张）仍然认，与新 `image_ids` 同时出现时新键优先；
//   ⑤ 返单/复制：来源单的图**逐张克隆字节**（复制次数 = 不同图片张数）并重映射到新单自己的 id；
//   ⑥ 孤儿清理认第 2/3 张（`image_id_2`/`image_id_3` 与 slot 行都算"还有活行引用"）；
//   ⑦ 18 格的一格：从 3 张删到 2 张只软删第 3 行、删到 0 张三行全软删、再传回 3 张那行要**复活**。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHash } = require("node:crypto");
const {
  MAX_ROW_IMAGES,
  SalesOrdersService,
  normalizeRowImageIds,
  normalizeSlotImages,
} = require("../../dist/modules/sales/sales-orders.service.js");

const user = { id: "00000000-0000-0000-0000-0000000000aa", username: "sales", display_name: "张三" };
const ORDER_ID = "33333333-3333-3333-3333-333333333333";
const NEW_ORDER_ID = "44444444-4444-4444-4444-444444444444";
const SOURCE_ORDER_ID = "55555555-5555-5555-5555-555555555555";
const IMAGE_A = "11111111-1111-1111-1111-111111111111";
const IMAGE_B = "22222222-2222-2222-2222-222222222222";
const IMAGE_C = "33333333-3333-3333-3333-333333333333";
const IMAGE_D = "44444444-4444-4444-4444-444444444444";
const CLONE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CLONE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CLONE_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const auditColumns = {
  create: () => ({ createdBy: user.id, updatedBy: user.id }),
  update: () => ({ updatedBy: user.id }),
  softDelete: () => ({ deletedAt: new Date("2026-11-05"), deletedBy: user.id, updatedBy: user.id }),
  record: async () => {},
};

/** 真的能被 `validateMaterialImage` 解开的 WebP（手搓 RIFF/VP8L 头，不解码像素 —— 与上一轮同一路子）。 */
function webp({ width = 800, height = 600, padding = 8 } = {}) {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
  const payload = Buffer.alloc(5 + padding);
  payload[0] = 0x2f;
  payload.writeUInt32LE(bits, 1);
  const file = Buffer.alloc(12 + 8 + payload.length);
  file.write("RIFF", 0, "ascii");
  file.writeUInt32LE(file.length - 8, 4);
  file.write("WEBP", 8, "ascii");
  file.write("VP8L", 12, "ascii");
  file.writeUInt32LE(payload.length, 16);
  payload.copy(file, 20);
  return file;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** 一行图片摘要（详情/返单预览里的 `image`/`image2`/`image3` 就是这个五字段形状）。 */
const summary = (id) => ({ id, width: 800, height: 600, byteSize: 100, sha256: `sha-${id}` });

/**
 * 更新路径的假 Prisma。
 *
 * 与既有 `sales-order-row-images.test.cjs` 同一个套路：同一张表在「替换」与「孤儿清理」里查询条件不同，
 * 所以按**查询形状**分流（`imageId.in` = 清理数引用；否则 = 替换时读现有行；`id.in` = 归属校验）。
 * 记下每一次写与每次清理查询，断言"写了什么"与"查了哪几列"。
 */
function updateHarness({ current = {}, orderImages = [], liveImages = [], slotExisting = [], slotRefRows = [], detailRefRows = [], extraRefRows = [] } = {}) {
  const calls = {
    salesOrderUpdate: [],
    versionCreate: [],
    specCreateMany: [],
    extraCreateMany: [],
    slotCreateMany: [],
    slotUpdate: [],
    imageFindMany: [],
    imageUpdateMany: [],
    cleanupQueries: [],
  };
  const tx = {
    salesOrder: { update: async ({ data }) => { calls.salesOrderUpdate.push(data); return { id: ORDER_ID, ...data }; } },
    salesOrderVersion: { create: async ({ data }) => { calls.versionCreate.push(data); return data; } },
    salesOrderSpecDetail: {
      updateMany: async () => ({}),
      createMany: async ({ data }) => { calls.specCreateMany.push(data); return { count: data.length }; },
      findMany: async (args) => { calls.cleanupQueries.push(["spec_details", args]); return detailRefRows; },
    },
    salesOrderMaterialRef: { findMany: async () => [], update: async () => ({}), createMany: async () => ({}) },
    salesOrderMaterialExtra: {
      updateMany: async () => ({}),
      createMany: async ({ data }) => { calls.extraCreateMany.push(data); return { count: data.length }; },
      findMany: async (args) => { calls.cleanupQueries.push(["material_extras", args]); return extraRefRows; },
    },
    salesOrderSlotImage: {
      findMany: async (args) => {
        if (args.where.imageId) { calls.cleanupQueries.push(["slot_images", args]); return slotRefRows; }
        return slotExisting;
      },
      update: async ({ where, data }) => { calls.slotUpdate.push([where.id, data]); return data; },
      createMany: async ({ data }) => { calls.slotCreateMany.push(data); return { count: data.length }; },
    },
    salesOrderImage: {
      findMany: async (args) => { calls.imageFindMany.push(args); return args.where.id ? orderImages : liveImages; },
      updateMany: async (args) => { calls.imageUpdateMany.push(args); return { count: args.where.id.in.length }; },
    },
  };
  const prisma = {
    salesOrder: {
      findFirst: async () => ({ id: ORDER_ID, orderNo: "SO-1", status: "draft", currentVersion: 1, customerId: "customer-1", customer: { id: "customer-1", name: "家百纳" }, contact: null, versions: [], boms: [], specDetails: [], materialRefs: [], materialExtras: [], slotImages: [], orderDate: new Date("2026-11-05T00:00:00.000Z"), quantity: "10", unit: "支", currency: "USD", extensionData: {}, ...current }),
    },
    customer: { findFirst: async () => ({ id: "customer-1", customerCode: "CUS-1", name: "家百纳", isActive: true }) },
    customerContact: { findFirst: async () => null },
    material: { findMany: async () => [] },
    $transaction: async (fn) => fn(tx),
  };
  return { service: new SalesOrdersService(prisma, auditColumns), calls };
}

// ================================================================ ① 三处都能存 3 张

test("三处都能存 3 张：细分明细 / 「其它」行写进 imageId/imageId2/imageId3，18 格写进 (spec_key, slot_index)", async () => {
  const { service, calls } = updateHarness({ orderImages: [{ id: IMAGE_A }, { id: IMAGE_B }, { id: IMAGE_C }], slotRefRows: [{ imageId: IMAGE_A }, { imageId: IMAGE_B }, { imageId: IMAGE_C }] });
  await service.update(ORDER_ID, {
    spec_details: [{ group_name: "伞布明细", name: "DL260134", image_ids: [IMAGE_A, IMAGE_B, IMAGE_C] }],
    material_extras: [{ spec_key: "handle_spec", content: "直柄银色", image_ids: [IMAGE_A, IMAGE_B, IMAGE_C] }],
    slot_images: [{ spec_key: "canopy_spec", image_ids: [IMAGE_A, IMAGE_B, IMAGE_C] }],
  }, user);

  // 明细行：数组按位置落三列，顺序 = 用户看到的顺序
  const detail = calls.specCreateMany[0][0];
  assert.deepEqual([detail.imageId, detail.imageId2, detail.imageId3], [IMAGE_A, IMAGE_B, IMAGE_C]);
  // 「其它」行同一口径
  const extra = calls.extraCreateMany[0][0];
  assert.deepEqual([extra.imageId, extra.imageId2, extra.imageId3], [IMAGE_A, IMAGE_B, IMAGE_C]);
  // 18 格：一格三行，`slotIndex` 就是顺序（唯一键 (salesOrderId, specKey, slotIndex)）
  assert.deepEqual(calls.slotCreateMany[0].map((row) => [row.specKey, row.slotIndex, row.imageId]), [
    ["canopy_spec", 0, IMAGE_A],
    ["canopy_spec", 1, IMAGE_B],
    ["canopy_spec", 2, IMAGE_C],
  ]);
  assert.ok(calls.slotCreateMany[0].every((row) => row.salesOrderId === ORDER_ID && row.createdBy === user.id));

  // 归属校验一次查完三张（不是每张一次往返）
  assert.deepEqual(calls.imageFindMany[0].where, { id: { in: [IMAGE_A, IMAGE_B, IMAGE_C] }, salesOrderId: ORDER_ID, deletedAt: null });
});

// ================================================================ ② 超过 3 张 422

test("超过 3 张 → 422 SALES_ORDER_IMAGE_LIMIT（三处都管，details 点名 scope/key/count），且一个字都不写", async () => {
  const four = [IMAGE_A, IMAGE_B, IMAGE_C, IMAGE_D];
  const cases = [
    ["spec_details", { spec_details: [{ group_name: "伞布明细", name: "DL260134", image_ids: four }] }, { scope: "spec_details", key: "DL260134", count: 4 }],
    ["material_extras", { material_extras: [{ label: "弹簧", content: "5cm", image_ids: four }] }, { scope: "material_extras", key: "弹簧", count: 4 }],
    ["slot_images", { slot_images: [{ spec_key: "rib_spec", image_ids: four }] }, { scope: "slot_images", key: "rib_spec", count: 4 }],
  ];
  for (const [label, payload, expected] of cases) {
    const { service, calls } = updateHarness();
    await assert.rejects(
      () => service.update(ORDER_ID, payload, user),
      (error) => {
        const response = error.getResponse();
        assert.equal(response.code, "SALES_ORDER_IMAGE_LIMIT", `${label} 越限必须是 422 SALES_ORDER_IMAGE_LIMIT`);
        assert.match(response.message, /一行\/一格最多 3 张图片/, "文案要说清上限是 3 张");
        assert.deepEqual(response.details, [expected], "details 要能让界面标红那一行");
        return true;
      },
    );
    // 上限在任何写之前判：不查图片表、不写任何子表、不动销售单
    assert.deepEqual(calls.imageFindMany, [], `${label}: 越限时一次图片表都不查`);
    assert.deepEqual(calls.specCreateMany, []);
    assert.deepEqual(calls.extraCreateMany, []);
    assert.deepEqual(calls.slotCreateMany, []);
    assert.deepEqual(calls.salesOrderUpdate, []);
  }
});

test("上限归一：去重后 3 张算合法（重复项不该把一次合法保存卡成 422），4 张不同图才拒", () => {
  assert.equal(MAX_ROW_IMAGES, 3);
  assert.deepEqual(normalizeRowImageIds({ image_ids: [IMAGE_A, IMAGE_A, IMAGE_B, IMAGE_A, IMAGE_C] }, "slot_images", "rib_spec"), [IMAGE_A, IMAGE_B, IMAGE_C], "去重 + 保序");
  assert.deepEqual(normalizeRowImageIds({ image_ids: [] }, "spec_details", "x"), []);
  assert.deepEqual(normalizeRowImageIds({ image_id: IMAGE_B }, "material_extras", "弹簧"), [IMAGE_B], "旧单值等同于 [id]");
  assert.deepEqual(normalizeRowImageIds({ image_id: IMAGE_A, image_ids: [IMAGE_B, IMAGE_C] }, "spec_details", "x"), [IMAGE_B, IMAGE_C], "两者同时出现时 image_ids 优先");
  assert.throws(
    () => normalizeRowImageIds({ image_ids: [IMAGE_A, IMAGE_B, IMAGE_C, IMAGE_D] }, "material_extras", "弹簧"),
    (error) => error.getResponse().code === "SALES_ORDER_IMAGE_LIMIT" && error.getResponse().details[0].count === 4,
  );
});

test("建单也在写之前拦：请求里一行 4 张图 → 422，连事务都不开（不会出现「单建好了、图没挂上」）", async () => {
  const calls = { transaction: 0 };
  const prisma = {
    customer: { findFirst: async () => ({ id: "customer-1", customerCode: "CUS-1", name: "家百纳", isActive: true }) },
    customerContact: { findFirst: async () => null },
    $transaction: async (fn) => { calls.transaction += 1; return fn({}); },
  };
  const service = new SalesOrdersService(prisma, auditColumns);
  await assert.rejects(
    () => service.create({ order_no: "SO-NEW", customer_id: "customer-1", order_date: "2026-11-05", product_name: "伞", quantity: "10", unit: "支", currency: "USD", spec_details: [{ group_name: "伞布明细", name: "DL1", image_ids: [IMAGE_A, IMAGE_B, IMAGE_C, IMAGE_D] }] }, user),
    (error) => error.getResponse().code === "SALES_ORDER_IMAGE_LIMIT",
  );
  assert.equal(calls.transaction, 0, "上限校验在任何写之前：一次事务都不开");
});

// ================================================================ ③ 只填 2 张

test("只填 2 张：第 3 列落 NULL（不挤位、不补位），18 格只写两行", async () => {
  const { service, calls } = updateHarness({ orderImages: [{ id: IMAGE_A }, { id: IMAGE_B }], slotRefRows: [{ imageId: IMAGE_A }, { imageId: IMAGE_B }] });
  await service.update(ORDER_ID, {
    spec_details: [{ group_name: "伞布明细", name: "DL260134", image_ids: [IMAGE_A, IMAGE_B] }],
    material_extras: [{ label: "弹簧", content: "5cm", image_ids: [IMAGE_A, IMAGE_B] }],
    slot_images: [{ spec_key: "canopy_spec", image_ids: [IMAGE_A, IMAGE_B] }],
  }, user);

  const detail = calls.specCreateMany[0][0];
  assert.deepEqual([detail.imageId, detail.imageId2, detail.imageId3], [IMAGE_A, IMAGE_B, null], "第 3 张没有就是 NULL");
  const extra = calls.extraCreateMany[0][0];
  assert.deepEqual([extra.imageId, extra.imageId2, extra.imageId3], [IMAGE_A, IMAGE_B, null]);
  assert.deepEqual(calls.slotCreateMany[0].map((row) => [row.slotIndex, row.imageId]), [[0, IMAGE_A], [1, IMAGE_B]]);
});

// ================================================================ ④ 兼容旧 image_id

test("兼容旧 image_id（2026-11-04 的请求）：三处都按「第 1 张」落，不写第 2/3 张", async () => {
  const { service, calls } = updateHarness({ orderImages: [{ id: IMAGE_A }], slotRefRows: [{ imageId: IMAGE_A }] });
  await service.update(ORDER_ID, {
    spec_details: [{ group_name: "伞布明细", name: "DL260134", image_id: IMAGE_A }],
    material_extras: [{ label: "弹簧", content: "5cm", image_id: IMAGE_A }],
    slot_images: [{ spec_key: "canopy_spec", image_id: IMAGE_A }],
  }, user);

  const detail = calls.specCreateMany[0][0];
  assert.deepEqual([detail.imageId, detail.imageId2, detail.imageId3], [IMAGE_A, null, null]);
  const extra = calls.extraCreateMany[0][0];
  assert.deepEqual([extra.imageId, extra.imageId2, extra.imageId3], [IMAGE_A, null, null]);
  assert.deepEqual(calls.slotCreateMany[0].map((row) => [row.slotIndex, row.imageId]), [[0, IMAGE_A]]);
});

test("旧 image_id 与新 image_ids 同时出现：image_ids 优先（接口是公开的，两种形状混发不该并存）", async () => {
  const { service, calls } = updateHarness({ orderImages: [{ id: IMAGE_B }, { id: IMAGE_C }], slotRefRows: [{ imageId: IMAGE_B }, { imageId: IMAGE_C }] });
  await service.update(ORDER_ID, {
    spec_details: [{ group_name: "伞布明细", name: "DL260134", image_id: IMAGE_A, image_ids: [IMAGE_B, IMAGE_C] }],
    slot_images: [{ spec_key: "canopy_spec", image_id: IMAGE_A, image_ids: [IMAGE_B, IMAGE_C] }],
  }, user);

  // 归属校验只查 image_ids 里的两个：旧的 A 根本没被理会（也不该被查/被抓）
  assert.deepEqual(calls.imageFindMany[0].where.id.in, [IMAGE_B, IMAGE_C]);
  assert.deepEqual([calls.specCreateMany[0][0].imageId, calls.specCreateMany[0][0].imageId2], [IMAGE_B, IMAGE_C]);
  assert.deepEqual(calls.slotCreateMany[0].map((row) => row.imageId), [IMAGE_B, IMAGE_C]);
});

// ================================================================ ⑦ 18 格：逐张软删 / 复活

test("18 格：一格原有 3 张、请求只剩 2 张 → 第 2 张换图、第 3 张那一行软删", async () => {
  const existing = [0, 1, 2].map((slotIndex) => ({ id: `slot-${slotIndex}`, specKey: "canopy_spec", slotIndex, imageId: IMAGE_A, deletedAt: null }));
  const { service, calls } = updateHarness({ slotExisting: existing, orderImages: [{ id: IMAGE_A }, { id: IMAGE_B }], liveImages: [{ id: IMAGE_A }, { id: IMAGE_B }], slotRefRows: [{ imageId: IMAGE_A }, { imageId: IMAGE_B }] });
  await service.update(ORDER_ID, { slot_images: [{ spec_key: "canopy_spec", image_ids: [IMAGE_A, IMAGE_B] }] }, user);

  // slotIndex 0 没变 → 一个字都不写；slotIndex 1 换成 IMAGE_B；slotIndex 2 请求里没有 → 软删那一行。
  // 关键差别（2026-11-05）：**不能只软删整格** —— 那样会把"这一格还有第 1 张"也一起清掉。
  assert.deepEqual(calls.slotUpdate.map(([id]) => id), ["slot-1", "slot-2"]);
  assert.deepEqual(calls.slotUpdate[0][1].imageId, IMAGE_B, "第 2 张改图");
  assert.equal(calls.slotUpdate[0][1].deletedAt, null, "改图不是删除");
  assert.ok(calls.slotUpdate[1][1].deletedAt instanceof Date, "第 3 张那一行软删");
  assert.deepEqual(calls.slotCreateMany, []);
});

test("18 格：一格三张全删（空数组）→ 三行全软删；再传回 3 张 → 原有行**复活**而不是撞唯一键再插一行", async () => {
  const existing = [0, 1, 2].map((slotIndex) => ({ id: `slot-${slotIndex}`, specKey: "canopy_spec", slotIndex, imageId: IMAGE_A, deletedAt: null }));

  const cleared = updateHarness({ slotExisting: existing, liveImages: [] });
  await cleared.service.update(ORDER_ID, { slot_images: [{ spec_key: "canopy_spec", image_ids: [] }] }, user);
  assert.deepEqual(cleared.calls.slotUpdate.map(([id]) => id).sort(), ["slot-0", "slot-1", "slot-2"], "空数组 = 这一格没有图");
  assert.ok(cleared.calls.slotUpdate.every(([, data]) => data.deletedAt instanceof Date));
  assert.deepEqual(cleared.calls.slotCreateMany, [], "清空不插入新行");

  // 再传回 3 张：那三行是**软删**的（唯一索引不看 deletedAt），必须复活，不能再 createMany → 否则必撞 P2002
  const revived = updateHarness({
    slotExisting: [0, 1, 2].map((slotIndex) => ({ id: `slot-${slotIndex}`, specKey: "canopy_spec", slotIndex, imageId: IMAGE_A, deletedAt: new Date("2026-11-05") })),
    orderImages: [{ id: IMAGE_A }, { id: IMAGE_B }, { id: IMAGE_C }],
    slotRefRows: [{ imageId: IMAGE_A }, { imageId: IMAGE_B }, { imageId: IMAGE_C }],
  });
  await revived.service.update(ORDER_ID, { slot_images: [{ spec_key: "canopy_spec", image_ids: [IMAGE_A, IMAGE_B, IMAGE_C] }] }, user);
  // 三行都要动：第 1 张图没变但它是软删行（要复活），第 2/3 张换图 + 复活。
  assert.deepEqual(revived.calls.slotUpdate.map(([id]) => id), ["slot-0", "slot-1", "slot-2"]);
  assert.deepEqual(revived.calls.slotUpdate.map(([, data]) => data.imageId), [IMAGE_A, IMAGE_B, IMAGE_C], "按 slotIndex 逐张对齐");
  assert.ok(revived.calls.slotUpdate.every(([, data]) => data.deletedAt === null && data.deletedBy === null), "复活要清掉 deletedAt/deletedBy");
  assert.deepEqual(revived.calls.slotCreateMany, [], "已有行只能复活，不能再插一行（唯一键不看 deletedAt）");
});

// ================================================================ ⑥ 孤儿清理认第 2/3 张

test("孤儿清理：明细行第 2 张、「其它」行第 3 张、18 格第 3 张都算「还有活行引用」", async () => {
  const { service, calls } = updateHarness({
    slotImages: undefined,
    liveImages: [{ id: IMAGE_A }, { id: IMAGE_B }, { id: IMAGE_C }, { id: IMAGE_D }],
    slotExisting: [],
    // 三种引用各只挂在一个"非第 1 列"的位置上：只查 image_id 的实现会把它们当孤儿清掉
    slotRefRows: [{ imageId: IMAGE_C }],
    detailRefRows: [{ imageId: null, imageId2: IMAGE_A, imageId3: null }],
    extraRefRows: [{ imageId: null, imageId2: null, imageId3: IMAGE_B }],
  });
  // `slot_images: []` 只为触发一次清理（touchesImages 为真），不改变引用关系
  await service.update(ORDER_ID, { slot_images: [] }, user);

  assert.deepEqual(calls.imageUpdateMany.length, 1, "只剩真正没人引用的那张要软删");
  assert.deepEqual(calls.imageUpdateMany[0].where.id.in, [IMAGE_D], "A/B/C 分别被明细第 2 张、「其它」第 3 张、18 格引用着，都不是孤儿");
  assert.ok(calls.imageUpdateMany[0].data.deletedAt instanceof Date, "只软删（快照里可能还提着这个 id）");

  // 清理必须查三列：只查 image_id 会把第 2/3 张误清（用户看到"上次传了 3 张，今天只剩 1 张"）
  for (const table of ["spec_details", "material_extras"]) {
    const query = calls.cleanupQueries.find(([name]) => name === table)[1];
    assert.deepEqual(query.select, { imageId: true, imageId2: true, imageId3: true }, `${table} 要取三列`);
    assert.deepEqual(query.where.OR, [
      { imageId: { in: [IMAGE_A, IMAGE_B, IMAGE_C, IMAGE_D] } },
      { imageId2: { in: [IMAGE_A, IMAGE_B, IMAGE_C, IMAGE_D] } },
      { imageId3: { in: [IMAGE_A, IMAGE_B, IMAGE_C, IMAGE_D] } },
    ], `${table} 的引用判定要覆盖三列`);
  }
});

test("孤儿清理：三张都被引用时一条 updateMany 都不发", async () => {
  const { service, calls } = updateHarness({
    liveImages: [{ id: IMAGE_A }, { id: IMAGE_B }, { id: IMAGE_C }],
    slotRefRows: [{ imageId: IMAGE_A }],
    detailRefRows: [{ imageId: null, imageId2: null, imageId3: IMAGE_B }],
    extraRefRows: [{ imageId: IMAGE_C, imageId2: null, imageId3: null }],
  });
  await service.update(ORDER_ID, { slot_images: [] }, user);
  assert.deepEqual(calls.imageUpdateMany, []);
});

// ================================================================ ⑤ 返单/复制：逐张克隆

/** 返单建单的假 Prisma：来源单 + 建完再 get 一次共用 findFirst（按 where 形状分流）。 */
function reorderHarness(source) {
  const calls = { createData: undefined, versionData: undefined, specRows: undefined, extraRows: undefined, slotRows: undefined, slotExisting: [], cloneCreate: [], imageFindMany: [] };
  const createdRow = { id: NEW_ORDER_ID, orderNo: "SO-NEW", status: "draft", currentVersion: 1, customerId: "customer-1", extensionData: {}, orderDate: new Date(), productName: "伞", quantity: "10", unit: "支", currency: "USD", contactId: null, boms: [], versions: [], specDetails: [], materialRefs: [], materialExtras: [], slotImages: [] };
  const tx = {
    salesOrder: { create: async ({ data }) => { calls.createData = data; return createdRow; } },
    salesOrderVersion: { create: async ({ data }) => { calls.versionData = data; return data; } },
    salesOrderSpecDetail: { updateMany: async () => ({}), createMany: async ({ data }) => { calls.specRows = data; return { count: data.length }; }, findMany: async () => [] },
    salesOrderMaterialRef: { findMany: async () => [], update: async () => ({}), createMany: async () => ({}) },
    salesOrderMaterialExtra: { updateMany: async () => ({}), createMany: async ({ data }) => { calls.extraRows = data; return { count: data.length }; }, findMany: async () => [] },
    salesOrderSlotImage: {
      findMany: async () => calls.slotExisting,
      update: async ({ where, data }) => ({ id: where.id, ...data }),
      createMany: async ({ data }) => { calls.slotRows = data; return { count: data.length }; },
    },
    salesOrderImage: {
      findMany: async (args) => { calls.imageFindMany.push(args); return source.images ?? []; },
      create: async ({ data }) => {
        calls.cloneCreate.push(data);
        // 按 findMany 返回顺序给新单自己的图片 id（A→CLONE_A、B→CLONE_B、C→CLONE_C）
        return { id: [CLONE_A, CLONE_B, CLONE_C][calls.cloneCreate.length - 1] };
      },
    },
  };
  const prisma = {
    customer: { findFirst: async () => ({ id: "customer-1", customerCode: "CUS-1", name: "家百纳", isActive: true }) },
    customerContact: { findFirst: async () => null },
    material: { findMany: async () => [] },
    salesOrder: {
      findFirst: async (args) => {
        // 返单来源按单号查；建完的 `get()` 按 id 查 —— 两种形状分开，避免「来源单被当成新单」。
        if (args.where && args.where.orderNo) return source.order;
        return { ...createdRow, customer: { id: "customer-1" }, contact: null };
      },
    },
    $transaction: async (fn) => fn(tx),
  };
  return { service: new SalesOrdersService(prisma, auditColumns), calls };
}

test("返单/复制：三处行图**逐张克隆字节**（克隆次数 = 不同图片张数）并重映射到新单自己的 id", async () => {
  const bytesA = webp({ width: 800, height: 600 });
  const bytesB = webp({ width: 300, height: 400 });
  const bytesC = webp({ width: 200, height: 200 });
  const sourceImages = [
    { id: IMAGE_A, salesOrderId: SOURCE_ORDER_ID, data: bytesA, mimeType: "image/webp", width: 800, height: 600, byteSize: bytesA.length, sha256: sha256(bytesA) },
    { id: IMAGE_B, salesOrderId: SOURCE_ORDER_ID, data: bytesB, mimeType: "image/webp", width: 300, height: 400, byteSize: bytesB.length, sha256: sha256(bytesB) },
    { id: IMAGE_C, salesOrderId: SOURCE_ORDER_ID, data: bytesC, mimeType: "image/webp", width: 200, height: 200, byteSize: bytesC.length, sha256: sha256(bytesC) },
  ];
  const source = {
    images: sourceImages,
    order: {
      id: SOURCE_ORDER_ID, orderNo: "SO-OLD", status: "closed", itemNo: "27621",
      customerId: "customer-1", contactId: null, productName: "50cm 三折伞", productSpec: null, unit: "支", currency: "USD",
      customerPoNo: null, externalContractNo: null, unitPrice: null, settlementUnitPrice: null, taxRate: null, settlementMethod: null,
      quantity: "1960", orderDate: new Date("2026-06-18T00:00:00.000Z"), deliveryDate: null, totalAmount: null, receivableAmount: null,
      localCurrencyAmount: null, extensionData: {}, currentVersion: 3, reorderFromOrderNo: null, specDetailLabels: {},
      // 明细行 2 张（A、B）、「其它」行 1 张（C）、18 格三张（A、B、C，分三行同属一格）
      specDetails: [{ groupName: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", barcode: null, quantity: null, unit: null, sortOrder: 0, imageId: IMAGE_A, imageId2: IMAGE_B, imageId3: null, image: summary(IMAGE_A), image2: summary(IMAGE_B), image3: null }],
      materialRefs: [],
      materialExtras: [{ label: "伞头", content: "直柄银色", specKey: "handle_spec", sortOrder: 0, materialId: null, imageId: IMAGE_C, imageId2: null, imageId3: null, image: summary(IMAGE_C), image2: null, image3: null }],
      slotImages: [
        { specKey: "canopy_spec", slotIndex: 0, imageId: IMAGE_A, image: summary(IMAGE_A) },
        { specKey: "canopy_spec", slotIndex: 1, imageId: IMAGE_B, image: summary(IMAGE_B) },
        { specKey: "canopy_spec", slotIndex: 2, imageId: IMAGE_C, image: summary(IMAGE_C) },
      ],
    },
  };
  const { service, calls } = reorderHarness(source);
  await service.create({ order_no: "SO-NEW", order_date: "2026-11-05", quantity: "2500", delivery_date: "2026-12-01", reorder_from_order_no: "SO-OLD" }, user);

  // 三张不同图各查一次（合并成一条 in 查询）→ 各克隆一条新行
  assert.deepEqual(calls.imageFindMany[0].where, { id: { in: [IMAGE_A, IMAGE_B, IMAGE_C] }, deletedAt: null });
  assert.equal(calls.cloneCreate.length, 3, "克隆次数 = 不同图片张数（不是按位置数重复克隆）");
  assert.ok(calls.cloneCreate.every((row) => row.salesOrderId === NEW_ORDER_ID), "克隆出来的图属于**新单**");
  assert.deepEqual(calls.cloneCreate.map((row) => Buffer.from(row.data)), [bytesA, bytesB, bytesC].map((bytes) => Buffer.from(bytes)), "字节原样（同内容、新 ArrayBuffer）");
  assert.equal(calls.cloneCreate[0].sha256, sha256(bytesA));
  assert.notEqual(calls.cloneCreate[0].data, bytesA, "不许共享来源单的可变内存");

  // 三处指针全部换成新单的 id，绝不跨单引用
  const detailRow = calls.specRows[0];
  assert.deepEqual([detailRow.salesOrderId, detailRow.imageId, detailRow.imageId2, detailRow.imageId3], [NEW_ORDER_ID, CLONE_A, CLONE_B, null]);
  const extraRow = calls.extraRows[0];
  assert.deepEqual([extraRow.salesOrderId, extraRow.imageId, extraRow.imageId2, extraRow.imageId3], [NEW_ORDER_ID, CLONE_C, null, null]);
  assert.deepEqual(calls.slotRows.map((row) => [row.salesOrderId, row.specKey, row.slotIndex, row.imageId]), [
    [NEW_ORDER_ID, "canopy_spec", 0, CLONE_A],
    [NEW_ORDER_ID, "canopy_spec", 1, CLONE_B],
    [NEW_ORDER_ID, "canopy_spec", 2, CLONE_C],
  ], "同一格的三行按 slotIndex 落库，id 全换成新单的");
  for (const row of [...calls.specRows, ...calls.extraRows, ...calls.slotRows]) {
    assert.ok(![IMAGE_A, IMAGE_B, IMAGE_C].includes(row.imageId), "不许跨单引用来源单的 image id");
  }

  // 快照按 §3.4 记**数组**（原样，不记字节）：回看某一版能回答"当时挂的是哪几张"
  assert.deepEqual(calls.versionData.snapshot.spec_details[0].image_ids, [IMAGE_A, IMAGE_B]);
  assert.deepEqual(calls.versionData.snapshot.material_extras[0].image_ids, [IMAGE_C]);
  assert.deepEqual(calls.versionData.snapshot.slot_images, [{ spec_key: "canopy_spec", image_ids: [IMAGE_A, IMAGE_B, IMAGE_C] }]);
  assert.equal(JSON.stringify(calls.versionData.snapshot).includes("sha-"), false, "快照只记指针，不记摘要/字节");
});

test("返单/复制：来源行的第 2/3 张图已不存在 → 422 SALES_ORDER_IMAGE_NOT_FOUND（不静默丢图）", async () => {
  const source = {
    images: [],
    order: {
      id: SOURCE_ORDER_ID, orderNo: "SO-OLD", status: "closed", itemNo: "27621", customerId: "customer-1", contactId: null,
      productName: "伞", productSpec: null, unit: "支", currency: "USD", customerPoNo: null, externalContractNo: null,
      unitPrice: null, settlementUnitPrice: null, taxRate: null, settlementMethod: null, quantity: "10",
      orderDate: new Date(), deliveryDate: null, totalAmount: null, receivableAmount: null, localCurrencyAmount: null,
      extensionData: {}, currentVersion: 1, reorderFromOrderNo: null, specDetailLabels: {}, materialRefs: [], materialExtras: [],
      specDetails: [{ groupName: "伞布明细", name: "x", sortOrder: 0, imageId: IMAGE_A, imageId2: IMAGE_B, imageId3: null, image: null, image2: null, image3: null }],
      slotImages: [],
    },
  };
  const { service, calls } = reorderHarness(source);
  await assert.rejects(
    () => service.create({ order_no: "SO-NEW", order_date: "2026-11-05", quantity: "10", reorder_from_order_no: "SO-OLD" }, user),
    (error) => error.getResponse().code === "SALES_ORDER_IMAGE_NOT_FOUND",
    "第 2 张缺失也要报错（上一轮只看第 1 张，会静默少一张）",
  );
  assert.deepEqual(calls.cloneCreate, []);
});

// ================================================================ ⑤ 返单预览 / 复制快照的行形状（§3.3）

/** 只读快照（预览/复制）的假 Prisma：只需要「查来源单」与「查物料是否存在」两条。 */
function snapshotHarness(source) {
  const prisma = {
    salesOrder: { findFirst: async () => source },
    material: { findMany: async () => [] },
  };
  return new SalesOrdersService(prisma, auditColumns);
}

test("返单预览 / 复制快照：每行带 image_ids + images，并把第 1 张镜像到旧的 image_id/image（§3.3）", async () => {
  const source = {
    id: SOURCE_ORDER_ID, orderNo: "SO-OLD", status: "closed", itemNo: "27621", customerId: "customer-1", contactId: null,
    customerSnapshot: { id: "customer-1" }, productName: "伞", productSpec: null, unit: "支", currency: "USD",
    customerPoNo: null, externalContractNo: null, unitPrice: null, settlementUnitPrice: null, taxRate: null, settlementMethod: null,
    quantity: "10", orderDate: new Date(), deliveryDate: null, totalAmount: null, receivableAmount: null, localCurrencyAmount: null,
    extensionData: {}, currentVersion: 1, reorderFromOrderNo: null, specDetailLabels: {},
    specDetails: [
      { groupName: "伞布明细", name: "DL1", sortOrder: 0, imageId: IMAGE_A, imageId2: IMAGE_B, imageId3: null, image: summary(IMAGE_A), image2: summary(IMAGE_B), image3: null },
      { groupName: "伞布明细", name: "DL2", sortOrder: 1, imageId: null, imageId2: null, imageId3: null, image: null, image2: null, image3: null },
    ],
    materialRefs: [],
    materialExtras: [{ label: "伞头", content: "直柄", specKey: "handle_spec", sortOrder: 0, materialId: null, imageId: IMAGE_C, imageId2: null, imageId3: null, image: summary(IMAGE_C), image2: null, image3: null, material: null }],
    slotImages: [
      { specKey: "canopy_spec", slotIndex: 0, imageId: IMAGE_A, image: summary(IMAGE_A) },
      { specKey: "canopy_spec", slotIndex: 1, imageId: IMAGE_B, image: summary(IMAGE_B) },
    ],
  };
  const service = snapshotHarness(source);

  for (const snapshot of [await service.reorderPreview("SO-OLD"), await service.copySnapshot(SOURCE_ORDER_ID)]) {
    const label = "source_order_no" in snapshot ? "返单预览" : "复制快照";
    const detail = snapshot.copy.spec_details[0];
    assert.deepEqual(detail.image_ids, [IMAGE_A, IMAGE_B], `${label}: 明细行给数组`);
    assert.deepEqual(detail.images, [summary(IMAGE_A), summary(IMAGE_B)], `${label}: 摘要数组按张给（界面显示 2 个缩略图）`);
    assert.equal(detail.image_id, IMAGE_A, `${label}: 第 1 张镜像到旧键（老前端仍可读）`);
    assert.deepEqual(detail.image, summary(IMAGE_A));
    // 没有图的行走老口径：一个图相关的键都不带（前端对"没有这个键"与 [] 处理一致，少一个键少一处 deepEqual 变红）
    for (const key of ["image_ids", "images", "image_id", "image"]) assert.equal(key in snapshot.copy.spec_details[1], false, `${label}: 没图的行不带 ${key}`);
    // 18 格：同一格的两行聚成数组（不能给前端两条各自一张的同名格子）
    assert.deepEqual(snapshot.copy.slot_images, [
      { spec_key: "canopy_spec", image_ids: [IMAGE_A, IMAGE_B], images: [summary(IMAGE_A), summary(IMAGE_B)], image_id: IMAGE_A, image: summary(IMAGE_A) },
    ], `${label}: slot_images 按 spec_key 聚成数组、格内按 slotIndex 排`);
    // 「其它」行同一形状（1 张 → 数组 + 镜像）
    const extra = snapshot.copy.material_extras[0];
    assert.deepEqual(extra.image_ids, [IMAGE_C]);
    assert.equal(extra.image_id, IMAGE_C);
  }
});

// ================================================================ 归一函数：slot 形状

test("normalizeSlotImages：一格 3 张的输出就是 [{ spec_key, image_ids }]（落库方不必再猜单值还是数组）", () => {
  assert.deepEqual(
    normalizeSlotImages([{ spec_key: "canopy_spec", image_ids: [IMAGE_A, IMAGE_B, IMAGE_C] }]),
    [{ spec_key: "canopy_spec", image_ids: [IMAGE_A, IMAGE_B, IMAGE_C] }],
  );
  // 旧形状 + 新形状混发：新键优先，旧键只在一格没有 image_ids 时兜底
  assert.deepEqual(
    normalizeSlotImages([{ spec_key: "rib_spec", image_id: IMAGE_A }, { spec_key: "tail_spec", image_id: IMAGE_B, image_ids: [IMAGE_C] }]),
    [{ spec_key: "rib_spec", image_ids: [IMAGE_A] }, { spec_key: "tail_spec", image_ids: [IMAGE_C] }],
  );
  // 超过 3 张：422（这条在 normalizeSlotImages 里也要拦，因为建单路径先走它）
  assert.throws(
    () => normalizeSlotImages([{ spec_key: "canopy_spec", image_ids: [IMAGE_A, IMAGE_B, IMAGE_C, IMAGE_D] }]),
    (error) => error.getResponse().code === "SALES_ORDER_IMAGE_LIMIT" && error.getResponse().details[0].scope === "slot_images",
  );
});

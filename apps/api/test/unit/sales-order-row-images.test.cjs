// 销售单「行图片」（2026-11-04）：材料格 / 「再加一款」/ 细分明细行都能挂图。
//
// 用户原话：「销售订单要支持每个物料插入图片。我记得以前是有过这个设计的，在物料清单里支持上传图片。
// 然后导出的销售单，物料图片统一归在表单底部。」补充：「一个生产单里有 5 种伞布、11 种伞头，
// 能在每种里插入图片」。设计契约：docs/design/sales-order-row-images-2026-11-04.md §2.1–§2.5。
//
// 本文件钉住七件事（与设计文档 §5「API 图片服务」那一行逐条对应）：
//   ① 上传：沿用 `validateMaterialImage`（不信 Content-Type），落 `sales_order_images`，审计只记元数据；
//   ② 读图：按单归属（不属于本单/已删 → 404），ETag/缓存头由控制器负责，服务层只管取字节与 sha；
//   ③ 18 格图片：**逐格对齐**（复活已软删的行、改 image_id），不是「软删 + 新建」——
//      唯一索引 `(sales_order_id, spec_key)` 不看 `deletedAt`，删了再建必撞 P2002；
//   ④ 行上的 `image_id` 真的落库（明细行 / 「其它」行），而且只接受**本单**的图片；
//   ⑤ 返单/复制建单时把来源单的图**克隆**成本单自己的行（同字节/宽高/sha），绝不跨单引用；
//   ⑥ 保存末尾清掉「本单没有任何活行引用」的图（软删）；
//   ⑦ 没带图片的普通保存**一次图片表都不查**（既有单测的 Prisma 替身不必跟着长）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHash } = require("node:crypto");
const {
  SALES_ORDER_IMAGE_SUMMARY,
  SalesOrdersService,
  normalizeSlotImages,
} = require("../../dist/modules/sales/sales-orders.service.js");

const user = { id: "00000000-0000-0000-0000-0000000000aa", username: "sales", display_name: "张三" };
const ORDER_ID = "33333333-3333-3333-3333-333333333333";
const NEW_ORDER_ID = "44444444-4444-4444-4444-444444444444";
const SOURCE_ORDER_ID = "55555555-5555-5555-5555-555555555555";
const IMAGE_A = "11111111-1111-1111-1111-111111111111";
const IMAGE_B = "22222222-2222-2222-2222-222222222222";
const CLONE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CLONE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const auditColumns = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), softDelete: () => ({ deletedAt: new Date("2026-11-04"), deletedBy: user.id, updatedBy: user.id }), record: async () => {} };

/**
 * 一个真的能被 `validateMaterialImage` 解开的 WebP（`VP8L` 无损块，宽高按参数写进块头）。
 *
 * 不引图片库：校验器只解容器头（RIFF + 块头 + 尺寸），所以这里手搓 33 个字节就够 ——
 * 与 2026-09-24 的物料图片单测同一条路子（那里也是手搓容器头，不解码像素）。
 */
function webp({ width = 800, height = 600, padding = 8 } = {}) {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
  const payload = Buffer.alloc(5 + padding);
  payload[0] = 0x2f; // VP8L 签名
  payload.writeUInt32LE(bits, 1);
  const file = Buffer.alloc(12 + 8 + payload.length);
  file.write("RIFF", 0, "ascii");
  file.writeUInt32LE(file.length - 8, 4); // RIFF 声明长度 = 文件长度 - 8
  file.write("WEBP", 8, "ascii");
  file.write("VP8L", 12, "ascii");
  file.writeUInt32LE(payload.length, 16);
  payload.copy(file, 20);
  return file;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ================================================================== ① 上传

function uploadHarness({ order = { id: ORDER_ID, orderNo: "SO-1" }, savedId = IMAGE_A } = {}) {
  const calls = { orderFind: [], create: [], audit: [] };
  const prisma = {
    salesOrder: { findFirst: async (args) => { calls.orderFind.push(args); return order; } },
    salesOrderImage: {
      create: async (args) => {
        calls.create.push(args);
        return { id: savedId, width: args.data.width, height: args.data.height, byteSize: args.data.byteSize, sha256: args.data.sha256, updatedAt: new Date("2026-11-04T12:00:00.000Z") };
      },
    },
  };
  const audit = { ...auditColumns, record: async (...args) => { calls.audit.push(args); } };
  return { service: new SalesOrdersService(prisma, audit), calls };
}

test("上传：合法 WebP 落 sales_order_images（字节 + 宽高 + sha256），回执是 snake_case 元数据", async () => {
  const { service, calls } = uploadHarness();
  const bytes = webp({ width: 800, height: 600 });
  const result = await service.setImage(ORDER_ID, { buffer: bytes, originalname: "sample.webp", mimetype: "image/webp" }, user);

  assert.deepEqual(result, {
    id: IMAGE_A,
    width: 800,
    height: 600,
    byte_size: bytes.length,
    sha256: sha256(bytes),
    updated_at: new Date("2026-11-04T12:00:00.000Z"),
  });
  assert.deepEqual(calls.orderFind[0].where, { id: ORDER_ID, deletedAt: null }, "前置：销售单必须存在且未删除");

  const data = calls.create[0].data;
  assert.equal(data.salesOrderId, ORDER_ID, "图片按单隔离（sales_order_id 不可空）");
  assert.equal(data.mimeType, "image/webp", "字节走完校验后 mime 一定是 WebP，不抄客户端的 Content-Type");
  assert.equal(data.width, 800);
  assert.equal(data.height, 600);
  assert.equal(data.byteSize, bytes.length);
  assert.equal(data.sha256, sha256(bytes));
  assert.ok(data.data instanceof Uint8Array, "Prisma Bytes 列要 Uint8Array");
  assert.notEqual(data.data, bytes, "必须复制一份自己的 ArrayBuffer（Buffer 的宽类型进不了 Prisma Bytes）");
  assert.deepEqual(Buffer.from(data.data), bytes);
  assert.equal(data.createdBy, user.id);

  const event = calls.audit.find(([action]) => action === "sales_order.image_uploaded");
  assert.ok(event, "上传要记审计");
  assert.equal(event[4].width, 800);
  assert.equal(event[4].height, 600);
  assert.equal(event[4].byte_size, bytes.length);
  assert.equal(event[4].sha256, sha256(bytes));
  assert.equal("data" in event[4], false, "审计只记元数据，不记字节");
});

test("上传：销售单不存在 → 404 SALES_ORDER_NOT_FOUND（图片必须挂在某一张单上）", async () => {
  const { service, calls } = uploadHarness({ order: null });
  await assert.rejects(
    () => service.setImage(ORDER_ID, { buffer: webp() }, user),
    (error) => error.getResponse().code === "SALES_ORDER_NOT_FOUND",
  );
  assert.deepEqual(calls.create, []);
});

test("上传：沿用 validateMaterialImage 的错误码 —— 不是 WebP / 空文件 / 超 2MB，一律不落库", async () => {
  const { service, calls } = uploadHarness();
  await assert.rejects(
    () => service.setImage(ORDER_ID, { buffer: Buffer.alloc(64, 0x41), originalname: "evil.webp", mimetype: "image/webp" }, user),
    (error) => error.getResponse().code === "MATERIAL_IMAGE_NOT_WEBP",
    "Content-Type 是谎话时仍然要拒（服务端解 RIFF 容器，不信 mimetype）",
  );
  await assert.rejects(
    () => service.setImage(ORDER_ID, { buffer: Buffer.alloc(0) }, user),
    (error) => error.getResponse().code === "MATERIAL_IMAGE_FILE_REQUIRED",
  );
  await assert.rejects(
    () => service.setImage(ORDER_ID, undefined, user),
    (error) => error.getResponse().code === "MATERIAL_IMAGE_FILE_REQUIRED",
  );
  await assert.rejects(
    () => service.setImage(ORDER_ID, { buffer: Buffer.alloc(2 * 1024 * 1024 + 1) }, user),
    (error) => error.getResponse().code === "MATERIAL_IMAGE_TOO_LARGE",
  );
  assert.deepEqual(calls.create, [], "校验没过就一个字节都不写");
});

// ================================================================== ② 读图

test("读图：只按 (本单, imageId, 未删除) 取字节；不属于本单或已删 → 404 SALES_ORDER_IMAGE_NOT_FOUND", async () => {
  const bytes = webp();
  const calls = [];
  const prisma = {
    salesOrderImage: {
      findFirst: async (args) => {
        calls.push(args);
        return args.where.id === IMAGE_A && args.where.salesOrderId === ORDER_ID && args.where.deletedAt === null
          ? { data: Buffer.from(bytes), sha256: sha256(bytes), mimeType: "image/webp" }
          : null;
      },
    },
  };
  const service = new SalesOrdersService(prisma, auditColumns);

  const image = await service.image(ORDER_ID, IMAGE_A);
  assert.deepEqual(calls[0].where, { id: IMAGE_A, salesOrderId: ORDER_ID, deletedAt: null }, "归属校验在 SQL 里一起做");
  assert.ok(Buffer.isBuffer(image.data));
  assert.deepEqual(image.data, bytes);
  assert.equal(image.sha256, sha256(bytes), "ETag 用 sha256（控制器据此回 304）");
  assert.equal(image.mimeType, "image/webp");

  await assert.rejects(
    () => service.image(SOURCE_ORDER_ID, IMAGE_A),
    (error) => error.getResponse().code === "SALES_ORDER_IMAGE_NOT_FOUND" && error.getResponse().details[0].image_id === IMAGE_A,
    "不属于这张单的图片与不存在的图片得到同一个 404（不给可枚举信息）",
  );
});

// ================================================================== get() 读侧

test("详情读侧：slotImages 与行上的 image/image2/image3 只取摘要（5 个字段、没有 data），绝不把字节塞进 JSON", async () => {
  assert.deepEqual(Object.keys(SALES_ORDER_IMAGE_SUMMARY).sort(), ["byteSize", "height", "id", "sha256", "width"], "摘要就是这五个字段（sha 已是换没换图的唯一依据，不带 updatedAt）");
  let captured = null;
  const row = { id: ORDER_ID, orderNo: "SO-1", quantity: "10", unit: "支", specDetails: [], currentVersion: 1, customer: { id: "customer-1" }, contact: null, versions: [], boms: [], materialRefs: [], materialExtras: [], slotImages: [] };
  const service = new SalesOrdersService({ salesOrder: { findFirst: async (args) => { captured = args; return row; } } }, auditColumns);
  await service.get(ORDER_ID);

  const slotImageSelect = captured.include.slotImages.include.image.select;
  assert.equal(slotImageSelect.sha256, true);
  assert.equal("data" in slotImageSelect, false, "18 格的图只取摘要");
  assert.equal("data" in captured.include.specDetails.include.image.select, false, "明细行的图只取摘要");
  assert.equal("data" in captured.include.materialExtras.include.image.select, false, "「其它」行的图只取摘要");
  assert.equal(captured.include.slotImages.where.deletedAt, null, "软删的格图不返回");
  // 2026-11-05「一条物料最多 3 张」：第 2/3 张同样只取摘要（详情接口返回 image2/image3 关系给前端排缩略图）。
  for (const relation of ["image2", "image3"]) {
    assert.deepEqual(captured.include.specDetails.include[relation].select, SALES_ORDER_IMAGE_SUMMARY, `明细行 ${relation} 只取摘要`);
    assert.deepEqual(captured.include.materialExtras.include[relation].select, SALES_ORDER_IMAGE_SUMMARY, `「其它」行 ${relation} 只取摘要`);
  }
  // 一格多张图时界面顺序由 `slotIndex` 决定，所以排序必须带上它（只按 specKey 排 = 同一格三张的顺序随机）。
  assert.deepEqual(captured.include.slotImages.orderBy, [{ specKey: "asc" }, { slotIndex: "asc" }], "slotImages 按 (specKey, slotIndex) 排序");
});

// ================================================================== ③ 18 格图片：逐格对齐

/**
 * 更新路径的假 Prisma。
 *
 * 三类 `findMany` 要按查询形状区分（同一张表在「替换」与「孤儿清理」里查的条件不同）：
 *   * `salesOrderImage.findMany` 带 `id.in` = 归属校验，返回 `orderImages`；
 *     不带 `id.in` = 孤儿清理扫本单活图，返回 `liveImages`；
 *   * `salesOrderSlotImage.findMany` 带 `imageId.in` = 清理时数引用，返回 `slotRefRows`；
 *     否则 = 替换时读现有格，返回 `slotExisting`；
 *   * 明细 / 「其它」的 `findMany` 只在清理里用，返回 `detailRefRows` / `extraRefRows`。
 */
function updateHarness({ current = {}, orderImages = [], liveImages = [], slotExisting = [], slotRefRows = [], detailRefRows = [], extraRefRows = [] } = {}) {
  const calls = { salesOrderUpdate: [], versionCreate: [], specCreateMany: [], extraCreateMany: [], slotFindMany: [], slotUpdate: [], slotCreateMany: [], imageFindMany: [], imageUpdateMany: [], cleanupRefs: [] };
  const tx = {
    salesOrder: { update: async (args) => { calls.salesOrderUpdate.push(args); return { id: ORDER_ID, ...args.data }; } },
    salesOrderVersion: { create: async (args) => { calls.versionCreate.push(args); return args.data; } },
    salesOrderSpecDetail: {
      updateMany: async () => ({}),
      createMany: async (args) => { calls.specCreateMany.push(args); return { count: args.data.length }; },
      findMany: async (args) => { calls.cleanupRefs.push(args); return detailRefRows; },
    },
    salesOrderMaterialRef: { findMany: async () => [], update: async () => ({}), createMany: async () => ({}) },
    salesOrderMaterialExtra: {
      updateMany: async () => ({}),
      createMany: async (args) => { calls.extraCreateMany.push(args); return { count: args.data.length }; },
      findMany: async (args) => { calls.cleanupRefs.push(args); return extraRefRows; },
    },
    salesOrderSlotImage: {
      findMany: async (args) => { calls.slotFindMany.push(args); return args.where.imageId ? slotRefRows : slotExisting; },
      update: async (args) => { calls.slotUpdate.push(args); return args.data; },
      createMany: async (args) => { calls.slotCreateMany.push(args); return { count: args.data.length }; },
    },
    salesOrderImage: {
      findMany: async (args) => { calls.imageFindMany.push(args); return args.where.id ? orderImages : liveImages; },
      updateMany: async (args) => { calls.imageUpdateMany.push(args); return { count: args.data ? 1 : 0 }; },
    },
  };
  const prisma = {
    salesOrder: {
      findFirst: async () => ({ id: ORDER_ID, orderNo: "SO-1", status: "draft", currentVersion: 1, customerId: "customer-1", category: null, customer: { id: "customer-1", name: "家百纳" }, contact: null, versions: [], boms: [], specDetails: [], materialRefs: [], materialExtras: [], slotImages: [], orderDate: new Date("2026-11-04T00:00:00.000Z"), quantity: "10", unit: "支", currency: "USD", extensionData: {}, ...current }),
    },
    customer: { findFirst: async () => ({ id: "customer-1", customerCode: "CUS-1", name: "家百纳", isActive: true }) },
    customerContact: { findFirst: async () => null },
    material: { findMany: async () => [] },
    salesOrderImage: { updateMany: async () => ({}) },
    $transaction: async (fn) => fn(tx),
  };
  return { service: new SalesOrdersService(prisma, auditColumns), calls };
}

test("18 格图片：逐张对齐 —— 变了改这一行（复活）、没提到的软删、新出现的才插入", async () => {
  const existing = [
    { id: "slot-1", specKey: "rib_spec", slotIndex: 0, imageId: IMAGE_A, deletedAt: null },
    { id: "slot-2", specKey: "canopy_spec", slotIndex: 0, imageId: IMAGE_A, deletedAt: new Date("2026-01-01T00:00:00.000Z") }, // 曾经删过 → 要复活
    { id: "slot-3", specKey: "handle_spec", slotIndex: 0, imageId: IMAGE_A, deletedAt: null }, // 请求没提到 → 软删
  ];
  const { service, calls } = updateHarness({
    slotExisting: existing,
    orderImages: [{ id: IMAGE_A }, { id: IMAGE_B }],
    liveImages: [{ id: IMAGE_A }],
    slotRefRows: [{ imageId: IMAGE_A }],
  });
  await service.update(ORDER_ID, { slot_images: [
    { spec_key: "rib_spec", image_ids: [IMAGE_A] },      // 没变 → 一个字都不写
    { spec_key: "canopy_spec", image_ids: [IMAGE_B] },   // 换图 + 复活
    { spec_key: "tail_spec", image_ids: [IMAGE_B] },     // 新增 → 插入
  ] }, user);

  // 归属校验一次查完（不是每格一次往返）
  assert.deepEqual(calls.imageFindMany[0].where, { id: { in: [IMAGE_A, IMAGE_B] }, salesOrderId: ORDER_ID, deletedAt: null });

  const updated = calls.slotUpdate.map((call) => [call.where.id, call.data]);
  assert.deepEqual(updated.map(([id]) => id).sort(), ["slot-2", "slot-3"]);
  const revived = updated.find(([id]) => id === "slot-2")[1];
  assert.equal(revived.imageId, IMAGE_B);
  assert.equal(revived.deletedAt, null, "曾经软删的格子要**复活**这一行");
  assert.equal(revived.deletedBy, null);
  assert.ok(updated.find(([id]) => id === "slot-3")[1].deletedAt instanceof Date, "请求没提到的格子 = 取消这一格的图（软删）");

  assert.deepEqual(calls.slotCreateMany[0].data.map((row) => [row.specKey, row.slotIndex, row.imageId, row.salesOrderId]), [["tail_spec", 0, IMAGE_B, ORDER_ID]]);
  // 替换读一次现有格；另一次是保存末尾的孤儿清理（按 `imageId.in` 数引用）—— 新出现的走 createMany。
  assert.equal(calls.slotFindMany.filter((args) => !args.where.imageId).length, 1);
  assert.equal(calls.slotCreateMany[0].data[0].createdBy, user.id);
});

test("18 格图片：一格从 3 张删到 1 张 —— 只软删 slotIndex 1/2 两行，第 1 张留着", async () => {
  const existing = [0, 1, 2].map((slotIndex) => ({ id: `slot-${slotIndex}`, specKey: "rib_spec", slotIndex, imageId: IMAGE_A, deletedAt: null }));
  const { service, calls } = updateHarness({ slotExisting: existing, orderImages: [{ id: IMAGE_A }], liveImages: [{ id: IMAGE_A }], slotRefRows: [{ imageId: IMAGE_A }] });
  await service.update(ORDER_ID, { slot_images: [{ spec_key: "rib_spec", image_ids: [IMAGE_A] }] }, user);

  // 不能只软删整格：0 那行还挂着第 1 张，软删它等于"把这一格的图全清了"。
  assert.deepEqual(calls.slotUpdate.map((call) => call.where.id), ["slot-1", "slot-2"], "只软删超出的第 2/3 张");
  assert.ok(calls.slotUpdate.every((call) => call.data.deletedAt instanceof Date));
  assert.deepEqual(calls.slotCreateMany, [], "没有新位置要插入");
});

test("18 格图片：空数组 = 全部取消（不是「不动」）；没传 = 连图片表都不查", async () => {
  const cleared = updateHarness({
    slotExisting: [{ id: "slot-1", specKey: "rib_spec", slotIndex: 0, imageId: IMAGE_A, deletedAt: null }],
    liveImages: [],
  });
  await cleared.service.update(ORDER_ID, { slot_images: [] }, user);
  assert.equal(cleared.calls.slotUpdate.length, 1);
  assert.ok(cleared.calls.slotUpdate[0].data.deletedAt instanceof Date);
  assert.deepEqual(cleared.calls.slotCreateMany, []);
  assert.equal(cleared.calls.imageFindMany.length, 1, "空数组没有图片 id、不用归属校验；但 touchesImages 为真，要扫一次孤儿（本次本单一张活图都没有）");
  assert.deepEqual(cleared.calls.imageFindMany[0].where, { salesOrderId: ORDER_ID, deletedAt: null });
  // touchesImages 为真（slot_images 出现了）→ 要扫一次孤儿；本单一张活图都没有，于是什么都不用删。
  assert.equal(cleared.calls.imageUpdateMany.length, 0);

  const untouched = updateHarness();
  await untouched.service.update(ORDER_ID, { reason: "只改了别的字段" }, user);
  assert.deepEqual(untouched.calls.slotFindMany, [], "没提到 slot_images 就整块不动");
  assert.deepEqual(untouched.calls.imageFindMany, [], "没带图片的普通保存一次图片表都不查");
  assert.deepEqual(untouched.calls.imageUpdateMany, []);
});

test("18 格图片：spec_key 必须是材料明细那 18 栏之一，否则 422 SLOT_IMAGE_KEY_UNSUPPORTED 且不写库", async () => {
  const { service, calls } = updateHarness();
  await assert.rejects(
    () => service.update(ORDER_ID, { slot_images: [{ spec_key: "qc_requirement", image_ids: [IMAGE_A] }] }, user),
    (error) => error.getResponse().code === "SLOT_IMAGE_KEY_UNSUPPORTED" && error.getResponse().details[0].spec_key === "qc_requirement",
  );
  assert.deepEqual(calls.slotFindMany, [], "键域校验在事务之前，连查都不查");
  assert.deepEqual(calls.salesOrderUpdate, [], "一个字节都不写");
});

test("normalizeSlotImages：输出数组形状、同一个格后写覆盖先写、旧 image_id 仍认、空格 = 没有图", () => {
  // 2026-11-05 起输出**一律是数组形状**（`[{ spec_key, image_ids }]`）：落库方按 (spec_key, slot_index) 逐张对齐。
  assert.deepEqual(normalizeSlotImages([{ spec_key: "rib_spec", image_ids: [IMAGE_A] }]), [{ spec_key: "rib_spec", image_ids: [IMAGE_A] }]);
  // 后写覆盖先写（接口是公开的，前端自己发重了不该变成看不懂的 400）
  assert.deepEqual(
    normalizeSlotImages([
      { spec_key: "rib_spec", image_ids: [IMAGE_A] },
      { spec_key: " rib_spec ", image_ids: [IMAGE_B, IMAGE_A] },
    ]),
    [{ spec_key: "rib_spec", image_ids: [IMAGE_B, IMAGE_A] }],
    "去重保序；后写的那条整格覆盖先写的",
  );
  // 旧的单张形状（2026-11-04 的请求）等同 image_ids: [id]，老前端不改也能存
  assert.deepEqual(normalizeSlotImages([{ spec_key: "handle_spec", image_id: IMAGE_B }]), [{ spec_key: "handle_spec", image_ids: [IMAGE_B] }]);
  // 两者同时出现时 image_ids 优先
  assert.deepEqual(normalizeSlotImages([{ spec_key: "tail_spec", image_id: IMAGE_A, image_ids: [IMAGE_B] }]), [{ spec_key: "tail_spec", image_ids: [IMAGE_B] }]);
  // [] = 这一格没有图（清空这一格），不再报「没有给出图片 id」：整块替换语义下"清空"必须表达得出来
  assert.deepEqual(normalizeSlotImages([{ spec_key: "rib_spec", image_ids: [] }]), [{ spec_key: "rib_spec", image_ids: [] }]);
  assert.deepEqual(normalizeSlotImages([]), []);
  assert.throws(
    () => normalizeSlotImages([{ spec_key: "sample_requirement", image_ids: [IMAGE_A] }]),
    (error) => error.getResponse().code === "SLOT_IMAGE_KEY_UNSUPPORTED",
  );
  // 超过 3 张 → 422 SALES_ORDER_IMAGE_LIMIT，details 指到哪一格、几张
  assert.throws(
    () => normalizeSlotImages([{ spec_key: "rib_spec", image_ids: [IMAGE_A, IMAGE_B, CLONE_A, CLONE_B] }]),
    (error) => {
      const response = error.getResponse();
      assert.equal(response.code, "SALES_ORDER_IMAGE_LIMIT");
      assert.match(response.message, /一行\/一格最多 3 张图片/);
      assert.deepEqual(response.details, [{ scope: "slot_images", key: "rib_spec", count: 4 }]);
      return true;
    },
  );
});

// ================================================================== ④ 行 image_id 落库

test("行图落库：明细行与「其它」行的 image_id 写进各自的表（且只接受本单的图）", async () => {
  const { service, calls } = updateHarness({
    orderImages: [{ id: IMAGE_A }, { id: IMAGE_B }],
    liveImages: [{ id: IMAGE_A }, { id: IMAGE_B }],
    detailRefRows: [{ imageId: IMAGE_A }, { imageId: IMAGE_B }],
  });
  await service.update(ORDER_ID, {
    spec_details: [
      { group_name: "伞布明细", name: "DL260134", image_id: IMAGE_A },
      { group_name: "伞头配色", name: "Hawái", image_id: IMAGE_B },
      { group_name: "伞布明细", name: "DL260135" },
    ],
    material_extras: [{ spec_key: "handle_spec", content: "直柄银色", image_id: IMAGE_A }],
  }, user);

  assert.deepEqual(calls.specCreateMany[0].data.map((row) => row.imageId), [IMAGE_A, IMAGE_B, null], "每行一张图；没有图的行走 null");
  assert.deepEqual(calls.extraCreateMany[0].data.map((row) => row.imageId), [IMAGE_A]);
  assert.equal(calls.specCreateMany[0].data[0].salesOrderId, ORDER_ID);

  // 三处引用都在 → 清理不该软删任何图（两张都被引用了）
  assert.deepEqual(calls.imageUpdateMany, []);
  // 清理要同时看 18 格 / 明细行 / 「其它」行三处引用（格图那次查在 `slotFindMany` 里，按 imageId.in 分辨）
  assert.equal(calls.cleanupRefs.length, 2);
  assert.equal(calls.slotFindMany.filter((args) => args.where.imageId).length, 1, "清理要数 18 格的图引用");
});

test("更新：图片不存在、已删除或不属于本单 → 422 SALES_ORDER_IMAGE_NOT_FOUND，一个字都不写", async () => {
  const { service, calls } = updateHarness({ orderImages: [{ id: IMAGE_A }] }); // IMAGE_B 不是本单的
  await assert.rejects(
    () => service.update(ORDER_ID, { spec_details: [{ group_name: "伞布明细", name: "x", image_id: IMAGE_B }] }, user),
    (error) => {
      assert.equal(error.getResponse().code, "SALES_ORDER_IMAGE_NOT_FOUND");
      assert.deepEqual(error.getResponse().details, [{ image_id: IMAGE_B, sales_order_id: ORDER_ID }]);
      return true;
    },
  );
  assert.deepEqual(calls.salesOrderUpdate, [], "归属校验在写之前");
  assert.deepEqual(calls.specCreateMany, []);
});

// ================================================================== ⑤ 返单/复制：克隆字节

function reorderHarness(source) {
  const calls = { createData: undefined, versionData: undefined, specRows: undefined, extraRows: undefined, slotRows: undefined, cloneCreate: [], imageFindMany: [], refRows: [] };
  const createdRow = { id: NEW_ORDER_ID, orderNo: "SO-NEW", status: "draft", currentVersion: 1, customerId: "customer-1", extensionData: {}, orderDate: new Date(), productName: "伞", quantity: "10", unit: "支", currency: "USD", contactId: null, boms: [], versions: [], specDetails: [], materialRefs: [], materialExtras: [], slotImages: [] };
  const tx = {
    salesOrder: { create: async (args) => { calls.createData = args.data; return createdRow; } },
    salesOrderVersion: { create: async (args) => { calls.versionData = args.data; return args.data; } },
    salesOrderSpecDetail: { updateMany: async () => ({}), createMany: async (args) => { calls.specRows = args.data; return { count: args.data.length }; }, findMany: async () => [] },
    salesOrderMaterialRef: { findMany: async () => [], update: async () => ({}), createMany: async (args) => { calls.refRows = args.data; return { count: args.data.length }; } },
    salesOrderMaterialExtra: { updateMany: async () => ({}), createMany: async (args) => { calls.extraRows = args.data; return { count: args.data.length }; }, findMany: async () => [] },
    salesOrderSlotImage: { findMany: async () => [], update: async () => ({}), createMany: async (args) => { calls.slotRows = args.data; return { count: args.data.length }; } },
    salesOrderImage: {
      findMany: async (args) => { calls.imageFindMany.push(args); return source.images ?? []; },
      create: async (args) => {
        calls.cloneCreate.push(args.data);
        // 按调用顺序给出新单自己的图片 id（A 先、B 后，与 source.images 同序）
        return { id: calls.cloneCreate.length === 1 ? CLONE_A : CLONE_B };
      },
    },
  };
  const prisma = {
    customer: { findFirst: async () => ({ id: "customer-1", customerCode: "CUS-1", name: "家百纳", isActive: true }) },
    customerContact: { findFirst: async () => null },
    material: { findMany: async () => [] },
    salesOrder: { findFirst: async () => (calls.createData ? createdRow : source.order) },
    salesOrderImage: { updateMany: async () => ({}) },
    $transaction: async (fn) => fn(tx),
  };
  return { service: new SalesOrdersService(prisma, auditColumns), calls };
}

test("返单/复制：来源单的图画进新单 —— 字节/宽高/sha 原样克隆成新行，绝不跨单引用", async () => {
  const sourceBytesA = webp({ width: 800, height: 600 });
  const sourceBytesB = webp({ width: 300, height: 400 });
  const sourceSummaryA = { id: IMAGE_A, width: 800, height: 600, byteSize: sourceBytesA.length, sha256: sha256(sourceBytesA) };
  const sourceSummaryB = { id: IMAGE_B, width: 300, height: 400, byteSize: sourceBytesB.length, sha256: sha256(sourceBytesB) };
  const source = {
    images: [
      { id: IMAGE_A, salesOrderId: SOURCE_ORDER_ID, data: sourceBytesA, mimeType: "image/webp", width: 800, height: 600, byteSize: sourceBytesA.length, sha256: sha256(sourceBytesA) },
      { id: IMAGE_B, salesOrderId: SOURCE_ORDER_ID, data: sourceBytesB, mimeType: "image/webp", width: 300, height: 400, byteSize: sourceBytesB.length, sha256: sha256(sourceBytesB) },
    ],
    order: {
      id: SOURCE_ORDER_ID, orderNo: "SO-OLD", status: "closed", itemNo: "27621",
      customerId: "customer-1", contactId: null, productName: "50cm 三折伞", productSpec: null, unit: "支", currency: "USD",
      customerPoNo: null, externalContractNo: null, unitPrice: null, settlementUnitPrice: null, taxRate: null, settlementMethod: null,
      quantity: "1960", orderDate: new Date("2026-06-18T00:00:00.000Z"), deliveryDate: null, totalAmount: null, receivableAmount: null,
      localCurrencyAmount: null, extensionData: {}, currentVersion: 3, reorderFromOrderNo: null, specDetailLabels: {},
      // 行上的图：一张明细行图（A）、一张「其它」行图（B）、18 格图（A）
      specDetails: [{ groupName: "伞布明细", name: "27621 流水花扇PKGY", color: "PKGY", barcode: null, quantity: null, unit: null, sortOrder: 0, imageId: IMAGE_A, image: sourceSummaryA }],
      materialRefs: [],
      materialExtras: [{ label: "伞头", content: "直柄银色", specKey: "handle_spec", sortOrder: 0, materialId: null, imageId: IMAGE_B, image: sourceSummaryB }],
      slotImages: [{ specKey: "canopy_spec", imageId: IMAGE_A, image: sourceSummaryA }],
    },
  };
  const { service, calls } = reorderHarness(source);
  await service.create({ order_no: "SO-NEW", order_date: "2026-11-04", quantity: "2500", delivery_date: "2026-12-01", reorder_from_order_no: "SO-OLD" }, user);

  // 只查一次图片库，一次查完全部被引用的 id（不是每张一次往返）
  assert.deepEqual(calls.imageFindMany[0].where, { id: { in: [IMAGE_A, IMAGE_B] }, deletedAt: null });

  assert.equal(calls.cloneCreate.length, 2, "两张来源图各克隆一条新行");
  assert.deepEqual(calls.cloneCreate.map((row) => row.salesOrderId), [NEW_ORDER_ID, NEW_ORDER_ID], "克隆出来的图属于**新单**");
  assert.deepEqual(Buffer.from(calls.cloneCreate[0].data), sourceBytesA, "同字节");
  assert.notEqual(calls.cloneCreate[0].data, sourceBytesA, "必须是新的 ArrayBuffer（Prisma Bytes 类型 + 不许共享可变内存）");
  assert.equal(calls.cloneCreate[0].width, 800);
  assert.equal(calls.cloneCreate[0].height, 600);
  assert.equal(calls.cloneCreate[0].byteSize, sourceBytesA.length);
  assert.equal(calls.cloneCreate[0].sha256, sha256(sourceBytesA), "sha 原样保留（图片内容没变）");
  assert.equal(calls.cloneCreate[0].mimeType, "image/webp");

  // 三处指针都指向**新单的**图片 id，绝不跨单引用来源单的 id
  assert.deepEqual(calls.specRows.map((row) => [row.salesOrderId, row.imageId]), [[NEW_ORDER_ID, CLONE_A]]);
  assert.deepEqual(calls.extraRows.map((row) => [row.salesOrderId, row.imageId]), [[NEW_ORDER_ID, CLONE_B]]);
  assert.deepEqual(calls.slotRows.map((row) => [row.salesOrderId, row.specKey, row.imageId]), [[NEW_ORDER_ID, "canopy_spec", CLONE_A]]);
  for (const row of [...calls.specRows, ...calls.extraRows, ...calls.slotRows]) {
    assert.notEqual(row.imageId, IMAGE_A);
    assert.notEqual(row.imageId, IMAGE_B);
  }

  // 快照跟请求载荷走（只记图片 id 指针，不存字节）：回看某一版能回答「当时挂的是哪几张图」。
  // 2026-11-05 起一律是**数组**（§3.4）：返单来源的一行/一格都收成 `image_ids`（顺序 = 用户看到的顺序）。
  assert.deepEqual(calls.versionData.snapshot.slot_images, [{ spec_key: "canopy_spec", image_ids: [IMAGE_A] }]);
  assert.deepEqual(calls.versionData.snapshot.spec_details[0].image_ids, [IMAGE_A]);
  assert.deepEqual(calls.versionData.snapshot.material_extras[0].image_ids, [IMAGE_B]);
});

test("返单/复制：来源单引用的图片已不存在 → 422 SALES_ORDER_IMAGE_NOT_FOUND（不静默丢图）", async () => {
  const source = {
    images: [],
    order: {
      id: SOURCE_ORDER_ID, orderNo: "SO-OLD", status: "closed", itemNo: "27621", customerId: "customer-1", contactId: null,
      productName: "伞", productSpec: null, unit: "支", currency: "USD", customerPoNo: null, externalContractNo: null,
      unitPrice: null, settlementUnitPrice: null, taxRate: null, settlementMethod: null, quantity: "10",
      orderDate: new Date(), deliveryDate: null, totalAmount: null, receivableAmount: null, localCurrencyAmount: null,
      extensionData: {}, currentVersion: 1, reorderFromOrderNo: null, specDetailLabels: {}, materialRefs: [], materialExtras: [],
      specDetails: [{ groupName: "伞布明细", name: "x", sortOrder: 0, imageId: IMAGE_A, image: null }],
      slotImages: [],
    },
  };
  const { service, calls } = reorderHarness(source);
  await assert.rejects(
    () => service.create({ order_no: "SO-NEW", order_date: "2026-11-04", quantity: "10", reorder_from_order_no: "SO-OLD" }, user),
    (error) => error.getResponse().code === "SALES_ORDER_IMAGE_NOT_FOUND",
  );
  assert.deepEqual(calls.cloneCreate, []);
});

// ================================================================== ⑥ 孤儿清理

test("无引用清理：本单没有任何活行引用的图在保存末尾软删（只软删，不硬删）", async () => {
  const { service, calls } = updateHarness({
    slotExisting: [],
    // 本单两张活图；明细行只引用了 A，B 成了孤儿（用户传了又删图）
    liveImages: [{ id: IMAGE_A }, { id: IMAGE_B }],
    slotRefRows: [],
    detailRefRows: [{ imageId: IMAGE_A }],
    extraRefRows: [],
    orderImages: [],
  });
  await service.update(ORDER_ID, { slot_images: [] }, user);

  // 清理的三个查询：格图引用（`slotFindMany`）、明细行引用、「其它」行引用
  assert.equal(calls.cleanupRefs.length, 2);
  assert.equal(calls.slotFindMany.filter((args) => args.where.imageId).length, 1);
  const ids = calls.imageUpdateMany[0].where.id.in;
  assert.deepEqual(ids, [IMAGE_B], "只有「谁都没引用」的那张被清；被明细行引用的 A 留着");
  assert.ok(calls.imageUpdateMany[0].data.deletedAt instanceof Date, "软删（图片行还可能被版本快照的 image_id 提到）");
  assert.equal(calls.imageUpdateMany[0].data.deletedBy, user.id);
});

test("无引用清理：本单的图全被引用 → 一条 updateMany 都不发", async () => {
  const { service, calls } = updateHarness({
    liveImages: [{ id: IMAGE_A }],
    slotRefRows: [{ imageId: IMAGE_A }],
    detailRefRows: [],
    extraRefRows: [],
    orderImages: [],
  });
  await service.update(ORDER_ID, { slot_images: [] }, user);
  assert.deepEqual(calls.imageUpdateMany, []);
});

// ================================================================== ⑦ 路由与导出上限

test("路由：GET :id/images/:imageId 必须声明在 @Get(\":id\") 之前", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "src", "modules", "sales", "sales-orders.controller.ts"), "utf8");
  const imageRoute = source.indexOf('@Get(":id/images/:imageId")');
  const byId = source.indexOf('@Get(":id") async');
  assert.ok(imageRoute > 0, "行图片读取路由必须存在");
  assert.ok(imageRoute < byId, "Nest 按声明顺序匹配：具体路径必须在 :id 之前");
  // 上传路由两段，同样声明在 :id 之前（本文件所有多段 GET/POST 都遵守这条约定）
  assert.ok(source.indexOf('@Post(":id/images")') > 0);
  assert.ok(source.indexOf('@Post(":id/images")') < byId);
});

test("导出：工艺单 multipart 的 files 上限跟着「每个位置 3 张」走（★3 + 明细行图片 200）", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "src", "modules", "sales", "sales-orders.controller.ts"), "utf8");
  // 2026-11-05：导出的候选是**每张图一条**（`spec_key#2`/`#3`），所以 18 格与「其它」行那两段要各 × 3 ——
  // 不加的话「18 格全填满 3 张」这种正常请求会先被 multer 用 LIMIT_FILE_COUNT 挡下。
  assert.match(source, /const PRODUCTION_SHEET_IMAGE_FILE_LIMIT = \(SPEC_MATERIAL_KEYS\.length \+ MATERIAL_EXTRA_LIMIT\) \* MAX_ROW_IMAGES \+ 200;/);
  assert.match(source, /files: PRODUCTION_SHEET_IMAGE_FILE_LIMIT/);
  assert.equal(/files: SPEC_MATERIAL_KEYS\.length \+ MATERIAL_EXTRA_LIMIT\s*\}/.test(source), false, "旧的「18 + 20」上限必须换掉");
});

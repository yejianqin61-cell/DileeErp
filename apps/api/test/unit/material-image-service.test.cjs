// 物料图片服务层的行为契约（用户 2026-09-24：「物料清单，要给物料配上图片」）。
//
// 钉住四件事：
//   ① 上传前**先校验**（不是 WebP 的字节不许进库），失败时一行都不写；
//   ② 字节进 `data`、宽高/字节数/sha256 进列，`mimeType` 一律写 `image/webp`（内容说了算，不听客户端的）；
//   ③ 列表查询**只取元数据、绝不带 `data`**（物料列表是采购/BOM/仓库/销售页每次都要拉的接口）；
//   ④ 上传/删除都记审计（图片是主数据的一部分），但审计里不含字节。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHash } = require("node:crypto");
const { AuditService } = require("../../dist/platform/audit/audit.service.js");
const { ProcurementMasterDataService, MATERIAL_IMAGE_SUMMARY } = require("../../dist/modules/procurement/procurement-master-data.service.js");

const USER = { id: "00000000-0000-0000-0000-0000000000aa", username: "tester", display_name: "测试" };
const MATERIAL_ID = "22222222-2222-2222-2222-222222222222";
const REAL_WEBP = Buffer.from("UklGRkAAAABXRUJQVlA4IDQAAAAwAwCdASolABcAPu12tFOppyUipWgBMB2JZwDKAA9i7tmAAJhpf9Cvkz7rj3DmFoGahQAA", "base64");

function harness(options = {}) {
  const calls = { upsert: [], delete: [], findUnique: [], materialFindFirst: [], materialFindMany: [], auditEvent: [] };
  const imageRow = options.imageRow === undefined ? null : options.imageRow;
  const prisma = {
    material: {
      findFirst: async (args) => { calls.materialFindFirst.push(args); return options.material === null ? null : { id: MATERIAL_ID, materialCode: "MAT-1", name: "伞布", deletedAt: null }; },
      findMany: async (args) => { calls.materialFindMany.push(args); return []; },
    },
    materialImage: {
      upsert: async (args) => { calls.upsert.push(args); return { id: "img-1", ...(args.update ?? args.create), ...(options.savedRow ?? {}) }; },
      delete: async (args) => { calls.delete.push(args); return { id: "img-1" }; },
      findUnique: async (args) => { calls.findUnique.push(args); return imageRow === null ? null : { ...imageRow, material: { materialCode: "MAT-1", name: "伞布" } }; },
    },
    auditEvent: { create: async (args) => { calls.auditEvent.push(args); return { id: `audit-${calls.auditEvent.length}` }; } },
  };
  const service = new ProcurementMasterDataService(prisma, new AuditService(prisma));
  return { service, calls };
}

const codeOf = (error) => error?.getResponse?.().code;
const file = (buffer, name = "伞布.webp") => ({ buffer, originalname: name, mimetype: "image/webp" });

test("上传物料图片：字节入库 + 元数据入库 + 记审计，mimeType 由内容决定", async () => {
  const { service, calls } = harness();
  const saved = await service.setMaterialImage(MATERIAL_ID, file(REAL_WEBP), USER);

  assert.equal(calls.upsert.length, 1);
  const data = calls.upsert[0].create;
  assert.equal(data.materialId, MATERIAL_ID);
  assert.deepEqual([data.width, data.height, data.byteSize], [37, 23, REAL_WEBP.length], "宽高与字节数从**解析结果**来，不听客户端");
  assert.equal(data.mimeType, "image/webp");
  assert.equal(data.sha256, createHash("sha256").update(REAL_WEBP).digest("hex"), "sha256 既当 ETag 也当「换没换图」的判据");
  assert.deepEqual(Array.from(Buffer.from(data.data)), Array.from(REAL_WEBP), "字节原样入库");
  assert.equal(data.createdBy, USER.id);

  // 同一物料只有一张图 → upsert（换图是改这一行，不是再插一行）
  assert.deepEqual(calls.upsert[0].where, { materialId: MATERIAL_ID });
  assert.equal("materialId" in calls.upsert[0].update, false, "update 分支不该改 materialId");

  assert.equal(calls.auditEvent.length, 1);
  assert.equal(calls.auditEvent[0].data.action, "material.image_set");
  assert.deepEqual(calls.auditEvent[0].data.details, { width: 37, height: 23, byte_size: REAL_WEBP.length });
  assert.equal("data" in calls.auditEvent[0].data.details, false, "审计里绝不放字节");
  assert.equal(saved.id, "img-1");
});

test("上传物料图片：不是 WebP 的字节一个都不许落库（伪装成 .webp 的 PNG 也要挡住）", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  const { service, calls } = harness();
  await assert.rejects(() => service.setMaterialImage(MATERIAL_ID, file(png, "假装是图.webp"), USER), (error) => codeOf(error) === "MATERIAL_IMAGE_NOT_WEBP");
  assert.equal(calls.upsert.length, 0, "校验不过不许写库");
  assert.equal(calls.auditEvent.length, 0, "也不许留下一条「上传成功」的审计");
});

test("上传物料图片：没带文件 / 物料不存在，各自有自己的错误码", async () => {
  const missing = harness();
  await assert.rejects(() => missing.service.setMaterialImage(MATERIAL_ID, undefined, USER), (error) => codeOf(error) === "MATERIAL_IMAGE_FILE_REQUIRED");
  assert.equal(missing.calls.upsert.length, 0);

  const gone = harness({ material: null });
  await assert.rejects(() => gone.service.setMaterialImage(MATERIAL_ID, file(REAL_WEBP), USER), (error) => codeOf(error) === "MATERIAL_NOT_FOUND");
  assert.equal(gone.calls.upsert.length, 0, "物料不存在时连校验都不该白跑一趟之后的写库");
});

test("删除物料图片：硬删 + 记审计；没有图时 404", async () => {
  const { service, calls } = harness({ imageRow: { id: "img-1", materialId: MATERIAL_ID, sha256: "abc" } });
  const result = await service.clearMaterialImage(MATERIAL_ID, USER);
  assert.deepEqual(result, { material_id: MATERIAL_ID, cleared: true });
  assert.deepEqual(calls.delete[0].where, { materialId: MATERIAL_ID });
  assert.equal(calls.auditEvent[0].data.action, "material.image_cleared");
  assert.deepEqual(calls.auditEvent[0].data.details, { sha256: "abc" });

  const none = harness({ imageRow: null });
  await assert.rejects(() => none.service.clearMaterialImage(MATERIAL_ID, USER), (error) => codeOf(error) === "MATERIAL_IMAGE_NOT_FOUND");
  assert.equal(none.calls.delete.length, 0);
});

test("读物料图片：返回字节 + mime + 文件名（文件名用物料编码，落盘/下载时认得出来）", async () => {
  const { service } = harness({ imageRow: { id: "img-1", materialId: MATERIAL_ID, data: new Uint8Array(REAL_WEBP), mimeType: "image/webp", sha256: "deadbeef" } });
  const image = await service.materialImage(MATERIAL_ID);
  assert.equal(image.mimeType, "image/webp");
  assert.equal(image.sha256, "deadbeef");
  assert.equal(image.fileName, "MAT-1.webp");
  assert.deepEqual(Array.from(image.data), Array.from(REAL_WEBP));

  const none = harness({ imageRow: null });
  assert.equal(await none.service.materialImage(MATERIAL_ID), null, "没有图返回 null（由控制器翻成 404）");
});

test("物料列表：只 select 图片**元数据**，绝不把 data 带进列表响应", async () => {
  const { service, calls } = harness();
  await service.listMaterials();
  const include = calls.materialFindMany[0].include;
  assert.deepEqual(include.image, { select: MATERIAL_IMAGE_SUMMARY });
  assert.equal("data" in MATERIAL_IMAGE_SUMMARY, false, "元数据清单里不许有 data —— 这是列表不带字节的唯一保证");
  assert.deepEqual(Object.keys(MATERIAL_IMAGE_SUMMARY).sort(), ["byteSize", "height", "id", "sha256", "updatedAt", "width"]);
});

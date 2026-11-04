// 物料图片前端逻辑的测试（node:test，与 apps/web/lib/*.test.mjs 同一套）。
//
// 用户 2026-09-24：「物料清单，要给物料配上图片。图片上传之后要压缩成 webp 再存进数据库里」。
//
// 这里**没有 DOM**：压缩管线（`ImagePipeline`）是注入的，所以测的是「我们要它做什么」——
// 尺寸怎么缩、哪种情况根本不发请求、编码器偷偷给了 PNG 时怎么办。
// 最后那一条是最容易漏的：Safari 老版本的 `canvas.toBlob(..., "image/webp")` 会**静默**回退成
// PNG，如果不在这里拦住，用户会看到后端报「不是 WebP」，而真正的原因是他的浏览器。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MATERIAL_IMAGE_MAX_BYTES,
  MATERIAL_IMAGE_MAX_EDGE,
  compressImageToWebp,
  deleteMaterialImage,
  fitWithin,
  materialImagePath,
  materialImageProblem,
  materialImageUrl,
  salesOrderImagePath,
  salesOrderImageUrl,
  uploadMaterialImage,
  uploadSalesOrderImage,
  webpFileName,
} from "./material-image.ts";

const file = (extra = {}) => ({ name: "伞布.png", type: "image/png", size: 1024 * 1024, ...extra });
// Node 的 FormData 只接受真的 Blob（假对象会在 append 时抛 TypeError），所以夹具用真 Blob。
const webp = (size = 1000) => new Blob([new Uint8Array(size)], { type: "image/webp" });

/** 假管线：记录「有没有被问到」，并按需返回指定尺寸/编码结果。 */
function pipeline({ width = 4000, height = 3000, blob = webp(), onEncode } = {}) {
  const seen = { measure: 0, encode: [] };
  return {
    seen,
    measure: async () => { seen.measure += 1; return { width, height }; },
    encodeWebp: async (_file, size) => { seen.encode.push(size); onEncode?.(size); return blob; },
  };
}

test("material-image：等比缩放到最长边上限，小图不放大", () => {
  assert.equal(MATERIAL_IMAGE_MAX_EDGE, 1600);
  assert.deepEqual(fitWithin(4000, 3000), { width: 1600, height: 1200 }, "横图按长边缩");
  assert.deepEqual(fitWithin(3000, 4000), { width: 1200, height: 1600 }, "竖图按长边缩");
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 }, "本来就小：不放大");
  assert.deepEqual(fitWithin(1600, 900), { width: 1600, height: 900 }, "正好等于上限：原样");
  assert.deepEqual(fitWithin(2001, 1000), { width: 1600, height: 800 });
  assert.deepEqual(fitWithin(0, 0), { width: 1, height: 1 }, "读不出尺寸也不能给 0（canvas 会抛错）");
});

test("material-image：不是图片的文件在**发请求之前**就被拦下", () => {
  assert.equal(materialImageProblem(file()), null);
  assert.match(materialImageProblem(file({ name: "报价单.pdf", type: "application/pdf" })), /只能上传图片/);
  assert.match(materialImageProblem(file({ name: "表.xlsx", type: "" })), /只能上传图片/);
  assert.match(materialImageProblem(file({ size: 21 * 1024 * 1024 })), /超过 20MB/);
  assert.match(materialImageProblem(null), /请选择/);
  // mimetype 缺失但扩展名是图片（部分系统会这样）要放行。
  assert.equal(materialImageProblem(file({ type: "", name: "IMG_0001.JPG" })), null);
});

test("material-image：压缩按「先量尺寸、再按缩过的尺寸编码」，并把真实宽高回报出去", async () => {
  const fake = pipeline({ width: 4000, height: 3000 });
  const result = await compressImageToWebp(file(), fake);
  assert.deepEqual(fake.seen.encode, [{ width: 1600, height: 1200 }], "编码用的必须是缩过的尺寸");
  assert.deepEqual([result.width, result.height], [1600, 1200]);
  assert.equal(result.blob.type, "image/webp");
});

test("material-image：编码器给了 PNG（旧 Safari 会静默回退）就报「换浏览器」，不许把它传上去", async () => {
  const fake = pipeline({ blob: new Blob([new Uint8Array(500)], { type: "image/png" }) });
  await assert.rejects(() => compressImageToWebp(file(), fake), /不支持把图片压成 WebP/);
});

test("material-image：压完仍然超过 2MB 时给出「剩多少 / 上限多少」", async () => {
  assert.equal(MATERIAL_IMAGE_MAX_BYTES, 2 * 1024 * 1024);
  const fake = pipeline({ blob: webp(MATERIAL_IMAGE_MAX_BYTES + 1) });
  await assert.rejects(() => compressImageToWebp(file(), fake), /超过 2MB 上限/);
  // 正好等于上限要放行（边界不能写成「小于」）。
  const ok = pipeline({ blob: webp(MATERIAL_IMAGE_MAX_BYTES) });
  assert.equal((await compressImageToWebp(file(), ok)).blob.size, MATERIAL_IMAGE_MAX_BYTES);
});

test("material-image：不是图片时**一次都不调用**解码与编码（先拦再干活）", async () => {
  const fake = pipeline();
  await assert.rejects(() => compressImageToWebp({ name: "a.pdf", type: "application/pdf", size: 10 }, fake), /只能上传图片/);
  assert.deepEqual(fake.seen, { measure: 0, encode: [] });
});

test("material-image：文件名换成 .webp（后端 multer 按扩展名放行，内容另有校验）", () => {
  assert.equal(webpFileName("伞布 花色.png"), "伞布 花色.webp");
  assert.equal(webpFileName("IMG_0001.JPG"), "IMG_0001.webp");
  assert.equal(webpFileName("没有扩展名"), "没有扩展名.webp");
  assert.equal(webpFileName(".png"), "material.webp", "只剩扩展名时给一个兜底名，不能得到空名字");
  assert.equal(webpFileName(""), "material.webp");
});

test("material-image：图片地址自带 /api/v1 前缀（<img> 不走 api-client），带版本号破缓存", () => {
  assert.equal(materialImagePath("m-1"), "/materials/m-1/image");
  assert.equal(materialImageUrl("m-1"), "/api/v1/materials/m-1/image");
  assert.equal(materialImageUrl("m-1", "abc123"), "/api/v1/materials/m-1/image?v=abc123");
  assert.equal(materialImageUrl("m-1", ""), "/api/v1/materials/m-1/image", "版本号为空时不拼多余的 ?v=");
});

test("material-image：上传是 multipart（不是 JSON），字段名必须是 file", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: { id: "img-1", width: 1600, height: 1200, byteSize: 900, sha256: "x", updatedAt: "2026-09-24T00:00:00.000Z" }, meta: {} }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    const saved = await uploadMaterialImage("m-1", file(), pipeline({ blob: webp() }));
    assert.equal(calls[0].url, "/api/v1/materials/m-1/image");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.credentials, "include");
    const body = calls[0].init.body;
    assert.equal(body instanceof FormData, true, "必须是 FormData —— 走 apiPost 会被 JSON 化");
    assert.equal(body.get("file").type, "image/webp");
    assert.equal(body.get("file").name, "伞布.webp", "文件名换成 .webp");
    assert.equal(saved.id, "img-1");
  } finally {
    globalThis.fetch = original;
  }
});

test("material-image：上传失败把后端的原因原样抛出去（不吞成「上传失败」）", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "MATERIAL_IMAGE_NOT_WEBP", message: "只支持 WebP 图片", details: [] } }), { status: 422, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(() => uploadMaterialImage("m-1", file(), pipeline()), (error) => error.code === "MATERIAL_IMAGE_NOT_WEBP" && error.message === "只支持 WebP 图片");
  } finally {
    globalThis.fetch = original;
  }
});

test("material-image：删除走 DELETE，失败同样带出后端原因", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: { material_id: "m-1", cleared: true }, meta: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await deleteMaterialImage("m-1");
    assert.deepEqual([calls[0].url, calls[0].init.method], ["/api/v1/materials/m-1/image", "DELETE"]);
  } finally {
    globalThis.fetch = original;
  }

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "MATERIAL_IMAGE_NOT_FOUND", message: "该物料没有图片", details: [] } }), { status: 404, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(() => deleteMaterialImage("m-1"), (error) => error.code === "MATERIAL_IMAGE_NOT_FOUND");
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------- 销售单行图片（2026-11-04「每种一张图」）
//
// 与物料图**同一套压缩与错误口径**，只是归属不同：接口是 `POST /sales-orders/:id/images`
//（multipart 字段名 `file`），读图是 `GET /sales-orders/:id/images/:imageId`，按单隔离。
// 这里钉住路径/地址/上传三件事 —— 前端所有行图控件都依赖它们，写错一处就是「图传上去了但显示不出来」。

test("material-image：销售单图片的路径与 <img src>（/api/v1 前缀 + ?v=sha 破缓存）", () => {
  assert.equal(salesOrderImagePath("so-1"), "/sales-orders/so-1/images", "不带 imageId 时是上传用的集合路径");
  assert.equal(salesOrderImagePath("so-1", "img-1"), "/sales-orders/so-1/images/img-1");
  assert.equal(salesOrderImagePath("so-1", ""), "/sales-orders/so-1/images", "空 imageId 不拼尾巴");
  assert.equal(salesOrderImageUrl("so-1", "img-1"), "/api/v1/sales-orders/so-1/images/img-1");
  assert.equal(salesOrderImageUrl("so-1", "img-1", "abc123"), "/api/v1/sales-orders/so-1/images/img-1?v=abc123");
  assert.equal(salesOrderImageUrl("so-1", "img-1", ""), "/api/v1/sales-orders/so-1/images/img-1", "版本号为空时不拼多余的 ?v=");
  assert.equal(salesOrderImageUrl("so-1", "img-1", null), "/api/v1/sales-orders/so-1/images/img-1");
});

test("material-image：销售单图上传是 multipart（字段名 file）、走本单的图片接口", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: { id: "img-1", width: 1600, height: 1200, byteSize: 900, sha256: "x", updatedAt: "2026-11-04T00:00:00.000Z" }, meta: {} }), { status: 201, headers: { "content-type": "application/json" } });
  };
  try {
    const saved = await uploadSalesOrderImage("so-1", file(), pipeline({ blob: webp() }));
    assert.equal(calls[0].url, "/api/v1/sales-orders/so-1/images", "不能写成物料图接口（那是另一个归属）");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.credentials, "include");
    const body = calls[0].init.body;
    assert.equal(body instanceof FormData, true, "必须是 FormData —— 走 apiPost 会被 JSON 化");
    assert.equal(body.get("file").type, "image/webp");
    assert.equal(body.get("file").name, "伞布.webp", "文件名换成 .webp（后端 multer 按扩展名放行）");
    assert.equal(saved.id, "img-1");
  } finally {
    globalThis.fetch = original;
  }
});

test("material-image：销售单图上传沿用同一个压缩管线（不是图片时一次都不发请求）", async () => {
  const original = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; return new Response("{}", { status: 200 }); };
  try {
    const fake = pipeline();
    await assert.rejects(() => uploadSalesOrderImage("so-1", { name: "a.pdf", type: "application/pdf", size: 10 }, fake), /只能上传图片/);
    assert.equal(called, 0, "不是图片就不该发请求");
    assert.deepEqual(fake.seen, { measure: 0, encode: [] });
  } finally {
    globalThis.fetch = original;
  }
});

test("material-image：销售单图上传失败把后端原因原样抛出（可据此区分没有权限等情形）", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "SALES_ORDER_IMAGE_NOT_FOUND", message: "销售单不存在", details: [] } }), { status: 404, headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(() => uploadSalesOrderImage("so-1", file(), pipeline()), (error) => error.code === "SALES_ORDER_IMAGE_NOT_FOUND" && error.message === "销售单不存在");
  } finally {
    globalThis.fetch = original;
  }
});

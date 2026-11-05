// 工艺单「带图片导出」前端逻辑的测试（node:test，与 apps/web/lib/*.test.mjs 同一套）。
//
// 用户 2026-09-24：「导出销售单的时候，每个有图片的物料允许用户勾选是否 excel 中一并导出这个图片」。
// 2026-11-04 扩到行级图片（docs/design/sales-order-row-images-2026-11-04.md §2.4）：
// 候选带 `image_url`（材料行自己的图 / 引用物料的图 / 其它行 / 明细行的图都由后端给地址），
// 键还可能是 `extra:<行 id>` / `detail:<行 id>`。
// 2026-11-05 扩到「每个位置最多 3 张」（docs/design/sales-order-row-images-x3-2026-11-05.md §3.5）：
// 候选**每张图一条**，第 2/3 张的 `spec_key` 带 `#2`/`#3`，另给 `base_key` / `image_slot`，
// label 由后端追加「（第 n 张）」。
//
// 这里**没有 DOM**（画布相关的部分注入成 `SheetImageDeps`），所以测的是纯逻辑：
//   ① 只列**有图**的候选，默认全勾（含同一格的第 2/3 张，一张都不许漏）；
//   ② 候选行的文字：有物料编码时带上物料，行图（明细行 / 其它行）直接用 label，
//      第 2/3 张的「（第 n 张）」由 label 带、这里不重复拼；
//   ③ 等比缩放到最大边 640 且不放大；
//   ④ 取图按候选的 `image_url`（行图没有物料 id，拼 material_id 的老写法必然取错）；
//   ⑤ 装表单时字段名 = 候选 `spec_key`（含 `#2`/`#3`；后端按 fieldname 定位「哪一格第几张」）；
//   ⑥ 字段名对前端是**不透明字符串**（`extra:<行 id>` / `detail:<行 id>` / `#n` 都不许改写）；
//   ⑦ 导出地址自带 /api/v1（走的是裸 fetch，不像 api-client 会补前缀）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPORT_IMAGE_MAX_EDGE,
  browserSheetImageDeps,
  buildProductionSheetForm,
  candidateLabel,
  defaultImageSelection,
  exportImageScale,
  exportImagesPath,
  productionSheetExportPath,
  productionSheetFileName,
  selectableImages,
} from "./production-sheet-image.ts";

const candidate = (extra = {}) => ({
  spec_key: "rib_spec", base_key: "rib_spec", image_slot: 0, label: "伞骨（孔对孔）", kind: "material",
  material_id: "m-1", material_code: "MAT-1", material_name: "伞骨 50cm 黑",
  has_image: true, image_version: "sha-1", image_source: "material", image_id: null,
  image_url: "/api/v1/materials/m-1/image?v=sha-1", ...extra,
});

const withImage = candidate();
const withoutImage = candidate({ spec_key: "canopy_spec", base_key: "canopy_spec", label: "伞布规格", has_image: false, image_version: null, image_source: null, image_url: "" });
const handleCandidate = candidate({
  spec_key: "handle_spec", base_key: "handle_spec", label: "伞头", material_id: "m-2", material_code: "MAT-2", material_name: "伞头 5cm",
  image_version: "sha-2", image_url: "/api/v1/materials/m-2/image?v=sha-2",
});
const detailCandidate = candidate({
  spec_key: "detail:66666666-6666-6666-6666-666666666666",
  base_key: "detail:66666666-6666-6666-6666-666666666666",
  label: "伞头配色 / Hawái",
  kind: "detail",
  material_id: null,
  material_code: null,
  material_name: null,
  image_version: "sha-detail",
  image_source: "row",
  image_id: "img-1",
  image_url: "/api/v1/sales-orders/o-1/images/img-1?v=sha-detail",
});

/**
 * 同一格（`rib_spec`）的 3 张**行图**（2026-11-05）。
 *
 * 契约：第 1 张 `spec_key = rib_spec`，第 2/3 张 `#2`/`#3`；`label` 第 2/3 张带「（第 n 张）」；
 * 三张各有自己的 `image_url`。行图可以不引用任何物料（material_* 全空）。
 */
function ribSlot(slot) {
  return candidate({
    spec_key: slot === 0 ? "rib_spec" : `rib_spec#${slot + 1}`,
    base_key: "rib_spec",
    image_slot: slot,
    label: slot === 0 ? "伞骨（孔对孔）" : `伞骨（孔对孔）（第 ${slot + 1} 张）`,
    material_id: null,
    material_code: null,
    material_name: null,
    image_source: "row",
    image_id: `img-rib-${slot + 1}`,
    image_version: `sha-r${slot + 1}`,
    image_url: `/api/v1/sales-orders/o-1/images/img-rib-${slot + 1}?v=sha-r${slot + 1}`,
  });
}
const ribImages = [ribSlot(0), ribSlot(1), ribSlot(2)];

/** 假管线：记录取过哪个地址、量到的尺寸与编到的尺寸，返回可辨认的 blob。 */
function deps({ width = 1280, height = 960 } = {}) {
  const seen = { fetch: [], measured: 0, encoded: [] };
  return {
    seen,
    fetchImage: async (item) => { seen.fetch.push(item.image_url); return new Blob([new Uint8Array(10)]); },
    measure: async () => { seen.measured += 1; return { width, height }; },
    encodeJpeg: async (_blob, size) => { seen.encoded.push(size); return new Blob([new Uint8Array(4)], { type: "image/jpeg" }); },
  };
}

/** 临时替换全局 fetch（浏览器取图那一段），结束时一定还原。 */
async function withFetchStub(stub, run) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push([url, init?.credentials]); return stub(url, init); };
  try {
    await run(seen);
  } finally {
    globalThis.fetch = original;
  }
}

test("production-sheet-image：只列有图的候选，默认全勾（同一格第 2/3 张也默认勾上）", () => {
  assert.deepEqual(selectableImages([withImage, withoutImage]).map((item) => item.spec_key), ["rib_spec"]);
  assert.deepEqual(defaultImageSelection([...ribImages, handleCandidate, withoutImage]), ["rib_spec", "rib_spec#2", "rib_spec#3", "handle_spec"], "3 张都要进默认勾选：漏掉 #2/#3 就等于永远导不出第 2/3 张");
  assert.deepEqual(defaultImageSelection([]), []);
});

test("production-sheet-image：候选行的文字带上物料编码与名称；行图没有物料编码时直接用 label；第 n 张不重复拼", () => {
  assert.equal(candidateLabel(withImage), "伞骨（孔对孔） — MAT-1 伞骨 50cm 黑");
  assert.equal(candidateLabel(candidate({ material_code: "", material_name: "" })), "伞骨（孔对孔）", "物料信息为空时不留下一个孤零零的破折号");
  // 明细行 / 其它行自己的图没有物料编码 —— label 已含分组，直接显示。
  assert.equal(candidateLabel(detailCandidate), "伞头配色 / Hawái");
  // 「（第 2 张）」由后端的 label 带：弹窗里只应出现一次（这里再拼一次就会重复）。
  assert.equal(candidateLabel(ribImages[1]), "伞骨（孔对孔）（第 2 张）");
  assert.equal(candidateLabel(ribImages[1]).split("（第 2 张）").length - 1, 1);
});

test("production-sheet-image：等比缩到 640，小图不放大", () => {
  assert.equal(EXPORT_IMAGE_MAX_EDGE, 640);
  assert.deepEqual(exportImageScale(1280, 960), { width: 640, height: 480 });
  assert.deepEqual(exportImageScale(960, 1280), { width: 480, height: 640 });
  assert.deepEqual(exportImageScale(320, 200), { width: 320, height: 200 }, "本来就小的图不放大（放大只会变糊还更大）");
  assert.deepEqual(exportImageScale(0, 0), { width: 640, height: 640 }, "读不出尺寸时给方框，不能给 0（canvas 会抛错）");
});

test("production-sheet-image：同一格 3 张 → multipart 字段名带 #2/#3，每张各用自己的 image_url", async () => {
  const fake = deps();
  const form = await buildProductionSheetForm(ribImages, fake);

  assert.deepEqual(fake.seen.fetch, [
    "/api/v1/sales-orders/o-1/images/img-rib-1?v=sha-r1",
    "/api/v1/sales-orders/o-1/images/img-rib-2?v=sha-r2",
    "/api/v1/sales-orders/o-1/images/img-rib-3?v=sha-r3",
  ], "同一格 3 张各有各的 image_url（不是把第 1 张发 3 遍）");
  assert.equal(fake.seen.encoded.length, 3);
  assert.deepEqual([...form.keys()], ["rib_spec", "rib_spec#2", "rib_spec#3"], "字段名 = 候选 spec_key，带 #2/#3（后端靠它区分第几张）");
  assert.equal((form.get("rib_spec#2")).name, "rib_spec#2.jpg");
  assert.equal((form.get("rib_spec#3")).name, "rib_spec#3.jpg");
  for (const key of ["rib_spec", "rib_spec#2", "rib_spec#3"]) assert.equal((form.get(key)).type, "image/jpeg", "必须是 JPEG —— Excel 不认 WebP");
});

test("production-sheet-image：按候选的 image_url 取图（行图没有物料 id，拼 material_id 的写法会取错）", async () => {
  const fake = deps();
  const form = await buildProductionSheetForm([withImage, detailCandidate], fake);

  assert.deepEqual(fake.seen.fetch, [
    "/api/v1/materials/m-1/image?v=sha-1",
    "/api/v1/sales-orders/o-1/images/img-1?v=sha-detail",
  ], "行图走销售单图片接口、物料图走物料接口 —— 地址全部来自后端给的 image_url");
  assert.deepEqual(fake.seen.encoded, [{ width: 640, height: 480 }, { width: 640, height: 480 }]);
  assert.deepEqual([...form.keys()], ["rib_spec", detailCandidate.spec_key]);
  assert.equal((form.get("rib_spec")).type, "image/jpeg");
  assert.equal((form.get("rib_spec")).name, "rib_spec.jpg");
  assert.equal(form.get(detailCandidate.spec_key) instanceof File, true);
});

test("production-sheet-image：勾两张就只取两张、只发两个文件（不多不少）", async () => {
  const fake = deps();
  const form = await buildProductionSheetForm([withImage, handleCandidate], fake);

  assert.equal(fake.seen.fetch.length, 2);
  assert.equal(fake.seen.measured, 2);
  assert.equal([...form.keys()].length, 2, "勾两张就只发两张");
});

/**
 * 「其它」行是 `extra:<行 id>`（2026-10-08），细分明细行是 `detail:<行 id>`（2026-11-04），
 * 第 2/3 张再追 `#2`/`#3`（2026-11-05）。这一条钉住「字段名对前端是不透明的」：
 * 后端按 fieldname 认「哪一行第几张」，前端**不能**对键做任何形状假设
 * （例如"必须是 `*_spec`"或"不含 `#`"）—— 真做了的话，行图勾了就会静默少发一个文件
 * （后端于是报"这一格没有可导出的图片"）。
 */
test("production-sheet-image：extra: / detail: / #n 键原样作为 multipart 字段名（前端不许改写）", async () => {
  const fake = deps();
  const extraKey = "extra:55555555-5555-5555-5555-555555555555";
  const extraCandidate = candidate({ spec_key: extraKey, base_key: extraKey, label: "弹簧", kind: "extra", material_id: null, material_code: null, material_name: null, image_source: "row", image_id: "img-2", image_url: "/api/v1/sales-orders/o-1/images/img-2?v=sha-extra" });
  const detailSecond = candidate({
    ...detailCandidate,
    spec_key: `${detailCandidate.spec_key}#2`,
    image_slot: 1,
    label: "伞头配色 / Hawái（第 2 张）",
    image_id: "img-1b",
    image_version: "sha-detail-2",
    image_url: "/api/v1/sales-orders/o-1/images/img-1b?v=sha-detail-2",
  });
  const form = await buildProductionSheetForm([extraCandidate, detailCandidate, detailSecond], fake);

  assert.deepEqual([...form.keys()], [extraKey, detailCandidate.spec_key, `${detailCandidate.spec_key}#2`]);
  assert.equal(form.get(extraKey).name, `${extraKey}.jpg`);
  assert.equal(form.get(`${detailCandidate.spec_key}#2`).name, `${detailCandidate.spec_key}#2.jpg`);
  assert.equal([...form.keys()].join("").includes("undefined"), false, "没有物料 id 的行图也不能把键写成 undefined");
});

test("production-sheet-image：一张都没勾时不取任何图（表单是空的，等于普通工艺单）", async () => {
  const fake = deps();
  const form = await buildProductionSheetForm([], fake);
  assert.deepEqual(fake.seen.fetch, []);
  assert.equal([...form.keys()].length, 0);
});

test("production-sheet-image：取图失败时把 HTTP 码说出来，绝不静默少一张图", async () => {
  const fake = { ...deps(), fetchImage: async () => { throw new Error("取图片失败（HTTP 404）：请刷新页面后重试"); } };
  await assert.rejects(() => buildProductionSheetForm([detailCandidate], fake), /HTTP 404/);
});

test("production-sheet-image：浏览器默认实现按候选的 image_url 取图（带 credentials，行图与物料图同一段代码）", async () => {
  await withFetchStub(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/webp" } }), async (seen) => {
    const blob = await browserSheetImageDeps().fetchImage(ribImages[1]);
    assert.equal(blob instanceof Blob, true);
    assert.deepEqual(seen, [["/api/v1/sales-orders/o-1/images/img-rib-2?v=sha-r2", "include"]], "第 2 张也按自己的 image_url 取（自带 /api/v1 与 ?v=sha），并带会话 cookie");
    assert.equal(blob.size, 3);
  });
});

test("production-sheet-image：浏览器取图失败把 HTTP 码说出来；没有 image_url 也不静默发请求", async () => {
  await withFetchStub(async () => new Response(null, { status: 404 }), async () => {
    await assert.rejects(() => browserSheetImageDeps().fetchImage(withImage), /取图片失败（HTTP 404）/);
  });
  const original = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; return new Response(null, { status: 200 }); };
  try {
    await assert.rejects(() => browserSheetImageDeps().fetchImage(candidate({ image_url: "" })), /没有图片地址/);
    assert.equal(called, 0, "没有地址就不该发出请求（契约漂移时给出人话，而不是 fetch(\"undefined\")）");
  } finally {
    globalThis.fetch = original;
  }
});

test("production-sheet-image：路径与文件名", () => {
  assert.equal(exportImagesPath("o-1"), "/sales-orders/o-1/export-images");
  // 导出走 downloadFormPost（裸 fetch），必须自带 /api/v1：少了就是打到 Web 服务的 404
  assert.equal(productionSheetExportPath("o-1"), "/api/v1/sales-orders/o-1/production-sheet.xlsx");
  assert.equal(productionSheetFileName("DL260134"), "迪礼ERP-工艺单-DL260134.xlsx");
});

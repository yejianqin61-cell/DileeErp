// 工艺单「带图片导出」前端逻辑的测试（node:test，与 apps/web/lib/*.test.mjs 同一套）。
//
// 用户 2026-09-24：「导出销售单的时候，每个有图片的物料允许用户勾选是否 excel 中一并导出这个图片」。
//
// 这里**没有 DOM**（画布相关的部分注入成 `SheetImageDeps`），所以测的是纯逻辑：
//   ① 只列**有图**的候选，默认全勾；
//   ② 缩放到最大边 640 且不放大；
//   ③ 装表单时字段名 = 栏位键（后端就是按 fieldname 认栏位的，写错就变成「一张图都没有」）；
//   ④ 导出地址自带 /api/v1（走的是裸 fetch，不像 api-client 会补前缀）；
//   ⑤ 字段名对前端是**不透明字符串**（材料明细「其它」行的键是 `extra:<行 id>`，2026-10-08）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPORT_IMAGE_MAX_EDGE,
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
  spec_key: "rib_spec", label: "伞骨（孔对孔）", material_id: "m-1", material_code: "MAT-1", material_name: "伞骨 50cm 黑",
  has_image: true, image_version: "sha-1", ...extra,
});

const withImage = candidate();
const withoutImage = candidate({ spec_key: "canopy_spec", label: "伞布规格", has_image: false, image_version: null });

/** 假管线：记录量到的尺寸与编到的尺寸，返回可辨认的 blob。 */
function deps({ width = 1280, height = 960 } = {}) {
  const seen = { fetch: [], measured: 0, encoded: [] };
  return {
    seen,
    fetchImage: async (materialId, version) => { seen.fetch.push([materialId, version]); return new Blob([new Uint8Array(10)]); },
    measure: async () => { seen.measured += 1; return { width, height }; },
    encodeJpeg: async (_blob, size) => { seen.encoded.push(size); return new Blob([new Uint8Array(4)], { type: "image/jpeg" }); },
  };
}

test("production-sheet-image：只列有图的候选，默认全勾（没有图的项列出来只会让人以为「勾了就有图」）", () => {
  assert.deepEqual(selectableImages([withImage, withoutImage]).map((item) => item.spec_key), ["rib_spec"]);
  assert.deepEqual(defaultImageSelection([withImage, withoutImage]), ["rib_spec"]);
  assert.deepEqual(defaultImageSelection([]), []);
});

test("production-sheet-image：候选行的文字带上物料编码与名称（勾选时才知道是哪张图）", () => {
  assert.equal(candidateLabel(withImage), "伞骨（孔对孔） — MAT-1 伞骨 50cm 黑");
  assert.equal(candidateLabel(candidate({ material_code: "", material_name: "" })), "伞骨（孔对孔）", "物料信息为空时不留下一个孤零零的破折号");
});

test("production-sheet-image：等比缩到 640，小图不放大", () => {
  assert.equal(EXPORT_IMAGE_MAX_EDGE, 640);
  assert.deepEqual(exportImageScale(1280, 960), { width: 640, height: 480 });
  assert.deepEqual(exportImageScale(960, 1280), { width: 480, height: 640 });
  assert.deepEqual(exportImageScale(320, 200), { width: 320, height: 200 }, "本来就小的图不放大（放大只会变糊还更大）");
  assert.deepEqual(exportImageScale(0, 0), { width: 640, height: 640 }, "读不出尺寸时给方框，不能给 0（canvas 会抛错）");
});

test("production-sheet-image：装表单时字段名 = 栏位键（后端按 fieldname 认栏位，写错就一张图都没有）", async () => {
  const fake = deps();
  const form = await buildProductionSheetForm([withImage, candidate({ spec_key: "handle_spec", material_id: "m-2" })], fake);

  assert.deepEqual(fake.seen.fetch, [["m-1", "sha-1"], ["m-2", "sha-1"]], "取图带版本号（浏览器才不会拿旧图）");
  assert.deepEqual(fake.seen.encoded, [{ width: 640, height: 480 }, { width: 640, height: 480 }]);
  assert.equal(form.get("rib_spec") instanceof File, true);
  assert.equal(form.get("handle_spec") instanceof File, true);
  assert.equal((form.get("rib_spec")).type, "image/jpeg", "必须是 JPEG —— Excel 不认 WebP");
  assert.equal((form.get("rib_spec")).name, "rib_spec.jpg");
  assert.equal([...form.keys()].length, 2, "勾两张就只发两张");
});

/**
 * 「其它」行的候选键是 `extra:<行 id>`（2026-10-08）。这一条钉住「字段名对前端是不透明的」：
 * 后端按 fieldname 认栏位，前端**不能**对键做任何形状假设（例如"必须是 `*_spec`"）——
 * 真做了的话，「其它」行勾了图就会静默少发一个文件（后端于是报"这一格没有可导出的图片"）。
 */
test("production-sheet-image：键名是后端给的原样字符串（「其它」行是 extra:<行 id>，前端不许改写）", async () => {
  const fake = deps();
  const extraKey = "extra:55555555-5555-5555-5555-555555555555";
  const form = await buildProductionSheetForm([candidate({ spec_key: extraKey, label: "弹簧" })], fake);
  assert.equal(form.get(extraKey) instanceof File, true);
  assert.equal(form.get(extraKey).name, `${extraKey}.jpg`);
  assert.deepEqual([...form.keys()], [extraKey]);
});

test("production-sheet-image：一张都没勾时不取任何图（表单是空的，等于普通工艺单）", async () => {
  const fake = deps();
  const form = await buildProductionSheetForm([], fake);
  assert.deepEqual(fake.seen.fetch, []);
  assert.equal([...form.keys()].length, 0);
});

test("production-sheet-image：取图失败时把 HTTP 码说出来，绝不静默少一张图", async () => {
  const fake = { ...deps(), fetchImage: async () => { throw new Error("取物料图片失败（HTTP 404）：请刷新页面后重试"); } };
  await assert.rejects(() => buildProductionSheetForm([withImage], fake), /HTTP 404/);
});

test("production-sheet-image：路径与文件名", () => {
  assert.equal(exportImagesPath("o-1"), "/sales-orders/o-1/export-images");
  // 导出走 downloadFormPost（裸 fetch），必须自带 /api/v1：少了就是打到 Web 服务的 404
  assert.equal(productionSheetExportPath("o-1"), "/api/v1/sales-orders/o-1/production-sheet.xlsx");
  assert.equal(productionSheetFileName("DL260134"), "迪礼ERP-工艺单-DL260134.xlsx");
});

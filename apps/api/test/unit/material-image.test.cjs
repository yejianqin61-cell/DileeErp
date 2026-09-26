// 物料图片校验的单元测试（用户 2026-09-24：「图片上传之后要压缩成 webp 再存进数据库里」）。
//
// 这个模块是**唯一**能挡住「伪装成 webp 的别的东西」的地方：用户选的是「浏览器压缩、服务端只校验」
// 那条路（另一条是引 sharp 那种原生依赖），所以客户端的 Content-Type 与扩展名都不可信，
// 服务端必须真的把 RIFF 容器解开、从块头里读出**真实像素尺寸**。
//
// 断言分三层：
//   1. **真实编码器产出的字节**（下面三个 base64 是 sharp 生成的 37×23 图，三种容器各一份）——
//      只用手搓的字节测会有一个致命盲区：解析器「只认自己造的那种格式」也能全绿；
//   2. 合成字节覆盖边界（超尺寸 / 声明长度不符 / 关键位不对）；
//   3. 大小上限**先于**解析：50MB 的假图不该被读进内存再判「不是 WebP」。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  MAX_MATERIAL_IMAGE_BYTES,
  MAX_MATERIAL_IMAGE_EDGE,
  inspectWebp,
  validateMaterialImage,
} = require("../../dist/modules/procurement/material-image.js");

/**
 * 真实编码器（sharp，仅用于**生成**这三个夹具）产出的 37×23 纯色图。
 * 三种容器各一份，覆盖 WebP 的全部三种块头：有损 VP8 / 无损 VP8L / 扩展 VP8X。
 */
const REAL_WEBP = {
  vp8: "UklGRkAAAABXRUJQVlA4IDQAAAAwAwCdASolABcAPu12tFOppyUipWgBMB2JZwDKAA9i7tmAAJhpf9Cvkz7rj3DmFoGahQAA",
  vp8l: "UklGRh4AAABXRUJQVlA4TBEAAAAvJIAFAAdQ1c70rv+BiOh/AAA=",
  vp8x: "UklGRlgAAABXRUJQVlA4WAoAAAAQAAAAJAAAFgAAQUxQSAoAAAABB1DAiAhERP8DVlA4ICgAAADwAgCdASolABcAPu12tFQppyUjJWgBMB2JaQAAKUNt8AD+8QiAAAAA",
};
const realWebp = (name) => Buffer.from(REAL_WEBP[name], "base64");

/** 手搓一个只有块头的 WebP（校验器只读头，不做像素解码，所以不需要真像素）。 */
function webpWithChunk(fourcc, payload) {
  const chunk = Buffer.alloc(8 + payload.length + (payload.length % 2));
  chunk.write(fourcc, 0, 4, "ascii");
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(4 + chunk.length, 4);
  header.write("WEBP", 8, 4, "ascii");
  return Buffer.concat([header, chunk]);
}

/** 广 24 位小端（VP8X 的画布尺寸就是这种写法）。 */
function u24le(value) {
  return Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]);
}

const vp8xChunk = (width, height) => webpWithChunk("VP8X", Buffer.concat([Buffer.from([0, 0, 0, 0]), u24le(width - 1), u24le(height - 1)]));
const vp8Chunk = (width, height, startCode = [0x9d, 0x01, 0x2a]) => {
  const payload = Buffer.alloc(10);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  Buffer.from(startCode).copy(payload, 3);
  return webpWithChunk("VP8 ", payload);
};

test("inspectWebp：真实编码器的三种容器都解得对（只认自己手搓的字节是最危险的假绿）", () => {
  assert.deepEqual(inspectWebp(realWebp("vp8")), { ok: true, width: 37, height: 23, format: "vp8" });
  assert.deepEqual(inspectWebp(realWebp("vp8l")), { ok: true, width: 37, height: 23, format: "vp8l" });
  assert.deepEqual(inspectWebp(realWebp("vp8x")), { ok: true, width: 37, height: 23, format: "vp8x" });
  // 三种容器的文件长度差别很大（72 / 38 / 96 字节），尺寸却必须一致 —— 说明读的确实是尺寸字段。
  assert.equal(realWebp("vp8").length, 72);
  assert.equal(realWebp("vp8l").length, 38);
  assert.equal(realWebp("vp8x").length, 96);
});

test("inspectWebp：不是 WebP 的一律报 NOT_WEBP（PNG / JPEG / 纯文本 / 空）", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
  for (const [name, bytes] of [["PNG", png], ["JPEG", jpeg], ["纯文本", Buffer.from("这不是图片，只是一段中文文本，用来凑够三十个字节。")], ["空", Buffer.alloc(0)]]) {
    const info = inspectWebp(bytes);
    assert.equal(info.ok, false, `${name} 必须被拒`);
    assert.equal(info.code, "MATERIAL_IMAGE_NOT_WEBP", `${name} 的错误码`);
  }
  // 头部像 RIFF 但表单类型不是 WEBP（例如 .wav）：同样要拒，不能只看前四个字节。
  const notWebpForm = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(20)]);
  assert.equal(inspectWebp(notWebpForm).ok, false);
});

test("inspectWebp：头部声明的长度与实际字节数不符 → TRUNCATED（不存半张图）", () => {
  const real = realWebp("vp8");
  const truncated = real.subarray(0, real.length - 8);
  const info = inspectWebp(truncated);
  assert.equal(info.ok, false);
  assert.equal(info.code, "MATERIAL_IMAGE_TRUNCATED");
  assert.match(info.message, /头部声明 72 字节，实际收到 64 字节/);

  // 反过来：在真图后面接一段垃圾（声明长度不变）也要拒 —— 「声明多少就必须是多少」。
  const padded = Buffer.concat([real, Buffer.alloc(8)]);
  assert.equal(inspectWebp(padded).code, "MATERIAL_IMAGE_TRUNCATED");
});

test("inspectWebp：VP8 的起始码不对就报「尺寸读不出来」（容器是 WebP，但块头坏了，不能瞎猜尺寸）", () => {
  assert.equal(inspectWebp(vp8Chunk(100, 50)).ok, true);
  const bad = vp8Chunk(100, 50, [0x00, 0x00, 0x00]);
  const info = inspectWebp(bad);
  assert.equal(info.ok, false, "起始码不是 9D 01 2A 的块不能按 VP8 去读宽高");
  // 报的是 DIMENSION_INVALID 而不是 NOT_WEBP：容器头确实写着 RIFF/WEBP，
  // 该说的是「这个 WebP 坏了」而不是「这不是 WebP」—— 两者的处理动作不同（重压 vs 换格式）。
  assert.equal(info.code, "MATERIAL_IMAGE_DIMENSION_INVALID");
});

test("inspectWebp：尺寸为 0 的块报 DIMENSION_INVALID（不能进库一个 0×0 的图）", () => {
  const info = inspectWebp(vp8Chunk(0, 0));
  assert.equal(info.ok, false);
  assert.equal(info.code, "MATERIAL_IMAGE_DIMENSION_INVALID");
});

test("inspectWebp：超过边长上限直接拒（压缩炸弹的体积很小，只看字节数是拦不住的）", () => {
  assert.equal(MAX_MATERIAL_IMAGE_EDGE, 2000);
  const info = inspectWebp(vp8xChunk(20000, 20000));
  assert.equal(info.ok, false);
  assert.equal(info.code, "MATERIAL_IMAGE_DIMENSION_TOO_LARGE");
  assert.match(info.message, /20000×20000 超过上限 2000×2000/);
  // 正好等于上限要放行（边界不能写成「小于」）。
  assert.equal(inspectWebp(vp8xChunk(2000, 2000)).ok, true);
  assert.equal(inspectWebp(vp8xChunk(2001, 2000)).ok, false);
});

test("validateMaterialImage：没有文件 / 超大小上限，各有自己的错误码（且不会去解容器）", () => {
  assert.equal(validateMaterialImage(undefined).code, "MATERIAL_IMAGE_FILE_REQUIRED");
  assert.equal(validateMaterialImage(Buffer.alloc(0)).code, "MATERIAL_IMAGE_FILE_REQUIRED");
  assert.equal(MAX_MATERIAL_IMAGE_BYTES, 2 * 1024 * 1024);

  // 超限的字节流：内容根本不是 WebP，但报的必须是「太大」—— 大小检查在解析**之前**，
  // 这样 50MB 的攻击性请求不会被读进内存再判「不是 WebP」。
  const huge = Buffer.alloc(MAX_MATERIAL_IMAGE_BYTES + 1, 0x41);
  const info = validateMaterialImage(huge);
  assert.equal(info.ok, false);
  assert.equal(info.code, "MATERIAL_IMAGE_TOO_LARGE");
  assert.match(info.message, /超过 2MB 上限/);
  // 正好等于上限的**真 WebP** 要放行。
  assert.equal(validateMaterialImage(realWebp("vp8")).ok, true, "正常大小必须放行");
});

test("validateMaterialImage：正常图片解出宽高（上传回执与列表都要用它们）", () => {
  const info = validateMaterialImage(realWebp("vp8x"));
  assert.equal(info.ok, true);
  assert.deepEqual([info.width, info.height, info.format], [37, 23, "vp8x"]);
  const lossy = validateMaterialImage(realWebp("vp8"));
  assert.deepEqual([lossy.width, lossy.height, lossy.format], [37, 23, "vp8"]);
});

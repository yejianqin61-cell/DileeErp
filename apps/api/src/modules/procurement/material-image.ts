/**
 * 物料图片的**纯校验**（无 Nest / Prisma 依赖，可单测）。
 *
 * ## 为什么服务端要自己解 WebP
 *
 * 用户 2026-09-24 的原话是「图片上传之后要压缩成 webp 再存进数据库里」，并且在两个方案里选了
 * **浏览器压缩、服务端只校验**那条（另一条是引 sharp 那种原生依赖）。这个选择意味着：
 * 服务端拿到的字节**完全由客户端说了算** —— `Content-Type` 可以是谎话，扩展名也可以是谎话。
 * 所以这里做的是「真的把 WebP 容器解开看一眼」：
 *
 *   1. `RIFF....WEBP` 容器头（并核对 RIFF 里声明的长度与实际字节数一致）；
 *   2. 从 `VP8 `（有损）/ `VP8L`（无损）/ `VP8X`（扩展）三种块头里读出**真实像素尺寸**；
 *   3. 尺寸与字节数都在上限内。
 *
 * 做这三件事的直接收益是：库里不会出现「伪装成 .webp 的 8MB PNG」（前端 `<img>` 打不开、
 * 导出 Excel 时解不出来），也不会出现「一张 20000×20000 的解压炸弹」（它的压缩后体积很小，
 * 只看字节数是拦不住的）。
 *
 * ## 为什么不重新编码
 *
 * 重新编码才能真正保证「存进去的一定是我们压的 WebP」，但那需要解码器 —— 就是用户明确不要的
 * 那个原生依赖。这里的取舍是**校验 + 限制**：字节数 ≤ 2MB、任一边长 ≤ 2000，
 * 比「静默接受任何字节」安全得多，而且没有任何新增依赖。
 */

/** 压缩后的字节上限（2MB）。浏览器端按 quality 0.82、最长边 1600 压出来的图通常在 200–500KB。 */
export const MAX_MATERIAL_IMAGE_BYTES = 2 * 1024 * 1024;
/** 任一边长的上限。超过这个尺寸的图片在页面上只是缩略图，存原图没有意义。 */
export const MAX_MATERIAL_IMAGE_EDGE = 2000;

export type WebpInfo =
  | { ok: true; width: number; height: number; format: "vp8" | "vp8l" | "vp8x" }
  | { ok: false; code: string; message: string };

const NOT_WEBP = { ok: false as const, code: "MATERIAL_IMAGE_NOT_WEBP", message: "只支持 WebP 图片（浏览器上传前会自动把 JPG/PNG 压成 WebP）：这个文件的内容不是 WebP" };

/**
 * 解开 WebP 容器，读出真实尺寸。
 *
 * ⚠️ 只读**块头**，不做像素解码：解码要引入解码器，而这里要的只是「是不是一个尺寸合理的
 * 真 WebP」。所以一个声明了 VP8X 头但后面跟着垃圾的字节串仍然会被接受 —— 那种文件打不开，
 * 但它是**上传者自己**的问题（页面上立刻就能看出来），不会污染任何财务数据。
 */
export function inspectWebp(buffer: Buffer | Uint8Array | null | undefined): WebpInfo {
  const bytes = buffer ? Buffer.from(buffer) : Buffer.alloc(0);
  if (bytes.length < 30) return NOT_WEBP;
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return NOT_WEBP;
  // RIFF 头里声明的长度是「RIFF 之后的所有字节」= 文件长度 - 8。不一致说明文件被截断或拼接，
  // 一律拒掉（库里存半张图比存一张坏图更难查）。
  const declared = bytes.readUInt32LE(4);
  if (declared !== bytes.length - 8) {
    return { ok: false, code: "MATERIAL_IMAGE_TRUNCATED", message: `WebP 文件不完整：头部声明 ${declared + 8} 字节，实际收到 ${bytes.length} 字节` };
  }
  return readChunks(bytes);
}

/** 遍历块的四个字节标识，找到第一个能给出尺寸的 `VP8 ` / `VP8L` / `VP8X`。 */
function readChunks(bytes: Buffer): WebpInfo {
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (size > bytes.length - data) {
      return { ok: false, code: "MATERIAL_IMAGE_TRUNCATED", message: `WebP 的 ${fourcc.trim()} 块声明了 ${size} 字节，实际只有 ${bytes.length - data} 字节` };
    }
    if (fourcc === "VP8X") return bounded(vp8xSize(bytes, data), "vp8x");
    if (fourcc === "VP8 ") return bounded(vp8Size(bytes, data), "vp8");
    if (fourcc === "VP8L") return bounded(vp8lSize(bytes, data), "vp8l");
    // 块数据按偶数长度对齐（RIFF 规范），跳过 1 个填充字节。
    offset = data + size + (size % 2);
  }
  return NOT_WEBP;
}

/** 尺寸是否在上限内（三种块头共用的最后一道闸）。 */
function bounded(size: { width: number; height: number } | null, format: "vp8" | "vp8l" | "vp8x"): WebpInfo {
  if (!size || size.width < 1 || size.height < 1) {
    return { ok: false, code: "MATERIAL_IMAGE_DIMENSION_INVALID", message: "WebP 里的图片尺寸读不出来（可能是损坏的文件）" };
  }
  if (size.width > MAX_MATERIAL_IMAGE_EDGE || size.height > MAX_MATERIAL_IMAGE_EDGE) {
    return {
      ok: false,
      code: "MATERIAL_IMAGE_DIMENSION_TOO_LARGE",
      message: `图片尺寸 ${size.width}×${size.height} 超过上限 ${MAX_MATERIAL_IMAGE_EDGE}×${MAX_MATERIAL_IMAGE_EDGE}：请在浏览器里重新压缩后再上传`,
    };
  }
  return { ok: true, width: size.width, height: size.height, format };
}

/** `VP8X`：1 字节标志 + 3 字节保留 + 3 字节「画布宽 − 1」+ 3 字节「画布高 − 1」（小端 24 位）。 */
function vp8xSize(bytes: Buffer, data: number): { width: number; height: number } | null {
  if (data + 10 > bytes.length) return null;
  return { width: readUInt24LE(bytes, data + 4) + 1, height: readUInt24LE(bytes, data + 7) + 1 };
}

/** `VP8 `（有损）：3 字节帧标签 + 3 字节起始码 `9D 01 2A` + 2 字节宽 + 2 字节高（各 14 位有效）。 */
function vp8Size(bytes: Buffer, data: number): { width: number; height: number } | null {
  if (data + 10 > bytes.length) return null;
  if (bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) return null;
  return { width: bytes.readUInt16LE(data + 6) & 0x3fff, height: bytes.readUInt16LE(data + 8) & 0x3fff };
}

/** `VP8L`（无损）：1 字节签名 `2F` + 14 位「宽 − 1」+ 14 位「高 − 1」（小端位打包）。 */
function vp8lSize(bytes: Buffer, data: number): { width: number; height: number } | null {
  if (data + 5 > bytes.length) return null;
  if (bytes[data] !== 0x2f) return null;
  // 把接下来 4 个字节当成一个 32 位小端整数：低 14 位是宽−1，接着 14 位是高−1。
  const bits = bytes.readUInt32LE(data + 1);
  return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

/**
 * 文件级校验（大小 + 容器）：服务层只调这一个。
 *
 * 大小检查放在解容器**之前**：一个 50MB 的假 WebP 不该被读进内存再判「不是 WebP」。
 */
export function validateMaterialImage(buffer: Buffer | Uint8Array | null | undefined): WebpInfo {
  const bytes = buffer ? Buffer.from(buffer) : Buffer.alloc(0);
  if (!bytes.length) return { ok: false, code: "MATERIAL_IMAGE_FILE_REQUIRED", message: "请选择要上传的图片" };
  if (bytes.length > MAX_MATERIAL_IMAGE_BYTES) {
    return {
      ok: false,
      code: "MATERIAL_IMAGE_TOO_LARGE",
      message: `图片压缩后仍有 ${(bytes.length / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_MATERIAL_IMAGE_BYTES / 1024 / 1024}MB 上限：请换一张更小的图，或在浏览器里重新压缩`,
    };
  }
  return inspectWebp(bytes);
}

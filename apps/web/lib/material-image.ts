// 物料图片的前端逻辑（**不能**放进 "use client" 文件）。
//
// 用户 2026-09-24：「物料清单，要给物料配上图片。图片上传之后要压缩成 webp 再存进数据库里。
// 所以要允许用户对对应的物料进行图片的上传」。
//
// ## 为什么压缩在前端做
//
// 用户在两个方案里选了「**浏览器** canvas 转 WebP 后上传，服务端只校验」，另一条是引 sharp
// （原生依赖，部署时要在服务器上拿到平台二进制）。所以这一侧要负责：读原图 → 按最长边缩放 →
// canvas 编码成 WebP → 上传；服务端负责：解开 RIFF 容器核对「真的是 WebP」+ 尺寸/大小上限。
// 两边**都要**有闸门：只有前端拦，伪造请求就能塞进来一个 8MB 的 PNG；只有后端拦，
// 用户会白等一次几 MB 的上传再被告知「不行」。
//
// ## 为什么要注入 `ImagePipeline`
//
// 缩放/编码这段只有在浏览器里才跑得起来（`createImageBitmap` + `<canvas>`），而本仓库的
// `lib/*.test.mjs` 是**没有 DOM 的 node:test**。所以这里把「解码尺寸」与「编码 WebP」抽成
// 可替换的两个函数：默认实现用浏览器 API，测试传假实现来验证**这套纯逻辑**
// （尺寸怎么缩、错误怎么分流、什么时候根本不发请求）。这样测的不是「canvas 能不能用」，
// 而是「我们要它做什么」—— 后者才是会写错的部分。

/**
 * 物料图片的失败（与 `ApiClientError` 同形状：`code` + `message`）。
 *
 * 为什么不直接用 `ApiClientError`：本模块要能被 `lib/*.test.mjs`（没有打包器的 **node:test**）
 * 直接 import，而那条链路解析不了**扩展名省略**的相对导入（`from "./api-client"` 在 Node 的
 * ESM 里找不到文件）。写一份同形状的类，比为了一个错误类型把整条测试链路弄断划算。
 * 用到 `code` 的地方（判断是哪一类失败）在这里同样拿得到。
 */
export class MaterialImageError extends Error {
  // 与 api-client 同样的理由：不用构造函数参数属性 —— 那种写法无法被 Node 的 strip-only 类型擦除解析。
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 与后端 `MAX_MATERIAL_IMAGE_BYTES` **必须一致**（两边各有一份，改一处就要改另一处）。 */
export const MATERIAL_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** 上传前把最长边缩到这个尺寸。再大对页面上的一张小图没有意义，只是白占数据库。 */
export const MATERIAL_IMAGE_MAX_EDGE = 1600;
/** WebP 编码质量。0.82 是「看得出是照片、体积又只有原图一两成」的常用档。 */
export const MATERIAL_IMAGE_QUALITY = 0.82;
/** `<input type="file">` 的 accept：浏览器据此过滤文件选择框（服务端仍会按内容再校验一次）。 */
export const MATERIAL_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/*";

/** 物料图片的接口路径（`apiGet`/`apiPost` 会自己补 `/api/v1`，所以这里不带前缀）。 */
export function materialImagePath(materialId: string): string {
  return `/materials/${materialId}/image`;
}

/**
 * `<img src>` 用的地址。
 *
 * 必须自带 `/api/v1` 前缀：`<img>` 是浏览器直接发的请求，不走 `api-client`（与所有导出下载同一条
 * 理由）。`version` 拼成查询串用来破缓存 —— 换图之后 `sha256` 变了，地址跟着变，浏览器就不会
 * 继续显示旧图（后端同时还给 `ETag`，两者一起保证「换了就一定看得到新图」）。
 */
export function materialImageUrl(materialId: string, version?: string | number | null): string {
  const base = `/api/v1${materialImagePath(materialId)}`;
  return version === undefined || version === null || version === "" ? base : `${base}?v=${encodeURIComponent(String(version))}`;
}

// ---------------------------------------------------------------- 销售单行图片（2026-11-04「每种一张图」）
//
// 与物料图**同一套字节口径**（浏览器压 WebP、服务端解 RIFF 容器核对、2MB/边长上限），只是归属不同：
// 图片按销售单隔离（`sales_order_images.sales_order_id`），行/格只存 `image_id` 指针。
// 所以这里复用压缩管线，只换请求路径与错误码默认值 —— 各写一套压缩逻辑迟早分叉成
// 「物料图能传、行图传不上去」这种查不出来的错。

/** 销售单图片的接口路径（`apiGet`/`apiPost` 会自己补 `/api/v1`，所以这里不带前缀）。 */
export function salesOrderImagePath(orderId: string, imageId?: string | null): string {
  const base = `/sales-orders/${orderId}/images`;
  const id = (imageId ?? "").trim();
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

/**
 * 销售单行图片的 `<img src>` 地址。
 *
 * 与 `materialImageUrl` 同一条理由：`<img>` 是浏览器直接发的请求，不走 `api-client`，所以必须自带
 * `/api/v1` 前缀；`version` 用 `sha256` 破缓存（换图之后 sha 变了，地址跟着变，浏览器不会再显示旧图）。
 */
export function salesOrderImageUrl(orderId: string, imageId: string, version?: string | number | null): string {
  const base = `/api/v1${salesOrderImagePath(orderId, imageId)}`;
  return version === undefined || version === null || version === "" ? base : `${base}?v=${encodeURIComponent(String(version))}`;
}

/**
 * 压成 WebP 再上传一张**销售单行图片**。
 *
 * 返回形状与 `uploadMaterialImage` 相同（`MaterialImageSummary`）：后端两张表都只回落元数据。
 * 错误码沿用同族的 `SALES_ORDER_IMAGE_*`，但真正的失败原因（不是 WebP / 太大 / 压缩失败）来自
 * `compressImageToWebp`，与物料图一致 —— 界面原样显示即可。
 */
export async function uploadSalesOrderImage(orderId: string, file: File, pipeline: ImagePipeline = browserImagePipeline()): Promise<MaterialImageSummary> {
  const compressed = await compressImageToWebp(file, pipeline);
  const form = new FormData();
  form.append("file", compressed.blob, webpFileName(file.name));
  const response = await fetch(`/api/v1${salesOrderImagePath(orderId)}`, { method: "POST", credentials: "include", body: form });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error) {
    throw new MaterialImageError(body?.error?.code ?? "SALES_ORDER_IMAGE_UPLOAD_FAILED", body?.error?.message ?? "图片上传失败");
  }
  return body.data as MaterialImageSummary;
}

/** 等比缩放到最长边不超过 `max`（图片本来就更小就原样返回，**不放大**）。 */
export function fitWithin(width: number, height: number, max = MATERIAL_IMAGE_MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0) return { width: 1, height: 1 };
  if (longest <= max) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * 选中的文件在**发请求之前**能不能用。返回原因（人话）或 null。
 *
 * 为什么先拦一道而不是「传上去让后端说」：后端要到收到几 MB 之后才能说话，
 * 而「你选的是一份 PDF」这件事在浏览器里立刻就知道。用户等 10 秒换来一句
 * 「不是 WebP」是完全可以避免的。
 */
export function materialImageProblem(file: { type?: string; size?: number; name?: string } | null | undefined): string | null {
  if (!file) return "请选择要上传的图片";
  const name = (file.name ?? "").toLowerCase();
  const looksLikeImage = (file.type ?? "").startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/.test(name);
  if (!looksLikeImage) return "只能上传图片（PNG / JPG / WebP）：这个文件看起来不是图片";
  // 原始文件上限给到 20MB：压缩是在**浏览器里**做的，所以原图可以比入库上限大得多
  // （一张 4000×3000 的手机照压缩后通常 200–500KB）。真正入库的上限由后端的 2MB 判定。
  if ((file.size ?? 0) > 20 * 1024 * 1024) return "原图超过 20MB：请先压缩或换一张更小的图片";
  return null;
}

/** 压缩后的文件名：`伞布 花色.png` → `伞布 花色.webp`（后端只认内容，名字是给人看的）。 */
export function webpFileName(originalName: string): string {
  const base = (originalName ?? "").replace(/\.[^.\\/]*$/, "").trim();
  return `${base || "material"}.webp`;
}

/** 解码 + 编码两件事的抽象，见文件头「为什么要注入 ImagePipeline」。 */
export type ImagePipeline = {
  /** 读原图尺寸。 */
  measure: (file: File) => Promise<{ width: number; height: number }>;
  /** 把原图按目标尺寸画进画布并编码成 WebP。 */
  encodeWebp: (file: File, size: { width: number; height: number }) => Promise<Blob>;
};

/** 压缩结果：字节 + 入库时的真实宽高（后端还会再解一次容器核对，两边不该有分歧）。 */
export type CompressedImage = { blob: Blob; width: number; height: number };

/**
 * 把选中的图片压成 WebP。
 *
 * 四条错误分流都是**给用户看的话**，不是内部错误码：
 *   - 不是图片 → 直接说「只能上传图片」；
 *   - 拿不到 2D 画布（老浏览器 / 无头环境）→ 说清「换 Chrome / Edge」；
 *   - 编码结果不是 WebP（Safari 老版本会偷偷回退成 PNG）→ 同样说清换浏览器，
 *     **不能**把 PNG 传上去让后端拒掉（那样用户看到的是「不是 WebP」，而真正的原因是他的浏览器）；
 *   - 压完仍然超过入库上限 → 让他换图，而不是传上去等后端 422。
 */
export async function compressImageToWebp(file: File, pipeline: ImagePipeline = browserImagePipeline()): Promise<CompressedImage> {
  const problem = materialImageProblem(file);
  if (problem) throw new Error(problem);
  const original = await pipeline.measure(file);
  const size = fitWithin(original.width, original.height);
  const blob = await pipeline.encodeWebp(file, size);
  if (blob.type !== "image/webp") throw new Error("这个浏览器不支持把图片压成 WebP：请换 Chrome 或 Edge 再试（旧版 Safari 不支持）");
  if (blob.size > MATERIAL_IMAGE_MAX_BYTES) {
    throw new Error(`压缩后仍有 ${(blob.size / 1024 / 1024).toFixed(1)}MB，超过 ${MATERIAL_IMAGE_MAX_BYTES / 1024 / 1024}MB 上限：请换一张更小的图片`);
  }
  return { blob, ...size };
}

/** 默认实现：`createImageBitmap` 解码、`<canvas>` 编码（两者都只在浏览器里存在，所以是**惰性**构造的）。 */
export function browserImagePipeline(): ImagePipeline {
  const canvasOf = (width: number, height: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };
  return {
    measure: async (file) => {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      // 画完就释放：一张 4000×3000 的位图占几十 MB，留着等 GC 在低配机器上会卡。
      bitmap.close?.();
      return size;
    },
    encodeWebp: async (file, size) => {
      const bitmap = await createImageBitmap(file);
      try {
        const canvas = canvasOf(size.width, size.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("这个浏览器不支持图片压缩（拿不到画布）：请换 Chrome 或 Edge 再试");
        // 先铺白底：带透明通道的 PNG 直接编码成 WebP 在某些浏览器上会得到黑底。
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, size.width, size.height);
        context.drawImage(bitmap, 0, 0, size.width, size.height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", MATERIAL_IMAGE_QUALITY));
        if (!blob) throw new Error("图片压缩失败：请换一张图片再试");
        return blob;
      } finally {
        bitmap.close?.();
      }
    },
  };
}

/** 上传回执：后端只回元数据（**不含字节**）。 */
export type MaterialImageSummary = { id: string; width: number; height: number; byteSize: number; sha256: string; updatedAt: string };

/**
 * 压成 WebP 再上传。
 *
 * 走**裸 fetch + FormData**而不是 `apiPost`：后者会把 body JSON 化（与物料批量导入同一条理由）。
 * 文件名带上 `.webp` 后缀：后端 multer 的白名单按扩展名放行（内容另有一道校验）。
 */
export async function uploadMaterialImage(materialId: string, file: File, pipeline: ImagePipeline = browserImagePipeline()): Promise<MaterialImageSummary> {
  const compressed = await compressImageToWebp(file, pipeline);
  const form = new FormData();
  form.append("file", compressed.blob, webpFileName(file.name));
  const response = await fetch(`/api/v1${materialImagePath(materialId)}`, { method: "POST", credentials: "include", body: form });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error) {
    throw new MaterialImageError(body?.error?.code ?? "MATERIAL_IMAGE_UPLOAD_FAILED", body?.error?.message ?? "图片上传失败");
  }
  return body.data as MaterialImageSummary;
}

/** 删除物料图片（后端硬删这一行并记审计）。 */
export async function deleteMaterialImage(materialId: string): Promise<void> {
  const response = await fetch(`/api/v1${materialImagePath(materialId)}`, { method: "DELETE", credentials: "include" });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error) {
    throw new MaterialImageError(body?.error?.code ?? "MATERIAL_IMAGE_DELETE_FAILED", body?.error?.message ?? "删除图片失败");
  }
}

// 工艺单「带图片导出」的前端逻辑（**不能**放进 "use client" 文件）。
//
// 用户 2026-09-24：「导出销售单的时候，每个有图片的物料允许用户勾选是否 excel 中一并导出这个图片。
// excel 中图片我们就单独排成一排放在底下的一个图片区。然后让用户自行拖拽就好了」。
//
// ## 为什么图片要在浏览器里转成 JPEG
//
// 库里存的是 **WebP**（用户要求「压缩成 webp 再存进数据库」），而 ExcelJS 写进 xlsx 的图片
// Excel 只认 png/jpeg/gif —— WebP media part 在 Excel 里是一个红叉。服务端要转就得有解码器，
// 而用户明确选了「不引 sharp 那种原生依赖」那条路。浏览器天生能解 WebP（这图就是它自己压的），
// 所以转换放在这里：取图 → 量尺寸 → 画到画布 → `toBlob("image/jpeg")` → 作为 multipart 文件上传。
//
// ## 为什么上传是 multipart、字段名就是栏位键
//
// 图片字节走 JSON 会撞上后端 Express 默认 100KB 的 body 上限。multipart 本来就是为字节准备的：
// **一个勾选的栏位 = 一个文件，字段名 = `spec_key`**（后端 `AnyFilesInterceptor` 把 fieldname
// 原样取出来当栏位键），于是不必再发明「第几个文件对应哪一格」这种会错位的约定。
//
// ## 为什么这里没有 `import` 别的模块
//
// `lib/*.test.mjs` 是**没有打包器的 node:test**，它解析不了本仓库惯用的「省略扩展名」相对导入。
// 所以模块内部的逻辑（勾选、缩放、装表单）保持自足，取数那一步（`apiGet`）留在组件里做。
//
// 与物料图片那一侧同样，画布相关的部分注入成 `SheetImageDeps`：注入之后测的是
// 「我们要它做什么」（勾了什么发什么、缩到多大、失败怎么办），而不是「canvas 能不能用」。

/** 导出进 Excel 的那张图的**最大边**。工艺单上图片是参考用的，640px 打出来已经够看清零件。 */
export const EXPORT_IMAGE_MAX_EDGE = 640;
/** JPEG 质量：0.85 在「看得出细节」与「一份工艺单只有几百 KB」之间。 */
export const EXPORT_IMAGE_QUALITY = 0.85;

/** 候选图片接口（`apiGet` 会自己补 `/api/v1`）。 */
export function exportImagesPath(orderId: string): string {
  return `/sales-orders/${orderId}/export-images`;
}

/**
 * 带图导出的地址。
 *
 * ⚠️ 自带 `/api/v1` 前缀：这条走 `downloadFormPost`（**裸 fetch**，见 lib/download.ts），
 * 它不像 `api-client` 那样补前缀。少了这三个字，请求会打到 Web 服务而不是 API，
 * 拿回一个 404 的 HTML —— 用户看到的是「导出失败」，而网络面板里那条请求根本没到过后端
 * （付款单导出踩过同一个坑，路径写在 lib/finance-slip.ts 里提醒过一次）。
 */
export function productionSheetExportPath(orderId: string): string {
  return `/api/v1/sales-orders/${orderId}/production-sheet.xlsx`;
}

/** 导出文件名（与后端 `Content-Disposition` 给的一致；后端给了就用后端那个）。 */
export function productionSheetFileName(orderNo: string): string {
  return `迪礼ERP-工艺单-${orderNo}.xlsx`;
}

/** 后端给的候选项（`GET /sales-orders/:id/export-images`）。 */
export type ExportImageCandidate = {
  spec_key: string;
  label: string;
  material_id: string;
  material_code: string;
  material_name: string;
  has_image: boolean;
  image_version: string | null;
};

/**
 * 候选项里**能勾选**的那些：只有「引用了物料 + 那个物料确实有图」才谈得上导出图片。
 *
 * 弹窗只列这些（用户要的是「每个有图片的物料允许用户勾选」）。没有图的那几项列出来
 * 只会让人以为「勾了就有图」，然后导出一份没有图的工艺单。
 */
export function selectableImages(candidates: readonly ExportImageCandidate[]): ExportImageCandidate[] {
  return candidates.filter((item) => item.has_image);
}

/** 默认勾选：全部有图的都勾上（点「工艺单」多半就是想要全带上，取消比一个个勾省事）。 */
export function defaultImageSelection(candidates: readonly ExportImageCandidate[]): string[] {
  return selectableImages(candidates).map((item) => item.spec_key);
}

/** 弹窗里的一行文字：`伞骨（孔对孔） — MAT-1 伞骨 50cm 黑`。 */
export function candidateLabel(candidate: ExportImageCandidate): string {
  const material = [candidate.material_code, candidate.material_name].filter(Boolean).join(" ");
  return material ? `${candidate.label} — ${material}` : candidate.label;
}

/** 解码（量尺寸）、编码两件事的抽象（理由见文件头）。 */
export type SheetImageDeps = {
  /** 取一张物料的 WebP 字节（`GET /materials/:id/image`，浏览器会走缓存/304）。 */
  fetchImage: (materialId: string, version: string | null) => Promise<Blob>;
  /** 读原图尺寸。 */
  measure: (blob: Blob) => Promise<{ width: number; height: number }>;
  /** 把原图缩到给定尺寸并编码成 JPEG。 */
  encodeJpeg: (blob: Blob, size: { width: number; height: number }) => Promise<Blob>;
};

/** 等比缩到最大边 `EXPORT_IMAGE_MAX_EDGE`（不放大）。 */
export function exportImageScale(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0) return { width: EXPORT_IMAGE_MAX_EDGE, height: EXPORT_IMAGE_MAX_EDGE };
  if (longest <= EXPORT_IMAGE_MAX_EDGE) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const scale = EXPORT_IMAGE_MAX_EDGE / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * 勾选的栏位 → multipart 表单（字段名 = `spec_key`，文件名也带栏位名，后端日志里看得懂）。
 *
 * 顺序照勾选顺序：出问题时报的那一格与用户点的那一行对得上。
 */
export async function buildProductionSheetForm(selected: readonly ExportImageCandidate[], deps: SheetImageDeps): Promise<FormData> {
  const form = new FormData();
  for (const candidate of selected) {
    const blob = await deps.fetchImage(candidate.material_id, candidate.image_version);
    const original = await deps.measure(blob);
    const jpeg = await deps.encodeJpeg(blob, exportImageScale(original.width, original.height));
    form.append(candidate.spec_key, jpeg, `${candidate.spec_key}.jpg`);
  }
  return form;
}

/** 默认实现：`fetch` 取图 + `createImageBitmap`/`<canvas>` 编码（只在浏览器里存在，所以**惰性**构造）。 */
export function browserSheetImageDeps(): SheetImageDeps {
  return {
    fetchImage: async (materialId, version) => {
      const query = version ? `?v=${encodeURIComponent(version)}` : "";
      const response = await fetch(`/api/v1/materials/${materialId}/image${query}`, { credentials: "include" });
      if (!response.ok) throw new Error(`取物料图片失败（HTTP ${response.status}）：请刷新页面后重试`);
      return response.blob();
    },
    measure: async (blob) => {
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return size;
    },
    encodeJpeg: async (blob, size) => {
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("这个浏览器不支持图片导出（拿不到画布）：请换 Chrome 或 Edge 再试");
        // 先铺白底：WebP 可能带透明通道，直接编码 JPEG 会得到黑底。
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, size.width, size.height);
        context.drawImage(bitmap, 0, 0, size.width, size.height);
        const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", EXPORT_IMAGE_QUALITY));
        if (!jpeg) throw new Error("图片转换失败：请稍后重试，或取消勾选图片后再导出");
        return jpeg;
      } finally {
        bitmap.close?.();
      }
    },
  };
}

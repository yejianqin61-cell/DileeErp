// 工艺单「带图片导出」的前端逻辑（**不能**放进 "use client" 文件）。
//
// 用户 2026-09-24：「导出销售单的时候，每个有图片的物料允许用户勾选是否 excel 中一并导出这个图片。
// excel 中图片我们就单独排成一排放在底下的一个图片区。然后让用户自行拖拽就好了」。
// 2026-11-04 扩到「行级图片」：材料行自己的图、引用物料的图、「再加一款 / 其它」行的图、
// 细分明细行的图都进候选（契约见 docs/design/sales-order-row-images-2026-11-04.md §2.4）。
// 2026-11-05 再扩到「每个位置最多 3 张」：候选变成**每张图一条**
// （契约见 docs/design/sales-order-row-images-x3-2026-11-05.md §3.5）——
// 同一格/同一行最多 3 条候选，`spec_key` 第 2/3 张带 `#2`/`#3`，另给 `base_key` 与 `image_slot`。
// 弹窗逐张可勾、默认全选；multipart 字段名仍然是候选的 `spec_key`（天然唯一）。
//
// ## 为什么图片要在浏览器里转成 JPEG
//
// 库里存的是 **WebP**（用户要求「压缩成 webp 再存进数据库」），而 ExcelJS 写进 xlsx 的图片
// Excel 只认 png/jpeg/gif —— WebP media part 在 Excel 里是一个红叉。服务端要转就得有解码器，
// 而用户明确选了「不引 sharp 那种原生依赖」那条路。浏览器天生能解 WebP（这图就是它自己压的），
// 所以转换放在这里：取图 → 量尺寸 → 画到画布 → `toBlob("image/jpeg")` → 作为 multipart 文件上传。
//
// ## 为什么取图地址由后端给（`image_url`），前端不再拼物料 id
//
// 2026-09-24 的候选只有一种来源：栏位引用的物料 → `/materials/:id/image`。2026-11-04 起，
// 材料行（含「再加一款 / 其它」）与细分明细行都可以有**行自己的图**，字节存在
// `sales_order_images` 里，按单隔离 —— 地址是 `/sales-orders/:id/images/:imageId`，**没有物料 id**。
// 哪一种图、存在哪张表，由后端在候选里用 `image_url`（自带 `/api/v1` 前缀与 `?v=sha`）说清楚：
// 前端照着这个地址取就是了。自己拼地址的写法在这里必然错一半（行图根本没有 material_id）。
//
// ## 为什么上传是 multipart、字段名就是候选键
//
// 图片字节走 JSON 会撞上后端 Express 默认 100KB 的 body 上限。multipart 本来就是为字节准备的：
// **一个勾选的候选 = 一个文件，字段名 = 后端给的 `spec_key`**（后端 `AnyFilesInterceptor` 把
// fieldname 原样取出来当栏位键），于是不必再发明「第几个文件对应哪一格」这种会错位的约定。
//
// 键对前端是**不透明的字符串**：18 个固定栏位是 `rib_spec` 这种栏位键，材料明细「其它」行是
// `extra:<行 id>`（2026-10-08），2026-11-04 起细分明细行是 `detail:<行 id>`，2026-11-05 起
// 同一格第 2/3 张再追加 `#2`/`#3`（`rib_spec#2`、`extra:<行 id>#3`…）。这里任何
// "必须是 `*_spec`"、「不含 `#`」之类的形状假设都会让某几张图静默发不出去
// （后端按 fieldname 找不到「那一格第几张」，只会报「这一格没有可导出的图片」）。
// 前端只把它们当**唯一字符串**用：勾选 id、字段名、`data-testid` 都是它，不解析也不改写。
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

/**
 * 后端给的候选项（`GET /sales-orders/:id/export-images`，契约见
 * docs/design/sales-order-row-images-2026-11-04.md §2.4 与
 * docs/design/sales-order-row-images-x3-2026-11-05.md §3.5）。
 *
 * 2026-11-04 起候选不再只是「引用了有图物料的栏位」：材料行自己的图、引用物料的图、
 * 「再加一款 / 其它」行的图、细分明细行的图都在里面。每张图的来源由后端用
 * `kind` / `image_source` 说清楚，`image_url` 是能直接 `<img src>` / `fetch` 的完整地址
 * （行图走销售单图片接口、物料图走物料图片接口，两者都自带 `/api/v1` 与 `?v=sha`）。
 *
 * 2026-11-05 起**每张图一条**：同一格/同一行最多 3 条，`spec_key` 是唯一键
 * （第 1 张 = 原键，第 2/3 张 = `原键#2` / `原键#3`），`base_key` / `image_slot`
 * 只是让调用方知道「这几条属于同一处、分别是第几张」，前端**不需要**拿它们拼字段名。
 */
export type ExportImageCandidate = {
  /**
   * 唯一种类键，也是 multipart 的字段名：第 1 张 = `rib_spec` / `extra:<行 id>` / `detail:<行 id>`，
   * 第 2/3 张 = `原键#2` / `原键#3`（后端解析 `#n` 后缀定位「哪一格第几张」）。
   */
  spec_key: string;
  /** 不带 `#n` 后缀的键（同一格/同一行的 3 张共用）：只用于展示/分组，**不要**拿它当字段名。 */
  base_key: string;
  /** 第几张：0 = 第 1 张，1 = 第 2 张，2 = 第 3 张（契约按 0 起）。 */
  image_slot: number;
  /** 印刷用的名字：栏位名 / 类目名 / 明细行名（明细行含分组）；第 2/3 张已追加「（第 n 张）」。 */
  label: string;
  /** 材料栏位（含「再加一款 / 其它」）/ 细分明细行。 */
  kind: "material" | "extra" | "detail";
  /** 引用了物料才有；行图（尤其是明细行的图）可以没有物料。 */
  material_id: string | null;
  /** 物料编码；行图没有物料时为空。 */
  material_code: string | null;
  /** 名称 + 规格 + 颜色（空段已由后端拼掉）。 */
  material_name: string | null;
  has_image: boolean;
  /** sha256，破缓存用；`image_url` 里已经带了 `?v=`，这里保留是契约形状。 */
  image_version: string | null;
  /** 行自己的图 / 物料清单那张（由服务端定：行图优先）。 */
  image_source: "row" | "material" | null;
  /** 行自己的图 = `sales_order_images.id`；物料图没有这个 id。 */
  image_id: string | null;
  /** 可直接 `<img src>` / `fetch`：自带 `/api/v1` 前缀与 `?v=sha`。 */
  image_url: string;
};

/**
 * 候选项里**能勾选**的那些：只有 `has_image` 才谈得上导出图片 —— 行自己的图或引用物料的图
 * 都算（两者由后端合并到同一个 `has_image`，前端不需要区分）。
 *
 * 2026-11-05 起同一格可能有「第 1/2/3 张」三条候选，这里**一条都不合并**：
 * 用户要逐张勾，被合并掉就等于某几张张图永远导不出去。
 *
 * 弹窗只列这些（用户要的是「每个有图片的物料允许用户勾选」）。没有图的那几项列出来
 * 只会让人以为「勾了就有图」，然后导出一份没有图的工艺单。
 */
export function selectableImages(candidates: readonly ExportImageCandidate[]): ExportImageCandidate[] {
  return candidates.filter((item) => item.has_image);
}

/**
 * 默认勾选：全部有图的都勾上（含同一格的第 2/3 张）——
 * 点「工艺单」多半就是想要全带上，取消比一个个勾省事。
 */
export function defaultImageSelection(candidates: readonly ExportImageCandidate[]): string[] {
  return selectableImages(candidates).map((item) => item.spec_key);
}

/**
 * 弹窗里的一行文字：`伞骨（孔对孔） — MAT-1 伞骨 50cm 黑`。
 *
 * - 行图（「再加一款 / 其它」/ 细分明细）没有物料编码时就只用候选自己的 `label`：
 *   明细行的 label 已经带分组（例如「伞头配色 / Hawái」），再拼一个破折号只会更难认；
 *   而且 `material_name` 单独出现时拼成「栏位 — 名称」也读不出这是物料。
 * - 第 2/3 张的「（第 n 张）」**由后端的 `label` 带**（2026-11-05）：这里不再拼一次，
 *   否则弹窗里会出现「（第 2 张）……（第 2 张）」这种重复。
 */
export function candidateLabel(candidate: ExportImageCandidate): string {
  if (!candidate.material_code) return candidate.label;
  const material = [candidate.material_code, candidate.material_name].filter(Boolean).join(" ");
  return material ? `${candidate.label} — ${material}` : candidate.label;
}

/** 解码（量尺寸）、编码两件事的抽象（理由见文件头）。 */
export type SheetImageDeps = {
  /**
   * 取这张候选的 WebP 字节。
   *
   * 传**整个候选**而不是物料 id：2026-11-04 起候选可能是行自己的图
   * （`/sales-orders/:id/images/:imageId`），也可能是物料图（`/materials/:id/image`）——
   * 拼地址的规则只有后端知道，前端照候选的 `image_url` 取就对了。
   */
  fetchImage: (candidate: ExportImageCandidate) => Promise<Blob>;
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
 * 勾选的候选 → multipart 表单（字段名 = `spec_key`，文件名也带候选键，后端日志里看得懂）。
 *
 * `spec_key` 对前端**不透明**（见文件头）：18 个固定栏位是 `rib_spec` 这种栏位键，
 * 「再加一款 / 其它」行是 `extra:<行 id>`，细分明细行是 `detail:<行 id>`；2026-11-05 起
 * 同一格第 2/3 张再带 `#2`/`#3`（`rib_spec#2`、`detail:<行 id>#3`…）。这里原样当字段名的
 * 键用，**不解析、不改写**（不拆 `#n`、不换回 `base_key`）—— 后端 `AnyFilesInterceptor` 拿
 * fieldname 去定位「哪一格第几张」，任何形状假设都会让那几张图静默发不出去。
 *
 * 顺序照勾选顺序：出问题时报的那一张与用户点的那一行对得上。
 */
export async function buildProductionSheetForm(selected: readonly ExportImageCandidate[], deps: SheetImageDeps): Promise<FormData> {
  const form = new FormData();
  for (const candidate of selected) {
    const blob = await deps.fetchImage(candidate);
    const original = await deps.measure(blob);
    const jpeg = await deps.encodeJpeg(blob, exportImageScale(original.width, original.height));
    form.append(candidate.spec_key, jpeg, `${candidate.spec_key}.jpg`);
  }
  return form;
}

/** 默认实现：`fetch` 取图 + `createImageBitmap`/`<canvas>` 编码（只在浏览器里存在，所以**惰性**构造）。 */
export function browserSheetImageDeps(): SheetImageDeps {
  return {
    fetchImage: async (candidate) => {
      // `image_url` 自带 `/api/v1` 与 `?v=sha`（契约）。这里**不**按 material_id 拼地址：
      // 行图（材料行自己的图、明细行的图）地址里根本没有物料 id。
      if (!candidate.image_url) throw new Error("这张候选没有图片地址：请刷新页面后重试");
      const response = await fetch(candidate.image_url, { credentials: "include" });
      if (!response.ok) throw new Error(`取图片失败（HTTP ${response.status}）：请刷新页面后重试`);
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

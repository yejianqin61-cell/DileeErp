// 凭证「一键导出 PNG」：纯逻辑（SVG 组版） + 浏览器位图化（SVG → canvas → PNG）。
//
// 为什么不用 html2canvas / html-to-image：
//   1) 这两个库都要新增前端依赖（本项目当前没有，也不能假设能联网安装）；
//   2) 它们靠遍历 DOM + 内联样式来"猜"版式，凭证纸这种固定表格用 SVG 反而更可控、更清晰。
// 因此这里把凭证重新组一遍版（SVG），交给浏览器自己栅格化：
//   Blob(svg) → Image → canvas.drawImage → canvas.toBlob('image/png') → <a download>
// 同源 blob: 不会污染 canvas，所以 toBlob 可用；不引外部字体/图片，离线也能出图。
//
// 本文件必须能被 `lib/**/*.test.mjs` 用 Node 直接 import（见 apps/web/lib/api-client.ts 的说明），
// 因此：不 import 任何 React/组件模块、不使用 enum/namespace 之类的不可擦除语法；
// 依赖浏览器全局（document/Image）的部分全部放在函数体内，Node 里只要不调用就不会报错。

export type VoucherImageLine = {
  lineNo: number;
  /** debit | credit */
  direction: string;
  subjectLabel: string;
  summary: string;
  amount: string;
};

export type VoucherImageInput = {
  voucherNo: string;
  voucherDate: string;
  period: string;
  currency: string;
  status: string;
  statusLabel?: string;
  summary: string;
  debitTotal: string;
  creditTotal: string;
  remark?: string | null;
  /** 来源（收支流水号 / 被红冲的凭证号），没有就画 "-"。 */
  sourceLabel?: string | null;
  createdBy?: string | null;
  lines: VoucherImageLine[];
};

/** 出图倍率：2 倍分辨率，贴到文档里不糊（1000 逻辑宽 → 2000px 位图）。 */
export const VOUCHER_PNG_SCALE = 2;

const PAGE_WIDTH = 1000;
const MARGIN = 44;
const FONT = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", sans-serif';
const INK = "#1f2937";
const MUTED = "#647184";
const LINE = "#c9d2dc";

/** 文件名：记账凭证-记-2026-09-0001.png（凭证号里的字符先做文件名安全化）。 */
export function voucherFileName(voucherNo: string): string {
  const safe = (voucherNo || "凭证").replace(/[\\/:*?"<>|\s]/g, "-");
  return `记账凭证-${safe}.png`;
}

/** XML 文本转义：凭证摘要里出现 & < > 时不能让 SVG 解析失败。 */
export function escapeXml(value: string): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** 金额 + 币种，与页面上的 money() 同一口径。 */
function amountText(amount: string, currency: string) {
  return amount ? `${amount} ${currency}` : "-";
}

/** 单元格文本裁剪：CJK 按 1em、ASCII 按 0.55em 估算宽度，超出加省略号（SVG 不做自动换行）。 */
export function fitText(value: string, maxWidth: number, size: number): string {
  let used = 0;
  let out = "";
  for (const char of String(value ?? "")) {
    const width = /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(char) ? size : size * 0.55;
    if (used + width > maxWidth) return `${out}…`;
    used += width;
    out += char;
  }
  return out;
}

type TextOptions = { size?: number; anchor?: "start" | "middle" | "end"; weight?: number; fill?: string; spacing?: number };

function text(x: number, y: number, value: string, options: TextOptions = {}): string {
  const { size = 14, anchor = "start", weight = 400, fill = INK, spacing } = options;
  const attrs = [
    `x="${x}"`, `y="${y}"`, `font-size="${size}"`, `font-family='${FONT}'`, `font-weight="${weight}"`,
    `fill="${fill}"`, `text-anchor="${anchor}"`,
    ...(spacing ? [`letter-spacing="${spacing}"`] : []),
  ];
  return `<text ${attrs.join(" ")}>${escapeXml(value)}</text>`;
}

function box(x: number, y: number, width: number, height: number, fill = "none"): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}" stroke="${LINE}" stroke-width="1"/>`;
}

function line(x1: number, y1: number, x2: number, y2: number): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${LINE}" stroke-width="1"/>`;
}

/**
 * 把凭证组版成一张 SVG（记账凭证版式）。
 *
 * 这是 PNG 的**唯一来源**：页面上那张 HTML 凭证纸服务于打印，这里服务于出图，
 * 两者用同一批字段，字段名变化时两处一起改（测试同时断言两边的关键标签）。
 */
export function voucherSvg(input: VoucherImageInput): string {
  const right = PAGE_WIDTH - MARGIN;
  const cols = { summary: MARGIN, subject: 392, debit: 620, credit: 800 };
  const parts: string[] = [];
  let y = 0;

  // 标题
  y += 58;
  parts.push(text(PAGE_WIDTH / 2, y, "记 账 凭 证", { size: 26, anchor: "middle", weight: 700, spacing: 4 }));
  y += 14;
  parts.push(line(MARGIN, y, right, y));
  y += 26;
  parts.push(text(MARGIN, y, `凭证号：${input.voucherNo}`, { size: 13 }));
  parts.push(text(PAGE_WIDTH / 2, y, `日期：${String(input.voucherDate).slice(0, 10)}`, { size: 13, anchor: "middle" }));
  parts.push(text(right, y, `期间：${input.period}`, { size: 13, anchor: "end" }));
  y += 20;
  parts.push(text(MARGIN, y, `币种：${input.currency}`, { size: 13, fill: MUTED }));
  parts.push(text(PAGE_WIDTH / 2, y, `状态：${input.statusLabel ?? input.status}`, { size: 13, anchor: "middle", fill: MUTED }));
  parts.push(text(right, y, `来源：${input.sourceLabel ?? "-"}`, { size: 13, anchor: "end", fill: MUTED }));
  y += 20;
  parts.push(text(MARGIN, y, `摘要：${fitText(input.summary, right - MARGIN - 40, 13)}`, { size: 13, fill: MUTED }));
  y += 14;

  // 表头
  const rowHeight = 30;
  parts.push(box(MARGIN, y, right - MARGIN, rowHeight, "#f8fafc"));
  parts.push(text(cols.summary + 8, y + 20, "摘要", { size: 13, weight: 600 }));
  parts.push(text(cols.subject + 8, y + 20, "会计科目", { size: 13, weight: 600 }));
  parts.push(text(cols.debit - 8, y + 20, "借方金额", { size: 13, weight: 600, anchor: "end" }));
  parts.push(text(right - 8, y + 20, "贷方金额", { size: 13, weight: 600, anchor: "end" }));
  y += rowHeight;

  // 分录
  for (const item of input.lines) {
    parts.push(box(MARGIN, y, right - MARGIN, rowHeight));
    parts.push(text(cols.summary + 8, y + 20, fitText(item.summary || input.summary, cols.subject - cols.summary - 20, 13), { size: 13 }));
    parts.push(text(cols.subject + 8, y + 20, fitText(item.subjectLabel, cols.debit - cols.subject - 20, 13), { size: 13 }));
    parts.push(text(cols.debit - 8, y + 20, item.direction === "debit" ? amountText(item.amount, input.currency) : "", { size: 13, anchor: "end" }));
    parts.push(text(right - 8, y + 20, item.direction === "credit" ? amountText(item.amount, input.currency) : "", { size: 13, anchor: "end" }));
    y += rowHeight;
  }
  // 合计
  parts.push(box(MARGIN, y, right - MARGIN, rowHeight, "#f8fafc"));
  parts.push(text(cols.summary + 8, y + 20, "合计", { size: 13, weight: 700 }));
  parts.push(text(cols.debit - 8, y + 20, amountText(input.debitTotal, input.currency), { size: 13, weight: 700, anchor: "end" }));
  parts.push(text(right - 8, y + 20, amountText(input.creditTotal, input.currency), { size: 13, weight: 700, anchor: "end" }));
  y += rowHeight;

  // 列分隔线（画在行框之上，让表格看起来是整格）
  for (const x of [cols.subject, cols.debit, cols.credit]) parts.push(line(x, y - rowHeight * (input.lines.length + 2), x, y));

  // 签字栏与备注
  y += 30;
  parts.push(text(MARGIN, y, `制单：${input.createdBy ?? ""}`, { size: 13, fill: MUTED }));
  parts.push(text(MARGIN + 180, y, "审核：", { size: 13, fill: MUTED }));
  parts.push(text(MARGIN + 360, y, "记账：", { size: 13, fill: MUTED }));
  parts.push(text(MARGIN + 540, y, "单位负责人：", { size: 13, fill: MUTED }));
  if (input.remark) {
    y += 22;
    parts.push(text(MARGIN, y, `备注：${fitText(input.remark, right - MARGIN - 40, 13)}`, { size: 13, fill: MUTED }));
  }
  y += 24;
  parts.push(text(MARGIN, y, "本凭证由迪礼 ERP 生成：科目取自「收支项目」字典，草稿可在凭证管理里改为自己账套的科目名。", { size: 11, fill: MUTED }));
  const height = Math.round(y + 24);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${height}" viewBox="0 0 ${PAGE_WIDTH} ${height}">`,
    `<rect x="0" y="0" width="${PAGE_WIDTH}" height="${height}" fill="#ffffff"/>`,
    ...parts,
    "</svg>",
  ].join("");
}

/** 从 SVG 根标签读回宽高（自己生成的，格式受控）。 */
export function svgSize(svg: string): { width: number; height: number } {
  const width = Number(/\bwidth="(\d+(?:\.\d+)?)"/.exec(svg)?.[1] ?? 0);
  const height = Number(/\bheight="(\d+(?:\.\d+)?)"/.exec(svg)?.[1] ?? 0);
  if (!width || !height) throw new Error("凭证图尺寸解析失败");
  return { width, height };
}

/**
 * SVG → PNG Blob（浏览器）。
 *
 * 失败一律抛出**可执行**的中文原因：canvas 不可用（如无 canvas 的环境）时要提示改用打印/另存 PDF，
 * 而不是丢一个 "toBlob is not a function" 让人猜。
 */
export async function voucherPngBlob(svg: string, scale = VOUCHER_PNG_SCALE): Promise<Blob> {
  if (typeof document === "undefined" || typeof Image === "undefined") throw new Error("当前环境不支持导出图片，请改用「打印 / 另存 PDF」");
  const { width, height } = svgSize(svg);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("凭证图渲染失败（浏览器无法载入 SVG），请改用「打印 / 另存 PDF」"));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境不支持导出图片（canvas 不可用），请改用「打印 / 另存 PDF」");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob((result) => resolve(result), "image/png"));
    if (!png) throw new Error("导出 PNG 失败：浏览器未能生成图片，请改用「打印 / 另存 PDF」");
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 触发浏览器下载（<a download>）。延迟回收 blob URL：立刻 revoke 会让部分浏览器中断下载。 */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 一键导出：组版 → 位图化 → 下载，返回文件名（供调用方提示「已导出 xxx.png」）。
 */
export async function exportVoucherPng(input: VoucherImageInput, scale = VOUCHER_PNG_SCALE): Promise<string> {
  const fileName = voucherFileName(input.voucherNo);
  const blob = await voucherPngBlob(voucherSvg(input), scale);
  downloadBlob(blob, fileName);
  return fileName;
}

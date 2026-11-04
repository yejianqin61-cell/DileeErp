/**
 * 打印横向探针（诊断用，非交付脚本的主流程）：
 * 在同一个 Chromium 里，用 4 个最小页面确认「@page 命名页 + page 属性」到底会不会改变 page.pdf() 的 MediaBox。
 *
 * 目的：区分「实现缺陷」与「Playwright page.pdf 的能力边界」。
 * 运行：node .agent\verify\_print-landscape-probe.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_DIR = path.join(REPO_ROOT, ".agent", "verify");

function parseMediaBox(buffer) {
  const text = buffer.toString("latin1");
  const boxes = [...text.matchAll(/\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/g)].map((match) => ({
    raw: match[0],
    width: Math.abs(Number(match[3]) - Number(match[1])),
    height: Math.abs(Number(match[4]) - Number(match[2])),
  }));
  return { first: boxes[0] ?? null, count: boxes.length };
}

const cases = {
  "default-a4-landscape": `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4 landscape; margin: 10mm; }
    body { margin: 0; font-family: sans-serif; }
    .sheet { width: 100%; }
    table { width: 100%; border-collapse: collapse; }
    td, th { border: 1px solid #333; padding: 4px; }
  </style></head><body><div class="sheet"><h1>默认 @page A4 横向</h1><table>${"<tr><td>1</td><td>2</td><td>3</td></tr>".repeat(11)}</table></div></body></html>`,
  "named-page-inflow": `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4 portrait; }
    @page warehouse { size: A4 landscape; margin: 10mm; }
    body { margin: 0; }
    .sheet { page: warehouse; width: 100%; }
    table { width: 100%; border-collapse: collapse; }
    td, th { border: 1px solid #333; padding: 4px; }
  </style></head><body><div class="sheet"><h1>命名页 warehouse A4 横向（在文档流内）</h1><table>${"<tr><td>1</td><td>2</td><td>3</td></tr>".repeat(11)}</table></div></body></html>`,
  "named-page-absolute": `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4 portrait; }
    @page warehouse { size: A4 landscape; margin: 10mm; }
    body { margin: 0; }
    body * { visibility: hidden; }
    .sheet, .sheet * { visibility: visible; }
    .sheet { page: warehouse; position: absolute; left: 0; top: 0; width: 100%; }
    table { width: 100%; border-collapse: collapse; }
    td, th { border: 1px solid #333; padding: 4px; }
  </style></head><body><div>其他内容</div><div class="sheet"><h1>命名页 warehouse A4 横向（绝对定位，模拟报表纸面）</h1><table>${"<tr><td>1</td><td>2</td><td>3</td></tr>".repeat(11)}</table></div></body></html>`,
  "named-page-absolute-only": `<!doctype html><html><head><meta charset="utf-8"><style>
    @page warehouse { size: A4 landscape; margin: 10mm; }
    body { margin: 0; }
    .sheet { page: warehouse; position: absolute; left: 0; top: 0; width: 100%; }
    table { width: 100%; border-collapse: collapse; }
    td, th { border: 1px solid #333; padding: 4px; }
  </style></head><body><div class="sheet"><h1>只有命名页 + 绝对定位</h1><table>${"<tr><td>1</td><td>2</td><td>3</td></tr>".repeat(11)}</table></div></body></html>`,
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const results = {};
for (const [name, html] of Object.entries(cases)) {
  await page.setContent(html, { waitUntil: "load" });
  const buffer = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(path.join(OUT_DIR, `_print-probe-${name}.pdf`), buffer);
  const parsed = parseMediaBox(buffer);
  results[name] = { mediaBox: parsed, media: page.viewportSize() };
  console.log(`${name}: ${parsed.first ? `${parsed.first.width} x ${parsed.first.height} pt (${parsed.first.raw})` : "no mediaBox"}`);
}
fs.writeFileSync(path.join(OUT_DIR, "_print-landscape-probe.json"), JSON.stringify(results, null, 2), "utf8");
await browser.close();

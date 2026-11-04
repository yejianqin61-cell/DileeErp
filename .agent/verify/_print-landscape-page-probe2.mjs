/**
 * 打印横向「根因定位」探针（第二轮）：在真实报表页面上依次注入 4 种候选修复，看哪种能把
 * page.pdf() 的 MediaBox 变成 A4 横向 842x595。
 *
 * 只做验证：通过 page.addStyleTag 在**浏览器里**注入覆盖样式，不改仓库源码。
 * 运行：node .agent\verify\_print-landscape-page-probe2.mjs（需要 3111 上的 next dev）
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_DIR = path.join(REPO_ROOT, ".agent", "verify");
const BASE = process.env.VERIFY_BASE_URL ?? "http://127.0.0.1:3111";

const PROFILE = {
  display_name: "张三", username: "zhangsan", role_keys: ["laoban"], surface_roles: ["laoban"], surface_scope: "full",
  surface_sections: ["dashboard", "production", "procurement", "qc", "warehouse", "sales", "reorder", "customers", "reports", "finance", "hr", "account", "business-query"],
  module_keys: ["sales", "procurement", "production", "warehouse", "finance", "hr"],
};
const ROWS = Array.from({ length: 11 }, (_, index) => ({
  order_no: "260119", material_name: `物料${index + 1}`, color: "黑色", unit: "打",
  purchase_quantity: "4700", inbound_quantity: "4700", pending_inbound_quantity: "0", production_issue_quantity: "3050", stock_quantity: "1650",
}));

function parseMediaBoxes(buffer) {
  const text = buffer.toString("latin1");
  return [...text.matchAll(/\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/g)].map((match) => ({
    raw: match[0],
    width: Math.abs(Number(match[3]) - Number(match[1])),
    height: Math.abs(Number(match[4]) - Number(match[2])),
  }));
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", serviceWorkers: "block" });
const page = await context.newPage();
page.setDefaultTimeout(120000);
await page.route("**/api/v1/**", async (route) => {
  const apiPath = new URL(route.request().url()).pathname.replace(/^\/api\/v1/, "");
  const envelope = (data, meta = {}) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data, meta }) });
  if (apiPath === "/auth/me") return envelope(PROFILE);
  if (apiPath === "/reports/procurement-warehouse") return envelope(ROWS, { generated_at: "2026-11-04T14:30:00.000Z", row_count: 11, row_limit: 5000, filters: { order_no: null, material: null } });
  return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_MOCKED", message: apiPath, details: [] }, meta: {} }) });
});
await page.goto(`${BASE}/reports/procurement-warehouse`, { waitUntil: "domcontentloaded", timeout: 180000 });
await page.locator('[data-testid="data-table-row"]').first().waitFor({ state: "visible", timeout: 180000 });
await page.locator('[data-testid="report-print"]').click();
await page.locator('[data-testid="report-print-dialog"]').waitFor({ state: "visible", timeout: 30000 });
await page.emulateMedia({ media: "print" });
await page.waitForTimeout(400);

/** 打印媒体下的 DOM 结构：sheet 的祖先链 + body 的直接子元素（供定位「谁占用了第一页」）。 */
const dom = await page.evaluate(() => {
  const sheet = document.querySelector(".procurement-warehouse-sheet");
  const chain = [];
  for (let node = sheet; node && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    chain.push({ tag: node.tagName.toLowerCase(), className: String(node.className ?? "").slice(0, 80), position: style.position, display: style.display, page: style.page, height: Math.round(node.getBoundingClientRect().height) });
  }
  const bodyChildren = [...document.body.children].map((node) => ({
    tag: node.tagName.toLowerCase(),
    className: String(node.className ?? "").slice(0, 60),
    id: node.id,
    display: getComputedStyle(node).display,
    height: Math.round(node.getBoundingClientRect().height),
    containsSheet: Boolean(node.querySelector(".procurement-warehouse-sheet")),
  }));
  return { sheetAncestorChain: chain, bodyChildren };
});

async function pdfBoxes(label) {
  const buffer = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  fs.writeFileSync(path.join(OUT_DIR, `_print-probe2-${label}.pdf`), buffer);
  return parseMediaBoxes(buffer);
}

const variants = [];
const baseline = await pdfBoxes("baseline");
variants.push({ name: "baseline（现状）", boxes: baseline });

// V1：page 属性往根元素上放（html）
await page.addStyleTag({ content: "@media print { html { page: procurement-warehouse !important; } }" });
await page.waitForTimeout(200);
variants.push({ name: "V1 html { page: procurement-warehouse }", boxes: await pdfBoxes("v1-html-page") });

// V2：page 属性放 body
await page.addStyleTag({ content: "@media print { body { page: procurement-warehouse !important; } }" });
await page.waitForTimeout(200);
variants.push({ name: "V2 + body { page: procurement-warehouse }", boxes: await pdfBoxes("v2-body-page") });

// V3：给本页加一条**默认** @page 尺寸（文档级），命名页留不留都不影响第一页
await page.addStyleTag({ content: "@media print { @page { size: A4 landscape; margin: 10mm; } }" });
await page.waitForTimeout(200);
variants.push({ name: "V3 + @page { size: A4 landscape }（默认页尺寸）", boxes: await pdfBoxes("v3-default-page-size") });

// V4：把纸面前面的内容（页头/筛选/面板）用 display:none 拿掉，让第一页就是纸面
await page.addStyleTag({ content: `@media print {
  .page-header, [data-testid="report-filters"], .page-root > section.panel { display: none !important; }
  .procurement-warehouse-dialog { display: block !important; }
}` });
await page.waitForTimeout(200);
variants.push({ name: "V4 + 隐藏纸面前的内容（display:none，而非 visibility）", boxes: await pdfBoxes("v4-hide-before-sheet") });

const result = {
  generatedAt: new Date().toISOString(),
  dom,
  variants,
  conclusion: (() => {
    const landscape = (boxes) => boxes.length > 0 && boxes.every((box) => box.width > box.height);
    const hit = variants.filter((variant) => landscape(variant.boxes)).map((variant) => variant.name);
    return {
      baselineIsLandscape: landscape(baseline),
      candidatesThatProduceLandscape: hit,
      note: hit.length ? `能让 page.pdf 打出 A4 横向的修复方向：${hit.join(" / ")}` : "4 个候选都没有改变第一页尺寸，需要进一步排查",
    };
  })(),
};
fs.writeFileSync(path.join(OUT_DIR, "_print-landscape-page-probe2.json"), JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify(result, null, 2));
await browser.close();

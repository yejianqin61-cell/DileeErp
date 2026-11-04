/**
 * 打印横向「根因定位」探针：在真实报表页面上确认——
 *   1) 现状 page.pdf() 的 MediaBox 是 Letter 竖直 612x792（打印不是 A4 横向 → 缺陷）；
 *   2) 把打印媒体下 `.procurement-warehouse-sheet` 的 `position: absolute` 改回 static 后，
 *      同一个页面立刻打出 A4 横向 842x595（= 唯一原因就是全局 @media print 里那条绝对定位）。
 *
 * 只做验证：通过 page.addStyleTag 在**浏览器里**注入覆盖样式，不改仓库源码。
 * 运行：node .agent\verify\_print-landscape-page-probe.mjs（需要 3111 上的 next dev）
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

function parseMediaBox(buffer) {
  const text = buffer.toString("latin1");
  const match = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(text);
  return match ? { raw: match[0], width: Math.abs(Number(match[3]) - Number(match[1])), height: Math.abs(Number(match[4]) - Number(match[2])) } : null;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", serviceWorkers: "block" });
const page = await context.newPage();
page.setDefaultTimeout(120000);
await page.route("**/api/v1/**", async (route) => {
  const url = new URL(route.request().url());
  const apiPath = url.pathname.replace(/^\/api\/v1/, "");
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

const computedBefore = await page.evaluate(() => {
  const sheet = document.querySelector(".procurement-warehouse-sheet");
  return { position: getComputedStyle(sheet).position, page: getComputedStyle(sheet).page, visibility: getComputedStyle(sheet).visibility };
});
const before = parseMediaBox(await page.pdf({ preferCSSPageSize: true, printBackground: true }));

// 只覆盖 position（不动 page / 其它打印规则），看 MediaBox 是否变成 A4 横向。
await page.addStyleTag({ content: "@media print { .procurement-warehouse-sheet { position: static !important; } }" });
await page.waitForTimeout(300);
const computedAfter = await page.evaluate(() => {
  const sheet = document.querySelector(".procurement-warehouse-sheet");
  return { position: getComputedStyle(sheet).position, page: getComputedStyle(sheet).page, visibility: getComputedStyle(sheet).visibility };
});
const after = parseMediaBox(await page.pdf({ preferCSSPageSize: true, printBackground: true }));

const result = {
  generatedAt: new Date().toISOString(),
  page: "http://127.0.0.1:3111/reports/procurement-warehouse",
  computedBefore,
  mediaBoxBefore: before,
  computedAfter,
  mediaBoxAfter: after,
  rootCause: computedBefore.position === "absolute"
    ? "打印媒体下 .procurement-warehouse-sheet 被全局 @media print 规则设为 position:absolute；Chromium 不给绝对定位盒子分配命名页 → @page procurement-warehouse 的 A4 landscape 不生效，回落到默认 Letter 竖直。"
    : "未复现 position:absolute",
  fixSuggestion: "把 `.procurement-warehouse-sheet` 从 `position: absolute` 那条全局规则里拆出来（或改成 `position: static`），让命名页生效；其余单据保持原规则。",
};
fs.writeFileSync(path.join(OUT_DIR, "_print-landscape-page-probe.json"), JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify(result, null, 2));
await browser.close();

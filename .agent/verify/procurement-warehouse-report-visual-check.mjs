/**
 * 采购与仓储报表（2026-11-04）—— 真实 Chromium 只读视觉/交互验证脚本（A 部分）。
 *
 * 约束：不改仓库源码。真实 Chromium 打开页面，用 `page.route` 统一 mock `/api/v1/**`
 * （严格按页面真实契约造数据：用户截图里那张真实的 11 行表、订单号全为 260119）。
 *
 * 运行：
 *   1) npm run dev --workspace=@dilee/web -- -p 3111
 *   2) node .agent\verify\procurement-warehouse-report-visual-check.mjs
 * 产物：
 *   docs/test/results/procurement-warehouse-report/{desktop-detail,print-dialog,print-media,mobile,empty,error}.png
 *   docs/test/results/procurement-warehouse-report/print-preview.pdf
 *   .agent/verify/procurement-warehouse-report-results.json
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_DIR = path.join(REPO_ROOT, "docs", "test", "results", "procurement-warehouse-report");
const RESULTS_JSON = path.join(REPO_ROOT, ".agent", "verify", "procurement-warehouse-report-results.json");
const PRINT_PDF = path.join(OUT_DIR, "print-preview.pdf");
const BASE = process.env.VERIFY_BASE_URL ?? "http://127.0.0.1:3111";

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const REPORT_PAGE_PATH = "/reports/procurement-warehouse";
const REPORT_API_PATH = "/reports/procurement-warehouse";
const EXPORT_API_PATH = "/reports/procurement-warehouse/export.xlsx";
const FILTERED_QUERY = "?order_no=260119&material=%E4%BC%9E";

const HEADERS = ["订单号", "物料名称", "颜色", "单位", "采购数量", "采购入库量", "采购未入库数", "生产领用数量", "库存量"];

// ---------------------------------------------------------------------------
// mock 数据：用户截图里那张真实的表（11 行、订单号全为 260119）。
// 字段名与 apps/web/lib/procurement-warehouse-report.ts 的 ProcurementWarehouseRow 逐字一致。
// ---------------------------------------------------------------------------
const reportRow = (material_name, color, unit, purchase, inbound, issue, stock) => ({
  order_no: "260119",
  material_name,
  color,
  unit,
  purchase_quantity: String(purchase),
  inbound_quantity: String(inbound),
  pending_inbound_quantity: String(purchase - inbound),
  production_issue_quantity: String(issue),
  stock_quantity: String(stock)
});

const ROWS = [
  reportRow("58cm*8k自动直骨伞", "黑色", "打", 4700, 4700, 3050, 1650),
  reportRow("75D 190T灰色XPG-23535黑胶自然光黑胶碰击布B色号", "灰色", "码", 9800, 9730, 9660, 70),
  reportRow("75D 190T天蓝色XPG-23637自然光黑胶碰击布A色号", "天蓝色", "码", 8495, 8495, 9040, -545),
  reportRow("75D 190T粉色自然光黑胶碰击布", "粉色", "码", 6200, 5778, 4800, 978),
  reportRow("75D 190T卡其色C色号素色黑胶自然光", "卡其色", "码", 8130, 8130, 7850, 280),
  reportRow("75D 190T白色素色黑胶自然光", "白色", "码", 19405, 19405, 17025, 2380),
  reportRow("ABS料伞头（TF1076）", "同客户提供的颜色", "打", 4700, 2178, 2046, 132),
  reportRow("配8MM金色伞签", "金色", "打", 4700, 4700, 2700, 2000),
  reportRow("配3.0金色伞珠", "金色", "打", 4700, 4700, 4700, 0),
  reportRow("1.2金色带LOGO全铜平面扣", "金色", "打", 4700, 4700, 4700, 0),
  reportRow("内标（1*6CM）", "白色", "打", 4700, 0, 0, 0)
];

/** 期望的「每行九列文字」：与 DataTable 渲染逐格对照。 */
const displayRow = (row) => [
  row.order_no, row.material_name, row.color, row.unit,
  row.purchase_quantity, row.inbound_quantity, row.pending_inbound_quantity, row.production_issue_quantity, row.stock_quantity
];

const PROFILE = {
  display_name: "张三",
  username: "zhangsan",
  role_keys: ["laoban"],
  surface_roles: ["laoban"],
  surface_scope: "full",
  // AppShell 用 canVisitPath(profile.surface_sections, pathname) 拦页面：必须含 "reports"。
  surface_sections: ["dashboard", "production", "procurement", "qc", "warehouse", "sales", "reorder", "customers", "reports", "finance", "hr", "account", "business-query"],
  module_keys: ["sales", "procurement", "production", "warehouse", "finance", "hr"],
};

const meta = () => ({
  generated_at: "2026-11-04T14:30:00.000Z",
  row_count: ROWS.length,
  row_limit: 5000,
  filters: { order_no: null, material: null },
});

/** 导出的占位字节：合法 ZIP 头即可（页面只关心 response.ok + 触发下载 + toast）。 */
const PLACEHOLDER_XLSX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);

// ---------------------------------------------------------------------------
// /api/v1/** 统一 mock。dataKind 决定这次页面看到的是哪一套数据。
// ---------------------------------------------------------------------------
function createMock(dataKind) {
  return async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const requestPath = url.pathname.replace(/^\/api\/v1/, "");
    const method = request.method();
    const envelope = (data, extraMeta = {}) => route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({ data, meta: extraMeta }),
    });
    const failure = (status, code, message) => route.fulfill({
      status,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({ error: { code, message, details: [] }, meta: {} }),
    });

    if (requestPath === "/auth/me" && method === "GET") return envelope(PROFILE);

    if (requestPath === REPORT_API_PATH && method === "GET") {
      if (dataKind === "error") return failure(422, "REPORT_ROW_LIMIT_EXCEEDED", "报表行数超过 5000 行，请按订单号或物料缩小范围");
      if (dataKind === "empty") return envelope([], { ...meta(), row_count: 0 });
      return envelope(ROWS, meta());
    }

    if (requestPath === EXPORT_API_PATH && method === "GET") {
      if (dataKind === "export-failure") return failure(500, "REPORT_EXPORT_FAILED", "导出失败：测试注入的 500");
      return route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent("迪礼ERP-采购与仓储报表-20261104230000.xlsx")}`,
          "cache-control": "no-store",
        },
        body: PLACEHOLDER_XLSX,
      });
    }

    // /reports 入口页要的既有接口
    if (requestPath === "/alerts" && method === "GET") return envelope([], {});
    if (/^\/reports\/[^/]+$/.test(requestPath) && method === "GET") return envelope([], {});

    return failure(404, "NOT_MOCKED", `未 mock 的请求：${method} ${requestPath}`);
  };
}

// ---------------------------------------------------------------------------
// 断言收集：每条都记录实测值；不中断场景（前置条件失败的场景由 runScenario 兜底）
// ---------------------------------------------------------------------------
const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail: detail ?? null });
  return Boolean(condition);
}

/** 一次 evaluate 取回页面上的全部断言数字。 */
async function collectFacts(page) {
  return page.evaluate(() => {
    const round = (value) => Math.round(value * 10) / 10;
    const rect = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: round(box.x), y: round(box.y), top: round(box.top), left: round(box.left), right: round(box.right), bottom: round(box.bottom), width: round(box.width), height: round(box.height) };
    };
    const style = (element, property) => (element ? getComputedStyle(element)[property] : null);
    const textOf = (element) => (element ? (element.innerText ?? element.textContent ?? "").trim() : "");
    const table = document.querySelector('[data-testid="report-table"]');
    const headerCells = table ? [...table.querySelectorAll("th")] : [];
    const dataRows = table ? [...table.querySelectorAll('[data-testid="data-table-row"]')] : [];
    const cellsOf = (row) => [...row.querySelectorAll("td")].map((cell) => ({ text: (cell.innerText ?? cell.textContent ?? "").trim(), className: cell.className, hasStatusError: Boolean(cell.querySelector(".status-error")) }));
    const sheet = document.querySelector('[data-testid="procurement-warehouse-sheet"]');
    const dialog = document.querySelector('[data-testid="report-print-dialog"]');
    const printSubtitle = document.querySelector('[data-testid="procurement-warehouse-print-subtitle"]');
    const emptyState = document.querySelector('[data-testid="empty-state"]');
    const errorState = document.querySelector('[data-testid="error-state"]');
    const numericTexts = dataRows.flatMap((row) => cellsOf(row).slice(4).map((cell) => cell.text));
    const statusErrorCells = [...document.querySelectorAll(".status-error")].map((element) => ({ text: (element.innerText ?? element.textContent ?? "").trim(), color: getComputedStyle(element).color }));
    const normalNumber = document.querySelector('[data-testid="report-table"] .procurement-warehouse-num:not(.status-error)');
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        innerWidth: window.innerWidth,
        horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
        bodyScrollWidth: document.body.scrollWidth,
      },
      table: {
        present: Boolean(table),
        headers: headerCells.map((cell) => (cell.innerText ?? cell.textContent ?? "").trim()),
        headerRects: headerCells.map(rect),
        rowCount: dataRows.length,
        rowLengths: dataRows.map((row) => row.querySelectorAll("td").length),
        rows: dataRows.map((row) => cellsOf(row).map((cell) => cell.text)),
        rowsWithStatusError: dataRows.map((row) => cellsOf(row).map((cell) => cell.hasStatusError)),
        tableWrap: (() => {
          const wrap = document.querySelector('[data-testid="report-table"] .table-wrap') ?? document.querySelector('[data-testid="report-table"] [data-testid="data-table"]');
          return wrap ? { clientWidth: wrap.clientWidth, scrollWidth: wrap.scrollWidth } : null;
        })(),
      },
      numeric: {
        texts: numericTexts,
        trailingZeroTexts: numericTexts.filter((text) => /\.\d*0$/.test(text)),
        statusErrorCells,
        normalNumberColor: normalNumber ? getComputedStyle(normalNumber).color : null,
      },
      rowCountText: textOf(document.querySelector('[data-testid="report-row-count"]')),
      scopeNotesText: textOf(document.querySelector('[data-testid="report-scope-notes"]')),
      empty: { present: Boolean(emptyState), text: textOf(emptyState) },
      error: { present: Boolean(errorState), text: textOf(errorState), hasRetry: Boolean(document.querySelector('[data-testid="error-state-retry"]')) },
      dialog: { present: Boolean(dialog), visible: Boolean(dialog) && getComputedStyle(dialog).display !== "none" && rect(dialog).width > 0, rect: rect(dialog) },
      sheet: {
        present: Boolean(sheet),
        rowCount: sheet ? sheet.querySelectorAll('[data-testid="procurement-warehouse-sheet-row"]').length : 0,
        company: textOf(document.querySelector(".procurement-warehouse-company")),
        title: textOf(document.querySelector(".procurement-warehouse-title")),
        subtitle: textOf(printSubtitle),
      },
      // 纸面表格的几何：数字格 display、一行九格的横向位置、行高（用来发现「格被 display:block 打散」这类版式缺陷）
      sheetTable: (() => {
        if (!sheet) return null;
        const tableEl = sheet.querySelector("table");
        if (!tableEl) return null;
        const cellInfo = (cell) => {
          const box = cell.getBoundingClientRect();
          return { text: (cell.innerText ?? cell.textContent ?? "").trim().slice(0, 20), display: getComputedStyle(cell).display, left: round(box.left), top: round(box.top), width: round(box.width), height: round(box.height) };
        };
        const headerRow = tableEl.querySelector("thead tr");
        const bodyRows = [...tableEl.querySelectorAll("tbody tr")];
        return {
          layout: getComputedStyle(tableEl).tableLayout,
          tableWidth: round(tableEl.getBoundingClientRect().width),
          header: headerRow ? [...headerRow.children].map(cellInfo) : [],
          firstRow: bodyRows[0] ? [...bodyRows[0].children].map(cellInfo) : [],
          secondRow: bodyRows[1] ? [...bodyRows[1].children].map(cellInfo) : [],
          rowHeights: bodyRows.slice(0, 3).map((row) => round(row.getBoundingClientRect().height)),
        };
      })(),
      printCalls: window.__printCalls ?? 0,
      printMedia: {
        sheetVisibility: style(sheet, "visibility"),
        sheetDisplay: style(sheet, "display"),
        sheetPosition: style(sheet, "position"),
        pageHeaderVisibility: style(document.querySelector(".page-header"), "visibility"),
        pageHeaderDisplay: style(document.querySelector(".page-header"), "display"),
        filterPanelVisibility: style(document.querySelector('[data-testid="report-filters"]'), "visibility"),
        panelVisibility: style(document.querySelector('[data-testid="report-scope-notes"]'), "visibility"),
        appShellDisplay: style(document.querySelector(".app-shell"), "display"),
        bodyPage: style(document.body, "page"),
        htmlPage: style(document.documentElement, "page"),
        sheetRect: rect(sheet),
      },
      toastTexts: [...document.querySelectorAll('[data-testid="toast-item"]')].map((element) => (element.innerText ?? element.textContent ?? "").trim()),
      pageTestIdPresent: Boolean(document.querySelector('[data-testid="page-reports-procurement-warehouse"]')),
      reportsEntry: (() => {
        const entryPage = document.querySelector('[data-testid="page-reports"]');
        if (!entryPage) return null;
        return {
          links: [...entryPage.querySelectorAll("a")].map((anchor) => ({ text: (anchor.innerText ?? anchor.textContent ?? "").trim(), href: anchor.getAttribute("href") })),
          buttons: [...entryPage.querySelectorAll("button")].map((button) => (button.innerText ?? button.textContent ?? "").trim()),
        };
      })(),
    };
  });
}

/** 从 Chromium 打出来的 PDF 里读 /MediaBox（A4 横向的唯一硬证据）。 */
function parseMediaBox(buffer) {
  const text = buffer.toString("latin1");
  const boxes = [...text.matchAll(/\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/g)].map((match) => ({
    raw: match[0],
    width: Math.abs(Number(match[3]) - Number(match[1])),
    height: Math.abs(Number(match[4]) - Number(match[2])),
  }));
  const pageCount = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  return { boxes, first: boxes[0] ?? null, pageCount };
}

async function clickAndWaitForRequest(page, fragment, action) {
  const requestPromise = page.waitForRequest((request) => request.url().includes(fragment), { timeout: 60000 });
  await action();
  return requestPromise;
}

async function waitForToast(page, expectedFragment) {
  const toast = page.locator('[data-testid="toast-item"]').filter({ hasText: expectedFragment }).first();
  await toast.waitFor({ state: "visible", timeout: 30000 });
  return (await toast.innerText()).trim();
}

const reportRequests = (requestLog) => requestLog.filter((request) => request.path === REPORT_API_PATH);
const exportRequests = (requestLog) => requestLog.filter((request) => request.path === EXPORT_API_PATH);

// ---------------------------------------------------------------------------
// 页面会话
// ---------------------------------------------------------------------------
async function capture(browser, { name, viewport, dataKind, route, after, screenshot = false, expectedConsoleErrorPatterns = [] }) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    acceptDownloads: true,
    serviceWorkers: "block", // 不走真实 sw.js：它的 fetch 透传会绕过 page.route
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(String(error?.stack ?? error)));
  const requestLog = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/v1/")) requestLog.push({ method: request.method(), url: request.url(), path: url.pathname.replace("/api/v1", ""), search: url.search });
  });
  // window.print 覆盖要在任何页面脚本之前：点「打印 / 另存 PDF」时只记录调用，不真的弹系统打印框。
  await page.addInitScript(() => {
    window.__printCalls = 0;
    window.print = () => { window.__printCalls = (window.__printCalls ?? 0) + 1; };
  });
  await page.route("**/api/v1/**", createMock(dataKind));

  const checksBefore = checks.length;
  const startedAt = Date.now();
  let navigationStatus = null;
  let scenarioError = null;
  let facts = null;
  let reloads = 0;
  try {
    const response = await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 180000 });
    navigationStatus = response ? response.status() : null;
    // 并发会话在同一 checkout 跑 vitest / next build 时，.next 会在 dev server 脚下被改写
    // （实测出现过 routes-manifest ENOENT / 页面白屏且 0 个 /api/v1 请求）；这里只做一次自动 reload。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await page.waitForFunction(() => Boolean(
          document.querySelector('[data-testid="page-reports-procurement-warehouse"]')
          || document.querySelector('[data-testid="page-reports"]')
        ), { timeout: 120000 });
        break;
      } catch (error) {
        if (attempt === 0) { reloads += 1; await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 }); continue; }
        throw error;
      }
    }
    check("页面导航 HTTP 200", navigationStatus === 200, { status: navigationStatus, reloadsDueToDevServerChurn: reloads });
    if (after) facts = await after(page, { requestLog, result: () => null });
    await page.waitForTimeout(250);
    facts = facts ?? await collectFacts(page);
    if (screenshot) await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), animations: "disabled" });
  } catch (error) {
    scenarioError = String(error?.stack ?? error);
    try { facts = await collectFacts(page); } catch { /* 页面已不可用 */ }
  }
  const scenarioChecks = checks.splice(checksBefore);
  if (scenarioError) scenarioChecks.push({ name: "场景执行", ok: false, detail: scenarioError });
  // 故意注入 422/500 的场景，浏览器会把失败的 HTTP 响应当成资源级 console error 打出来（不是页面代码报错），
  // 这类日志单独归类；只有预期之外的 console error 才算失败。
  const unexpectedConsoleErrors = consoleErrors.filter((text) => !expectedConsoleErrorPatterns.some((pattern) => pattern.test(text)));
  scenarioChecks.push({
    name: expectedConsoleErrorPatterns.length ? "无预期之外的 console error（故意注入的失败 HTTP 资源日志不计）" : "console error = 0",
    ok: unexpectedConsoleErrors.length === 0,
    detail: consoleErrors.length ? { unexpected: unexpectedConsoleErrors, all: consoleErrors } : null,
  });
  scenarioChecks.push({ name: "pageerror = 0", ok: pageErrors.length === 0, detail: pageErrors.length ? pageErrors : null });
  const result = {
    name,
    route,
    screenshot: screenshot ? path.join(OUT_DIR, `${name}.png`) : null,
    viewport,
    navigationStatus,
    facts,
    checks: scenarioChecks,
    consoleErrors,
    pageErrors,
    requestLog,
    reloadsDueToDevServerChurn: reloads,
    elapsedMs: Date.now() - startedAt,
  };
  await context.close();
  return result;
}

async function runScenario(browser, spec) {
  try {
    return await capture(browser, spec);
  } catch (error) {
    return {
      name: spec.name,
      route: spec.route,
      screenshot: null,
      viewport: spec.viewport,
      navigationStatus: null,
      facts: null,
      checks: [{ name: "场景运行", ok: false, detail: String(error?.stack ?? error) }],
      consoleErrors: [],
      pageErrors: [],
      requestLog: [],
      elapsedMs: 0,
    };
  }
}

// ---------------------------------------------------------------------------
async function run() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(path.dirname(RESULTS_JSON), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const results = [];
  const mediaBox = {};
  try {
    // =====================================================================
    // 场景 1：桌面 1440x900 —— 首屏、九列、数字格式、布局、查询、导出、打印、打印媒体
    // =====================================================================
    {
      const result = await runScenario(browser, {
        name: "desktop-detail",
        route: REPORT_PAGE_PATH,
        viewport: DESKTOP,
        dataKind: "normal",
        after: async (page, { requestLog }) => {
          await page.locator('[data-testid="page-reports-procurement-warehouse"]').waitFor({ state: "visible", timeout: 180000 });
          await page.locator('[data-testid="data-table-row"]').first().waitFor({ state: "visible", timeout: 60000 });
          const initialRequests = requestLog.slice();
          const initialFacts = await collectFacts(page);

          // ---- 断言 1：首屏取数路径恰为 /api/v1/reports/procurement-warehouse（无查询串）
          const firstScreenData = reportRequests(initialRequests);
          check("首屏取数请求路径恰为 /api/v1/reports/procurement-warehouse（无查询串）", firstScreenData.length >= 1 && firstScreenData.every((request) => request.path === REPORT_API_PATH && request.search === ""), firstScreenData.map((request) => request.url));
          check("首屏页面 testid 可见（page-reports-procurement-warehouse）", initialFacts.pageTestIdPresent, initialFacts.pageTestIdPresent);

          // ---- 断言 2：九列表头 + 11 行逐行核对
          const table = initialFacts.table;
          check("表头九列文字与顺序正确", JSON.stringify(table.headers) === JSON.stringify(HEADERS), table.headers);
          check("表格 11 行", table.rowCount === 11, { rowCount: table.rowCount, rowLengths: table.rowLengths });
          check("每行都是 9 个单元格", table.rowLengths.length === 11 && table.rowLengths.every((length) => length === 9), table.rowLengths);
          const rowMismatch = ROWS.map((row, index) => ({ row: index + 1, expected: displayRow(row), actual: table.rows[index] }))
            .filter((item) => JSON.stringify(item.expected) !== JSON.stringify(item.actual));
          check("11 行逐行九列与 mock（截图原表）完全一致", rowMismatch.length === 0 && table.rows.length === 11, rowMismatch);
          for (const rowNumber of [1, 3, 7, 11]) {
            check(`第 ${rowNumber} 行全列取值正确`, JSON.stringify(table.rows[rowNumber - 1]) === JSON.stringify(displayRow(ROWS[rowNumber - 1])), { row: rowNumber, expected: displayRow(ROWS[rowNumber - 1]), actual: table.rows[rowNumber - 1] });
          }
          check("行数文案「共 11 行」", initialFacts.rowCountText.includes("共 11 行"), initialFacts.rowCountText);

          // ---- 断言 3：数字格式（无尾零 / 负值标红 / 非负不标红）
          check("表格里没有 4700.0000 这种尾零数字", initialFacts.numeric.trailingZeroTexts.length === 0, { trailingZeroTexts: initialFacts.numeric.trailingZeroTexts, firstNumericTexts: initialFacts.numeric.texts.slice(0, 12) });
          const row1 = table.rows[0];
          check("第 1 行库存量显示 1650（无 .0000）", row1[8] === "1650" && !row1[8].includes("."), row1);
          const row3 = table.rows[2];
          check("第 3 行库存量显示 -545", row3[8] === "-545", { stock: row3[8] });
          check("第 3 行库存量带 status-error（红）", table.rowsWithStatusError[2][8] === true, { row3StatusError: table.rowsWithStatusError[2], statusErrorCells: initialFacts.numeric.statusErrorCells });
          check("第 2 行「采购未入库数 70」不是红", table.rows[1][6] === "70" && table.rowsWithStatusError[1][6] === false, { value: table.rows[1][6], statusError: table.rowsWithStatusError[1][6] });
          check("第 11 行「采购未入库数 4700」正常（非红）", table.rows[10][6] === "4700" && table.rowsWithStatusError[10][6] === false, { value: table.rows[10][6], statusError: table.rowsWithStatusError[10][6] });
          check("status-error 的 computed color 与普通数字不同（确实是红色）", initialFacts.numeric.statusErrorCells.length > 0 && initialFacts.numeric.statusErrorCells[0].color !== initialFacts.numeric.normalNumberColor, { redColor: initialFacts.numeric.statusErrorCells[0]?.color ?? null, normalNumberColor: initialFacts.numeric.normalNumberColor });

          // ---- 断言 4：1440x900 布局
          check("1440x900 页面无横向溢出（scrollWidth - innerWidth ≤ 1）", initialFacts.document.horizontalOverflow <= 1, { scrollWidth: initialFacts.document.scrollWidth, innerWidth: initialFacts.document.innerWidth, diff: initialFacts.document.horizontalOverflow });
          check("九列都有实际宽度（无列被压成 0 宽）", table.headerRects.length === 9 && table.headerRects.every((rect) => rect && rect.width > 0), table.headerRects.map((rect) => rect?.width));
          check("九列都在视口内（left ≥ 0 且 right ≤ 1440）", table.headerRects.every((rect) => rect.left >= 0 && rect.right <= initialFacts.viewport.width + 0.5), table.headerRects.map((rect) => ({ left: rect?.left, right: rect?.right })));
          check("口径说明三条规则都在页面上", ["不跨单位相加", "不按订单拆账", "不设合计行"].every((rule) => initialFacts.scopeNotesText.includes(rule)), initialFacts.scopeNotesText.slice(0, 240));

          // ---- 截图：桌面明细
          await page.screenshot({ path: path.join(OUT_DIR, "desktop-detail.png"), animations: "disabled" });

          // ---- 断言 5：查询 / 重置的请求 URL
          await page.locator('[data-testid="filter-order-no"]').fill("260119");
          await page.locator('[data-testid="filter-material"]').fill("伞");
          const filteredRequest = await clickAndWaitForRequest(page, REPORT_API_PATH, () => page.locator('[data-testid="report-search"]').click());
          check("点「查询」请求 URL 带 order_no=260119&material=伞（等价编码）", new URL(filteredRequest.url()).search === FILTERED_QUERY, filteredRequest.url());
          await page.waitForTimeout(400);
          check("查询后表格仍 11 行", (await page.locator('[data-testid="data-table-row"]').count()) === 11, await page.locator('[data-testid="data-table-row"]').count());

          // ---- 断言 8：导出（成功路径）
          const exportRequest = await clickAndWaitForRequest(page, EXPORT_API_PATH, () => page.locator('[data-testid="report-export"]').click());
          check("导出请求 URL 是 export.xlsx 且带当前已应用筛选参数", new URL(exportRequest.url()).pathname === `/api/v1${EXPORT_API_PATH}` && new URL(exportRequest.url()).search === FILTERED_QUERY, exportRequest.url());
          const exportToast = await waitForToast(page, "已导出");
          check("导出成功出现 toast「已导出 11 行采购与仓储报表」", exportToast.includes("已导出 11 行采购与仓储报表"), exportToast);

          // ---- 断言 6：打印弹窗
          const reportRequestsBeforePrint = reportRequests(requestLog).length;
          await page.locator('[data-testid="report-print"]').click();
          await page.locator('[data-testid="report-print-dialog"]').waitFor({ state: "visible", timeout: 30000 });
          await page.waitForTimeout(300);
          const printFacts = await collectFacts(page);
          check("点「打印」弹窗出现（report-print-dialog visible）", printFacts.dialog.present && printFacts.dialog.visible, printFacts.dialog);
          check("纸面有公司名", printFacts.sheet.company.includes("厦门迪礼伞业有限公司"), printFacts.sheet.company);
          check("纸面有标题「采购与仓储报表」", printFacts.sheet.title.includes("采购与仓储报表"), printFacts.sheet.title);
          check("纸面表格 11 行", printFacts.sheet.rowCount === 11, printFacts.sheet.rowCount);
          check("副标题含「订单号：260119」", printFacts.sheet.subtitle.includes("订单号：260119"), printFacts.sheet.subtitle);
          check("副标题含「行数：11 行」", printFacts.sheet.subtitle.includes("行数：11 行"), printFacts.sheet.subtitle);
          check("副标题含「打印时间」", printFacts.sheet.subtitle.includes("打印时间："), printFacts.sheet.subtitle);
          // 纸面表格几何：九列必须真的排成九列（不是被 display:block 打散成竖排）
          const sheetTable = printFacts.sheetTable;
          check("纸面表格 table-layout = fixed", sheetTable?.layout === "fixed", sheetTable?.layout ?? null);
          check("纸面数据行的 9 个 td 都是 table-cell（不是 block）", sheetTable !== null && sheetTable.firstRow.length === 9 && sheetTable.firstRow.every((cell) => cell.display === "table-cell"), sheetTable ? sheetTable.firstRow.map((cell) => ({ text: cell.text, display: cell.display, left: cell.left, width: cell.width })) : null);
          check("纸面一行 9 格在同一行（left 严格递增、纵向有重叠）", (() => {
            if (!sheetTable || sheetTable.firstRow.length !== 9) return false;
            const cells = sheetTable.firstRow;
            const leftsIncrease = cells.every((cell, index) => index === 0 || cell.left > cells[index - 1].left);
            const sameLine = cells.every((cell) => Math.abs(cell.top - cells[0].top) < 2);
            return leftsIncrease && sameLine;
          })(), sheetTable ? { firstRow: sheetTable.firstRow, rowHeights: sheetTable.rowHeights } : null);
          check("纸面数据行行高合理（≤ 80px；11 行应能在一张 A4 横向内）", sheetTable !== null && sheetTable.rowHeights.every((height) => height <= 80), sheetTable?.rowHeights ?? null);
          await page.screenshot({ path: path.join(OUT_DIR, "print-dialog.png"), animations: "disabled" });

          await page.locator('[data-testid="report-print-confirm"]').click();
          await page.waitForTimeout(300);
          const afterConfirm = await collectFacts(page);
          check("点「打印 / 另存 PDF」时 window.print 被调用（覆盖计数 = 1）", afterConfirm.printCalls === 1, { printCalls: afterConfirm.printCalls });
          check("打印弹窗不会额外请求取数接口（纸面数据 = 屏幕数据）", reportRequests(requestLog).length === reportRequestsBeforePrint, { before: reportRequestsBeforePrint, after: reportRequests(requestLog).length });

          // ---- 断言 7：打印媒体（只留纸面）+ page.pdf() 的 MediaBox
          await page.emulateMedia({ media: "print" });
          await page.waitForTimeout(400);
          const printMode = await collectFacts(page);
          check("emulateMedia(print) 后 .procurement-warehouse-sheet visibility = visible", printMode.printMedia.sheetVisibility === "visible", printMode.printMedia);
          check("emulateMedia(print) 后 .page-header visibility = hidden", printMode.printMedia.pageHeaderVisibility === "hidden", printMode.printMedia);
          check("emulateMedia(print) 后筛选面板 visibility = hidden", printMode.printMedia.filterPanelVisibility === "hidden", printMode.printMedia);
          check("emulateMedia(print) 后口径说明面板 visibility = hidden（页面上只留纸面）", printMode.printMedia.panelVisibility === "hidden", printMode.printMedia);
          check("emulateMedia(print) 后 .app-shell display = none（不留布局，避免空白页）", printMode.printMedia.appShellDisplay === "none", printMode.printMedia);
          check("打印媒体下命名页挂到了 body/html（body page = procurement-warehouse）", printMode.printMedia.bodyPage === "procurement-warehouse" && printMode.printMedia.htmlPage === "procurement-warehouse", { bodyPage: printMode.printMedia.bodyPage, htmlPage: printMode.printMedia.htmlPage });
          check("打印媒体下纸面 position = static（走文档流，命名页才生效）", printMode.printMedia.sheetPosition === "static", printMode.printMedia.sheetPosition);
          check("打印媒体下纸面 display 不是 none 且有实际宽度", printMode.printMedia.sheetDisplay !== "none" && printMode.printMedia.sheetRect.width > 0, printMode.printMedia);
          await page.screenshot({ path: path.join(OUT_DIR, "print-media.png"), animations: "disabled" });

          // page.pdf()：preferCSSPageSize 让 CSS @page（命名页 A4 landscape）生效
          const pdfBuffer = await page.pdf({ path: PRINT_PDF, preferCSSPageSize: true, printBackground: true });
          const parsed = parseMediaBox(pdfBuffer);
          mediaBox.parsed = parsed;
          mediaBox.bytes = pdfBuffer.length;
          mediaBox.options = { preferCSSPageSize: true, printBackground: true };
          check("打印 PDF 恰好 1 页（11 行 + 口径说明在 A4 横向上放得下）", parsed.pageCount === 1, { pageCount: parsed.pageCount, bytes: pdfBuffer.length });
          check("PDF /MediaBox 宽 > 高（A4 横向，不是竖向）", parsed.first !== null && parsed.first.width > parsed.first.height, parsed.first);
          check("PDF /MediaBox ≈ 842 x 595 pt（A4 横向，允许 ±3pt）", parsed.first !== null && Math.abs(parsed.first.width - 842) <= 3 && Math.abs(parsed.first.height - 595) <= 3, parsed.first ? { width: parsed.first.width, height: parsed.first.height, raw: parsed.first.raw, allBoxes: parsed.boxes } : null);

          // 回到屏幕媒体、关掉弹窗，再点「重置」→ 请求无查询串
          await page.emulateMedia({ media: "screen" });
          await page.keyboard.press("Escape");
          await page.waitForTimeout(400);
          const resetRequest = await clickAndWaitForRequest(page, REPORT_API_PATH, () => page.locator('[data-testid="report-reset"]').click());
          check("点「重置」请求无查询串（search 为空）", new URL(resetRequest.url()).search === "", resetRequest.url());
          return await collectFacts(page);
        },
      });
      result.screenshot = path.join(OUT_DIR, "desktop-detail.png");
      results.push(result);
    }

    // =====================================================================
    // 场景 2：错误态（422 后端原文 + 重试）
    // =====================================================================
    {
      const result = await runScenario(browser, {
        name: "error",
        route: REPORT_PAGE_PATH,
        viewport: DESKTOP,
        dataKind: "error",
        expectedConsoleErrorPatterns: [/Failed to load resource: the server responded with a status of 422/],
        after: async (page, { requestLog }) => {
          await page.locator('[data-testid="error-state"]').waitFor({ state: "visible", timeout: 180000 });
          const facts = await collectFacts(page);
          check("422 时页面展示后端原文（含「5000」字样）", facts.error.text.includes("报表行数超过 5000 行，请按订单号或物料缩小范围"), facts.error.text);
          check("422 时页面仍存活（页面 testid 可见，未整片崩掉）", facts.pageTestIdPresent, facts.pageTestIdPresent);
          check("错误态提供重试按钮", facts.error.hasRetry, facts.error.hasRetry);
          await page.screenshot({ path: path.join(OUT_DIR, "error.png"), animations: "disabled" });
          const before = reportRequests(requestLog).length;
          await page.locator('[data-testid="error-state-retry"]').click();
          await page.waitForTimeout(900);
          check("点「重新加载」会重新请求取数接口（初始 + 重试 = 2 次）", reportRequests(requestLog).length === before + 1, { before, after: reportRequests(requestLog).length, urls: reportRequests(requestLog).map((request) => request.url) });
          return facts;
        },
      });
      result.screenshot = path.join(OUT_DIR, "error.png");
      results.push(result);
    }

    // =====================================================================
    // 场景 3：导出失败（500 → 失败 toast，页面不崩）
    // =====================================================================
    {
      const result = await runScenario(browser, {
        name: "desktop-export-failure",
        route: REPORT_PAGE_PATH,
        viewport: DESKTOP,
        dataKind: "export-failure",
        expectedConsoleErrorPatterns: [/Failed to load resource: the server responded with a status of 500/],
        after: async (page) => {
          await page.locator('[data-testid="data-table-row"]').first().waitFor({ state: "visible", timeout: 180000 });
          await page.locator('[data-testid="report-export"]').click();
          const toastText = await waitForToast(page, "导出失败");
          check("导出接口 500 时出现失败 toast（含后端 message）", toastText.includes("导出失败：测试注入的 500"), toastText);
          const facts = await collectFacts(page);
          check("导出失败后页面不崩（表格仍 11 行、页面 testid 仍在）", facts.table.rowCount === 11 && facts.pageTestIdPresent, { rows: facts.table.rowCount, pagePresent: facts.pageTestIdPresent });
          return facts;
        },
      });
      results.push(result);
    }

    // =====================================================================
    // 场景 4：空态
    // =====================================================================
    {
      const result = await runScenario(browser, {
        name: "empty",
        route: REPORT_PAGE_PATH,
        viewport: DESKTOP,
        dataKind: "empty",
        after: async (page, { requestLog }) => {
          await page.locator('[data-testid="empty-state"]').waitFor({ state: "visible", timeout: 180000 });
          const facts = await collectFacts(page);
          check("空数据：表格空态文案「当前筛选条件下没有数据」", facts.empty.text.includes("当前筛选条件下没有数据"), facts.empty.text);
          check("空数据：行数文案「共 0 行」", facts.rowCountText.includes("共 0 行"), facts.rowCountText);
          await page.screenshot({ path: path.join(OUT_DIR, "empty.png"), animations: "disabled" });
          const exportBefore = exportRequests(requestLog).length;
          const reportsBefore = reportRequests(requestLog).length;
          await page.locator('[data-testid="report-print"]').click();
          await page.waitForTimeout(400);
          const afterPrintClick = await collectFacts(page);
          check("空数据点「打印」不弹窗（无 report-print-dialog）", !afterPrintClick.dialog.present, afterPrintClick.dialog);
          const printToast = await waitForToast(page, "没有可打印的数据");
          check("空数据点「打印」提示「当前筛选条件下没有可打印的数据」", printToast.includes("当前筛选条件下没有可打印的数据"), printToast);
          await page.locator('[data-testid="report-export"]').click();
          await page.waitForTimeout(900);
          check("空数据点「导出」不发 export 请求", exportRequests(requestLog).length === exportBefore, { before: exportBefore, after: exportRequests(requestLog).length });
          const exportToast = await waitForToast(page, "没有可导出的数据");
          check("空数据点「导出」提示「当前筛选条件下没有可导出的数据」", exportToast.includes("当前筛选条件下没有可导出的数据"), exportToast);
          check("空态不额外请求取数接口（打印/导出都不重新拉数据）", reportRequests(requestLog).length === reportsBefore, { before: reportsBefore, after: reportRequests(requestLog).length });
          return facts;
        },
      });
      result.screenshot = path.join(OUT_DIR, "empty.png");
      results.push(result);
    }

    // =====================================================================
    // 场景 5：窄屏 390x844
    // =====================================================================
    {
      const result = await runScenario(browser, {
        name: "mobile",
        route: REPORT_PAGE_PATH,
        viewport: MOBILE,
        dataKind: "normal",
        after: async (page) => {
          await page.locator('[data-testid="data-table-row"]').first().waitFor({ state: "visible", timeout: 180000 });
          const facts = await collectFacts(page);
          check("390x844 页面无横向溢出（scrollWidth - innerWidth ≤ 1）", facts.document.horizontalOverflow <= 1, { scrollWidth: facts.document.scrollWidth, innerWidth: facts.document.innerWidth, bodyScrollWidth: facts.document.bodyScrollWidth, diff: facts.document.horizontalOverflow });
          check("390x844 表格 11 行也在（数据未被裁掉）", facts.table.rowCount === 11, facts.table.rowCount);
          check("390x844 表格有宽度（容器不为 0；宽表靠容器内横滑或省略，不撑破页面）", facts.table.tableWrap !== null && facts.table.tableWrap.clientWidth > 0, facts.table.tableWrap);
          await page.screenshot({ path: path.join(OUT_DIR, "mobile.png"), animations: "disabled" });
          return facts;
        },
      });
      result.screenshot = path.join(OUT_DIR, "mobile.png");
      results.push(result);
    }

    // =====================================================================
    // 场景 6：入口 —— /reports 页头的「采购与仓储报表」按钮可点进
    // =====================================================================
    {
      const result = await runScenario(browser, {
        name: "reports-entry",
        route: "/reports",
        viewport: DESKTOP,
        dataKind: "normal",
        after: async (page, { requestLog }) => {
          await page.locator('[data-testid="page-reports"]').waitFor({ state: "visible", timeout: 180000 });
          await page.waitForTimeout(600);
          const before = await collectFacts(page);
          const entry = before.reportsEntry;
          const link = entry?.links?.find((candidate) => candidate.text === "采购与仓储报表") ?? null;
          check("/reports 页头有「采购与仓储报表」入口（链接文案与 href 正确）", link !== null && link.href === "/reports/procurement-warehouse", entry);
          await page.locator('a[href="/reports/procurement-warehouse"]').first().click();
          await page.waitForURL(`**${REPORT_PAGE_PATH}`, { timeout: 60000 });
          await page.locator('[data-testid="page-reports-procurement-warehouse"]').waitFor({ state: "visible", timeout: 60000 });
          await page.waitForTimeout(800);
          const facts = await collectFacts(page);
          check("点入口后 URL 到 /reports/procurement-warehouse 且页面渲染", new URL(page.url()).pathname === REPORT_PAGE_PATH && facts.pageTestIdPresent, { url: page.url(), pagePresent: facts.pageTestIdPresent });
          const dataRequests = reportRequests(requestLog);
          check("进入报表页后取数请求无查询串（路径恰为 /api/v1/reports/procurement-warehouse）", dataRequests.length >= 1 && dataRequests.every((request) => request.path === REPORT_API_PATH && request.search === ""), dataRequests.map((request) => request.url));
          return facts;
        },
      });
      results.push(result);
    }
  } finally {
    await browser.close();
  }

  const allChecks = results.flatMap((result) => result.checks);
  const failed = allChecks.filter((item) => !item.ok);
  const payload = {
    base: BASE,
    generatedAt: new Date().toISOString(),
    script: path.relative(REPO_ROOT, import.meta.filename),
    mediaBox,
    summary: {
      scenarios: results.length,
      checks: allChecks.length,
      passed: allChecks.length - failed.length,
      failed: failed.length,
      consoleErrors: results.reduce((total, result) => total + result.consoleErrors.length, 0),
      pageErrors: results.reduce((total, result) => total + result.pageErrors.length, 0),
      // 故意注入 422/500 的两个场景会被浏览器记为资源级 console error（不是页面代码报错），单独计数。
      consoleErrorsInErrorInjectionScenarios: results
        .filter((result) => ["error", "desktop-export-failure"].includes(result.name))
        .reduce((total, result) => total + result.consoleErrors.length, 0),
    },
    results,
  };
  await writeFile(RESULTS_JSON, JSON.stringify(payload, null, 2), "utf8");

  for (const result of results) {
    const failedHere = result.checks.filter((item) => !item.ok).length;
    console.log(`\n=== ${result.name} (${result.viewport.width}x${result.viewport.height}) → ${result.screenshot ?? "(no screenshot)"}`);
    console.log(`    导航 HTTP ${result.navigationStatus}；断言 ${result.checks.length - failedHere}/${result.checks.length}；console error ${result.consoleErrors.length}；pageerror ${result.pageErrors.length}`);
    for (const item of result.checks) {
      console.log(`    ${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail === null ? "" : `  ${JSON.stringify(item.detail).slice(0, 700)}`}`);
    }
  }
  console.log(`\n=== 合计：${payload.summary.passed}/${payload.summary.checks} 条断言通过；console error ${payload.summary.consoleErrors}；pageerror ${payload.summary.pageErrors}`);
  console.log(`=== MediaBox：${mediaBox.parsed?.first ? `${mediaBox.parsed.first.width} x ${mediaBox.parsed.first.height} pt（${mediaBox.parsed.first.raw}）` : "未取到"}`);
  console.log(`=== 结果 JSON：${RESULTS_JSON}`);
  console.log(`=== 打印 PDF：${PRINT_PDF}`);
  if (failed.length) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

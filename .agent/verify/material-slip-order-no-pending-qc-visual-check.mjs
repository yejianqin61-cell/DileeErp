/**
 * C. 真实 Chromium 视觉/交互验证（2026-11-07）：
 *   1) /qc/finished-goods「待质检（全部订单）」：跨订单行集、状态中文、已检/待检、排序、「共 N 张」、
 *      行内「录入质检」预选该送检批次、双击行按 order_no 拉三张明细、空态；
 *   2) /production/material-issues 打印件：领料单/补料单纸头出现「订单号：」且位置顺序正确。
 *
 * 约束：不改仓库源码、不连数据库。真实 Chromium + `page.route` 统一 mock `/api/v1/**`。
 * 运行：
 *   1) npm run dev --workspace=@dilee/web -- -p 3111
 *   2) node .agent\verify\material-slip-order-no-pending-qc-visual-check.mjs
 * 产物：
 *   docs/test/results/material-slip-order-no-pending-qc/{pending-list,pending-empty,qc-dialog-preselected,print-issue,print-replenishment}.png
 *   docs/test/results/material-slip-order-no-pending-qc/summary.json
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_DIR = path.join(REPO_ROOT, "docs", "test", "results", "material-slip-order-no-pending-qc");
const SUMMARY_JSON = path.join(OUT_DIR, "summary.json");
const BASE = process.env.VERIFY_BASE_URL ?? "http://127.0.0.1:3111";
const DESKTOP = { width: 1440, height: 900 };

const PROFILE = {
  display_name: "张三",
  username: "zhangsan",
  role_keys: ["laoban"],
  surface_roles: ["laoban"],
  surface_scope: "full",
  surface_sections: ["dashboard", "production", "procurement", "qc", "warehouse", "sales", "reorder", "customers", "reports", "finance", "hr", "account", "business-query"],
  module_keys: ["sales", "procurement", "production", "warehouse", "finance", "hr"],
};

// ---------------------------------------------------------------------------
// 成品质检数据：跨订单 6 张送检单（2 submitted / 1 inspecting / draft / qc_completed / cancelled）
// ---------------------------------------------------------------------------
const submission = ({ id, submissionNo, orderNo, status, submissionDate, submittedQuantity, inspectedQuantity, pendingQuantity, sourceType = "finished_goods_inbound_notice", unitNameSnapshot = "把", productionOrderNoSnapshot, productNameSnapshot = "自动雨伞", productSpecificationSnapshot = "22寸×8K" }) => ({
  id,
  submissionNo,
  orderNo,
  productionOrderId: `po-${orderNo}`,
  productionOrderNoSnapshot: productionOrderNoSnapshot ?? `MO-${orderNo}`,
  sourceType,
  sourceId: `src-${id}`,
  submittedQuantity,
  inspectedQuantity,
  pendingQuantity,
  submissionDate: `${submissionDate}T00:00:00.000Z`,
  remark: null,
  version: 1,
  status,
  unitId: "u-1",
  unitNameSnapshot,
  productNameSnapshot,
  productSpecificationSnapshot,
  qcRecords: status === "inspecting" ? [{ id: "qc-1", status: "active", inspectedQuantity: inspectedQuantity }] : [],
  created_by_name: "张三",
  updated_by_name: "李四",
  createdAt: `${submissionDate}T01:00:00.000Z`,
  updatedAt: `${submissionDate}T02:00:00.000Z`,
});

const SUBMISSIONS = [
  // 同一天两张：送检单号 0001 在 0003 前
  submission({ id: "sub-1", submissionNo: "FGIS-20261101-0001", orderNo: "SO-1001", status: "submitted", submissionDate: "2026-11-01", submittedQuantity: "100", inspectedQuantity: "0", pendingQuantity: "100" }),
  submission({ id: "sub-2", submissionNo: "FGIS-20261101-0003", orderNo: "SO-3003", status: "submitted", submissionDate: "2026-11-01", submittedQuantity: "50", inspectedQuantity: "0", pendingQuantity: "50", sourceType: "outsource_finished_goods_return" }),
  submission({ id: "sub-3", submissionNo: "FGIS-20261102-0002", orderNo: "SO-2002", status: "inspecting", submissionDate: "2026-11-02", submittedQuantity: "200", inspectedQuantity: "80", pendingQuantity: "120" }),
  submission({ id: "sub-4", submissionNo: "FGIS-20261103-0004", orderNo: "SO-4004", status: "draft", submissionDate: "2026-11-03", submittedQuantity: "10", inspectedQuantity: "0", pendingQuantity: "10" }),
  submission({ id: "sub-5", submissionNo: "FGIS-20261030-0005", orderNo: "SO-5005", status: "qc_completed", submissionDate: "2026-10-30", submittedQuantity: "10", inspectedQuantity: "10", pendingQuantity: "0" }),
  submission({ id: "sub-6", submissionNo: "FGIS-20261104-0006", orderNo: "SO-6006", status: "cancelled", submissionDate: "2026-11-04", submittedQuantity: "10", inspectedQuantity: "0", pendingQuantity: "10" }),
];

const SOURCES = [{
  source_type: "finished_goods_inbound_notice", source_id: "src-1", notice_id: "notice-1", notice_no: "FGI-20261101-01", batch_no: "B1",
  order_no: "SO-1001", production_order_id: "po-SO-1001", production_order_no: "MO-SO-1001",
  product_name: "自动雨伞", product_specification: "22寸×8K", unit_id: "u-1", unit: "把", available_quantity: "100",
  source_status: "acknowledged", packaging_operation_name: "包装", created_by_name: "张三", updated_by_name: "李四",
  createdAt: "2026-11-01T01:00:00.000Z", updatedAt: "2026-11-01T02:00:00.000Z",
}];

// ---------------------------------------------------------------------------
// 打印件数据：领料单 + 补料单（走 /production/material-movements/:id/slip-document）
// ---------------------------------------------------------------------------
const ISSUE_MOVEMENT = {
  id: "issue-1", movementNo: "MI-20261107-AAAA1111", documentType: "issue", status: "posted", orderNo: "SO-1001",
  productionOrderId: "po-SO-1001", productionOrder: { productionOrderNo: "MO-20261107-0001", orderNo: "SO-1001" },
  createdAt: "2026-11-07T02:30:00.000Z", remark: "第一批领料，裁剪工序", reason: null,
  lines: [{ id: "ml-1", materialId: "m1", quantity: "1200", material: { name: "伞骨", materialCode: "M-001", specificationModel: "58cm" }, unit: { name: "根" } }],
  created_by_name: "张三", updated_by_name: "李四",
};
const REPLENISHMENT_MOVEMENT = {
  id: "replenishment-1", movementNo: "MC-20261107-BBBB2222", documentType: "replenishment", status: "posted", orderNo: "SO-2002",
  productionOrderId: "po-SO-2002", productionOrder: { productionOrderNo: "MO-20261107-0001", orderNo: "SO-2002" },
  createdAt: "2026-11-07T03:10:00.000Z", reason: "伞布原始坏片 12 米", remark: null,
  lines: [{ id: "ml-2", materialId: "m2", quantity: "12", material: { name: "伞布", materialCode: "M-002", specificationModel: "EVA" }, unit: { name: "米" } }],
  created_by_name: "张三", updated_by_name: "李四",
};
const ISSUE_SLIP_DOCUMENT = {
  document_type: "issue",
  document: {
    movementNo: "MI-20261107-AAAA1111", status: "posted", productionOrderNo: "MO-20261107-0001", orderNo: "SO-1001",
    productName: "自动雨伞", productCode: "", productSpecification: "22寸×8K", productColor: "", operationName: "裁剪", issueUnit: "一车间",
    plannedQuantity: 500, unitName: "把", operatorName: "张三", operatedAt: "2026-11-07 10:30", remark: "第一批领料，裁剪工序", reason: "",
    lines: [{ sequence: 1, materialName: "伞骨", materialCode: "M-001", specificationModel: "58cm", color: "黑色", unit: "根", bomQuantity: 2500, issuedQuantity: 300, currentQuantity: 1200, remainingQuantity: 1000, remark: null }],
  },
};
const REPLENISHMENT_SLIP_DOCUMENT = {
  document_type: "replenishment",
  document: {
    movementNo: "MC-20261107-BBBB2222", status: "posted", productionOrderNo: "MO-20261107-0001", orderNo: "SO-2002",
    productName: "自动雨伞", productCode: "", productSpecification: "22寸×8K", productColor: "", operationName: "", issueUnit: "一车间",
    plannedQuantity: 500, unitName: "把", operatorName: "张三", operatedAt: "2026-11-07 11:10", reason: "伞布原始坏片 12 米", remark: "",
    lines: [{ sequence: 1, imageUrl: "", materialName: "伞布", materialCode: "M-002", specificationModel: "EVA", color: "透明", unit: "米", replenishQuantity: 12, remark: null }],
  },
};

const EXPECTED_PENDING_HEADERS = ["送检单", "订单号", "生产单", "成品", "来源", "送检数量", "已检数量", "待检数量", "状态", "操作"];
const EXPECTED_ISSUE_PRINT_HEAD_ROW3 = [["生产数量：", "500 把"], ["操作人：", "张三"], ["操作时间：", "2026-11-07 10:30"], ["订单号：", "SO-1001"]];
const EXPECTED_REPLENISHMENT_PRINT_HEAD_ROW3 = [["操作人：", "张三"], ["操作时间：", "2026-11-07 11:10"], ["订单号：", "SO-2002"], ["补料原因：", "伞布原始坏片 12 米"]];

// ---------------------------------------------------------------------------
function createMock(dataKind) {
  return async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const requestPath = url.pathname.replace(/^\/api\/v1/, "");
    const method = request.method();
    const envelope = (data, meta = {}) => route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify({ data, meta }) });
    const notFound = (code, message) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code, message, details: [] }, meta: {} }) });

    if (requestPath === "/auth/me" && method === "GET") return envelope(PROFILE);

    // ---- 成品质检 ----
    if (requestPath === "/finished-goods/qc/sources" && method === "GET") {
      const orderNo = url.searchParams.get("order_no");
      return envelope(orderNo ? SOURCES.filter((source) => source.order_no === orderNo) : SOURCES);
    }
    if (requestPath === "/finished-goods/inspection-submissions" && method === "GET") {
      const orderNo = url.searchParams.get("order_no");
      if (dataKind === "qc-sentinel") {
        const sentinel = [submission({ id: "sub-sentinel", submissionNo: "FGIS-20261107-9999", orderNo: "SO-7007", status: "submitted", submissionDate: "2026-11-07", submittedQuantity: "200", inspectedQuantity: "66", pendingQuantity: "42" })];
        return envelope(orderNo ? sentinel.filter((row) => row.orderNo === orderNo) : sentinel);
      }
      if (dataKind === "qc-empty") return envelope(orderNo ? [] : SUBMISSIONS.filter((row) => ["draft", "qc_completed", "cancelled"].includes(row.status)));
      return envelope(orderNo ? SUBMISSIONS.filter((row) => row.orderNo === orderNo) : SUBMISSIONS);
    }
    if (requestPath === "/finished-goods/qc-records/available-inbound-sources" && method === "GET") {
      const orderNo = url.searchParams.get("order_no");
      if (orderNo !== "SO-1001") return envelope([]);
      return envelope([{
        qc_id: "qc-9", qc_no: "FQC-20261107-0001", submission_id: "sub-1", order_no: "SO-1001", production_order_id: "po-SO-1001",
        source_type: "finished_goods_inbound_notice", source_id: "src-1", unit_id: "u-1", unit: "把",
        qualified_quantity: "100", conditional_accept_quantity: "0", rejected_quantity: "0", available_for_inbound_quantity: "100",
        available_for_defective_quantity: "0", conditionally_accepted: false, source_read_only: true,
      }]);
    }

    // ---- 领料单 / 补料单 ----
    if (requestPath === "/production/material-movements" && method === "GET") return envelope([ISSUE_MOVEMENT, REPLENISHMENT_MOVEMENT]);
    if (requestPath === "/production/orders" && method === "GET") return envelope([{ id: "po-SO-1001", productionOrderNo: "MO-20261107-0001", orderNo: "SO-1001" }]);
    const slipMatch = requestPath.match(/^\/production\/material-movements\/([^/]+)\/slip-document$/);
    if (slipMatch && method === "GET") {
      const id = decodeURIComponent(slipMatch[1]);
      if (id === "issue-1") return envelope(ISSUE_SLIP_DOCUMENT);
      if (id === "replenishment-1") return envelope(REPLENISHMENT_SLIP_DOCUMENT);
      return notFound("MATERIAL_SLIP_NOT_FOUND", "单据不存在");
    }

    return notFound("NOT_MOCKED", `未 mock 的请求：${method} ${requestPath}`);
  };
}

// ---------------------------------------------------------------------------
const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail: detail ?? null });
  return Boolean(condition);
}
const textOf = async (locator) => ((await locator.innerText()) ?? "").trim();

/** 从页面取「待质检」块的全量事实。 */
async function collectPendingFacts(page) {
  return page.evaluate(() => {
    const block = document.querySelector('[data-testid="finished-goods-qc-pending"]');
    const table = block?.querySelector('[data-testid="data-table"]');
    const rows = block ? [...block.querySelectorAll('[data-testid="data-table-row"]')] : [];
    const headers = block ? [...block.querySelectorAll("th")].map((th) => {
      const box = th.getBoundingClientRect();
      return {
        text: (th.innerText ?? th.textContent ?? "").trim(),
        styleWidth: th.getAttribute("style") ?? "",
        width: Math.round(box.width * 10) / 10,
        clientWidth: th.clientWidth,
        scrollWidth: th.scrollWidth,
        truncated: th.scrollWidth > th.clientWidth + 1,
        title: th.getAttribute("title"),
      };
    }) : [];
    const cellsOf = (row) => [...row.querySelectorAll("td")].map((cell) => ({
      text: (cell.innerText ?? cell.textContent ?? "").trim(),
      button: cell.querySelector("button") ? (cell.querySelector("button").innerText ?? "").trim() : null,
    }));
    return {
      blockPresent: Boolean(block),
      blockText: block ? (block.innerText ?? "").trim() : "",
      tablePresent: Boolean(table),
      tableWidth: table ? Math.round(table.getBoundingClientRect().width * 10) / 10 : null,
      headers,
      rows: rows.map(cellsOf),
      rowCount: rows.length,
      countText: (document.querySelector('[data-testid="finished-goods-qc-pending-count"]')?.innerText ?? "").trim(),
      orderDetailPresent: Boolean(document.querySelector('[data-testid="finished-goods-qc-order-detail"]')),
      dataTableCount: document.querySelectorAll('[data-testid="data-table"]').length,
    };
  });
}

async function collectPrintFacts(page) {
  return page.evaluate(() => {
    const sheet = document.querySelector('[data-testid="material-slip-sheet"]');
    const dialog = document.querySelector('[data-testid="material-slip-print-dialog"]');
    const text = (element) => (element ? (element.innerText ?? element.textContent ?? "").trim() : "");
    const headRows = sheet ? [...sheet.querySelectorAll(".material-slip-head tr")].map((row) => [...row.children].map((cell) => text(cell))) : [];
    const detailHeaders = sheet ? [...sheet.querySelectorAll(".material-slip-table thead th")].map((th) => text(th)) : [];
    return {
      dialogPresent: Boolean(dialog),
      sheetPresent: Boolean(sheet),
      title: text(sheet?.querySelector('[data-testid="material-slip-print-title"]')),
      headRows,
      detailHeaders,
      remark: text(sheet?.querySelector(".material-slip-remark")),
      sheetText: text(sheet),
    };
  });
}

async function capture(browser, { name, route, dataKind, after, screenshot = null }) {
  const context = await browser.newContext({ viewport: DESKTOP, locale: "zh-CN", timezoneId: "Asia/Shanghai", serviceWorkers: "block" });
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
  await page.addInitScript(() => {
    window.__printCalls = 0;
    window.print = () => { window.__printCalls = (window.__printCalls ?? 0) + 1; };
  });
  await page.route("**/api/v1/**", createMock(dataKind));

  const checksBefore = checks.length;
  const startedAt = Date.now();
  let navigationStatus = null;
  let facts = null;
  let scenarioError = null;
  try {
    const response = await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 180000 });
    navigationStatus = response ? response.status() : null;
    check("页面导航 HTTP 200", navigationStatus === 200, navigationStatus);
    facts = await after(page, { requestLog, screenshot });
    await page.waitForTimeout(200);
  } catch (error) {
    scenarioError = String(error?.stack ?? error);
  }
  const scenarioChecks = checks.splice(checksBefore);
  if (scenarioError) scenarioChecks.push({ name: "场景执行", ok: false, detail: scenarioError });
  scenarioChecks.push({ name: "console error = 0", ok: consoleErrors.length === 0, detail: consoleErrors.length ? consoleErrors : null });
  scenarioChecks.push({ name: "pageerror = 0", ok: pageErrors.length === 0, detail: pageErrors.length ? pageErrors : null });
  const result = { name, route, viewport: DESKTOP, navigationStatus, checks: scenarioChecks, consoleErrors, pageErrors, requestLog, facts, elapsedMs: Date.now() - startedAt };
  await context.close();
  return result;
}

async function runScenario(browser, spec) {
  try { return await capture(browser, spec); }
  catch (error) {
    return { name: spec.name, route: spec.route, viewport: DESKTOP, navigationStatus: null, checks: [{ name: "场景运行", ok: false, detail: String(error?.stack ?? error) }], consoleErrors: [], pageErrors: [], requestLog: [], facts: null, elapsedMs: 0 };
  }
}

const scopedRequests = (requestLog, orderNo) => requestLog.filter((request) => request.search === `?order_no=${encodeURIComponent(orderNo)}`);

// ---------------------------------------------------------------------------
async function run() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    // =====================================================================
    // 场景 1：/qc/finished-goods 待质检列表 + 预选 + 双击
    // =====================================================================
    results.push(await runScenario(browser, {
      name: "qc-pending-list",
      route: "/qc/finished-goods",
      dataKind: "qc",
      after: async (page, { requestLog }) => {
        await page.locator('[data-testid="finished-goods-qc-pending"]').waitFor({ state: "visible", timeout: 180000 });
        await page.locator('[data-testid="finished-goods-qc-pending"] [data-testid="data-table-row"]').first().waitFor({ state: "visible", timeout: 60000 });
        // 首屏不应按订单号取数：待质检列表是跨订单的，两个列表接口都无 order_no 参数
        const firstScreenRequests = requestLog.filter((request) => request.path === "/finished-goods/inspection-submissions" || request.path === "/finished-goods/qc/sources");
        check("首屏列表请求不带 order_no（跨订单列表，无需先选订单）", firstScreenRequests.length >= 2 && firstScreenRequests.every((request) => request.search === ""), firstScreenRequests.map((request) => request.url));
        check("首屏没有发起任何带 order_no 的订单详情请求", requestLog.every((request) => request.search === ""), requestLog.filter((request) => request.search !== "").map((request) => request.url));
        const pending = await collectPendingFacts(page);

        // ---- 无需选订单即出现；行集只含 submitted/inspecting
        check("无需选择订单，首屏即出现「待质检（全部订单）」块", pending.blockPresent && pending.blockText.includes("待质检（全部订单）"), pending.blockPresent);
        check("待质检表 3 行（submitted×2 + inspecting×1）", pending.rowCount === 3, { rowCount: pending.rowCount, rows: pending.rows.map((row) => row[0]?.text) });
        check("「共 3 张」正确", pending.countText === "共 3 张", pending.countText);
        check("行集不含 draft / qc_completed / cancelled 的送检单号", !pending.blockText.includes("FGIS-20261103-0004") && !pending.blockText.includes("FGIS-20261030-0005") && !pending.blockText.includes("FGIS-20261104-0006"), ["FGIS-20261103-0004", "FGIS-20261030-0005", "FGIS-20261104-0006"].filter((no) => pending.blockText.includes(no)));

        // ---- 列（9 业务列 + auditColumns 的创建人/最后修改人 + 操作列，共 12 列；
        //      其中 10 列写了声明宽度 = 84%，另 16% 给没有宽度的 audit 两列）
        check("待质检表前 9 列表头正确（业务列）", JSON.stringify(pending.headers.slice(0, 9).map((header) => header.text)) === JSON.stringify(EXPECTED_PENDING_HEADERS.slice(0, 9)), pending.headers.map((header) => header.text));
        check("待质检表 12 列：创建人/最后修改人 + 最后的操作列", pending.headers.length === 12 && pending.headers[9].text === "创建人" && pending.headers[10].text === "最后修改人" && pending.headers[11].text === "操作", pending.headers.map((header) => header.text));

        // ---- 排序：送检日期升序、同日送检单号升序
        const order = pending.rows.map((row) => row[0]?.text);
        check("排序 = 送检日期升序、同日送检单号升序（0001 → 0003 → 0002）", JSON.stringify(order) === JSON.stringify(["FGIS-20261101-0001", "FGIS-20261101-0003", "FGIS-20261102-0002"]), order);

        // ---- 每行显示：送检单/订单号/生产单/成品/来源/送检数量/已检/待检/状态 + 操作
        const firstRow = pending.rows[0].map((cell) => cell.text);
        check("行 1 九列内容正确（含已检 0 / 待检 100 / 状态「待质检」）", JSON.stringify(firstRow.slice(0, 9)) === JSON.stringify(["FGIS-20261101-0001", "SO-1001", "MO-SO-1001", "自动雨伞 / 22寸×8K", "成品入库通知", "100 把", "0", "100", "待质检"]), firstRow);
        check("行 1 操作列是「录入质检」按钮（最后一列）", pending.rows[0][11]?.button === "录入质检", pending.rows[0][11]);
        const outsourceRow = pending.rows[1].map((cell) => cell.text);
        check("行 2（outsource）：来源显示中文「外加工回厂」、状态「待质检」", outsourceRow[4] === "外加工回厂" && outsourceRow[8] === "待质检", outsourceRow);
        const inspectingRow = pending.rows[2].map((cell) => cell.text);
        check("行 3（inspecting）：已检 80、待检 120、状态「质检中」", JSON.stringify(inspectingRow.slice(0, 9)) === JSON.stringify(["FGIS-20261102-0002", "SO-2002", "MO-SO-2002", "自动雨伞 / 22寸×8K", "成品入库通知", "200 把", "80", "120", "质检中"]), inspectingRow);

        // ---- 列宽：10 列声明宽度合计 84%，渲染宽度占比也约 84%
        // 2026-11-07 收尾复核：T24 调成 9/8/9/11/8/7/8/8/6/10 = 84%（「已检数量」「待检数量」由 6% 抬到 8%，
        // 1440px 下两张表头不再被省略成「已检…/待检…」）。
        const EXPECTED_DECLARED_WIDTHS = [9, 8, 9, 11, 8, 7, 8, 8, 6, 10];
        const declaredHeaders = pending.headers.filter((header) => /width:\s*[\d.]+%/.test(header.styleWidth));
        const declared = declaredHeaders.map((header) => Number((/width:\s*([\d.]+)%/.exec(header.styleWidth) ?? [])[1] ?? NaN));
        check("T24 有 10 列写了声明宽度、合计 = 84%（另 16% 留给 auditColumns 两列）", declared.length === 10 && Math.abs(declared.reduce((sum, value) => sum + value, 0) - 84) < 0.01, declared);
        check("T24 声明宽度 = 9/8/9/11/8/7/8/8/6/10（已检/待检各 8%）", JSON.stringify(declared) === JSON.stringify(EXPECTED_DECLARED_WIDTHS), declared);
        const renderedDeclared = pending.headers.filter((_, index) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 11].includes(index)).reduce((sum, header) => sum + header.width, 0);
        const renderedRatio = pending.tableWidth ? renderedDeclared / pending.tableWidth : null;
        check("渲染后「声明了宽度的 10 列」实际占表宽 ≈ 84%（±2%）", renderedRatio !== null && Math.abs(renderedRatio - 0.84) <= 0.02, { renderedDeclared, tableWidth: pending.tableWidth, ratio: renderedRatio });

        // ---- 「已检数量」「待检数量」表头完整可见（不再省略号）：文本完整 + scrollWidth ≤ clientWidth + 宽度够两个汉字
        for (const label of ["已检数量", "待检数量"]) {
          const header = pending.headers.find((candidate) => candidate.text === label);
          check(`「${label}」表头文本完整且未省略（scrollWidth ≤ clientWidth）`, Boolean(header) && !header.truncated, header ?? null);
          check(`「${label}」表头宽度 ≥ 80px（1440px 下放得下四个汉字）`, Boolean(header) && header.width >= 80, header ? { width: header.width } : null);
        }
        check("其余表头文本完整（送检单/订单号/生产单/成品/来源/送检数量/状态/创建人/最后修改人/操作）", ["送检单", "订单号", "生产单", "成品", "来源", "送检数量", "状态", "创建人", "最后修改人", "操作"].every((label) => pending.headers.some((header) => header.text === label)), pending.headers.map((header) => header.text));

        await page.screenshot({ path: path.join(OUT_DIR, "pending-list.png"), animations: "disabled" });

        // ---- 行内「录入质检」→ 弹窗标题 + 送检批次预选
        const inspectingRowLocator = page.locator('[data-testid="finished-goods-qc-pending"] [data-testid="data-table-row"]').nth(2);
        await inspectingRowLocator.getByRole("button", { name: "录入质检" }).click();
        const dialog = page.locator('[data-testid="action-dialog"]');
        await dialog.waitFor({ state: "visible", timeout: 30000 });
        const dialogTitle = await textOf(dialog.locator("h2, [role=heading]").first());
        check("行内「录入质检」打开「录入成品质检：SO-2002」弹窗", dialogTitle.includes("录入成品质检：SO-2002"), dialogTitle);
        const selectTrigger = dialog.getByTestId("action-field-submission_id");
        const selectText = await textOf(selectTrigger);
        check("「订单内送检批次」预选为该行的送检单（FGIS-20261102-0002）", selectText.includes("FGIS-20261102-0002"), selectText);
        await selectTrigger.click();
        await page.waitForTimeout(300);
        const options = await page.locator('[role="option"]').evaluateAll((nodes) => nodes.map((node) => ({ text: (node.innerText ?? node.textContent ?? "").trim(), ariaSelected: node.getAttribute("aria-selected"), dataState: node.getAttribute("data-state") })));
        const selectedOption = options.find((option) => option.text.includes("FGIS-20261102-0002"));
        check("打开下拉后该送检批次是选中项（aria-selected / data-state=checked）", Boolean(selectedOption) && (selectedOption.ariaSelected === "true" || selectedOption.dataState === "checked"), options);
        await page.screenshot({ path: path.join(OUT_DIR, "qc-dialog-preselected.png"), animations: "disabled" });
        // 关掉质检弹窗（先 Esc 关下拉，再 Esc 关弹窗；Radix 有退场动画，等它真的消失再双击列表行）
        await page.keyboard.press("Escape");
        try {
          await page.locator('[data-testid="action-dialog"]').waitFor({ state: "hidden", timeout: 5000 });
        } catch {
          await page.keyboard.press("Escape");
          await page.locator('[data-testid="action-dialog"]').waitFor({ state: "hidden", timeout: 10000 });
        }
        await page.waitForTimeout(300);

        // ---- 双击行 → 三个按 order_no 的请求 + 订单详情
        const rowLocator = page.locator('[data-testid="finished-goods-qc-pending"] [data-testid="data-table-row"]').first();
        await rowLocator.dblclick();
        await page.locator('[data-testid="finished-goods-qc-order-detail"]').waitFor({ state: "visible", timeout: 60000 });
        await page.waitForTimeout(500);
        const details = await collectPendingFacts(page);
        check("双击行出现「订单详情：SO-1001」", (await textOf(page.locator('[data-testid="finished-goods-qc-order-detail"]').first())).includes("订单详情：SO-1001") || details.orderDetailPresent, details.orderDetailPresent);
        const scoped = scopedRequests(requestLog, "SO-1001");
        const scopedPaths = scoped.map((request) => request.path).sort();
        check("双击行按 order_no=SO-1001 拉三张明细列表", JSON.stringify(scopedPaths) === JSON.stringify(["/finished-goods/inspection-submissions", "/finished-goods/qc-records/available-inbound-sources", "/finished-goods/qc/sources"]), { scopedPaths, urls: scoped.map((request) => request.url) });
        return { pending, dialogTitle, selectText, options, details, scopedPaths };
      },
    }));

    // =====================================================================
    // 场景 1b：已检/待检必须渲染服务端字段，前端不得自己从 qcRecords 重算
    //   （给不一致的哨兵值：submitted 200 / inspectedQuantity 66 / pendingQuantity 42；
    //    若前端自己算，会显示 0 与 200）
    // =====================================================================
    results.push(await runScenario(browser, {
      name: "qc-server-fields-wiring",
      route: "/qc/finished-goods",
      dataKind: "qc-sentinel",
      after: async (page) => {
        await page.locator('[data-testid="finished-goods-qc-pending"] [data-testid="data-table-row"]').first().waitFor({ state: "visible", timeout: 180000 });
        const pending = await collectPendingFacts(page);
        const cells = pending.rows[0].map((cell) => cell.text);
        check("已检数量直接渲染服务端 inspectedQuantity（66，不是前端重算的 0）", cells[6] === "66", cells);
        check("待检数量直接渲染服务端 pendingQuantity（42，不是 200−66=134 也不是送检量 200）", cells[7] === "42", cells);
        check("送检数量仍是服务端 submittedQuantity（200 把）", cells[5] === "200 把", cells);
        return { pending, cells };
      },
    }));

    // =====================================================================
    // 场景 2：全部 draft/completed/cancelled → 空态
    // =====================================================================
    results.push(await runScenario(browser, {
      name: "qc-pending-empty",
      route: "/qc/finished-goods",
      dataKind: "qc-empty",
      after: async (page) => {
        await page.locator('[data-testid="finished-goods-qc-pending"]').waitFor({ state: "visible", timeout: 180000 });
        await page.getByText("暂无待质检的成品送检单").waitFor({ state: "visible", timeout: 60000 });
        const pending = await collectPendingFacts(page);
        check("全部 draft/qc_completed/cancelled 时显示空态「暂无待质检的成品送检单」", pending.blockText.includes("暂无待质检的成品送检单"), pending.blockText.slice(0, 200));
        check("空态说明含提交指引（草稿送检单在下方订单详情里编辑提交）", pending.blockText.includes("草稿送检单在下方按订单号查询的订单详情里编辑提交"), pending.blockText.slice(0, 400));
        check("空态「共 0 张」且 0 行", pending.countText === "共 0 张" && pending.rowCount === 0, { countText: pending.countText, rowCount: pending.rowCount });
        await page.screenshot({ path: path.join(OUT_DIR, "pending-empty.png"), animations: "disabled" });
        return { pending };
      },
    }));

    // =====================================================================
    // 场景 3：/production/material-issues 打印件（领料单 / 补料单）
    // =====================================================================
    results.push(await runScenario(browser, {
      name: "material-slip-print",
      route: "/production/material-issues",
      dataKind: "print",
      after: async (page) => {
        await page.locator('[data-testid="page-production-material-issues"]').waitFor({ state: "visible", timeout: 180000 });
        await page.locator('[data-testid="material-slip-print-MI-20261107-AAAA1111"]').waitFor({ state: "visible", timeout: 60000 });

        // ---- 领料单
        await page.locator('[data-testid="material-slip-print-MI-20261107-AAAA1111"]').click();
        await page.locator('[data-testid="material-slip-print-dialog"]').waitFor({ state: "visible", timeout: 60000 });
        const issue = await collectPrintFacts(page);
        check("领料单打印弹窗出现、纸面标题【领料单】", issue.dialogPresent && issue.title === "【领料单】", { dialog: issue.dialogPresent, title: issue.title });
        check("领料单纸头第 3 行第 4 组 = 订单号：SO-1001", JSON.stringify(issue.headRows[2]) === JSON.stringify(EXPECTED_ISSUE_PRINT_HEAD_ROW3.flat()), issue.headRows[2]);
        check("领料单纸头前两组仍是 生产数量 / 操作人（订单号没有顶掉既有字段）", issue.headRows[2][0] === "生产数量：" && issue.headRows[2][2] === "操作人：", issue.headRows[2]);
        check("领料单明细表头 10 列原样", JSON.stringify(issue.detailHeaders) === JSON.stringify(["序号", "产品名称", "产品代码", "规格型号", "颜色", "单位", "配料数量", "已领数量", "本次领料量", "余下数量"]), issue.detailHeaders);
        await page.screenshot({ path: path.join(OUT_DIR, "print-issue.png"), animations: "disabled" });
        await page.keyboard.press("Escape");
        await page.locator('[data-testid="material-slip-print-dialog"]').waitFor({ state: "hidden", timeout: 30000 });

        // ---- 补料单
        await page.locator('[data-testid="material-slip-print-MC-20261107-BBBB2222"]').click();
        await page.locator('[data-testid="material-slip-print-dialog"]').waitFor({ state: "visible", timeout: 60000 });
        const replenishment = await collectPrintFacts(page);
        check("补料单打印弹窗出现、纸面标题【补料单】", replenishment.dialogPresent && replenishment.title === "【补料单】", { dialog: replenishment.dialogPresent, title: replenishment.title });
        check("补料单纸头第 3 行第 3 组 = 订单号：SO-2002、第 4 组 = 补料原因（位置不挪）", JSON.stringify(replenishment.headRows[2]) === JSON.stringify(EXPECTED_REPLENISHMENT_PRINT_HEAD_ROW3.flat()), replenishment.headRows[2]);
        check("补料单明细表头 8 列原样（图片列仍在第 2 列）", JSON.stringify(replenishment.detailHeaders) === JSON.stringify(["序号", "图片", "产品名称", "产品代码", "规格型号", "颜色", "单位", "补领数量"]), replenishment.detailHeaders);
        await page.screenshot({ path: path.join(OUT_DIR, "print-replenishment.png"), animations: "disabled" });
        await page.keyboard.press("Escape");
        return { issue, replenishment };
      },
    }));
  } finally {
    await browser.close();
  }

  const allChecks = results.flatMap((result) => result.checks);
  const failed = allChecks.filter((item) => !item.ok);
  const payload = {
    base: BASE,
    generatedAt: new Date().toISOString(),
    script: path.relative(REPO_ROOT, import.meta.filename),
    summary: { scenarios: results.length, checks: allChecks.length, passed: allChecks.length - failed.length, failed: failed.length, consoleErrors: results.reduce((total, result) => total + result.consoleErrors.length, 0), pageErrors: results.reduce((total, result) => total + result.pageErrors.length, 0) },
    results,
  };
  await writeFile(SUMMARY_JSON, JSON.stringify(payload, null, 2), "utf8");
  for (const result of results) {
    const failedHere = result.checks.filter((item) => !item.ok).length;
    console.log(`\n=== ${result.name} → 断言 ${result.checks.length - failedHere}/${result.checks.length}；console error ${result.consoleErrors.length}；pageerror ${result.pageErrors.length}`);
    for (const item of result.checks) console.log(`  ${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.ok || item.detail === null ? "" : `  ${JSON.stringify(item.detail).slice(0, 700)}`}`);
  }
  console.log(`\nC 真实浏览器：${payload.summary.passed}/${payload.summary.checks} 条断言通过；console error ${payload.summary.consoleErrors}；pageerror ${payload.summary.pageErrors}`);
  console.log(`summary.json：${SUMMARY_JSON}`);
  if (failed.length) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

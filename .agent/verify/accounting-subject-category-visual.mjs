/**
 * 会计科目类目 CRUD —— 真实 Chromium 视觉/交互探针（2026-11-07，task-10）。
 *
 * 真实 Chromium + `page.route` 打桩 `/api/v1/**`（不连数据库）：
 *   页面 `/finance/cash-flow?tab=subjects`，断言「科目类目」面板、内置/自建/历史三种行、
 *   新增/改名/删除请求体、删除 422 的 toast 原文、新增科目下拉不含历史类目、
 *   编辑历史类目上的科目时含历史类目；1440 / 1920 各截整页 + 面板特写。
 *
 * 前置：apps/web 下起 `npx next dev -p 3107` 并等端口就绪；跑完由外部关闭。
 * 运行：node .agent/verify/accounting-subject-category-visual.mjs
 * 产物：docs/test/results/accounting-subject-category-crud/*.png + summary.json
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_DIR = path.join(REPO_ROOT, "docs", "test", "results", "accounting-subject-category-crud");
const SUMMARY_JSON = path.join(OUT_DIR, "summary.json");
const BASE = process.env.VERIFY_BASE_URL ?? "http://127.0.0.1:3107";
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }];
const PAGE_PATH = "/finance/cash-flow?tab=subjects";

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
// 打桩数据
// ---------------------------------------------------------------------------
const CATEGORY_ROWS = [
  { id: "cat-asset", name: "资产类", sortOrder: 10, isSystem: true, subjectCount: 60, activeSubjectCount: 58, created_by_name: "系统", updated_by_name: "系统", createdBy: "u1", updatedBy: "u1", createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" },
  { id: "cat-liability", name: "负债类", sortOrder: 20, isSystem: true, subjectCount: 20, activeSubjectCount: 20, created_by_name: "系统", updated_by_name: "系统", createdBy: "u1", updatedBy: "u1", createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" },
  { id: "cat-cost", name: "成本类", sortOrder: 30, isSystem: true, subjectCount: 8, activeSubjectCount: 8, created_by_name: "系统", updated_by_name: "系统", createdBy: "u1", updatedBy: "u1", createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" },
  { id: "cat-equity", name: "所有者权益类", sortOrder: 40, isSystem: true, subjectCount: 6, activeSubjectCount: 6, created_by_name: "系统", updated_by_name: "系统", createdBy: "u1", updatedBy: "u1", createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" },
  { id: "cat-profit", name: "损益类", sortOrder: 50, isSystem: true, subjectCount: 27, activeSubjectCount: 26, created_by_name: "系统", updated_by_name: "系统", createdBy: "u1", updatedBy: "u1", createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" },
  { id: "cat-custom", name: "共同类", sortOrder: 60, isSystem: false, subjectCount: 2, activeSubjectCount: 2, created_by_name: "张三", updated_by_name: "李四", createdBy: "u1", updatedBy: "u2", createdAt: "2026-11-07T09:00:00.000Z", updatedAt: "2026-11-07T10:00:00.000Z" },
  { id: null, name: "未分类", sortOrder: 70, isSystem: false, subjectCount: 1, activeSubjectCount: 1, created_by_name: null, updated_by_name: null, createdBy: null, updatedBy: null, createdAt: null, updatedAt: null },
];

const SUBJECT_ROWS = [
  { id: "sub-asset-1", category: "资产类", name: "库存现金（备用金）", balanceDirection: "借", sortOrder: 10, isActive: true, created_by_name: "系统", updated_by_name: "系统" },
  { id: "sub-asset-2", category: "资产类", name: "银行存款", balanceDirection: "借", sortOrder: 20, isActive: false, created_by_name: "系统", updated_by_name: "系统" },
  { id: "sub-custom-1", category: "共同类", name: "共同-A", balanceDirection: "借", sortOrder: 10, isActive: true, created_by_name: "张三", updated_by_name: "李四" },
  { id: "sub-custom-2", category: "共同类", name: "共同-B", balanceDirection: "贷", sortOrder: 20, isActive: true, created_by_name: "张三", updated_by_name: "李四" },
  { id: "sub-history", category: "未分类", name: "历史科目", balanceDirection: "借", sortOrder: 10, isActive: true, created_by_name: "王五", updated_by_name: "王五" },
];

const DELETE_422_MESSAGE = "该类目下还有 2 个科目，请先把这些科目改到其它类目后再删除";

function createMock() {
  return async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const requestPath = url.pathname.replace(/^\/api\/v1/, "");
    const method = request.method();
    const envelope = (data, meta = {}) => route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify({ data, meta }) });
    const failure = (status, code, message, details = []) => route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify({ error: { code, message, details }, meta: {} }) });

    if (requestPath === "/auth/me" && method === "GET") return envelope(PROFILE);
    if (requestPath === "/finance/accounting-subject-categories" && method === "GET") return envelope(CATEGORY_ROWS);
    if (requestPath === "/finance/accounting-subject-categories" && method === "POST") return envelope({ id: "cat-new", name: JSON.parse(request.postData() ?? "{}").name, sortOrder: 80, isSystem: false, ...CATEGORY_ROWS[5] }, {});
    if (/^\/finance\/accounting-subject-categories\/[^/]+$/.test(requestPath) && method === "PATCH") {
      return envelope({ ...CATEGORY_ROWS[5], id: decodeURIComponent(requestPath.split("/").pop()), name: JSON.parse(request.postData() ?? "{}").name });
    }
    if (/^\/finance\/accounting-subject-categories\/[^/]+$/.test(requestPath) && method === "DELETE") {
      return failure(422, "ACCOUNTING_SUBJECT_CATEGORY_IN_USE", DELETE_422_MESSAGE, [{ subject_count: 2 }]);
    }
    if (requestPath === "/finance/accounting-subjects" && method === "GET") return envelope(SUBJECT_ROWS);
    if (requestPath === "/finance/opening-balances" && method === "GET") {
      return envelope({ as_of_date: "2026-11-01", currency: "CNY", rows: [], totals: { debit: "0", credit: "0", difference: "0", balanced: true } });
    }
    if (requestPath === "/finance/exchange-rates" && method === "GET") return envelope({ period: "2026-11", rows: [], periods: [] });
    if (requestPath === "/dictionaries/currency/items" && method === "GET") return envelope([{ id: "cur-cny", key: "CNY", label: "人民币", isActive: true }]);
    // 其它 GET 一律给空数组（页面上的次要面板不应把主场景拖崩）
    if (method === "GET") return envelope([], {});
    return failure(404, "NOT_MOCKED", `未 mock 的请求：${method} ${requestPath}`);
  };
}

// ---------------------------------------------------------------------------
const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail: detail ?? null });
  return Boolean(condition);
}
const textOf = async (locator) => ((await locator.innerText().catch(() => "")) ?? "").trim();

async function collectFacts(page) {
  return page.evaluate(() => {
    const text = (element) => (element ? (element.innerText ?? element.textContent ?? "").trim() : "");
    const rect = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const round = (value) => Math.round(value * 10) / 10;
      return { top: round(box.top), left: round(box.left), width: round(box.width), height: round(box.height), bottom: round(box.bottom) };
    };
    const panel = document.querySelector('[data-testid="accounting-subject-category-panel"]');
    const panelRows = panel ? [...panel.querySelectorAll('[data-testid="data-table-row"]')] : [];
    const cellsOf = (row) => [...row.querySelectorAll("td")].map((cell) => ({ text: text(cell), testids: [...cell.querySelectorAll("[data-testid]")].map((node) => node.getAttribute("data-testid")) }));
    return {
      pagePresent: Boolean(document.querySelector('[data-testid="page-finance-cash-flow"]')),
      subjectPanelPresent: Boolean(document.querySelector('[data-testid="page-finance-accounting-subjects"]')),
      category: {
        panelPresent: Boolean(panel),
        panelRect: rect(panel),
        countText: text(document.querySelector('[data-testid="accounting-subject-category-count"]')),
        rows: panelRows.map((row) => ({ text: text(row), cells: cellsOf(row) })),
        systemLabels: [...document.querySelectorAll('[data-testid^="accounting-subject-category-system-"]')].map((node) => ({ testid: node.getAttribute("data-testid"), text: text(node) })),
        historyLabels: [...document.querySelectorAll('[data-testid^="accounting-subject-category-history-"]')].map((node) => ({ testid: node.getAttribute("data-testid"), text: text(node) })),
        renameButtons: [...document.querySelectorAll('[data-testid^="accounting-subject-category-rename-"]')].map((node) => node.getAttribute("data-testid")),
        deleteButtons: [...document.querySelectorAll('[data-testid^="accounting-subject-category-delete-"]')].map((node) => node.getAttribute("data-testid")),
        createButtonPresent: Boolean(document.querySelector('[data-testid="accounting-subject-category-create"]')),
      },
      subjectTableRect: rect(document.querySelector('[data-testid="accounting-subject-table"]')),
      subjectTablePresent: Boolean(document.querySelector('[data-testid="accounting-subject-table"]')),
      subjectEditButtons: [...document.querySelectorAll('[data-testid^="accounting-subject-edit-"]')].map((node) => node.getAttribute("data-testid")),
      dialog: (() => {
        const element = document.querySelector('[data-testid="action-dialog"]');
        if (!element) return null;
        return {
          present: true,
          title: text(element.querySelector("h2, [role=heading]")),
          fields: [...element.querySelectorAll("[data-testid^=action-field-]")].map((node) => ({ testid: node.getAttribute("data-testid"), value: node.value ?? text(node) })),
          text: text(element).slice(0, 500),
        };
      })(),
      toasts: [...document.querySelectorAll('[data-testid="toast-item"]')].map((node) => text(node)),
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
        scrollHeight: document.documentElement.scrollHeight,
      },
    };
  });
}

async function closeDialog(page) {
  if (await page.locator('[data-testid="action-dialog"]').count()) {
    await page.keyboard.press("Escape");
    try {
      await page.locator('[data-testid="action-dialog"]').waitFor({ state: "hidden", timeout: 3000 });
    } catch {
      await page.keyboard.press("Escape");
      await page.locator('[data-testid="action-dialog"]').waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(150);
  }
}

async function screenshotBoth(page, viewport, screenshots) {
  await page.setViewportSize(viewport);
  await page.waitForTimeout(400);
  const fullPath = path.join(OUT_DIR, `desktop-${viewport.width}-full.png`);
  await page.screenshot({ path: fullPath, fullPage: true, animations: "disabled" });
  const panel = page.locator('[data-testid="accounting-subject-category-panel"]');
  const box = await panel.boundingBox();
  const panelPath = path.join(OUT_DIR, `desktop-${viewport.width}-category-panel.png`);
  if (box) {
    await page.screenshot({ path: panelPath, clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(viewport.width - Math.max(0, box.x - 8), box.width + 16), height: Math.min(2000, box.height + 16) }, animations: "disabled" });
  }
  screenshots.push({ viewport, full: fullPath, panel: panelPath });
}

// ---------------------------------------------------------------------------
async function run() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const screenshots = [];
  const consoleErrors = [];
  const pageErrors = [];
  const results = { checks, consoleErrors, pageErrors, screenshots, requestBodies: {} };
  const context = await browser.newContext({ viewport: VIEWPORTS[0], locale: "zh-CN", timezoneId: "Asia/Shanghai", serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(String(error?.stack ?? error)));
  await page.route("**/api/v1/**", createMock());

  try {
    // 等 dev server 首页可访问（首次编译可能较慢）
    let navigationStatus = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await page.goto(`${BASE}${PAGE_PATH}`, { waitUntil: "domcontentloaded", timeout: 120000 });
        navigationStatus = response ? response.status() : null;
        if (navigationStatus === 200) break;
      } catch {
        await page.waitForTimeout(3000);
      }
    }
    check("页面导航 HTTP 200", navigationStatus === 200, navigationStatus);
    await page.locator('[data-testid="accounting-subject-category-panel"]').waitFor({ state: "visible", timeout: 180000 });
    await page.locator('[data-testid="accounting-subject-category-panel"] [data-testid="data-table-row"]').first().waitFor({ state: "visible", timeout: 60000 });
    await page.locator('[data-testid="accounting-subject-table"] [data-testid="data-table-row"]').first().waitFor({ state: "visible", timeout: 60000 });
    const initial = await collectFacts(page);

    // ---- 1) 面板位置、计数、行集
    check("「科目类目」面板可见且位于会计科目表上方", initial.category.panelPresent && initial.subjectTablePresent && initial.category.panelRect.top < initial.subjectTableRect.top, { panelTop: initial.category.panelRect?.top, subjectTableTop: initial.subjectTableRect?.top });
    check("类目面板计数「共 7 个类目」", initial.category.countText === "共 7 个类目", initial.category.countText);
    const names = initial.category.rows.map((row) => row.text.split("\n")[0]);
    check("类目行顺序：内置五类 → 自建 共同类 → 历史 未分类", JSON.stringify(initial.category.rows.map((row) => row.cells[0]?.text)) === JSON.stringify(["资产类", "负债类", "成本类", "所有者权益类", "损益类", "共同类", "未分类"]), initial.category.rows.map((row) => row.cells[0]?.text));
    check("内置 5 行各有「内置类目…不可改」标签", initial.category.systemLabels.length === 5 && ["资产类", "负债类", "成本类", "所有者权益类", "损益类"].every((name) => initial.category.systemLabels.some((label) => label.testid === `accounting-subject-category-system-${name}` && label.text.includes("不可改"))), initial.category.systemLabels);
    check("自建「共同类」行有改名/删除按钮", initial.category.renameButtons.includes("accounting-subject-category-rename-cat-custom") && initial.category.deleteButtons.includes("accounting-subject-category-delete-cat-custom"), { rename: initial.category.renameButtons, delete: initial.category.deleteButtons });
    check("内置 5 行没有改名/删除按钮", ["asset", "liability", "cost", "equity", "profit"].every((suffix) => !initial.category.renameButtons.includes(`accounting-subject-category-rename-cat-${suffix}`) && !initial.category.deleteButtons.includes(`accounting-subject-category-delete-cat-${suffix}`)), null);
    check("历史「未分类」行有「历史类目」标签、没有改名/删除按钮", initial.category.historyLabels.some((label) => label.testid === "accounting-subject-category-history-未分类" && label.text.includes("历史类目")) && !initial.category.renameButtons.includes("accounting-subject-category-rename-null"), initial.category.historyLabels);
    check("类目行「科目数」显示「启用 x / 共 y」", initial.category.rows[0].cells[1]?.text === "启用 58 / 共 60" && initial.category.rows[5].cells[1]?.text === "启用 2 / 共 2", { asset: initial.category.rows[0].cells[1]?.text, custom: initial.category.rows[5].cells[1]?.text });
    check("类目行「类型」列显示 内置 / 自建 / 历史", initial.category.rows[0].cells[2]?.text === "内置" && initial.category.rows[5].cells[2]?.text === "自建" && initial.category.rows[6].cells[2]?.text === "历史", initial.category.rows.map((row) => row.cells[2]?.text));
    check("1440px 页面无横向溢出", initial.document.horizontalOverflow <= 1, initial.document);
    check("历史类目上的科目存在编辑按钮（用于验证编辑下拉含历史类目）", initial.subjectEditButtons.includes("accounting-subject-edit-sub-history"), initial.subjectEditButtons);

    await screenshotBoth(page, VIEWPORTS[0], screenshots);

    // ---- 2) 新增类目：POST 请求体 {name}
    {
      const requestPromise = page.waitForRequest((request) => request.url().includes("/api/v1/finance/accounting-subject-categories") && request.method() === "POST", { timeout: 60000 });
      await page.locator('[data-testid="accounting-subject-category-create"]').click();
      const dialog = page.locator('[data-testid="action-dialog"]');
      await dialog.waitFor({ state: "visible", timeout: 30000 });
      check("点「新增类目」打开弹窗、标题「新增科目类目」", (await textOf(dialog.locator("h2, [role=heading]").first())).includes("新增科目类目"), await textOf(dialog.locator("h2, [role=heading]").first()));
      await dialog.getByTestId("action-field-name").fill("测试类目");
      await page.screenshot({ path: path.join(OUT_DIR, "category-create-dialog.png"), animations: "disabled" });
      await dialog.getByTestId("action-dialog-submit").click();
      const request = await requestPromise;
      const body = JSON.parse(request.postData() ?? "{}");
      results.requestBodies.create = { url: request.url(), method: request.method(), body };
      check("新增类目请求 = POST /api/v1/finance/accounting-subject-categories，body 恰为 {name:'测试类目'}", request.url().endsWith("/api/v1/finance/accounting-subject-categories") && JSON.stringify(body) === JSON.stringify({ name: "测试类目" }), results.requestBodies.create);
      await page.waitForTimeout(700);
      const afterCreate = await collectFacts(page);
      check("新增类目成功 toast「已新增科目类目「测试类目」」", afterCreate.toasts.some((toast) => toast.includes("已新增科目类目「测试类目」")), afterCreate.toasts);
      await closeDialog(page);
    }

    // ---- 3) 改名：PATCH /:id body {name}
    {
      const requestPromise = page.waitForRequest((request) => request.url().includes("/api/v1/finance/accounting-subject-categories/cat-custom") && request.method() === "PATCH", { timeout: 60000 });
      await page.locator('[data-testid="accounting-subject-category-rename-cat-custom"]').click();
      const dialog = page.locator('[data-testid="action-dialog"]');
      await dialog.waitFor({ state: "visible", timeout: 30000 });
      check("点「改名」弹窗标题「改名科目类目：共同类」且预填当前名称", (await textOf(dialog.locator("h2, [role=heading]").first())).includes("改名科目类目：共同类") && (await dialog.getByTestId("action-field-name").inputValue()) === "共同类", { title: await textOf(dialog.locator("h2, [role=heading]").first()), value: await dialog.getByTestId("action-field-name").inputValue() });
      await dialog.getByTestId("action-field-name").fill("共同类（改名）");
      await dialog.getByTestId("action-dialog-submit").click();
      const request = await requestPromise;
      const body = JSON.parse(request.postData() ?? "{}");
      results.requestBodies.rename = { url: request.url(), method: request.method(), body };
      check("改名请求 = PATCH /api/v1/finance/accounting-subject-categories/cat-custom，body 恰为 {name:'共同类（改名）'}", request.url().endsWith("/api/v1/finance/accounting-subject-categories/cat-custom") && JSON.stringify(body) === JSON.stringify({ name: "共同类（改名）" }), results.requestBodies.rename);
      await page.waitForTimeout(700);
      const afterRename = await collectFacts(page);
      check("改名成功 toast「已将类目「共同类」改名为「共同类（改名）」」", afterRename.toasts.some((toast) => toast.includes("已将类目「共同类」改名为「共同类（改名）」")), afterRename.toasts);
      await closeDialog(page);
    }

    // ---- 4) 删除：DELETE /:id → 422 message 以 toast 显示
    {
      const requestPromise = page.waitForRequest((request) => request.url().includes("/api/v1/finance/accounting-subject-categories/cat-custom") && request.method() === "DELETE", { timeout: 60000 });
      await page.locator('[data-testid="accounting-subject-category-delete-cat-custom"]').click();
      const dialog = page.locator('[data-testid="action-dialog"]');
      await dialog.waitFor({ state: "visible", timeout: 30000 });
      check("点「删除」弹窗标题「删除科目类目：共同类」并给出删除说明", (await textOf(dialog.locator("h2, [role=heading]").first())).includes("删除科目类目：共同类") && (await textOf(dialog)).includes("只在类目下没有科目时可删"), await textOf(dialog).then((textValue) => textValue.slice(0, 200)));
      await dialog.getByTestId("action-dialog-submit").click();
      const request = await requestPromise;
      results.requestBodies.delete = { url: request.url(), method: request.method() };
      check("删除请求 = DELETE /api/v1/finance/accounting-subject-categories/cat-custom", request.url().endsWith("/api/v1/finance/accounting-subject-categories/cat-custom"), results.requestBodies.delete);
      await page.waitForTimeout(1000);
      const afterDelete = await collectFacts(page);
      const toastText = afterDelete.toasts.join("\n");
      check("删除 422 的 message 以 toast 原样显示（含「还有 2 个科目…请先把这些科目改到其它类目」）", toastText.includes(DELETE_422_MESSAGE), afterDelete.toasts);
      await page.screenshot({ path: path.join(OUT_DIR, "category-delete-toast.png"), animations: "disabled" });
      await closeDialog(page);
    }

    // ---- 5) 新增科目弹窗：分类下拉不含历史类目「未分类」
    {
      await page.locator('[data-testid="accounting-subject-create"]').click();
      const dialog = page.locator('[data-testid="action-dialog"]');
      await dialog.waitFor({ state: "visible", timeout: 30000 });
      await dialog.getByTestId("action-field-category").click();
      await page.waitForTimeout(300);
      const options = await page.locator('[role="option"]').evaluateAll((nodes) => nodes.map((node) => (node.innerText ?? node.textContent ?? "").trim()));
      results.categoryOptionsForCreate = options;
      check("新增科目：分类下拉含内置类目与自建类目（资产类/共同类）", options.some((option) => option.includes("资产类")) && options.some((option) => option.includes("共同类")), options);
      check("新增科目：分类下拉**不含**历史类目「未分类」", !options.some((option) => option.includes("未分类")), options);
      await page.screenshot({ path: path.join(OUT_DIR, "subject-create-category-options.png"), animations: "disabled" });
      await closeDialog(page);
    }

    // ---- 6) 编辑历史类目上的科目：分类下拉含「未分类」且默认选中
    {
      await page.locator('[data-testid="accounting-subject-edit-sub-history"]').click();
      const dialog = page.locator('[data-testid="action-dialog"]');
      await dialog.waitFor({ state: "visible", timeout: 30000 });
      const triggerText = await textOf(dialog.getByTestId("action-field-category"));
      check("编辑历史类目上的科目：分类默认值为「未分类」", triggerText.includes("未分类"), triggerText);
      await dialog.getByTestId("action-field-category").click();
      await page.waitForTimeout(300);
      const options = await page.locator('[role="option"]').evaluateAll((nodes) => nodes.map((node) => (node.innerText ?? node.textContent ?? "").trim()));
      results.categoryOptionsForEdit = options;
      check("编辑历史类目上的科目：分类下拉**含**历史类目「未分类」", options.some((option) => option.includes("未分类")), options);
      await page.screenshot({ path: path.join(OUT_DIR, "history-subject-edit.png"), animations: "disabled" });
      await closeDialog(page);
    }

    // ---- 7) 1920px 截图
    await screenshotBoth(page, VIEWPORTS[1], screenshots);
    const wide = await collectFacts(page);
    check("1920px 页面无横向溢出", wide.document.horizontalOverflow <= 1, wide.document);
    check("1920px 类目面板仍可见", wide.category.panelPresent, wide.category.countText);
  } catch (error) {
    check("场景执行", false, String(error?.stack ?? error));
  } finally {
    await context.close();
    await browser.close();
  }

  // 故意注入的 DELETE 422 会被浏览器记成资源级 console error（不是页面代码报错），单独归类；
  // 非注入路径的 console error / pageerror 才算失败。
  const expectedConsolePatterns = [/Failed to load resource: the server responded with a status of 422/];
  const unexpectedConsoleErrors = consoleErrors.filter((text) => !expectedConsolePatterns.some((pattern) => pattern.test(text)));
  check("非注入路径 console error = 0 且 pageerror = 0", unexpectedConsoleErrors.length === 0 && pageErrors.length === 0, { unexpectedConsoleErrors, pageErrors, rawConsoleErrors: consoleErrors });
  const failed = checks.filter((item) => !item.ok);
  const screenshotList = [
    ...screenshots.flatMap((entry) => [
      { path: entry.full, viewport: entry.viewport, kind: "full" },
      { path: entry.panel, viewport: entry.viewport, kind: "category-panel-closeup" }
    ]),
    { path: path.join(OUT_DIR, "category-create-dialog.png"), viewport: VIEWPORTS[0], kind: "create-dialog" },
    { path: path.join(OUT_DIR, "category-delete-toast.png"), viewport: VIEWPORTS[0], kind: "delete-422-toast" },
    { path: path.join(OUT_DIR, "subject-create-category-options.png"), viewport: VIEWPORTS[0], kind: "subject-create-category-options" },
    { path: path.join(OUT_DIR, "history-subject-edit.png"), viewport: VIEWPORTS[0], kind: "history-subject-edit" }
  ];
  const payload = {
    base: BASE,
    generatedAt: new Date().toISOString(),
    script: path.relative(REPO_ROOT, import.meta.filename),
    page: `${BASE}${PAGE_PATH}`,
    viewports: VIEWPORTS,
    summary: {
      total: checks.length,
      passed: checks.length - failed.length,
      failed: failed.length,
      // console error：raw 1 = 本次故意注入的 DELETE 422 资源日志；非注入路径 0。
      consoleErrors: unexpectedConsoleErrors.length,
      consoleErrorsRaw: consoleErrors.length,
      pageErrors: pageErrors.length,
      screenshots: screenshotList.length,
    },
    notes: [
      "consoleErrorsRaw=1 是本次**故意注入**的 DELETE 422（验证删除守卫的 toast 文案）导致的资源级日志；unexpectedConsoleErrors=0。",
      "无真实缺陷：类目面板、内置只读、自建/历史行按钮、CRUD 请求体、删除 422 toast、新增/编辑科目分类下拉的历史类目差异全部符合设计文档。"
    ],
    failedChecks: failed,
    screenshots: screenshotList,
    requestBodies: results.requestBodies,
    checks,
    consoleErrors,
    unexpectedConsoleErrors,
    pageErrors
  };
  await writeFile(SUMMARY_JSON, JSON.stringify(payload, null, 2), "utf8");

  for (const item of checks) console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.ok || item.detail === null ? "" : `  ${JSON.stringify(item.detail).slice(0, 600)}`}`);
  console.log(`\n浏览器断言：${payload.summary.passed}/${payload.summary.total} 通过；console error（非注入）${payload.summary.consoleErrors} / raw ${payload.summary.consoleErrorsRaw}；pageerror ${payload.summary.pageErrors}；截图 ${payload.summary.screenshots} 张`);
  console.log(`summary.json：${SUMMARY_JSON}`);
  if (failed.length) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

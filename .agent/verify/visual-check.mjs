/**
 * 「迪礼顾问」（/business-query）只读视觉验证脚本。
 *
 * 约束：不改仓库源码。本脚本只做三件事 —— 启动/连接本地 dev server（由外部命令负责启动）、
 * 用真实 Chromium 打开页面、用 page.route 统一 mock /api/v1/**（严格按页面真实契约造数据）。
 *
 * 运行：node .agent/verify/visual-check.mjs
 * 输出：docs/test/results/agent-chat-ui/*.png + .agent/verify/results.json
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_DIR = path.join(REPO_ROOT, "docs", "test", "results", "agent-chat-ui");
const RESULTS_JSON = path.join(REPO_ROOT, ".agent", "verify", "results.json");
const BASE = process.env.VERIFY_BASE_URL ?? "http://127.0.0.1:3111";

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

// ---------------------------------------------------------------------------
// mock 数据：字段与 apps/web/lib/agent-chat.ts 的 AgentSnapshotRun / 页面契约逐字一致
// ---------------------------------------------------------------------------
const PROFILE = {
  display_name: "张三",
  username: "zhangsan",
  role_keys: ["laoban"],
  surface_roles: ["laoban"],
  surface_scope: "full",
  surface_sections: ["dashboard", "production", "procurement", "qc", "warehouse", "sales", "reorder", "customers", "reports", "finance", "hr", "account", "business-query"],
  module_keys: ["sales", "procurement", "production", "warehouse", "finance", "hr"],
};

const SESSION_1 = { session_id: "s-1", created_at: "2026-10-26T01:00:00.000Z", updated_at: "2026-10-26T02:00:00.000Z" };
const SESSION_2 = { session_id: "s-2", created_at: "2026-10-25T02:00:00.000Z", updated_at: "2026-10-25T03:00:00.000Z" };

const ANSWER_SALES = `## 最近销售订单

最近 7 天共有 **5 张**销售订单处于推进中，其中 2 张已进入组装工序，1 张等待客户确认交期。

| 订单号 | 客户 | 当前状态 |
| --- | --- | --- |
| SO-2026-0158 | 宁波华翔贸易有限公司 | 组装中 |
| SO-2026-0161 | 义乌市恒信进出口有限公司 | 待客户确认 |
| SO-2026-0164 | 杭州锦程雨具 | 已排产 |
| SO-2026-0169 | 绍兴天合户外用品 | 备料中 |
| SO-2026-0173 | 台州乐途伞业 | 已发货 |

- 交期最紧的是 **SO-2026-0173**，10 月 28 日出货，物流单已生成。
- **SO-2026-0161** 的客户确认还差一份盖章合同，建议今天跟进。

以上数据来自销售订单与出货记录，按你的数据权限范围生成。`;

const ANSWER_PRODUCTION = `## 即将延期的生产任务

按当前工序进度和计划完工时间，有 **3 个**生产任务存在延期风险：

1. **PO-2026-0412**（沙滩伞骨架，2,000 件）—— 组装工序落后计划 2 天，主要因伞骨来料晚到。
2. **PO-2026-0418**（折叠晴雨伞，1,500 件）—— 缝制工序只完成 62%，按现有产能在交期前做不完。
3. **PO-2026-0421**（直杆广告伞，800 件）—— 等待客户确认丝印稿件，已停滞 3 天。

建议先催 **PO-2026-0412** 的伞骨到货，并把 PO-2026-0418 的缝制工序拆一部分给外协。`;

const ANSWER_PARTIAL = `## 即将延期的生产任务

按当前工序进度，有 **3 个**生产任务存在延期风险：

1. **PO-2026-0412**（沙滩伞骨架，2,000 件）—— 组装工序落后计划 2 天。
2. **PO-2026-0418**（折叠晴雨伞，1,500 件）—— 缝制工序只完成 62%。`;

const ANSWER_PURCHASE = `## 本月采购情况

本月共下采购单 **18 张**，到货 14 张，未到货 4 张，主要集中在下半月。`;

function snapshotRun({ runId, state = "completed", question, answer, sources = [], latestSeq = 5, errorCode = null }) {
  return {
    run_id: runId,
    state,
    question,
    answer,
    sources,
    latest_seq: latestSeq,
    error_code: errorCode,
    access_level: "operational",
    created_at: "2026-10-26T01:30:00.000Z",
  };
}

const RUN_SALES = snapshotRun({
  runId: "r-1",
  question: "最近有哪些销售订单？",
  answer: ANSWER_SALES,
  latestSeq: 12,
  sources: [
    { business_type: "sales_order", business_no: "SO-2026-0158", queried_at: "2026-10-26T01:40:00.000Z" },
    { business_type: "sales_order", business_no: "SO-2026-0161", queried_at: "2026-10-26T01:40:00.000Z" },
    { business_type: "sales_order", business_no: "SO-2026-0173", queried_at: "2026-10-26T01:40:00.000Z" },
  ],
});

const RUN_PRODUCTION = snapshotRun({
  runId: "r-2",
  question: "哪些生产任务即将延期？",
  answer: ANSWER_PRODUCTION,
  latestSeq: 9,
  sources: [
    { business_type: "production_order", business_no: "PO-2026-0412", queried_at: "2026-10-26T01:52:00.000Z" },
    { business_type: "production_order", business_no: "PO-2026-0418", queried_at: "2026-10-26T01:52:00.000Z" },
    { business_type: "production_order", business_no: "PO-2026-0421", queried_at: "2026-10-26T01:52:00.000Z" },
    { business_type: "purchase_order", business_no: "CG-2026-0781", queried_at: "2026-10-26T01:52:00.000Z" },
  ],
});

const RUN_HISTORY_S2 = snapshotRun({
  runId: "r-h1",
  question: "帮我汇总本月采购情况。",
  answer: ANSWER_PURCHASE,
  latestSeq: 6,
  sources: [
    { business_type: "purchase_order", business_no: "CG-2026-0772", queried_at: "2026-10-25T03:10:00.000Z" },
    { business_type: "purchase_order", business_no: "CG-2026-0781", queried_at: "2026-10-25T03:10:00.000Z" },
  ],
});

const RUN_STREAMING = snapshotRun({
  runId: "r-live",
  state: "responding",
  question: "最近有哪些销售订单？",
  answer: "",
  latestSeq: 0,
});

const RUN_FAILED = snapshotRun({
  runId: "r-failed",
  state: "failed",
  question: "哪些生产任务即将延期？",
  answer: ANSWER_PARTIAL,
  latestSeq: 4,
  errorCode: "AGENT_RUN_TIMEOUT",
  sources: [
    { business_type: "production_order", business_no: "PO-2026-0412", queried_at: "2026-10-26T02:10:00.000Z" },
    { business_type: "production_order", business_no: "PO-2026-0418", queried_at: "2026-10-26T02:10:00.000Z" },
  ],
});

/** SSE：id 行 + data 行 + 空行分帧，data 是版本化 JSON。 */
function sseBody(runId, frames) {
  return frames.map((frame) => `id: ${runId}:${frame.seq}\ndata: ${JSON.stringify({
    v: 1,
    run_id: runId,
    seq: frame.seq,
    type: frame.type,
    at: "2026-10-26T02:20:00.000Z",
    data: frame.data,
  })}\n\n`).join("");
}

// 流式场景：1 个 tool_status(running) + 2 个 answer_delta，**故意不发终态**（body 直接结束）。
const STREAM_FRAMES = [
  { seq: 1, type: "tool_status", data: { tool: "order_query", operation: "search_orders", status: "running" } },
  { seq: 2, type: "answer_delta", data: { text: "## 最近销售订单\n\n" } },
  { seq: 3, type: "answer_delta", data: { text: "最近 7 天共有 **3 张**销售订单处于推进中，其中 SO-2026-0158 已进入组装工序，SO-2026-0173 已完成出货。" } },
];

// ---------------------------------------------------------------------------
// /api/v1/** 统一 mock。dataKind 决定这次页面看到的是哪一套数据。
// ---------------------------------------------------------------------------
function createMock(dataKind) {
  const conversationRuns = [RUN_SALES, RUN_PRODUCTION];
  return async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const method = request.method();
    const json = (data, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({ data, meta: {} }),
    });
    const sse = (body) => route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      body,
    });

    // GET /auth/me（AppShell 每次路由都读）
    if (path === "/auth/me" && method === "GET") return json(PROFILE);

    // GET /business-query/sessions
    if (path === "/business-query/sessions" && method === "GET") {
      const sessions = dataKind === "history" ? [SESSION_1, SESSION_2] : [SESSION_1];
      return json({ sessions });
    }

    // POST /business-query/sessions（新建会话）
    if (path === "/business-query/sessions" && method === "POST") return json({ session_id: "s-2" }, 201);

    // GET /business-query/sessions/:id（快照）
    const snapshotMatch = path.match(/^\/business-query\/sessions\/([^/]+)$/);
    if (snapshotMatch && method === "GET") {
      const id = decodeURIComponent(snapshotMatch[1]);
      if (id === "s-1") {
        if (dataKind === "empty") return json({ session_id: "s-1", runs: [] });
        if (dataKind === "streaming") return json({ session_id: "s-1", runs: [RUN_STREAMING] });
        if (dataKind === "error") return json({ session_id: "s-1", runs: [RUN_FAILED] });
        return json({ session_id: "s-1", runs: conversationRuns });
      }
      if (id === "s-2") return json({ session_id: "s-2", runs: [RUN_HISTORY_S2] });
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "SESSION_NOT_FOUND", message: "会话不存在", details: [] }, meta: {} }) });
    }

    // POST /business-query/sessions/:id/runs（提问，202）
    if (/^\/business-query\/sessions\/[^/]+\/runs$/.test(path) && method === "POST") {
      return json({ run_id: "r-9", state: "planning" }, 202);
    }

    // GET /business-query/runs/:id/events（SSE）
    if (/^\/business-query\/runs\/[^/]+\/events$/.test(path) && method === "GET") {
      const runId = decodeURIComponent(path.match(/^\/business-query\/runs\/([^/]+)\/events$/)[1]);
      if (dataKind === "streaming" && runId === "r-live") return sse(sseBody(runId, STREAM_FRAMES));
      return sse("");
    }

    // POST /business-query/runs/:id/cancel
    if (/^\/business-query\/runs\/[^/]+\/cancel$/.test(path) && method === "POST") {
      return json({ state: "cancelled" });
    }

    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_MOCKED", message: `未 mock 的请求：${method} ${path}`, details: [] }, meta: {} }) });
  };
}

// ---------------------------------------------------------------------------
// 页面实测：一次 evaluate 取回全部断言数字
// ---------------------------------------------------------------------------
async function collectFacts(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const round = (value) => Math.round(value * 10) / 10;
      return { x: round(box.x), y: round(box.y), top: round(box.top), left: round(box.left), right: round(box.right), bottom: round(box.bottom), width: round(box.width), height: round(box.height) };
    };
    const style = (element, property) => (element ? getComputedStyle(element)[property] : null);
    const scroll = document.querySelector('[data-testid="agent-scroll"]');
    const composerWrap = document.querySelector(".agent-composer-wrap");
    const composer = document.querySelector(".agent-composer");
    const inputBox = document.querySelector(".agent-input-box");
    const input = document.querySelector('[data-testid="agent-input"]');
    const submit = document.querySelector('[data-testid="business-query-submit"]');
    const cancel = document.querySelector('[data-testid="business-query-cancel"]');
    const sendLike = cancel ?? submit;
    const topbar = document.querySelector(".topbar");
    const sidebar = document.querySelector(".sidebar");
    const contentArea = document.querySelector('[data-testid="app-main"]');
    const thread = document.querySelector('[data-testid="agent-thread"]');
    const tables = [...document.querySelectorAll('[data-testid="agent-markdown-table"]')].map((element, index) => ({
      index,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      internalHorizontalScroll: element.scrollWidth > element.clientWidth,
      rect: rect(element),
    }));
    const userMessages = [...document.querySelectorAll('[data-testid="agent-message-user"]')];
    const assistantMessages = [...document.querySelectorAll('[data-testid="agent-message-assistant"]')];
    const suggestions = [...document.querySelectorAll('[data-testid="agent-suggestion"]')];
    const toolSteps = [...document.querySelectorAll('[data-testid="agent-tool-step"]')];
    const sources = [...document.querySelectorAll(".agent-source")];
    const historyItems = [...document.querySelectorAll('[data-testid="agent-history-item"]')];
    const businessError = document.querySelector('[data-testid="business-query-error"]');
    const answer = document.querySelector('[data-testid="business-query-answer"]');
    const toolbarHome = document.querySelector('[data-testid="agent-toolbar-home"]');
    const toolbarHomeVisible = (() => {
      if (!toolbarHome) return false;
      const box = toolbarHome.getBoundingClientRect();
      return getComputedStyle(toolbarHome).display !== "none" && box.width > 0 && box.height > 0;
    })();
    const caret = document.querySelector('[data-testid="agent-stream-caret"]');
    const markdown = document.querySelector('[data-testid="agent-markdown"]');
    const paragraphs = markdown ? [...markdown.querySelectorAll(".agent-md-p")] : [];
    const lastParagraph = paragraphs.length ? paragraphs[paragraphs.length - 1] : null;

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      document: {
        scrollingElementScrollHeight: document.scrollingElement.scrollHeight,
        scrollingElementClientHeight: document.scrollingElement.clientHeight,
        documentElementScrollWidth: document.documentElement.scrollWidth,
        documentElementClientWidth: document.documentElement.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight,
        verticalOverflow: document.scrollingElement.scrollHeight - window.innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
      },
      agentScroll: scroll ? {
        clientHeight: scroll.clientHeight,
        scrollHeight: scroll.scrollHeight,
        scrollTop: scroll.scrollTop,
        overflowY: getComputedStyle(scroll).overflowY,
        rect: rect(scroll),
      } : null,
      layout: {
        topbar: rect(topbar),
        sidebar: rect(sidebar),
        contentArea: rect(contentArea),
        thread: rect(thread),
        composerWrap: rect(composerWrap),
        composer: rect(composer),
        inputBox: rect(inputBox),
        input: rect(input),
        sendLike: rect(sendLike),
        sendTestId: cancel ? "business-query-cancel" : submit ? "business-query-submit" : null,
        scrollBottom: rect(document.querySelector('[data-testid="agent-scroll-bottom"]')),
      },
      inViewport: {
        input: input ? (rect(input).top >= 0 && rect(input).bottom <= window.innerHeight + 0.5) : false,
        sendLike: sendLike ? (rect(sendLike).top >= 0 && rect(sendLike).bottom <= window.innerHeight + 0.5) : false,
        composer: composerWrap ? (rect(composerWrap).top >= 0 && rect(composerWrap).bottom <= window.innerHeight + 0.5) : false,
        topbar: topbar ? (rect(topbar).top >= 0 && rect(topbar).left >= 0 && rect(topbar).width > 0 && rect(topbar).height > 0) : false,
        sidebar: sidebar ? (rect(sidebar).top >= 0 && rect(sidebar).left >= 0 && rect(sidebar).width > 0 && rect(sidebar).height > 0) : false,
        contentArea: contentArea ? (rect(contentArea).bottom <= window.innerHeight + 0.5 && rect(contentArea).width > 0) : false,
      },
      overlap: {
        // 消息区下沿不应该压到底部输入区；底部输入区应该在工作区最底部。
        scrollBottomVsComposerTop: scroll && composerWrap ? Math.round((rect(scroll).bottom - rect(composerWrap).top) * 10) / 10 : null,
        composerBottomVsViewport: composerWrap ? Math.round((window.innerHeight - rect(composerWrap).bottom) * 10) / 10 : null,
      },
      counts: {
        userMessages: userMessages.length,
        assistantMessages: assistantMessages.length,
        suggestions: suggestions.length,
        tables: tables.length,
        toolSteps: toolSteps.length,
        sources: sources.length,
        copyButtons: document.querySelectorAll('[data-testid="agent-copy"]').length,
        retryButtons: document.querySelectorAll('[data-testid="agent-retry"]').length,
        historyItems: historyItems.length,
      },
      texts: {
        welcomeTitle: document.querySelector(".agent-empty-title")?.textContent ?? null,
        welcomeSub: document.querySelector(".agent-empty-sub")?.textContent ?? null,
        suggestionTexts: suggestions.map((element) => element.textContent?.trim() ?? ""),
        userTexts: userMessages.map((element) => element.textContent?.trim() ?? ""),
        phaseLabel: document.querySelector('[data-testid="business-query-phase"]')?.textContent?.trim() ?? null,
        inputStatus: document.querySelector('[data-testid="agent-input-status"]')?.textContent?.trim() ?? null,
        toolStepSummaries: toolSteps.map((element) => element.querySelector(".agent-tool-label")?.textContent?.trim() ?? ""),
        sourceLabels: sources.map((element) => element.textContent?.trim() ?? ""),
        businessError: businessError?.textContent?.trim() ?? null,
        answerSample: answer ? (answer.textContent ?? "").slice(0, 240) : null,
        historyItemTitles: historyItems.map((element) => element.querySelector(".agent-history-item-title")?.textContent?.trim() ?? ""),
        historyItemMeta: historyItems.map((element) => element.querySelector(".agent-history-item-meta")?.textContent?.trim() ?? ""),
        displayName: document.querySelector('[data-testid="user-menu-account"]')?.textContent?.trim() ?? null,
      },
      styles: {
        // AI 正文必须无气泡背景（transparent）；用户气泡是浅色底。
        assistantAnswerBackgrounds: assistantMessages.map((element) => style(element.querySelector(".agent-answer"), "backgroundColor")),
        assistantMessageBackgrounds: assistantMessages.map((element) => style(element, "backgroundColor")),
        userBubbleBackgrounds: userMessages.map((element) => style(element.querySelector(".agent-bubble-user"), "backgroundColor")),
        userBubbleRects: userMessages.map((element) => rect(element.querySelector(".agent-bubble-user"))),
        assistantAnswerRects: assistantMessages.map((element) => rect(element.querySelector(".agent-answer"))),
        assistantMessageRects: assistantMessages.map((element) => rect(element)),
        assistantAvatarBackgrounds: assistantMessages.map((element) => style(element.querySelector(".agent-avatar"), "backgroundColor")),
        threadMaxWidth: style(thread, "maxWidth"),
        inputBorderRadius: style(inputBox, "borderRadius"),
        sendBorderRadius: style(sendLike, "borderRadius"),
      },
      tables,
      historyDialog: (() => {
        const dialog = document.querySelector('[data-testid="agent-history-dialog"]');
        return dialog ? { visible: true, rect: rect(dialog) } : { visible: false, rect: null };
      })(),
      shell: {
        sidebarDisplay: style(sidebar, "display"),
        topbarDisplay: style(topbar, "display"),
        toolbarHome: toolbarHome ? { display: style(toolbarHome, "display"), visible: toolbarHomeVisible, rect: rect(toolbarHome) } : null,
        toolbarTitle: rect(document.querySelector(".agent-toolbar-title")),
        toolbarActions: rect(document.querySelector(".agent-toolbar-actions")),
      },
      streaming: {
        caret: Boolean(caret),
        caretRect: rect(caret),
        lastParagraphRect: rect(lastParagraph),
        caretInLastParagraph: Boolean(caret && lastParagraph && lastParagraph.contains(caret)),
        answerRect: rect(answer),
        pending: Boolean(document.querySelector('[data-testid="agent-answer-pending"]')),
        cancelButton: Boolean(document.querySelector('[data-testid="business-query-cancel"]')),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// 场景执行
// ---------------------------------------------------------------------------
const checks = [];
function must(condition, name, detail) {
  checks.push({ name, ok: Boolean(condition), detail: detail ?? null, required: true });
  if (!condition) throw new Error(`断言失败：${name}${detail ? `（${JSON.stringify(detail)}）` : ""}`);
}
function soft(condition, name, detail) {
  checks.push({ name, ok: Boolean(condition), detail: detail ?? null, required: false });
}

async function capture(browser, { name, viewport, dataKind, after }) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    serviceWorkers: "block", // 不走真实 sw.js：它的 fetch 透传会绕过 page.route，导致 mock 失效
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(String(error?.stack ?? error)));

  const requestLog = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/")) requestLog.push(`${request.method()} ${new URL(request.url()).pathname.replace("/api/v1", "")}`);
  });

  await page.route("**/api/v1/**", createMock(dataKind));

  const checksBefore = checks.length;
  const startedAt = Date.now();
  await page.goto(`${BASE}/business-query`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.locator('[data-testid="page-business-query"]').waitFor({ state: "visible", timeout: 120000 });

  let afterError = null;
  if (after) {
    try {
      await after(page);
    } catch (error) {
      afterError = error instanceof Error ? error.message : String(error);
    }
  }

  // 布局稳定后再量（贴底/弹窗都写在 setTimeout / rAF 里）
  await page.waitForTimeout(350);
  let facts = null;
  const screenshotPath = path.join(OUT_DIR, `${name}.png`);
  try {
    facts = await collectFacts(page);
    await page.screenshot({ path: screenshotPath, animations: "disabled" });
  } catch (error) {
    afterError = afterError ?? (error instanceof Error ? error.message : String(error));
  }

  if (facts) {
    // 页面级通用断言：整页不滚、不横溢、输入框不被裁（每个场景都记录一次，桌面/窄屏各一份）。
    soft(facts.document.verticalOverflow <= 1, "整页不可滚动（scrollHeight - innerHeight ≤ 1）", {
      scrollHeight: facts.document.scrollingElementScrollHeight,
      innerHeight: facts.viewport.height,
      diff: facts.document.verticalOverflow,
    });
    soft(Math.abs(facts.document.horizontalOverflow) <= 1, "无横向溢出（scrollWidth - innerWidth ≤ 1）", {
      scrollWidth: facts.document.documentElementScrollWidth,
      innerWidth: facts.viewport.width,
      diff: facts.document.horizontalOverflow,
    });
    if (facts.layout.input) soft(facts.layout.input.bottom <= facts.viewport.height + 0.5, "输入框底边 ≤ innerHeight", facts.layout.input);
    // 响应式外壳：桌面侧栏必须还在；≤720px 只对对话页隐藏侧栏并给出「回工作台」。
    if (facts.viewport.width >= 900) {
      soft(facts.shell.sidebarDisplay !== "none" && facts.inViewport.topbar, "桌面侧栏未被误伤且顶栏可见", { sidebarDisplay: facts.shell.sidebarDisplay, topbar: facts.layout.topbar });
      soft(facts.shell.toolbarHome?.display === "none", "桌面不显示「回工作台」入口", facts.shell.toolbarHome);
    } else {
      soft(facts.shell.sidebarDisplay === "none", "窄屏 ERP 侧栏隐藏（display=none）", { sidebarDisplay: facts.shell.sidebarDisplay });
      soft(facts.shell.toolbarHome?.visible === true, "窄屏「回工作台」入口可见", facts.shell.toolbarHome);
    }
  }

  const scenarioChecks = checks.splice(checksBefore);
  if (afterError) scenarioChecks.push({ name: "场景执行", ok: false, detail: afterError, required: true });
  const result = {
    name,
    screenshot: screenshotPath,
    viewport,
    facts,
    checks: scenarioChecks,
    consoleErrors,
    pageErrors,
    requestLog,
    afterError,
    elapsedMs: Date.now() - startedAt,
  };
  await context.close();
  return result;
}

/** 单个场景失败不阻断后续场景：异常也落成一条失败记录继续往下跑。 */
async function runScenario(browser, spec) {
  try {
    return await capture(browser, spec);
  } catch (error) {
    return {
      name: spec.name,
      screenshot: null,
      viewport: spec.viewport,
      facts: null,
      checks: [{ name: "场景运行", ok: false, detail: String(error?.stack ?? error), required: true }],
      consoleErrors: [],
      pageErrors: [],
      requestLog: [],
      afterError: String(error?.message ?? error),
      elapsedMs: 0,
    };
  }
}

function waitForConversationReady(page) {
  return page.locator('[data-testid="agent-message-assistant"]').nth(1).waitFor({ state: "visible", timeout: 60000 });
}

async function run() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(path.dirname(RESULTS_JSON), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    // A. 空态（runs: []）
    results.push(await runScenario(browser, {
      name: "desktop-empty",
      viewport: DESKTOP,
      dataKind: "empty",
      after: async (page) => {
        await page.locator('[data-testid="agent-welcome"]').waitFor({ state: "visible", timeout: 60000 });
        const facts = await collectFacts(page);
        must(facts.texts.welcomeTitle === "今天有什么可以帮您？", "空态标题文案", facts.texts.welcomeTitle);
        must(facts.texts.welcomeSub === "查询订单、追踪生产进度、了解采购与库存情况", "空态副标题文案", facts.texts.welcomeSub);
        must(facts.counts.suggestions === 4, "空态推荐问题 4 张", facts.counts.suggestions);
        must(facts.counts.assistantMessages === 0 && facts.counts.userMessages === 0, "空态没有消息", facts.counts);
        must(facts.inViewport.input && facts.inViewport.sendLike, "输入框与发送按钮在视口内", facts.inViewport);
        must(facts.document.verticalOverflow <= 1 && facts.document.horizontalOverflow <= 1, "桌面空态整页不滚/无横向溢出", facts.document);
        must(facts.shell.sidebarDisplay === "block" && facts.inViewport.topbar, "桌面空态：侧栏显示、顶栏可见", { sidebarDisplay: facts.shell.sidebarDisplay, topbar: facts.layout.topbar });
      },
    }));

    // B. 对话态：2 个 completed run
    results.push(await runScenario(browser, {
      name: "desktop-conversation",
      viewport: DESKTOP,
      dataKind: "conversation",
      after: async (page) => {
        await waitForConversationReady(page);
        const facts = await collectFacts(page);
        must(facts.counts.userMessages === 2, "2 条用户消息", facts.counts.userMessages);
        must(facts.counts.assistantMessages === 2, "2 条 AI 回复", facts.counts.assistantMessages);
        must(facts.texts.userTexts[0] === "最近有哪些销售订单？", "第一条问题文案", facts.texts.userTexts);
        must(facts.texts.userTexts[1] === "哪些生产任务即将延期？", "第二条问题文案", facts.texts.userTexts);
        must(facts.counts.tables >= 1, "回答里有 Markdown 表格", facts.counts.tables);
        must(facts.counts.sources >= 5, "回答下方有来源 chips", facts.counts.sources);
        must(facts.counts.copyButtons === 2, "每条完成回复都有复制按钮", facts.counts.copyButtons);
        must(facts.counts.retryButtons === 0, "已完成回复不显示重试", facts.counts.retryButtons);
        must(facts.inViewport.composer && facts.inViewport.input && facts.inViewport.sendLike, "输入区与发送按钮在视口内", facts.inViewport);
        must(facts.inViewport.topbar && facts.inViewport.sidebar, "顶栏与侧栏可见", { inViewport: facts.inViewport, topbar: facts.layout.topbar, sidebar: facts.layout.sidebar, viewport: facts.viewport });
        must(facts.shell.sidebarDisplay === "block", "桌面侧栏仍显示（未被窄屏规则误伤）", { display: facts.shell.sidebarDisplay, rect: facts.layout.sidebar });
        must(facts.shell.toolbarHome?.display === "none", "桌面不显示「回工作台」入口", facts.shell.toolbarHome);
        // Lead 指定的关键验收 1：桌面长对话整页不滚，只有消息区滚。
        must(facts.document.verticalOverflow <= 1, "整页不可滚动（scrollHeight - innerHeight ≤ 1）", {
          scrollHeight: facts.document.scrollingElementScrollHeight,
          innerHeight: facts.viewport.height,
          diff: facts.document.verticalOverflow,
        });
        must(facts.agentScroll && facts.agentScroll.clientHeight > 0, "消息区 clientHeight > 0", facts.agentScroll);
        must(facts.agentScroll && facts.agentScroll.scrollHeight > facts.agentScroll.clientHeight, "消息区 scrollHeight > clientHeight（内容在消息区内部滚）", facts.agentScroll);
        // Lead 指定的关键验收 2：用户气泡右对齐、AI 正文左侧不是气泡（量 boundingBox）。
        const thread = facts.layout.thread;
        const bubbleRects = facts.styles.userBubbleRects;
        must(thread !== null && bubbleRects.length === 2 && bubbleRects.every((box) => box && Math.abs(thread.right - box.right) <= 2), "用户气泡右对齐（右边贴 thread 右边）", { threadRight: thread?.right, bubbleRights: bubbleRects.map((box) => box?.right) });
        const answerRects = facts.styles.assistantAnswerRects;
        const messageRects = facts.styles.assistantMessageRects;
        must(thread !== null && messageRects.length === 2 && messageRects.every((box) => box && Math.abs(box.left - thread.left) <= 2), "AI 消息块左对齐 thread 左边", { threadLeft: thread?.left, messageLefts: messageRects.map((box) => box?.left) });
        must(answerRects.length === 2 && thread !== null && answerRects.every((box) => box && Math.abs((box.left - thread.left) - 40) <= 2), "AI 正文左侧不是气泡（正文左 = thread 左 + 40px）", {
          threadLeft: thread?.left,
          answerLefts: answerRects.map((box) => box?.left),
          offsets: answerRects.map((box) => (box && thread ? Math.round((box.left - thread.left) * 10) / 10 : null)),
        });
        // AI 正文不是气泡
        const answerBgs = facts.styles.assistantAnswerBackgrounds;
        must(answerBgs.length === 2 && answerBgs.every((bg) => bg === "rgba(0, 0, 0, 0)"), "AI 正文无气泡背景", answerBgs);
        must(facts.styles.userBubbleBackgrounds.every((bg) => bg !== "rgba(0, 0, 0, 0)"), "用户消息是浅色气泡", facts.styles.userBubbleBackgrounds);
      },
    }));

    // C. 回看历史：滚到顶部后出现「回到底部」
    results.push(await runScenario(browser, {
      name: "desktop-scrolled",
      viewport: DESKTOP,
      dataKind: "conversation",
      after: async (page) => {
        await waitForConversationReady(page);
        await page.locator('[data-testid="agent-scroll"]').evaluate((element) => { element.scrollTop = 0; });
        await page.locator('[data-testid="agent-scroll-bottom"]').waitFor({ state: "visible", timeout: 10000 });
        const facts = await collectFacts(page);
        must(facts.agentScroll && facts.agentScroll.scrollTop === 0, "消息区已滚到顶部", facts.agentScroll);
        must(facts.agentScroll && facts.agentScroll.scrollHeight > facts.agentScroll.clientHeight, "内容仍高于可视区", facts.agentScroll);
        must(facts.layout.scrollBottom !== null, "出现「回到底部」按钮", facts.layout.scrollBottom);
        must(facts.layout.scrollBottom && facts.layout.scrollBottom.bottom <= facts.viewport.height && facts.layout.scrollBottom.top >= 0, "「回到底部」在视口内", facts.layout.scrollBottom);
      },
    }));

    // D. 流式：tool_status(running) + 2 个 answer_delta，无终态
    results.push(await runScenario(browser, {
      name: "desktop-streaming",
      viewport: DESKTOP,
      dataKind: "streaming",
      after: async (page) => {
        await page.locator('[data-testid="agent-tool-step"]').waitFor({ state: "visible", timeout: 60000 });
        await page.locator('[data-testid="agent-stream-caret"]').waitFor({ state: "visible", timeout: 60000 });
        await page.getByText("最近 7 天共有").first().waitFor({ state: "visible", timeout: 60000 });
        const facts = await collectFacts(page);
        must(facts.streaming.cancelButton, "运行中显示停止按钮", facts.layout.sendTestId);
        must(facts.texts.toolStepSummaries.some((summary) => summary === "正在查询销售订单"), "折叠步骤摘要「正在查询销售订单」", facts.texts.toolStepSummaries);
        must(facts.counts.toolSteps === 1, "执行步骤卡 1 张（折叠）", facts.counts.toolSteps);
        must(facts.streaming.caret, "流式光标可见", facts.streaming);
        // Lead 指定的关键验收：光标挂在最后一个段落末尾，不再单独占一行。
        must(facts.streaming.caretInLastParagraph, "流式光标在最后一个段落内（不再单独占一行）", {
          caretRect: facts.streaming.caretRect,
          lastParagraphRect: facts.streaming.lastParagraphRect,
          caretParent: facts.streaming.caretInLastParagraph ? "last .agent-md-p" : "not-in-paragraph",
        });
        must(facts.streaming.caretRect !== null && facts.streaming.lastParagraphRect !== null
          && facts.streaming.caretRect.top >= facts.streaming.lastParagraphRect.top - 1
          && facts.streaming.caretRect.bottom <= facts.streaming.lastParagraphRect.bottom + 1, "光标 rect 纵向落在最后段落范围内（与正文同一行）", {
          caretRect: facts.streaming.caretRect,
          lastParagraphRect: facts.streaming.lastParagraphRect,
        });
        must(facts.counts.userMessages === 1 && facts.counts.assistantMessages === 1, "1 问 1 答", facts.counts);
        must(facts.texts.phaseLabel === "正在回答…" || facts.texts.phaseLabel === "连接中断，正在恢复…", "底部阶段文案是运行中/恢复中", facts.texts.phaseLabel);
        must(facts.inViewport.sendLike, "停止按钮在视口内", facts.inViewport);
      },
    }));

    // E. 失败态：state=failed + AGENT_RUN_TIMEOUT
    results.push(await runScenario(browser, {
      name: "desktop-error",
      viewport: DESKTOP,
      dataKind: "error",
      after: async (page) => {
        await page.locator('[data-testid="business-query-error"]').waitFor({ state: "visible", timeout: 60000 });
        await page.locator('[data-testid="agent-retry"]').waitFor({ state: "visible", timeout: 10000 });
        const facts = await collectFacts(page);
        must(facts.texts.businessError?.includes("AGENT_RUN_TIMEOUT"), "显示未完成原因（含错误码）", facts.texts.businessError);
        must(facts.counts.retryButtons === 1, "显示「重试」按钮", facts.counts.retryButtons);
        must(facts.counts.copyButtons === 1, "部分答案仍可复制", facts.counts.copyButtons);
        must(facts.streaming.cancelButton === false, "失败后不再是停止按钮", facts.streaming);
      },
    }));

    // F. 历史记录弹窗（列表 2 条 + 各会话首问标题）
    results.push(await runScenario(browser, {
      name: "desktop-history",
      viewport: DESKTOP,
      dataKind: "history",
      after: async (page) => {
        await waitForConversationReady(page);
        await page.getByTestId("agent-history-open").click();
        await page.locator('[data-testid="agent-history-list"]').waitFor({ state: "visible", timeout: 60000 });
        const facts = await collectFacts(page);
        must(facts.counts.historyItems === 2, "历史弹窗 2 条会话", facts.counts.historyItems);
        must(facts.texts.historyItemTitles[0] === "最近有哪些销售订单？", "第一条标题取首问", facts.texts.historyItemTitles);
        must(facts.texts.historyItemTitles[1] === "帮我汇总本月采购情况。", "第二条标题取首问", facts.texts.historyItemTitles);
        must(facts.historyDialog.visible, "历史弹窗可见", facts.historyDialog);
        must(facts.historyDialog.rect && facts.historyDialog.rect.width > 0 && facts.historyDialog.rect.height > 0, "弹窗有实际尺寸", facts.historyDialog.rect);
        must(facts.historyDialog.rect && facts.historyDialog.rect.top >= 0 && facts.historyDialog.rect.bottom <= facts.viewport.height, "弹窗在视口内", facts.historyDialog.rect);
      },
    }));

    // G. 窄屏空态
    results.push(await runScenario(browser, {
      name: "mobile-empty",
      viewport: MOBILE,
      dataKind: "empty",
      after: async (page) => {
        await page.locator('[data-testid="agent-welcome"]').waitFor({ state: "visible", timeout: 60000 });
        const facts = await collectFacts(page);
        must(facts.texts.welcomeTitle === "今天有什么可以帮您？", "窄屏空态标题", facts.texts.welcomeTitle);
        must(facts.counts.suggestions === 4, "窄屏空态 4 张推荐卡", facts.counts.suggestions);
        must(facts.inViewport.input && facts.inViewport.sendLike, "窄屏输入框与发送按钮在视口内", facts.inViewport);
        must(facts.shell.sidebarDisplay === "none", "窄屏 ERP 侧栏隐藏（display=none）", { display: facts.shell.sidebarDisplay, rect: facts.layout.sidebar });
        must(facts.shell.toolbarHome?.visible === true, "窄屏「回工作台」入口可见", facts.shell.toolbarHome);
        must(facts.shell.toolbarTitle !== null && facts.shell.toolbarActions !== null && facts.shell.toolbarTitle.right <= facts.shell.toolbarActions.left, "窄屏工具栏标题与动作不重叠", { title: facts.shell.toolbarTitle, actions: facts.shell.toolbarActions });
        // Lead 指定的关键验收 3：窄屏无横向溢出 + 输入框不被裁掉。
        must(facts.document.documentElementScrollWidth <= 391, "窄屏无横向溢出（scrollWidth ≤ 390+1）", {
          scrollWidth: facts.document.documentElementScrollWidth,
          innerWidth: facts.viewport.width,
          diff: facts.document.horizontalOverflow,
        });
        must(facts.document.verticalOverflow <= 1, "窄屏整页不滚动（scrollHeight - innerHeight ≤ 1）", {
          scrollHeight: facts.document.scrollingElementScrollHeight,
          innerHeight: facts.viewport.height,
          diff: facts.document.verticalOverflow,
        });
        must(facts.layout.input !== null && facts.layout.input.bottom <= facts.viewport.height + 0.5, "窄屏输入框底边 ≤ innerHeight（不被裁掉）", facts.layout.input);
      },
    }));

    // G. 窄屏对话态
    results.push(await runScenario(browser, {
      name: "mobile-conversation",
      viewport: MOBILE,
      dataKind: "conversation",
      after: async (page) => {
        await waitForConversationReady(page);
        const facts = await collectFacts(page);
        must(facts.counts.userMessages === 2 && facts.counts.assistantMessages === 2, "窄屏 2 问 2 答", facts.counts);
        must(facts.counts.tables >= 1, "窄屏回答含表格", facts.counts.tables);
        must(facts.inViewport.composer && facts.inViewport.input && facts.inViewport.sendLike, "窄屏输入区在视口内", facts.inViewport);
        must(facts.styles.assistantAnswerBackgrounds.every((bg) => bg === "rgba(0, 0, 0, 0)"), "窄屏 AI 正文不是气泡", facts.styles.assistantAnswerBackgrounds);
        // Lead 指定的关键验收：390px 下侧栏退场、对话占满宽度、不再「一字一行」。
        must(facts.shell.sidebarDisplay === "none", "窄屏 ERP 侧栏隐藏（display=none）", { display: facts.shell.sidebarDisplay, rect: facts.layout.sidebar });
        must(facts.shell.toolbarHome?.visible === true, "窄屏「回工作台」入口可见", facts.shell.toolbarHome);
        must(facts.agentScroll && facts.agentScroll.clientHeight > 300, "窄屏消息区 clientHeight > 300（不再被 232px 侧栏压成一条）", facts.agentScroll);
        must(facts.styles.assistantAnswerRects.length === 2 && facts.styles.assistantAnswerRects.every((box) => box && box.width > 250), "窄屏正文宽度 > 250px（不再一字一行）", facts.styles.assistantAnswerRects);
        must(facts.shell.toolbarTitle !== null && facts.shell.toolbarActions !== null && facts.shell.toolbarTitle.right <= facts.shell.toolbarActions.left, "窄屏工具栏标题与动作不重叠", { title: facts.shell.toolbarTitle, actions: facts.shell.toolbarActions });
        // Lead 指定的关键验收 3：窄屏无横向溢出 + 输入框不被裁掉 + 宽表内部横滑。
        must(facts.document.documentElementScrollWidth <= 391, "窄屏无横向溢出（scrollWidth ≤ 390+1）", {
          scrollWidth: facts.document.documentElementScrollWidth,
          innerWidth: facts.viewport.width,
          diff: facts.document.horizontalOverflow,
        });
        must(facts.document.verticalOverflow <= 1, "窄屏整页不滚动（scrollHeight - innerHeight ≤ 1）", {
          scrollHeight: facts.document.scrollingElementScrollHeight,
          innerHeight: facts.viewport.height,
          diff: facts.document.verticalOverflow,
        });
        must(facts.layout.input !== null && facts.layout.input.bottom <= facts.viewport.height + 0.5, "窄屏输入框底边 ≤ innerHeight（不被裁掉）", facts.layout.input);
        must(facts.tables.some((table) => table.internalHorizontalScroll), "窄屏宽表在表格内部横向滚动（不撑破页面）", facts.tables);
        const thread = facts.layout.thread;
        const answerRects = facts.styles.assistantAnswerRects;
        must(thread !== null && answerRects.length === 2 && answerRects.every((box) => box && Math.abs((box.left - thread.left) - 40) <= 2), "窄屏 AI 正文左侧不是气泡（正文左 = thread 左 + 40px）", {
          threadLeft: thread?.left,
          answerLefts: answerRects.map((box) => box?.left),
        });
      },
    }));
  } finally {
    await browser.close();
  }

  const report = { base: BASE, generatedAt: new Date().toISOString(), results };
  await writeFile(RESULTS_JSON, JSON.stringify(report, null, 2), "utf8");
  printSummary(report);
  return report;
}

function printSummary(report) {
  console.log(`\nbase=${report.base}`);
  for (const result of report.results) {
    console.log(`\n=== ${result.name} (${result.viewport.width}x${result.viewport.height}) -> ${result.screenshot}`);
    if (!result.facts) {
      console.log(`  NO FACTS; afterError=${result.afterError}`);
      continue;
    }
    const facts = result.facts;
    const doc = facts.document;
    const scroll = facts.agentScroll;
    console.log(`  page scrollHeight/innerHeight = ${doc.scrollingElementScrollHeight}/${facts.viewport.height} (diff ${doc.verticalOverflow})`);
    console.log(`  page scrollWidth/innerWidth  = ${doc.documentElementScrollWidth}/${facts.viewport.width} (diff ${doc.horizontalOverflow})`);
    console.log(`  agent-scroll clientHeight/scrollHeight/scrollTop = ${scroll ? `${scroll.clientHeight}/${scroll.scrollHeight}/${scroll.scrollTop}` : "n/a"}`);
    console.log(`  input bottom<=vh=${facts.inViewport.input} submit/cancel bottom<=vh=${facts.inViewport.sendLike} topbar=${facts.inViewport.topbar} sidebar=${facts.inViewport.sidebar}`);
    console.log(`  tables wrap clientWidth/scrollWidth = ${facts.tables.map((table) => `${table.clientWidth}/${table.scrollWidth}${table.internalHorizontalScroll ? "(内部横滑)" : ""}`).join(", ") || "none"}`);
    const bubbleRights = (facts.styles.userBubbleRects ?? []).map((box) => box?.right);
    const answerLefts = (facts.styles.assistantAnswerRects ?? []).map((box) => box?.left);
    console.log(`  thread.left/right=${facts.layout.thread?.left}/${facts.layout.thread?.right} userBubbleRights=${JSON.stringify(bubbleRights)} aiAnswerLefts=${JSON.stringify(answerLefts)}`);
    console.log(`  input=${JSON.stringify(facts.layout.input)} sendLike=${JSON.stringify(facts.layout.sendLike)}`);
    console.log(`  counts=${JSON.stringify(facts.counts)}`);
    console.log(`  assistantAnswerBg=${JSON.stringify(facts.styles.assistantAnswerBackgrounds)} userBubbleBg=${JSON.stringify(facts.styles.userBubbleBackgrounds)}`);
    console.log(`  sidebar.display=${facts.shell.sidebarDisplay} topbar.display=${facts.shell.topbarDisplay} toolbarHome=${JSON.stringify(facts.shell.toolbarHome)}`);
    console.log(`  assistantAnswerWidths=${JSON.stringify((facts.styles.assistantAnswerRects ?? []).map((box) => box?.width))}`);
    if (facts.streaming.caretRect) console.log(`  caretRect=${JSON.stringify(facts.streaming.caretRect)} lastParagraphRect=${JSON.stringify(facts.streaming.lastParagraphRect)} caretInLastParagraph=${facts.streaming.caretInLastParagraph}`);
    if (facts.texts.phaseLabel) console.log(`  phaseLabel=${facts.texts.phaseLabel}`);
    if (facts.texts.toolStepSummaries.length) console.log(`  toolSteps=${JSON.stringify(facts.texts.toolStepSummaries)}`);
    if (facts.texts.businessError) console.log(`  businessError=${facts.texts.businessError}`);
    if (facts.texts.historyItemTitles.length) console.log(`  historyTitles=${JSON.stringify(facts.texts.historyItemTitles)}`);
    const failed = result.checks.filter((check) => !check.ok);
    if (result.afterError) console.log(`  afterError=${result.afterError}`);
    console.log(`  checks: ${result.checks.length - failed.length}/${result.checks.length} ok${failed.length ? `; FAILED=${JSON.stringify(failed)}` : ""}`);
    console.log(`  consoleErrors=${result.consoleErrors.length} pageErrors=${result.pageErrors.length}`);
    if (result.consoleErrors.length) console.log(`    console: ${JSON.stringify(result.consoleErrors.slice(0, 10))}`);
    if (result.pageErrors.length) console.log(`    pageerror: ${JSON.stringify(result.pageErrors.slice(0, 10))}`);
  }
}

run().then((report) => {
  const failed = report.results.flatMap((result) => result.checks.filter((check) => !check.ok));
  if (failed.length) process.exitCode = 1;
}).catch((error) => {
  console.error("VISUAL CHECK FAILED:", error);
  process.exitCode = 1;
});

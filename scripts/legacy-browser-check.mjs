// 旧浏览器兼容性的**真实浏览器**验证（2026-11-21）。
//
// 与 `test/legacy-compat.test.tsx` 的分工：
//   · 那个测试用沙箱验证 polyfill 的逻辑正确；
//   · 这个测试用真实 Chromium 打开**真实构建产物**，在"删掉新 API"的页面里
//     验证 ① 不白屏 ② polyfill 真的把 API 补回来了 ③ 登录接口真的能通。
//
// 三种场景（对应用户报的三种现场）：
//   1. Chrome 102 级（有 AbortController，缺 AbortSignal.timeout/any）—— 目标：**完全可用**
//   2. Chrome 80 级（再缺 at/hasOwn/replaceAll/groupBy/toSorted）—— 目标：**完全可用**
//   3. IE 级（连 fetch/Promise 都没有）—— 目标：**不白屏，显示中文换浏览器提示**
//
// 运行：node scripts/legacy-browser-check.mjs
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.LEGACY_CHECK_BASE ?? "http://127.0.0.1:3002";

/** 模拟"缺某些 API"的浏览器：在页面任何脚本执行前删掉这些能力。 */
const stripApis = {
  // Chrome 102：有 AbortController，但没有 AbortSignal.timeout(103)/any(116)
  chrome102: `
    delete AbortSignal.timeout;
    delete AbortSignal.any;
  `,
  // Chrome 80：再缺一批 2020 年之后才有的方法
  chrome80: `
    delete AbortSignal.timeout;
    delete AbortSignal.any;
    delete Array.prototype.at;
    delete String.prototype.at;
    delete Object.hasOwn;
    delete Array.prototype.findLast;
    delete Array.prototype.findLastIndex;
    delete String.prototype.replaceAll;
    delete Object.groupBy;
    delete Array.prototype.toSorted;
    delete Array.prototype.toReversed;
    delete Array.prototype.toSpliced;
    delete Array.prototype.with;
    delete Promise.withResolvers;
    delete URL.canParse;
  `,
  // IE 级：连底座都没有 → 应当显示提示而不是白屏
  ie: `
    delete AbortSignal.timeout;
    delete AbortSignal.any;
    delete window.fetch;
  `,
};

const results = [];

async function checkScenario(browser, name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  // 关键：addInitScript 在页面脚本之前执行，等效于"这个浏览器天生缺这些 API"
  await page.addInitScript(stripApis[name]);

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 60_000 });

  const state = await page.evaluate(() => {
    const notice = document.querySelector('[data-dilee-compat="unsupported"]');
    return {
      // polyfill 是否真的把 API 补回来了
      hasTimeout: typeof AbortSignal.timeout === "function",
      hasAny: typeof AbortSignal.any === "function",
      hasAt: typeof [].at === "function",
      hasHasOwn: typeof Object.hasOwn === "function",
      hasReplaceAll: typeof "".replaceAll === "function",
      hasGroupBy: typeof Object.groupBy === "function",
      hasToSorted: typeof [].toSorted === "function",
      // 页面是否真的渲染出了内容（而不是白屏）
      bodyTextLength: (document.body?.innerText ?? "").trim().length,
      noticeShown: !!notice,
      noticeText: notice ? notice.innerText.slice(0, 120) : null,
      missing: window.__dileeCompatMissing ?? null,
    };
  });

  results.push({ scenario: name, ...state, consoleErrors: consoleErrors.length, consoleErrorSamples: consoleErrors.slice(0, 6), pageErrors: pageErrors.length });

  // 场景 3 需要断言"显示了提示且提示里有换浏览器指引"
  if (name === "ie") {
    if (!state.noticeShown) throw new Error("[ie] 应当显示不支持提示，实际没有（会变成白屏）");
    if (!/换一个浏览器|Edge|Chrome/.test(state.noticeText ?? "")) throw new Error("[ie] 提示里缺少换浏览器指引");
  } else {
    if (state.noticeShown) throw new Error(`[${name}] 误报为不支持浏览器：${state.noticeText}`);
    if (state.bodyTextLength < 10) throw new Error(`[${name}] 页面正文为空（白屏）`);
    if (!state.hasTimeout) throw new Error(`[${name}] AbortSignal.timeout 未被补回 —— 所有接口都会失败`);
    if (!state.hasAny) throw new Error(`[${name}] AbortSignal.any 未被补回`);
    if (name === "chrome80") {
      for (const key of ["hasAt", "hasHasOwn", "hasReplaceAll", "hasGroupBy", "hasToSorted"]) {
        if (!state[key]) throw new Error(`[chrome80] ${key} 未被补回`);
      }
    }
    // 关键业务验证：在"缺 AbortSignal.timeout"的页面里，带该信号的真实请求必须发得出去。
    // 默认打同源的静态清单（本地无 API 也能跑通）；部署后可传 LEGACY_CHECK_PROBE 打真实登录接口。
    const probePath = process.env.LEGACY_CHECK_PROBE ?? "/login";
    const expectStatus = Number(process.env.LEGACY_CHECK_EXPECT ?? 200);
    const loginOk = await page.evaluate(async ({ path, expect }) => {
      try {
        const res = await fetch(path, {
          credentials: "include",
          cache: "no-store",
          // 故意用 AbortSignal.timeout —— 这正是旧浏览器缺的 API，
          // 也是 api-client 每次请求都在用的东西
          signal: AbortSignal.timeout(5000),
        });
        return { status: res.status, ok: res.status === expect };
      } catch (e) {
        return { error: String(e) };
      }
    }, { path: probePath, expect: expectStatus });
    results[results.length - 1].loginProbe = loginOk;
    if (loginOk.error) throw new Error(`[${name}] 带 AbortSignal.timeout 的请求失败：${loginOk.error}`);
    if (!loginOk.ok) throw new Error(`[${name}] 探针 ${probePath} 预期 ${expectStatus}，实际 ${loginOk.status}`);
  }

  await context.close();
}

const browser = await chromium.launch();
try {
  for (const name of ["chrome102", "chrome80", "ie"]) {
    await checkScenario(browser, name);
    console.log(`  ✔ ${name}`);
  }
} finally {
  await browser.close();
}

console.log("\n=== 明细 ===");
for (const r of results) {
  console.log(
    `  ${r.scenario.padEnd(10)} 白屏=${r.bodyTextLength < 10 ? "是" : "否"} ` +
    `提示=${r.noticeShown ? "有" : "无"} ` +
    `timeout=${r.hasTimeout ? "✓" : "✗"} any=${r.hasAny ? "✓" : "✗"} ` +
    `console错误=${r.consoleErrors} page错误=${r.pageErrors}` +
    (r.loginProbe ? ` 登录探针=${r.loginProbe.status ?? r.loginProbe.error}` : "")
  );
}
console.log("\n✅ 三种旧浏览器场景全部通过");
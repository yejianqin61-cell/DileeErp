#!/usr/bin/env node
// 抓财务接口的基线：阶段 6 换 join 之前存一份，换完再抓一份，逐字段比。
//
// 为什么不在 SQL 层比：报表口径在服务端算（分摊、币种、已过账口径都在代码里），
// 表行没变不代表报表数字没变。只有接口响应能证明「数字没变」。
//
// 用法（先把 API 指向快照库跑起来）：
//   node scripts/snapshot/capture-finance-baseline.mjs before
//   node scripts/snapshot/capture-finance-baseline.mjs after
// 环境变量：BASE_URL（默认 http://127.0.0.1:3101/api/v1）、BASELINE_USER、BASELINE_PASSWORD
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3101/api/v1";
const USER = process.env.BASELINE_USER ?? "baseline-laoban";
const PASSWORD = process.env.BASELINE_PASSWORD ?? "Baseline#2026";
const label = process.argv[2] ?? "before";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 财务 JSON 接口：全部无路径参数，`page`/`pageSize` 用服务端默认。 */
const JSON_ENDPOINTS = [
  "finance/reports/sales-reconciliation-detail",
  "finance/reports/purchase-reconciliation-detail",
  "finance/reports/sales-reconciliation-summary",
  "finance/reports/sales-gross-profit",
  "finance/reports/cost-accounting",
  "finance/reports/cash-flow-detail",
  "finance/reports/cash-flow-summary",
  "finance/reports/forex-receipts",
  "finance/reports/balance-sheet",
  "finance/reports/income-statement",
  "finance/reports/cash-flow-statement",
  "finance/receivable-sources",
  "finance/customer-payments",
  "finance/order-summary",
  "finance/receivable-order-summary",
  "finance/receivable-adjustments",
  "finance/reconciliations",
  "finance/order-close-preview",
  "finance/supplier-payments",
  "finance/payable-order-summary",
  "finance/supplier-payable-reconciliations",
  "finance/payable-entries",
  "finance/banks",
  "finance/banks/balances",
  "finance/bank-transfers",
  "finance/cash-flow-entries",
  "finance/exchange-rates",
  "finance/accounting-subjects",
  "finance/accounting-subjects/categories",
  "finance/opening-balances",
  "finance/overhead-allocations",
  "finance/overhead-allocations/resolved?period=2026-10",
  "finance/vouchers",
  "finance/slips",
];

/** 二进制导出：只记 sha256 与字节数，内容不落盘。 */
const BINARY_ENDPOINTS = [
  "finance/reports/sales-reconciliation-detail.xlsx",
  "finance/reports/purchase-reconciliation-detail.xlsx",
  "finance/reports/sales-reconciliation-summary.xlsx",
  "finance/reports/sales-gross-profit.xlsx",
  "finance/reports/cost-accounting.xlsx",
  "finance/reports/cash-flow-detail.xlsx",
  "finance/reports/cash-flow-summary.xlsx",
  "finance/reports/forex-receipts.xlsx",
  "finance/reports/balance-sheet.xlsx",
  "finance/reports/income-statement.xlsx",
  "finance/reports/cash-flow-statement.xlsx",
  "finance/payable-entries.xlsx",
  "finance/receivable-sources.xlsx",
];

async function login() {
  const response = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASSWORD }),
  });
  if (!response.ok) throw new Error(`登录失败 ${response.status}：${await response.text()}`);
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length === 0) throw new Error("登录成功但没有拿到 Set-Cookie");
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function captureJson(cookie, path) {
  const response = await fetch(`${BASE}/${path}`, { headers: { cookie } });
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* 保留原文，方便看错误页 */ }
  return { status: response.status, body };
}

/**
 * 二进制导出：xlsx 里既有生成时间（docProps/core.xml），表头也常写「导出时间」，
 * 整文件哈希与 sheet XML 哈希都不稳定。这里只留结构指纹：工作表数量与行数总和。
 * 数值口径由同源 JSON 接口负责对照，导出件只证明「行列没塌」。
 */
async function captureBinary(cookie, path) {
  const response = await fetch(`${BASE}/${path}`, { headers: { cookie } });
  const buffer = Buffer.from(await response.arrayBuffer());
  let sheets = 0;
  let rows = 0;
  if (response.status === 200 && buffer.length > 0) {
    const zip = await JSZip.loadAsync(buffer);
    const sheetNames = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
    sheets = sheetNames.length;
    for (const name of sheetNames) {
      const xml = await zip.files[name].async("string");
      rows += (xml.match(/<row /g) ?? []).length;
    }
  }
  return { status: response.status, sheets, rows };
}

const cookie = await login();
const results = {};
for (const path of JSON_ENDPOINTS) results[path] = await captureJson(cookie, path);
for (const path of BINARY_ENDPOINTS) results[path] = await captureBinary(cookie, path);

const out = {
  label,
  captured_at: new Date().toISOString(),
  base_url: BASE,
  user: USER,
  endpoints: results,
};
const target = join(root, "docs", "test", "baselines", `finance-${label}.json`);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(out, null, 2), "utf8");

const failed = Object.entries(results).filter(([, value]) => value.status !== 200);
console.log(`已写入 ${target}`);
console.log(`接口 ${Object.keys(results).length} 个，非 200 的 ${failed.length} 个`);
for (const [path, value] of failed) console.log(`  ${value.status}  ${path}`);

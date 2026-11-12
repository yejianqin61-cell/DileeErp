// 销售单「Excel 补录」的纯函数测试（node:test，不是 vitest —— 纯函数按仓库约定走 node --test）。
//
// 这几句话是用户点「确认建立销售单」之前唯一会看的判定：
//   · 错误与提醒要分开（有 error 时按钮后面那句"待修正 N 项"必须出现，否则用户以为都填好了）；
//   · 汇总里「待修正 0 项」也要说出来（0 是"可以建单"的信号，省掉就变成了没有信号）；
//   · 文件在前端就要挡住扩展名与体积（后端还会再挡，但让用户先看到人话）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SALES_ORDER_IMPORT_ACCEPT, SALES_ORDER_IMPORT_MAX_BYTES, SALES_ORDER_IMPORT_PATH,
  importFailureMessage, importFileProblem, importIssueSplit, importOutcome, importSummaryText, readableSize,
} from "./sales-order-import.ts";

const issues = [
  { level: "warning", field: "unit", message: "单位不在清单里" },
  { level: "error", field: "order_no", message: "订单号已被占用" },
];

test("上传端点带 /api/v1 前缀，白名单只放行 Excel", () => {
  assert.equal(SALES_ORDER_IMPORT_PATH, "/api/v1/sales-orders/import-preview");
  assert.equal(SALES_ORDER_IMPORT_ACCEPT, ".xlsx,.xls");
  assert.equal(SALES_ORDER_IMPORT_MAX_BYTES, 10 * 1024 * 1024, "与控制器 limits.fileSize 同一个数");
});

test("待修正项拆分：错误在前（error 不修就建不了单）", () => {
  const split = importIssueSplit(issues);
  assert.deepEqual(split.errors.map((item) => item.field), ["order_no"]);
  assert.deepEqual(split.warnings.map((item) => item.field), ["unit"]);
});

test("汇总：认出多少、明细多少、追加多少、没认出多少、待修正几项", () => {
  const text = importSummaryText({
    summary: { recognized: 31, detail_rows: 12, extra_rows: 2, fills: 20, missing: [] },
    issues: issues,
    unrecognized: [{ where: "A4", text: "加大货样各1支" }],
  });
  assert.equal(text, "读出 31 处字段 · 细分明细 12 行 · 材料追加 2 行 · 1 处没认出 · 待修正 1 项");
});

test("汇总：没有明细/追加/未认出时省掉那几段，但「待修正 0 项」必须留着", () => {
  const text = importSummaryText({ summary: { recognized: 8, detail_rows: 0, extra_rows: 0, fills: 8, missing: [] }, issues: [], unrecognized: [] });
  assert.equal(text, "读出 8 处字段 · 待修正 0 项");
});

test("结论档位：只有提醒 = ready，有 error = blocked", () => {
  assert.equal(importOutcome({ issues: issues }), "blocked");
  assert.equal(importOutcome({ issues: [issues[0]] }), "ready");
  assert.equal(importOutcome({ issues: [] }), "ready");
});

test("文件预检：扩展名、体积、没选文件都给一句人话", () => {
  assert.equal(importFileProblem(null), "请选择要补录的 Excel 文件");
  assert.match(importFileProblem({ name: "订单.csv", size: 10 }), /只支持 \.xlsx \/ \.xls/);
  assert.match(importFileProblem({ name: "订单.xlsx", size: SALES_ORDER_IMPORT_MAX_BYTES + 1 }), /超过 10MB/);
  assert.equal(importFileProblem({ name: "订单.xlsx", size: 1024 }), "");
  assert.equal(importFileProblem({ name: "旧单.XLS", size: 1024 }), "", "扩展名大小写不敏感");
});

// ---------------------------------------------------------------- 上传失败说清是哪一种失败
//
// 2026-11-12 真实事故：1.5MB 的销售单 .xls 被 nginx 的 client_max_body_size 默认值（1m）
// 在转发之前回了 413（HTML 错误页），请求根本没到 API。页面当时只有一句兜底的「读取失败」，
// 于是用户被指向"文件可能损坏"，而病灶在网关 —— 这几条用例钉住「不同的失败必须说不同的话」。

test("413 必须说「网关挡下的体积问题」，并带上这份文件多大（不能再说成文件损坏）", () => {
  const message = importFailureMessage({ status: 413, fileSize: 1520128 });
  assert.match(message, /太大/);
  assert.match(message, /1\.4MB/, "要把这份文件的实际体积（1,520,128 字节）写出来，用户才知道该压缩还是该找管理员");
  assert.match(message, /client_max_body_size/, "必须点名网关那个配置项，否则运维只能从「读取失败」开始猜");
  assert.doesNotMatch(message, /损坏/, "413 与文件损坏无关，这句提示必须彻底分开");
});

test("401/403 说权限与登录，不要把鉴权失败说成读取失败", () => {
  assert.match(importFailureMessage({ status: 401 }), /登录已失效/);
  assert.match(importFailureMessage({ status: 403 }), /没有补录权限/);
  assert.match(importFailureMessage({ status: 403, serverMessage: "缺少 sales 模块权限" }), /缺少 sales 模块权限/, "有服务端原话就用原话");
});

test("网关 5xx 说「稍后重试」，不把它和业务校验失败混在一起", () => {
  assert.match(importFailureMessage({ status: 504 }), /暂时不可用（HTTP 504）/);
  assert.match(importFailureMessage({ status: 502 }), /请稍后重试/);
});

test("有业务信封就用服务端那句话（例如「没认出任何销售单字段」）", () => {
  assert.equal(importFailureMessage({ status: 422, serverMessage: "这张表里没认出任何销售单字段" }), "这张表里没认出任何销售单字段");
});

test("没有业务信封时兜底也必须带状态码（下次能从界面看出是 403 还是 500）", () => {
  const message = importFailureMessage({ status: 500 });
  assert.match(message, /HTTP 500/);
  assert.match(message, /没有返回可识别的错误内容/);
});

test("体积文案：KB/MB 两种档位，别把 300KB 写成 0.3MB", () => {
  assert.equal(readableSize(300 * 1024), "300KB");
  assert.equal(readableSize(1572864), "1.5MB");
  assert.equal(readableSize(1520128), "1.4MB", "1,520,128 字节 ≈ 1.45MiB，保留一位小数");
  assert.equal(readableSize(undefined), "");
});

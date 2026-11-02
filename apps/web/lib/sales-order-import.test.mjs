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
  importFileProblem, importIssueSplit, importOutcome, importSummaryText,
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

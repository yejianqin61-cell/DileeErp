// 财务表格「一屏看全一行、不需要左右拖动」的源码守卫。
//
// 用户要求（2026-09-16）：「财务部分的表单，我希望能一次性在页面上展示全貌，不需要左右拖动条来拖动。」
// 用真实 Chromium + 真实 CSS 在 1366/1440/1600/1920 四个视口实测过（数字见 globals.css 的注释与
// docs/log），结论落在四条互相依赖的规则上。任何一条被改回去，最宽的那几张表就会重新出现横向滚动条，
// 所以这里把它们钉住 —— 这些是**排版约束**，类型检查与组件测试都发现不了。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const css = read("../app/globals.css");
const dialog = read("../components/finance/record-detail-dialog.tsx");

test("内容区上限放到 1920px：否则任何屏幕上表格可用宽度都被压在 1376px", () => {
  assert.match(css, /\.content-area \{ max-width: 1920px;/, "1440 上限会让 1920 屏的表格可用宽度只有 1376px");
});

test("财务表格紧凑：12px / 内边距 8px / 行高 38px", () => {
  assert.match(css, /\.finance-page \.data-table \{ font-size: 12px; font-variant-numeric: tabular-nums; \}/, "数字要等宽，金额才上下对齐");
  assert.match(css, /\.finance-page \.data-table th, \.finance-page \.data-table td \{ height: 38px; padding: 0 8px; \}/);
});

test("财务表格允许换行：这是「不横向滚动」的关键（nowrap 会让长客户名把整张表顶出容器）", () => {
  assert.match(css, /\.finance-page \.data-table th \{ font-size: 12px; white-space: normal;/, "表头也要能换行");
  assert.match(css, /\.finance-page \.data-table td \{ white-space: normal; \}/);
  // 工资台账用的是 .ui-table，同样要放开：19 列，1366 屏上原本溢出 455px。
  assert.match(css, /\.finance-page \.payroll-sheet-table \.ui-table-cell \{ padding: 6px 8px; white-space: normal; \}/);
});

test("金额不会被换行拆开：money() 用不换行空格连接金额与币种", () => {
  assert.match(dialog, /return currency \? `\$\{amount\}\\u00a0\$\{currency\}` : String\(amount\);/, "普通空格会让「500.0000」和「USD」折到两行");
});

test("其它模块的表格不被牵连：紧凑与换行规则都限定在 .finance-page 内", () => {
  for (const rule of [".data-table { font-size: 12px", ".data-table td { white-space: normal; }"]) {
    const index = css.indexOf(rule);
    assert.notEqual(index, -1, `找不到规则：${rule}`);
    // 规则前 200 个字符内必须出现 .finance-page 选择器（即该规则是财务页限定的）
    assert.match(css.slice(Math.max(0, index - 200), index + rule.length), /\.finance-page/, `${rule} 必须限定在财务页`);
  }
  // 全站基础表格仍是 nowrap（生产/采购/仓库的表格各自调过密度，不受影响）
  assert.match(css, /\.data-table th, \.data-table td \{ height: 44px; padding: 0 14px; border-bottom: 1px solid var\(--border\); white-space: nowrap; \}/);
});

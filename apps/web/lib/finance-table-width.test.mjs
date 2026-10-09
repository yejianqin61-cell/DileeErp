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
const dataTable = read("../components/data/data-table.tsx");
const tablePrimitive = read("../components/ui/table.tsx");

test("内容区上限放到 1920px：否则任何屏幕上表格可用宽度都被压在 1376px", () => {
  assert.match(css, /\.content-area \{ max-width: 1920px;/, "1440 上限会让 1920 屏的表格可用宽度只有 1376px");
});

/**
 * 2026-09-20 用户第 3 条：「确认应付的表单，还需要左右滑动。争取直接完整展示，不再需要左右滑动」。
 *
 * 根因不是「规则不够」，而是**规则没生效**：DataTable 渲染出来的 `<table>` 带的是 `ui-table`
 * （`components/ui/table.tsx`），而上面那几条紧凑/换行规则只写了 `.finance-page .data-table` ——
 * `.data-table` 这个类在财务页根本不存在，于是单元格一直是 `.ui-table-cell` 的
 * `padding: 12px` + `white-space: nowrap`，最小宽度等于整段文本宽度，列多的表必然溢出容器。
 *
 * 所以下面除了钉住规则本身，还单独钉住「规则必须同时写到 `.ui-table` 上」。
 */
test("DataTable 用的是 .ui-table —— 财务页的排版规则必须同时写在这个类上", () => {
  assert.match(tablePrimitive, /className=\{cn\("ui-table", className\)\}/, "表格基础类的来源：改了这里，下面两条断言就要跟着改");
  assert.doesNotMatch(tablePrimitive, /"data-table"/, "基础表格类从来不是 .data-table（这正是规则失效的原因）");
  assert.match(dataTable, /<Table className=\{className\}/, "DataTable 除了这个可选类不再附加别的类名");
  assert.match(css, /\.finance-page \.data-table, \.finance-page \.ui-table \{ font-size: 12px; font-variant-numeric: tabular-nums; \}/, "紧凑规则必须同时命中 .ui-table");
  assert.match(css, /\.finance-page \.data-table td, \.finance-page \.ui-table-cell \{ white-space: normal; overflow-wrap: anywhere; \}/, "换行规则必须同时命中 .ui-table-cell");
});

test("财务表格紧凑：12px / 内边距 8px / 行高 38px", () => {
  assert.match(css, /\.finance-page \.data-table, \.finance-page \.ui-table \{ font-size: 12px; font-variant-numeric: tabular-nums; \}/, "数字要等宽，金额才上下对齐");
  assert.match(css, /\.finance-page \.data-table th, \.finance-page \.data-table td,\n\.finance-page \.ui-table-head, \.finance-page \.ui-table-cell \{ height: 38px; padding: 6px 8px; \}/);
});

test("财务表格允许换行：这是「不横向滚动」的关键（nowrap 会让长客户名把整张表顶出容器）", () => {
  assert.match(css, /\.finance-page \.data-table th, \.finance-page \.ui-table-head \{ font-size: 12px; white-space: normal;/, "表头也要能换行");
  assert.match(css, /\.finance-page \.data-table td, \.finance-page \.ui-table-cell \{ white-space: normal; overflow-wrap: anywhere; \}/, "长串（单号/UUID）也要能断行，否则同样把表顶宽");
  // 工资台账用的是 .ui-table，同样要放开：19 列，1366 屏上原本溢出 455px。
  assert.match(css, /\.finance-page \.payroll-sheet-table \.ui-table-cell \{ padding: 6px 8px; white-space: normal; \}/);
});

test("固定列宽 + 超长省略 + 悬停看全文（用户 2026-09-20 第 6 条；2026-09-27 起是**通用**规则）", () => {
  // 固定布局：不切 fixed 的话「列宽」只是建议值，长摘要照样把列撑宽。
  // 2026-09-27：这三条从 `.finance-page` 前缀里**提出来变成通用规则** —— 采购计划的 13 列表
  // （用户：「表单要保证一次性展示所有column」）也要这一套，而页面私有规则等于让下一个模块
  // 再抄一遍，抄歪了的表现是「某个页面没省略」（那三条注释自己就在警告这个坑）。
  // 只影响**自愿加入**的表：`data-table-fixed` 是 DataTable 在「有列给了 meta.width」时自己加的类。
  assert.match(css, /^\.ui-table\.data-table-fixed \{ table-layout: fixed; \}$/m);
  assert.match(css, /^\.data-table-fixed \.ui-table-head, \.data-table-fixed \.ui-table-cell \{ overflow: hidden; \}$/m);
  // 省略号规则的权重必须压过 `.finance-page .ui-table-cell { white-space: normal }`（否则静默失效：
  // 看起来只是「没省略」）—— 所以要叠到 (0,4,1)，不依赖样式表先后顺序。
  assert.match(css, /^\.ui-table\.data-table-fixed \.ui-table-cell\.cell-ellipsis,\n\.ui-table\.data-table-fixed \.ui-table-head\.cell-ellipsis \{ white-space: nowrap; text-overflow: ellipsis; \}$/m);
  // 财务页那几条更具体的规则**原样保留**（紧凑/换行仍在 .finance-page 内），所以财务四张表的
  // 行为一字未变；下面这条同时是"没被顺手删掉"的守卫。
  assert.match(css, /\.finance-page \.data-table td, \.finance-page \.ui-table-cell \{ white-space: normal; overflow-wrap: anywhere; \}/);
  // 只有「给了宽度」的表才切固定布局；列宽由 meta 决定，见 DataTable。
  assert.match(dataTable, /const fixed = columns\.some\(\(column\) => metaOf\(column\.meta\)\.width\);/, "有列宽才切固定布局");
  // 2026-10-08：第二个参数（这一格的值）不能省 —— 只写 `ellipsisTitle(rendered)` 时，
  // `accessorKey` 写法的文本列（没写 cell，TanStack 默认 cell 是函数 → flexRender 返回元素）
  // 永远算不出 title：省略号在、悬停却空白。物料清单页的「物料编码 / 物料名称」踩过这个坑。
  assert.match(dataTable, /title=\{meta\.ellipsis \? ellipsisTitle\(rendered, cell\.getValue\(\)\) : undefined\}/, "省略的单元格要带上原生 title（鼠标悬停显示全文）");
});

test("金额不会被换行拆开：money() 用不换行空格连接金额与币种", () => {
  assert.match(dialog, /return currency \? `\$\{amount\}\\u00a0\$\{currency\}` : String\(amount\);/, "普通空格会让「500.0000」和「USD」折到两行");
});

test("其它模块的表格不被牵连：紧凑与换行规则都限定在 .finance-page 内", () => {
  for (const rule of [".data-table, .finance-page .ui-table { font-size: 12px", ".ui-table-cell { white-space: normal; overflow-wrap: anywhere; }"]) {
    const index = css.indexOf(rule);
    assert.notEqual(index, -1, `找不到规则：${rule}`);
    // 规则前 200 个字符内必须出现 .finance-page 选择器（即该规则是财务页限定的）
    assert.match(css.slice(Math.max(0, index - 200), index + rule.length), /\.finance-page/, `${rule} 必须限定在财务页`);
  }
  // 全站基础表格仍是 nowrap（生产/采购/仓库的表格各自调过密度，不受影响）
  assert.match(css, /\.data-table th, \.data-table td \{ height: 44px; padding: 0 14px; border-bottom: 1px solid var\(--border\); white-space: nowrap; \}/);
  assert.match(css, /\.ui-table-cell \{ padding: 12px; vertical-align: middle; white-space: nowrap; \}/, "全站基础的 .ui-table-cell 保持原样");
});

// 「全站表格都受过列宽 / 省略治理」的**覆盖面守卫**（2026-10-09）。
//
// 为什么需要：这一轮治理把「列宽受限 + 超长省略 + hover 全文」从**逐列自愿加入**改成**默认**
// （`components/data/data-table.tsx` 一律给 `<table>` 加 `data-table-fixed`，见
// `docs/design/table-column-width-audit-2026-10-09.md` 第 7.1 节），所以 `<DataTable` 渲染的表自动受管。
// 但**手写**的 `<table>` / 共享 `<Table>` 原语永远拿不到那个默认 —— 它们必须显式挂
// `globals.css` 里的 `.table-bounded`，或者有自己的固定列宽 CSS，或者属于「可编辑网格 / 打印单据」这类
// 本来就不该套省略号的表（理由写在下面的清单里）。
//
// 这条守卫的直接起因是一次真实的漏审：给盘点划范围时把 `app/reorder/page.tsx` 漏在外面，
// 而它有 4 张手写表。当时是用「遍历所有含表格的文件、逐个比对盘点里有没有出现」的脚本查出来的；
// 现在把同一件事固化成断言，**以后新增一张手写表、或者新开一个没被归类的文件，这里立刻变红**，
// 不再依赖「人肉划分模块范围」。做法与 `lib/audit-columns-coverage.test.mjs` 同源：
// 按文件清点，不许有未分类项，白名单/分类项必须带理由。
//
// 运行：node --test lib/table-width-coverage.test.mjs（属于 npm run test:lib）
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

/** 表格原语自身：它们**定义**规则，不是被治理的对象。 */
const PRIMITIVES = new Set(["components/data/data-table.tsx", "components/ui/table.tsx"]);

/**
 * 手写表格已经挂上 `.table-bounded` 的文件（`路径 -> 说明`）。
 * 断言：文件里必须真的出现 `table-bounded`（1996 那种「注释里写了、代码里没挂」的假达标会变红）。
 */
const BOUNDED = {
  "app/procurement/orders/[id]/page.tsx": "采购单详情的「到货批次」小表（6 列）",
  "app/production/page.tsx": "生产页的「BOM 表入口」表（3 列）",
  "app/reorder/page.tsx": "返单页 4 张表：货号汇总 / 按币种毛利 / QC 合格率 / 批次清单",
  "app/warehouse/finished-goods-storage/page.tsx": "成品存量页的「按订单号收束」展开表（5 列）",
  "components/account/account-center.tsx": "账号管理表（6 列，用共享 Table 原语手写）",
  "components/finance/payable-merge-payment-dialog.tsx": "合并付款的逐行金额表（6 列）",
  "components/production/production-order-detail-page.tsx": "生产单详情的进度测量表（5 列）",
  "components/reorder/document-groups.tsx": "返单单据分组表（5 列）",
  "components/reorder/unassigned-panel.tsx": "待补录清单表（8 列）",
  "components/sales/production-sheet-export-dialog.tsx": "工艺单导出弹窗的图片勾选表（3 列）",
};

/**
 * 手写表格有自己的固定列宽 CSS 的文件（`路径 -> 断言用的标记`）。
 * 这些表比 `.table-bounded` 更早就有整套列宽规则（含实测依据），改成通用类反而是倒退。
 */
const OWN_LAYOUT = {
  "components/bom/bom-workbench.tsx": /<table className="data-table bom-table">/,
  "components/procurement/plan-detail-sheet.tsx": /className="data-table plan-draft-table"/,
};

/**
 * 有意**不**套省略号的文件（`路径 -> 理由`）。
 * 规矩：理由必须说明**这一类界面为什么不该有省略号**，不是「先跳过」。
 */
const EXEMPT = new Map(Object.entries({
  // 每格一个受控 <Input> / <Select>：`nowrap + overflow: hidden` 会把控件本身裁掉。
  "components/finance/payroll-sheet.tsx": "工资台账是单元格可编辑网格（每格 input），压窄/裁切会挤坏控件；已有 .payroll-sheet-table 整套列宽与吸顶表头",
  "components/production/daily-reports-panel.tsx": "工序日报草稿表与员工日报更正表都是录入网格（Select/Input），省略号对输入框无意义",
  "components/production/material-issues-panel.tsx": "领料草稿网格是可编辑录入表，单元格是控件；该文件的 DataTable 部分由默认固定布局管住",
  "components/production/material-slip-editor.tsx": "领料单/补料单编辑网格 13/9 列，已有 .material-slip-editor 的 max-width:240px + overflow:hidden + text-overflow:ellipsis（globals.css:459-471），不能改成 fixed 布局",
  "components/sales/sales-order-editor.tsx": "销售单细分明细每格一个受控 Input，压窄会挤坏输入框",
  // 打印/导出件：版式是对准纸样的，列宽由表格 own 的 CSS 决定，不是「内容超长要省略」的场景。
  "components/finance/bank-transfer-slip-editor.tsx": "跨行转账单正文与签字栏是打印件，版式照 example/财务/跨行转账单.html，.transfer-slip-table 已 table-layout:fixed",
  "components/finance/voucher-workspace.tsx": "记账凭证纸是打印/导出 PNG 用的版式件（.voucher-sheet-table），列宽服务纸样；该文件的 2 张 DataTable 已达标（见盘点已达标清单）",
  // AI 对话答案里的表格：列由模型当场生成，构建时不存在列定义，也不可能预先给每列宽度；
  // 对话阅读的正确做法是「表格自己横向滚」（用户要求「Markdown 表格应支持横向滚动」），
  // 塞进固定列宽 + 省略号会把答案裁成看不懂的样子。样式见 globals.css 的 .agent-md-table-wrap。
  "components/agent/agent-markdown.tsx": "AI 回答的 Markdown 表格由模型生成，列数与列宽构建时未知；按对话阅读要求用 .agent-md-table-wrap 横向滚动，不适用 ERP 数据表的列宽/省略号治理",
}));

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (entry.endsWith(".tsx")) found.push(full);
  }
  return found;
}

const rel = (file) => relative(webRoot, file).replaceAll("\\", "/");
const source = (file) => readFileSync(file, "utf8");

const files = [...walk(join(webRoot, "app")), ...walk(join(webRoot, "components"))].filter((file) => !PRIMITIVES.has(rel(file)));
/** 有手写表格的文件：`<table ` 或共享原语 `<Table>` / `<Table `。 */
const handWritten = files.filter((file) => /<table\s/.test(source(file)) || /<Table[\s>]/.test(source(file)));
/** 只渲染 DataTable 的文件：由 data-table.tsx 的默认值自动受管，不需要在这里逐个登记。 */
const dataTableOnly = files.filter((file) => /<DataTable\b/.test(source(file)) && !handWritten.includes(file));

test("每一个有手写表格的文件都必须被分类，不许有未分类项", () => {
  const unclassified = handWritten.map(rel).filter((path) => !(path in BOUNDED) && !(path in OWN_LAYOUT) && !EXEMPT.has(path)).sort();
  assert.deepEqual(
    unclassified,
    [],
    `以下文件有手写 <table>/<Table>，但既没挂 .table-bounded、也没有自己的固定列宽 CSS、也没进豁免清单：\n  ${unclassified.join("\n  ")}\n` +
      "处理办法：① 挂 .table-bounded + 每列宽度 + 长文本格 cell-ellipsis/title；或 ② 进 OWN_LAYOUT/EXEMPT 并写明理由（见 docs/design/table-column-width-audit-2026-10-09.md）。",
  );
});

test(".table-bounded 是**代码里**挂上的，不是只在注释里提一句", () => {
  for (const [path, why] of Object.entries(BOUNDED)) {
    const file = files.find((candidate) => rel(candidate) === path);
    assert.ok(file, `${path} 在 BOUNDED 里但文件不存在（改名或删除后要同步清理）：${why}`);
    assert.match(source(file), /table-bounded/, `${path}（${why}）列在 BOUNDED 里，但源码里找不到 class \`table-bounded\``);
  }
});

test("自己有列宽 CSS 的表：标记还在（改了类名这些 CSS 会静默失效）", () => {
  for (const [path, marker] of Object.entries(OWN_LAYOUT)) {
    const file = files.find((candidate) => rel(candidate) === path);
    assert.ok(file, `${path} 在 OWN_LAYOUT 里但文件不存在`);
    assert.match(source(file), marker, `${path} 的表格标记被改过了，对应的列宽 CSS 会静默失效`);
  }
});

test("豁免清单不得腐烂：每项都要有理由，且不得已经挂了 .table-bounded", () => {
  for (const [path, reason] of EXEMPT) {
    assert.ok(typeof reason === "string" && reason.trim().length >= 8, `${path} 的豁免理由太短，说不清为什么不需要省略号`);
    const file = files.find((candidate) => rel(candidate) === path);
    assert.ok(file, `${path} 在豁免清单里但文件不存在（改名或删除后要同步清理）`);
    assert.doesNotMatch(source(file), /table-bounded/, `${path} 已经挂了 .table-bounded，应从豁免清单移除（否则清单会越来越长、失去意义）`);
  }
});

test("三类清单互不重叠（同一个文件不许既豁免又达标记）", () => {
  const bounded = new Set(Object.keys(BOUNDED));
  const own = new Set(Object.keys(OWN_LAYOUT));
  const exempt = new Set(EXEMPT.keys());
  for (const path of bounded) assert.equal(own.has(path) || exempt.has(path), false, `${path} 同时在 BOUNDED 与另一类清单里`);
  for (const path of own) assert.equal(exempt.has(path), false, `${path} 同时在 OWN_LAYOUT 与豁免清单里`);
});

test("只渲染 DataTable 的文件同样受管：默认值不能被改回「有列宽才切固定布局」", () => {
  // 这条与 lib/finance-table-width.test.mjs 的那条互补：那里钉的是「class 无条件加上」，
  // 这里钉的是「这件事覆盖了绝大多数页面」—— 只渲染 DataTable 的文件有几十个，
  // 一旦默认值退回自愿加入制，它们全部会重新变宽（而没有任何测试会红）。
  assert.ok(dataTableOnly.length >= 30, `只渲染 DataTable 的文件只有 ${dataTableOnly.length} 个，明显少于预期（是不是把所有表都改回手写了？）`);
  const dataTable = source(join(webRoot, "components", "data", "data-table.tsx"));
  assert.match(dataTable, /const className = \["data-table-fixed", tableClassName \?\? ""\]\.filter\(Boolean\)\.join\(" "\);/, "DataTable 必须无条件挂上 data-table-fixed");
});

test("手写表的通用入口在 CSS 里还在（.table-bounded 那三条缺一不可）", () => {
  const css = readFileSync(join(webRoot, "app", "globals.css"), "utf8");
  // 固定布局：没有它，「列宽」只是建议值，长文本照样把列撑宽。
  assert.match(css, /^\.ui-table\.table-bounded, \.data-table\.table-bounded \{ table-layout: fixed; \}$/m, "缺 table-layout: fixed");
  // 裁切盒：没有它，text-overflow 不生效（省略号永远不出现）。
  assert.match(css, /^\.ui-table\.table-bounded \.ui-table-head, \.ui-table\.table-bounded \.ui-table-cell,\n\.data-table\.table-bounded th, \.data-table\.table-bounded td \{ overflow: hidden; \}$/m, "缺 overflow: hidden");
  // 省略号：`white-space: nowrap` 是 text-overflow 生效的前提。
  assert.match(css, /^\.ui-table\.table-bounded \.ui-table-head\.cell-ellipsis, \.ui-table\.table-bounded \.ui-table-cell\.cell-ellipsis,\n\.data-table\.table-bounded th\.cell-ellipsis, \.data-table\.table-bounded td\.cell-ellipsis \{ white-space: nowrap; text-overflow: ellipsis; \}$/m, "缺 text-overflow: ellipsis");
});

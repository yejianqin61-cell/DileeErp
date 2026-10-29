// 物料清单页（采购 → 物料清单，app/procurement/materials/page.tsx）的**列宽与省略**守卫。
//
// 用户 2026-10-08：「物料清单太宽了，表格所有列宽限定长度，超过就省略显示，鼠标hover才显示所有文字。
// 尽量保证所有column一次性展示。」
//
// 为什么这类要求要写成守卫：它们几乎全部落在 CSS 与 `meta` 上，而这两处都没有类型检查 ——
// 少一个 width、少一条 padding 覆盖，表现只是「那个页面看起来还是老样子 / 又开始横向滚动」，
// 测试一条都不会红。这与 `bom-table.test.mjs`（BOM 表）、`finance-table-width.test.mjs`（财务四表）
// 是同一种守卫。
//
// 下面的数字不是拍出来的：真实 Chromium 加载 `app/globals.css` + 这张表的真实 DOM，
// 在 1280/1366/1440/1600/1920 五个视口下量过（改前/改后对照表写在 globals.css 的注释里，
// 完整推导见 docs/design/materials-table-column-widths-2026-10-08.md）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (...parts) => readFileSync(join(webRoot, ...parts), "utf8");
// CSS 守卫按整行写正则（`... { overflow: hidden; }$`）：Windows 上 checkout 出来是 CRLF，
// 不归一化的话同一份代码在 Windows 上红、在 Linux 上绿 —— 这不是守卫，是平台抽奖。
const css = read("app", "globals.css").replace(/\r\n/g, "\n");
const page = read("app", "procurement", "materials", "page.tsx");
const auditColumns = read("components", "data", "audit-columns.tsx");

test("十列都有显式百分比宽度、总和正好 100%（少一列就轮到浏览器替它猜，长名字会再挤一次）", () => {
  const block = /const COLUMN_WIDTH = \{([\s\S]*?)\} as const;/.exec(page);
  assert.ok(block, "列宽必须集中写在 COLUMN_WIDTH 里：散在十个 meta 里就没法一眼看出总和");
  const widths = [...block[1].matchAll(/(\w+): "([\d.]+)%"/g)].map((match) => [match[1], Number(match[2])]);
  assert.equal(widths.length, 10, "物料清单是十列：物料编码 / 名称 / 规格型号 / 颜色 / 默认单位 / 图片 / 状态 / 创建人 / 最后修改人 / 操作");
  assert.equal(widths.reduce((sum, [, width]) => sum + width, 0), 100, "总和不是 100% 时少掉的那一份由浏览器自动分摊，长名字会重新把别的列挤窄");

  // 文本列要有足够宽度，否则一屏里全是被省略到只剩一两个字的格子；控件列要放得下按钮。
  const byName = new Map(widths);
  for (const column of ["materialCode", "materialName", "specificationModel", "color", "unit"]) {
    assert.ok(byName.get(column) >= 7, `文本列 ${column} 只拿到 ${byName.get(column)}%，一行里几乎看不到字`);
  }
  // 实测（globals.css 的注释里有完整表）：单行放下 40px 缩略图 +「换图」+「删除图片」需要 162px，
  // 「编辑 / 停用 / 删除」三个按钮需要 142px。1366 屏表宽 1034px，15% = 155px、13% = 134px ——
  // 这两个数是"宁可让按钮折成两行，也不把文本列压到看不清"取到的下限。
  assert.ok(byName.get("image") >= 15, `图片列 ${byName.get("image")}% 放不下缩略图 + 两个按钮`);
  assert.ok(byName.get("actions") >= 13, `操作列 ${byName.get("actions")}% 放不下三个按钮`);
});

test("文本列显式声明「省略 + hover 看全文」，控件列一个都不许声明", () => {
  // 五个文本列：宽度 + `ellipsis: true` 成对出现（`ellipsis` 是 DataTable 给**字符串格**加
  // `cell-ellipsis` 与原生 title 的唯一开关，见 components/data/data-table.tsx）。
  for (const [column, header] of [["materialCode", "物料编码"], ["materialName", "物料名称"], ["specificationModel", "规格型号"], ["color", "颜色"], ["unit", "默认单位"]]) {
    assert.match(
      page,
      new RegExp(`header: "${header}", meta: \\{ width: COLUMN_WIDTH\\.${column}, ellipsis: true \\}`),
      `${header}列少了 ellipsis: true —— 表现只是"这一列不省略"，靠眼睛几乎发现不了`,
    );
  }
  // 图片与操作两列装的是**控件**：先说不要 ellipsis（DataTable 的 title 只挑字符串格，
  // 给这两列加上只会让 `nowrap` 把折行后的按钮裁掉），再说这两列必须仍然有宽度。
  assert.match(page, /id: "image", header: "图片", meta: \{ width: COLUMN_WIDTH\.image \}/, "图片列不能带 ellipsis");
  assert.match(page, /id: "actions", header: "操作", meta: \{ width: COLUMN_WIDTH\.actions \}/, "操作列不能带 ellipsis");
});

test("两列审计信息也必须给宽度：它们不再靠 auditColumns() 的默认（无宽度）", () => {
  // `auditColumns()` 只给列定义、不给宽度。这张表任何一列缺宽度都会被 fixed 布局自动分摊，
  // 所以这里改用同一对工厂逐个挂 meta（字段与格式仍然只有一份，没有另写一套）。
  assert.match(page, /\{ \.\.\.createdByColumn<Reference>\(\), meta: \{ width: COLUMN_WIDTH\.auditCreated \} \}/);
  assert.match(page, /\{ \.\.\.updatedByColumn<Reference>\(\), meta: \{ width: COLUMN_WIDTH\.auditUpdated \} \}/);
  assert.equal(/\.\.\.auditColumns<Reference>\(\)/.test(page), false, "这张表要逐列给宽度，不能再用 auditColumns() 的默认列");
});

test("三张表都挂着 materials-page-table，CSS 才生效（类名一改这些规则静默失效）", () => {
  const occurrences = [...page.matchAll(/tableClassName="materials-page-table"/g)];
  assert.equal(occurrences.length, 3, "主表 + 批量导入结果的两张小表（未导入的行 / 已新增的物料）");
  assert.match(css, /^\.ui-table\.materials-page-table \{ font-size: 12px; \}$/m, "字号要写在 .ui-table 一起才有 (0,2,0) 权重");
  assert.match(css, /^\.materials-page-table \.ui-table-head, \.materials-page-table \.ui-table-cell \{ padding: 6px 8px; \}$/m);
});

test("审计格「姓名 + 次行小字时间」的意图只作用于本页（其它页面一个字都没变）", () => {
  // `auditActorCell` 的注释从 2026-09-16 起就写着两行，但全站一直没有对应 CSS，实际渲染成一行
  // （实测 88.1px，比本页 8% 列的内容盒 82.7 − 16 = 66.7px 宽，会被裁掉且没有 title 可看）。
  assert.match(css, /^\.materials-page-table \.audit-actor-cell \{ display: grid; gap: 1px; \}$/m);
  assert.match(css, /^\.materials-page-table \.audit-actor-time \{ color: var\(--text-muted\); font-size: 11px; \}$/m);
  assert.equal(/^\.audit-actor-cell \{/m.test(css), false, "写成全局规则会改掉另外几十张表的行高");
  // 被裁掉的那两段文字得有地方看：DataTable 的省略 title 只给字符串格，所以容器自己带 title。
  assert.match(auditColumns, /<div className="audit-actor-cell" title=\{time \? `\$\{actor\} \$\{time\}` : actor\}>/);
});

test("一次性展示靠的是通用那三条（固定布局 + 省略 + title），这里没有另起一套", () => {
  // 页面给了 meta.width → DataTable 自己给表加 data-table-fixed；下面这三条是 2026-09-27 起全站通用的。
  // 本页刻意不写 min-width：写了就等于在窄屏上换回横向滚动条，而用户要的正是「一次性展示」。
  assert.match(css, /^\.ui-table\.data-table-fixed \{ table-layout: fixed; \}$/m);
  assert.match(css, /^\.ui-table\.data-table-fixed \.ui-table-cell\.cell-ellipsis,\n\.ui-table\.data-table-fixed \.ui-table-head\.cell-ellipsis \{ white-space: nowrap; text-overflow: ellipsis; \}$/m);
  assert.equal(/\.materials-page-table[^{]*\{[^}]*min-width/m.test(css), false, "本页不许给表设 min-width（那会在窄屏上换回横向滚动）");
});

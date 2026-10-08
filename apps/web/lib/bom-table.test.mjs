// BOM 表的**列宽与悬浮页大小**守卫（用户 2026-10-08）。
//
// 用户原话：「1.BOM表页面，物料名称一长，后面的column就被压缩很窄。这很不好。我要求，扩大BOM表悬浮居中页面的
// 占页面大小，并且固定物料名称这一列的宽度。一旦字数超出，就省略显示，鼠标hover时显示全部文字。」
//
// 为什么这类要求要写成守卫：它们全部落在 CSS 里，而 CSS 没有类型检查 ——
// 少一条属性、选择器少一个类，表现只是"那个页面看起来还是老样子"，测试一条都不会红。
// 这与 `purchase-plan-table.test.mjs`、`warehouse-issue-sheet.test.mjs` 是同一种守卫。
//
// 下面的数字不是拍出来的：用真实 Chromium 加载 `app/globals.css` + 这张表的真实 DOM，
// 在 1024/1366/1440/1600/1920 五个视口下量过（改前/改后对照写在 globals.css 的注释里）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (...parts) => readFileSync(join(webRoot, ...parts), "utf8");
const css = read("app", "globals.css");
const component = read("components", "bom", "bom-workbench.tsx");

test("悬浮居中页确实放大了，而且不是靠样式表先后顺序赢的", () => {
  assert.match(
    css,
    /\.ui-sheet-content\.bom-workbench \{ width: min\(96vw, 1880px, calc\(100vw - 24px\)\); max-height: calc\(100vh - 24px\); \}/,
    "写回 min(80vw, 1280px) 就等于没放大",
  );
  // 反向的一半：把居中页压在 1280px 的是 `.ui-sheet-right`（(0,1,0)）。
  // 只写 `.bom-workbench`（同样 (0,1,0)）是在赌"我的规则排在它后面"——这个文件里已经栽过一次
  // （见 `.cell-ellipsis` 的注释：省略号静默失效）。所以必须用 (0,2,0) 的选择器。
  assert.equal(/^\.bom-workbench \{/m.test(css), false, "要写 .ui-sheet-content.bom-workbench");
  // 第三个参数是给窄屏的：96vw 在 375px 屏上比 100vw - 24px 还宽 9px，会把居中页顶出屏幕。
  assert.match(css, /@media \(max-width: 720px\)[\s\S]{0,400}ui-sheet-content/, "窄屏那条 media 仍要在（本条 min() 与它同解）");
});

test("那张表是固定布局，且组件上真的挂着 .bom-table（类名一改这些 CSS 就静默失效）", () => {
  assert.match(css, /\.bom-table \{ table-layout: fixed; min-width: 1180px; \}/, "没有 fixed，长物料名还会把列撑开");
  assert.match(component, /<table className="data-table bom-table">/);
});

test("九列都有显式百分比宽度、总和正好 100%（少一列就轮到浏览器替它猜，长名字会再挤一次）", () => {
  // 列清单从 JSX 里取，不从 CSS 里取：CSS 里漏写一列时"总和"照样能凑成 100%，
  // 而漏掉的那一列会被自动分摊 —— 那正是横滑/挤歪的入口。
  const used = new Set([...component.matchAll(/bom-col-([a-z]+)/g)].map((match) => match[1]));
  const widths = new Map([...css.matchAll(/\.bom-col-([a-z]+) \{ width: ([\d.]+)%; \}/g)].map((match) => [match[1], Number(match[2])]));

  assert.ok(used.size >= 9, "BOM 表是 序号/物料名称/型号/规格型号/颜色/数量/单位/供应商/操作 九列");
  for (const column of used) assert.ok(widths.has(column), `列 ${column} 没有显式百分比宽度（fixed 布局下会被自动分摊，挤歪别人）`);
  assert.equal([...widths.values()].reduce((sum, width) => sum + width, 0), 100, "总和不是 100% 就会横向滚动");

  // 为什么全是百分比、没有一个 px：生产侧不显示供应商列（少 17%），实测混入 px 时浏览器会把
  // 多余宽度整块塞给 px 那两列（1920 屏序号 48→208px、操作 56→243px），全百分比则按比例摊开。
  const material = widths.get("material");
  assert.ok(material >= 20, `物料名称列只拿到 ${material}%（它是本表最长的一列文本，得占最大的一份）`);
  for (const column of ["model", "spec", "color", "quantity"]) {
    assert.ok(widths.get(column) >= 8, `列 ${column} 太窄，行内输入框会看不到自己填的值`);
  }
});

test("物料名称列：超长省略 + hover 看全文（两条各管一半，缺一条都不成立）", () => {
  // ① 省略号：`min-width: 0` 不能省 —— `.ui-select-trigger` 是 flex 容器，里面的 Radix Value
  //    `<span>` 默认最小宽度是 min-content，只写 overflow/text-overflow 它照样把列撑开。
  assert.match(
    css,
    /\.bom-table \.bom-col-material \.ui-select-trigger \{ min-width: 0; \}/,
    "少了 min-width: 0，省略号永远不出现（列被撑开，其它列又被挤窄）",
  );
  assert.match(
    css,
    /\.bom-table \.bom-col-material \.ui-select-trigger > span \{ display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/,
  );
  // ② 被省略掉的字要有地方看：title 由组件给，而且必须取**触发器正在显示的那串字**。
  assert.match(component, /title=\{materialLabelOf\(row\.materialId\) \|\| undefined\}/);
  assert.match(component, /const materialLabelOf = \(materialId: string\) => materialOptions\.find\(\(option\) => option\.value === materialId\)\?\.label \?\? ""/);
});

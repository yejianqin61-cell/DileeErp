// 采购计划明细表的**可读性**守卫（用户 2026-09-30）。
//
// 用户原话：「采购物料那个表单高度太小了，可以高度大一点，这样视图更方便」。
// 这一页 13 列挤在一屏里，行高完全由「单元格内边距 + 行内控件高度」决定（表格没有写死 height），
// 所以把它们调回 4px / 30px 那种贴屏密度**不会有任何测试变红** —— 只有靠人肉眼看。
// 这里把它钉住，理由与 `warehouse-issue-sheet.test.mjs` 里那几条列宽守卫一样：
// 看得见的行为写在 CSS 里，而 CSS 没有类型检查。
//
// 另一条同样是"看着才知道"的口径：13 列的宽度总和必须是 100%。
// `table-layout: fixed` 下总和超过 100% 就是把表撑出容器 —— 那会牺牲掉用户要的「不横滑」。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (...parts) => readFileSync(join(webRoot, ...parts), "utf8");
const css = read("app", "globals.css");
const sheet = read("components", "procurement", "plan-detail-sheet.tsx");

test("计划明细表的行高与行内控件加高了（8px 内边距 + 34px 控件，不再是 4px/30px）", () => {
  assert.match(
    css,
    /\.purchase-plan-sheet\.material-issue-sheet \.data-table th,\s*\.purchase-plan-sheet\.material-issue-sheet \.data-table td \{ padding: 8px 6px; \}/,
    "表头与单元格的内边距决定行高，调小就退回贴屏密度",
  );
  assert.match(
    css,
    /\.purchase-plan-sheet\.material-issue-sheet \.data-table \.ui-input,\s*\.purchase-plan-sheet\.material-issue-sheet \.data-table \.ui-select-trigger \{ width: 100%; min-width: 0; height: 34px;/,
    "行内输入/下拉的高度是行高的另一半",
  );
});

test("每一列都有显式宽度、且总和正好 100%（少了或多了都会横滑）", () => {
  // 列清单**从 JSX 里取**，不从 CSS 里取：CSS 里少写一列的话，"总和 100%" 照样成立
  // （少的那列按 `table-layout: fixed` 自动分摊），而这正是横滑的入口。
  // 从 JSX 取还顺带让这条守卫对"以后加一列"（例如定价工作流的币种列）是良性的：
  // 加了列就必须给它宽度并重新配平，不需要改这里的数字。
  const used = new Set([...sheet.matchAll(/plan-col-([a-z]+)/g)].map((match) => match[1]));
  const widths = new Map([...css.matchAll(/\.plan-col-([a-z]+) \{ width: ([\d.]+)%;/g)].map((match) => [match[1], Number(match[2])]));

  assert.ok(used.size >= 13, "计划明细至少是那 13 列");
  for (const column of used) assert.ok(widths.has(column), `列 ${column} 没有显式宽度（fixed 布局下会被自动分摊，挤歪别人）`);
  assert.equal([...widths.values()].reduce((sum, width) => sum + width, 0), 100, "总和不是 100% 就会横向滚动");
});

test("那张表确实挂着 .purchase-plan-sheet（改了类名这些 CSS 会静默失效）", () => {
  assert.match(sheet, /className="material-issue-sheet purchase-plan-sheet"/);
});

test("按 BOM 参考单价预填的那一格有可见标记（浅黄底；文字说明在 title 与面板上）", () => {
  // 用户 2026-10-08 第二轮：「为什么BOM表保存了单价之后，采购计划显示不了单价，下单不了」——
  // 单价本来都是 0，一打开却有了数，**不标出来源就会被当成供应商报价**。
  // 这一列只有 6% 宽、塞不下文字标签，所以可见标记只有底色，文字放在 input 的 title 与表上方的面板说明里。
  assert.match(
    css,
    /\.purchase-plan-sheet\.material-issue-sheet \.data-table \.plan-price-from-bom \.ui-input \{ background: #fff8e8; border-color: #f0d69b; \}/,
    "少了这条，预填来的价与手填的价在屏幕上完全一样（来源就看不见了）",
  );
  assert.match(sheet, /plan-price-from-bom/);
  assert.match(sheet, /data-testid="plan-price-from-bom"/, "面板上那句说明也要在（颜色标记之外的文字说明）");
});

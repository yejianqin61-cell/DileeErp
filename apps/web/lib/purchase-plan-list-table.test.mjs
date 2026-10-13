// 采购计划列表的**列宽与展平**守卫（2026-10-13）。
//
// 用户原话：「采购计划的那个页面，也要显示物料名称等等 column。都要显示」。
//
// 为什么写成守卫（与 `materials-table-width.test.mjs`、`purchase-plan-table.test.mjs` 同源）：
// 「一行是什么」「每列多宽」全在 TSX 里，两处都没有类型检查 —— 少写一列宽度、总和不是 100%，
// 表现只是「又开始横向滚动 / 那一列被浏览器自动分摊」，测试一条都不会红。
//
// 运行：node --test lib/purchase-plan-list-table.test.mjs（属于 npm run test:lib）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const page = readFileSync(join(webRoot, "app", "procurement", "plans", "page.tsx"), "utf8");

/** 13 列，顺序即屏幕顺序（口径 7）。 */
const HEADERS = [
  "计划编号", "销售单号", "货号", "客户", "物料名称", "型号", "单位",
  "本次采购量", "单价", "行总价", "供应商", "下单状态", "预计到货",
];

test("十三列都有显式百分比宽度、总和正好 100%（少一列就轮到浏览器替它猜）", () => {
  // 列宽必须集中写在一处：散在十三个 meta 里就没人能一眼看出总和。
  const block = /const COLUMN_WIDTH = \{([\s\S]*?)\} as const;/.exec(page);
  assert.ok(block, "列宽必须集中写在 COLUMN_WIDTH 里");

  const widths = [...block[1].matchAll(/(\w+): "([\d.]+)%"/g)].map((match) => [match[1], Number(match[2])]);
  assert.equal(widths.length, 13, "展平后是十三列（一行 = 一条计划明细）");
  assert.equal(widths.reduce((sum, [, width]) => sum + width, 0), 100, "总和不是 100% 就会横向滚动，而用户要的正是「一屏看全」");
});

test("十三列的表头与顺序固定，物料名称在里面（用户点名要的那一列）", () => {
  const headers = [...page.matchAll(/header: "([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(headers, HEADERS);
  assert.ok(headers.includes("物料名称"), "用户 2026-10-13 点名的就是这一列");
});

test("每一列的 meta 都引用 COLUMN_WIDTH 常量（不许某一列自己写死宽度）", () => {
  const metas = [...page.matchAll(/meta: \{ width: ([^,}]+)/g)].map((match) => match[1].trim());

  assert.equal(metas.length, 13, "十三列都要显式宽度");
  for (const meta of metas) {
    assert.match(meta, /^COLUMN_WIDTH\.\w+$/, `列宽应走 COLUMN_WIDTH 常量，实际是 ${meta}（写死之后总和就没人管得住了）`);
  }
});

test("一行 = 一条明细：按 `lines[]` 展平，一份空计划补一行占位", () => {
  assert.match(page, /const lines = plan\.lines \?\? \[\];/, "展平的数据源是后端下发的 lines[]");
  assert.match(page, /out\.push\(\{ plan, line: null \}\)/, "一份被删空行的计划不能从列表里凭空消失 —— 它唯一的入口就是这一页");
});

test("计划级汇总不再单独成列（口径 7：它们挂在「计划编号」那一格的 title 上）", () => {
  const headers = [...page.matchAll(/header: "([^"]+)"/g)].map((match) => match[1]);

  for (const moved of ["行数", "未下单", "计划金额", "状态", "最后修改人"]) {
    assert.equal(headers.includes(moved), false, `${moved} 已改成挂在计划编号的 title 上（13 列里放不下 20 列）`);
  }
  assert.match(page, /title=\{planSummaryTitle\(row\.original\.plan\)\}/, "少了它，那几项就真的没有地方看了");
  for (const kept of ["未下单", "计划金额", "最后更新"]) {
    assert.ok(page.includes(kept), `title 里要留着「${kept}」`);
  }
});

test("下单状态那一格同时回答「有没有买」与「落在哪张单」", () => {
  // 13 列里没有位置再拆一列「采购单号」，而这两件事本来就是同一个问题的两半。
  assert.match(page, /row\.line\.ordered \? `已下单 \$\{row\.line\.purchaseOrderNo \?\? ""\}`\.trim\(\) : "未下单"/);
  assert.match(page, /data-testid="plan-open"/, "计划编号是唯一的入口（没有单独的「操作」列）");
});

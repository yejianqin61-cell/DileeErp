// 搜索下拉弹层的**长文字换行**守卫（用户 2026-09-30）。
//
// 用户原话：「销售单部分，引用库存的信息，如果页面不够展示，那就换行，而不是超出页面显示范围」
// （选中项：材料明细里「从物料清单引用」下拉的选项文字）。
//
// 那些 label 是「编码 / 名称 规格 颜色」四段拼起来的（`lib/sales-order-spec.ts` 的
// `materialOptionLabel`），长物料名在固定宽度的弹层里放不下。弹层是
// `left: 0; right: 0; overflow: auto`，而选项文字是个 flex 项（最小宽度 = min-content）：
// 既不换行也不收缩，于是弹层横向滚动、那一行字被切在可视范围之外。
// 两条属性各管一半：`min-width: 0` 让它能收缩（flex 项默认收缩不了），
// `overflow-wrap: anywhere` 让没有空格的编码/长英文也有断点（中文本来就能逐字断行）。
//
// 这是**共用原语**上的改动（会计科目筛选、BOM 供应商、生产单候选都在用），所以守卫也钉在原语上。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (...parts) => readFileSync(join(webRoot, ...parts), "utf8");
const css = read("app", "globals.css");
const component = read("components", "ui", "searchable-select.tsx");

test("弹层里的选项文字换行而不是横向溢出（能收缩 + 任意位置可断行）", () => {
  assert.match(
    css,
    /\.ui-searchable-select-option-text \{ min-width: 0; white-space: normal; overflow-wrap: anywhere; \}/,
    "少了 min-width: 0 弹层就会横向滚动（flex 项的最小宽度是 min-content）",
  );
});

test("选项文字确实挂在这个类上（类名改了这条守卫要一起红）", () => {
  assert.match(component, /className="ui-searchable-select-option-text"/);
  // 反向的一半：不要用 `text-overflow: ellipsis` 把长物料名截掉 —— 用户要的是换行看全。
  assert.equal(/ui-searchable-select-option-text[^}]*text-overflow/.test(css), false, "选项要换行看全，不是省略号截断");
});

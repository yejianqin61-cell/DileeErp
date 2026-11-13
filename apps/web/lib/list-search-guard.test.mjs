// 「所有下拉列表、所有表单都要能搜」的源码守卫（用户 2026-11-13）。
//
// 用户原话：「通览整个项目，统计所有下拉列表，所有表单是否都有搜索功能搜索框，如果没有，都需要加上
// 搜索功能。因为现在单子多了，查找比较麻烦。」当天确认的口径：
//   · 只给**数据型**（会长长的）下拉加搜索；2–8 项的固定枚举（状态 / 是否 / 借贷方向）不加；
//   · **列表页/表格也要能搜**。
//
// 为什么需要守卫：这类缺口类型检查发现不了（有没有输入框都是合法 JSX），组件测试只覆盖「已经写了的
// 那个页面」。全站清点（2026-11-13）的结论是：表格类界面 48 个，其中 29 个已经有搜索、其余待补；
// 表单下拉 73 个字段里只有 6 个显式写了 searchable-select，另外 67 个靠 ActionDialog 的
// 「选项多了自动升级」兜底。规则一旦被改坏，不会有任何报错，只会静默退回「不能搜」。
//
// 与 `pool-search-guard.test.mjs` 的分工：那份管「主数据池」这几个结构相似的页面；
// 这份管**共用原语上的规则**（ActionDialog 的升级阈值）与**已经接上搜索的列表页清单**。
// 行为由组件测试覆盖（test/action-dialog-search-threshold.test.tsx 等），这里只钉约定。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(resolve(here, "..", relative), "utf8");

const actionDialog = read("components/ui/action-dialog.tsx");

test("表单下拉的搜索规则只有一份：显式声明 + 「选项多了自动升级」", () => {
  // ① 显式声明优先（调用方最清楚这份清单会不会长）
  assert.match(actionDialog, /if \(field\.type === "searchable-select"\) return true;/, "显式 searchable-select 必须一定带搜索");
  // ② 自动升级：阈值以上的 select 走 SearchableSelect
  assert.match(actionDialog, /export const SEARCHABLE_FIELD_MIN_OPTIONS = 9;/, "阈值必须是 9（8 项正好铺满 288px 弹层，再多就要滚）");
  assert.match(actionDialog, /\(field\.options\?\.length \?\? 0\) >= SEARCHABLE_FIELD_MIN_OPTIONS/, "必须按选项个数判断");
  // ③ 渲染分支真的用它（只写规则不接线 = 白写）
  assert.match(actionDialog, /data-testid=\{usesSearchableField\(field\) \? `action-field-\$\{field\.name\}` : undefined\}/, "渲染分支必须按 usesSearchableField 决定 testid 落点");
  assert.match(actionDialog, /\{usesSearchableField\(field\) \? <SearchableSelect/, "长清单必须渲染 SearchableSelect（带搜索框）");
  // ④ 固定枚举仍走紧凑的 Radix Select（不能把 2 项的性别也变成搜索框）
  assert.match(actionDialog, /<Select value=\{values\[field\.name\] \?\? ""\}/, "小枚举要保持紧凑的 Select");
});

/**
 * 已经接上关键字搜索的列表页（2026-11-13 清点后逐个核过）。
 * 每新增一个「补上了搜索」的页面就往这里加一行 —— 加进来的页面会被下面三条断言钉住，
 * 以后有人把搜索框删了、或把过滤改成自己写的 includes（语义与全站不一致），这里立刻红。
 */
const LIST_SCREENS_WITH_SEARCH = [
  ["app/procurement/boms/page.tsx", "BOM 表"],
  ["app/procurement/materials/page.tsx", "物料清单"],
  ["app/procurement/suppliers/page.tsx", "供应商池"],
  ["app/warehouse/stocktakes/page.tsx", "盘点单"],
  ["app/warehouse/raw-material-storage/page.tsx", "原料仓储情况"],
  ["components/sales/customer-pool.tsx", "客户池"],
  ["components/bom/bom-workbench.tsx", "BOM 工作区明细行"],
  // 2026-11-13 这一轮补上的三处
  ["components/finance/cash-flow-workspace.tsx", "收支明细"],
  ["components/sales/finished-goods-overview.tsx", "成品出库总览"],
  ["app/sales/orphans/page.tsx", "孤立单据"],
  ["app/procurement/inbounds/page.tsx", "采购入库记录"],
  ["app/production/material-issues/page.tsx", "领料单 / 补料单"],
  ["components/finance/finance-report-workspace.tsx", "财务报表（表内搜索）"],
  ["components/finance/bank-transfer-workspace.tsx", "银行互转记录"],
  ["components/account/account-center.tsx", "账号管理"],
];

test("清单里的每个列表页都有搜索框、走统一语义的 fuzzyMatch、且无命中提示与「本来就空」分开", () => {
  for (const [path, label] of LIST_SCREENS_WITH_SEARCH) {
    const source = read(path);
    assert.match(source, /from "[^"]*lib\/fuzzy-search"/, `${label}（${path}）必须用 lib/fuzzy-search 的统一匹配语义`);
    assert.match(source, /fuzzyMatch\(/, `${label}（${path}）必须用 fuzzyMatch 过滤列表`);
    assert.match(source, /<\/?Input|SearchableSelect/, `${label}（${path}）缺少搜索输入控件`);
    assert.match(source, /没有匹配|没有匹配的/, `${label}（${path}）的无命中提示必须与「本来就没有数据」分开`);
  }
});

test("列表页搜索的语义只允许有一个实现：不许再手写 includes 式过滤", () => {
  // 反面守卫：2026-09-16 之前每个页面各写一句 `xxx.toLowerCase().includes(query.toLowerCase())`，
  // 多词查询在不同页面的结果不一致，用户会以为「这个页面的搜索坏了」。清单里的页面一律不许退回那种写法。
  for (const [path, label] of LIST_SCREENS_WITH_SEARCH) {
    const source = read(path);
    assert.doesNotMatch(
      source,
      /\.toLowerCase\(\)\.includes\(\s*query\.toLowerCase\(\)/,
      `${label}（${path}）还在手写 includes 式过滤：请改用 fuzzyMatch（见 lib/fuzzy-search.ts 的注释）`,
    );
  }
});

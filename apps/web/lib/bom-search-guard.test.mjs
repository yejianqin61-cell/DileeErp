// 「BOM 表列表都能搜索」的源码守卫（用户 2026-11-11：「需要在生产和采购模块的BOM表页面加上搜索功能」）。
//
// 为什么需要守卫：BOM 表有**两个入口**，改的是同一张表，但列表页是两份各自渲染的表 ——
//   - 采购 → BOM表（`app/procurement/boms/page.tsx`，DataTable，含孤立 BOM 行）；
//   - 生产页的【BOM表】面板（`app/production/page.tsx`，手写 `<table>`，且只显示订单号/数量）。
// 这种「同一份业务、两处界面」的地方，最容易出现的不是写错，而是**只改了一处**：
// 2026-11-05 的删除键、2026-10-13 的取数口径都栽在同一个形态上。
//
// 而且这类缺口类型检查发现不了（有没有搜索框都是合法 JSX），组件测试也只覆盖已经写了的那一页。
// 所以这里用一份清单把三件事钉住：
//   1. 每个 BOM 表列表入口都有搜索输入框（filter-bar + 带「搜索」提示）；
//   2. 过滤都走 `lib/fuzzy-search` 的 fuzzyMatch，语义全站一致（空格分词 AND、忽略大小写与空白）；
//   3. 清单本身与仓库里真实存在的文件一致（改名/搬家后这里立刻变红）。
//
// 注意：这是**约定守卫**，不是行为测试 —— 行为由
// `test/procurement-bom-page.test.tsx` 与 `test/production-page.test.tsx` 覆盖。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pathOf = (relative) => resolve(here, "..", relative);
const read = (relative) => readFileSync(pathOf(relative), "utf8");

/**
 * BOM 表列表入口清单：路径、人对它的叫法、它的搜索框 testid。
 * 新增一个 BOM 表列表（比如将来给某个角色单开一页）就必须登记在这里 ——
 * 漏登记会在第二条断言里暴露。
 */
const BOM_LISTS = [
  ["app/procurement/boms/page.tsx", "采购 → BOM表", "bom-search"],
  ["app/production/page.tsx", "生产页【BOM表】面板", "production-bom-search"],
];

test("每个 BOM 表列表入口都有搜索框，且过滤走统一语义的 fuzzyMatch", () => {
  for (const [path, label, testId] of BOM_LISTS) {
    const source = read(path);
    assert.ok(existsSync(pathOf(path)), `${label}（${path}）不存在：改名或搬家后要同步更新这份清单`);
    assert.match(source, /from "[^"]*lib\/fuzzy-search"/, `${label}（${path}）必须使用 lib/fuzzy-search 的统一匹配语义`);
    assert.match(source, /fuzzyMatch\(/, `${label}（${path}）必须用 fuzzyMatch 过滤列表`);
    assert.match(source, /className="filter-bar"/, `${label}（${path}）缺少筛选条（搜索框应放在 filter-bar 里）`);
    // 搜索框的提示有的写在 label 上、有的写在 placeholder 上，所以只要求「搜索」二字与一个 <Input> 在附近同时出现。
    assert.match(source, /搜索[\s\S]{0,300}?<Input|<Input[\s\S]{0,300}?搜索/, `${label}（${path}）的筛选条里缺少带「搜索」提示的输入框`);
    // testid 是行为测试唯一稳定的抓取点：改了它，两个页面的搜索用例会一起失效却看不出原因。
    assert.match(source, new RegExp(`data-testid="${testId}"`), `${label}（${path}）的搜索框缺少 data-testid="${testId}"`);
  }
});

test("清单不要漏登记：这两个文件必须真的还带着自己的 BOM 表列表", () => {
  // 反向检查：清单一里写的入口，源码里得真有一张 BOM 表（否则「有搜索框」只是在验一个空壳）。
  assert.match(read("app/procurement/boms/page.tsx"), /data-testid="page-procurement-boms"/, "采购 BOM 表页的页面根节点不见了");
  assert.match(read("app/procurement/boms/page.tsx"), /<DataTable/, "采购 BOM 表页必须有那张列表（DataTable）");
  assert.match(read("app/production/page.tsx"), /data-testid="production-bom-panel"/, "生产页的【BOM表】面板不见了");
  assert.match(read("app/production/page.tsx"), /table-bounded/, "生产页【BOM表】是手写表，必须继续挂 table-bounded（见 lib/table-width-coverage.test.mjs）");
});

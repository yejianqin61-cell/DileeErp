// 「所有池子都要支持搜索」的源码守卫（用户 2026-09-16 的明确要求）。
//
// 为什么需要守卫：池子是一批**结构相似、各自实现**的页面（供应商池 / 物料池 / 客户池 /
// 工序池 / 加工地点池 / 单位池 / 部门池 / 岗位池 / 银行账户池），新增一个池子时最容易被忘掉的
// 就是搜索框 —— 2026-09-16 暴露出来的正是「供应商池、物料清单、客户池」三个池子没有搜索框，
// 而其它池子有。这类缺口类型检查发现不了（有没有输入框都是合法 JSX），
// 组件测试也只会覆盖「已经写了的那个页面」。所以这里用一份清单把三件事钉住：
//   1. 每个池页面都有搜索输入框（filter-bar + 提示里带「搜索」）；
//   2. 每个池页面的过滤都走 lib/fuzzy-search 的 fuzzyMatch，语义全站一致；
//   3. 清单本身与仓库里真实存在的池页面一致（漏登记会在下面第二条断言里暴露）。
//
// 注意：这是**约定守卫**，不是行为测试 —— 行为由 test/pool-search.test.tsx 覆盖。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(resolve(here, "..", relative), "utf8");

/** 全站主数据池清单：路径 + 人对它的叫法（断言失败时好看）。 */
const POOLS = [
  ["app/procurement/suppliers/page.tsx", "供应商池"],
  ["app/procurement/materials/page.tsx", "物料池（物料清单）"],
  ["app/sales/page.tsx", "客户池"],
  ["components/production/master-data-pool-page.tsx", "工序池 / 加工地点池"],
  ["components/production/unit-pool-page.tsx", "单位池"],
  ["components/hr/organization-pool.tsx", "部门池 / 岗位池"],
  ["components/finance/bank-workspace.tsx", "银行账户池"],
];

test("每个池页面都有搜索框，且过滤走统一语义的 fuzzyMatch", () => {
  for (const [path, label] of POOLS) {
    const source = read(path);
    assert.match(source, /from "[^"]*lib\/fuzzy-search"/, `${label}（${path}）必须使用 lib/fuzzy-search 的统一匹配语义`);
    assert.match(source, /fuzzyMatch\(/, `${label}（${path}）必须用 fuzzyMatch 过滤列表`);
    assert.match(source, /className="filter-bar"/, `${label}（${path}）缺少筛选条（搜索框应放在 filter-bar 里）`);
    // 搜索框的样式各页略有不同（有的把提示写在 label 上、有的写在 Input 的 placeholder 上），
    // 所以只要求「搜索」二字与一个 <Input> 在附近同时出现。
    assert.match(source, /搜索[\s\S]{0,300}?<Input|<Input[\s\S]{0,300}?搜索/, `${label}（${path}）的筛选条里缺少带「搜索」提示的输入框`);
  }
});

test("池子清单不要漏登记：这些文件里出现的「池」标题都必须有人管", () => {
  // 反向检查：任何一个页面把「池」写进**界面文案**的文件，都必须在上面的清单里。
  // 漏登记时这里会红，提示去补搜索框（而不是让新池子悄悄少一个搜索）。
  // 注释先剥掉：像 app/finance/banks/page.tsx 这种只有一层路由壳的文件，
  // 注释里写着「银行账户池二级页」但界面上并没有「池」字（标题在组件里），不该算进来。
  const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\/\/[^\n"'`]*$/gm, "");
  const candidates = [
    "app/procurement/suppliers/page.tsx",
    "app/procurement/materials/page.tsx",
    "app/procurement/boms/page.tsx",
    "app/sales/page.tsx",
    "app/customers/page.tsx",
    "app/finance/banks/page.tsx",
    "app/production/operations/page.tsx",
    "app/production/locations/page.tsx",
    "app/production/units/page.tsx",
    "app/hr/departments/page.tsx",
    "app/hr/positions/page.tsx",
    "components/production/master-data-pool-page.tsx",
    "components/production/unit-pool-page.tsx",
    "components/hr/organization-pool.tsx",
    "components/finance/bank-workspace.tsx",
  ];
  const registered = new Set(POOLS.map(([path]) => path));
  const unregistered = candidates.filter((path) => !registered.has(path) && /池/.test(stripComments(read(path))));
  assert.deepEqual(unregistered, [], `这些文件提到了「池」但不在搜索守卫清单里：${unregistered.join("、")}`);
});

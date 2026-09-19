// 「全站不漏」守卫：渲染了 `<DataTable` 的前端文件，必须接上「创建人 / 最后修改人」两列，
// 或者进白名单并写明**为什么不需要**。
//
// 为什么需要这条：这次治理要覆盖 40+ 个页面、70+ 处表格，靠人肉清点必然漏掉几个
// （盘点时就发现 `hr/page.tsx` 有两个列数组定义了从未渲染、采购页的导出按钮定义了没人调用）。
// 一个「按文件清点、不许有未分类项」的断言，比任何一次人工核对都可靠：
// 新加的表格页如果忘了接两列，这里立刻变红。
//
// 白名单是故意做成「必须带理由」的：它同时是这份治理的**决策记录**——
// 聚合表、明细子表、导入错误表、跨来源待处理清单为什么没有操作人列，都能在这里读到。
//
// 运行：node --test lib/audit-columns-coverage.test.mjs（属于 npm run test:lib）
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * 有意不接两列的文件：`路径 -> 理由`。
 * 规矩：理由必须说明**这一类界面为什么不该有操作人列**，不是「先跳过」。
 */
const EXEMPT = new Map(Object.entries({
  // 两处都不加，但理由不同：
  //   ①「报表」页签的列由**接口返回的键**动态生成（Object.keys(rows[0])），不是列定义数组，
  //      用不上列工厂；它的「创建人 / 最后修改人」由后端以 created_by_name / updated_by_name
  //      直接下发（reports.service 自己换姓名，不能下发 id——否则动态列会长出一列 UUID），
  //      表头中文来自 lib/display-text.ts 的标签；
  //   ②「告警中心」页签是**跨来源的待处理清单**（生产日报告警、成品 QC 不合格、库存净变动为负
  //      混在一张表里），行身份是「告警」而不是某张业务单据，三种来源各有各的操作人，
  //      硬塞一列会让人以为是「这条告警是谁建的」；底层记录在自己的模块里已有这两列。
  "app/reports/page.tsx": "报表页签的列由接口键动态生成（姓名由后端以 created_by_name 下发）；告警中心是跨来源待处理清单，行身份是告警不是单据",

  // 订单全链路是跨模块汇总视图：一行是一个订单在各模块的状态汇总，行身份不是某张业务单据，
  // 各模块的明细在自己页面里已有这两列。
  "app/workbench.tsx": "订单全链路是跨模块状态汇总，行身份不是某张单据（已有「更新时间」列）",

  // 财务报表沿用老系统版式，列与合计由后端 ReportTable 下发，且都是「期间聚合」口径。
  "components/finance/finance-report-workspace.tsx": "报表列与合计由后端 ReportTable 下发，属期间聚合口径，无单一操作人",
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

const files = [...walk(join(webRoot, "app")), ...walk(join(webRoot, "components"))];
const tableFiles = files.filter((file) => /<DataTable/.test(source(file)));
const usesAuditColumns = (file) => /auditColumns|auditDetailFields/.test(source(file));

test("渲染表格的文件要么接了两列，要么在白名单里写明理由", () => {
  const unclassified = tableFiles.filter((file) => !usesAuditColumns(file) && !EXEMPT.has(rel(file))).map(rel);
  assert.deepEqual(
    unclassified,
    [],
    `以下文件渲染了表格但既没有接「创建人 / 最后修改人」两列、也没有进白名单并写明理由：\n  ${unclassified.join("\n  ")}`
  );
});

test("白名单不得腐烂：每一项都必须带理由，且不得是已经接了两列的文件", () => {
  for (const [path, reason] of EXEMPT) {
    assert.ok(typeof reason === "string" && reason.trim().length >= 8, `${path} 的白名单理由太短，说明不清为什么不需要这两列`);
    const file = files.find((candidate) => rel(candidate) === path);
    assert.ok(file, `${path} 在白名单里但文件不存在（改名或删除后要同步清理白名单）`);
    assert.equal(usesAuditColumns(file), false, `${path} 已经接了两列，应从白名单移除（否则白名单会越来越长、失去意义）`);
  }
});

test("两列的列名与字段名在全站必须一致（各页不许自己起名）", () => {
  // 列名/字段名只有一处定义：components/data/audit-columns.tsx。
  // 若某个页面绕过工厂自己写「创建人」，这里会抓到——那正是本治理要避免的分叉。
  const offenders = [];
  for (const file of files) {
    if (rel(file) === "components/data/audit-columns.tsx") continue;
    const text = source(file);
    if (/header:\s*"创建人"/.test(text) || /header:\s*"最后修改人"/.test(text)) offenders.push(rel(file));
  }
  assert.deepEqual(offenders, [], `以下文件自己手写了「创建人 / 最后修改人」表头，应改用 auditColumns()：\n  ${offenders.join("\n  ")}`);
});

test("界面不得把 createdBy/updatedBy 直接渲染出来（那是 UUID）", () => {
  // 验收标准 ①「无 UUID」的可执行版本：2026-09-16 之前凭证纸上写的是
  //   <span>制单：{voucher.createdBy ?? "—"}</span>
  // 渲染成「制单：6f3a1c8e-…」。姓名必须走 created_by_name / updated_by_name（后端注入）。
  // 这里只抓 JSX 里的表达式渲染（`{xxx.createdBy}`），类型声明（`createdBy?: string`）不受影响。
  const offenders = [];
  for (const file of files) {
    const text = source(file);
    for (const line of text.split(/\r?\n/)) {
      if (/\{[^{}]*\.(createdBy|updatedBy)\b/.test(line)) offenders.push(`${rel(file)}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, [], `以下位置直接渲染了 createdBy/updatedBy（会显示 UUID），应改用 created_by_name / updated_by_name：\n  ${offenders.join("\n  ")}`);
});

test("时间格式化只走 lib/audit-time（不得再出现按宿主时区的 toLocale* 调用）", () => {
  const offenders = [];
  for (const file of files) {
    if (rel(file) === "lib/audit-time.ts") continue;
    const text = source(file);
    // toLocaleString/toLocaleDateString 会按运行宿主时区走：导出在容器里跑、界面在浏览器里跑，两边会不一致
    if (/toLocaleString\(|toLocaleDateString\(/.test(text)) offenders.push(rel(file));
  }
  assert.deepEqual(offenders, [], `以下文件用 toLocale* 格式化时间，会随宿主时区变化，应改用 lib/audit-time.ts：\n  ${offenders.join("\n  ")}`);
});

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

  // 收付款单存档（2026-09-26）：这一页的行身份是「一张要拿去银行/走签字的纸」，
  // 而纸面上那个「谁」是**制单人**（`maker`，单独一列，是印在单子上的签字格），
  // 与「谁在系统里点了保存」是两个人 —— 代录时它们不一样，摆两列反而要财务去分辨哪个是哪个。
  // 「谁保存的」属审计口径：`finance_slips.created_by / updated_by` 有列，
  // 每次保存/作废也都写一条审计事件（`payment_slip.save` / `_slip.delete`）。
  // 另外这一页的列已经很宽（编号/日期/对方/币种/汇率/折合人民币/合计/行数/制单人/保存时间），
  // 再塞两列会把这一页存在的理由（看汇率与折合人民币）挤到屏幕外。
  "components/finance/finance-slips-workspace.tsx": "存档列表的行身份是待打印的单据，纸面上的「谁」是制单人（已有列）；谁保存的属审计口径（有列 + 审计事件），列宽也放不下",

  // 采购计划列表：2026-09-27 起它是一个按百分比分完宽度的固定版式表；2026-10-13 按用户
  // 「也要显示物料名称等等 column。都要显示」**展平成一行 = 一条明细**（13 列，见
  // `lib/purchase-plan-list-table.test.mjs`），列宽全部给了业务列（物料/型号/数量/单价/
  // 供应商/下单状态/预计到货），13 列里没有「创建人 / 最后修改人」的位置。
  // 操作人信息没有丢：它挂在「计划编号」那一格的 `title` 上（未下单行数 / 计划金额 /
  // 最后更新 人 + 北京时间），点进计划详情也仍然看得见。
  "app/procurement/plans/page.tsx": "13 列全部给了业务列（2026-10-13 展平后一行是一条物料）；操作人信息挂在计划编号的 title 上，详情里也看得到",

  // 成品出库总览（2026-09-30 拆成独立二级页）：这一页是**按「产品 + 单位」聚合**的口径表
  // （后端 `GET /sales-orders/finished-goods-summary` 返回的是分组汇总），一行是「某产品还有多少压在
  // 成品仓」，根本不是某张单据 —— 没有"谁创建/谁最后改了这一行"可言，硬塞两列只能填出空值。
  // 行对应的**来源事实**（生产单 + 成品出入库单）各自在自己的页面上已有这两列。
  "components/sales/finished-goods-overview.tsx": "按产品+单位聚合的存量汇总表，一行是分组结果而不是单据，没有单一操作人",

  // 「填单价」浮层（2026-10-09，用户：「我真没看到哪里可以手填单价的。可以重新设计这一块」）：
  // 它是**同一份计划草稿的录入网格**（每行一个单价 Input，改完仍要点「保存计划」），
  // 一行对应的是计划里的一行明细，不是一张业务单据 —— 没有"谁创建/谁最后改了这行价格"可言。
  // 真正的操作人信息在它背后那一页（采购计划详情 / 列表）上，那里两列都在。
  "components/procurement/plan-price-dialog.tsx": "填单价浮层的录入网格：一行是计划明细而不是单据，操作人信息在其背后的采购计划页",
  // 单据详情弹窗里的「领用物料」明细（2026-10-29）：一行是一条物料明细，不是一张单据 ——
  // 「谁创建 / 谁最后改了这一行」在数据上就不存在；单据级的创建人/最后修改人在弹窗头部的
  // 详情字段里（调用方页面用 `auditDetailFields(detail)` 渲染），两列信息没有丢。
  // 这张表存在的理由是「把打印件上的四个数量原样显示出来」，与审计列无关。
  "components/production/material-slip-lines-table.tsx": "单据详情弹窗里的物料明细表：一行是物料明细而不是单据，操作人在弹窗头部的单据字段里（auditDetailFields），明细行本身没有操作人",
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
/**
 * 「这一页接上了这两列」的判据。
 *
 * 2026-10-08 补第二种写法：物料清单页为了给每一列指定宽度（用户要求「表格所有列宽限定长度…保证所有
 * column一次性展示」）不能再整块铺 `auditColumns()`，改成 `...createdByColumn()` / `...updatedByColumn()`
 * 逐列挂 `meta`。**两个工厂必须都出现**才算「两列都在」——只用一个的文件（采购计划列表只有「最后更新」）
 * 仍然走白名单，否则这条守卫会把它误判成"已经接了两列"。
 */
const usesAuditColumns = (file) => {
  const text = source(file);
  return /auditColumns|auditDetailFields/.test(text) || (/createdByColumn/.test(text) && /updatedByColumn/.test(text));
};

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

# 全站表格盘点：「列出宽度受限 + 超长省略 + 悬停看全文」（2026-10-09）

用户 2026-10-09 原话：

> 针对本项目所有的表格，我不希望会因为某个 column 不限定宽度而导致表格的左右宽度太大。
> 我希望每个 column 都能限定宽度。超过字数就省略显示。鼠标 hover 的时候再显示全部文字。
> 你先统揽所有的表格表单，然后统计所有需要进行改进修复的。

这份文档就是那一步「统揽 + 统计」的产物：**全站 96 张表逐张过了一遍，78 张需要修**。
逐张明细在文末附录，按模块拆开的详细版在 `docs/design/table-column-width-audit-2026-10-09/` 下的 5 个文件里。

---

## 0. 结论先看这里

| 指标 | 数量 | 占比 |
| --- | --- | --- |
| 表格总数 | **100** | 100% |
| 其中 `DataTable`（TanStack 通用表） | 76 | 76% |
| 其中手写 `<table>` / `<Table>` 原语 | 24 | 24% |
| **需要修**（列宽不受限，或长文本无省略 + 无 hover 全文） | **82** | **82%** |
| 已达标（列宽显式受限 + 关键列省略 + hover 全文） | 7 | 7% |
| 不适用（可编辑网格 / 打印单据，不该套省略号） | 11 | 11% |

> **一处盘点遗漏（2026-10-09 当日自查补上）**：给 5 个模块划范围时把 `apps/web/app/reorder/page.tsx` 漏在外面，
> 而它有 **4 张手写 `<table className="ui-table">`**（约 212 / 273 / 300 / 321 行：返单货号汇总、按币种毛利、
> QC 合格率、批次清单）。发现方式不是再读一遍代码，而是写了一条**覆盖面自查**：
> 遍历 `app/`+`components/` 里所有含 `<DataTable` / `<table ` / `<Table ` 的文件，逐个比对 5 份模块盘点里有没有出现 ——
> 55 个「有表格的文件」里 54 个出现过，只有它没有。
> 因此上面的数字是 **100 张 / 82 张需要修**（初版写的是 96 / 78，只统计了 5 份模块盘点）。
> 这条自查已经**固化进守卫** `apps/web/lib/table-width-coverage.test.mjs`（见第 8 节），
> 以后再漏一个文件会直接变红，不再靠人肉划分范围。

需要修的 82 张里，**70 张是 `DataTable` 渲染的，12 张是手写表**。
问题不是「个别页面漏了」，而是**全站只有 3 个文件给列写过宽度**：

| 文件 | 有 `meta.width` 的列数 | 说明 |
| --- | --- | --- |
| `apps/web/app/procurement/materials/page.tsx` | 15（3 张表，各自总和 100%） | 物料清单页，本轮的模板 |
| `apps/web/app/procurement/plans/page.tsx` | 10（11 列，共 87%） | 采购计划列表 |
| `apps/web/components/finance/voucher-workspace.tsx` | 19（2 张表） | 凭证管理，唯一达标的财务表 |

其余 90+ 张表的列定义**一个 `meta` 都没有**，所以它们都是「自动布局 + 每格 `white-space: nowrap`」——
每一列的最小宽度 = 该列最长的那串文字，表格因此被顶出容器，只能横向滚动。这正是用户说的「左右宽度太大」。

---

## 1. 判定口径：什么算「需要修」

列宽受限 + 超长省略 + hover 全文，在当前代码里由三个东西共同实现（缺一不可）：

| 要件 | 由谁提供 | 现状 |
| --- | --- | --- |
| ① 列宽有上界 | `meta.width` → `DataTable` 给 `<table>` 加 `data-table-fixed` → `table-layout: fixed`（`globals.css:232`） | 只有 3 个文件有 |
| ② 超长省略 | `meta.ellipsis` → 单元格加 `.cell-ellipsis` → `text-overflow: ellipsis`（`globals.css:237`） | 只有 3 个文件有 |
| ③ hover 看全文 | `meta.ellipsis` → 单元格加原生 `title`（`data-table.tsx:91`） | 只有 3 个文件有 |

所以判定规则写死成三条，**满足任意一条就算「需要修」**：

1. 这张表的列定义里没有任何 `meta.width`（→ `table-layout` 是 `auto`，列宽无上界）；
2. 长文本列没有 `meta.ellipsis`（→ 不省略、也没有 hover 全文）；
3. 手写 `<table>` 没有等价的 CSS + `title`。

反过来说，`不适用` 只有一个理由：**这一格装的是控件（输入框 / 下拉 / 勾选框）+ 容器本身已经有固定列宽或最小宽度**。
给这类格子套 `nowrap + text-overflow` 会把控件裁掉，是负收益 —— 领料单、日报录入、工资台账都属于这一类，
它们各自已经有一整套列宽规则（`.material-slip-editor`、`.purchase-plan-sheet`、`.payroll-sheet-table`……）。

---

## 2. 统计总表（按模块）

| 模块 | 表格总数 | `DataTable` | 手写表 | **需要修** | 已达标 | 不适用 |
| --- | --- | --- | --- | --- | --- | --- |
| A 采购 | 10 | 8 | 2 | **5** | 4 | 1 |
| B 销售 · 仓库 | 19 | 16 | 3 | **18** | 0 | 1 |
| C 生产 · 质检 | 23 | 17 | 6 | **19** | 0 | 4 |
| D 财务 | 32 | 27 | 5 | **25** | 2 | 5 |
| E 人力 · 报表 · 工作台 · 账号 · 拆单 · BOM | 12 | 8 | 4 | **11** | 1 | 0 |
| F 返单（补审，见上文「一处盘点遗漏」） | 4 | 0 | 4 | **4** | 0 | 0 |
| **合计** | **100** | **76** | **24** | **82** | **7** | **11** |

列数分布（全站 100 张，`动态` = 列由接口/后端下发，前端写不死）：

| 列数 | 张数 | 列数 | 张数 |
| --- | --- | --- | --- |
| 3 列 | 6 | 11 列 | 8 |
| 4 列 | 6 | 12 列 | 4 |
| 5 列 | 7 | 13 列 | 8 |
| 6 列 | 13 | 14 列 | 5 |
| 7 列 | 5 | 16 列 | 2 |
| 8 列 | 14 | 17 列 | 1 |
| 9 列 | 3 | 18 列 | 1 |
| 10 列 | 10 | 19 列 | 1 |
| | | 21 列 | 1 |
| | | 动态（最多 23 列） | 1 |

**最宽、也最该优先修的 10 张**（列数 x 有没有宽度上界 = 溢出风险）：

| 列数 | 表 | 位置 |
| --- | --- | --- |
| 动态（销售对账明细表 23 列） | 财务报表预览 | `apps/web/components/finance/finance-report-workspace.tsx:296` |
| 19 | 应付对账明细 | `apps/web/components/finance/payable-workspace.tsx:1125` |
| 18 | 应收对账明细 | `apps/web/components/finance/receivable-workspace.tsx:793` |
| 17 | 员工目录 | `apps/web/app/hr/page.tsx:1228` |
| 16 | 来料质检主表 | `apps/web/components/qc/incoming-inspections-panel.tsx:326` |
| 16 | 现金流量表 | `apps/web/components/finance/cash-flow-workspace.tsx:385` |
| 14 | 盘点明细 | `apps/web/app/warehouse/stocktakes/page.tsx:474` |
| 14 | 银行流水 | `apps/web/components/finance/bank-workspace.tsx:234` |
| 14 | 跨行转账记录 | `apps/web/components/finance/bank-transfer-workspace.tsx:326` |
| 13 | 原料入库单 | `apps/web/app/procurement/inbounds/page.tsx:154` |

---

## 3. 根因：不是「漏了几个页面」，是「逐列自愿加入」制

`DataTable` 现在的契约是**自愿加入**：

```ts
// components/data/data-table.tsx:86
const fixed = columns.some((column) => metaOf(column.meta).width);
```

**只要有一列写了 `meta.width`，整张表才切 `table-layout: fixed`**；一列都没写，就还是自动布局。
这个设计本身是有意的（`globals.css:229-231` 的注释写着「只影响自愿加入的表」），
2026-09-27 把规则提成通用、2026-10-08 物料清单页做全列定宽，走都是这条路。

代价就是今天这个局面：**默认值是「不受限」，于是 81% 的表都不受管**。
新增一张表、新增一列，不会有人提醒补宽度 —— 表现只是「那个页面又开始横着长」，测试一条都不会红。

所以这次要改的不是 78 张表的 CSS，而是**默认值**：让「每列有上界 + 超长省略 + hover 全文」成为不用声明就有的行为，
再把少数必须例外的表显式列出来。这也是代码里已经写过两次的教训
（`globals.css:227-231`：「页面私有规则等于让下一个模块再抄一遍 —— 抄出来的那份一旦与这份不一致，
表现是『某个页面没省略』，查半天」）。

---

## 4. 五个会「静默失效」的坑（这次盘点新查出来的）

这几条的共同点是**看起来改对了、实际没生效**，必须写进修复方案，否则修完还是老样子：

1. **只加 `meta.ellipsis` 等于什么都没加。**
   省略样式挂在 `.ui-table.data-table-fixed .ui-table-cell.cell-ellipsis`（`globals.css:237`），
   没有 `data-table-fixed` 就命中不了。而 `data-table-fixed` 只由「任意一列有 `meta.width`」触发。
   → **宽度与省略必须成对给。**

2. **`ellipsisTitle` 只认字符串和数字（`data-table.tsx:53-57`）。**
   单元格渲染的是 JSX / `ReactNode` 时（拼接的金额、Badge、勾选框 span、`<div>` 容器……），
   省略号会出现、**hover 却是空白**。财务模块已核出 7 处这类列
   （`bank-workspace` 当前余额 / 余额构成、`bank-transfer-workspace` 当前余额、`finance-slips-workspace` 借方合计、
   `cash-flow-workspace` 来源 badge、应收/应付勾选列）。
   → 这类列要么改成 `accessorFn`（把屏幕上那串字作为值），要么像 `auditActorCell` 那样在容器上自己写 `title`。
   （先例警告写在 `data-table.tsx:64-73`：物料清单页的「物料编码/物料名称」第一次上线就是这个样子。）

3. **`id` + 自定义 `cell` 且没有 accessor 的列拿不到值。**
   `cell.getValue()` 返回 `undefined`，自动 title 算不出来。物料清单页的「默认单位」因此改成了 `accessorFn`。

4. **`DataTable` 从不下发 `cell-ellipsis` 到 `<th>`。**
   只有 `<td>` 带（`data-table.tsx:88` 的 `<TableHead>` 没有 `cell-ellipsis`），
   所以 `globals.css:238` 的 `.ui-table-head.cell-ellipsis` 对 `DataTable` 是**死代码**；
   固定布局下一窄，表头只能换行或被 `overflow: hidden` 裁掉。
   → 列名较长的表（如「最后修改人」「含税金额（本）」）要给够宽度，或者让表头也能省略 + hover。

5. **Radix Portal 把弹窗里的表搬出了 `.finance-page`。**
   `DialogContent` 走 Portal 挂到 `body`（`ui/dialog.tsx:13`），于是 `.finance-page .ui-table-cell { white-space: normal }`
   （`globals.css:212`）够不到弹窗内的表。**9 张财务表在弹窗里**
   （应付详情 962/970/972、导入错误 1185；应收详情 669/675；工资详情 841/845/847），
   它们退回 `padding: 12px + nowrap + 自动布局` —— 这就是用户
   「确认应付的表单还需要左右滑动」的根因。`globals.css:213-220` 的注释当年只修了「留在 `.finance-page` 里的表」，漏了 Portal 这条。

---

## 5. 已达标的 7 张（可以照抄的模板）

| 位置 | 列数 | 做法 |
| --- | --- | --- |
| `apps/web/app/procurement/materials/page.tsx:315` | 10 | `COLUMN_WIDTH` 十个百分比总和 100%，5 个文本列 `ellipsis: true`；图片/操作列给宽度但不给省略 |
| `apps/web/app/procurement/materials/page.tsx:276` | 3 | 导入结果「未导入的行」小表，12% / 18% / 70% |
| `apps/web/app/procurement/materials/page.tsx:286` | 4 | 导入结果「已新增的物料」小表，14% / 30% / 18% / 38% |
| `apps/web/app/procurement/plans/page.tsx:182` | 11 | 10 列显式宽度共 87%，余量归审计列 |
| `apps/web/components/finance/voucher-workspace.tsx:361` | 11 | `ENTRY_COLUMN_WIDTHS` 全列宽度 + 3 列省略 |
| `apps/web/components/finance/voucher-workspace.tsx:369` | 11 | `VOUCHER_COLUMN_WIDTHS` 全列宽度 + 3 列省略 |
| `apps/web/components/bom/bom-workbench.tsx:258` | 10 / 8 | 手写表，但 `.bom-table` 有 `table-layout: fixed` + 十列百分比 + 物料名称列省略 + `title` |

两处「偏脆弱」值得在同一次修复里一起收口：

- 采购计划列表（`plans/page.tsx:182`）的 10 列只覆盖 87%，剩下 13% 静默归给没写宽度的 `updatedByColumn`；
  且「计划金额」列是自定义 `cell` 返回 JSX 又没 `accessor`，**被省略后没有 hover 全文**（对应上面第 2、3 条坑）。
- 物料清单页的审计两列用 `{...createdByColumn(), meta: {...}}` 逐列挂宽度，这个写法是对的，
  但 `auditColumns()` 工厂本身不给宽度 —— 全站 30+ 处在用它，**不能在工厂里统一给宽度**
  （各表列数不同，固定百分比会在列多的表里挤歪别人）；正确做法就是照物料清单页在页内展开覆盖。

---

## 6. 不适用（11 张）及理由

| 位置 | 列数 | 为什么不该套省略号 |
| --- | --- | --- |
| `components/procurement/plan-detail-sheet.tsx:474` | 14 | 采购计划明细编辑表：已有一套 `.plan-col-*` 百分比（总和 100%）+ `table-layout: fixed`，4 个只读列已有 `.plan-cell-ellipsis` + 手写 `title` |
| `components/sales/sales-order-editor.tsx:792` | 7 | 销售单细分明细：每格一个受控 `<Input>`，压窄会挤坏输入框 |
| `components/production/material-issues-panel.tsx:239` | 8 | 领料草稿网格，单元格是可编辑控件 |
| `components/production/daily-reports-panel.tsx:299` | 8 | 工序员工日报草稿表，单元格是 `<Select>` / `<Input>` |
| `components/production/daily-reports-panel.tsx:303` | 10 | 员工日报在线更正表，同上 |
| `components/production/material-slip-editor.tsx:242` | 13 / 9 | 领料单/补料单编辑网格，已有 `.material-slip-editor` 的 `max-width: 240px + overflow: hidden + text-overflow: ellipsis`（`globals.css:459-471`），**不要改成 fixed 布局** |
| `components/finance/payroll-sheet.tsx:172` | 21 | 工资台账可编辑网格（全站最宽），已有 `.payroll-sheet-table` 一套 |
| `components/finance/bank-transfer-slip-editor.tsx:119` | 4 | 跨行转账单正文（打印件），已有 `table-layout: fixed` + 版式对齐 |
| `components/finance/bank-transfer-slip-editor.tsx:181` | 4 | 转账单签字栏（打印件） |
| `components/finance/voucher-workspace.tsx:408` | 4 | 记账凭证纸（打印 / 导出 PNG），版式由纸样决定 |
| `components/finance/payable-merge-payment-dialog.tsx:278` | 6 | 合并付款逐行金额表。它需要的**不是省略号，而是**：① 外面包一层 `.table-wrap`；② 给输入列固定宽度（现在既没有滚动容器也没有宽度） |

---

## 7. 修复方案

### 方案 A（推荐先做）：把「每列有上界 + 省略 + hover 全文」变成默认

改动集中在 2 个文件，覆盖 78 张表里的绝大多数：

1. **`components/data/data-table.tsx`**
   - 默认给**所有能取到文本的列**加 `title`（不再要求 `meta.ellipsis`）—— 取不到就是控件列，自然不加；
     这一条单独就能把「鼠标 hover 显示全部文字」铺满全站，且**零布局风险**。
   - 默认切 `data-table-fixed`；没写 `meta.width` 的列按剩余空间均分（或按列数均分 100%），
     保证「每个 column 都有上界」而不是「有的列靠内容撑」。
2. **`app/globals.css`**
   - 给手写表补上与 `data-table-fixed` 等价的一组规则（`.ui-table` / `.data-table` 两个类都要写 ——
     这是 `finance-table-width.test.mjs:32-38` 记过的那次教训）。
   - 加一条**显式退出清单**：财务页靠换行「一屏看全」的表（`.finance-page`）、
     第 6 节那 11 张可编辑网格 / 打印单据，用更高权重的选择器退出「固定 + 省略」，
     回到现在的换行 / 自有列宽行为。

**代价（要一起接受）**：列宽默认**均分**，操作列按钮多的表（销售单列表 4 个按钮、
成品出库单按状态最多 5 个按钮、采购单列表最多 6 个控件）会折成多行、行变高。
这是「宁可按钮折行，也不让表横着长」的取舍 —— 与物料清单页 2026-10-08 已经做过的那次取舍同一个方向。

**收益**：改完以后**新增表格自动受管**，不会再退回今天这个局面。

### 方案 B（在 A 之上收口）：给列宽有讲究的表写显式百分比

照物料清单页的模板（`COLUMN_WIDTH` 总和 100%），把 A 里「均分明显不合适」的表逐张配平。
优先做这几类：

- 列数 ≥ 13 的 12 张（对账明细、财务报表预览、来料质检、盘点明细、原料入库……）；
- 操作列按钮 ≥ 4 个的表；
- 有金额列的表（金额不能被截断成看不全，宁可给宽/右对齐）；
- 列由接口动态生成的 2 张（报表页 `Object.keys(rows[0])`、财务报表预览后端 `ReportTable.columns`）——
  这两张写不死 `meta`，需要在 `DataTable` 里加一条按列下标的宽度策略。

### 关于「只改 CSS 行不行」

不行，两个原因：

- 只给 `.ui-table` 加 `table-layout: fixed` 而不给宽度，是**列宽均分**（这就是方案 A 的默认），
  想「关键列宽、按钮列宽」还是得逐列说；
- 想把 `.ui-table-cell` 全局改成 `white-space: normal`（学财务页的换行法）会**改变所有模块的行高与密度**，
  而且 `lib/finance-table-width.test.mjs:86-87` 明确钉住了「全站基础表格仍是 nowrap」这条契约。

### 7.1 方案 A 已落地（真实 Chromium 实测）

改了两个文件：

| 文件 | 改动 |
| --- | --- |
| `apps/web/components/data/data-table.tsx` | `<table>` **一律**加 `data-table-fixed`（不再要求某列先给 `meta.width`）；文本格**默认**带 `cell-ellipsis` + 原生 `title`（`meta.ellipsis: false` 才关）；`<th>` 也补上了 `cell-ellipsis` + `title`（以前这条 CSS 对 DataTable 是死代码） |
| `apps/web/app/globals.css` | ① `.finance-page .ui-table.data-table-fixed` 三条 —— 财务**页面内**的表显式退出固定布局、回到「换行一屏看全」；② 新增 `.table-bounded` —— 给 20 张**手写** `<table>` 用的同义入口 |

同步更新的守卫与测试（都是「钉住旧行为」的那几条，逐一写明理由）：
`lib/finance-table-width.test.mjs`（固定布局的判定 + title 的表达式）、
`test/data-table-ellipsis.test.tsx`（旧契约「没开 ellipsis 的列不带 title」作废，换成新契约）。
`test/materials-table-width.test.tsx`（图片/操作列不许省略）、`lib/materials-table-width.test.mjs`、
`lib/purchase-plan-table.test.mjs`、`lib/bom-table.test.mjs`、`lib/audit-columns-coverage.test.mjs` 全部**原样通过**。

**实测**（真实 Chromium 1366x768 / 1920x1080 + 真实 `app/globals.css` + 与 DataTable 输出一致的 DOM，
长文本列用 28 字中文；列宽与内容无关是固定布局的定义）：

| 场景 | 视口 | 容器宽 | 表宽 | 横向溢出 | `table-layout` | 单元格 `white-space` | 内容被裁 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 旧 · 13 列自动布局 | 1366 | 1266 | **4519** | **3253** | auto | nowrap | 否 |
| 新 · 13 列固定布局 | 1366 | 1266 | **1266** | **0** | fixed | nowrap | 是（省略号 + hover） |
| 旧 · 8 列自动布局 | 1366 | 1266 | **2781** | **1515** | auto | nowrap | 否 |
| 新 · 8 列固定布局 | 1366 | 1266 | **1266** | **0** | fixed | nowrap | 是 |
| 财务页内 · 19 列（有 `.finance-page` 祖先） | 1366 | 1266 | 1266 | **0** | auto | **normal（换行）** | 否 |
| 财务弹窗 · 19 列（Portal 到 body） | 1366 | 1266 | 1266 | **0** | **fixed** | nowrap | 是 |
| 手写 · 6 列裸 `.data-table` | 1366 | 1266 | **2109** | **843** | auto | nowrap | 否 |
| 手写 · 6 列 `.table-bounded` | 1366 | 1266 | **1266** | **0** | fixed | nowrap | 是 |

（1920 视口同趋势，数字见表的另一半，略。）

三条结论：
1. **78 张「需要修」的表里，74 张由方案 A 直接收口**（表宽 = 容器宽，横向溢出归零）；
2. **财务页面内的表行为一字未变**（仍是自动布局 + 换行，实测 0 溢出、无裁切），
   而**弹窗里的 9 张财务表**从「自动布局 + 横滑」变成了固定布局 —— 用户报的
   「确认应付的表单，还需要左右滑动」正是这一批；
3. 手写表加上 `.table-bounded` 后同样归零。

方案 B（逐表配平）在方案 A 之上继续做：**8 张手写表**加 `.table-bounded` + 显式列宽（它们拿不到 DataTable 的默认），
以及 13 列以上 / 操作列按钮多的表把**均分**换成**关键列更宽**的显式百分比。

---

## 8. 需要同步改的守卫与测试（本项目把守卫当契约，不能偷偷绕过）

`方案 A` 会改掉 `DataTable` 的默认行为，下面这几条钉住旧行为的断言必须跟着改，
**每条都要在提交信息里写明「为什么改」**（这个仓库的习惯是注释里写清楚，例如 `globals.css` 里那一堆「为什么」）：

| 文件 | 行 | 钉住的东西 | 处理 |
| --- | --- | --- | --- |
| `apps/web/lib/finance-table-width.test.mjs` | 67 | `const fixed = columns.some((column) => metaOf(column.meta).width);` | 改成新判定 |
| `apps/web/lib/finance-table-width.test.mjs` | 71 | `title={meta.ellipsis ? ellipsisTitle(...) : undefined}` | 改成「默认带 title」的表达式 |
| `apps/web/test/data-table-ellipsis.test.tsx` | 73-79 | 「没开 `ellipsis` 的列不带 `cell-ellipsis`、不带 `title`」 | 改成新契约（文本列默认都带） |
| `apps/web/test/materials-table-width.test.tsx` | 110-120 | 「图片/操作两格不许省略」 | 预期**仍然通过**：方案 A 按「取不取得到字符串」判定，控件格天然没有 title |
| `apps/web/lib/purchase-plan-table.test.mjs` | 35-46 | 14 列宽度总和 100% | 预期**仍然通过**（CSS 未被改动） |
| `apps/web/lib/audit-columns-coverage.test.mjs` | 全 | 全站表格必须接审计两列 | 不受影响 |

另外建议**新增一条全站守卫**（照 `audit-columns-coverage.test.mjs` 的写法，按文件清点、不许有未分类项）：
`apps/web/lib/table-width-coverage.test.mjs` —— 遍历所有渲染表格的文件，
要么该表受新默认策略管，要么进显式例外清单并写明理由。否则这一轮修完，
下一张新表又会退回「不受限」的默认。

---

## 9. 顺带发现的死代码 / 死 CSS（与本次无关，但既然盘到了）

| 位置 | 问题 |
| --- | --- |
| `components/finance/payroll-sheet.tsx` 的 `.ui-table-footer` | `globals.css` 里没有这个类的任何规则（表尾合计行样式靠 `.payroll-sheet-table tfoot .ui-table-cell` 兜） |
| `app/globals.css:264` | `.production-order-table .data-table td:last-child { white-space: normal; min-width: 150px }` —— **没有任何元素带 `.production-order-table`**：`app/production/page.tsx:181` 用的是 `data-testid="production-order-table"`。所以生产单列表操作列那 150px 从来没生效过 |
| `app/workbench.tsx:27` | `productionColumns` 定义后从未使用 |
| `app/hr/page.tsx` | 有两个列数组定义了但从未渲染（审计 A 组盘点时顺带发现同款：采购页有个导出按钮定义了没人调用） |
| `globals.css:238` | `.ui-table-head.cell-ellipsis` 对 `DataTable` 是死代码（`DataTable` 从不下发该 class 给 `<th>`），见第 4 节第 4 条 |
| 2 张手写表 | `components/reorder/unassigned-panel.tsx:116`、`components/reorder/document-groups.tsx:81` 的 `<td>` **完全没有 className**，连 `.ui-table-cell` 的 padding / nowrap 基准都缺 —— 修法是先补 class 再谈宽度与省略 |

---

## 10. 附录：逐表明细

> 详细版（含每张表的完整列清单、列宽现状、省略现状、风险与逐表建议）见：
> - `docs/design/table-column-width-audit-2026-10-09/A-采购.md`（10 张）
> - `docs/design/table-column-width-audit-2026-10-09/B-销售与仓库.md`（19 张）
> - `docs/design/table-column-width-audit-2026-10-09/C-生产与质检.md`（23 张）
> - `docs/design/table-column-width-audit-2026-10-09/D-财务.md`（32 张）
> - `docs/design/table-column-width-audit-2026-10-09/E-人力报表工作台账号拆单BOM.md`（12 张）

### 需修（82 张）

> 其中 4 张来自模块 F「返单」—— 初版盘点漏了 `apps/web/app/reorder/page.tsx`，补审后加在最后。

| 模块 | 表 | 位置 | 列数 | 当前状态 |
| --- | --- | --- | --- | --- |
| 采购 | T9 | `apps/web/app/procurement/orders/[id]/page.tsx:100` | 6 | 需要修 |
| 采购 | T1 | `apps/web/app/procurement/boms/page.tsx:139` | 5 | 需要修 |
| 采购 | T2 | `apps/web/app/procurement/inbounds/page.tsx:154` | 13 | 需要修 |
| 采购 | T8 | `apps/web/app/procurement/suppliers/page.tsx:165` | 10 | 需要修 |
| 采购 | T6 | `apps/web/app/procurement/orders/page.tsx:225` | 8 | 需要修 |
| 销售·仓库 | T3 | `apps/web/components/sales/finished-goods-overview.tsx:62` | 6 | 需要修 |
| 销售·仓库 | T5 | `apps/web/components/sales/production-sheet-export-dialog.tsx:98` | 3 | 需要修 |
| 销售·仓库 | T2 | `apps/web/components/sales/customer-pool.tsx:139` | 8 | 需要修 |
| 销售·仓库 | T6 | `apps/web/app/warehouse/page.tsx:184` | 10 | 需要修 |
| 销售·仓库 | T7 | `apps/web/app/warehouse/page.tsx:197` | 11 | 需要修 |
| 销售·仓库 | T1 | `apps/web/components/sales/sales-orders-list.tsx:211` | 9 | 需要修 |
| 销售·仓库 | T8 | `apps/web/app/warehouse/page.tsx:226` | 8 | 需要修 |
| 销售·仓库 | T15 | `apps/web/app/warehouse/raw-material-storage/page.tsx:229` | 6 | 需要修 |
| 销售·仓库 | T16 | `apps/web/app/warehouse/raw-material-storage/page.tsx:235` | 12 | 需要修 |
| 销售·仓库 | T9 | `apps/web/app/warehouse/finished-goods-storage/page.tsx:256` | 5 | 需要修 |
| 销售·仓库 | T10 | `apps/web/app/warehouse/finished-goods-storage/page.tsx:278` | 5 | 需要修 |
| 销售·仓库 | T11 | `apps/web/app/warehouse/finished-goods-storage/page.tsx:283` | 13 | 需要修 |
| 销售·仓库 | T12 | `apps/web/app/warehouse/finished-goods-storage/page.tsx:291` | 8 | 需要修 |
| 销售·仓库 | T13 | `apps/web/app/warehouse/finished-goods-storage/page.tsx:295` | 11 | 需要修 |
| 销售·仓库 | T14 | `apps/web/app/warehouse/finished-goods-storage/page.tsx:299` | 12 | 需要修 |
| 销售·仓库 | T17 | `apps/web/app/warehouse/stocktakes/page.tsx:418` | 3 | 需要修 |
| 销售·仓库 | T18 | `apps/web/app/warehouse/stocktakes/page.tsx:438` | 11 | 需要修 |
| 销售·仓库 | T19 | `apps/web/app/warehouse/stocktakes/page.tsx:474` | 14 | 需要修 |
| 生产·质检 | T10 | `apps/web/components/production/outsource-logistics-panel.tsx:44` | 7 | 需要修 |
| 生产·质检 | T11 | `apps/web/components/production/outsource-logistics-panel.tsx:44` | 7 | 需要修 |
| 生产·质检 | T9 | `apps/web/components/production/master-data-pool-page.tsx:62` | 7 | 需要修 |
| 生产·质检 | T8 | `apps/web/components/production/unit-pool-page.tsx:78` | 6 | 需要修 |
| 生产·质检 | T13 | `apps/web/components/production/production-order-detail-page.tsx:79` | 6 | 需要修 |
| 生产·质检 | T14 | `apps/web/components/production/production-order-detail-page.tsx:79` | 5 | 需要修 |
| 生产·质检 | T18 | `apps/web/components/qc/qc-inbound-panel.tsx:126` | 10 | 需要修 |
| 生产·质检 | T19 | `apps/web/components/qc/qc-inbound-panel.tsx:128` | 8 | 需要修 |
| 生产·质检 | T12 | `apps/web/components/production/finished-goods-panel.tsx:170` | 13 | 需要修 |
| 生产·质检 | T1 | `apps/web/app/production/page.tsx:179` | 3 | 需要修 |
| 生产·质检 | T2 | `apps/web/app/production/page.tsx:181` | 10 | 需要修 |
| 生产·质检 | T21 | `apps/web/components/qc/finished-goods-qc-panel.tsx:195` | 10 | 需要修 |
| 生产·质检 | T22 | `apps/web/components/qc/finished-goods-qc-panel.tsx:195` | 8 | 需要修 |
| 生产·质检 | T23 | `apps/web/components/qc/finished-goods-qc-panel.tsx:195` | 13 | 需要修 |
| 生产·质检 | T3 | `apps/web/app/production/material-issues/page.tsx:247` | 11 | 需要修 |
| 生产·质检 | T4 | `apps/web/app/production/material-issues/page.tsx:256` | 6 | 需要修 |
| 生产·质检 | T6 | `apps/web/components/production/material-issues-panel.tsx:257` | 8 | 需要修 |
| 生产·质检 | T7 | `apps/web/components/production/material-issues-panel.tsx:265` | 6 | 需要修 |
| 生产·质检 | T20 | `apps/web/components/qc/incoming-inspections-panel.tsx:326` | 16 | 需要修 |
| 财务 | T9 | `apps/web/components/finance/finance-slips-workspace.tsx:192` | 11 | 需要修 |
| 财务 | T1 | `apps/web/components/finance/accounting-subject-workspace.tsx:226` | 7 | 需要修 |
| 财务 | T6 | `apps/web/components/finance/bank-workspace.tsx:234` | 14 | 需要修 |
| 财务 | T8 | `apps/web/components/finance/finance-report-workspace.tsx:296` | 动态 | 需要修 |
| 财务 | T4 | `apps/web/components/finance/bank-transfer-workspace.tsx:319` | 10 | 需要修 |
| 财务 | T5 | `apps/web/components/finance/bank-transfer-workspace.tsx:326` | 14 | 需要修 |
| 财务 | T7 | `apps/web/components/finance/cash-flow-workspace.tsx:385` | 16 | 需要修 |
| 财务 | T21 | `apps/web/components/finance/receivable-workspace.tsx:669` | 5 | 需要修 |
| 财务 | T22 | `apps/web/components/finance/receivable-workspace.tsx:675` | 8 | 需要修 |
| 财务 | T23 | `apps/web/components/finance/receivable-workspace.tsx:765` | 12 | 需要修 |
| 财务 | T24 | `apps/web/components/finance/receivable-workspace.tsx:779` | 12 | 需要修 |
| 财务 | T25 | `apps/web/components/finance/receivable-workspace.tsx:793` | 18 | 需要修 |
| 财务 | T26 | `apps/web/components/finance/receivable-workspace.tsx:824` | 10 | 需要修 |
| 财务 | T27 | `apps/web/components/finance/salary-workspace.tsx:841` | 8 | 需要修 |
| 财务 | T28 | `apps/web/components/finance/salary-workspace.tsx:845` | 6 | 需要修 |
| 财务 | T29 | `apps/web/components/finance/salary-workspace.tsx:847` | 5 | 需要修 |
| 财务 | T11 | `apps/web/components/finance/payable-workspace.tsx:962` | 4 | 需要修 |
| 财务 | T12 | `apps/web/components/finance/payable-workspace.tsx:970` | 8 | 需要修 |
| 财务 | T13 | `apps/web/components/finance/payable-workspace.tsx:972` | 4 | 需要修 |
| 财务 | T14 | `apps/web/components/finance/payable-workspace.tsx:1097` | 13 | 需要修 |
| 财务 | T15 | `apps/web/components/finance/payable-workspace.tsx:1101` | 13 | 需要修 |
| 财务 | T16 | `apps/web/components/finance/payable-workspace.tsx:1115` | 13 | 需要修 |
| 财务 | T17 | `apps/web/components/finance/payable-workspace.tsx:1125` | 19 | 需要修 |
| 财务 | T18 | `apps/web/components/finance/payable-workspace.tsx:1165` | 14 | 需要修 |
| 财务 | T19 | `apps/web/components/finance/payable-workspace.tsx:1185` | 3 | 需要修 |
| 人力·报表·工作台·账号·拆单·BOM | T12 | `apps/web/components/hr/organization-pool.tsx:36` | 9 | 需要修 |
| 人力·报表·工作台·账号·拆单·BOM | T4 | `apps/web/app/reports/page.tsx:46` | 6 | 需要修 |
| 人力·报表·工作台·账号·拆单·BOM | T5 | `apps/web/app/reports/page.tsx:46` | 9 | 需要修 |
| 人力·报表·工作台·账号·拆单·BOM | T6 | `apps/web/app/workbench.tsx:64` | 6 | 需要修 |
| 人力·报表·工作台·账号·拆单·BOM | T7 | `apps/web/app/workbench.tsx:65` | 8 | 需要修 |
| 人力·报表·工作台·账号·拆单·BOM | T10 | `apps/web/components/reorder/document-groups.tsx:81` | 5 | 需要修 |
| 人力·报表·工作台·账号·拆单·BOM | T9 | `apps/web/components/reorder/unassigned-panel.tsx:116` | 8 | 需要修 |
| 人力·报表·工作台·账号·拆单·BOM | T8 | `apps/web/components/account/account-center.tsx:138` | 6 | 需要修 |
| 人力·报表·工作台·账号·拆单·BOM | T1 | `apps/web/app/hr/page.tsx:1042` | 3 | 需要修 |
| 人力·报表·工作台·账号·拆单·BOM | T2 | `apps/web/app/hr/page.tsx:1228` | 17 | 需要修 |
| 人力·报表·工作台·账号·拆单·BOM | T3 | `apps/web/app/hr/page.tsx:1240` | 6 | 需要修 |
| 返单（补审） | F1 | `apps/web/app/reorder/page.tsx:212` | 7 | 需要修 |
| 返单（补审） | F2 | `apps/web/app/reorder/page.tsx:273` | 5 | 需要修 |
| 返单（补审） | F3 | `apps/web/app/reorder/page.tsx:300` | 5 | 需要修 |
| 返单（补审） | F4 | `apps/web/app/reorder/page.tsx:321` | 10 | 需要修 |

### 已达标（7 张）

| 模块 | 表 | 位置 | 列数 | 当前状态 |
| --- | --- | --- | --- | --- |
| 采购 | T7 | `apps/web/app/procurement/plans/page.tsx:182` | 11 | 已达标 |
| 采购 | T3 | `apps/web/app/procurement/materials/page.tsx:276` | 3 | 已达标 |
| 采购 | T4 | `apps/web/app/procurement/materials/page.tsx:286` | 4 | 已达标 |
| 采购 | T5 | `apps/web/app/procurement/materials/page.tsx:315` | 10 | 已达标 |
| 财务 | T30 | `apps/web/components/finance/voucher-workspace.tsx:361` | 11 | 已达标 |
| 财务 | T31 | `apps/web/components/finance/voucher-workspace.tsx:369` | 11 | 已达标 |
| 人力·报表·工作台·账号·拆单·BOM | T11 | `apps/web/components/bom/bom-workbench.tsx:258` | 10 | 已达标 |

### 不适用（11 张，可编辑网格 / 打印单据）

| 模块 | 表 | 位置 | 列数 | 当前状态 |
| --- | --- | --- | --- | --- |
| 采购 | T10 | `apps/web/components/procurement/plan-detail-sheet.tsx:474` | 14 | 不适用 |
| 销售·仓库 | T4 | `apps/web/components/sales/sales-order-editor.tsx:792` | 7 | 不适用 |
| 生产·质检 | T5 | `apps/web/components/production/material-issues-panel.tsx:239` | 8 | 不适用 |
| 生产·质检 | T17 | `apps/web/components/production/material-slip-editor.tsx:242` | 13 | 不适用 |
| 生产·质检 | T15 | `apps/web/components/production/daily-reports-panel.tsx:299` | 8 | 不适用 |
| 生产·质检 | T16 | `apps/web/components/production/daily-reports-panel.tsx:303` | 10 | 不适用 |
| 财务 | T2 | `apps/web/components/finance/bank-transfer-slip-editor.tsx:119` | 4 | 不适用 |
| 财务 | T20 | `apps/web/components/finance/payroll-sheet.tsx:172` | 21 | 不适用 |
| 财务 | T3 | `apps/web/components/finance/bank-transfer-slip-editor.tsx:181` | 4 | 不适用 |
| 财务 | T10 | `apps/web/components/finance/payable-merge-payment-dialog.tsx:278` | 6 | 不适用 |
| 财务 | T32 | `apps/web/components/finance/voucher-workspace.tsx:408` | 4 | 不适用 |

# A — 采购模块表格清单

审计范围：`apps/web/app/procurement/**/*`、`apps/web/components/procurement/**/*`（只读，未改动任何源文件）。
判定口径：`DataTable`（`components/data/data-table.tsx`）只要**任一列**有 `meta.width` 就给 `<table>` 加 `data-table-fixed`（`table-layout: fixed`，见 `globals.css:232`），表宽锁死在容器内；`meta.ellipsis` 加 `.cell-ellipsis` + 原生 `title`。手写 `<table>` 走 CSS 选择器，两样都要自己写。

## 统计
- 表格总数: 10
- DataTable 调用点: 8
- 手写 `<table>`: 2
- 需要修（列宽不受限 / 无省略悬停）: 5
- 已达标: 4
- 不适用（可编辑网格等，需保持现状）: 1

## 明细

### [T1] apps/web/app/procurement/boms/page.tsx:139
- 渲染方式: DataTable
- 表格标识: `data-testid="page-procurement-boms"` 页内「已确认销售单 → BOM 表入口」列表（列定义 85–96 行；未传 `tableClassName`）
- 列数: 5
- 列清单: 订单号(宽度=无, 省略=无) BOM状态(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) BOM表·操作按钮(宽度=无, 省略=无)
- 列宽约束现状: 无（列定义里没有任何 `meta.width` → 自动布局）
- 省略与悬停现状: 无（仅审计列 `auditActorCell` 自带容器 `title`，见 `components/data/audit-columns.tsx:51`）
- 判定: 需要修
- 风险与备注: `.ui-table-cell` 是 `white-space: nowrap`（`globals.css:89`），自动布局下每列最小宽度 = 该列最长文本宽度；订单号列随销售单号变长即把表顶出 `.ui-table-wrap`（横滑）。5 列很少，给 5 个 `meta.width` 即可收口。

### [T2] apps/web/app/procurement/inbounds/page.tsx:154
- 渲染方式: DataTable
- 表格标识: `data-testid="page-procurement-inbounds"` 页内「原料入库单」列表（跨模块状态 + 财务付款通知；列定义 107–137 行）
- 列数: 13
- 列清单: 入库单号(宽度=无, 省略=无) 订单号(宽度=无, 省略=无) 采购单号(宽度=无, 省略=无) 到货批次(宽度=无, 省略=无) 到货记录(宽度=无, 省略=无) 数量(宽度=无, 省略=无) 质检状态(宽度=无, 省略=无) 入库状态(宽度=无, 省略=无) 应付来源(宽度=无, 省略=无) 财务付款(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无
- 省略与悬停现状: 无（审计两列自带 `title`）
- 判定: 需要修
- 风险与备注: 13 列、全部 nowrap 且零列宽 —— 是本次范围里最容易横滑的一张（单号类列最长，`应付来源` 还被拼成 `金额（状态）`）。修时必须同时给「应付来源 / 财务付款 / 操作」定宽：这两列分别装的是拼接文本与按钮，只加省略号没用。

### [T3] apps/web/app/procurement/materials/page.tsx:276
- 渲染方式: DataTable
- 表格标识: `tableClassName="materials-page-table"`，用途「批量导入结果 → 未导入的行」（列定义内联在 276–282 行）
- 列数: 3
- 列清单: Excel 行号(宽度=有 12%, 省略=无) 字段(宽度=有 18%, 省略=有) 原因(宽度=有 70%, 省略=有)
- 列宽约束现状: meta.width 覆盖 3/3 列（和 = 100%）→ `data-table-fixed`
- 省略与悬停现状: meta.ellipsis 覆盖 2 列（字段 / 原因），`title` 由 DataTable 的 `ellipsisTitle(rendered, value)` 从 `accessorKey` 取值给出
- 判定: 已达标
- 风险与备注: 唯一「行长提示」列（原因）已定宽 + 省略 + hover；Excel 行号是纯数字，不加省略号是对的。

### [T4] apps/web/app/procurement/materials/page.tsx:286
- 渲染方式: DataTable
- 表格标识: `tableClassName="materials-page-table"`，用途「批量导入结果 → 已新增的物料」（列定义内联在 286–291 行）
- 列数: 4
- 列清单: Excel 行号(宽度=有 14%, 省略=无) 物料编码(宽度=有 30%, 省略=有) 编码来源(宽度=有 18%, 省略=无) 物料名称(宽度=有 38%, 省略=有)
- 列宽约束现状: meta.width 覆盖 4/4 列（和 = 100%）
- 省略与悬停现状: meta.ellipsis 覆盖 2 列（物料编码 / 物料名称）；「编码来源」只有「自动生成 / 表里填写」两种固定短文本，无需省略
- 判定: 已达标
- 风险与备注: 无。

### [T5] apps/web/app/procurement/materials/page.tsx:315
- 渲染方式: DataTable
- 表格标识: `tableClassName="materials-page-table"`，用途「物料清单」主表（列定义 206–233 行，宽度常量 `COLUMN_WIDTH` 53–66 行）
- 列数: 10
- 列清单: 物料编码(宽度=有 12%, 省略=有) 物料名称(宽度=有 14%, 省略=有) 规格型号(宽度=有 11%, 省略=有) 颜色(宽度=有 7%, 省略=有) 默认单位(宽度=有 7%, 省略=有) 图片(宽度=有 15%, 省略=无) 状态(宽度=有 5%, 省略=无) 创建人(宽度=有 8%, 省略=无) 最后修改人(宽度=有 8%, 省略=无) 操作(宽度=有 13%, 省略=无)
- 列宽约束现状: meta.width 覆盖 10/10 列（和 = 100%，即表宽 = 容器宽）；`globals.css:829-832` 只做紧凑化与审计格两行布局
- 省略与悬停现状: meta.ellipsis 覆盖 5 列（编码/名称/规格/颜色/单位），`title` 由 accessor 值回退给出；审计两列由 `auditActorCell` 容器自带 `title`；图片/操作是控件列，刻意不给省略
- 判定: 已达标
- 风险与备注: 本页是全模块的**参考实现**（用户 2026-10-08 原始诉求的落地页，实测数据见 `globals.css:813-828` 注释）。注意「默认单位」用 `accessorFn` 而非 `id`+`cell`，否则省略号会出现但 hover 一片空白 —— 其它页照抄时别抄错。

### [T6] apps/web/app/procurement/orders/page.tsx:225
- 渲染方式: DataTable
- 表格标识: `data-testid="page-procurement-orders"` 页内「采购单」列表（列数组 `orderColumns` 185–208 行）
- 列数: 8
- 列清单: 采购单号(宽度=无, 省略=无) 订单号(宽度=无, 省略=无) 供应商(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 金额(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无
- 省略与悬停现状: 无（审计两列自带 `title`）
- 判定: 需要修
- 风险与备注: 供应商名与「金额+币种」无界；`操作` 列最多同时渲染 6 个控件（到货跟踪/关闭到货/退回采购计划/打印信息/导出/已关闭），自动布局下长供应商名会把这一列挤到折行甚至把表顶出容器。

### [T7] apps/web/app/procurement/plans/page.tsx:182
- 渲染方式: DataTable
- 表格标识: `data-testid="page-procurement-plans"`（page-root 类 `purchase-plan-list`）页内「采购计划」列表（列定义 123–149 行）
- 列数: 11
- 列清单: 计划编号(宽度=有 11%, 省略=有) 销售单号(宽度=有 11%, 省略=有) 货号(宽度=有 8%, 省略=有) 客户(宽度=有 11%, 省略=有) BOM 版本(宽度=有 6%, 省略=无) 行数(宽度=有 5%, 省略=无) 未下单(宽度=有 7%, 省略=无) 计划金额(宽度=有 13%, 省略=有) 状态(宽度=有 7%, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=有 8%, 省略=无)
- 列宽约束现状: meta.width 覆盖 10/11 列（和 = 87%）；只要有一列带 `meta.width` 即 `data-table-fixed`，第 11 列（`updatedByColumn()`，工厂不给宽度，`audit-columns.tsx:68-74`）按固定布局算法吃掉剩余 13%
- 省略与悬停现状: meta.ellipsis 覆盖 5 列；审计列由 `auditActorCell` 容器自带 `title`
- 判定: 已达标
- 风险与备注: 固定布局下余量自动分给未定宽列，所以**不会溢出**，这是它算达标的原因。两点脆弱：① 审计列拿 13%（远宽于它需要的 8%），一旦有人往表里插一列且忘记了宽度，余量分配会静默改变版式；② 「计划金额」列的自定义 cell 返回 ReactNode、且该列用 `id` 无 accessor，DataTable 的 `ellipsisTitle` 取不到值 —— 只有携带「其中未下单」时才由内层 `<span title>` 给提示，纯已下单金额被省略后**没有**全文 hover。

### [T8] apps/web/app/procurement/suppliers/page.tsx:165
- 渲染方式: DataTable
- 表格标识: `data-testid="page-procurement-suppliers"` 页内「供应商池」列表（列定义 121–140 行）
- 列数: 10
- 列清单: 供应商编码(宽度=无, 省略=无) 供应商名称(宽度=无, 省略=无) 联系人(宽度=无, 省略=无) 联系电话(宽度=无, 省略=无) 地址(宽度=无, 省略=无) 备注(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无
- 省略与悬停现状: 无（审计两列自带 `title`）
- 判定: 需要修
- 风险与备注: 「地址」「备注」是自由文本，实际数据里就有长句；10 列全自动布局 + nowrap，地址一长整张表横滑。操作列三个按钮（编辑/停用/删除），定宽时别压到放不下（参考物料清单页给到 13%）。

### [T9] apps/web/app/procurement/orders/[id]/page.tsx:100
- 渲染方式: 手写 table（`<table className="ui-table batch-table">`，包在 `<div className="table-wrap">` 里；同一行 JSX 同时渲染每个物料区块的表头与行）
- 表格标识: `batch-table`（CSS：`globals.css:365-367`、`378-379`、`380`），用途「采购单详情 → 每个物料的到货批次流转（到货/质检/入库/操作）」
- 列数: 6
- 列清单: 物料(宽度=无, 省略=有——`.cell-material` `max-width:220px` + `text-overflow: ellipsis`，且逐格手写 `title={ml}`) 批次(宽度=无, 省略=无) 到货(宽度=无, 省略=无) 质检(宽度=无, 省略=无) 入库(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无显式列宽（无 CSS width，无 `table-layout: fixed`）；仅 `.table-wrap { overflow-x: auto }`（`globals.css:172`）兜住溢出，即横滑条
- 省略与悬停现状: 只有「物料」列有 CSS `text-overflow` + 手写 `title`；其余 5 列无省略、无 `title`（审计格无关，本表无审计列）
- 判定: 需要修
- 风险与备注: 「入库」列把该批次的全部入库单拼成 `数量(状态)、数量(状态)…`，是典型的无界文本列；`.purchase-item-block .ui-table td { white-space: nowrap }` 保证它一定撑宽。`操作` 列最多 4 个按钮，省略无意义 —— 修的时候按列区分处理。附带发现（非本次任务，但同属这张表）：单元格是裸 `<td>`，没有 `.ui-table-cell` 类，于是连 `padding: 12px` 都没有（全局只有 `.ui-table-head` 与 `.ui-table-cell` 给内边距）。

### [T10] apps/web/components/procurement/plan-detail-sheet.tsx:474
- 渲染方式: 手写 table（`<table className="data-table plan-draft-table">`，在采购计划详情 Sheet 内，包在 `<div className="table-wrap">`）
- 表格标识: page 侧 `purchase-plan-sheet` + SheetContent 的 `material-issue-sheet` 双层类（`globals.css:511-553`），用途「采购计划明细编辑（唯一能改数量/单价/供应商的地方）」
- 列数: 14
- 列清单: 勾选(宽度=有 3%) 名称(宽度=有 11%) 型号(宽度=有 7%) 下单状态(宽度=有 8%) 本次采购量(宽度=有 6%) 当前库存量(宽度=有 6%, 省略=有) 单位(宽度=有 5%) 单价(宽度=有 6%) 行总价(宽度=有 7%, 省略=有) 供应商(宽度=有 11%) 供应商地址(宽度=有 11%, 省略=有) 联系人(宽度=有 8%, 省略=有) 预计到货(宽度=有 7%) 操作(宽度=有 4%)
- 列宽约束现状: CSS 选择器 `.purchase-plan-sheet.material-issue-sheet .data-table { min-width: 0; table-layout: fixed }`（`globals.css:511`）+ 14 条 `.plan-col-*` 显式宽度，和 = 100%（`globals.css:522-535`）
- 省略与悬停现状: 自写 CSS `text-overflow`（`.plan-cell-ellipsis`，`globals.css:542`）覆盖 4 个只读列，且这 4 格逐格手写 `title`（库存 506 行、行总价 530 行、地址 546 行、联系人 547 行）；编辑格（名称/型号/数量/单位/单价/供应商/预计到货）刻意不省略，只有已下单锁定时给 `lockedHint` 提示
- 判定: 不适用
- 风险与备注: 单元格里是 `<Select>` / `<Input>` / `<input type=date>` / checkbox，属于「可编辑网格需保持自己的布局」那一类：对输入框做省略无意义，压窄只会挤坏控件。列宽与省略已经单独做全（14/14 定宽、和 100%），改造成 DataTable 反而会丢掉 `plan-col-*` 这套实测过的宽度。

## 建议

按修法分组，同一组一次改完：

1. **T1 / T2 / T6 / T8 —— 「零列宽 + 零省略」的四张只读 DataTable，统一照物料清单页（T5）的做法改**
   - 每列补 `meta: { width: "…%" }`，同表内宽度和 = 100%（和 < 100% 时余量会被分给未定宽列，版式照样漂）；
   - 文本列补 `meta.ellipsis: true`：T1「订单号」；T2「入库单号 / 订单号 / 采购单号 / 到货记录 / 应付来源 / 财务付款」；T6「采购单号 / 订单号 / 供应商 / 金额」；T8「供应商编码 / 名称 / 联系人 / 电话 / 地址 / 备注」；
   - **不要**给控件列加省略：T2「操作」、T6「操作」（最多 6 个控件）、T8「操作」（3 个按钮）只给足宽度（物料清单页给控件列 13%~15%）；
   - T2 列数最多（13 列），先按物料清单页那样收 `padding`（`globals.css:830` 的 `.ui-table-head/.ui-table-cell { padding: 6px 8px }` 同款），再用列宽换「一次性展示」。
   - 顺带提醒照抄的坑：文本列要用 `accessorKey` / `accessorFn`，纯 `id` + 自定义 `cell` 的列拿不到省略 `title`（`data-table.tsx:75-77`）。

2. **T7 —— 采购计划列表：只差「补齐 87% → 100%」与「金额列的 hover 兜底」**
   - 给 `updatedByColumn<PlanRow>()`（`plans/page.tsx:147`）补 `meta.width`，或按物料清单页的写法 `{ ...updatedByColumn<PlanRow>(), meta: { width: "…%" } }`；现在的 13% 余量全归审计列，一旦增删列就静默改版；
   - 「计划金额」（135–145 行）改为 `accessorFn: (row) => amountSummaryText(row.amounts ?? [])`，让 DataTable 的 `ellipsisTitle` 有值可取，省掉「省略了却悬停无字」的那一半。

3. **T9 —— 采购单详情的批次表：给「入库」列定界，并顺手补类名**
   - 该列是把多条入库拼成的串，最省事的修法是给 `batch-table` 定 `table-layout: fixed` + 逐列宽度（与 T10 同一套 CSS 手法），或至少给「入库 / 到货 / 质检」加 `max-width` + `text-overflow: ellipsis` + 手写 `title`；
   - 「操作」列是按钮，只给宽度；
   - 顺带把裸 `<td>` 补上 `ui-table-cell` 类（否则整表没有单元格内边距，且 `.ui-table-cell` 的 nowrap 也没生效在这张表上）。

4. **T3 / T4 / T5 —— 不动**（三张表列宽与省略已完备；T5 是本次的统一模板）。

5. **T10 —— 明确保持现状**（可编辑网格，14 列已定宽 + 4 个只读列已省略带 title）。

6. **范围外但由本模块页面渲染，未计入统计**：`apps/web/components/bom/bom-workbench.tsx:258` 的 `<table className="data-table bom-table">`（BOM 编辑网格）由 `apps/web/app/procurement/boms/page.tsx:103` 的 `<BomWorkbench>` 渲染。它的路径不在本次范围内，但它是「可编辑网格」的同类（`globals.css:767` 已 `table-layout: fixed` + `.bom-col-*` 宽度），若后续统一整改需要单独排期。

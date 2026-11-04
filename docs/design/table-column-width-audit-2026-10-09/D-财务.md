# D — 财务模块表格清单

审计范围：`apps/web/app/finance/**/*`（13 个路由文件，全是装配壳，无表格）+ `apps/web/components/finance/**/*`（21 个组件）。
判据（来自 data-table.tsx / globals.css）：`meta.width` 一旦出现在任一列 → `<table>` 加 `data-table-fixed` → `table-layout: fixed`；`meta.ellipsis` → 单元格加 `cell-ellipsis` + 原生 `title`。
两条关键基础设施事实（决定了下面每一格的判定）：
1. `.finance-page .ui-table-cell { white-space: normal; overflow-wrap: anywhere }`（globals.css:212）**只对留在 `.finance-page` DOM 子树里的表生效**。`DialogContent` 用 Radix Portal 渲染到 body（components/ui/dialog.tsx:13），所以**详情弹窗/导入弹窗里的 DataTable 完全享受不到这条**——它们退回 `.ui-table-cell { padding:12px; white-space:nowrap }`（globals.css:89）+ 12px 表头，自动布局下每列 min-content 等于整段文本宽度，靠 `.table-wrap { overflow-x:auto }` 横向滚动兜着。本次有 9 张表属于这种情况。
2. `.ui-table.data-table-fixed .ui-table-cell.cell-ellipsis`（globals.css:237，(0,4,0)）权重压过 `.finance-page .ui-table-cell`（(0,2,0)）与 `.finance-page .payroll-sheet-table .ui-table-cell`（(0,3,0)），所以在财务页里补 `meta.width + meta.ellipsis` 是**能生效**的，不需要再动 CSS。
3. `DataTable` 从不给 `<th>` 加 `cell-ellipsis`（data-table.tsx:88 只给 style.width），所以 globals.css:238 的 `.ui-table-head.cell-ellipsis` 对 DataTable 是死代码：固定布局下表头只能换行（财务页）或被 `overflow:hidden` 裁掉（弹窗）。
4. `ellipsisTitle` 只认字符串/数字（data-table.tsx:53-77）：列 `cell` 返回 JSX（按钮、badge、`<span data-testid>`、勾选框）时，`ellipsis: true` 只会截断、**不会**有 hover 全文；那类格子要提示得自己在容器上写 `title`（audit-columns.tsx:47-56 的 `auditActorCell` 就是范例）。

## 统计
- 表格总数: 32
- DataTable 调用点: 27
- 手写 <table>: 5
- 需要修（列宽不受限 / 无省略悬停）: 25
- 已达标: 2
- 不适用（可编辑网格等，需保持现状）: 5

## 明细

### [T1] apps/web/components/finance/accounting-subject-workspace.tsx:226
- 渲染方式: DataTable
- 表格标识: panel「会计科目」内的表（页 testId=page-finance-accounting-subjects；列定义 171-186）
- 列数: 7
- 列清单: 分类(宽度=无, 省略=无) 项目(无,无) 余额方向(无,无) 状态(无,无) 创建人(无,无) 最后修改人(无,无) 操作(无,无)
- 列宽约束现状: 无（meta.width 覆盖 0/7 列，整表未加 data-table-fixed）
- 省略与悬停现状: 无（meta.ellipsis 覆盖 0 列）；创建人/最后修改人由 `auditActorCell` 在容器上自写 title（audit-columns.tsx:47-56）
- 判定: 需要修
- 风险与备注: 宿主在 `.finance-page` 里（cash-flow-workspace.tsx:301 的 page-root），靠换行才没撑破容器，但列宽仍随内容浮动、「项目」这种长名（占位示例「销售费 运费」）没有省略 + hover 全文。操作列 3 个按钮（178-185），切 fixed 布局后必须给死宽度（如 12%），否则被压成 2-3 行。

### [T2] apps/web/components/finance/bank-transfer-slip-editor.tsx:119
- 渲染方式: 手写 table
- 表格标识: `className="transfer-slip-table"`（跨行转账单正文，打印件）
- 列数: 4（label/value/label/value 四栏栅格，按段用 colSpan 混排）
- 列清单: 付款方段（付款方全称/账号/开户行）· 收款方段（全称/账号/开户行/联行号/转账日期）· 金额段（币种/汇率/原币金额/折合人民币/大写金额）· 用途；每格是 `cell()` 工厂产出的可编辑 `<input class="transfer-slip-input">`（同文件 96-105）
- 列宽约束现状: CSS `.transfer-slip-table, .transfer-slip-sign { width:100%; table-layout: fixed }`（globals.css:692）
- 省略与悬停现状: 无（单据不需要）
- 判定: 不适用
- 风险与备注: 银行纸质转账单版式，四栏等宽由模板决定；单元格里是输入框，压窄会挤坏打印稿，省略号也没有意义。

### [T3] apps/web/components/finance/bank-transfer-slip-editor.tsx:181
- 渲染方式: 手写 table
- 表格标识: `className="transfer-slip-sign"`（制单/审核/记账/单位负责人签字栏）
- 列数: 4
- 列清单: 制单(宽度=无, 省略=无) 审核(无,无) 记账(无,无) 单位负责人(无,无)，各格含可编辑 input
- 列宽约束现状: CSS `.transfer-slip-sign { width:100%; table-layout: fixed }` + `td { text-align:center; height:46px }`（globals.css:692-697）
- 省略与悬停现状: 无
- 判定: 不适用
- 风险与备注: 手写签名区，格高与居中由 CSS 定；它是单据的一部分，与 T2 同一张打印稿。

### [T4] apps/web/components/finance/bank-transfer-workspace.tsx:319
- 渲染方式: DataTable
- 表格标识: panel `data-testid="bank-transfer-balances"`「本方账户余额」（列定义 233-245）
- 列数: 10
- 列清单: 银行编码(无,无) 银行名称(无,无) 银行账号(无,无) 币种(无,无) 期初余额(无,无) 收入(无,无) 支出(无,无) 转入(无,无) 转出(无,无) 当前余额(无,无)
- 列宽约束现状: 无（0/10 列有 meta.width）
- 省略与悬停现状: 无（0 列 meta.ellipsis；无自写 title）
- 判定: 需要修
- 风险与备注: 在 `.finance-page` 内靠换行兜住溢出。会撑宽的是「银行名称」（如「中国农业银行股份有限公司」）与「银行账号」（长串数字）；「当前余额」是 JSX `<span data-testid=…>`（244），即使加 ellipsis 也拿不到 title，要 hover 需在 span 上自写 `title` 或改用 accessorFn。

### [T5] apps/web/components/finance/bank-transfer-workspace.tsx:326
- 渲染方式: DataTable
- 表格标识: panel `data-testid="bank-transfer-list"`「互转记录」（列定义 247-271）
- 列数: 14
- 列清单: 互转单号(无,无) 日期(无,无) 本方账户(无,无) 本方币种(无,无) 本方金额(无,无) 对方账户(无,无) 对方币种(无,无) 对方金额(无,无) 汇率(无,无) 状态(无,无) 备注(无,无) 创建人(无,无) 最后修改人(无,无) 操作(无,无)
- 列宽约束现状: 无（0/14 列有 meta.width）
- 省略与悬停现状: 无（0 列 meta.ellipsis）；两列审计列自带容器 title
- 判定: 需要修
- 风险与备注: 「本方账户/对方账户」是 `bankName / accountNumber` 拼接串（同文件 58 `accountText`），「状态」在已冲销时拼上整段冲销原因（258），这两类是主要撑宽源；备注列同理。操作列两个按钮（跨行转账单/冲销）需固定宽度。

### [T6] apps/web/components/finance/bank-workspace.tsx:234
- 渲染方式: DataTable
- 表格标识: panel「银行账户池」（列定义 184-205，页 testId=page-finance-banks）
- 列数: 14
- 列清单: 银行编码(无,无) 银行名称(无,无) 账户名称(无,无) 银行账号(无,无) 币种(无,无) 期初余额(无,无) 当前余额(无,无) 余额构成(无,无) SWIFT(无,无) 状态(无,无) 备注(无,无) 创建人(无,无) 最后修改人(无,无) 操作(无,无)
- 列宽约束现状: 无（0/14 列有 meta.width）
- 省略与悬停现状: 无（0 列 meta.ellipsis）；审计两列自带容器 title
- 判定: 需要修
- 风险与备注: 「余额构成」是 `期初 X + 收 Y − 付 Z + 转入 A − 转出 B = 余额`（178-182）这种超长拼接句，是这张表最需要「固定宽度 + 省略 + hover 全文」的一列；「账户名称」是公司全称；「当前余额」「余额构成」都是 JSX（192-193），加 ellipsis 也没有 title。操作列 3 个按钮（199-203）。

### [T7] apps/web/components/finance/cash-flow-workspace.tsx:385
- 渲染方式: DataTable
- 表格标识: panel「收支流水」（列定义 271-296）
- 列数: 16
- 列清单: 日期(无,无) 对方名称(无,无) 收支(无,无) 金额(无,无) 币种(无,无) 分类(无,无) 项目(无,无) 结算方式(无,无) 银行账户(无,无) 款项性质(无,无) 订单号(无,无) 来源(无,无) 状态(无,无) 创建人(无,无) 最后修改人(无,无) 操作(无,无)
- 列宽约束现状: 无（0/16 列有 meta.width）
- 省略与悬停现状: 无（0 列 meta.ellipsis）；审计两列自带容器 title
- 判定: 需要修
- 风险与备注: 16 列是财务页里偏宽的几张之一。「项目」是「分类 / 科目名」（278），「结算方式」把结算方式与结算账户标签用 `--` 拼起来（279），「银行账户」是 `bankName / accountNumber`（280）；「来源」是 `<span className="badge">`（285，JSX → ellipsis 无 title）。

### [T8] apps/web/components/finance/finance-report-workspace.tsx:296
- 渲染方式: DataTable
- 表格标识: panel「{当前报表名}」（报表预览；页 testId=page-finance-reports）
- 列数: 动态——等于后端 `ReportTable.columns.length`（前端 `columns = (table?.columns ?? []).map(...)`，同文件 155-162）。已核实的取值：销售对账明细表 23 列（apps/api/src/modules/finance/finance-report.tables.ts:49-74）、采购对账明细表 17 列（同文件 162-180）；销售对账汇总/毛利/核算/收支明细/收支汇总/外汇一览表与三大报表分别由 finance-report.tables.ts、finance-report-forex.tables.ts、finance-three-statements.ts:361-363 决定
- 列清单: 由后端列定义决定，前端只给 `id: col-N` / `header` / `cell`，**不带任何 meta**。以销售对账明细表为例：日期 销售单号 客户名称 产品名称 产品代码 规格型号 单位 币种 单价 含税单价 税额 调整金额 折扣 数量 金额 含税金额 汇率 单价(本) 含税单价(本) 税额(本) 调整金额(本) 金额(本) 含税金额(本)
- 列宽约束现状: 无（0/23 列有 meta.width；后端的 `ReportColumn.width` 是 Excel 列宽，不参与页面布局）
- 省略与悬停现状: 无（0 列 meta.ellipsis；无自写 title）
- 判定: 需要修
- 风险与备注: 全模块最宽的一张表（23 列，globals.css:205 的实测记录点了它的名）。它在 `.finance-page` 内，换行规则让它不横向滚动，代价是 1366 屏下每列只剩几十 px、行高被拉高，「产品名称/规格型号/客户名称」这类长文本既没有固定宽度也没有 hover 全文——恰是用户 2026-09-20 第 6 条要解决的问题。修法与其他表不同：宽度只能在前端按列下标 pattern 补（后端 width 只影响导出）。

### [T9] apps/web/components/finance/finance-slips-workspace.tsx:192
- 渲染方式: DataTable
- 表格标识: panel「已保存的{收/付款单}」（列定义 useMemo 113-132）
- 列数: 11
- 列清单: 单据编号(无,无) 日期(无,无) 对方单位(无,无) 币种(无,无) 汇率(无,无) 折合人民币(无,无) 借方合计(无,无) 行数(无,无) 制单人(无,无) 保存时间(无,无) 操作(无,无)
- 列宽约束现状: 无（0/11 列有 meta.width）
- 省略与悬停现状: 无（0 列 meta.ellipsis；无自写 title）
- 判定: 需要修
- 风险与备注: 「对方单位」是公司全称（最宽的一列）；「借方合计」是 JSX `<span data-testid={slip-total-…}>`（121），加 ellipsis 也无 title。操作列 3 个按钮（打开/导出/作废，126-131）。

### [T10] apps/web/components/finance/payable-merge-payment-dialog.tsx:278
- 渲染方式: 手写 table
- 表格标识: `className="data-table"`，容器 `data-testid="payable-merge-rows"`（合并付款逐行金额表）
- 列数: 6
- 列清单: 订单号(无,无) 供应商(无,无) 币种(无,无) 应付金额(无,无) 未核销余额(无,无) 本次核销金额(无,无，格内是 `<Input>`，287)
- 列宽约束现状: 无（手写表用不上 ColumnMeta）；生效的是通用 `.data-table th, .data-table td { white-space:nowrap; padding:0 14px; height:44px }`（globals.css:187）
- 省略与悬停现状: 无
- 判定: 不适用
- 风险与备注: 弹窗内容 Portal 到 body（ui/dialog.tsx:13），**不在** `.finance-page` 子树里，所以 `.finance-page .data-table`（208-212）那套紧凑/换行一条都不生效；表外也没有 `.table-wrap`（277-291），供应商名一长就会把 `.ui-dialog-content`（`overflow:auto`，globals.css:69）顶出滚动条。最后一列是逐行输入框，压窄会挤坏输入：这里需要的是「外层包 `.table-wrap` + 给金额列固定宽度」，不是省略号。

### [T11] apps/web/components/finance/payable-workspace.tsx:962
- 渲染方式: DataTable
- 表格标识: 详情弹窗（RecordDetailDialog）里的 section「付款核销记录」
- 列数: 4
- 列清单: 付款单号(无,无) 付款日期(无,无) 付款状态(无,无) 核销金额(无,无)
- 列宽约束现状: 无（0/4 列有 meta.width）
- 省略与悬停现状: 无
- 判定: 需要修
- 风险与备注: **弹窗内 → Portal 到 body → 不在 `.finance-page` 里**：拿到的是 `.ui-table-cell { padding:12px; white-space:nowrap }` + 自动布局，列宽完全不受限（弹窗宽 min(88vw,1080px)，`record-detail-dialog`，globals.css:586）；溢出表现为弹窗里出现横向滚动条（`.table-wrap` 在 data-table.tsx:88 自带的 `overflow-x:auto`）。

### [T12] apps/web/components/finance/payable-workspace.tsx:970
- 渲染方式: DataTable
- 表格标识: 应付对账详情弹窗 section「纳入对账的应付条目」
- 列数: 8
- 列清单: 应付单号(无,无) 采购物料(无,无) 规格型号(无,无) 采购单号(无,无) 来源批次(无,无) 订单号(无,无) 金额(无,无) 状态(无,无)
- 列宽约束现状: 无（0/8 列有 meta.width）
- 省略与悬停现状: 无
- 判定: 需要修
- 风险与备注: 同 T11 的 Portal 问题；「采购物料」「规格型号」在详情里本就是长文本（主列表里这两列由 `flow.material_names.join("、")` 生成），nowrap 下会把弹窗顶宽。

### [T13] apps/web/components/finance/payable-workspace.tsx:972
- 渲染方式: DataTable
- 表格标识: 应付对账详情弹窗 section「仍待接收的来源」
- 列数: 4
- 列清单: 来源批次(无,无) 订单号(无,无) 数量(无,无) 金额(无,无)
- 列宽约束现状: 无（0/4 列有 meta.width）
- 省略与悬停现状: 无
- 判定: 需要修
- 风险与备注: 同 T11 的 Portal 问题；4 列都短，风险等级低于 T12，但「无列宽约束 + 无省略悬停」这一条同样成立。

### [T14] apps/web/components/finance/payable-workspace.tsx:1097
- 渲染方式: DataTable
- 表格标识: panel「原料入库条目」（列定义 inboundColumns，769-782）
- 列数: 13
- 列清单: 入库单号(无,无) 订单号(无,无) 采购单号(无,无) 批次(无,无) 供应商(无,无) 原料(无,无) 入库数量(无,无) 单价(无,无) 应付金额(无,无) 来源状态(无,无) 创建人(无,无) 最后修改人(无,无) 操作(无,无)
- 列宽约束现状: 无（0/13 列有 meta.width）
- 省略与悬停现状: 无（0 列 meta.ellipsis）；审计两列自带容器 title
- 判定: 需要修
- 风险与备注: 在 `.finance-page` 内靠换行兜住溢出；「原料」是 `materialText()` 的拼接结果、「供应商」是公司全称，二者最宽。行可双击进详情（1097），fixed 后需给操作列固定宽度。

### [T15] apps/web/components/finance/payable-workspace.tsx:1101
- 渲染方式: DataTable
- 表格标识: panel「外加工签收」（列定义 outsourceColumns，783-796）
- 列数: 13
- 列清单: 外加工批次(无,无) 签收单(无,无) 订单号(无,无) 采购单号(无,无) 供应商(无,无) 原料(无,无) 签收数量(无,无) 单价(无,无) 应付金额(无,无) 来源状态(无,无) 创建人(无,无) 最后修改人(无,无) 操作(无,无)
- 列宽约束现状: 无（0/13 列有 meta.width）
- 省略与悬停现状: 无（0 列 meta.ellipsis）
- 判定: 需要修
- 风险与备注: 与 T14 同构（同一页、同一套 CSS 兜底），同样是「换行可用、固定列宽与 hover 全文缺失」。

### [T16] apps/web/components/finance/payable-workspace.tsx:1115
- 渲染方式: DataTable
- 表格标识: panel「应付对账」→ `data-testid="payable-pending-entries"`「待创建对账」（列定义 pendingEntryColumns，851-870）
- 列数: 13
- 列清单: 供应商(无,无) 应付单号(无,无) 待对账月份(无,无) 来源批次(无,无) 订单号(无,无) 采购单号(无,无) 采购物料(无,无) 规格型号(无,无) 应付金额(无,无) 确认日期(无,无) 创建人(无,无) 最后修改人(无,无) 操作(无,无)
- 列宽约束现状: 无（0/13 列有 meta.width）
- 省略与悬停现状: 无（0 列 meta.ellipsis）
- 判定: 需要修
- 风险与备注: 「供应商」「采购物料」「规格型号」三列都是长文本；「供应商」列在查不到内嵌对象时会退化成 UUID（852），固定布局下会被裁掉一半而没有任何提示。

### [T17] apps/web/components/finance/payable-workspace.tsx:1125
- 渲染方式: DataTable
- 表格标识: panel「应付对账」→ `data-testid="payable-reconciliations"`「已创建对账单」（列定义 reconciliationColumns，824-849）
- 列数: 19
- 列清单: 对账单号(无,无) 供应商(无,无) 订单号(无,无) 采购单号(无,无) 采购物料(无,无) 规格型号(无,无) 期间(无,无) 待确认应付(无,无) 应付快照(无,无) 已付快照(无,无) 系统余额(无,无) 外部余额(无,无) 差异(无,无) 支付银行(无,无) 会计科目(无,无) 状态(无,无) 创建人(无,无) 最后修改人(无,无) 操作(无,无)
- 列宽约束现状: 无（0/19 列有 meta.width）
- 省略与悬停现状: 无（0 列 meta.ellipsis）
- 判定: 需要修
- 风险与备注: 19 列是全模块第二宽的表，且「采购物料 / 规格型号 / 订单号 / 采购单号」四列都是「、」拼接的列表串（`flow.material_names.join("、")` 等，827-830），内容长度不可控。它是 1366 屏下最需要固定列宽 + 省略 + hover 的一张。

### [T18] apps/web/components/finance/payable-workspace.tsx:1165
- 渲染方式: DataTable
- 表格标识: panel「确认应付」台账（列定义 entryColumns，801-823；含 selectionColumn 754-768）
- 列数: 14
- 列清单: 选择(勾选框,无,无) 应付单号(无,无) 来源批次(无,无) 来源(无,无) 订单号(无,无) 供应商(无,无) 原料 / 说明(无,无) 应付金额(无,无) 未核销余额(无,无) 确认日期(无,无) 状态(无,无) 创建人(无,无) 最后修改人(无,无) 操作(无,无)
- 列宽约束现状: 无（0/14 列有 meta.width）
- 省略与悬停现状: 无（0 列 meta.ellipsis）
- 判定: 需要修
- 风险与备注: 第一列不只是勾选框：被锁的行旁边还要显示一整段中文原因（758-767 `locks.join("；")`），固定布局下必须单独给宽（否则会把「应付单号」挤没）；「原料 / 说明」在来源为 other 时直接显示 `sourceNoSnapshot`（808）。操作列最多 4 个按钮（814-822）。

### [T19] apps/web/components/finance/payable-workspace.tsx:1185
- 渲染方式: DataTable
- 表格标识: 批量导入弹窗（Dialog `data-testid="payable-import-dialog"`）内的错误明细表（列内联写在调用处）
- 列数: 3
- 列清单: 行号(无,无) 字段(无,无) 原因(无,无)
- 列宽约束现状: 无（0/3 列有 meta.width）
- 省略与悬停现状: 无
- 判定: 需要修
- 风险与备注: 弹窗内 → Portal → 不受 `.finance-page` 影响（同 T11）。「原因」是后端的中文报错文案（可长达一整句），nowrap 下弹窗必然横向滚动。

### [T20] apps/web/components/finance/payroll-sheet.tsx:172
- 渲染方式: 手写 table
- 表格标识: `<table className="ui-table payroll-sheet-table">`，容器 `data-testid="payroll-sheet"`（role=grid）；同一元素在两处挂载：salary-workspace.tsx:876（工资台账，可编辑）与 salary-workspace.tsx:894（工资付款，只读但带行内金额输入）
- 列数: 21（工资台账 sheetColumns，salary-workspace.tsx:522-553）/ 14（工资付款 paymentColumns，同文件 559-592）
- 列清单: 台账模式——工号 姓名 部门 岗位 类型 周期 币种 基本工资 绩效 房补 迟到扣款 旷工扣款 早退扣款 社保 个税 其他增减 应发 已付 未付 状态 操作（全部 宽度=无, 省略=无）；付款模式——选择(勾选框) 工号 姓名 部门 岗位 总工资 社保 个税 已付 未付 发放银行 状态 币种 付款操作（全部 宽度=无, 省略=无）
- 列宽约束现状: 无 meta（手写表）；生效的是 `.finance-page .payroll-sheet-table .ui-table-cell { padding:6px 8px; white-space:normal }`（globals.css:242）与 `.payroll-sheet-table { min-width: 100% }`（713）
- 省略与悬停现状: 只读格带 `title`，但那是**只读原因提示**（payroll-sheet.tsx:191 用 `readOnlyHint`），不是内容全文；无 text-overflow
- 判定: 不适用
- 风险与备注: 单元格级编辑 + 键盘导航 + 逐格保存（input、方向键/Tab/Enter 语义、失败标红，payroll-sheet.tsx:135-215），列宽必须由编辑行为决定（金额格 `min-width:72px`，globals.css:721）；压窄或省略会直接破坏「点开就能改」。付款模式虽不可逐格编辑，但操作列里是逐行金额输入框 + 付款/冲销按钮（salary-workspace.tsx:630-644），同样属于「自带布局」。

### [T21] apps/web/components/finance/receivable-workspace.tsx:669
- 渲染方式: DataTable
- 表格标识: 应收来源详情弹窗 section「收款核销记录」
- 列数: 5
- 列清单: 核销 ID(无,无) 收款单号(无,无) 收款日期(无,无) 收款状态(无,无) 核销金额(无,无)
- 列宽约束现状: 无（0/5 列有 meta.width）
- 省略与悬停现状: 无
- 判定: 需要修
- 风险与备注: 弹窗内 → Portal → 不受 `.finance-page` 影响（同 T11）。「核销 ID」是 UUID，nowrap 下它是这张表最宽的一格。

### [T22] apps/web/components/finance/receivable-workspace.tsx:675
- 渲染方式: DataTable
- 表格标识: 应收对账详情弹窗 section「纳入对账的应收条目」
- 列数: 8
- 列清单: 应收来源(无,无) 订单号(无,无) 客户(无,无) 产品(无,无) 规格型号(无,无) 金额(无,无) 未收(无,无) 状态(无,无)
- 列宽约束现状: 无（0/8 列有 meta.width）
- 省略与悬停现状: 无
- 判定: 需要修
- 风险与备注: 同 T21 的 Portal 问题；「客户/产品/规格型号」都是长文本，弹窗里既没有换行兜底也没有省略 + hover。

### [T23] apps/web/components/finance/receivable-workspace.tsx:765
- 渲染方式: DataTable
- 表格标识: panel「成品出库条目」（列定义 sourceColumns，542-554）
- 列数: 12
- 列清单: 应收来源(无,无) 订单号(无,无) 客户(无,无) 出库单(无,无) 产品(无,无) 数量(无,无) 应收金额(无,无) 未收(无,无) 状态(无,无) 创建人(无,无) 最后修改人(无,无) 操作(无,无)
- 列宽约束现状: 无（0/12 列有 meta.width）
- 省略与悬停现状: 无（0 列 meta.ellipsis）；审计两列自带容器 title
- 判定: 需要修
- 风险与备注: 「产品」列把产品名与规格型号拼成 `产品名（规格）`（547），「客户」可能是公司全称，二者是撑宽源；操作列按钮数量随状态变化（sourceActions），fixed 后需固定宽度。

### [T24] apps/web/components/finance/receivable-workspace.tsx:779
- 渲染方式: DataTable
- 表格标识: `data-testid="receivable-pending-entries"`「待创建对账的条目」（列定义 pendingSourceColumns，600-613）
- 列数: 12
- 列清单: 客户(无,无) 应收来源(无,无) 待对账月份(无,无) 订单号(无,无) 出库单(无,无) 产品(无,无) 规格型号(无,无) 应收金额(无,无) 出库日期(无,无) 创建人(无,无) 最后修改人(无,无) 操作(无,无)
- 列宽约束现状: 无（0/12 列有 meta.width）
- 省略与悬停现状: 无（0 列 meta.ellipsis）
- 判定: 需要修
- 风险与备注: 与 T16 对称。「客户」列在查不到内嵌对象时退化成 `customerId`（UUID，601），固定布局下会被裁掉且无提示。

### [T25] apps/web/components/finance/receivable-workspace.tsx:793
- 渲染方式: DataTable
- 表格标识: `data-testid="receivable-reconciliations"`「应收对账单」（列定义 reconciliationColumns，570-595）
- 列数: 18
- 列清单: 对账单号(无,无) 客户(无,无) 订单号(无,无) 产品(无,无) 规格型号(无,无) 期间(无,无) 待确认应收(无,无) 应收快照(无,无) 已收快照(无,无) 系统余额(无,无) 外部余额(无,无) 差异(无,无) 回款银行(无,无) 会计科目(无,无) 状态(无,无) 创建人(无,无) 最后修改人(无,无) 操作(无,无)
- 列宽约束现状: 无（0/18 列有 meta.width）
- 省略与悬停现状: 无（0 列 meta.ellipsis）
- 判定: 需要修
- 风险与备注: 18 列 + 「产品/规格型号」是 `product_names.join("、")` 拼接串（575-576）+ 「会计科目」是「分类 / 名称」（586），是应收侧最宽的一张。操作列按钮文案还会随草稿数变长（「一键确认应收（N 条）」，592）。

### [T26] apps/web/components/finance/receivable-workspace.tsx:824
- 渲染方式: DataTable
- 表格标识: panel「确认应收」台账（列定义 ledgerColumns，559-569；含 selectionColumn 534-540）
- 列数: 10
- 列清单: 选择(勾选框,无,无) 应收来源(无,无) 订单号(无,无) 客户(无,无) 应收金额(无,无) 到期日(无,无) 状态(无,无) 创建人(无,无) 最后修改人(无,无) 操作(无,无)
- 列宽约束现状: 无（0/10 列有 meta.width）
- 省略与悬停现状: 无（0 列 meta.ellipsis）
- 判定: 需要修
- 风险与备注: 与 T18 对称（应收侧勾选列没有锁定原因文字，宽度压力小一档）；「客户」可为公司全称。

### [T27] apps/web/components/finance/salary-workspace.tsx:841
- 渲染方式: DataTable
- 表格标识: 工资台账详情弹窗（RecordDetailDialog）section「生产日报来源」
- 列数: 8
- 列清单: 日期(无,无) 订单号(无,无) 工序(无,无) 计薪方式(无,无) 日报条数(无,无) 件数(无,无) 时长（小时）(无,无) 金额(无,无)
- 列宽约束现状: 无（0/8 列有 meta.width）
- 省略与悬停现状: 无
- 判定: 需要修
- 风险与备注: 弹窗内 → Portal → 不受 `.finance-page` 影响（同 T11）；「工序」名可长（如「平车合缝+包边」），nowrap 下撑宽弹窗。宿主页本身是 `.finance-page`（812），但这条 CSS 到不了 Portal 里。

### [T28] apps/web/components/finance/salary-workspace.tsx:845
- 渲染方式: DataTable
- 表格标识: 工资台账详情弹窗 section「工资调整」
- 列数: 6
- 列清单: 调整单号(无,无) 类型(无,无) 方向(无,无) 金额(无,无) 原因(无,无) 状态(无,无)
- 列宽约束现状: 无（0/6 列有 meta.width）
- 省略与悬停现状: 无
- 判定: 需要修
- 风险与备注: 同 T27 的 Portal 问题；「原因」是财务手写的调整原因（整句话），是本表的主要撑宽源。

### [T29] apps/web/components/finance/salary-workspace.tsx:847
- 渲染方式: DataTable
- 表格标识: 工资台账详情弹窗 section「工资付款核销」
- 列数: 5
- 列清单: 付款单号(无,无) 付款日期(无,无) 状态(无,无) 发放银行(无,无) 核销金额(无,无)
- 列宽约束现状: 无（0/5 列有 meta.width）
- 省略与悬停现状: 无
- 判定: 需要修
- 风险与备注: 同 T27 的 Portal 问题；「发放银行」是 `名称（账号）`（同文件 `bankLabel`，139），nowrap 下最宽。

### [T30] apps/web/components/finance/voucher-workspace.tsx:361
- 渲染方式: DataTable
- 表格标识: panel「收支流水」（记账凭证页；列定义 entryColumns，279-302）
- 列数: 11
- 列清单: 日期(宽度=有 6%, 省略=无) 流水号(有 9%, 无) 会计科目(有 15%, 有) 对方名称(有 12%, 有) 收支(有 4%, 无) 金额(有 9%, 无) 结算方式(有 12%, 有) 凭证(有 9%, 无) 创建人(无, 无) 最后修改人(无, 无) 操作(有 8%, 无)
- 列宽约束现状: meta.width 覆盖 9/11 列（自有两列合计 84%，刻意留 16% 给两列审计列，由 fixed 布局均分，见同文件 56-64 的注释）→ 整表切 `table-layout: fixed`
- 省略与悬停现状: meta.ellipsis 覆盖 3 列（会计科目 / 对方名称 / 结算方式，都是可长文本）；这三列 `cell` 返回字符串，`ellipsisTitle` 能取到值 → hover 有全文。两列审计列不用 ellipsis，靠 `auditActorCell` 的容器 title
- 判定: 已达标
- 风险与备注: 用户 2026-09-20 第 6 条在这张表上已落地。残余风险两条：① 操作列 8% 里最多 2 个按钮（295-299），文案再长会被压行；② 固定布局下 `.data-table-fixed .ui-table-head { overflow: hidden }`（globals.css:233）会把换到第二行的表头裁掉，而 DataTable 从不下发 `th.cell-ellipsis`（data-table.tsx:88），所以「表头过长」这一态无兜底——当前 11 个表头都在一行内。

### [T31] apps/web/components/finance/voucher-workspace.tsx:369
- 渲染方式: DataTable
- 表格标识: panel「记账凭证」（列定义 voucherColumns，304-329）
- 列数: 11
- 列清单: 凭证号(宽度=有 9%, 省略=无) 日期(有 6%, 无) 期间(有 5%, 无) 摘要(有 19%, 有) 借方合计(有 9%, 无) 贷方合计(有 9%, 无) 状态(有 5%, 无) 来源(有 12%, 有) 创建人(无, 无) 最后修改人(无, 无) 操作(有 10%, 无)
- 列宽约束现状: meta.width 覆盖 9/11 列（自有两列合计 84%，余 16% 给审计两列）→ `table-layout: fixed`
- 省略与悬停现状: meta.ellipsis 覆盖 2 列（摘要 19% / 来源 12%），两列都是字符串 cell → hover 有 title；审计两列自带容器 title
- 判定: 已达标
- 风险与备注: 与 T30 同一套宽度表与同一处注释（56-64）。残余风险同 T30②；另注意「操作」列 10% 里草稿态最多 4 个按钮（317-325），窄屏 1366 下已是临界值。

### [T32] apps/web/components/finance/voucher-workspace.tsx:408
- 渲染方式: 手写 table
- 表格标识: `className="voucher-sheet-table"`（记账凭证纸，打印/导出 PNG 用）
- 列数: 4
- 列清单: 摘要(无,无) 会计科目(无,无) 借方金额(无,无) 贷方金额(无,无)，加一行合计（colSpan=2）
- 列宽约束现状: CSS `.voucher-sheet-table { width:100%; border-collapse: collapse }`（globals.css:643-646），未设 table-layout
- 省略与悬停现状: 无；`.voucher-sheet-table .num { white-space: nowrap }`（globals.css:646）保证金额不被折断
- 判定: 不适用
- 风险与备注: 凭证纸版式：与导出的 PNG / 打印稿必须逐格一致（voucher-workspace.tsx:397-423），且它在 Portal 出去的打印弹窗里（384）。加省略号会把「摘要」裁掉，与纸质凭证不符——这里换行才是正确行为。

## 建议

**修法 A —— 补 `meta.width` + `meta.ellipsis`（对应 T30/T31 已用的成熟做法，适用于留在 `.finance-page` 里的所有 DataTable）**
- 一次性收益最大的一批：T1、T4、T5、T6、T7、T9、T14、T15、T16、T17、T18、T23、T24、T25、T26（页内表，15 张）。
- 每张表照着 voucher-workspace.tsx:64-65 那样先写一张宽度表，自有的业务列合计留出 16% 给 `auditColumns()` 的两列（fixed 布局会把余量均分给没宽度的列），至少给「操作」列一个死宽度；长文本列一律加 `ellipsis: true`。
- **前置修正（很重要）**：`ellipsisTitle` 只认字符串/数字（data-table.tsx:53-77），以下列现在返回 JSX，加了 `ellipsis` 只会截断、**不会有 hover 全文**，必须改成 `accessorFn` 或在单元格容器上自写 `title`：
  - bank-workspace.tsx:192/193（当前余额、余额构成）、bank-transfer-workspace.tsx:244（当前余额）、finance-slips-workspace.tsx:121（借方合计）、cash-flow-workspace.tsx:285（来源 badge）、payable-workspace.tsx:757/764（勾选框 + 锁定原因）、receivable-workspace.tsx:536/538（勾选框）。
- 只补宽度不补省略、或只补省略不补宽度，都会出现「看起来改了但还是要左右滑 / 悬停空白」的半生效状态——这正是 data-table.tsx:64-73 记录过的坑。

**修法 B —— 弹窗内的表：先让它拿到财务页那套规则，再套修法 A（T11、T12、T13、T19、T21、T22、T27、T28、T29，共 9 张）**
- 根因是 `DialogContent` 走 Radix Portal（ui/dialog.tsx:13），`.finance-page .ui-table-cell`（globals.css:212）够不到它，于是弹窗里的 DataTable 退回 `padding:12px + white-space:nowrap`，必然横向滚动。
- 两种落点，二选一（都要评估回归面，本次只读不实施）：
  1. 在 globals.css 里补一条与 `.finance-page` 等价的弹窗作用域规则，例如 `.ui-dialog-content .ui-table-cell { white-space: normal; overflow-wrap: anywhere; padding: 6px 8px }`（并同样给 `.ui-table-head` 与 `.data-table`）——一处生效、弹窗内所有表受益；
  2. 或者逐表套修法 A（`meta.width` + `meta.ellipsis`，这两条规则是全局的、Portal 内外都生效），代价是 9 张表逐个来、且缺少换行兜底的那一档仍在。
- 建议选 1 打底 + 对「原因 / 采购物料 / 规格型号 / 发放银行」这类长文本列再补 `ellipsis`（选 2 的宽度部分）。注意选 1 之后 `.cell-ellipsis`（(0,4,0)）仍然压得住新规则，不会互相抵消。

**修法 C —— 财务报表预览表是特例（T8）**
- 列完全由后端 `ReportTable.columns` 决定、前端只做 `map`（finance-report-workspace.tsx:155-162），所以不能靠「写列定义」解决；建议在前端按列下标/表头关键词映射一张宽度 + 省略表（后端 `ReportColumn.width` 是 Excel 列宽，只能用于导出，不能直接当页面宽度——销售对账明细 23 列的 width 之和是 300+，是字符数不是百分比）。
- 应优先覆盖长文本列：产品名称 / 规格型号 / 客户名称 / 供应商名称 / 对方名称 / 项目 / 银行账户 / 结算方式 / 备注。

**修法 D —— 保持现状，只做局部加固（T2、T3、T10、T20、T32，5 张）**
- T2/T3/T32（跨行转账单、签字栏、凭证纸）：单据/打印件，宽度必须与导出稿一致，不加省略。
- T20（PayrollSheet）：可编辑网格，列宽由编辑行为决定（金额格 `min-width:72px`）；若一定要改善长文本（部门、岗位名），应在列定义里给「部门/岗位」用固定 `width` 的 `colgroup` 方案而不是加省略号——因为省略会遮住只读格的 `readOnlyHint` 之外的显示内容。
- T10（合并付款弹窗的逐行金额表）：需要的是外层包一层 `.table-wrap`（现在没有，payable-merge-payment-dialog.tsx:277-291）+ 给「本次核销金额」列固定宽度，让输入框不被挤压；它不是省略号能解决的问题。

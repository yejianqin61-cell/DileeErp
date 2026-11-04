# C — 生产 / 质检模块表格清单

审计范围：`apps/web/app/production/**`、`apps/web/app/qc/**`、`apps/web/components/production/**`、`apps/web/components/qc/**`（只读审计，未改动任何源码）。

事实基线（全模块统一）：
- 本模块 **0 处** `meta: { width }`、**0 处** `meta: { ellipsis: true }`（grep `meta:` 在本范围内只命中接口返回值的 `{ data, meta: {} }`，与列元数据无关）。因此 **没有一张 DataTable 会拿到 `data-table-fixed`，也没有一格 `cell-ellipsis`**（触发逻辑见 `apps/web/components/data/data-table.tsx:86-87`）。
- 本模块页面**不带** `.finance-page` 类（该类只出现在 `components/finance/*` 与 `app/finance/*`）。所以 `.ui-table-cell` 的 `white-space: nowrap`（`apps/web/app/globals.css:89`）与 `.data-table th, .data-table td` 的 `white-space: nowrap`（`globals.css:187`）在本模块**全部生效**，没有任何「换行兜底」。
- 唯一例外是领料单编辑页：`globals.css:459-471` 的 `.material-slip-editor` 规则自己写了宽度上限 + `text-overflow: ellipsis`。

## 统计
- 表格总数: 23
- DataTable 调用点: 17
- 手写 <table>: 6
- 需要修（列宽不受限 / 无省略悬停）: 19
- 已达标: 0
- 不适用（可编辑网格等，需保持现状）: 4

## 明细

### [T1] apps/web/app/production/page.tsx:179
- 渲染方式: 手写 table
- 表格标识: `<div className="table-wrap">` 内 `<table className="data-table">`，用途「BOM表」列表；父面板 `data-testid="production-bom-panel"`
- 列数: 3
- 列清单: 订单号(宽度=无, 省略=无)、数量(宽度=无, 省略=无)、BOM表(宽度=无, 省略=无)
- 列宽约束现状: 无（只有 `.data-table th, .data-table td { white-space: nowrap }`，globals.css:187；globals.css:264 的 `.production-order-table .data-table td:last-child` 不适用于本表）
- 省略与悬停现状: 无（td 无 title、无 text-overflow）
- 判定: 需要修
- 风险与备注: 三格全是自动布局 + nowrap，订单号/数量列宽取决于内容最小宽度；第 3 列装按钮，窄屏时整表撑宽 `.table-wrap` 出现横向滚动。列少，风险等级低，但按判定口径（存在无界列宽且无省略悬停）仍需修。

### [T2] apps/web/app/production/page.tsx:181
- 渲染方式: DataTable
- 表格标识: `<div data-testid="production-order-table">` 包裹的「生产单查找」表（DataTable 自带 `data-testid="data-table"`）；列定义在同文件 139-149 行
- 列数: 10
- 列清单: 生产单号(宽度=无, 省略=无)、订单号(宽度=无, 省略=无)、执行方式(宽度=无, 省略=无)、地点(宽度=无, 省略=无)、计划数(宽度=无, 省略=无)、工序(宽度=无, 省略=无)、状态(宽度=无, 省略=无)、创建人(宽度=无, 省略=无)、最后修改人(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`，无自写 title）
- 判定: 需要修
- 风险与备注: 两点硬伤。①「工序」列是 `operations.map(item => item.operationNameSnapshot).join("、")`（145 行），工序一多就是长串，nowrap + 自动布局会把整表顶宽。②`globals.css:263-264` 写了 `.production-order-table .data-table td:last-child { white-space: normal; min-width: 150px }`，但页面只在 181 行写了 `data-testid="production-order-table"`，**没有任何元素带这个 class**，所以这条「给操作列留 150px」的规则是死代码，操作列的按钮组仍会被压在一格里。

### [T3] apps/web/app/production/material-issues/page.tsx:247
- 渲染方式: DataTable
- 表格标识: 「领料单 / 补料单」面板列表（页 `data-testid="page-production-material-issues"`）；列定义在同文件 187-198 行
- 列数: 11
- 列清单: 订单号(宽度=无, 省略=无)、生产单号(宽度=无, 省略=无)、类型(宽度=无, 省略=无)、单据号(宽度=无, 省略=无)、状态(宽度=无, 省略=无)、物料明细(宽度=无, 省略=无)、数量合计(宽度=无, 省略=无)、登记时间(宽度=无, 省略=无)、创建人(宽度=无, 省略=无)、最后修改人(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`）
- 判定: 需要修
- 风险与备注: 「物料明细」列把该单全部行拼成 `名称 × 数量单位`（193 行），行数一多必成长串，nowrap 下直接决定整表宽度；「操作」列最多 6 个按钮。11 列叠加后横向滚动几乎必然。

### [T4] apps/web/app/production/material-issues/page.tsx:256
- 渲染方式: DataTable
- 表格标识: 双击行弹出的 `RecordDetailDialog`（`testId="material-slip-detail"`）内「领用物料（N 项）」区块；列定义在同文件 201-208 行
- 列数: 6
- 列清单: 物料编码(宽度=无, 省略=无)、物料名称(宽度=无, 省略=无)、规格型号(宽度=无, 省略=无)、单位(宽度=无, 省略=无)、数量(宽度=无, 省略=无)、备注(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`；6 列全部是 `id` + 自定义 `cell`，即使以后加 `ellipsis` 也拿不到自动 title，见 data-table.tsx:70-77）
- 判定: 需要修
- 风险与备注: 物料名称/规格型号/备注都是自由文本，弹窗宽度有限；且这三个是 `id`+`cell` 列，没有 accessor 可回退，必须像 `auditActorCell` 那样在容器上自写 `title` 才有悬停全文。

### [T5] apps/web/components/production/material-issues-panel.tsx:239
- 渲染方式: 手写 table
- 表格标识: `<div className="table-wrap">` 内 `<table className="ui-table">`，用途「生产单卡片内的新领料单草稿编辑网格」（仅 `draft` 存在时渲染）；页内由 `production-order-detail-page.tsx:79` 的 `<MaterialIssuesPanel>` 渲染
- 列数: 8
- 列清单: 物料(宽度=无, 省略=无)、BOM 核定用量(宽度=无, 省略=无)、当前库存(宽度=无, 省略=无)、生产已领累计(宽度=无, 省略=无)、生产未领用(宽度=无, 省略=无)、本次领料数量(宽度=无, 省略=无)、风险(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无
- 省略与悬停现状: 无
- 判定: 不适用
- 风险与备注: 第 1 格是 `<Select>` 物料下拉、第 6 格是 `<Input type="number">`、第 8 格是按钮（241/246/248 行）。可编辑录入网格，压缩或省略会让下拉/输入框不可用，必须保持自己的自动布局。

### [T6] apps/web/components/production/material-issues-panel.tsx:257
- 渲染方式: DataTable
- 表格标识: 「生产领料单」面板列表（`<section className="panel">`，无独立 testid）；列定义在同文件 186-201 行
- 列数: 8
- 列清单: 单据号(宽度=无, 省略=无)、类型(宽度=无, 省略=无)、业务日期(宽度=无, 省略=无)、明细(宽度=无, 省略=无)、状态(宽度=无, 省略=无)、创建人(宽度=无, 省略=无)、最后修改人(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`）
- 判定: 需要修
- 风险与备注: 「操作」列按状态最多 3 个按钮 + 1 个状态文字（193-200 行）；「明细」是「N 项 / 合计 X」较短。列数不多但操作列会被压窄。

### [T7] apps/web/components/production/material-issues-panel.tsx:265
- 渲染方式: DataTable
- 表格标识: `RecordDetailDialog`（`testId="material-slip-detail"`）内「领用物料（N 项）」区块；列定义在同文件 204-211 行
- 列数: 6
- 列清单: 物料编码(宽度=无, 省略=无)、物料名称(宽度=无, 省略=无)、规格型号(宽度=无, 省略=无)、单位(宽度=无, 省略=无)、数量(宽度=无, 省略=无)、备注(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`；同样 6 列均为 `id`+`cell`，无 accessor 可回退）
- 判定: 需要修
- 风险与备注: 与 T4 是同一形状的两份实现（生产单详情页 vs 领料单页），建议同一种修法，避免两处漂移。

### [T8] apps/web/components/production/unit-pool-page.tsx:78
- 渲染方式: DataTable
- 表格标识: 「单位池」列表（页 `data-testid="page-production-units"`）；列定义在同文件 62-68 行
- 列数: 6
- 列清单: 单位名称(宽度=无, 省略=无)、备注(宽度=无, 省略=无)、状态(宽度=无, 省略=无)、创建人(宽度=无, 省略=无)、最后修改人(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`）
- 判定: 需要修
- 风险与备注: 「备注」列是自由文本（`row.original.remark || "-"`，64 行），nowrap 下一条长备注就能把 6 列表顶宽；「操作」列 3 个按钮。

### [T9] apps/web/components/production/master-data-pool-page.tsx:62
- 渲染方式: DataTable
- 表格标识: 工序池（`kind="operations"`）/ 加工地点池（`kind="locations"`）共用一个调用点，页面 testid 分别为 `page-production-operations`、`page-production-locations`；列定义在同文件 58 行
- 列数: 7（工序）/ 6（加工地点）
- 列清单: 工序名称(宽度=无, 省略=无)、编码(宽度=无, 省略=无)、默认单位(宽度=无, 省略=无)、状态(宽度=无, 省略=无)、创建人(宽度=无, 省略=无)、最后修改人(宽度=无, 省略=无)、操作(宽度=无, 省略=无) ／ 地点名称(宽度=无, 省略=无)、类型(宽度=无, 省略=无)、状态(宽度=无, 省略=无)、创建人(宽度=无, 省略=无)、最后修改人(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`）
- 判定: 需要修
- 风险与备注: 一个是同一 `DataTable` 元素按 `isOperations` 切两套列，修的时候两套都要给宽度，否则只修一半会静默不一致。工序名称是自由文本，是主要变宽来源。

### [T10] apps/web/components/production/outsource-logistics-panel.tsx:44
- 渲染方式: DataTable
- 表格标识: 「外加工交接」面板内第一张表「外加工批次」（`columns={batchColumns}`）；列定义在同文件 42 行
- 列数: 7
- 列清单: 批次(宽度=无, 省略=无)、订单号(宽度=无, 省略=无)、状态(宽度=无, 省略=无)、计划/直发(宽度=无, 省略=无)、创建人(宽度=无, 省略=无)、最后修改人(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`）
- 判定: 需要修
- 风险与备注: 「操作」列最多 3 个按钮（直发/签收/删除，42 行），且两张表上下叠在同一个 `.panel-body` 里，操作列宽度不一致时两表列会错位。

### [T11] apps/web/components/production/outsource-logistics-panel.tsx:44
- 渲染方式: DataTable
- 表格标识: 同一面板内第二张表「回厂与直装柜」（`columns={transferColumns}`，紧跟在 `<h3>回厂与直装柜</h3>` 后）；列定义在同文件 43 行
- 列数: 7
- 列清单: 编号(宽度=无, 省略=无)、订单号(宽度=无, 省略=无)、类型(宽度=无, 省略=无)、数量(宽度=无, 省略=无)、状态(宽度=无, 省略=无)、创建人(宽度=无, 省略=无)、最后修改人(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`）
- 判定: 需要修
- 风险与备注: 「编号」列是 `transferNo ?? shipmentNo ?? "-"` 的回退取值（43 行），无省略时在窄容器里会直接顶宽整表。

### [T12] apps/web/components/production/finished-goods-panel.tsx:170
- 渲染方式: DataTable
- 表格标识: 「成品存量与入库通知 → 入库通知（分批）」列表（`<section className="panel">`，生产单详情页 `data-testid="order-overview"` 之下的 `<FinishedGoodsPanel>`）；列定义在同文件 116-132 行
- 列数: 13
- 列清单: 通知单(宽度=无, 省略=无)、批次(宽度=无, 省略=无)、通知日期(宽度=无, 省略=无)、通知数量(宽度=无, 省略=无)、已送检(宽度=无, 省略=无)、待送检(宽度=无, 省略=无)、QC 合格(宽度=无, 省略=无)、在途入库(宽度=无, 省略=无)、已入库(宽度=无, 省略=无)、状态(宽度=无, 省略=无)、创建人(宽度=无, 省略=无)、最后修改人(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`）
- 判定: 需要修
- 风险与备注: 本模块列数最多的表（13 列，含审计两列）。「通知数量」是 `数量 + 单位` 拼接（120 行），「操作」列按状态给按钮。列数多 + 全部 nowrap，横向滚动是当前必然表现；这也是最该上 `table-layout: fixed` 的一张表。

### [T13] apps/web/components/production/production-order-detail-page.tsx:79
- 渲染方式: DataTable
- 表格标识: 生产单详情「工序与进度」面板（`data-testid="order-operations-panel"`，仅在 `operationsPanel.open` 为真时渲染）；列定义在同文件 75 行
- 列数: 6
- 列清单: 顺序(宽度=无, 省略=无)、工序(宽度=无, 省略=无)、目标数量(宽度=无, 省略=无)、单位(宽度=无, 省略=无)、状态(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`）
- 判定: 需要修
- 风险与备注: 注意这张表**没有接 `auditColumns()`**（75 行的数组里只有 6 列，与列表页 T2 的 10 列口径不同），所以它的列数就是 6。「工序」列是 `operationNameSnapshot` 自由文本，是唯一变宽来源。

### [T14] apps/web/components/production/production-order-detail-page.tsx:79
- 渲染方式: 手写 table
- 表格标识: 同一面板内「进度测量」表：`<div className="table-wrap"><table className="ui-table">`（`progress.measurements` 非空才渲染，行/格显式用 `ui-table-row` / `ui-table-cell`）
- 列数: 5
- 列清单: 工序/来源(宽度=无, 省略=无)、计划(宽度=无, 省略=无)、实际(宽度=无, 省略=无)、差额(宽度=无, 省略=无)、完成率(宽度=无, 省略=无)
- 列宽约束现状: 无（`.ui-table { width:100% }` 自动布局；`.ui-table-head` / `.ui-table-cell` 均 nowrap，globals.css:88-89）
- 省略与悬停现状: 无（无 title、无 text-overflow）
- 判定: 需要修
- 风险与备注: 第 1 格是 `row.operation_name ?? row.source_type ?? "-"`，工序名或来源类型都是长文本；其余 4 列是数字/百分比。手写的 `<table className="ui-table">` 上加不了 `meta`，需要走 CSS（或改成 DataTable）才能拿到省略 + 悬停。

### [T15] apps/web/components/production/daily-reports-panel.tsx:299
- 渲染方式: 手写 table（经 `components/ui/table.tsx` 的 `<Table>` → `<div className="ui-table-wrap"><table className="ui-table">`）
- 表格标识: `data-testid="operation-report-draft-table"`，用途「工序员工日报 → 未保存草稿录入表」（弹窗 `data-testid="operation-report-form"` 内）
- 列数: 8
- 列清单: 员工(宽度=无, 省略=无)、日期(宽度=无, 省略=无)、计薪方式(宽度=无, 省略=无)、件数(宽度=无, 省略=无)、时长（小时）(宽度=无, 省略=无)、单价(宽度=无, 省略=无)、备注(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无
- 省略与悬停现状: 无
- 判定: 不适用
- 风险与备注: 「计薪方式」是 `<Select>`，「件数/时长/单价/备注」是 4 个 `<Input>`，「操作」是删除按钮（299 行）。可编辑录入网格，压窄或省略会让控件不可用。

### [T16] apps/web/components/production/daily-reports-panel.tsx:303
- 渲染方式: 手写 table（同上，`<Table>` → `ui-table`）
- 表格标识: `data-testid="employee-report-table"`，用途「已有员工日报的在线更正表」（同一弹窗内，接在草稿表与汇总条之后）
- 列数: 10
- 列清单: 员工(宽度=无, 省略=无)、日期(宽度=无, 省略=无)、计薪方式(宽度=无, 省略=无)、件数(宽度=无, 省略=无)、时长（小时）(宽度=无, 省略=无)、单价(宽度=无, 省略=无)、备注(宽度=无, 省略=无)、本行薪资(宽度=无, 省略=无)、当日该员工总薪资(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无
- 省略与悬停现状: 无（仅「单价」Input 自带 `title={unitPriceLabel(...)}`，是单价口径说明，不是列内容省略提示）
- 判定: 不适用
- 风险与备注: 与 T15 同属可编辑录入网格（4 个 Input + 保存按钮），且 10 列里 6 列是控件。保持现状。

### [T17] apps/web/components/production/material-slip-editor.tsx:242
- 渲染方式: 手写 table（`<Table className="data-table">` → `<table className="ui-table data-table">`，位于 `<section className="panel material-slip-editor" data-testid="material-slip-lines">`）
- 表格标识: `data-testid="material-slip-lines"` 面板内的「物料明细」表（`<div className="table-wrap">`）
- 列数: 13（领料单）/ 9（补料单，`!isReplenishment` 时才渲染「采购入库数量 / 采购未入库数量 / 生产领用数量 / 生产未领用数量」4 列；空态行 colSpan 写死 `isReplenishment ? 9 : 13`，282 行可交叉验证）
- 列清单: 物料(宽度=无, 省略=无)、物料代码(宽度=无, 省略=无)、型号(宽度=无, 省略=无)、颜色(宽度=无, 省略=无)、核定用量(宽度=无, 省略=无)、当前库存量(宽度=无, 省略=无)、采购入库数量(宽度=无, 省略=无)、采购未入库数量(宽度=无, 省略=无)、生产领用数量(宽度=无, 省略=无)、生产未领用数量(宽度=无, 省略=无)、领料数量（补料单为「补领数量」）(宽度=无, 省略=无)、备注(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: CSS 选择器 —— `.material-slip-editor .data-table { min-width: 1180px; table-layout: auto }`、`.material-slip-editor .data-table th, .material-slip-editor .data-table td { max-width: 240px; overflow: hidden; text-overflow: ellipsis }`、`.material-slip-editor .slip-col-material { min-width: 260px; max-width: 300px }`、`.slip-col-qty { width: 120px }`、`.slip-col-remark { width: 200px }`、`.slip-col-action { width: 80px }`（globals.css:459-471）
- 省略与悬停现状: CSS text-overflow —— `.material-slip-editor .data-table th, td` 的 `overflow:hidden + text-overflow:ellipsis`；另外部分格自写 `title`（266 行物料、272-274 行物料代码/型号/颜色、276 行当前库存量）
- 判定: 不适用
- 风险与备注: 典型可编辑单据网格：「物料」是 `<Select>`，「领料数量」「备注」是 `<Input>`，「操作」是删除按钮（267-280 行）。它自己那套 `max-width + ellipsis + 局部 title` 已经能兜住长文本，**不要**改成 `meta.width` 走 `table-layout: fixed`，否则 13 列的 select/input 会被压坏。

### [T18] apps/web/components/qc/qc-inbound-panel.tsx:126
- 渲染方式: DataTable
- 表格标识: 「质检合格待入库 / 次品登记」面板内第一张表「质检合格待入库」（页 `data-testid="page-qc-inbound"`）；列定义在同文件 85-95 行
- 列数: 10
- 列清单: 质检单(宽度=无, 省略=无)、订单号(宽度=无, 省略=无)、合格/条件合格(宽度=无, 省略=无)、不合格(宽度=无, 省略=无)、单位(宽度=无, 省略=无)、可入库（净值）(宽度=无, 省略=无)、可登记次品(宽度=无, 省略=无)、创建人(宽度=无, 省略=无)、最后修改人(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`）
- 判定: 需要修
- 风险与备注: 表头文字长（「合格/条件合格」「可入库（净值）」「可登记次品」）+ 审计两列 + 操作列最多 2 按钮（94 行），10 列全 nowrap，容器窄时必然横向滚动。

### [T19] apps/web/components/qc/qc-inbound-panel.tsx:128
- 渲染方式: DataTable
- 表格标识: 同一面板内第二张表「次品记录」；列定义在同文件 96-104 行
- 列数: 8
- 列清单: 次品单(宽度=无, 省略=无)、订单号(宽度=无, 省略=无)、成品(宽度=无, 省略=无)、数量(宽度=无, 省略=无)、状态(宽度=无, 省略=无)、创建人(宽度=无, 省略=无)、最后修改人(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`）
- 判定: 需要修
- 风险与备注: 「成品」列是 `productNameSnapshot ?? "-"`（99 行），产品名可能很长且无省略提示；它和 T18 上下相邻，宽度策略应一致。

### [T20] apps/web/components/qc/incoming-inspections-panel.tsx:326
- 渲染方式: DataTable
- 表格标识: 「来料质检」主列表（页 `data-testid="page-qc-incoming"`）；列定义在同文件 272-304 行
- 列数: 16
- 列清单: 订单号(宽度=无, 省略=无)、采购单号(宽度=无, 省略=无)、物料(宽度=无, 省略=无)、质检批次(宽度=无, 省略=无)、本批总数量(宽度=无, 省略=无)、最终结果(宽度=无, 省略=无)、状态(宽度=无, 省略=无)、送检(宽度=无, 省略=无)、合格(宽度=无, 省略=无)、条件接收(宽度=无, 省略=无)、不合格(宽度=无, 省略=无)、入库情况(宽度=无, 省略=无)、入库通知(宽度=无, 省略=无)、创建人(宽度=无, 省略=无)、最后修改人(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`）
- 判定: 需要修
- 风险与备注: 全模块列数最多的表（16 列）。两格是长拼接文本：「入库情况」输出 `已建单 X · 剩余可入 Y`（可能再加「有草稿待过账」「待仓库接收通知」两段，285 行），「入库通知」输出 `通知单号（状态）`（286 行）；「操作」列最多 5 个按钮（288-303 行）。这两格都是 `id`+自定义 `cell`、无 accessor，`ellipsis` 开了也拿不到自动 title，必须自写 title。

### [T21] apps/web/components/qc/finished-goods-qc-panel.tsx:195
- 渲染方式: DataTable
- 表格标识: 成品质检「订单详情：{订单号}」区块内第一张表「成品来源」（页 `data-testid="page-qc-finished-goods"`；同一行 195 还有两张表）；列定义在同文件 185 行
- 列数: 10
- 列清单: 生产单(宽度=无, 省略=无)、来源(宽度=无, 省略=无)、入库通知/批次(宽度=无, 省略=无)、包装工序(宽度=无, 省略=无)、可送检数量(宽度=无, 省略=无)、单位(宽度=无, 省略=无)、状态(宽度=无, 省略=无)、创建人(宽度=无, 省略=无)、最后修改人(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`）
- 判定: 需要修
- 风险与备注: 「入库通知/批次」是 `notice_no / batch_no` 拼接（185 行），是最容易变宽的一格；「包装工序」是工序名。三张表上下堆在同一 `.panel-body` 里，若只给其中一张加宽度，三张表列边界会互相错位。

### [T22] apps/web/components/qc/finished-goods-qc-panel.tsx:195
- 渲染方式: DataTable
- 表格标识: 同一「订单详情」区块内第二张表「送检记录」；列定义在同文件 186 行
- 列数: 8
- 列清单: 送检单(宽度=无, 省略=无)、来源(宽度=无, 省略=无)、成品(宽度=无, 省略=无)、送检数量(宽度=无, 省略=无)、状态(宽度=无, 省略=无)、创建人(宽度=无, 省略=无)、最后修改人(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`）
- 判定: 需要修
- 风险与备注: 「来源」列是 `来源类型 / sourceId`（拼接 UUID，186 行），「成品」是 `产品名 / 规格型号`（两个快照字段拼接）。这两格内容长度完全不可控，且都是 `id`+`cell`，需要宽度上限 + 自写 title。

### [T23] apps/web/components/qc/finished-goods-qc-panel.tsx:195
- 渲染方式: DataTable
- 表格标识: 同一「订单详情」区块内第三张表「质检记录」；列定义在同文件 187 行
- 列数: 13
- 列清单: 质检单(宽度=无, 省略=无)、订单号(宽度=无, 省略=无)、送检记录(宽度=无, 省略=无)、来源类型(宽度=无, 省略=无)、检验日期(宽度=无, 省略=无)、合格数量(宽度=无, 省略=无)、条件接收(宽度=无, 省略=无)、不合格(宽度=无, 省略=无)、可入库数量（净值）(宽度=无, 省略=无)、单位(宽度=无, 省略=无)、创建人(宽度=无, 省略=无)、最后修改人(宽度=无, 省略=无)、操作(宽度=无, 省略=无)
- 列宽约束现状: 无（无 `meta.width`）
- 省略与悬停现状: 无（无 `meta.ellipsis`）
- 判定: 需要修
- 风险与备注: 13 列。「送检记录」直接渲染 `submission_id`（外键 id，187 行）—— 不设宽度上限时这一格就是 36 字符 UUID 的 nowrap 宽度，是这张表最硬的变宽来源；「操作」列在不可更正时渲染一句中文说明（`已有入库/次品事实，不可更正`），也必须给足宽度。

## 建议

1. **17 个 DataTable 走同一套修法（T2、T3、T4、T6、T7、T8、T9、T10、T11、T12、T13、T18、T19、T20、T21、T22、T23）**：给每个表的文本型长列加 `meta: { ellipsis: true }`，并给**至少一列**（该表最长的文本列，或「操作」列）加 `meta: { width }`。只加 `ellipsis` 不加任何 `width` 是无效的 —— `DataTable` 只在「有列给了 width」时才给 `<table>` 加 `data-table-fixed`（data-table.tsx:86-87），而 `.cell-ellipsis` 的省略规则只写在 `.ui-table.data-table-fixed .ui-table-cell.cell-ellipsis` 下（globals.css:237-238）。按表建议给宽度的列：
   - T2 `生产单号`（或 `工序`）、T3 `物料明细`、T4 `物料名称`+`规格型号`+`备注`、T6 `操作`、T7 同 T4、T8 `备注`、T9 两套列各自的 `工序名称` / `地点名称`、T10 `操作`、T11 `编号`、T12 `通知单`+`操作`、T13 `工序`、T18 `可入库（净值）`+`操作`、T19 `成品`、T20 `入库情况`+`入库通知`、T21 `入库通知/批次`、T22 `来源`+`成品`、T23 `送检记录`+`操作`。
   - **凡是 `id` + 自定义 `cell` 且没有 `accessorKey`/`accessorFn` 的列（本模块全部审计两列、T4/T7 的 6 列、T20 的「入库情况/入库通知」、T21-T23 的拼接连、T2/T13 的「操作」）拿不到 `ellipsis` 自动 title**（data-table.tsx:75-77）。这类格必须照 `audit-columns.tsx:47-56` 的 `auditActorCell` 做法，在容器上自写 `title`（审计两列已经自带了，不用改）。
2. **T1（`app/production/page.tsx:179` 的 BOM 表）**：手写 `<table className="data-table">` 加不了 `meta`。要么改成 `<DataTable columns={...}>`（3 列，改动最小、顺带拿到分页与省略机制），要么在 `globals.css` 补一条 `.production-bom-panel .data-table th:nth-child(1) { width: 40% }` 之类的固定列宽 + `title`。
3. **T14（生产单详情「进度测量」表）**：同样加不了 `meta`。建议同样收敛成 `<DataTable>`；若要保持手写，需要照 `globals.css:542` 给采购计划表写的 `.plan-cell-ellipsis` 那样，为「工序/来源」列补一条 `white-space: nowrap; overflow: hidden; text-overflow: ellipsis` 的 CSS 并配 title。
4. **T5、T15、T16、T17 保持现状（不适用）**：四张都是单元格里装 `<Select>`/`<Input>`/按钮的可编辑网格，其中 T17 已有自己的 `max-width + text-overflow: ellipsis`（globals.css:459-471）。**不要**给 T17 加 `meta.width`，否则 `table-layout: fixed` 会把 13 列的 select/input 压坏。
5. **顺带修一条死 CSS**：`globals.css:263-264` 的 `.production-order-table .data-table td:last-child { white-space: normal; min-width: 150px }` 在本仓库**没有任何元素带 `production-order-table` 这个 class**（`app/production/page.tsx:181` 用的是 `data-testid="production-order-table"`，只有测试文件读它）。修 T2 时把 class 补上或删掉这条规则，别让「操作列已留 150px」的假象留在代码里。
6. **范围边界说明**：`app/production/page.tsx:161` 与 `app/production/orders/[id]/page.tsx` 会渲染 `apps/web/components/bom/bom-workbench.tsx`（含手写 `<table className="data-table bom-table">`，第 258 行，自带 `bom-col-*` 宽度类），该文件在 `components/bom/`，**不在本次 C 范围**，已由其他范围的审计覆盖。另经核查，`components/production/payroll-export-panel.tsx` 与 `components/production/progress-column-order-editor.tsx` **不含任何表格**（导出弹窗只有下拉/日期控件，工序列排序用的是 `<ol>` 列表），故未列入明细。

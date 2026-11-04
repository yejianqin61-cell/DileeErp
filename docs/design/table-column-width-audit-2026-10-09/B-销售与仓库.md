# B — 销售 / 仓库模块表格清单

审计范围：`apps/web/app/sales/**/*`、`apps/web/app/warehouse/**/*`、`apps/web/components/sales/**/*`（只读审计，未改动任何源文件）。

判定依据（口径来自 `apps/web/components/data/data-table.tsx` + `apps/web/app/globals.css`）：
- `meta.width` 只要有一列给了值，`DataTable` 就给 `<table>` 加 `data-table-fixed`（data-table.tsx:86-87），固定布局下内容再也撑不宽列；
- `meta.ellipsis` 只加 `cell-ellipsis` 类，而 `.cell-ellipsis` 的 `text-overflow: ellipsis` 生效前提是同时有 `data-table-fixed`（globals.css:232-238）——**只加 ellipsis 不加 width 等于什么都没加**；
- 悬停 title 由 `meta.ellipsis` 驱动，且只认字符串/数字（data-table.tsx:53-77）；按钮/缩略图那种 ReactNode 格给不出 title，`auditColumns()` 的两列是自己在容器上写 title（audit-columns.tsx:51）。

## 统计
- 表格总数: 19
- DataTable 调用点: 16
- 手写 <table>: 3
- 需要修（列宽不受限 / 无省略悬停）: 18
- 已达标: 0
- 不适用（可编辑网格等，需保持现状）: 1

## 明细

### [T1] apps/web/components/sales/sales-orders-list.tsx:211
- 渲染方式: DataTable
- 表格标识: 销售单列表（页 `data-testid="page-sales-orders"` → 面板「销售单」）
- 列数: 9
- 列清单: 订单号(宽度=无, 省略=无) 货号(宽度=无, 省略=无) 客户(宽度=无, 省略=无) 产品(宽度=无, 省略=无) 数量(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无（列定义 172-188 行，`meta.width` 覆盖 0/9 列，表格未加 `data-table-fixed`）
- 省略与悬停现状: 无（`meta.ellipsis` 覆盖 0 列，无自写 title，无相关 CSS）
- 判定: 需要修
- 风险与备注: 「订单号」是 `<Button variant="link">`、「操作」列最多同时挂 4 个按钮（编辑 / 工艺单 / 确认 / 删除），两列都是 nowrap 的 ReactNode，列宽由内容 min-content 决定而完全不受限；客户名与产品名是长文本且无省略无 title。整表只能靠 `.table-wrap` 横向滚动兜底（globals.css:172）。

### [T2] apps/web/components/sales/customer-pool.tsx:139
- 渲染方式: DataTable
- 表格标识: 客户池（页 `data-testid="page-sales-customers"` → 面板「客户池」）
- 列数: 8
- 列清单: 编码(宽度=无, 省略=无) 客户(宽度=无, 省略=无) 国家/地区(宽度=无, 省略=无) 联系人(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无（列定义 116-124 行，`meta.width` 覆盖 0/8 列）
- 省略与悬停现状: 无（`meta.ellipsis` 覆盖 0 列）
- 判定: 需要修
- 风险与备注: 「国家/地区」写英文全称（如 United States of America）时是最宽的一列，「操作」列 4 个按钮同样 nowrap；地址/备注这些真正的长字段不在列里（在详情 Sheet 的 `detail-list`），所以风险主要来自按钮列与国家名。

### [T3] apps/web/components/sales/finished-goods-overview.tsx:62
- 渲染方式: DataTable
- 表格标识: 成品出库总览（`data-testid="finished-goods-overview"`）
- 列数: 6
- 列清单: 产品(宽度=无, 省略=无) 单位(宽度=无, 省略=无) 全部成品数(宽度=无, 省略=无) 已出库数(宽度=无, 省略=无) 未出库数(宽度=无, 省略=无) 生产单数(宽度=无, 省略=无)
- 列宽约束现状: 无（列定义 44-51 行，`meta.width` 覆盖 0/6 列）
- 省略与悬停现状: 无（`meta.ellipsis` 覆盖 0 列）
- 判定: 需要修
- 风险与备注: 五列是短数字，实际溢出概率是本模块最低的一张；唯一无界的是「产品」列（成品名 + 规格快照可较长），且它既无省略也无 hover title。补列宽的主要收益是消除横向滚动而不是救长文本。

### [T4] apps/web/components/sales/sales-order-editor.tsx:792
- 渲染方式: 手写 table
- 表格标识: 细分明细（类名 `ui-table`，行 `data-testid="sales-detail-row-N"`，表头 `sales-detail-head-*`；列名可被用户自定义，默认见 lib/sales-order-spec.ts:260-267）
- 列数: 7
- 列清单: 分组名(宽度=无, 省略=无) 品番/品名(宽度=无, 省略=无) 颜色/配色(宽度=无, 省略=无) 条码(宽度=无, 省略=无) 数量(宽度=无, 省略=无) 单位(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无（表格无宽度声明，也没有针对本表的 CSS 选择器）
- 省略与悬停现状: 无（单元格里是 `<Input>`，省略没有意义）
- 判定: 不适用
- 风险与备注: 每一格都是受控 `<Input>`（sales-order-editor.tsx:797-801），是可编辑网格：压窄列会把输入框挤坏，省略/悬停标题对输入框也不成立。列名上限 20 字符（SPEC_DETAIL_LABEL_MAX_LENGTH）已经限制了表头最长宽度。**保持现状**，不要按只读表的规则改。

### [T5] apps/web/components/sales/production-sheet-export-dialog.tsx:98
- 渲染方式: 手写 table
- 表格标识: 工艺单带图导出的勾选弹窗（`data-testid="production-sheet-image-dialog"` 内的表格，行 `production-sheet-image-row-*`）
- 列数: 3
- 列清单: 导出图片(宽度=无, 省略=无) 材料栏位 / 物料(宽度=无, 省略=无) 预览(宽度=无, 省略=无)
- 列宽约束现状: 无（手写 `<table className="ui-table">`，无 `table-layout`，无列宽）
- 省略与悬停现状: 无（无 CSS text-overflow，无 title）
- 判定: 需要修
- 风险与备注: 第 2 列是 `candidateLabel(candidate)` 文本（可见地指向 `lib/production-sheet-image.ts`），物料名 + 规格拼起来很长且 nowrap；第 1 列是可勾选的 checkbox、第 3 列是 56px 缩略图，这两列天然不需要省略，但需要固定宽度才不会跟着文本列一起被撑开。弹窗宽度有限，这张表最容易溢出的就是这个文本列。

### [T6] apps/web/app/warehouse/page.tsx:184
- 渲染方式: DataTable
- 表格标识: 仓库首页「待入库通知」（`data-testid="page-warehouse"`）
- 列数: 10
- 列清单: 通知单号(宽度=无, 省略=无) 通知时间(宽度=无, 省略=无) 采购/到货(宽度=无, 省略=无) 订单号(宽度=无, 省略=无) 物料(宽度=无, 省略=无) 通知数量(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无（`noticeColumns` 定义 120-130 行，`meta.width` 覆盖 0/10 列）
- 省略与悬停现状: 无（`meta.ellipsis` 覆盖 0 列）
- 判定: 需要修
- 风险与备注: 「采购/到货」与「物料」都是两段拼串（`采购单号 / 到货单号`、`物料编码 / 物料名`），是这张表最宽的两列，无省略无 title；「操作」列是一个按钮。10 列 nowrap 的 min-content 之和很容易超过面板宽度。

### [T7] apps/web/app/warehouse/page.tsx:197
- 渲染方式: DataTable
- 表格标识: 仓库首页「待出库通知」
- 列数: 11
- 列清单: 单据号(宽度=无, 省略=无) 类型(宽度=无, 省略=无) 生产单号(宽度=无, 省略=无) 订单号(宽度=无, 省略=无) 业务日期(宽度=无, 省略=无) 物料明细(宽度=无, 省略=无) 明细数(宽度=无, 省略=无) 提交时间(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无（`pendingOutboundColumns` 定义 132-144 行，`meta.width` 覆盖 0/11 列）
- 省略与悬停现状: 无（`meta.ellipsis` 覆盖 0 列）
- 判定: 需要修
- 风险与备注: 风险最高的一张：第 139 行把整单物料明细摊成一格（`物料 × 数量单位`，多条用「、」连接，注释自称「仓库最关心」），这串文本无上界；11 列 nowrap 相加，横向滚动条几乎必然出现。

### [T8] apps/web/app/warehouse/page.tsx:226
- 渲染方式: DataTable
- 表格标识: 仓库首页「已接收但缺入库草稿」（`stuckNotices.length > 0` 时才渲染）
- 列数: 8
- 列清单: 通知单号(宽度=无, 省略=无) 采购/到货(宽度=无, 省略=无) 物料(宽度=无, 省略=无) 通知数量(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无（`stuckColumns` 定义 110-118 行，`meta.width` 覆盖 0/8 列）
- 省略与悬停现状: 无（`meta.ellipsis` 覆盖 0 列）
- 判定: 需要修
- 风险与备注: 与 T6 同源（`采购/到货`、`物料` 两列都是拼串），列数少一列但仍无任何宽度约束。这是低频的条件渲染区，优先级低于 T6/T7。

### [T9] apps/web/app/warehouse/finished-goods-storage/page.tsx:256
- 渲染方式: 手写 table
- 表格标识: 成品仓储情况 → 「成品（按订单号收束，点击条目展开明细）」，类名 `ui-table`，单元格 `ui-table-cell`
- 列数: 5
- 列清单: 订单号(宽度=无, 省略=无) 成品现存数量(宽度=无, 省略=无) 已入库数量(宽度=无, 省略=无) 已出库数量(宽度=无, 省略=无) 明细(宽度=无, 省略=无)
- 列宽约束现状: 无（手写 `<table className="ui-table">` 放在 `.table-wrap` 里，无列宽、无专属 CSS 选择器）
- 省略与悬停现状: 无（无 text-overflow，无 title）
- 判定: 需要修
- 风险与备注: 展开行第 268 行把「生产单 / 成品名 / 规格」拼成一格且 `.ui-table-cell` 是 nowrap（globals.css:89），这是最长的一格；第 261 与 265 行的单元格里还有按钮（`variant="link"` / 「展开·收起」）。首列是订单号按钮。它是分组展开表（用 `<Fragment>` 插二级行），改成 DataTable 会丢掉展开能力，所以应按手写表补列宽 + 自写省略类。

### [T10] apps/web/app/warehouse/finished-goods-storage/page.tsx:278
- 渲染方式: DataTable
- 表格标识: 成品仓储情况 → 「次品」存量
- 列数: 5
- 列清单: 订单号(宽度=无, 省略=无) 成品(宽度=无, 省略=无) 规格(宽度=无, 省略=无) 类别(宽度=无, 省略=无) 存量(宽度=无, 省略=无)
- 列宽约束现状: 无（`balanceColumns` 定义 143-149 行，`meta.width` 覆盖 0/5 列）
- 省略与悬停现状: 无（`meta.ellipsis` 覆盖 0 列）
- 判定: 需要修
- 风险与备注: 与 T3 同形（短数值 + 一个较长的「成品 / 规格」文本列），溢出风险低但同样缺省略与悬停。注意这是无类型标注的列数组（`const balanceColumns = [...]`，元素没有 `ColumnDef<Balance>[]` 标注），补 `meta` 时 TS 推断能接受字面量，但建议顺手补上类型标注。

### [T11] apps/web/app/warehouse/finished-goods-storage/page.tsx:283
- 渲染方式: DataTable
- 表格标识: 成品仓储情况 → 「待入库通知」
- 列数: 13
- 列清单: 入库通知(宽度=无, 省略=无) 订单号(宽度=无, 省略=无) 批次(宽度=无, 省略=无) 包装工序(宽度=无, 省略=无) 通知日期(宽度=无, 省略=无) 通知数量(宽度=无, 省略=无) 已送检(宽度=无, 省略=无) 待送检(宽度=无, 省略=无) QC 合格(宽度=无, 省略=无) 已入库(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无)
- 列宽约束现状: 无（`noticeColumns` 定义 150-163 行，`meta.width` 覆盖 0/13 列）
- 省略与悬停现状: 无（`meta.ellipsis` 覆盖 0 列）
- 判定: 需要修
- 风险与备注: 本模块最宽的一张（13 列，无操作列）。`operationNameSnapshot`（包装工序名）与 `inboundNo` 无界；10 个短列的最小宽度之和就已经很可观，必须靠横向滚动。这张表最需要「固定布局 + 数值列各给窄宽 + 名称列给 ellipsis」。

### [T12] apps/web/app/warehouse/finished-goods-storage/page.tsx:291
- 渲染方式: DataTable
- 表格标识: 成品仓储情况 → 「成品入库单」
- 列数: 8
- 列清单: 入库单(宽度=无, 省略=无) 订单号(宽度=无, 省略=无) 成品(宽度=无, 省略=无) 数量(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无（`inboundColumns` 定义 164-172 行，`meta.width` 覆盖 0/8 列）
- 省略与悬停现状: 无（`meta.ellipsis` 覆盖 0 列）
- 判定: 需要修
- 风险与备注: 「成品」列取 `productNameSnapshot`（成品名 + 规格快照），无省略无 title；操作列按状态最多 2 个按钮。整体风险中等。

### [T13] apps/web/app/warehouse/finished-goods-storage/page.tsx:295
- 渲染方式: DataTable
- 表格标识: 成品仓储情况 → 「成品出库通知（销售发起）」
- 列数: 11
- 列清单: 出库通知(宽度=无, 省略=无) 订单号(宽度=无, 省略=无) 客户(宽度=无, 省略=无) 成品(宽度=无, 省略=无) 通知数量(宽度=无, 省略=无) 已出库 / 剩余(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 出库单(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无（`outboundNoticeColumns` 定义 186-197 行，`meta.width` 覆盖 0/11 列）
- 省略与悬停现状: 无（`meta.ellipsis` 覆盖 0 列）
- 判定: 需要修
- 风险与备注: 两个高风险列：「成品」把 `productNameSnapshot / productSpecificationSnapshot` 拼成一格（第 190 行），「出库单」取 `outbound_summary`（一张通知可能对应多张出库单号的拼接串，第 194 行）。两列都无界且无省略。

### [T14] apps/web/app/warehouse/finished-goods-storage/page.tsx:299
- 渲染方式: DataTable
- 表格标识: 成品仓储情况 → 「成品出库单」
- 列数: 12
- 列清单: 出库单(宽度=无, 省略=无) 订单号(宽度=无, 省略=无) 客户(宽度=无, 省略=无) 成品(宽度=无, 省略=无) 数量(宽度=无, 省略=无) 应收金额(宽度=无, 省略=无) 发货(宽度=无, 省略=无) 来源通知(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无（`outboundColumns` 定义 173-185 行，`meta.width` 覆盖 0/12 列）
- 省略与悬停现状: 无（`meta.ellipsis` 覆盖 0 列）
- 判定: 需要修
- 风险与备注: 「发货」列把 `发货日期 / 承运商 / 运单号` 三段拼成一格（第 180 行），是最长的一列；「操作」列按状态最多同时出现 5 个按钮（过账出库 / 取消出库单 / 维护发货 / 登记签收 / 冲销，第 184 行）——这一列的 min-content 很可能比任何文本列都宽，是 12 列里最该固定宽度的一列。

### [T15] apps/web/app/warehouse/raw-material-storage/page.tsx:229
- 渲染方式: DataTable
- 表格标识: 原料仓储情况 → 「库存汇总」
- 列数: 6
- 列清单: 物料(宽度=无, 省略=无) 规格型号(宽度=无, 省略=无) 单位(宽度=无, 省略=无) 待入库（未过账）(宽度=无, 省略=无) 已过账库存(宽度=无, 省略=无) 合计(宽度=无, 省略=无)
- 列宽约束现状: 无（`balanceColumns` 定义 133-143 行，`meta.width` 覆盖 0/6 列）
- 省略与悬停现状: 无（`meta.ellipsis` 覆盖 0 列）
- 判定: 需要修
- 风险与备注: 「物料」列是 `物料编码 / 物料名` 的拼串（第 134 行），「规格型号」是长文本且注释说它是原料的关键区分项（第 135-136 行）——这两列都必须看全，所以省略的 hover title 在这里不是可选项而是刚需。另有一列用 `status-warning` 包了「待入库」数字。

### [T16] apps/web/app/warehouse/raw-material-storage/page.tsx:235
- 渲染方式: DataTable
- 表格标识: 原料仓储情况 → 「原料入库单」
- 列数: 12
- 列清单: 入库单号(宽度=无, 省略=无) 订单号(宽度=无, 省略=无) 采购单号(宽度=无, 省略=无) 到货批次(宽度=无, 省略=无) 到货记录(宽度=无, 省略=无) 数量(宽度=无, 省略=无) 质检状态(宽度=无, 省略=无) 入库状态(宽度=无, 省略=无) 备注(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无（`inboundColumns` 定义 145-168 行，`meta.width` 覆盖 0/12 列）
- 省略与悬停现状: 无（`meta.ellipsis` 覆盖 0 列）
- 判定: 需要修
- 风险与备注: 「备注」是自由文本（无长度上界），12 列 nowrap 时它是把表格顶宽的头号原因；「操作」列按状态最多 3 个按钮（编辑 / 过账 / 删除）。`inspection_status`、`receipt_no`、`purchase_order_no` 三个 accessorKey 列回落后端原值，可能偏长。

### [T17] apps/web/app/warehouse/stocktakes/page.tsx:418
- 渲染方式: DataTable
- 表格标识: 库存盘点 → 导入结果里的「错误行」表（内联列数组，仅 `importResult.errors.length > 0` 时渲染）
- 列数: 3
- 列清单: 行号(宽度=无, 省略=无) 字段(宽度=无, 省略=无) 原因(宽度=无, 省略=无)
- 列宽约束现状: 无（内联数组，`meta.width` 覆盖 0/3 列）
- 省略与悬停现状: 无（`meta.ellipsis` 覆盖 0 列）
- 判定: 需要修
- 风险与备注: 只有三列，但「原因」是后端拼出来的中文长句（可能含列名与期望格式），且这表渲染在固定宽度的面板里。可直接照 `apps/web/app/procurement/materials/page.tsx:279-281` 的同形表做法（行号 12% / 字段 18% + ellipsis / 原因 70% + ellipsis）。

### [T18] apps/web/app/warehouse/stocktakes/page.tsx:438
- 渲染方式: DataTable
- 表格标识: 库存盘点 → 「盘点单」列表
- 列数: 11
- 列清单: 盘点单号(宽度=无, 省略=无) 盘点月份(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 明细数(宽度=无, 省略=无) 差异行数(宽度=无, 省略=无) 来源文件(宽度=无, 省略=无) 导入时间(宽度=无, 省略=无) 确认时间(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无（`stocktakeColumns` 定义 332-354 行，`meta.width` 覆盖 0/11 列）
- 省略与悬停现状: 无（`meta.ellipsis` 覆盖 0 列）
- 判定: 需要修
- 风险与备注: 「来源文件」是用户上传的 Excel 文件名（无长度上界，中文名常见），是最长的一列；操作列按状态最多 3 个按钮（明细 / 确认 / 删除 或 冲销）。行本身支持双击打开明细（`onRowDoubleClick`），不影响列宽判断。

### [T19] apps/web/app/warehouse/stocktakes/page.tsx:474
- 渲染方式: DataTable
- 表格标识: 库存盘点 → 盘点单明细（`data-testid="stocktake-detail"` 区内）
- 列数: 14
- 列清单: 行号(宽度=无, 省略=无) 产品代码(宽度=无, 省略=无) 产品名称(宽度=无, 省略=无) 产品规格(宽度=无, 省略=无) 仓位(宽度=无, 省略=无) 货位(宽度=无, 省略=无) 单位(宽度=无, 省略=无) 导入时账面(宽度=无, 省略=无) 实盘数(宽度=无, 省略=无) 导入时差异(宽度=无, 省略=无) 确认时账面(宽度=无, 省略=无) 已应用调整(宽度=无, 省略=无) 差异原因(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无（`lineColumns` 定义 356-380 行，`meta.width` 覆盖 0/14 列）
- 省略与悬停现状: 无（`meta.ellipsis` 覆盖 0 列）
- 判定: 需要修
- 风险与备注: 全模块列数最多的一张（14 列）。产品名称/规格/仓位/货位/差异原因五个自由文本列都无界，其中「差异原因」是用户手填的长句；操作列在草稿态是两个按钮、已确认态是一句「已确认」。这是横向滚动最严重的一张。

## 建议

统一前提（适用于下面所有 DataTable）：**宽度与省略必须成对给**——只写 `meta.ellipsis` 不会生效，因为 `.cell-ellipsis` 的 `text-overflow` 只在 `data-table-fixed` 下命中（globals.css:232-238），而 `data-table-fixed` 由「任意一列有 `meta.width`」触发（data-table.tsx:86）。同时注意 `ellipsisTitle` 只认字符串/数字（data-table.tsx:53-77），所以按钮列、缩略图列、checkbox 列给了 `meta.width` 也不要给 `meta.ellipsis`（给不出 title，等于多一个无效类）。

1. **销售列表类三张（T1 / T2 / T3）**：给每列补 `meta.width`（合计约 100%），文本列（客户 / 产品 / 国家/地区 / 编码）加 `meta.ellipsis`；「操作」列给固定 px 宽（T1 最多 4 个按钮、T2 是 4 个按钮，建议 160–200px）且不加 ellipsis。「订单号」这类内含 `<Button variant="link">` 的列给宽后靠 `data-table-fixed` 的 `overflow: hidden` 兜住，但按钮文字会被裁——若不愿裁，就把按钮换成纯文本 + 整行 `onRowDoubleClick`（T1 现在没有用这个能力）。
2. **审计两列（所有含 `...auditColumns()` 的表：T1 / T2 / T6 / T7 / T8 / T11 / T12 / T13 / T14 / T16 / T18）**：不要改 `auditColumns()` 工厂本身（会波及全站 30 多处调用）。按 `apps/web/app/procurement/materials/page.tsx:218-222` 的既定先例，在页内展开时覆盖一次：`{ ...createdByColumn<X>(), meta: { width: "8%" } }` / `{ ...updatedByColumn<X>(), meta: { width: "8%" } }`。这两列的内容自带容器 title（audit-columns.tsx:51），不需要 `meta.ellipsis`。
3. **仓库首页三张（T6 / T7 / T8）**：同一处修法——`采购/到货`、`物料` 两个拼串列给宽 + `ellipsis: true`；`物料明细`（T7）与 `备注` 类列必须给 `ellipsis: true`，否则 hover 看不到被裁掉的明细；`操作` / 状态列给窄固定宽、不加 ellipsis。三张表共用一份百分比宽度表即可（列不同，但同一批列名给同一个宽度更不容易漂移）。
4. **成品仓储 DataTable 五张（T10 / T11 / T12 / T13 / T14）**：T11（13 列）与 T14（12 列）优先。T13 的「成品」「出库单」与 T14 的「成品」「发货」是拼串列，必须 `ellipsis: true`；T14 的「操作」列（最多 5 个按钮）给固定 px 宽。T10 与 T3 同形，低优先。
5. **原料仓储两张（T15 / T16）**：T15 的「物料」「规格型号」给宽 + `ellipsis: true`（这两列正是原料的关键区分项，被裁必须能悬停看全）；T16 的「备注」给固定较窄宽度 + `ellipsis: true`，`操作` 列固定 px 宽。
6. **盘点三张（T17 / T18 / T19）**：T17 直接照抄 `apps/web/app/procurement/materials/page.tsx:279-281` 的三列比例；T18 的「来源文件」给宽 + `ellipsis: true`；T19（14 列）需要逐列定宽——数值列各 5–7%，产品代码/名称/规格/仓位/货位共给约 40%，`差异原因` 给 12% + `ellipsis: true`，`操作` 给固定 px 宽。
7. **手写表两张（T5 工艺单导出弹窗、T9 成品存量收束表）**：它们的单元格是 `.ui-table-cell`，用不上 `data-table-fixed` 那套规则，必须自己写 CSS（先例是 globals.css:540-542 给采购计划手写表补的 `.plan-cell-ellipsis`）。T5 建议 3 列定宽（勾选 12% / 文本 63% + 自写省略类 / 预览 25%）；T9 建议 5 列定宽，并给展开行那格的「生产单 / 成品名 / 规格」加自写省略类 + 容器 `title`（它的内容跨两行结构，DataTable 的 `ellipsisTitle` 同样给不出 title，与 `auditActorCell` 是同一类问题）。
8. **T4（sales-order-editor 细分明细）保持现状**：可编辑网格，单元格是 `<Input>`，压窄会挤坏控件，省略与 hover title 对输入框无意义。

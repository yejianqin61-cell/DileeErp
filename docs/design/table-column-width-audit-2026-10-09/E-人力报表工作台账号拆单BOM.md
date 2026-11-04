# E — 人力 / 报表 / 工作台 / 账号 / 拆单 / BOM 表格清单

审计范围：`apps/web/app/hr/**`、`apps/web/app/reports/**`、`apps/web/app/workbench.tsx`、`apps/web/app/page.tsx`、`apps/web/app/account/**`、`apps/web/components/{account,reorder,bom,hr,panels,modules}/**`（14 个文件，已逐个全量读取）。

前置事实（用于判定，均已核对源码）：
- `DataTable` 的列宽/省略只由列定义上的 `meta.width` / `meta.ellipsis` 驱动（`components/data/data-table.tsx:86-91`）：任意一列有 `meta.width` 才给 `<table>` 加 `data-table-fixed`（`table-layout: fixed`），有 `meta.ellipsis` 才加 `cell-ellipsis` + 原生 `title`。
- **本次范围内 `meta.width` / `meta.ellipsis` 使用数 = 0**（已用 `Select-String` 全量搜 `meta:` / `ellipsis`，命中的全是 API 返回值的 `meta: {}`，无一处列元数据）。
- `DataTable` 外层是 `.table-wrap { overflow-x: auto }`（`globals.css:172`），`Table` 原语外层是 `.ui-table-wrap { overflow: auto }`（`globals.css:82`）。因此「列宽不受限」的表现是**表被内容撑宽 + 底下出现横向滚动条**，不会撑破页面栅格。
- `.ui-table-cell` 默认 `white-space: nowrap`（`globals.css:89`）；`.data-table th/td` 默认 `white-space: nowrap`（`globals.css:187`）。范围内**没有任何一张表位于 `.finance-page` 之下**（hr / reports / workbench / account / reorder / bom 都不带该类），因此财务页那套「放开换行 + `overflow-wrap: anywhere`」的豁免（`globals.css:208-212`）对本范围一律不生效 —— nowrap 就是实际生效的规则，长文本必然撑列。
- 关于任务书里「account-center.tsx 与 bom-workbench.tsx 含有很多 raw `<table>`」：实测**各只有 1 张**——`account-center.tsx` 用共享原语 `<Table>/<TableCell>` 手写了一张表（等价 raw table），`bom-workbench.tsx` 有 1 个字面 `<table className="data-table bom-table">`。范围内全部 raw table 共 4 张，无遗漏（其余文件里没有任何 `<table` / `<Table` / `<DataTable`）。
- 附带发现：`app/workbench.tsx:27` 的 `productionColumns` 已定义但**从未使用**（死代码）。

## 统计
- 表格总数: 12
- DataTable 调用点: 8
- 手写 <table>: 4
- 需要修（列宽不受限 / 无省略悬停）: 11
- 已达标: 1
- 不适用（可编辑网格等，需保持现状）: 0

## 明细

### [T1] apps/web/app/hr/page.tsx:1042
- 渲染方式: DataTable
- 表格标识: 批量导入员工弹窗内的「未导入的行」明细表（`DialogContent className="hr-import-dialog"`，`empty={null}`）
- 列数: 3
- 列清单: 行号(宽度=无, 省略=无) 字段(宽度=无, 省略=无) 原因(宽度=无, 省略=无)
- 列宽约束现状: 无
- 省略与悬停现状: 无
- 判定: 需要修
- 风险与备注: 列定义内联在 JSX 里；`原因` 是后端返回的**整句中文提示**（如"身份证号码校验位不正确"），`.ui-table-cell` 为 nowrap、无 `cell-ellipsis`、无 title，一句 20+ 字就把表顶宽。表在弹窗内，`.hr-import-dialog` 在 `globals.css` 里**没有任何宽度规则**（已确认无此选择器），弹窗宽度不受此表约束。

### [T2] apps/web/app/hr/page.tsx:1228
- 渲染方式: DataTable
- 表格标识: `employeeColumns`（员工目录，`data-testid="page-hr"` 主表）
- 列数: 17
- 列清单: 工号(宽度=无, 省略=无) 姓名(宽度=无, 省略=无) 部门/职务(宽度=无, 省略=无) 性别(宽度=无, 省略=无) 出生日期(宽度=无, 省略=无) 年龄(宽度=无, 省略=无) 学历(宽度=无, 省略=无) 入职日期(宽度=无, 省略=无) 工龄(宽度=无, 省略=无) 联系方式(宽度=无, 省略=无) 合同情况(宽度=无, 省略=无) 类型(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 离职日期(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无
- 省略与悬停现状: 无（`创建人/最后修改人` 由 `...auditColumns<Employee>()` 展开，其单元格自己带 `title`，见 `components/data/audit-columns.tsx:51`；其余列无）
- 判定: 需要修
- 风险与备注: 17 列 + 零列宽约束 = 全表自动布局。长值来源明确：「部门/职务」是 `部门名 / 职务名` 拼接字符串、「联系方式」「合同情况」是可变长文本、「创建人/最后修改人」是 `auditActorCell` 的两行结构（姓名 + 时间），再加「操作」列的 3 个 nowrap 按钮（编辑/离职/删除，`编辑`列已删除行时只剩 `恢复`）。除审计两列外**没有任何一列有省略 + hover 兜底**。

### [T3] apps/web/app/hr/page.tsx:1240
- 渲染方式: DataTable
- 表格标识: `recordColumns`（考勤与绩效合表）
- 列数: 6
- 列清单: 类型(宽度=无, 省略=无) 员工(宽度=无, 省略=无) 日期/周期(宽度=无, 省略=无) 结果(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无)
- 列宽约束现状: 无
- 省略与悬停现状: 无（仅审计两列自带容器 title）
- 判定: 需要修
- 风险与备注: 「员工」列做的是 `employeeName(employeeId)` 查表（能取到姓名，但取不到就回落成 **UUID**）；「日期/周期」把日期 + 起止时间或起止日期拼成一句；这些都没有省略/hover。

### [T4] apps/web/app/reports/page.tsx:46
- 渲染方式: DataTable
- 表格标识: `alertColumns`（定义在同文件 :44）——告警中心，外层 `section data-testid="daily-alert-table"`
- 列数: 6
- 列清单: 级别(宽度=无, 省略=无) 标题(宽度=无, 省略=无) 订单号(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 建议(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无
- 省略与悬停现状: 无
- 判定: 需要修
- 风险与备注: 「标题」与「建议」都是后端产出的整句中文（如"员工日报与工序日报差异"、"请核对当天日报后再确认"），是这张表最宽的来源；「操作」列是按钮。无 `cell-ellipsis`、无 title，长句直接横向撑表。

### [T5] apps/web/app/reports/page.tsx:46
- 渲染方式: DataTable
- 表格标识: `reportColumns`（定义在同文件 :45）——报表数据表，**列集合由 `Object.keys(rows[0])` 动态生成**，随页签变化
- 列数: 9～12（按页签；无数据时为 0，DataTable 走 `empty` 分支不渲染表）
- 列清单: 逐页签列出（键名 = 表头，`displayField` 未映射的键**原样显示英文**，`lib/display-text.ts:6`）——
  - 订单推进(orders, 10 列): 订单号 产品名称=`product_name` 数量 单位 状态 交货日期=`delivery_date` 创建时间 更新时间 创建人 最后修改人
  - 采购与应付(procurement-payables, 10 列): 采购单号=`purchase_order_no` 订单号 供应商=`supplier` 状态 金额 币种 创建时间 更新时间 创建人 最后修改人
  - 库存(inventory, 9 列): 编号=`id` 订单号 库存类别 库存变动=`quantity_delta` 来源类型 来源编号 创建时间 创建人 最后修改人
  - 生产与质检(production-qc, 12 列): 质检单号=`qc_no` 订单号 结论=`conclusion` 状态 送检数量=`inspected_quantity` 合格数量=`qualified_quantity` 不合格数量=`rejected_quantity` 检验日期=`inspection_date` 创建时间 更新时间 创建人 最后修改人
  - 薪资(payroll, 11 列): 台账单号=`ledger_no` 员工=`employee_id` 周期开始=`period_start` 周期结束=`period_end` 状态 基本工资=`base_salary` 生产来源金额=`production_source_amount` 创建时间 更新时间 创建人 最后修改人
  （列清单依据 `apps/api/src/modules/reports/reports.service.ts:25-35` 各方法的 `data: rows.map(...)` 键序，非猜测）
- 列宽约束现状: 无
- 省略与悬停现状: 无
- 判定: 需要修
- 风险与备注: 三重风险叠加。①「供应商」列的值是 `supplierSnapshot` **对象**，cell 里 `JSON.stringify(value)`（`:45`）→ 单行 JSON 串，长度可达数百字符，nowrap 下必然撑爆；②`inventory` 的 `id` / `source_id`、`payroll` 的 `employee_id` 是 **UUID（36 字符）**；③`inventory` 的 `最后修改人` 服务端恒为 `null`（`reports.service.ts:31`），列存在但永远显示 "-"。此外这些列的审计单元格是**普通 accessorKey 列**（不是 `auditColumns()`），所以拿不到 `auditActorCell` 自带的 title。

### [T6] apps/web/app/workbench.tsx:64
- 渲染方式: DataTable
- 表格标识: 订单全链路（`section.panel.table-panel`，列定义内联在 JSX，基于 `orderColumns`）
- 列数: 6
- 列清单: 订单号(宽度=无, 省略=无) 总体状态(宽度=无, 省略=无) 销售(宽度=无, 省略=无) 阻塞原因(宽度=无, 省略=无) 更新时间(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无
- 省略与悬停现状: 部分自写 title——「阻塞原因」的每个 badge 是 `<span className="workbench-blocker" title={item.suggestion}>`（`:64`），但 title 给的是**处理建议**，不是该 badge 显示的那串 `item.label`；其余列无省略无 title
- 判定: 需要修
- 风险与备注: 「阻塞原因」是多个 badge 纵向堆叠，`globals.css:261` 只给了 `min-width: 170px; white-space: normal`，badge 文本本身仍是 nowrap → 长阻塞原因把一个单元格撑到几百 px；「操作」是按钮。

### [T7] apps/web/app/workbench.tsx:65
- 渲染方式: DataTable
- 表格标识: 生产计量（`progress-detail-grid` 内，`gridColumn: 1 / -1` 的整宽 panel，列定义内联，基于 `measurementColumns`）
- 列数: 8
- 列清单: 工序/来源(宽度=无, 省略=无) 完成数量(宽度=无, 省略=无) 计划数量(宽度=无, 省略=无) 差额(宽度=无, 省略=无) 超单量(宽度=无, 省略=无) 完成率(宽度=无, 省略=无) 单位(宽度=无, 省略=无) 计量状态(宽度=无, 省略=无)
- 列宽约束现状: 无
- 省略与悬停现状: 无
- 判定: 需要修
- 风险与备注: 「工序/来源」在 `operation_name` 为空时回落成较长的中文说明（"外加工直装柜" / "外加工成品回厂"）；其余为数量/比率，宽度可控，但整表仍无任何列宽或省略约束，列名与内容完全交给自动布局。

### [T8] apps/web/components/account/account-center.tsx:138
- 渲染方式: 手写 table（使用共享原语 `<Table>/<TableHeader>/<TableRow>/<TableHead>/<TableCell>`，落在 `.ui-table-wrap > table.ui-table`）
- 表格标识: `account-admin-panel` 内的「账号管理」表（`data-testid="account-row-<username>"` 逐行）
- 列数: 6
- 列清单: 用户名(宽度=无, 省略=无) 姓名(宽度=无, 省略=无) 角色(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 创建时间(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无（只在 `TableCell` 上用内联 `style={{ display: "flex", gap: 6, flexWrap: "wrap" }}` 包按钮组，`:148`）
- 省略与悬停现状: 无
- 判定: 需要修
- 风险与备注: 「角色」列是 `surface_roles.map(surfaceRoleName).join("、")`，多角色账号可达数十字；「操作」列 3 个按钮（改角色/重置密码/停用或启用）nowrap，是第二个撑宽源。`.ui-table-cell` 是 nowrap 且无省略/title；`.ui-table-wrap` 会出横向滚动条兜底，所以不破坏布局，但「角色」一旦超宽就只能靠拖动滚动条看。

### [T9] apps/web/components/reorder/unassigned-panel.tsx:116
- 渲染方式: 手写 table
- 表格标识: `<table className="ui-table" data-testid="unassigned-table">`（未填货号待补录清单）
- 列数: 8
- 列清单: 全选复选框(宽度=无, 省略=无) 销售单号(宽度=无, 省略=无) 客户(宽度=无, 省略=无) 产品(宽度=无, 省略=无) 数量(宽度=无, 省略=无) 下单日期(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无
- 省略与悬停现状: 无
- 判定: 需要修
- 风险与备注: 表头写了 `className="ui-table-head"`（nowrap + 40px 高），但**所有 `<td>` 都没有 className**（`:140-159`）→ 单元格拿不到 `.ui-table-cell` 的 padding/nowrap，实际是「表头 nowrap、内容自动换行、无内边距」。两个后果：①列宽仍由最长的单元格 min-content 决定，产品名/客户名长时整表被撑宽并出现横向滚动条；②同一张表内表头与内容行的排版基准不一致（表头 40px + 12px 内边距，内容行无内边距）。包裹层是 `<div className="table-wrap">`（overflow-x: auto）。

### [T10] apps/web/components/reorder/document-groups.tsx:81
- 渲染方式: 手写 table
- 表格标识: `<table className="ui-table">`（单据分组，**每个分组各渲染一张**，`DOCUMENT_ROUTES` 共 17 个分组，最多 17 张同位表）
- 列数: 5
- 列清单: 单号(宽度=无, 省略=无) 日期(宽度=无, 省略=无) 数量(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
- 列宽约束现状: 无
- 省略与悬停现状: 无（`:95` 只有一个条件类名 `cn(document.date_source === "created_at" && "panel-note")`，用于把"登记时间"标灰，与省略无关）
- 判定: 需要修
- 风险与备注: 与 T9 同源问题——`<td>` 全部无 className（`:94-98`），表头有 `.ui-table-head`。单号列（`PO-20260101-0001` 之类）与「日期（登记时间）」后缀文本是主要宽度来源。因为同一张 5 列表被复制 17 份、且各自独立自动布局，同一列在不同分组里的宽度**互不相同**，视觉上不像一组表（`globals.css:440` 只给了组间距）。

### [T11] apps/web/components/bom/bom-workbench.tsx:258
- 渲染方式: 手写 table
- 表格标识: `<table className="data-table bom-table">`（BOM 明细编辑网格，在 `SheetContent className="bom-workbench"` 里；采购/生产三个入口共用）
- 列数: 10（默认）；生产侧 `showSupplier={false} + showReferencePrice={false}` 时为 8
- 列清单: 序号(宽度=有, 省略=无) 物料名称(宽度=有, 省略=有, 自写 title) 型号(宽度=有, 省略=无) 规格型号(宽度=有, 省略=无) 颜色(宽度=有, 省略=无) 数量(宽度=有, 省略=无) 单位(宽度=有, 省略=无) 供应商(宽度=有, 省略=无) 参考单价(宽度=有, 省略=无) 操作(宽度=有, 省略=无)
- 列宽约束现状: CSS 选择器全覆盖——`.bom-table { table-layout: fixed; min-width: 1180px; }`（`globals.css:767`）+ `.bom-table .bom-col-index|material|model|spec|color|quantity|unit|supplier|price|action` 逐列百分比宽度（`:769-778`，十列合计 100%，守卫见 `lib/bom-table.test.mjs`）；生产侧少两列时按比例摊给其余列（注释 `:748-751` 记录了实测依据）
- 省略与悬停现状: 物料名称列：`.bom-table .bom-col-material .ui-select-trigger > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }`（`:779-780`）+ `SelectTrigger title={materialLabelOf(row.materialId)}`（`bom-workbench.tsx:260`，与触发器显示的是同一份 label）；参考单价的币种格同样有省略（`:783`）。其余列为原生 `<Input>/<Select>`，靠控件自身横向滚动，不需要文本省略
- 判定: 已达标
- 风险与备注: 这是**唯一已达到「列宽有界 + 超长省略 + hover 看全文」标准**的表，且它是可编辑网格却没用「不适用」豁免——因为用户 2026-10-08 明确要求过这一列宽方案，代码与 CSS 都已落地（`globals.css:726-784` 有完整实测注释）。两点保留：①`min-width: 1180px` 意味着 1024 视口下按设计出横向滚动（注释 `:752-753` 记录为有意为之）；②「型号/规格型号/颜色/数量」是 `<Input>`，长值只能靠输入框内部滚动查看，没有 title——若要求与物料名称列同等的 hover 体验，需要另行补 `title`。

### [T12] apps/web/components/hr/organization-pool.tsx:36
- 渲染方式: DataTable
- 表格标识: `columns`（同一处调用按 `kind` 渲染两张不同表：`app/hr/departments/page.tsx` 的部门池、`app/hr/positions/page.tsx` 的岗位池）
- 列数: 9（两种 kind 都是 9 列）
- 列清单: 
  - 部门池(kind=departments): 部门编码(宽度=无, 省略=无) 部门名称(宽度=无, 省略=无) 岗位数(宽度=无, 省略=无) 员工数(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 备注(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
  - 岗位池(kind=positions): 岗位编码(宽度=无, 省略=无) 岗位名称(宽度=无, 省略=无) 所属部门(宽度=无, 省略=无) 员工数(宽度=无, 省略=无) 状态(宽度=无, 省略=无) 备注(宽度=无, 省略=无) 创建人(宽度=无, 省略=无) 最后修改人(宽度=无, 省略=无) 操作(宽度=无, 省略=无)
  （`{label}编码 / {label}名称` 的 label 由 `kind` 决定；`auditColumns<Department | Position>()` 展开第 7、8 列）
- 列宽约束现状: 无
- 省略与悬停现状: 无（仅审计两列自带 `auditActorCell` 容器 title）
- 判定: 需要修
- 风险与备注: 「备注」是自由文本、无长度上限，是最大的撑宽源；「操作」列最多 3 个按钮（编辑/停用或启用/删除，已删除行只有恢复）；「所属部门」是 `部门编码 / 部门名称` 拼接串。整表无列宽、无省略。

## 建议

按修法把 11 张待修表分组（T11 无需改动，仅保留上文两点观察）。

**A. DataTable 型（T1/T2/T3/T4/T5/T6/T7/T12）——用现成的列元数据机制，不动基础设施**
1. 给每列补 `meta: { width: "..." }`，同一张表所有列的宽度**必须合计 100%**（`DataTable` 只要见到任意一列有宽度就把整表切成 `data-table-fixed`；有百分比缺口的表在窄屏会出怪列，`globals.css:748-751` 有实测教训）。建议按「内容最大长度」排序分配：短枚举列（状态/类型/级别/日期）5–8%，文本列（标题/建议/备注/部门/职务/供应商 JSON）12–20%，按钮列给固定 px（如 `"120px"`）并允许换行。
2. 对存在长文本的列补 `meta: { ellipsis: true }`，注意 `ellipsisTitle` 只认**字符串/数字**：`id` + 自定义 `cell` 且没有 accessor 的列取不到值，必须改成 `accessorFn` 返回屏幕上那串字，或自己在容器上加 `title`（`data-table.tsx:75-77`、`audit-columns.tsx:47-56` 的既有先例）。
3. 逐表重点：
   - **T1（导入错误明细）**：3 列，`原因` 必须 `ellipsis: true`；宽度 8% / 12% / 80%。
   - **T2（员工目录，17 列）**：最需要修的一张。`部门/职务`、`联系方式`、`合同情况` 三列给 `ellipsis: true` 并写成 `accessorFn`（现在是纯 `cell`），审计两列沿用 `auditColumns()` 已有的容器 title（不要重复加 `ellipsis`，ReactNode 取不到 title）。`操作` 列给足按钮宽度（3 个按钮约 150px）否则会被压到折行。
   - **T3（考勤与绩效）**：`员工` 列目前会在查不到人时显示 UUID，建议同时补 `ellipsis: true`；`日期/周期` 列给 22% 左右。
   - **T4（告警中心）**：`标题`/`建议` 必须 `ellipsis: true`；`操作` 列固定宽度。
   - **T5（报表数据，列由后端键动态生成）**：这张表**不能只靠页面写死 meta**——列集合随页签变化。两种可选修法：①在 `reportColumns` 的 `map` 里按 `key` 查一张「已知长文本键」表集中给宽度/省略（`supplier`、`id`、`source_id`、`employee_id` 必须 `ellipsis`，`title`/`suggestion` 同理）；②更稳妥：`supplier` 这种对象值在 cell 里不要 `JSON.stringify` 整坨，改为取 `name`/`supplierCode` 等具名字段渲染，从根上消掉「单行 JSON」。同时建议把 `inventory` 页签恒定为空、无意义的 `最后修改人` 列处理掉（服务端恒 `null`，`reports.service.ts:31`）。
   - **T6（工作台订单全链路）**：`阻塞原因` 给 `meta: { width, ellipsis: true }` 不适用（单元格是 ReactNode），应改为**给 badge 自己带 `title={item.label}`**（现在 title 给的是 `suggestion`，看到的是建议不是被截断的那串字），并给该列 `white-space: normal` 的容器宽度上限。
   - **T7（生产计量）**：8 列内容都短，宽度分配即可，无需省略。
   - **T12（部门池/岗位池）**：`备注` 列必须 `ellipsis: true`；`操作` 列固定宽度。

**B. 手写 `<table>` 但用的是共享原语（T8）**
- 与 A 组同一套修法但机制不同：`<Table>` 走的是 `.ui-table`，`meta` 对它无效。两个选择：①改用 `DataTable` 并复用现成的 `meta.width`/`meta.ellipsis` 机制（推荐，账号表本来就是只读列表）；②保留原语，则在 `globals.css` 里加页面私有规则（固定列宽 + `overflow: hidden; text-overflow: ellipsis` + 自写 `title`），参照 `.materials-page-table`（`globals.css:829-831`）的写法。
- 单列重点：`角色` 列（多角色 `join("、")`）与 `操作` 列（3 个按钮）。

**C. 裸 `<td>` 的手写表（T9 unassigned-table、T10 document-groups）——先补齐样式基准，再谈宽度**
- 这两张表的 `<td>` **完全没有 className**，所以既没有 `.ui-table-cell` 的 padding，也没有受控的 nowrap/省略。最小改动：给所有 `<td>` 加 `className="ui-table-cell"`，让它们与表头（已是 `.ui-table-head`）回到同一套排版基准；`document-groups.tsx:95` 的条件类名改成 `cn("ui-table-cell", ...)`。
- 之后再按 A 组思路给「产品/客户/单号」列加宽度与省略：这两张是手写表，`meta` 不生效，只能在 CSS 里写（建议给它们各自的 `<table>` 加一个类，如 `.unassigned-table`、`.document-group-table`，然后在 `globals.css` 里用 `table-layout: fixed` + `nth-child` 宽度 + `.ui-table-cell` 的 `text-overflow: ellipsis`，并给单元格补 `title`）。
- T10 额外建议：17 张同位表各自独立自动布局，导致同一列在不同分组里宽度不一致；若希望对齐，应改用一张表 + 分组行（或至少给单号列固定宽度），仅靠 CSS 无法跨表对齐。

**D. 无需改动**
- T11（`bom-workbench.tsx:258`）：列宽、省略、hover 三项齐备，保持现状。若要与其它表口径完全统一，可考虑的仅是给「型号/规格型号/颜色」三个 `<Input>` 单元格补 `title`（当前只能靠输入框内部滚动看长值），非必需。

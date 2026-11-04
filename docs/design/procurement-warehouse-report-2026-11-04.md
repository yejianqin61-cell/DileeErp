# 采购与仓储报表（按订单 × 物料的采购 / 入库 / 领用 / 库存对照）

- 日期：2026-11-04
- 状态：设计已定，按本文实施
- 需求来源：用户原话「用户需要一份采购与仓储报表。需要这些信息。你统揽系统，采购模块，仓库模块，然后设计这份报表并支持导出与打印」，同时给出目标版式截图（一张 Excel 表：订单号 / 物料名称 / 颜色 / 单位 / 采购数量 / 采购入库量 / 采购未入库数 / 生产领用数量 / 库存量，11 行物料、订单号 260119）。
- 关联：[采购模块设计](./procurement-module-design.md)、[仓库模块设计](./warehouse-module-design.md)、[出库单导出与打印](./outbound-slip-export-and-print-2026-11-02.md)、[供应商编码与采购单库存粒度](./supplier-code-and-procurement-stock-granularity-2026-09-15.md)、[超收与按实收登记质检](./../log/2026-11-04.md)

## 1. 一条原则：五个数量都是「同一个订单 × 同一个物料 × 同一个单位」上的账

报表的每一行是**一张订单上的一个物料**（物料粒度＝`materials` 的唯一键「名称 + 规格型号 + 颜色」，单位不换算）。
五个数量分别来自三类已生效业务事实，全部**按单据上自己的 `order_no` 归集**：

| 数量列 | 精确口径 | 数据来源 |
| --- | --- | --- |
| 采购数量 | 该订单下**已下单**采购明细的订购数量合计 | `purchase_order_items.quantity`（`purchase_orders.status ∈ ordered / partially_arrived / arrived_complete`，两张表 `deleted_at is null`） |
| 采购入库量 | 该订单下**已过账**原料入库单的入库数量合计（草稿不算，冲销的入库单状态已变 `reversed` 也不算） | `raw_material_inbounds.quantity`（`status = 'posted'`，`deleted_at is null`），与仓库「原料仓储情况」同一批单据 |
| 采购未入库数 | = 采购数量 − 采购入库量；**允许为负**（2026-11-04 起允许超收，多送的按实收入库，负数就是超收量） | 计算列 |
| 生产领用数量 | 该订单下生产已过账的**领料 + 补料 − 退料**（冲销、撤销过账后的净额；报废不计入领用） | `inventory_facts.quantity_delta` 取负号，`source_type ∈ material_issue / material_replenishment / material_return / material_movement_reversal / material_movement_reopen`，`rawMaterialMovementLineId` 非空 |
| 库存量 | 该**物料 + 单位**的当前结存（原料仓 + 报废仓，与 `GET /inventory/raw-material-balances` 完全同口径） | `inventory_facts.quantity_delta` 之和，`inventory_category ∈ raw_material / scrap`，物料须为 `material_type = 'raw_material'` 且物料、单位都未删除 |

三条必须写进口径说明（页面、打印件、导出件都印）的规则：

1. **不跨单位相加**：同一物料若历史上出现过两个单位，会分成两行（2026-09-15 的教训：把「米」和「卷」加起来得到的库存数不可比，不能用于任何判断）。
2. **库存量不按订单拆账**：仓库模块 §2/§5 明确规定库存是物料级静态结存，订单归属只留在动态单据明细里。因此同一物料出现在多张订单时，**每行的库存量是同一个数**（当前结存），不是「这张订单还剩多少料」。
3. **本表不设合计行**：行是不同单位组成的，跨单位合计没有意义；合计只会在单位内部有意义，而本报表不按单位分组展示。

## 2. 行集合与筛选

**行集合** = 下列三类来源在「订单号 × 物料 × 单位」上的并集，且五个数量不同时全为 0：

1. 已下单采购明细（含已到货、已超收）；
2. 已过账原料入库单；
3. 生产领用（领料 / 补料 / 退料 / 冲销）事实。

明确**不从 BOM 需求出发**：只有采购计划/BOM 需求、还没下采购单的物料不出行。理由：本表要回答的是「买了多少、回来多少、用了多少、还有多少」，BOM 需求是另一张（采购计划）的事实；把需求混进「采购数量」会让两列互相污染。

**筛选**（两个，都是模糊匹配，走数据库查询，不拼可变长 URL）：

| 参数 | 作用 |
| --- | --- |
| `order_no` | 订单号包含匹配（大小写不敏感）；不给＝全部订单 |
| `material` | 物料名称 **或** 物料编码包含匹配（大小写不敏感）；不给＝全部物料 |

不提供日期范围：采购日期、到货日期、业务日期、领用日期是四个不同日期，挂哪一个都要另说，属于待确认项（见 §8），先不做半对不对的筛选。

**行数上限**：单次最多 **5000 行**，超过返回 422 `REPORT_ROW_LIMIT_EXCEEDED`（提示按订单号/物料缩小范围）。理由：屏幕、打印、导出必须是同一份数据，不能出现「屏幕 200 行、导出 5000 行」；厂内一次看一张或几张订单是常态，5000 行是保护闸而不是分页。

**排序**：订单号倒序（数字感知，`260119` > `26012` 而不是字符串比较），同订单内物料名称升序、单位升序。

## 3. 接口契约

模块：`apps/api/src/modules/reports/`（报表模块；本报表与既有 5 张报表并列）。
权限：`@RequireAnyModules("procurement", "warehouse")`（采购或仓库任一模组可看；与既有报表的 `RequireAnyModules` 风格一致）。

### 3.1 屏幕取数

`GET /api/v1/reports/procurement-warehouse?order_no=&material=`

```json
{
  "data": [
    {
      "order_no": "260119",
      "material_name": "58cm*8k自动直骨伞",
      "color": "黑色",
      "unit": "打",
      "purchase_quantity": "4700",
      "inbound_quantity": "4700",
      "pending_inbound_quantity": "0",
      "production_issue_quantity": "3050",
      "stock_quantity": "1650"
    }
  ],
  "meta": {
    "generated_at": "2026-11-04T14:30:00.000Z",
    "row_count": 11,
    "row_limit": 5000,
    "filters": { "order_no": "260119", "material": null }
  }
}
```

- 数量一律为**去掉无意义尾零的十进制字符串**（`4700` 而不是 `4700.0000`；`-0` 输出 `0`）。理由：既有报表接口也把 Decimal 转字符串输出，避免前端浮点误差；xlsx 导出内部仍用 Decimal 写数值单元格。
- `color` 为空字符串时前端显示 `-`（不返回 null，少一种分支）。

### 3.2 Excel 导出

`GET /api/v1/reports/procurement-warehouse/export.xlsx?order_no=&material=`

- 同一个取数函数（与 §3.1 **同一份数据**，不另算一遍），ExcelJS 生成一个工作表 `采购与仓储报表`；
- 版式：A4 **横向**、`fitToPage` + `fitToWidth: 1`、水平居中；第 1 行标题（`迪礼ERP　采购与仓储报表`），第 2 行筛选条件 + 生成时间 + 行数，第 3 行表头（九列，与屏幕同序同名），第 4 行起数据，末尾一行口径说明（自动换行、合并整行）；
- 数量单元格写成**数值**（`0.####` 格式），不是文本：用户在 Excel 里要能直接求和/排序；
- 每列宽度按 `platform/excel/row-height.ts` 的 CJK 宽度口径设置，行高用 `rowHeightFor` 计算（长物料名折行不截断）；
- 文件名：`迪礼ERP-采购与仓储报表-<北京时间戳>.xlsx`，`Content-Disposition` 用 `filename*=UTF-8''` 编码（与采购单导出同一写法）；
- 行数超 5000 同样 422。

### 3.3 打印

不做服务端 PDF。打印走浏览器：页面上「打印」打开**打印预览弹窗**（与出库单 / 领料单 / 凭证同一做法：`@media print` 只留 `.procurement-warehouse-sheet`），用户再按浏览器打印或另存 PDF。

- 打印纸版式：A4 **横向**。命名页写法与其余单据不同，必须照下面这条（实施时踩过，勿改回去）：
  - `@page procurement-warehouse { size: A4 landscape; margin: 10mm; }`；
  - 命名页挂 **html / body** 且用 `:has()` 限定只在本报表纸面存在时生效：
    `html:has(.procurement-warehouse-sheet), body:has(.procurement-warehouse-sheet) { page: procurement-warehouse; }`；
  - 纸面本身 **不要** `position: absolute`（从既有几张单据的可见/定位清单里摘出来），改走文档流，
    并把背后的整页界面 `body:has(.procurement-warehouse-sheet) .app-shell { display: none }` 收掉；
  - 只对不支持 `:has()` 的旧浏览器留 `@supports not selector(:has(*))` 回退（退回纵向，挤但不空白）。
  - **依据（真实 Chromium 实测，2026-11-04）**：Chromium 不给绝对定位盒子分配命名页 —— 纸面自己写
    `page:` 时 `page.pdf()` 的 MediaBox 仍是 `612×792`（Letter 纵向），改成上面的写法后是
    `841.92×594.96`（A4 横向）、11 行 1 页。证据：`.agent/verify/_print-landscape-page-probe.json`、
    `_print-landscape-page-probe2.json`、`docs/test/results/procurement-warehouse-report/print-preview.pdf`。
- 纸面数字格的 DOM 必须是 `<td><span class="procurement-warehouse-num">…</span></td>`：`.procurement-warehouse-num`
  带 `display: block`（屏幕上用它做右对齐），**挂到 `<td>` 上会把单元格摘出表格布局**，实测每个数字竖着叠成一列、
  后四列被挤出纸外、11 行打出 3 页。该回归有组件测试守卫（`test/procurement-warehouse-report.test.tsx`）。
- 纸面内容：公司名 + 标题「采购与仓储报表」、筛选条件 + 行数 + 打印时间（北京时间）、九列表格（表头每页重复）、口径说明、不设合计行；
- 打印件数据＝屏幕上当前这份数据（同一次接口返回），不额外请求、不前端自算；
- 没有数据时不打开打印弹窗（不留空纸），提示「当前筛选条件下没有可打印的数据」。

## 4. 前端页面

路由：`/reports/procurement-warehouse`（属于 `reports` 表面栏目，`sectionOfPath` 前缀匹配已覆盖，无需改表面权限表）。
入口：`/reports` 页头部加一个「采购与仓储报表」按钮（不新开一级导航——报表是一级导航下的第二层，与采购/仓库下的子页一致）。

页面结构（自上而下）：

1. `PageHeader`：标题「采购与仓储报表」；右侧动作：**导出 Excel**、**打印**；
2. 筛选条：订单号、物料（名称/编码）、查询、重置；
3. 结果面板：表头九列（`订单号 9% / 物料名称 26% / 颜色 8% / 单位 6% / 采购数量 9% / 采购入库量 10% / 采购未入库数 11% / 生产领用数量 11% / 库存量 10%`，合计 100%，`DataTable` 的 `table-layout: fixed` 下必须写全）；数量列右对齐、等宽数字；负的「采购未入库数」「库存量」标红（超收 / 负库存）；
4. 口径说明面板（固定文案，见 §1 三条 + 各列来源一句话）；
5. 空态 / 错误态（沿用 `EmptyState` / `ErrorState`，错误态可重试）。

导出：`downloadFile`（`lib/download.ts`）带当前筛选参数，成功/失败 toast 与既有导出页一致。
打印：弹窗内 `.procurement-warehouse-sheet`，点「打印」调 `window.print()`。

文案不出现「UUID」、不出现英文状态码；口径说明里不写实现细节（表名/字段名），只写业务口径。

## 5. 测试

| 层 | 文件 | 要钉住什么 |
| --- | --- | --- |
| API 单测 | `apps/api/test/unit/procurement-warehouse-report.test.cjs` | 五列口径（草稿/已取消采购单不计、草稿入库不计、已冲销净额、退料抵减、报废不计领用、超收为负未入库）；行集合并集与全 0 行剔除；排序；`order_no`/`material` 过滤；5000 行上限 422；金额字符串去尾零；xlsx 工作簿（表头、数值单元格、A4 横向、文件名）；控制器 DTO/路由/权限/Content-Disposition |
| Web 逻辑单测 | `apps/web/lib/procurement-warehouse-report.test.mjs` | 九列定义与宽度合计 100%；筛选查询串；数量显示（尾零/负数/空颜色）；口径说明文案含三条规则；打印件筛选行文案 |
| Web 组件测试 | `apps/web/test/procurement-warehouse-report.test.tsx` | 首屏取数路径与参数；表格九列与数字格式；负值标红；导出打 `export.xlsx` 且带筛选参数；打印弹窗内容与 `window.print`；空数据不打印；接口失败显示可重试错误态 |
| 视觉验证 | `.agent/verify/procurement-warehouse-report-visual-check.mjs`（Playwright + `page.route` mock） | 真实 Chromium 下九列渲染、无横向溢出、打印弹窗、`emulateMedia('print')` 后只剩纸面、`page.pdf()` 为 A4 横向（MediaBox 宽 > 高）；截图存 `docs/test/results/procurement-warehouse-report/` |

## 6. 非目标

- 不做分页 / 不做「按筛选批量打印」；
- 不做成本金额、不做供应商维度列（供应商筛选也不做：一行是订单×物料，供应商在明细行上，加进来会出现「同一订单同一物料两个供应商」的拆行歧义，等用户确认真实需要）；
- 不加新数据库表、不加迁移：全部从既有事实表聚合；
- 不改库存余额、不写任何事实。

## 7. 实施边界（写给实现者）

- 后端只动 `apps/api/src/modules/reports/`（新增 `procurement-warehouse-report.service.ts`、`procurement-warehouse-report-export.service.ts`，必要时新增纯函数文件 `procurement-warehouse-report.domain.ts`）与 `apps/api/test/unit/`；**不要动**既有 5 张报表的输出字段（`reports.service.ts` 的输出顺序被既有测试钉住）。
- 前端只动 `apps/web/app/reports/`、`apps/web/components/reports/`（新目录）、`apps/web/lib/`、`apps/web/test/`、`apps/web/app/globals.css`（只追加本报表样式与打印规则）。
- `apps/web/app/globals.css` 的 `@media print` 里 `body * { visibility: hidden }` 是全局规则：新纸面必须加进可见清单，否则打印一张白纸。
- 查询性能：按 SRS「复杂报表 ≤ 3 秒」，聚合优先在数据库侧（`groupBy`），禁止按行循环查库；若某步只能 `findMany`，在代码注释里写明数据量上界。

## 8. 未确认 / 留待后续（不改本轮实现）

| 事项 | 当前处理 | 需要谁确认 |
| --- | --- | --- |
| 草稿采购单是否计入「采购数量」 | **不计**（草稿不是下单承诺；已取消也不计） | 用户/采购负责人：若要看「建了单还没下单」，可加一列或加筛选 |
| 日期范围筛选 | 不做（四个日期口径不同） | 用户：要按哪个日期看 |
| 供应商维度 | 不做 | 用户：是否真的需要按供应商拆行 |
| 报废是否算「领用」 | 不算（单独在库存量里体现减少） | 生产/仓库：若要看「损耗率」应做单独的损耗报表 |
| 跨订单借用物料（A 单买的料被 B 单领用） | 按单据各自订单号归集，不做抵消；库存量是物料级结存 | 用户：是否需要「订单专属可用量」——那要新建订单库存账，与仓库模块 §2 冲突，需专门设计 |

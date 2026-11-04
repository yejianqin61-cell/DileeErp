# 采购与仓储报表（`/reports/procurement-warehouse`）独立验证报告

- 日期：2026-11-04
- 验证人：verifier（独立验证；**未改任何源码**，只写 `.agent/verify/` 与 `docs/test/results/procurement-warehouse-report/`）
- 被验对象：设计文档 [`docs/design/procurement-warehouse-report-2026-11-04.md`](../../docs/design/procurement-warehouse-report-2026-11-04.md) 对应的前后端实现
- 结论：**通过**（以最终工作区代码为准）
  - 真实 Chromium 视觉/交互：**88/88 条断言通过**，console error **4**（全部是故意注入 422/500 时浏览器对失败 HTTP 的资源级日志；正常路径 0），pageerror **0**；
  - 打印横向硬证据：`page.pdf()` **1 页**、`MediaBox = 841.91998 × 594.95996 pt`（A4 横向，允许 ±3pt）；
  - 导出件独立核验：**27/27**；后端口径行为复核：**34/34** + 3 条「单测加固性探针」全部能抓住对应实现错误；
  - 独立重跑单测：`procurement-warehouse-report.test.cjs` **36 tests / 36 pass / 0 fail**；`reports-service.test.cjs` **28 / 28 / 0**；
  - 验证过程中发现**两个打印缺陷**（A4 横向未生效、纸面数字格被 `display:block` 打散），Lead 修复后**复验通过**，修复前/后对照见 §4。

> 说明：本报告分两段——先跑出「修复前」的失败证据，Lead 修复后按同一脚本全量重跑得到上面的最终数字。文中的实测值均来自**最终代码**的那一次全量运行；修复前的数字单独标注。

## 1. 截图台账（绝对路径）

| 截图 / 文件 | 证明什么 |
| --- | --- |
| `C:\Users\USER\Desktop\Dilee\docs\test\results\procurement-warehouse-report\desktop-detail.png` | 桌面 1440x900 首屏：九列表头/11 行、数字无尾零、`-545` 红字、行数「共 11 行」、无横向溢出 |
| `...\print-dialog.png` | 打印预览弹窗：公司名 + 标题 + 筛选/行数/打印时间副标题 + **九列对齐的 11 行纸面** + 口径说明（修复后） |
| `...\print-media.png` | `emulateMedia({media:"print"})` 后**只剩纸面**（页头/筛选/口径面板/整个 app-shell 不可见），纸面九列一行一格 |
| `...\print-media-before-fix.png` | **修复前**的打印媒体纸面（由修复前真实 `page.pdf()` 的第 1 页渲染）：数字竖着叠成一列、后 4 列挤出纸外 —— 缺陷 2 的对照证据 |
| `...\print-preview.pdf` | `page.pdf({preferCSSPageSize:true})` 的真实产物：**1 页**、`/MediaBox [0 0 841.91998 594.95996]`（A4 横向） |
| `...\mobile.png` | 窄屏 390x844：页面无横向溢出（观察项见 §5.b） |
| `...\empty.png` | 空态：空态文案 + 「共 0 行」 |
| `...\error.png` | 错误态 422：页面显示后端原文（含「5000」）+ 「重新加载」按钮 |
| `...\采购与仓储报表-样例.xlsx` | 从 `dist` 真实 `exportWorkbook()` 导出的 xlsx（11 行真实数据） |
| `...\采购与仓储报表-样例.pdf` / `.png` | LibreOffice 渲染导出件（PDF + PNG），证明 xlsx 打开后长什么样 |
| `...\print-dialog.png`、`print-media.png` 之外的 6 张截图 | 见上（desktop-detail / mobile / empty / error / print-preview / before-fix） |

结果 JSON（原始数字）：
- `.agent/verify/procurement-warehouse-report-results.json`（视觉/交互，88 条断言 + 全部请求日志 + MediaBox）
- `.agent/verify/procurement-warehouse-report-export-results.json`（xlsx 导出件，27 条）
- `.agent/verify/procurement-warehouse-report-caliber-probes.json`（口径行为复核 34 条 + 3 探针）
- `.agent/verify/_print-landscape-probe.json`、`_print-landscape-page-probe.json`、`_print-landscape-page-probe2.json`（打印横向根因探针）
- `.agent/verify/_node-test-procurement-warehouse.log`、`.agent/verify/_node-test-reports-service.log`（单测原始输出）

## 2. 实测数字

### 2.1 断言与控制台（最终代码）

| 场景 | 视口 | 断言 | console error | pageerror |
| --- | --- | --- | --- | --- |
| desktop-detail（首屏/九列/数字/布局/查询/导出/打印/打印媒体） | 1440x900 | **54/54** | 0 | 0 |
| error（422 后端原文 + 重试） | 1440x900 | **7/7** | 3（故意注入 422 的资源日志） | 0 |
| desktop-export-failure（导出 500） | 1440x900 | **5/5** | 1（故意注入 500 的资源日志） | 0 |
| empty（空态 + 不弹窗/不发请求） | 1440x900 | **10/10** | 0 | 0 |
| mobile | 390x844 | **6/6** | 0 | 0 |
| reports-entry（`/reports` 入口） | 1440x900 | **6/6** | 0 | 0 |
| **合计** | | **88/88** | **4（全部为故意注入的失败 HTTP 资源日志；正常路径 0）** | **0** |

- 全部 6 个场景导航均 **HTTP 200**；dev server 编译期并发导致白屏的次数：0（脚本内置「首次不就绪自动 reload 一次」的兜底，但最终一轮 `reloadsDueToServerChurn` 全为 0）。
- 首屏取数请求路径恰为 `/api/v1/reports/procurement-warehouse`（无查询串）；dev 下 React StrictMode 令首屏 effect 跑两次，两次都无参数（不是数据错误）。

### 2.2 九列与数字显示（桌面首屏）

| 指标 | 实测 |
| --- | --- |
| 表头（顺序） | `订单号 / 物料名称 / 颜色 / 单位 / 采购数量 / 采购入库量 / 采购未入库数 / 生产领用数量 / 库存量` |
| 表格行数 / 每行单元格 | **11 行 / 每行 9 格**；第 1、3、7、11 行**九列全字段**与用户截图原表逐字一致（含第 11 行 `4700 / 0 / 4700 / 0 / 0`） |
| 尾零 | 55 个数量格里 **0 个** `4700.0000` 形态（`trailingZeroTexts=[]`） |
| 负数标红 | 第 3 行「库存量」= `-545`，带 `.status-error`，computed color `rgb(180, 35, 24)`（普通数字 `rgb(23, 32, 51)`） |
| 非负不标红 | 第 2 行「采购未入库数 70」、第 11 行「采购未入库数 4700」均**不带** `.status-error` |
| 行数文案 | `共 11 行（单次最多 5000 行，超出请按订单号或物料缩小范围）` |

### 2.3 布局

| 视口 | 指标 | 实测 |
| --- | --- | --- |
| 1440x900 | `documentElement.scrollWidth - innerWidth` | **0**（1440 − 1440） |
| 1440x900 | 九列实际宽度 px | `99.7 / 288.1 / 88.6 / 66.5 / 99.7 / 110.8 / 121.9 / 121.9 / 110.8`（无 0 宽列） |
| 1440x900 | 九列左/右边界 | `282 → 1390`，全部在视口内（right ≤ 1440） |
| 390x844 | `scrollWidth - innerWidth` | **0**（390 − 390）；表格 11 行仍在 |
| 390x844 | 表格容器 clientWidth/scrollWidth | `90 / 90`（见 §5.b 观察项：9 列被压到约 10px/列，无内部横滑） |

### 2.4 查询 / 导出（请求 URL 实测）

| 操作 | 实测 URL |
| --- | --- |
| 输入订单号 `260119` + 物料 `伞` → 点「查询」 | `http://127.0.0.1:3111/api/v1/reports/procurement-warehouse?order_no=260119&material=%E4%BC%9E` |
| 点「重置」 | `http://127.0.0.1:3111/api/v1/reports/procurement-warehouse`（无查询串） |
| 点「导出 Excel」（已应用筛选 = 260119/伞） | `.../api/v1/reports/procurement-warehouse/export.xlsx?order_no=260119&material=%E4%BC%9E` |
| 导出成功 toast | `操作成功 / 已导出 11 行采购与仓储报表` |
| 导出接口 500 | toast `操作失败 / 导出失败：测试注入的 500`，表格仍 11 行、页面不崩 |

### 2.5 打印：弹窗、打印媒体、PDF（唯一硬证据）

| 指标 | 实测（修复后） | 修复前对照 |
| --- | --- | --- |
| 弹窗 `report-print-dialog` | 可见，rect `1240 × 720`（视口内居中） | 同 |
| 纸面内容 | 公司名 `厦门迪礼伞业有限公司`、标题 `采购与仓储报表`、`procurement-warehouse-sheet-row` **11 行** | 同 |
| 副标题 | `筛选条件：订单号：260119；物料：伞　行数：11 行　打印时间：2026-11-04 23:03:40（北京时间）` | 同 |
| `window.print` 调用（initScript 覆盖计数） | **1** | 1 |
| 打印是否额外取数 | **否**（取数请求数 3 → 3，纸面数据 = 屏幕数据） | 否 |
| `emulateMedia(print)` 后 | sheet `visibility=visible / position=static / display=grid`；`.page-header` `visibility=hidden`；筛选面板 `hidden`；口径面板 `hidden`；`.app-shell` `display=none`；`body/html` 的 `page = procurement-warehouse`；sheet rect `1100 × 584.5px` | sheet `position=absolute`、body/html `page=auto` |
| **`page.pdf()` MediaBox** | **`841.91998 × 594.95996 pt`**（宽 > 高；与 842×595 差 0.08 / 0.04pt） | **`612 × 792 pt`（Letter 纵向）** |
| **PDF 页数（11 行 + 口径说明）** | **1 页**（146016 bytes） | **2 页**（147154 bytes） |
| 纸面表格几何 | `<table>` `table-layout=fixed`；第 1 行 9 个 `<td>` 全部 `display=table-cell`，left 严格递增（170.5 → 1159.5），同一 top（260.5）；行高 `[23, 37, 23]px`（长物料名折行 37px） | `<td class="procurement-warehouse-num">` 带 `display:block` → 数字叠成一列、后 4 列挤出纸外、行高被撑大、sheet 高 1624px → 2 页 |

PDF 原始串：`/MediaBox [0 0 841.91998 594.95996]`（单页）；生成选项 `{ preferCSSPageSize: true, printBackground: true }`（`preferCSSPageSize` 是让 CSS `@page` 生效的必要条件）。产物：`docs/test/results/procurement-warehouse-report/print-preview.pdf`。

### 2.6 导出件独立核验（直接 require `apps/api/dist`，27/27）

脚本 `.agent/verify/procurement-warehouse-report-export-check.mjs`：手写假 Prisma 喂「用户截图 11 行」对应的采购/入库/领用/库存事实 → `ProcurementWarehouseReportExportService.exportWorkbook()`（**dist 真实实现**）→ exceljs 打开真实 xlsx。

| 核验项 | 实测 |
| --- | --- |
| 工作表 | 1 个，名字 `采购与仓储报表` |
| 第 3 行表头 | `订单号 / 物料名称 / 颜色 / 单位 / 采购数量 / 采购入库量 / 采购未入库数 / 生产领用数量 / 库存量`（同名同序） |
| 数据行 | **11 行**（第 4–14 行）；11 行逐列数值与截图一致（含 `库存量 -545`、第 11 行 `4700/0/4700/0/0`） |
| 数量单元格类型 | 55 个格 **全部 `typeof === "number"`**，`numFmt = "0.####"`（不是文本） |
| 版式 | `orientation="landscape"`、`paperSize=9`（A4）、`fitToPage=true`、`fitToWidth=1`、`fitToHeight=0`、`horizontalCentered=true` |
| 标题/信息行 | `A1 = 迪礼ERP　采购与仓储报表`；`A2` 含 `订单号包含「260119」/ 全部物料 / 生成时间：2026-11-04 22:48 / 共 11 行（上限 5000 行）` |
| 表尾口径说明 | 第 15 行、合并 `A15:I15`，含 `不跨单位相加`、`不按订单拆账`、`不设合计行`（+ 各列来源一段） |
| 文件名 | `迪礼ERP-采购与仓储报表-20261104224748.xlsx`（北京时间戳）；ZIP 头 `50 4B 03 04` |
| 屏幕=导出 | `report()` 的 JSON 11 行与 xlsx 同一行**逐列相同**（数量字符串无尾零；生成时间同一次取数） |
| 不写库 | 假 Prisma 的写方法一被调用就抛错；27 条断言中「导出过程没有写库」通过 |
| LibreOffice 渲染 | 可用：生成 `采购与仓储报表-样例.pdf` + `.png`（1124×795，肉眼可见 A4 横向一页、九列、`-545` 红字）；不可用时会记录「未渲染」——本机可用 |

### 2.7 单测原始数字（独立重跑，不是引用工程师结果）

| 命令 | tests | pass | fail | duration |
| --- | --- | --- | --- | --- |
| `node --test apps/api/test/unit/procurement-warehouse-report.test.cjs` | **36** | **36** | **0** | 6205.6785ms |
| `node --test apps/api/test/unit/reports-service.test.cjs` | **28** | **28** | **0** | 1528.9783ms |

（原始输出：`.agent/verify/_node-test-procurement-warehouse.log`、`.agent/verify/_node-test-reports-service.log`；两条命令 `exit=0`。）

### 2.8 后端口径行为复核（34/34 + 3 探针）

脚本 `.agent/verify/procurement-warehouse-report-caliber-probes.mjs` 用**按 Prisma where 语义真的过滤**的内存假库（不是「记录调用形状、无视 where」的形状桩）重放设计文档 §1/§2 场景，检查**行为**：

- 11 行逐列与截图一致；订单号数字感知倒序（260119 > 26012 > 2602）；同订单内物料名码位升序；
- 行为级：`draft`/`cancelled` 采购单不出行、`ordered` 计入；入库只算 `posted`（draft/reversed 不计）；领用 = 领料+补料−退料+冲销/撤销净额 = **3120**，报废与无 `rawMaterialMovementLineId` 的事实不计；超收 → 未入库 **-20**；行集 = 三类来源并集、五列全 0 剔除、只有库存不建行；
- 筛选：订单号大小写不敏感包含（`po-260119` → `PO-260119`）、物料名包含、物料编码大小写不敏感（`yl-0` → `YL-001`）、空白串=未筛选；
- 5000 行允许 / **5001 行 422 `REPORT_ROW_LIMIT_EXCEEDED`（details `{row_count:5001,row_limit:5000}`，不截断）**；1 到 5000 行固定 **7 条查询**；
- 库存量 = 余额接口同口径：**11 行逐行一致**（同一批 `inventory_facts` 按（物料,单位）求和；报废仓计入、成品类别不计、软删物料/单位按 0 排除；库存事实里的 `orderNo` 不参与分组）；
- 守卫：真实实现 4 条 `groupBy` 的 where 键全为标量（`deletedAt / purchaseOrderId / materialId / unitId / status / orderNo / sourceType / rawMaterialMovementLineId / inventoryCategory`）；
- 控制器：两条路由路径/GET/方法级 `@RequireAnyModules("procurement","warehouse")`、且都声明在 `@Get(":report/export")` 之前。

**单测加固性探针**（在内存里改坏实现，验证单测断言不是空转；不改任何文件）：

| 探针 | 改坏方式 | 结果 |
| --- | --- | --- |
| P1 草稿采购单不计 | 运行期把 `EFFECTIVE_PURCHASE_ORDER_STATUSES` 追加 `"draft"` | 单测的 `where.status.in` deepEqual 断言会失败、行为级也能看到 draft 行流出 → **能抓住** |
| P2 5001 行 422 不截断 | 运行期把 `PROCUREMENT_WAREHOUSE_ROW_LIMIT` 改成 6000 | `assert.rejects(getStatus()===422)` 因「没有抛错」而失败 → **该断言不是恒真** |
| P3 groupBy 标量守卫 | 让假库把一条 groupBy 的 where 记录成 `{ material: { deletedAt: null } }`（模拟关联过滤实现） | 守卫判为违规键 `inventoryFact.material` → **能抓住「顺手优化回关联过滤」** |

> 空转迹象检查：`采购数量` 那条单测断言的是**查询形状**（`purchaseOrder.findMany` 的 `deletedAt/status` + `purchaseOrderItem.groupBy` 的 `purchaseOrderId in`），如果实现改成「查全量再在 JS 里按状态过滤」，该断言仍会通过——但本实现里状态条件只可能落在这一条查询上（行为级探针也证明 draft/cancelled 真的不出行），风险低、不构成未覆盖缺陷；其余关键断言（5001→422、行集并集/全 0、库存同口径）都是**行为级**而非形状级。

## 3. 口径抽查表（设计文档 §1/§2/§3 逐条核对代码）

| # | 条款 | 代码位置（最终工作区） | 结论 |
| --- | --- | --- | --- |
| 1 | 采购数量 = 已下单采购明细合计；草稿/已取消不计；两张表都未删 | `apps/api/src/modules/reports/procurement-warehouse-report.domain.ts:29`（三个状态）；`...report.service.ts:135-142`（`purchaseOrder.findMany` where `deletedAt:null` + `status.in`）；`:159-168`（`purchaseOrderItem.groupBy` where `deletedAt:null` + `purchaseOrderId in`） | ✅ 行为级 draft/cancelled 不出行、ordered 计入 |
| 2 | 采购入库量 = 已过账原料入库单；草稿与已冲销不计 | `...report.service.ts:170-179`（`rawMaterialInbound.groupBy` where `{deletedAt:null, status:"posted"}`） | ✅ 行为级 posted 4700 计入、draft/reversed 不计 |
| 3 | 采购未入库数 = 采购数量 − 采购入库量，**允许为负**（超收） | `...report.domain.ts:252-258`（`pending = purchase.minus(inbound)`）；`:280-290` 输出 | ✅ 行为级 100/120 → `-20`；11 行数据中 `-545` |
| 4 | 生产领用 = 领料+补料−退料±冲销/撤销过账净额；报废不计；必须来自原料移动单据明细 | `...report.domain.ts:50-56`（五个 sourceType）；`...report.service.ts:182-191`（`sourceType.in` + `rawMaterialMovementLineId:{not:null}` + `orderNo:{not:null}`）；`:258`（`negated()`） | ✅ 行为级 3050+100−50+30−10=3120；`material_scrap` 与无外键事实不计 |
| 5 | 库存量 = 物料+单位当前结存（原料仓+报废仓），物料须 raw_material 且未删、单位未删，**不按订单拆账** | `...report.service.ts:224-243`（`inventoryFact.groupBy by:[materialId,unitId]`，where id 集合 + `inventoryCategory.in`）；`...domain.ts:31-32`；`:245-250,261`（按物料+单位取数） | ✅ 与 `inventory.service.ts:21 rawMaterialBalances` 同口径（见下） |
| 6 | 库存量与 `GET /inventory/raw-material-balances` 一致 | `apps/api/src/platform/inventory/inventory.service.ts:21`（where: `inventoryCategory in [raw_material,scrap]`、`material:{materialType:"raw_material",deletedAt:null}`、`unit:{deletedAt:null}`，按 `materialId|unitId` 求和） vs 报表（先按同样三类条件筛成 id 集合，再 `groupBy(materialId,unitId)` 求和） | ✅ **同一（物料,单位）的求和集合相同**；11 行逐行相等（caliber probe）。补充：报表把范围收窄到「本表行集合」的物料/单位 id，但只影响「要不要算这个键」，不影响「算出来的和」；余额接口会把和为 0 的键过滤掉，报表对存在的行显示 0 —— 无实质差异 |
| 7 | 行集 = 三类来源并集，且五个数量不同时全为 0；库存不参与建行 | `...domain.ts:209-268`（`cells` 只由 purchase/inbound/issue 建；`filter` 五列全 0 剔除）；库存只在填数时按物料+单位取 | ✅ 行为级：只有入库/只有领用出行；领用冲销干净且无库存不出行；只有库存的物料不长行 |
| 8 | 排序：订单号数字感知倒序 → 同订单物料名升序 → 单位升序 | `...domain.ts:140-182`（`tokenize`/`naturalCompare`/`compareOrderNoDesc`，数字段去前导零按长度→逐位比）；`:269-279`（排序链 + 末两级稳定排序） | ✅ 260119 > 26012 > 2602；同订单物料名/单位码位升序 |
| 9 | 筛选：`order_no` 订单号包含（大小写不敏感）；`material` 名称或编码包含（大小写不敏感）；走数据库、不拼可变长 URL | `...report.service.ts:48-68`（trim + `containsInsensitive` + `materialContains` 的 `OR`）；`:135-147`（采购单）；`:170-191`（入库/领用 where）；`:164,176,188`（`materialId in` 收窄） | ✅ 行为级四种情形（订单号/名称/编码/空白）均正确 |
| 10 | 单次最多 5000 行，超过 422 `REPORT_ROW_LIMIT_EXCEEDED`，**不截断** | `...report.service.ts:89-105`（`rows.length > LIMIT` 抛 422 + details）；`...domain.ts:20` | ✅ 5000 行正常、5001 行 422（行为级 + 单测） |
| 11 | 数量一律去无意义尾零；`-0` 输出 `0` | `...domain.ts:124-138`（`toFixed(4)` + 去尾零 + `-0` 归一，大数不走指数）；前端二次收口 `apps/web/lib/procurement-warehouse-report.ts:121-143` | ✅ 单测 12 例 + 行为级 JSON 无尾零 |
| 12 | `groupBy` 不用关联过滤（本机无库，无法证明引擎支持） | `...report.service.ts:116-129`（注释写清原因）；四组 groupBy 的 where 全是标量/id 集合 | ✅ 守卫用例 + 探针 P3 |
| 13 | 路由顺序：静态路由在 `@Get(":report/export")` 之前 | `apps/api/src/modules/reports/reports.controller.ts:44`（`procurement-warehouse`）、`:51`（`.../export.xlsx`）、`:63`（`:report/export`） | ✅ 元数据 + 源码位置均正确 |
| 14 | 方法级权限：`@RequireAnyModules("procurement","warehouse")`；覆盖类级六模块 | `...reports.controller.ts:25`（类级六模块）、`:45`、`:52`（方法级） | ✅ 元数据断言通过 |
| 15 | xlsx 与屏幕**共用同一取数**，不另算一遍；超 5000 同样 422 | `...procurement-warehouse-report-export.service.ts:95-106`（`const result = await this.report.build(filter)`）；`...report.service.ts:75-87` | ✅ 导出核验中「屏幕 JSON 逐行 = xlsx 逐行」+ 导出只调一次 `build` |
| 16 | 既有 5 张报表输出零改动 | `apps/api/src/modules/reports/reports.service.ts`：`git status --porcelain` 与 `git diff` 对该文件**均为空**（未修改）；`reports.controller.ts` 的 diff 为 54 增 2 删，2 行删除只是 import 行（加 `MaxLength`）与 `class ReportsController { constructor(...) }` 一行的展开换行，**既有 5 个 handler 的查询/映射代码一字未动**；`reports.module.ts` 只加了两个 provider | ✅ 零改动（另：`node --test reports-service.test.cjs` 28/28 通过） |
| 17 | 导出件版式：工作表名、第 3 行九列表头、A4 横向 fitToPage、数量数值单元格、标题、表尾口径说明、文件名 | `...procurement-warehouse-report-export.service.ts:18`（表名）、`:27-45`（九列宽/数值列）、`:108-120`（pageSetup）、`:146-177`（数值写入 + `0.####`）、`:69-75`（口径说明）、`:100-105`（文件名） | ✅ 27/27 条断言（exceljs 打开真实 xlsx 核验） |

## 4. 验证中发现的两个打印缺陷（Lead 已修复，本报告复验）

验证前段（约 22:53–22:59）在**修复前代码**上全量跑出 2 条硬失败，并进一步做了根因定位；Lead 修复后按同一脚本重跑 88/88 通过。两轮都以「用户截图 11 行」为数据。

### 缺陷 1：打印不是 A4 横向（实测 Letter 纵向 2 页）

- **现象（修复前）**：`emulateMedia(print)` 后纸面可见、页头隐藏（这些正常），但 `page.pdf({preferCSSPageSize:true})` 的 `/MediaBox` = **`[0 0 612 792]`（Letter 纵向）**，11 行打出 **2 页**；`@page procurement-warehouse { size: A4 landscape }` 完全没生效。
- **定位过程（3 份探针，均只读、不改源码）**：
  1. `.agent/verify/_print-landscape-probe.mjs`：最小页面里「默认 `@page{A4 landscape}`」「命名页 + 文档流」「命名页 + 绝对定位」「只有命名页 + 绝对定位」四种组合 → 前两种 842×595、后两种 612×792/595×842，证明 **Chromium 不给绝对定位的盒子分配命名页**，且 PDF 导出按第 1 页尺寸统一出纸；
  2. `.agent/verify/_print-landscape-page-probe.mjs`：真实报表页面上把 sheet 改成 `position:static` 后仍 612×792 → 说明还有「第一页不是纸面」这层原因（页头/筛选/表格面板虽 `visibility:hidden` 但仍占布局，第 1 页的 `page` 是 `auto`）；
  3. `.agent/verify/_print-landscape-page-probe2.mjs`：在真实页面依次注入 4 种候选修复 → `html{page:…}`、`body{page:…}`、默认 `@page{A4 landscape}`、把纸面前内容 `display:none` **都能打出 841.92×594.96**。根因写成一句话：**命名页挂在 sheet 自己身上 + sheet 绝对定位 + 前面的界面用 visibility 隐藏（保留布局）**，三者叠加导致第 1 页按默认纸张（Letter 纵向）出纸。
- **修复（Lead，`apps/web/app/globals.css` @media print）**：纸面改成 `position: static` 走文档流；`html:has(.procurement-warehouse-sheet), body:has(.procurement-warehouse-sheet){ page: procurement-warehouse }`（用 `:has` 限定只有本报表纸面存在时生效，避免凭证/出库单被横过来）；`body:has(.procurement-warehouse-sheet) .app-shell{ display:none }`（不用 visibility，避免空白页）；删掉 sheet 自己身上的 `page`；旧浏览器 `@supports not selector(:has(*))` 回退到原来的绝对定位纵向打法。位置：`globals.css:733-759`（尤其 `:753-755`）。
- **复验（最终代码）**：`emulateMedia(print)` 下 sheet `visibility=visible / position=static / display=grid`、`.app-shell display=none`、`body/html page=procurement-warehouse`；`page.pdf()` = **1 页**、`MediaBox 841.91998 × 594.95996` → 通过。

### 缺陷 2：纸面数字格被 `.procurement-warehouse-num { display:block }` 打散（数字竖叠、后 4 列挤出纸外、3 页）

- **现象（修复前）**：打印弹窗/打印媒体里，纸面表头九列正常，但数据行只有「订单号/物料名称/颜色/单位」四个格，五个数字列被挤进**一格**并**每行数字竖着叠**（`4700/4700/0/3050/1650` 各占一行），行高被撑到 ~5 倍，sheet 高 **1624px** → 11 行打 **3 页**、后 4 列跑出纸外。`print-media-before-fix.png` 即该缺陷的截图证据。
- **根因**：纸面数字格是 `<td class="procurement-warehouse-num">`，而该类在 `globals.css:1200` 是给屏幕 `<span>` 用的 `display:block`；`block` 把 `<td>` 从表格布局里摘出来。
- **修复（Lead，`apps/web/components/reports/procurement-warehouse-print-sheet.tsx:62`）**：改成 `<td><span class="procurement-warehouse-num">…</span></td>`（文件头 `:24-25` 写明「该 class 只能挂 span，不能挂 td」）；`apps/web/test/procurement-warehouse-report.test.tsx` 加了守卫用例。
- **复验（最终代码）**：纸面第 1 行 9 个 `<td>` 全部 `display=table-cell`、left 170.5→1159.5 严格递增且同 top（260.5）、行高 `[23,37,23]px`；sheet 1100×584.5；PDF **1 页**。截图 `print-dialog.png` / `print-media.png` 可见九列一行一格。

> 修复只动前端（`apps/web`），后端与导出件未变；导出件核验（27/27）在修复前后都跑过，结论不变。

## 5. 失败项与复现方式

### 5.a 最终代码：**无失败项**（88/88 + 27/27 + 34/34 + 36/36 + 28/28；console error 4 条全部为故意注入 422/500 的资源日志）

历史失败项（已修复，保留复现命令，防止回归）：

```powershell
# 1) 起 dev server（不要跑 next build —— 会与并发会话冲突）
npm run dev --workspace=@dilee/web -- -p 3111
# 2) 打印横向 + 纸面九列的主回归（任一失败会 exit code 1）
node .agent\verify\procurement-warehouse-report-visual-check.mjs
# 3) 只跑打印横向根因探针（需要 3111；会打印 4 种候选修复的 MediaBox）
node .agent\verify\_print-landscape-page-probe2.mjs
# 4) 导出件 / 口径 / 单测
node .agent\verify\procurement-warehouse-report-export-check.mjs
node .agent\verify\procurement-warehouse-report-caliber-probes.mjs
node --test apps/api/test/unit/procurement-warehouse-report.test.cjs
node --test apps/api/test/unit/reports-service.test.cjs
```

- 回归判据：`print-preview.pdf` 的 `/MediaBox` 必须是 `841.9×594.9`（宽>高）且 **1 页**；`print-dialog.png` 里数据行必须是九格同行；`.agent/verify/procurement-warehouse-report-results.json` 的 `summary.failed` 必须为 0。

### 5.b 非阻塞观察项（未按验收断言计失败，供产品/后续决定）

1. **390x844 窄屏可读性**：页面**无横向溢出**（scrollWidth 390 = innerWidth 390，验收项通过），但 ERP 侧栏在 390px 仍占 232px，主区只剩约 158px，9 列表格容器只有 **90px**（每列约 10px，单元格一字一行；`tableWrap 90/90` 无内部横滑）。这与全站窄屏行为一致（只有 `/business-query` 专门隐藏侧栏），不是本表新增回归；若要求手机上可读，需要给宽表加 `min-width` 走容器内横滑或隐藏侧栏。
2. **导出的 xlsx 在 LibreOffice 里「口径说明」那一行的行距略挤**（合并单元格按 `rowHeightFor` 估算，LibreOffice 字体回退与 Excel 度量不同）；Excel 内正常。属渲染环境差异，记录不判失败。
3. 打印 API 依赖 `page.pdf({preferCSSPageSize:true})` 才能让 CSS `@page` 生效；浏览器「打印/另存 PDF」走的是同一打印管线，但用户在系统打印对话框里手动改纸张会影响结果——这是浏览器行为，不是实现缺陷。

### 5.c 验证过程的环境性故障（记录，非实现缺陷）

- dev server 运行期间，**同一 checkout 的另一个会话在跑 `vitest run` 并启动过一次 `next build`**（实测 PID 9548，22:57 启动后结束；`vitest` 22:41 起仍在跑），导致 `apps/web/.next` 被并发重写：dev server 报
  `ENOENT: no such file or directory, open '...\apps\web\.next\routes-manifest.json'` / `prerender-manifest.json`，页面 500/白屏（一次 180s 断言超时）。
- 处理：按环境约定**只重启 dev server**（未清理 `.next`、未改源码；`npm run dev --workspace=@dilee/web -- -p 3111` 重启后恢复 200），并在脚本里加「首次页面不就绪自动 `reload()` 一次」的兜底。最终一轮 6 个场景 `reloadsDueToServerChurn` 全为 0，说明复跑时 `.next` 冲突未再发生。
- 未跑 `next build`（遵守环境约束）；未执行任何 `git add/commit/stash`；`apps/api/dist` 只读（后端在 22:49:56 重新构建过 dist，B/C 核验在 22:47 与 23:05 各跑一次，结论一致）。

## 6. 复现步骤（完整命令）

```powershell
# 0) 前置：本机无 PostgreSQL/docker —— 本验证不需要数据库，全部走 page.route mock
cd C:\Users\USER\Desktop\Dilee

# 1) 起前端 dev server（端口 3111；不要跑 next build）
npm run dev --workspace=@dilee/web -- -p 3111
#    等 dev server 打印 Ready（或访问 http://127.0.0.1:3111/reports/procurement-warehouse 返回 200）

# 2) A. 真实 Chromium 视觉/交互验证（6 场景、88 条断言、截图 + PDF + results.json）
node .agent\verify\procurement-warehouse-report-visual-check.mjs

# 3) 关掉 dev server（验证脚本不负责关；Ctrl+C 或结束该 node 进程），确认端口释放
Get-NetTCPConnection -LocalPort 3111 -State Listen -ErrorAction SilentlyContinue

# 4) B. 导出件独立核验（不需要 dev server；require dist + 假 Prisma + exceljs；含 LibreOffice 渲染）
node .agent\verify\procurement-warehouse-report-export-check.mjs

# 5) C. 后端口径行为复核 + 单测加固性探针（不需要 dev server）
node .agent\verify\procurement-warehouse-report-caliber-probes.mjs

# 6) 独立重跑两条单测（dist 已构建）
node --test apps/api/test/unit/procurement-warehouse-report.test.cjs
node --test apps/api/test/unit/reports-service.test.cjs

# 7) （可选）打印横向根因探针（第 2、3 个需要 dev server + 真实页面）
node .agent\verify\_print-landscape-probe.mjs
node .agent\verify\_print-landscape-page-probe.mjs
node .agent\verify\_print-landscape-page-probe2.mjs
```

产物与脚本（均在仓库内、不改源码）：
- `.agent/verify/procurement-warehouse-report-visual-check.mjs`（A：视觉/交互）
- `.agent/verify/procurement-warehouse-report-export-check.mjs`（B：导出件）
- `.agent/verify/procurement-warehouse-report-caliber-probes.mjs`（C：口径行为 + 探针）
- `.agent/verify/_print-landscape-probe.mjs`、`_print-landscape-page-probe.mjs`、`_print-landscape-page-probe2.mjs`（打印横向根因定位）
- `docs/test/results/procurement-warehouse-report/`（截图、`print-preview.pdf`、样例 xlsx/pdf/png）
- 结果 JSON：见 §1 末尾

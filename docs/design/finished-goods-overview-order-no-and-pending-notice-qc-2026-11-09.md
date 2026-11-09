# 成品出库总览「按订单号明细」+ 成品质检「待送检（成品入库通知）」队列

- 日期：2026-11-09（下午）
- 用户原话（两条，原文照录）：
  1. 「用户反馈，成品出库总览明细表单那边要有订单号」
  2. 「生产包装工序完成后提交成品入库通知，进入到成品质检，成品质检页面没有显示这条记录」

## 0. 现场事实（先查清楚"没有显示"是什么）

### 需求 2 不是显示 bug

只读查了线上库（`dilee_erp`，2026-11-09 15:20 前后）：

| 成品入库通知 | 订单号 | 状态 | 通知量 | 送检单数 |
| --- | --- | --- | --- | --- |
| FGN-20261109-0766EB38 | DL260135 | pending（待送检） | 88 | **0** |
| FGN-20261109-4CE7144C | DL260135 | pending | 100 | **0** |
| FGN-20261109-47518A3F | DL260119 | pending | 180 | **0** |
| 之前 7 张 | … | completed | … | 各 1 张（2026-11-07 及更早） |

根因：**成品入库通知不是成品送检单**。`/qc/finished-goods` 页面的「待质检（全部订单）」列表
（2026-11-07 新增，T24）只列 `finished_goods_inspection_submissions` 里 `submitted` / `inspecting`
的行；通知发出后不会自动变成送检单，旧流程必须在「订单详情 → 成品来源」里点「创建送检」（草稿），
再点「提交送检」，才会进队列。线上这 3 张通知两步都没做，所以页面上一条都看不到 —— 数据在库里，
只是没有入口把「还没送检的通知」列出来。

### 需求 1 的落点

全站只有一处「成品出库总览」：`/sales/finished-goods`（`components/sales/finished-goods-overview.tsx`），
数据来自 `GET /sales-orders/finished-goods-summary`。它当时只有一张**按「产品 + 单位」汇总**的表
（产品 / 单位 / 全部成品数 / 已出库数 / 未出库数 / 生产单数），**没有订单号，也没有任何明细表**。
用户说的「明细表单」就是这张总览表：他要的是能按订单号看到每个订单/每张生产单的数。
两条需求各选了推荐方案（见下），提交前经用户确认。

## 1. 需求 1：总览表下方新增「按订单号明细」表

### 1.1 口径

- 汇总表**一个字不改**（仍按产品 + 单位分行，不同单位不做合计）；
- 汇总表下方新增「按订单号明细」，**一行 = 一张生产单**，列：订单号 / 生产单号 / 产品 / 单位 /
  全部成品数 / 已出库数 / 未出库数；
- 两份数据来自同一个接口、同一次 `groupBy`（入库/出库合计只查一次），所以「明细逐行相加 = 汇总行」
  永远成立，前端不做任何加减（与全站「数量口径只在服务端算一份」一致）。

### 1.2 为什么不在汇总表上加一列订单号

「产品 + 单位」一行可能由同一产品的**多张销售单**折成（线上 `50cm*6k 三折手开伞` 就同时出现在
DL260135 与 DL260136）。一格里塞多个订单号既看不出哪个量属于哪张单，也没法按订单排序；
而明细一行一张生产单，订单号与数量是一一对应的。

### 1.3 API 变更（只加不改）

`FinishedGoodsOutboundNoticeService.overview()`：

- `productionOrder.findMany` 的 `select` 补 `orderNo` / `productionOrderNo`；
- 返回值新增 `details: Array<{ order_no, production_order_no, product_name, unit,
  inbound_quantity, outbound_quantity, unshipped_quantity }>`；
- `details` 按「订单号 → 生产单号」排序；`unshipped_quantity` 与汇总行同一套下限保护（不为负）；
- 没有生产单时返回 `{ production_order_count: 0, groups: [], details: [] }`（形状稳定，不返回 `undefined`）。

### 1.4 Web

`components/sales/finished-goods-overview.tsx`：

- 新增 `FinishedGoodsOverviewDetail` 类型与明细 `DataTable`，标题「按订单号明细」；
- 两张表分别套 `data-testid="finished-goods-overview-summary"` / `finished-goods-overview-detail` 容器：
  两张表的表头有重名（全部成品数 / 已出库数 / 未出库数），测试与验收脚本按容器取表，不靠"表头唯一"猜；
- `details` 按**可选字段**处理（`details ?? []`）：旧后端/接口替身不返回它时明细给空态，
  汇总表照常渲染，不把整页变成错误态；
- 两张表都补了带依据的列宽（合计各 100%），注释写在 `COLUMN_WIDTH` 上方。

## 2. 需求 2：成品质检页新增「待送检（成品入库通知）」队列 + 一键送检

### 2.1 行集

`GET /finished-goods/qc/sources`（面板本来就在用，不新增请求）里
`source_type = finished_goods_inbound_notice` 的行 —— 后端只返回**还有可送检量**
（`available_quantity = 通知量 − 已送检量 > 0`）且未取消的通知。按「先通知先送」排：
通知日期升序，同日按通知单号升序。外加工回厂来源不进这张表（它走成品回厂交接）。

### 2.2 列（T25，9 业务列 + 审计两列 = 84% / 16%）

| 列 | 内容 | 宽度 |
| --- | --- | --- |
| 入库通知 | `notice_no`（FGN-…） | 10% |
| 订单号 | `order_no` | 8% |
| 生产单 | `production_order_no` | 9% |
| 成品 | `product_name / product_specification` | 18% |
| 通知数量 | `notice_quantity + 单位` | 7% |
| 待送检 | `available_quantity + 单位` | 7% |
| 通知日期 | `notice_date` | 8% |
| 状态 | 中文：待送检 / 部分送检 | 7% |
| 操作 | 「送检」按钮 | 10% |

状态词不用英文原值（T22/T23 的历史缺陷：`draft`/`submitted` 直接漏到界面），本表用
`pendingNoticeStatusLabel()` 映射成中文；质检队列的状态词（T24）沿用未变。

### 2.3 一键送检的实现（为什么不自动送检）

- **不自动**：通知是生产侧"这批可以送检了"的声明，送检量由仓库决定（可以先只送一部分）。
  自动建单还会让"先送一部分"失去入口，并把历史通知的补送变成隐式行为；
- 行内「送检」= `POST /finished-goods/inspection-submissions` 带 **`submit: true`**：
  建单与"提交送检"在**同一个事务**里完成（状态直接落 `submitted`），不会留下"草稿建了、提交失败"
  的半成品；数量取该通知的剩余可送检量，服务端仍做超量校验（并发下超量给 422）；
- 成功后 `load()` 刷新，再自动打开「录入成品质检」弹窗并**预选刚建的那一批**：
  弹窗不是 `await load()` 之后立刻开（那时 `submissions` 还是旧闭包，下拉里没有新单），
  而是由一个 `pendingQcOpen` 状态 + `useEffect([pendingQcOpen, submissions])` 等新单真的进了列表再开；
- 送检失败：错误 toast，不打开弹窗、不刷新；按钮在请求期间禁用（防重复点击）。

### 2.4 API 变更

- `SubmissionDto` 新增 `@IsOptional() @IsBoolean() submit?: boolean`；
- `FinishedGoodsQcService.createSubmission`：`status = input.submit ? "submitted" : "draft"`，
  与 `syncFinishedGoodsInboundNoticeStatus` 同事务；
- 审计仍是一条 `finished_goods_inspection_submission.create`，但 details 带上落库后的 `status`；
- 不传 `submit` 时行为与以前完全一致（草稿；订单详情「创建送检 → 提交送检」老路继续可用）。

### 2.5 与 T24 的关系

送检后通知的 `available_quantity` 变 0（或通知变 `partially_inbound` 且剩余量继续显示），
新送检单立刻出现在下方 T24「待质检（全部订单）」里 —— 两段队列分别回答
「哪些通知还没送检」与「哪些送检单还没检完」，不混排：
通知还没有"本次检验数量"，混进 T24 会让已检/待检两列一半是「—」。

## 3. 测试与门禁

| 门禁 | 结果 |
| --- | --- |
| API 全量单测 | **2973 / 2973 pass**（新增：总览 details 断言 + 一键送检全链路 1 条；既有总览用例补 `details` 期望） |
| API 构建 | `npm run build --workspace=@dilee/api` exit 0 |
| Web 构建 | `npm run build --workspace=@dilee/web` exit 0（`/sales/finished-goods`、`/qc/finished-goods` 均正常产出） |
| Web 组件测试 | `finished-goods-qc-panel` / `outbound-notice-pages` / `sales-subpages` 共 **53 / 53 pass**（新增：明细表 2 条、待送检队列 4 条） |
| `npm run typecheck` | api / coding-worker / web 全绿 |

## 4. 部署与线上注意

- **无数据库迁移**：重发 API + Web 即可；
- 部署后线上这 3 张 `pending` 通知（DL260135 两张、DL260119 一张）会立刻出现在成品质检页
  「待送检（成品入库通知）」里，点「送检」即进入待质检队列 —— 不需要补数据；
- 总览页明细依赖新 API：若只发 Web 不发 API，明细表显示空态（汇总不受影响）；
- 本轮**未部署**（按约定需用户批准后再发布）。

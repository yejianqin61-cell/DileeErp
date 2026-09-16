# 任务：销售分批出库通知 + 成品出库总览

## 状态
已完成

## 认领
负责人：全栈 Agent
开始日期：2026-09-16

## 来源需求（用户原话）

> 「销售模块，成品出库这边，支持分批出库。给仓库发出库通知。仓库再选择出库。
> 销售模块还要支持查看当前全部成品数，已出库数，未出库数」

用户对追问的选择：

1. 分批的主动权 —— **销售通知时就能填数量（默认全部可出库，可只通知一部分，余量以后再通知）
   + 仓库再按通知分批实际出库**；
2. 三个数字的位置 —— **销售页顶部给全部销售单合计，打开某张销售单详情再给该单合计与逐生产单明细**；
3. 口径 —— 全部成品数 = 累计成品入库量，已出库数 = 累计已过账/已发出/已签收出库量，
   未出库数 = 全部 − 已出库；**并按「产品 + 单位」分行列**。

设计见 [销售的分批出库通知与成品出库总览](../../design/finished-goods-partial-outbound-and-overview-2026-09-16.md)。

## 目标

- 销售可以对一个生产单**分批发**出库通知（只通知一部分，余量以后再通知），且不会超发；
- 仓库侧保留既有的「自己选择本次出库数量」，与销售的分批通知接成一条闭环链路；
- 销售页能直接看到「全部成品数 / 已出库数 / 未出库数」（模块级按产品+单位，单据级给合计）。

## 关联决策

- **不静默截断**：通知数量超过当时可出库量就 422 并回报可出库量，而不是悄悄按可出库量建单；
- **按数量通知必须指定生产单**：一张通知只对应一个生产单，同一个数量套到多个批次上用户无法预期；
- **三个数字只留一份算法**（`unshippedQuantity`），销售单合计与模块总览共用，避免两处口径漂移；
- **不做跨单位合计**：件 / kg / 套 相加是没有业务含义的数，按「产品 + 单位」分行；
- **退货不计入「未出库」**（用户确认的口径是「全部 − 已出库」），负值夹到 0（显示负数会被当成系统错误）；
- **弹窗失败抛错**（不 toast）：失败时弹窗保留、用户填的数量不丢；
- **仓库侧不改代码**：分批出库在仓库侧本来就成立，本轮只补了断言与链路对接。

## 范围与非范围

**做**：

- `apps/api/src/modules/sales/finished-goods-outbound-notice.service.ts`：`createNotices` 支持
  `notice_quantity`（`parseQuantity` 守卫 + 超量 422 + 必须指定生产单）、新增 `overview()`、
  `summary()` 增加 `totals`、抽出 `unshippedQuantity` / `totalsRow` / `totalsOf`；
- `apps/api/src/modules/sales/sales-orders.controller.ts`：`OutboundNoticeDto.notice_quantity`、
  新增 `GET /sales-orders/finished-goods-summary`（**声明在 `@Get(":id")` 之前**）；
- `apps/web/app/sales/page.tsx`：顶部「成品出库总览」面板（独立加载/错误态/刷新）、
  单据合计行、「通知仓库出库」改成带数量的弹窗；
- 测试：`apps/api/test/unit/outbound-notice-flow.test.cjs`（29 → 38）、
  `apps/api/test/http/sales-orders-contract.test.cjs`（新增路由 + DTO 探针 + 路由顺序护栏）、
  `apps/web/test/outbound-notice-pages.test.tsx`（18 → 21）。

**不做**：

- 仓库页不动（已有「已出库 / 剩余」列与可选数量的建单弹窗）；
- 总览不做搜索/筛选、不做跨订单总计；
- 不做提醒/推送（与待入库通知现状一致）；
- 不动 `FinishedGoodsOutbound` 的表结构（`outbound_notice_id` 与 `shipped_quantity` 早已存在）。

## 验收与验证

1. `test/unit/outbound-notice-flow.test.cjs`（38 条，+9）：
   - 分批通知：部分通知后余量可再通知一次 / 超量 422 且一条通知都不建 / 按数量必须指定生产单 /
     数量入口拒绝 `NaN`·`0`·负数·`1e3`·`0.00004` / DTO 把空串当未填写；
   - 总览与合计：按产品+单位分行且同产品多生产单折成一行 / 无生产单返回空分组 /
     负数下限保护 / 销售单合计 = 明细折算；
2. `test/http/sales-orders-contract.test.cjs`：新增 `GET /finished-goods-summary` 的
   匿名 401、成功信封与字段形状、「必须命中自己的处理器而不是 `:id`」护栏、`notice_quantity`
   的三个 DTO 校验探针；
3. `test/outbound-notice-pages.test.tsx`（21 条，+3）：
   - 顶部总览渲染三个数字与「不跨单位合计」说明、每个数字来自后端返回；
   - 总览加载失败时就地给出错误态与重试、客户池/销售单照常渲染；
   - 分批通知弹窗默认整批可出库量、改成一部分后按该数量发出（请求体含 `notice_quantity`）、
     成功后按服务端返回提示并刷新、余量仍可继续通知；
   - 超量 422 与其它失败：原因显示在弹窗内、弹窗不关、不刷新、不冒充成功。
4. 本机 `tsc --noEmit`（web）与 `nest build`（api）通过。

## 决策记录

- **分批的断点在销售侧**：仓库侧 `createOutboundFromNotice` 早就支持只出一部分、`syncNoticeStatus`
  也按累计出库推导通知状态；缺的是销售只能整批通知。所以本轮把力气花在通知数量上，
  而不是重做仓库的出库单。
- **`notice_quantity` 只在指定生产单时才有意义**：不指定生产单时一次会给多个批次各建一张通知，
  同一个数量套到每个批次上无法解释，所以直接 422。
- **超量报错而不是夹取**：错误信息里带上可出库量，用户改小即可重试。
- **总览用两条 `groupBy` 而不是逐生产单 `aggregate`**：后者是 N+1；总览是模块级视图，
  生产单数量必然比单张销售单大得多。
- **模块级总览给独立错误态**：一张页面上的三个数据源共用一个错误态会让「客户池拉不到」
  看起来像「整页坏了」；总览失败只影响自己那一块。
- **销售单合计由后端折**（不前端 `Number()` 相加）：金额/数量一律字符串往返，
  前端不做浮点累加（与全站口径一致）。
- **弹窗里不放「剩余量」以外的解释**：销售页的说明性文案在第十五轮被明确要求删掉，
  这里只保留数字与去处（「可出库 60 件」而不是「本批次尚可出库数量为 60」）。

## 完成记录

- 新增：`docs/design/finished-goods-partial-outbound-and-overview-2026-09-16.md`、本文件；
- 修改：`apps/api/src/modules/sales/{finished-goods-outbound-notice.service.ts,sales-orders.controller.ts}`、
  `apps/web/app/sales/page.tsx`、
  `apps/api/test/unit/outbound-notice-flow.test.cjs`、
  `apps/api/test/http/sales-orders-contract.test.cjs`、
  `apps/web/test/outbound-notice-pages.test.tsx`；
- 验证：API 单测 **1410 / 1410**（+9）、web 组件 **41 文件 / 767 用例**（+3）、
  web lib 156 条、`tsc --noEmit` 与 `nest build` 通过。
- **未在真实数据库上验证**：`notice_quantity` 落库、`groupBy` 聚合、并发锁，
  以及契约测试（需要 `API_BASE_URL` 与 PostgreSQL，本机都没有）。

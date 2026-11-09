# 2026-11-09（下午）：成品出库总览补订单号明细 + 成品质检「待送检」队列

> 同日另有财务 R2/R3 治理与会计科目类目两批工作（其日志在 `docs/log/2026-11-09.md`、
> `docs/log/2026-11-09-r2-r3-summary.md`，由另一批会话产出，未并入本次提交）。本文件只记本轮两条需求。

## 用户原话

1. 「用户反馈，成品出库总览明细表单那边要有订单号」
2. 「生产包装工序完成后提交成品入库通知，进入到成品质检，成品质检页面没有显示这条记录」

两条都先问清了落点再动手（用户选择：① 总览表下方加「按订单号明细」表；② 待质检队列里也列出
「待送检的成品入库通知」，行内一键送检）。

## 排查结论

- **需求 2 不是显示 bug**。只读查线上库：今天发出的 3 张成品入库通知
  `FGN-20261109-0766EB38`（DL260135，88）、`FGN-20261109-4CE7144C`（DL260135，100）、
  `FGN-20261109-47518A3F`（DL260119，180）状态都是 `pending`、**送检单 0 张**；
  成品质检页「待质检（全部订单）」只列送检单（`submitted` / `inspecting`），通知不自动变送检单，
  旧流程要在订单详情里「创建送检 → 提交送检」两步，两步没做页面上就什么都没有。
- **需求 1 的落点**：`/sales/finished-goods` 的成品出库总览当时只有「产品 + 单位」汇总表，
  `GET /sales-orders/finished-goods-summary` 不返回任何订单号；明细表需要后端补数据。

## 决策（每条都写进设计文档）

1. 汇总表不加订单号列，改为下方新增「按订单号明细」：一行一张生产单，订单号与数量一一对应；
   汇总「产品+单位」行可能由多张销售单折成，塞多个订单号读不出归属。
2. 明细与汇总同源（同一次 `groupBy`），前端不做加减；`details` 在 API 里是**只加不改**的新字段，
   旧响应/替身没有它时 Web 给明细空态、汇总照常。
3. `details` 按「订单号 → 生产单号」排序；`unshipped_quantity` 与汇总行同一套下限保护（不为负）。
4. 触发入库通知后**不自动送检**：送检量由仓库决定（可先送一部分）；新增的是「通知可见 + 一键送检」。
5. 一键送检 = `POST /finished-goods/inspection-submissions` 带 `submit: true`，建单与提交**同一个事务**，
   状态直接 `submitted`，不留"草稿建了提交失败"的半成品；不传 `submit` 行为完全不变。
6. 送检成功后的「录入质检」弹窗不能 `await load()` 后立刻开（旧闭包看不到新送检单），
   改由 `pendingQcOpen` + `useEffect([pendingQcOpen, submissions])` 等新单进列表再开。
7. 待送检队列用 `GET /finished-goods/qc/sources`（面板已有请求，不新增），只留
   `source_type = finished_goods_inbound_notice`，按通知日期 → 通知单号升序（先通知先送）。
8. 两段队列分开：T25「待送检（成品入库通知）」+ T24「待质检（全部订单）」；
   混排会让已检/待检两列一半是「—」（通知还没有本次检验数量）。

## 实现（文件清单）

- API 销售：`apps/api/src/modules/sales/finished-goods-outbound-notice.service.ts`
  —— `overview()` 增 `details`（select 补 orderNo / productionOrderNo，排序与下限保护）。
- API 质检：`apps/api/src/modules/production/finished-goods-qc.service.ts`（`SubmissionInput.submit`、
  create 时按 submit 落 `submitted`、审计 details 带 status）、
  `finished-goods-qc.controller.ts`（`SubmissionDto.submit`）。
- Web 销售：`apps/web/components/sales/finished-goods-overview.tsx`（明细表 + 容器 testid + 两张表列宽）。
- Web 质检：`apps/web/components/qc/finished-goods-qc-panel.tsx`（T25 队列、中文状态词、
  一键送检、pendingQcOpen 时序、列宽注释）。
- 测试：`apps/api/test/unit/outbound-notice-flow.test.cjs`（总览 details 三条断言）、
  `apps/api/test/unit/finished-goods-inbound-chain.test.cjs`（一键送检全链路）、
  `apps/web/test/outbound-notice-pages.test.tsx`（明细表 2 条）、
  `apps/web/test/finished-goods-qc-panel.test.tsx`（待送检队列 4 条）。
- 文档：`docs/design/finished-goods-overview-order-no-and-pending-notice-qc-2026-11-09.md`；
  `docs/design/material-slip-order-no-and-finished-goods-pending-qc-2026-11-07.md` §2.4 补「后续变更」。

## 测试与门禁

| 门禁 | 结果 |
| --- | --- |
| API 全量单测 | **2973 / 2973 pass / 0 fail** |
| API 构建 | exit 0 |
| Web 构建（`next build`） | exit 0（`/sales/finished-goods`、`/qc/finished-goods` 正常产出） |
| Web 组件测试（受影响 3 文件） | **53 / 53 pass** |
| `npm run typecheck` | api / coding-worker / web 全绿 |

## 没做 / 遗留

- 入库通知 → 送检单没有做自动补建（用户选择的是"队列可见 + 一键送检"）；若以后要"通知即送检"，
  在 `create()` 里复用同一条 `createSubmission(..., submit: true)` 即可；
- `GET /finished-goods/qc/sources` 仍是按生产单逐条查通知（面板此前就如此，本轮未改）：
  生产单数量上去后值得改成一次 `findMany` + 内存分组（与 `progressMap` 同一做法）；
- 总览明细暂无导出/打印件：用户只要求页面有订单号，Excel 需求未提出；
- 未部署（按约定需用户批准后发布）。

## 状态

- 本文件与两条需求的代码/测试同批提交；线上未部署、无数据库迁移。

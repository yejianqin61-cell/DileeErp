# T11 Web：采购单页瘦身（去新建/草稿 tab/编辑明细，加退回采购计划）

> 设计依据：[purchase-plan-and-supplier-collapse-2026-09-27.md](../../design/purchase-plan-and-supplier-collapse-2026-09-27.md) §6.3、§2（口径 7/11）
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T05](./05-purchase-order-revert-and-readonly.md)（后端先只读化并给出退回端点）。可与 [T10](./10-web-plan-detail-sheet.md) 并行。
后续 [T14](./14-web-test-migration.md) 依赖它。

## 目标

采购单页**只留凭证该有的东西**：列表（已下单及之后）、导出、到货跟踪、关闭到货、打印字段填写；
把"新建/草稿工作台/编辑明细/下单"整套拿掉，「回到草稿」换成「**退回采购计划**」。

## 口径与决策（依据设计文档）

- **口径 11**：采购单页去掉「新建采购单」、「草稿」筛选 tab、「编辑明细」；「回到草稿」→「**退回采购计划**」；
  **不做**"不建计划直接下单"的旁路 —— 只要存在一条不经过计划的单，计划就不再是权威。
- **口径 7**：数量/单价/供应商的唯一编辑点是计划，采购单页只保留打印字段
  （付款方式 / 交期条款 / 交货地址 / 回签）。
- **§6.3**：删除清单与保留清单（逐条落地）。
- **`orders/page.tsx:139-140` 的注释**是这条的来历（"两个数据源会自相矛盾"）——
  瘦身之后这页不再有两个数据源，**那段注释要一起更新**，别留一段描述已不存在的事实的注释。

## 范围与非范围

**范围**

- `apps/web/app/procurement/orders/page.tsx`：删除入口与状态、加退回动作、更新注释。
- 与 [T14](./14-web-test-migration.md) 的接口：被搬走的测试文件与留在本页的断言，边界写清（见"实施要点 4"）。

**非范围**

- 后端（[T05](./05-purchase-order-revert-and-readonly.md)）。
- 计划页的一切（[T09](./09-web-plans-list-page.md)/[T10](./10-web-plan-detail-sheet.md)）。
- **不把**已下单单的明细编辑挪回来（口径 7 的反面）。

## 交付物

| 文件 | 关键改动 |
| --- | --- |
| `apps/web/app/procurement/orders/page.tsx` | 删：「新建采购单」按钮、草稿工作区 `Sheet`、`草稿` 筛选 tab、`编辑` 按钮、`下单` 按钮；加：「退回采购计划」（原因必填的弹窗，走 `Dialog`/`ActionDialog` 而不是原生 `confirm`）；改：「回到草稿」的文案与调用端点；更新 `:139-140` 一带的注释 |
| `apps/web/app/procurement/orders/page.tsx` | 明细只读后的展示：明细仍在（看得到买了什么），但没有编辑入口 |
| `apps/web/test/procurement-order-print.test.tsx` 等 | 见 [T14](./14-web-test-migration.md)：该文件**不搬迁**，仅其按钮集合断言随本任务改动而更新（本任务只负责让页面本身自洽） |

## 实施要点

### 1. 删除清单（§6.3，逐条）

| 删 | 说明 |
| --- | --- |
| 「新建采购单」按钮 | 新建只能在计划里发生（口径 11） |
| 草稿工作区 `Sheet`（整套） | 它被搬到 [T10](./10-web-plan-detail-sheet.md) 的计划详情 Sheet |
| `草稿` 筛选 tab | 草稿已经不存在（[T01](./01-plan-schema-and-migrations.md) 的搬迁迁移把它们归并成计划） |
| `编辑` 按钮 | 明细只读（口径 7） |
| `下单` 按钮 | 下单只发生在计划的收束预览里 |

> 删的时候连带删：这些入口相关的 state / effect / 请求（例如为草稿工作区加载 BOM 明细与下单状态的那两次请求）。
> **留下一个不用的请求**会让页面上多出无法解释的失败提示。

### 2. 保留清单（§6.3，逐条）

- 列表（只显示**已下单及之后**：`ordered` / `partially_arrived` / `arrived_complete`）；
- 导出（既有采购单打印导出）；
- 到货跟踪（登记到货、批次、关闭到货）；
- 打印字段填写（付款方式 / 交期条款 / 交货地址 / 厂家回签 / 供应商回签 / 主管签字）。

### 3. 「退回采购计划」（口径 15 ③）

- 位置：原来「回到草稿」的按钮位置（交互习惯不变：单行的操作按钮）。
- 弹窗：**原因必填**（空/纯空格 → 前端先拦，后端仍是最终判定）。
- 成功：提示"已退回采购计划（PP-…）"并刷新列表（该单从列表消失 —— 它已是 `cancelled`）；
- 失败：把服务端原因**原样**显示（例如"该单已有到货事实，不能退回"）。

### 4. 与 [T14](./14-web-test-migration.md) 的边界（写清，免得两边互相等）

- **搬到计划页的**：草稿工作区相关（保存草稿/按供应商收束/下单状态列/编辑明细/按 BOM 编辑）。
- **留在采购单页的**：打印字段填写、导出、到货跟踪、**退回采购计划**。
  所以 `procurement-order-print.test.tsx` 里"打印字段 + 导出"那部分**留在本页测试**，
  只把"编辑明细/草稿"相关的断言迁走（见 [T14](./14-web-test-migration.md)）。

### 5. 空态与文案

- 列表为空时给可行动空态：「还没有已下单的采购单：请到【采购 → 采购计划】收束下单」——
  用户刚把入口挪走，空态是第一处会看到的地方。

## 验收与验证

| # | 验收点 | 怎么验 |
| --- | --- | --- |
| 1 | 页面上**没有**「新建采购单」「草稿」tab「编辑」「下单」 | 采购单页用例（[T14](./14-web-test-migration.md) 保留部分） |
| 2 | 明细仍可见（只读），没有编辑入口 | 同上 |
| 3 | 「退回采购计划」在原来「回到草稿」的位置，原因必填 | 同上 |
| 4 | 退回成功后该单从列表消失、计划侧行回到未下单 | 同上 + 后端用例（[T05](./05-purchase-order-revert-and-readonly.md)） |
| 5 | 打印字段仍可填（付款方式/交期条款/交货地址/回签） | 同上 |
| 6 | 导出、到货跟踪、关闭到货仍可用 | 同上 |
| 7 | 空态文案指向采购计划 | 同上 |
| 8 | 没有为已删入口留下"孤儿请求"（网络面板/断言请求列表） | 同上（断言请求集合） |
| 9 | 类型检查 + web 单测 | `npm run typecheck`、`cd apps/web; npm run test:unit` |

## 决策记录

- **删入口而不是隐藏**：隐藏的入口会随着下一次改动"复活"，而它背后已经没有语义了。
- **注释一起更新**：`orders/page.tsx:139-140` 那段解释"两个数据源会矛盾"的注释，
  在瘦身之后描述的事实已不存在；留着会让下一个人以为页面还在同时刷两个来源。

## 完成记录

| 项 | 内容 |
| --- | --- |
| 完成日期 / 提交 | 2026-09-27 / `1362152` |
| 实际交付物（文件 + 条数） | `apps/web/app/procurement/orders/page.tsx`（-604 行改动：去掉「新建采购单」「草稿」tab、「编辑明细」，「回到草稿」→「退回采购计划」）、`apps/web/app/procurement/plans/page.tsx`、`apps/web/test/procurement-order-slimming.test.tsx`（3 条，新建）、`apps/web/test/procurement-order-deeplink.test.tsx`（1 行：搜索框占位符跟着改）；四个源码级约定守卫：`apps/web/lib/refresh-policy.test.mjs`、`apps/web/lib/page-data-alignment.test.mjs`、`apps/web/lib/finance-table-width.test.mjs`、`apps/web/lib/audit-columns-coverage.test.mjs`；**删除** `apps/web/test/procurement-draft.test.tsx`（284 行 / 8 条）与 `apps/web/test/procurement-order-collapse.test.tsx`（400 行 / 14 条） |
| 验证命令与结果 | `npm run typecheck`：双绿；`cd apps/web; npm run test:unit`：lib 284/284、组件 59 文件 1010 条；`procurement-order-slimming.test.tsx` 3/3（本机实测） |
| 与设计的差异（含理由） | ①删掉那两个测试文件而不是改写它们——整篇都在测已经搬走的草稿工作区；**等价覆盖在 T14 的 `apps/web/test/procurement-plans.test.tsx` 里重建**（8 + 14 条的行为改成在 `PlanDetailSheet` 上断言）。②`page-data-alignment` 里采购单页从"两张表"移除、四条主数据加载搬到计划页。③`finance-table-width.test.mjs` 的更新顺带把 T13 那三条通用 CSS 规则也钉住了（**T13 的提交只改了 CSS，断言红到这一次才同步**，见 T13 的完成记录） |
| 未验证项（环境阻断） | 采购单页瘦身后的真实观感（还剩哪些按钮、布局是否空）未目测；页面级用例证不了 CSS 生效 |
| 踩到的坑 | 删测试文件之前先确认"它测的行为在新页面有等价断言"，否则删掉的是覆盖、不是重复——这也是本任务把等价用例留到 T14 补的原因（先删后建中间那一步没有覆盖） |

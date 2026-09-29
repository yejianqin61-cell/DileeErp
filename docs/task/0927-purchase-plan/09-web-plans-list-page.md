# T09 Web：`/procurement/plans` 列表页 + 采购枢纽卡

> 设计依据：[purchase-plan-and-supplier-collapse-2026-09-27.md](../../design/purchase-plan-and-supplier-collapse-2026-09-27.md) §6.1、§2（口径 5/14）
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T02](./02-plan-api-skeleton.md)（列表/候选/新建接口）、[T03](./03-plan-save-and-delete.md)（软删）。
后续 [T10](./10-web-plan-detail-sheet.md)、[T13](./13-web-fixed-table-css.md)、[T14](./14-web-test-migration.md) 依赖它。

## 目标

新增采购计划的入口与列表页：`/procurement/plans`（口径 14 的 9 列，只读列表可 hover 看全文），
并在采购枢纽页加一张卡片。这是采购员每天打开的那一页。

## 口径与决策（依据设计文档）

- **口径 14**：列表 9 列 —— 计划编号 / 销售单号 / **货号** / 客户 / BOM 版本 / 行数 / 未下单行数 /
  状态 / 最后更新（人 + 北京时间）。**不做** Excel 导出。
- **口径 11**：新路由 `/procurement/plans` + 采购枢纽页卡片；每个动作只有一个入口。
- **口径 5**：只读列表要「一次性展示所有 column」+ hover 看全文 → 用 `DataTable` 的
  `meta.width` + `meta.ellipsis`（`components/data/data-table.tsx` 已有支持），
  CSS 生效依赖 [T13](./13-web-fixed-table-css.md) 把 `.data-table-fixed` 从 `.finance-page` 里提出来。
- **口径 2**：新建是"选一张还没有计划的 BOM"（候选接口），**不做**自动生成。

## 范围与非范围

**范围**

- `apps/web/app/procurement/plans/page.tsx`（列表 + 新建入口 + 筛选）。
- `apps/web/app/procurement/page.tsx`（采购枢纽）加一张「采购计划」卡片。
- `apps/web/test/testid-pages.test.ts` 登记 `procurement/plans/page.tsx` → `page-procurement-plans`。
- 列表行的状态徽标（未下单/部分下单/已完成）与「BOM 比计划多 N 个物料」提示（口径 12）。

**非范围**

- 详情/编辑 Sheet（[T10](./10-web-plan-detail-sheet.md)）、CSS 提取（[T13](./13-web-fixed-table-css.md)）。
- 计划 Excel 导出（口径 14 明确不做）。
- 左侧主导航**不变**（采购已经是一个 nav 项，计划是它下面的二级页）。

## 交付物

| 文件 | 关键改动 |
| --- | --- |
| `apps/web/app/procurement/plans/page.tsx` | 新建：`PageHeader`（面包屑 `["采购", "采购计划"]`）+ 筛选（订单号/货号/状态/关键字）+ `DataTable` 9 列 + 新建按钮 |
| `apps/web/components/procurement/plan-create-dialog.tsx` | 新建：选候选 BOM（`GET /purchase-plans/plan-candidates`）→ `POST /purchase-plans` → 成功进详情（由 [T10](./10-web-plan-detail-sheet.md) 提供 Sheet；本任务先跳 `?plan_id=`） |
| `apps/web/app/procurement/page.tsx` | 加「采购计划」卡片（与既有枢纽卡同一套写法） |
| `apps/web/test/testid-pages.test.ts` | 登记新页面 testid |
| `apps/web/app/globals.css` | 只加"计划列表"这一块自己的样式；`table-layout`/省略号**不在这里写**（[T13](./13-web-fixed-table-css.md) 统一提通用规则） |

## 实施要点

### 1. 列表列（口径 14，逐列落地）

| 列 | 数据源 | 宽度（建议） |
| --- | --- | --- |
| 计划编号 | `plan_no`（`PP-…`） | 11% |
| 销售单号 | `order_no` | 11% |
| 货号 | 销售单的 `item_no`（**join 出来，计划表不存**） | 10% |
| 客户 | 销售单客户快照的名称 | 12% |
| BOM 版本 | `bom_version` | 6% |
| 行数 | 明细行数 | 6% |
| 未下单行数 | 未下单行数（**0 时给"—"或"全部已下单"**，别只给 0） | 9% |
| 状态 | 派生三态 | 9% |
| 最后更新 | `updated_at` + `updated_by` 姓名（**北京时间**，走 `lib/audit-time`） | 16% |

- 每列都写 `meta: { width }`；会长的列（客户、货号）再加 `meta: { ellipsis: true }` ——
  `DataTable` 会自动加 `data-table-fixed`（`data-table.tsx` 里 `columns.some(c => metaOf(c.meta).width)` 那段）。
- **不要**在页面里算百分比之外的东西：9 列的宽度之和不必凑 100（只读列表允许自己撑开）。

### 2. 筛选与排序

- 参数直接映射接口（[T02](./02-plan-api-skeleton.md) §列表）：`order_no` / `item_no` / `status` / `q`。
- 默认按"最后更新倒序"（后端默认），前端**不重排**（重排会让"后端已排序"这件事没有单一真源）。
- 筛选用 `lib/fuzzy-search` 的既有语义（多词 AND），**不要**自己写 `includes`。

### 3. 新建流程（口径 2）

1. 点「新建采购计划」→ 拉候选（只有"已确认销售单 + 有 BOM + 还没有未删计划"的 BOM）。
2. 允许按销售单号/货号/客户搜（候选可能很多）。
3. 选一张 → `POST /purchase-plans {bom_id}` → 成功即进详情（行已经带好了，采购员接着填供应商与单价）。
4. 候选为空时给**可行动**的空态：「没有可建计划的 BOM：请先在【采购 → BOM 表】为已确认销售单建 BOM」——
   只说"暂无数据"会让人不知道该去哪。

### 4. 口径 12 的提示

- 行尾或列内提示「这张 BOM 比计划多 N 个物料」（`bom_extra_material_count > 0` 才出现）。
- **不给**"一键同步"按钮：口径 12 明确"不同步、靠人看提示兜"。

## 验收与验证

| # | 验收点 | 怎么验 |
| --- | --- | --- |
| 1 | 页面根 testid `page-procurement-plans` 且已登记 | `apps/web/test/testid-pages.test.ts` |
| 2 | 9 列都在、顺序与口径 14 一致 | 计划页列表用例（[T14](./14-web-test-migration.md) 里写） |
| 3 | 长文本列带省略号（`meta.ellipsis` → `cell-ellipsis` + `title`） | 同上（断言 DOM 类名/title；**观感只能目测**） |
| 4 | 筛选参数与接口一致（订单号/货号/状态/关键字） | 同上（断言请求 URL） |
| 5 | 新建：候选为空给可行动空态；选中后 POST 并进详情 | 同上 |
| 6 | 「BOM 比计划多 N 个物料」只在 N>0 时出现 | 同上 |
| 7 | 「最后更新」显示姓名 + 北京时间，**不显示 UUID** | 同上 |
| 8 | 枢纽页有「采购计划」卡片且指向 `/procurement/plans` | 既有枢纽页用例（[T14](./14-web-test-migration.md) 补） |
| 9 | 类型检查 + web 单测 | `npm run typecheck`、`cd apps/web; npm run test:unit` |

## 决策记录

- **列表页只读、编辑走 Sheet**（与采购单页的草稿工作区一致的交互习惯）：列表要能一眼扫完，
  编辑要能一次看全 13 列，两者塞进同一个视图必然互相牺牲。
- **不在这里写 `table-layout: fixed`**：CSS 统一在 [T13](./13-web-fixed-table-css.md) 提成通用规则，
  这里再写一份会出现"两处规则打架，其中一个静默失效"。

## 完成记录

| 项 | 内容 |
| --- | --- |
| 完成日期 / 提交 |  |
| 实际交付物（文件 + 条数） |  |
| 验证命令与结果 | `npm run typecheck`：｜`cd apps/web; npm run test:unit`： |
| 与设计的差异（含理由） |  |
| 未验证项（环境阻断） |  |
| 踩到的坑 |  |

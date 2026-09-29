# T11 `/reorder` 页面

> 设计依据：[reorder-item-no-and-summary-2026-09-26.md](../../design/reorder-item-no-and-summary-2026-09-26.md) §四.2
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T07](./07-reorder-articles-api.md)、[T08](./08-reorder-article-detail-api.md)、[T09](./09-reorder-documents-and-timeline-api.md)、
[T10](./10-reorder-nav-and-permission.md)、[T06](./06-reorder-web-entry.md)（「以此返单」跳到编辑器）。

## 目标

一屏走完「**查货号 → 看批次 → 看单据**」，并且能从任一批次发起返单。

结构与工作台刻意不同，避免两个页面做同一件事：

| | 工作台 `/` | 返单与总结 `/reorder` |
| --- | --- | --- |
| 轴 | **订单号** | **货号** |
| 回答 | 「这一单现在推进到哪一步、卡在哪」 | 「这个货做过几次、每次多少、QC 怎么样、要不要返单」 |
| 深度 | 模块状态卡 + 阻塞 + 计量 | 批次序列 + 跨批汇总 + **逐张单据** |
| 动作 | 只读 | 只读 + 「以此返单」 |

## 关联决策

- 单据清单在页内列出，跳转只是加速（[T09](./09-reorder-documents-and-timeline-api.md)）。
- 跳转映射集中在一处，API 不拼 URL。
- 前端不重算业务数字（批次汇总、合格率都来自服务端）。

## 范围与非范围

**范围**

- `apps/web/app/reorder/page.tsx` + `apps/web/components/reorder/*` + `globals.css` 相应区块。
- `apps/web/test/reorder-page.test.tsx`。
- 未填货号入口的**入口**（待办表本体在 [T12](./12-reorder-history-backfill.md)）。

**非范围**

- 任何写操作（除「以此返单」跳转）。
- 毛利、交期达成、导出（[T14](./14-reorder-summary-enhancement.md)）。

## 交付物

| 文件 | 改动 |
| --- | --- |
| `apps/web/app/reorder/page.tsx` | 新建：页面骨架、状态机（未选货号 / 已选货号 / 已选批次）、加载三态 |
| `apps/web/components/reorder/article-list.tsx` | 新建：货号列表 + 搜索 + 筛选 |
| `apps/web/components/reorder/article-summary.tsx` | 新建：跨批汇总卡 |
| `apps/web/components/reorder/order-timeline.tsx` | 新建：批次时间线 + 「以此返单」 |
| `apps/web/components/reorder/document-groups.tsx` | 新建：17 组单据清单 + `DOCUMENT_ROUTES` |
| `apps/web/app/globals.css` | 新样式（按既有面板/表格区块风格） |
| `apps/web/test/reorder-page.test.tsx` | 新建（约 12 条） |

## 实施要点

**1. 三个状态（用 URL 参数表达，便于分享与回退）**

- `/reorder`：只显示货号列表。
- `/reorder?item_no=27621`：列表 + 汇总 + 批次时间线。
- `/reorder?item_no=27621&order_no=DL260001-1`：再加上该批的单据清单。

用 `useSearchParams`（照 `apps/web/app/qc/page.tsx` 的写法）。**不要**用内部 state 记选中项——
业务要能把"这个货号的这一批"发给同事。切换货号时要清掉 `order_no`。

**2. 货号列表**

- 搜索框（`data-testid="reorder-q"`）→ `GET /reorder/articles?q=`，**输入防抖 300ms**
  （不防抖会在每敲一个字发一次请求，而这里每次请求要跑聚合）。
- 筛选：客户（下拉，来自既有客户接口）、`含已关闭`（默认勾选）、`含已删除`（默认不勾）。
- 列：货号 / 订单数 / 累计数量（按单位分行展示，例如 `1960 支`）/ 最近下单 / 最近交期 / 客户 / QC 合格率。
- 合格率 `null` 显示 `-`，**不要显示 `0%`**（那是"全部不合格"的意思，两回事）。
- 行点击 → 设 `item_no`。

**3. 汇总卡 + 批次时间线**

- 汇总卡：订单数 / 在制批次数 / 首末下单日 / 数量（分行）/ 采购金额（分行）/ 应收金额（分行）/ QC 合格率与不合格数。
- 时间线：按 `orders` 顺序（服务端已升序）逐批一块，含订单号（可点进销售单编辑页）、客户、
  下单日、交期、数量、状态、该批 QC 与出库数量；右上角两个按钮：
  - 「查看单据」（把 `order_no` 写进 URL，展开第 4 区）
  - 「以此返单」：`router.push("/sales/orders/new?reorder_from_order_no=" + encodeURIComponent(order_no))`；
    `can_reorder === false` 时按钮 `disabled` 并把 `can_reorder_reason` 放进 `title`。
    **不要**自己判断状态——理由由服务端给（[T08](./08-reorder-article-detail-api.md) 实施要点 3）。

**4. 单据清单**

- 17 个分组按 `groups` 顺序渲染，每组一个可折叠块，标题带数量（`采购单（2）`），
  空组显示「未建立」而不是隐藏（口径与工作台的 `missing` 一致）。
- 行内列：单号 / 日期（`date_source === "created_at"` 时日期后加小字「登记时间」）/
  数量+单位 / 状态 / 操作（跳转）。
- **跳转映射一处集中**：

```ts
// apps/web/components/reorder/document-groups.tsx
const DOCUMENT_ROUTES: Record<DocumentType, (doc: Document) => string> = {
  purchase_order: (d) => `/procurement/orders?order_no=${encodeURIComponent(orderNo)}`,   // 依赖 T13
  purchase_receipt: () => `/procurement/orders?order_no=${...}`,
  incoming_inspection: (d) => `/qc/incoming?receipt_id=${encodeURIComponent(d.extra.receipt_id)}`,
  raw_material_inbound: () => `/warehouse/raw-material-storage`,
  production_order: (d) => `/production?order_no=${...}`,
  material_movement: (d) => `/production/material-issues?production_order_id=${...}`,
  operation_daily_report: () => `/production?order_no=${...}`,
  finished_submission: (d) => `/qc/finished-goods?order_no=${...}`,
  finished_qc: (d) => `/qc/finished-goods?order_no=${...}`,
  finished_inbound_notice: (d) => `/warehouse/finished-goods-storage`,
  finished_inbound: () => `/warehouse/finished-goods-storage`,
  finished_defective: () => `/qc?order_no=${...}`,
  finished_outbound: () => `/warehouse/finished-goods-storage`,
  receivable: () => `/finance/receivable`,
  payable_source: () => `/finance/payable`,
  supplier_payable: () => `/finance/payable`,
  bom: () => `/procurement/boms`,
};
```

- 目标页面**当前真正读查询参数的只有** `/production`、`/qc`、`/qc/finished-goods`、
  `/qc/incoming`（`receipt_id`）、`/warehouse/raw-material-storage`（`notice_id`）——
  其余跳转落在一个未筛选的列表上。这是**已知且接受**的（单据本身已在页内列全），
  但按钮文案不要写「查看筛选结果」，写「打开模块页」，别对用户承诺它会筛选
  （[T13](./13-order-deeplink-procurement.md) 会补采购侧；财务侧仍是未筛选）。

**5. 既有组件与口径**

- 表格用 `components/data/data-table.tsx`，空/错/载用 `components/feedback/states.tsx`，
  时间用 `lib/audit-time` 的北京时间格式化，金额/数量直接显示服务端字符串。
- 页面根 `data-testid="page-reorder"`（与 `page-sales`、`page-finance` 同一命名口径）。
- **不要**在页面上加"金额合计"之类的二次计算。

## 验收与验证

| # | 验收点 | 用例 |
| --- | --- | --- |
| 1 | 首屏拉货号列表并渲染 | `reorder-page.test.tsx` |
| 2 | 搜索防抖：连敲 3 个字符只发 1 次请求（假定时器推进） | 同上 |
| 3 | 点击货号 → URL 带 `item_no` 并拉详情 | 同上 |
| 4 | 切换货号会清掉 `order_no` | 同上 |
| 5 | 数量/金额按单位、币种分行展示，不出现跨单位相加 | 同上 |
| 6 | `qualified_rate = null` 显示 `-` | 同上 |
| 7 | 批次时间线按服务端顺序渲染，不二次排序 | 同上 |
| 8 | 「以此返单」跳转 URL 正确且**编码**（含空格/中文的货号或单号） | 同上 |
| 9 | `can_reorder=false` 时按钮禁用且 `title` 显示服务端给的理由 | 同上 |
| 10 | 单据 17 组渲染，空组显示「未建立」 | 同上 |
| 11 | `date_source="created_at"` 的行带「登记时间」小字 | 同上 |
| 12 | 接口失败 → 错误态，且不把上一批的数据留在屏幕上 | 同上 |

命令：`npm run typecheck` → `cd apps/web; npm run test:unit`。

## 决策记录

- **用 URL 参数记选中项**：见实施要点 1（可分享）。
- **跳转文案不承诺筛选**：见实施要点 4。

## 完成记录

（认领后填写。）

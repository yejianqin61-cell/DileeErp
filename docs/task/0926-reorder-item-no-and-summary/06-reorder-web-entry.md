# T06 返单前端：入口、预填与来源提示

> 设计依据：[reorder-item-no-and-summary-2026-09-26.md](../../design/reorder-item-no-and-summary-2026-09-26.md) §四.3、§五
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T04](./04-sales-order-item-no-web.md)（编辑器上有货号字段）、[T05](./05-reorder-create-service.md)（预览与建单口径）。

## 目标

销售点一下「以此返单」就能得到一张**填好工艺口径、留着数量和交期**的新单，并且一眼看得出它从哪张单返来。

## 关联决策

- 已拍板 ③：全带工艺口径、数量/交期必重填、单价照带待复核。
- 设计文档 §四.3：返单来的单顶部显示「由 `DL260001-1` 返单（同货号）」并可跳来源单。

## 范围与非范围

**范围**

- 编辑器支持 `?reorder_from_order_no=<来源单号>`：拉预览、预填、标出必填、顶部横幅。
- 保存时带 `reorder_from_order_no`。
- 编辑既有单时，若该单有来源，显示来源横幅（只读）。
- 测试增补。

**非范围**

- 不做「以此返单」按钮本身（在 [T11](./11-reorder-page.md) 的页面上；本任务把编辑器侧做成能接住的）。
- 不做多来源/合并返单、不做「返单时改客户」的特殊逻辑。
- 不在编辑器里做差异对比视图（preview 的 `copy` 直接预填即可）。

## 交付物

| 文件 | 改动 |
| --- | --- |
| `apps/web/components/sales/sales-order-editor.tsx` | 读 `useSearchParams().get("reorder_from_order_no")`；拉预览；预填；横幅；载荷带来源键；`must_fill` 高亮与提交前校验 |
| `apps/web/app/sales/orders/new/page.tsx` | 确认查询串能透到编辑器（现有实现是 `<SalesOrderEditor />`，若它自己不读 searchParams 则需要在这里传 prop） |
| `apps/web/test/sales-order-editor.test.tsx` | 增补约 6 条 |

## 实施要点

**1. 预填的正确做法**

- 编辑器现在的新建态是 `base` / `spec` / `details` / `materialRefs` 几块本地 state。
  返单预填要**一次性把预览结果灌进这几块**，而不是逐键 set（逐键会因为 React 批处理与
  `setBaseField` 的浅合并写法产生竞态，出现「填了一半」的表单）。
- 实现顺序：`load()` 里若发现 `reorderFromOrderNo`，先 `GET /sales-orders/reorder-preview?order_no=…`，
  拿到 `copy` 后与默认空值合并，再渲染。**加载失败要出错误态**，不要退化成空表单——
  空表单会让销售以为「这单本来就没工艺要求」，直接存下去就是一张缺工艺的单。
- `must_fill` 里的字段（订单号/下单日期/数量/交期）保持空值并在标签后加「（返单必填）」提示；
  保存前的既有校验（`order_no` / 数量）已经会拦住空值，这里只补**可读性**。

**2. 横幅**

- 新建（返单）态：`data-testid="reorder-source-banner"`，文案含来源单号与货号，附「查看来源单」链接
  （`/sales/orders/<来源单 id>/edit`——预览响应里带 `source_order_id`，别让前端再去搜一次）。
- 编辑既有单且 `order.reorderFromOrderNo` 有值时：同一 testid，只读展示，不给「换成别的来源」的入口
  （后端在 [T05](./05-reorder-create-service.md) 已明确 `reorder_from_order_no` 不可更新）。

**3. 载荷**

- 保存时 `reorder_from_order_no: reorderFromOrderNo`（仅新建态带）。
- 货号来自预览的 `item_no` 并预填到 [T04](./04-sales-order-item-no-web.md) 的货号输入框，
  **允许销售改动但要给提示**：改了货号就不再是「同货号返单」，
  提示文案：「改掉货号后，这张单在【返单与总结】里会归到新的货号下」。

**4. `useSearchParams` 的 Suspense 边界**

仓库里客户端页读 `searchParams` 的既有做法见 `apps/web/app/qc/page.tsx`（`useSearchParams` + `useEffect`）。
照它写；**不要**引入 `window.location.search` 直读（构建期的 Suspense 边界问题在若干页面的注释里记着）。

## 验收与验证

| # | 验收点 | 用例 |
| --- | --- | --- |
| 1 | 带 `?reorder_from_order_no=DL260001-1` 时表单被预填（工艺标量 + 明细 + 材料引用） | `sales-order-editor.test.tsx` |
| 2 | 数量/下单日/交期为空，且带「返单必填」提示 | 同上 |
| 3 | 顶部横幅显示来源单号与货号，链接指向来源单 | 同上 |
| 4 | 预览接口失败时是**错误态**而不是空表单 | 同上 |
| 5 | 保存请求体带 `reorder_from_order_no`，且金额三兄弟缺席 | 同上 |
| 6 | 编辑既有单时展示来源横幅，且不改写 `reorder_from_order_no` | 同上 |

命令：`npm run typecheck` → `cd apps/web; npm run test:unit`。

## 决策记录

- **预填一次性灌入**：见实施要点 1。
- **改货号允许但要提示**：销售偶尔要拿老工艺做相似款的新货，硬拦会逼他们手抄一遍整张单。

## 完成记录

**2026-09-26 完成**（提交 `f28a536`）。

- 交付物：编辑器的返单模式（`useSearchParams` → 预览 → 一次性预填）、`ReorderBanner`、
  「返单必填」提示、载荷带 `reorder_from_order_no`、`globals.css` 的两条样式、
  `apps/web/test/sales-order-reorder.test.tsx`（9 条）。
- 与计划的差异：
  1. **`useSearchParams` 放在编辑器里**（不在页面里传 prop）：两个页面
     （`/sales/orders/new`、`/sales/orders/[id]/edit`）本来就已经用 `<Suspense>` 包着编辑器，
     这正是为了让它可以读查询串；再走一层 prop 只是多一次搬运。
  2. **预览失败时整个表单不渲染**（原计划只说"要出错误态"）：
     实测发现错误横幅下面那张空白表单仍然可以提交 —— 而空白表单看起来就是
     「这一单本来没有工艺要求」，销售填几个数直接存下去就是一张缺工艺的下单。
     现在退成一张失败页，只给「重试」与「返回销售单列表」。
  3. 预填把 `order_date` 也清空（新建态的默认值是「今天」）：服务端的 `must_fill` 里有它，
     而"沿用上一批的下单日"是错的；留空 + 提示比默认今天更诚实。
- 验证：`npm run typecheck`（api + web）通过；web lib **283/283**；web 组件 **55 文件 / 977 条**。
- **未验证**：没有在真实浏览器里走过「返单 → 保存 → 新单出现在货号下」的整条交互；
  日期格在真实日期控件里的行为只有 jsdom 层面的断言。

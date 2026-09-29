# T04 销售单前端：货号录入、列表列与筛选

> 设计依据：[reorder-item-no-and-summary-2026-09-26.md](../../design/reorder-item-no-and-summary-2026-09-26.md) §四.3
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T01](./01-sales-order-item-no-schema.md)、[T02](./02-sales-order-item-no-api.md)。后续 [T06](./06-reorder-web-entry.md) 依赖它
（返单预填要落在这个表单上）。

## 目标

新建/编辑销售单时能填货号——**既能挑已有货号，也能直接输新货号**；销售单列表能看到货号、能按货号搜、
能筛出「未填货号」的历史单。

## 关联决策

- 货号**不是主数据**：不做「新建货号」弹窗、不做货号池页面，输入框自己就是入口（设计文档 §二）。
- 不用原生 `<datalist>`：全站治理轮已移除原生浏览器控件（`docs/task/0824-01/04-remove-native-browser-prompts.md`）。
- 不用 `apps/web/components/ui/searchable-select.tsx`：它是**只能选不能建**的控件（`options` → `onChange`，
  输入只用于过滤），而货号必须允许「输一个系统里还没有的」。

## 范围与非范围

**范围**

- 新增 `apps/web/lib/item-no.ts`（与 API 的 `itemNoKey` 同义的纯函数）+ `apps/web/lib/item-no.test.mjs`。
- 新增 `apps/web/components/sales/item-no-input.tsx`（输入 + 既有货号建议下拉）。
- 新增 `GET /sales-orders/item-nos`（建议候选来源，改动落在 sales 模块）。
- `apps/web/components/sales/sales-order-editor.tsx`：基本信息加货号字段。
- `apps/web/app/sales/page.tsx`：列表加货号列 + 搜索命中 + 状态筛选。
- 测试：`apps/web/test/sales-order-editor.test.tsx` 增补；新增 `apps/web/test/sales-item-no.test.tsx`。

**非范围**

- 不做返单入口（[T06](./06-reorder-web-entry.md)）。
- 不做 `/reorder` 页面（[T11](./11-reorder-page.md)）。
- 不改「客户池」那张表。

## 交付物

| 文件 | 改动 |
| --- | --- |
| `apps/web/lib/item-no.ts` | 新建：`ITEM_NO_MAX_LENGTH`、`normalizeItemNo`、`itemNoKey` |
| `apps/web/lib/item-no.test.mjs` | 新建：与 API 同一组测试向量（见下） |
| `apps/api/src/modules/sales/sales-orders.controller.ts` | 新增 `@Get("item-nos")`（**必须声明在 `@Get(":id")` 之前**） |
| `apps/api/src/modules/sales/sales-orders.service.ts` | `itemNoOptions(q?, limit?)`：`groupBy(["itemNo"])` 过滤空值，返回去重后的货号数组 |
| `apps/web/components/sales/item-no-input.tsx` | 新建 |
| `apps/web/components/sales/sales-order-editor.tsx` | 基本信息区加货号；载荷带 `item_no` |
| `apps/web/app/sales/page.tsx` | 货号列、搜索、筛选 |
| `apps/web/test/sales-order-editor.test.tsx` | 增补 |
| `apps/web/test/sales-item-no.test.tsx` | 新建 |

## 实施要点

**1. 归一函数两端同源（本仓库没有共享包）**

`apps/web/lib/item-no.ts` 是 `apps/api/src/modules/sales/item-no.ts` 的**逐字复制**（导出名一致）。
两份用**同一组测试向量**钉住：`"" / "  " / "27621" / " 27621 " / "27621\t流水" / "27621　流水"（全角空格）/
"dl27621" / "DL27621"`。先例：`SPEC_SCALAR_FIELDS`（api）↔ `sales-order-spec.ts`（web）、
`china-region.ts`（两份字节相同）。

**2. `GET /sales-orders/item-nos`**

- 入参：`q`（可选，按归一键 contains，不区分大小写）、`limit`（默认 50，上限 200）。
- 返回：`{ data: [{ item_no, item_no_key, order_count }] }`，按 `order_count` 降序、再按货号升序。
- 为什么不让前端从 `GET /sales-orders?page_size=200` 里自己推：那样只能看到前 200 张单的货号，
  老货号会被推荐不到——**推荐不出来就等于没有**。
- `groupBy` 出来的行按**列值**分组，`27621` 与 `DL27621` 会分成两行；本接口是**建议**用途，
  不做跨行归并（归并要读全部行，代价不成比例）。分组归并的事情归 [T07](./07-reorder-articles-api.md)。

**3. `ItemNoInput` 组件**

```
props: { value, onChange, suggestions: { item_no, item_no_key, order_count }[], disabled?, testId? }
```

- 收起态就是一个 `<Input>`（可以随便输，包括系统里没有的新货号）。
- 聚焦/输入时在下拉里展示建议：`货号 + （N 单）`，按 `itemNoKey` 去重后最多 8 条。
- 命中「输入值与某建议的 key 相同」时**不**替换用户的原始写法（存原样是货运的口径）。
- 键盘：↑↓ 移动、Enter 采用、Esc 关闭、Tab 关闭；鼠标点击采用。**必须做键盘可达**
  （全站既有控件的无障碍口径：菜单类控件都要键盘走通）。
- `data-testid` 落在 Input 上，沿用 `sales-base-item_no`——这样「按 testid 找字段」的既有用法不变。
- 样式类名沿用现有表单类的写法（`ui-input` + 自定义下拉类），新增 CSS 放 `apps/web/app/globals.css` 对应区块，
  **不要**用行内 style 拼版式。

**4. 编辑器**

- 放在「基本信息」里客户/联系人那一组旁边（`sales-order-editor.tsx` 基本信息区块），
  **不要**塞进 `BASE_FIELDS`（那是一条只渲染纯 Input 的循环，塞进去会让那个循环长出特例分支）。
- 载荷：`item_no: base.item_no?.trim() || null`——空串要发 `null`（后端语义是「清除货号」），
  发 `""` 语义相同但**发 `null` 更不容易被下一个人读错**。
- 编辑既有单时回填 `order.itemNo`；新建时为空。

**5. 销售单列表**

- `Order` 类型加 `itemNo?: string | null`；列定义（`orderColumns`）在「订单号」之后加「货号」列，空值显示 `-`。
- 搜索：`visibleOrders` 的拼接串里加 `order.itemNo ?? ""`。
- 筛选：新增一个 `Select`（`data-testid="sales-item-no-filter"`），三档
  `全部 / 仅有货号 / 未填货号`，默认全部。**不要**顺手加「按货号分组」——那是 `/reorder` 的职责。

## 验收与验证

| # | 验收点 | 用例 |
| --- | --- | --- |
| 1 | web 的 `itemNoKey` 与 api 同向量同结果 | `web/lib/item-no.test.mjs`（`node --test`）+ api 侧向量表 |
| 2 | 编辑器能输入系统里没有的新货号并保存 | `sales-item-no.test.tsx` |
| 3 | 建议下拉只列既有货号、按单数降序、最多 8 条 | 同上 |
| 4 | 已确认单改货号时提示填原因（沿用既有原因弹窗路径） | 同上 |
| 5 | 列表显示货号；搜索货号能命中 | 同上（渲染 `SalesPage`） |
| 6 | 「未填货号」筛选只留 `itemNo` 为空的单 | 同上 |
| 7 | `GET /sales-orders/item-nos` 不被 `@Get(":id")` 吃掉 | api 侧加一条路由顺序用例（照 `purchase-orders` 的 `bom-item-status` 先例） |

命令：`npm run typecheck` → `cd apps/web; npm run test:unit` → `npm run test:unit:api`。

> 加列与加筛选项会动到渲染 `SalesPage` 的既有测试：`apps/web/test/pool-search.test.tsx`、
> `sales-production-sheet.test.tsx`、`outbound-notice-pages.test.tsx`。跑全量后按**真实行为**同步断言，
> 不要为了让测试变绿而放宽断言。

## 决策记录

- **建议候选靠新接口而不是本地推导**：见实施要点 2。
- **不做「新建货号」弹窗**：货号是客户/产品侧给定的编码，不是我们分配的主数据；
  真需要主数据（图片、常驻规格、负责人）时再升级，设计文档 §二 已写明触发条件。

## 完成记录

**2026-09-26 完成**（提交 `257eae6`）。

- 交付物：`apps/web/lib/item-no.ts` + `apps/web/lib/item-no.test.mjs`（与 api 侧同一组向量）；
  `apps/api/src/modules/sales/sales-orders.service.ts` 的 `itemNoOptions()` 与
  `GET /sales-orders/item-nos`；`apps/web/components/sales/item-no-input.tsx`；
  编辑器的货号字段与载荷规则；销售单列表的列、搜索与筛选；`globals.css` 的 `.ui-item-no*`；
  `apps/web/test/sales-item-no.test.tsx`（13 条）。
- 与计划的差异：
  1. **过滤用「包含」而不是「前缀」**：输 `27621` 会连 `DL27621` 一起列出。这与服务端 `q` 的
     `contains` 语义一致，也确实有用（货号常常只记得尾巴）。已在测试里写成断言并说明理由。
  2. `ItemNoInput` 做成**纯受控、无请求**：候选由编辑器取一次传进来，
     所以组件测试不需要起 msw 就能覆盖键盘/筛选/建议全部行为。
  3. 组件测试里加了一个带 `useState` 的受控壳（`Controlled`）：纯受控组件直接配 `onChange={() => {}}`
     的桩，输入框永远是空的 —— 那测出来的是测试自己的问题，不是组件的问题。
- 验证：`npm run typecheck`（api + web）通过；web lib **283/283**；web 组件 **54 文件 / 968 条**；
  `npm run test:unit:api` **2051/2051**。
- **未验证**：没有在真实浏览器里目测过建议下拉的定位与观感（jsdom 不排版）；
  `GET /sales-orders/item-nos` 只在假 Prisma 上验过 `groupBy` 参数形状。
- 路由顺序：本地加了一条**静态断言**（读控制器源码，断言 `@Get("item-nos")` 在 `@Get(":id")` 之前），
  另在 `sales-orders-contract.test.cjs` 登记了端到端探测（http 套件需真实环境，本地未跑）。
  静态断言第一版被**注释里的同一段文字**骗过去了（注释写着「必须声明在 @Get(":id") 之前」），
  改为匹配 `@Get(":id") async` 这条真正的声明。

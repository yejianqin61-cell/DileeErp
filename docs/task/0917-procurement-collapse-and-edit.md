# 0917 采购单第三轮：编辑已建单、列宽、下单状态列、按供应商收束

> 设计：[purchase-order-collapse-and-edit-2026-09-17.md](../design/purchase-order-collapse-and-edit-2026-09-17.md)
> 待确认：[0917-采购单收束与编辑待确认事项.md](../memo/0917-采购单收束与编辑待确认事项.md)

## 用户原话

1. 「采购板块，要支持对已经建好的采购单进行编辑」
2. 「新建采购单这个页面，勾选框太宽了，要窄一点，然后让名称和型号那栏宽一点。预计到货那个 column 也要宽点」
3. 「已经选中并下单的 BOM 物料，再新建采购单中要显示已下单。因此要多一个 column」
4. 「采购单现在有点乱。我们的逻辑是，导入 BOM 物料之后，用户对采购单进行编辑，填写供应商等等 column。
   支持保存草稿。然后再根据供应商收束下单。一个采购单内，一个供应商下一个单。当前这个功能完全缺位」

## 交付

### 后端

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/modules/procurement/purchase-orders.service.ts` | `update()` 放开可编辑范围 + 必填原因 + 前后值审计；新增 `splitExisting`、`bomItemOrderStatus`、`collectGroups`、`replaceOrder`、`assertEditable`、`snapshotSource`、`orderSnapshot`；`refs()` 移除「每行必须有供应商」并新增「一张单只能有一个供应商」 |
| `apps/api/src/modules/procurement/purchase-orders.controller.ts` | `PurchaseOrderUpdateDto`、`PurchaseOrderSplitExistingDto`、`BomItemOrderStatusQueryDto`；`GET bom-item-status`（**在 `:id` 之前**）、`POST :id/split`；`ItemDto.supplier_id` / `SplitGroupDto.supplier_id` 改为可选 |
| `apps/api/src/modules/procurement/raw-material-inbounds.service.ts` | 入库单与应付来源的供应商改走 `requireItemSupplier()` 守卫（明细行供应商已可空） |
| `apps/api/src/modules/production/outsource-logistics.service.ts` | 外加工应付来源的供应商标空守卫 |
| `apps/api/prisma/schema.prisma` | `PurchaseOrderItem @@index([bomItemId])`；`supplierId` / `supplierSnapshot` 与关系字段改为可空 |
| `apps/api/prisma/migrations/20260920100000_purchase_order_item_bom_item_index/` | 纯新增索引 |
| `apps/api/prisma/migrations/20260920120000_purchase_order_item_supplier_nullable/` | 两列 DROP NOT NULL（放松约束） |

### 前端

| 文件 | 改动 |
| --- | --- |
| `apps/web/app/procurement/orders/page.tsx` | 草稿表加「下单状态」列（11 列）；`BOM 外新增原因` 输入；换物料清 `bom_item_id`；保存/下单统一按供应商收束；列表编辑入口放开到「已下单未到货」+ 修改原因 |
| `apps/web/app/globals.css` | 草稿表逐列显式宽度（修掉 `.material-issue-sheet` 的 24%/8% 权重泄漏）；`.bom-order-draft` / `.bom-order-partial` / `.purchase-edit-reason` |

### 测试

| 文件 | 内容 |
| --- | --- |
| `apps/api/test/unit/purchase-order-edit-ordered.test.cjs` | 7 条：草稿无需原因 / 已下单必填原因 / 空白原因不算 / 前后值审计 / 有到货一律拒绝 / 中间状态拒绝 / 复用参照物校验 |
| `apps/api/test/unit/purchase-order-split-existing.test.cjs` | 12 条：第 1 组沿用原单 / 扩展数据带来源 / 单组既等于原地保存 / 草稿下单补采购日期 / 草稿保存不写采购日期 / 已下单不退回草稿 / 必填原因 / 有到货拒绝 / 审计 / 结构校验先于写入 / 下单前必填 / 404 |
| `apps/api/test/unit/purchase-order-bom-item-status.test.cjs` | 10 条：四态 / 草稿单独累计 / 多单相加去重 / 超买仍是足量 / 已下单优先于草稿 / 排除已取消 / 排除软删行 / 需求量 0 / 404 与空 BOM / 返回需求量 |
| `apps/api/test/unit/purchase-order-bom-item-index-migration.test.cjs` | 5 条：索引存在 / 不改数据不加约束 / 只建一个索引 / schema 一致 / 目录顺序 |
| `apps/api/test/unit/purchase-order-item-supplier-nullable-migration.test.cjs` | 5 条：只放松两列 / 不改数据 / schema 一致 / **放松约束的同时下单门禁仍在** / 目录顺序 |
| `apps/api/test/purchase-orders.test.cjs` | 改 4 条：旧的「非草稿一律不可编辑」按新规则重写；「每行必须有供应商」从 refs 挪到下单门禁；两条「per-item suppliers」改成单供应商并新增「一张单不能有两个供应商」「没有供应商的草稿明细写 null」 |
| `apps/api/test/unit/purchase-order-split.test.cjs` | 拆出「结构校验先于 refs」；新增「没有供应商的组存草稿可以、下单不行」「未选供应商只能一组」 |
| `apps/api/test/unit/purchase-order-split-existing.test.cjs` | 同上（收束已有单的两个方向） |
| `apps/web/test/procurement-order-collapse.test.tsx` | 13 条：下单状态列四态 / BOM 外新增 / 草稿中不算已下单 / 手工行标记 / 原因必填 / 换物料清 BOM 行号 / 收束已存在单 / 一张变两张 / 已下单必填原因 / 有到货无编辑入口 / **未选供应商：存草稿放行、下单阻断** / **导入后三行都没供应商也能存草稿** / **空草稿走普通建单接口** |
| `apps/web/test/procurement-draft.test.tsx` | 随列序调整（库存列 4→5）、按钮改名（`收束下单（2 张）`） |

## 修掉的三个真缺陷

1. **列宽权重泄漏**：`.material-issue-sheet .data-table td:nth-child(1) { width: 24% }`
   （写给领料单的）压过 `.draft-select-cell { width: 40px }`，`table-layout: fixed` 下
   复选框列真宽 24%（1920px 屏约 460px），名称列反被压到 8%。已逐列显式覆盖到 `(0,4,0)` 权重。
2. **BOM 外新增原因无处可填**：后端要求 `outside_bom_reason`，界面给不出，
   于是「添加行 → 保存草稿」在选了 BOM 时必然 422。已补输入框与保存前校验。
3. **换物料不清 `bom_item_id`**：撞 `PURCHASE_BOM_ITEM_MISMATCH` 拒绝整张单，报错不指行。

## 验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（api + web） |
| `npm run test:deploy` | 27 / 27 |
| `npm run test:unit:api` | 1801 / 1801 |
| Web lib | 218 / 218 |
| Web 组件（49 文件） | 880 / 880 |
| `npm run build --workspace=@dilee/web` | 通过（52 页） |

> **并行工作流**：验证期间财务侧的 `overhead-allocation` / `voucher-line-editor` / `searchable-select`
> 正在被另一个工作流改，那一时段全量前端测试是红的（失败全部落在它正在改的面上）。
> 它自己修完后全量恢复绿。另外，我为了判断责任归属做的一次 `git stash` + `pop`
> 把 3 个 web 文件的行尾改成了 CRLF，害得 `finance-table-width.test.mjs` 两条
> **正则内嵌 `\n`** 的断言失配（已用 Node 规范回 LF）。经过与教训见 `docs/log/2026-09-17.md` 第三轮。

## 未验证（无本地数据库）

- 迁移 `20260920100000_purchase_order_item_bom_item_index`（加索引）与
  `20260920120000_purchase_order_item_supplier_nullable`（两列 DROP NOT NULL）
  从未在真实 PostgreSQL 上执行。
- `bomItemOrderStatus` 的查询只跑过手写假 Prisma，未对真实库验证 SQL。
- `prisma migrate deploy`、`apps/api/test/http`、`apps/api/test/integration`、Playwright 均未运行。
- 列宽只做了权重推导与构建，**未在真实浏览器量过像素**，建议部署后目测 1200–2560px。
- `GET purchase-orders/bom-item-status` 与 `@Get(":id")` 的先后顺序靠代码位置保证，
  没有自动化断言（与上一轮 `pay-batch` / `payment-sheet.xlsx` 同类风险）。
- `PURCHASE_ITEM_SUPPLIER_MISSING` 两道守卫是防御性的，正常路径到不了，没有测试覆盖。

## 部署顺序

先 `npm run db:generate --workspace=@dilee/api` → `prisma migrate deploy` → 再切代码。

本轮**不是**纯向后兼容：`20260920120000` 会放松 `purchase_order_items.supplier_id` 的 NOT NULL。
不跑迁移的话，保存「还没选供应商」的草稿会撞上数据库的 NOT NULL 违约（500），
其余功能不受影响（已有明细行都有供应商）。

迁移后用这条语句确认放松生效：

```sql
SELECT column_name, is_nullable FROM information_schema.columns
WHERE table_name = 'purchase_order_items' AND column_name IN ('supplier_id', 'supplier_snapshot');
-- 期望两行都是 YES
```

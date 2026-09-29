# T12 Web：BOM 工作区供应商列按入口显隐（生产隐藏）+ 计划从 BOM 预填供应商

> 设计依据：[purchase-plan-and-supplier-collapse-2026-09-27.md](../../design/purchase-plan-and-supplier-collapse-2026-09-27.md) §6.4、§2（口径 3）
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T10](./10-web-plan-detail-sheet.md)（计划侧的供应商格用法定了再动 BOM 侧，避免两边对 `SupplierSelect` 的用法分叉）。
可与 [T11](./11-web-purchase-order-slimming.md)、[T13](./13-web-fixed-table-css.md) 并行。

## 目标

落实用户原话的第一句「**生产模块里面的 BOM 表里面不用填写供应商**」：
BOM 工作区的「供应商」列**只在采购侧显示**，生产侧隐藏；同时确认**新建计划时从 BOM 行预填供应商**
（这条的写入侧在 [T02](./02-plan-api-skeleton.md)，本任务负责端到端可用与提示）。

## 口径与决策（依据设计文档）

- **口径 3**：BOM 的「供应商」列只在采购侧显示（生产侧隐藏）；新建计划时从 BOM 行**预填供应商**。
  理由：BOM 那列回答"这个部件**通常**找哪家"（跨订单、跨返单长期有效），
  计划回答"**这一批**找哪家买"——前者是后者的默认值，采购员只处理例外。
- **§6.4**：给 `BomWorkbench` 加一个 prop（例如 `showSupplier?: boolean`），**不复制组件**；
  三个入口的传值表（`/procurement/boms` = true、`/procurement/orders` = true、`/production` = 不传）。
- **口径 4**：供应商格用 `SupplierSelect`（下拉 + 快速新建）。

## 范围与非范围

**范围**

- `apps/web/components/bom/bom-workbench.tsx`：加 `showSupplier?: boolean`；为 `false` 时
  **不渲染**供应商列（表头 + 单元格同步），保存时也不该因为这一列不可见而丢掉已有值。
- 三个入口传值：`app/procurement/boms/page.tsx`（true）、`app/procurement/orders/page.tsx`（true）、
  `app/production/page.tsx`（不传）。
- 计划侧预填的**可见性**：计划详情里能看到从 BOM 预填来的供应商（[T10](./10-web-plan-detail-sheet.md) 已做），
  本任务补一条用例钉住"BOM 行有供应商 → 新建计划后该行带供应商"。

**非范围**

- BOM 保存时的供应商写入与校验（[T02](./02-plan-api-skeleton.md) 之前那批已经做了 —— `BomItemDto.supplier_id`
  与 `BOM_SUPPLIER_NOT_FOUND` 已存在），本任务**不**改它。
- 生产侧的其它行为（领料、日报）。

## 交付物

| 文件 | 关键改动 |
| --- | --- |
| `apps/web/components/bom/bom-workbench.tsx` | 新增 `showSupplier?: boolean`；控制「供应商」表头与单元格的渲染；`null`/`undefined` 视为 `false`（**默认隐藏**，这样"忘了传"的新入口默认是安全的生产侧行为） |
| `apps/web/app/procurement/boms/page.tsx` | `showSupplier` |
| `apps/web/app/procurement/orders/page.tsx` | `showSupplier`（该页在 [T11](./11-web-purchase-order-slimming.md) 会瘦身，注意与 T11 的改动合并不冲突） |
| `apps/web/app/production/page.tsx` | **不传**（并在旁边留一句注释说明"生产不填供应商"，免得下一个人以为是漏了） |
| `apps/web/test/bom-supplier.test.tsx` | 增补：`showSupplier` 三态（true 显示 / false 隐藏 / 不传隐藏） |

## 实施要点

### 1. 默认值的方向（容易写反的一处）

- `showSupplier` 缺省 = **隐藏**。理由：三个入口里只有两个要显示；"忘了传"的后果应该是"生产侧少一列"
  （无害），而不是"生产侧多出一列让人填"（用户明确说生产不用填）。
- 隐藏的是**这一列**，不是这一列的数据：保存时 `supplier_id` 仍按行状态原样发出
  （否则在生产侧存一次 BOM 会把采购填过的供应商抹掉——那是**数据损坏**，不是显示问题）。
  这条必须有测试钉住：`showSupplier=false` 时保存，请求体里的 `supplier_id` **保持原值**。

### 2. 三个入口的传值（§6.4）

| 入口 | 传值 |
| --- | --- |
| `/procurement/boms` | `true` |
| `/procurement/orders` | `true` |
| `/production` | 不传（false） |

- 不复制组件（§6.4 明确）：两个副本的字段口径必然漂移 —— 这个组件本来就是为"采购与生产共用"抽出来的
  （见它的文件头注释）。

### 3. 计划侧的预填（口径 3 的落点）

- 新建计划时，计划行的供应商来自 **BOM 行的供应商**（[T02](./02-plan-api-skeleton.md) 已实现）。
- 本任务补一条**端到端可见性**用例：BOM 某行有供应商 → 新建计划 → 详情里那一行显示该供应商，
  且地址/联系人随之派生显示（口径 4）。
- BOM 行**没有**供应商时，计划行留空（不猜、不取"上次买过的供应商"——那是设计文档没写的口径）。

## 验收与验证

| # | 验收点 | 怎么验 |
| --- | --- | --- |
| 1 | `showSupplier=true`：表头与单元格都有「供应商」 | `bom-supplier.test.tsx` |
| 2 | `showSupplier=false` 或**不传**：两处都没有 | 同上 |
| 3 | 隐藏时保存**不丢**已有 `supplier_id`（数据不损坏） | 同上（断言请求体） |
| 4 | 三个入口的传值与 §6.4 一致 | 源码静态断言（三处 grep）或页面用例 |
| 5 | 未选供应商的行保存时写 `DbNull`（既有行为回归） | 既有 `bom-supplier.test.tsx` 用例 |
| 6 | 计划新建后，BOM 行有供应商的明细带出该供应商；BOM 行没填则留空 | 计划页用例（[T14](./14-web-test-migration.md) 补） |
| 7 | 类型检查 + web 单测 | `npm run typecheck`、`cd apps/web; npm run test:unit` |

## 决策记录

- **默认隐藏**：见"实施要点 1"——"忘了传"的后果要朝无害的方向倒。
- **隐藏列但不丢数据**：显示是显示，存储是存储；把两者混起来就会在生产侧存一次 BOM 时抹掉采购的数据。
- **不给生产侧加"只读展示"**：用户原话是"生产模块里面的 BOM 表里面不用填写供应商"，
  加一列只读展示会让两边的列宽永远对不齐，收益是零。

## 完成记录

| 项 | 内容 |
| --- | --- |
| 完成日期 / 提交 |  |
| 实际交付物（文件 + 条数） |  |
| 验证命令与结果 | `npm run typecheck`：｜`cd apps/web; npm run test:unit`： |
| 与设计的差异（含理由） |  |
| 未验证项（环境阻断） |  |
| 踩到的坑 |  |

# T05 采购单 API：退回采购计划（替换 revert-draft/cancel）+ 明细只读 + 列表只含已下单及之后

> 设计依据：[purchase-plan-and-supplier-collapse-2026-09-27.md](../../design/purchase-plan-and-supplier-collapse-2026-09-27.md) §5.2、§4.3、§2（口径 7/11/15）
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T04](./04-plan-collapse-order.md)（要有 1:1 链接才谈得上退回）。后续 [T07](./07-supplier-snapshot-address-contact.md)、
[T11](./11-web-purchase-order-slimming.md) 依赖它。

## 目标

把采购单**收成纯粹的对外凭证**：列表只出现"已下单及之后"的单；明细在采购单页**只读**（要改去计划）；
删掉两个因为草稿消失而变成死代码的端点（`revert-draft`、`cancel`），换成**退回采购计划**
（把这一单退回它的计划，行回到"未下单"而**数量/单价/供应商原样保留**）。

## 口径与决策（依据设计文档）

- **口径 11**：每个动作只有一个入口；采购单页去掉新建/草稿 tab/编辑明细；**不做**"不建计划直接下单"的旁路。
- **口径 15 ③**：已下单**可退回采购计划**（原因必填、该单无任何到货事实），**退回不删数据**。
- **口径 7**：数量/单价/供应商的唯一编辑点是计划 → 采购单明细变成只读；
  而计划里已下单行的内容也是锁的（[T03](./03-plan-save-and-delete.md)），所以**退回是改这些内容的唯一通路**。
- **§4.3**：退回的步骤与错误码；作废单**不进列表**，只在审计里可查。
  可退不变式 = **`status === "ordered"` 且无任何到货事实**；被拒用 `PURCHASE_ORDER_NOT_REVERTIBLE`
  （本批次**新起**，命名照同族既有 `PURCHASE_ARRIVAL_NOT_REVERTIBLE` —— 后者是"到货状态回退"的判据，语义不同）。
- **§5.2**：其余端点的去留表。
- **状态集合（已确认）**：`draft` / `ordered` / `partially_arrived` / `arrived_complete` / `cancelled`，
  **没有** `partially_ordered` —— 不要引入它。

## 范围与非范围

**范围**

- `GET /purchase-orders` 只返回 `ordered` / `partially_arrived` / `arrived_complete`。
- `PATCH /purchase-orders/:id` 只接受打印字段；明细变更 → 422 `PURCHASE_ORDER_DETAIL_READONLY`。
- **删除** `POST /:id/revert-draft`、`POST /:id/cancel`。
- **新增** `POST /:id/revert-to-plan`（`reason` 必填）。
- 单测 `apps/api/test/unit/purchase-order-revert-to-plan.test.cjs`，并更新 `apps/api/test/purchase-orders.test.cjs`。

**非范围**

- 计划侧（[T03](./03-plan-save-and-delete.md)/[T04](./04-plan-collapse-order.md)）。
- 供应商快照扩字段（[T07](./07-supplier-snapshot-address-contact.md)）。
- 采购单页界面（[T11](./11-web-purchase-order-slimming.md)）。

## 交付物

| 文件 | 关键改动 |
| --- | --- |
| `apps/api/src/modules/procurement/purchase-orders.controller.ts` | 删两个端点、加 `revert-to-plan`；`PATCH` 的 DTO 收窄到打印字段 |
| `apps/api/src/modules/procurement/purchase-orders.service.ts` | `list` 的状态过滤；`update` 的明细只读守卫；新增 `revertToPlan`；删除 `revertToDraft` / `cancel` |
| `apps/api/src/modules/procurement/purchase-plans.service.ts` | 提供"按 `bom_id` 找未删计划 / 不存在就补建"的复用方法（供退回调用） |
| `apps/api/test/unit/purchase-order-revert-to-plan.test.cjs` | 新建（约 10 条） |
| `apps/api/test/purchase-orders.test.cjs` | 改：删除针对 `revert-draft` / `cancel` 的用例，补"明细只读""列表不含草稿/已取消" |
| `apps/api/test/http/purchase-orders-contract.test.cjs` | 路由表同步：删 2 条、加 1 条（**本机跑不了 → 环境阻断**） |

## 实施要点

### 1. 列表过滤（口径 11 + §5.2）

- `GET /purchase-orders`：`status IN ('ordered','partially_arrived','arrived_complete')`。
- `cancelled` 与历史遗留 `draft` **都不进列表**（草稿已被 [T01](./01-plan-schema-and-migrations.md) 的搬迁迁移
  归并成计划并软删；`cancelled` 只在审计里可查）。
- **注意**：过滤要作用在**默认列表**上；`GET /:id`（详情）不因此 404 —— 退回后的单仍要能被审计/深链查到。
  实现时在决策记录里写明详情端的可见性口径。

### 2. `PATCH /purchase-orders/:id` 收窄（口径 7）

- 保留：付款方式 / 交期条款 / 交货地址 / 厂家回签 / 供应商回签 / 主管签字 / 备注
  （走既有 `PATCH /:id/print-fields` 的字段集合即可，若两处重复，合并成一个 DTO）。
- 请求里出现 `items`、`bom_id`、任何明细字段 → 422 `PURCHASE_ORDER_DETAIL_READONLY`，
  文案必须给出口：**"明细请在采购计划里改"**（只报错不指路，用户会以为系统坏了）。
- 数量/单价/供应商**不再**是采购单可改字段：原 `update` 里的明细替换分支**删掉**（不是留着不用）。

### 3. 退回采购计划（`POST /:id/revert-to-plan`，§4.3）

**可退的不变式（已定稿，按这条写）**：

> **可退 = `status === "ordered"` 且该单没有任何到货事实。**

理由：`partially_arrived` / `arrived_complete` **必然有到货**（名字本身就是这个意思），
`cancelled` 已经作废；所以"可退"实际只有 `ordered` 一档。
**采购单状态只有 `draft` / `ordered` / `partially_arrived` / `arrived_complete` / `cancelled` 五个**，
**没有** `partially_ordered`（设计文档 §4.3 里那句"`ordered` / `partially_ordered` 之外"作废）。
被拒时统一用 `PURCHASE_ORDER_NOT_REVERTIBLE`（**不新造第二个同义码**；该码本批次新起，
见下方"实测"与 §决策记录 —— 仓库里目前没有它，同族既有的是 `PURCHASE_ARRIVAL_NOT_REVERTIBLE`）。

事务内五步：

1. 校验上面那条不变式（状态 = `ordered` 且无 `receipt`）；不满足 → 422 **`PURCHASE_ORDER_NOT_REVERTIBLE`**，
   文案说明原因（"已有到货事实" / "当前状态不可退回"）。
   > ⚠️ **实测**：这个码**本批次新起**，仓库里目前没有它。
   > 同族的既有码是 `PURCHASE_ARRIVAL_NOT_REVERTIBLE`（`purchase-orders.service.ts:462`），
   > 但那是"到货状态回退"用的（判据是 `partially_arrived`/`arrived_complete`），**语义不同，不要混用**。
   > 命名照它的款式（`PURCHASE_<对象>_NOT_REVERTIBLE`）。
   > 若实现时想复用 `PURCHASE_ARRIVAL_NOT_REVERTIBLE`，那是**改口径**，先回到设计文档确认。
2. 找目标计划：该单 `bom_id` 对应的**未删**计划；**不存在就自动补建一份**（口径 15 ③）。
   连 `bom_id` 都没有的历史单 → 422 `PURCHASE_ORDER_WITHOUT_BOM_NOT_REVERTIBLE`。
3. 把指向这张单明细的计划行 `purchase_order_item_id` **清空**（`purchase_order_item_id` 上有 `@unique`，
   清空后才能被将来的波次重新认领）。
4. 软删该采购单**及其明细**；`status` 记 `cancelled`。
5. 审计 `purchase_order.revert_to_plan`（含 PO 号、计划号、原因、行数）。

**退回不删数据**：计划行的数量/单价/供应商/预计到货**原样保留**（这是 §3.2 设计的全部意义），
而且这正是[已下单行内容被锁](./03-plan-save-and-delete.md)之后**唯一**的改法。

### 4. 删除两个端点（不是标记废弃，是删掉）

| 端点 | 删的理由 |
| --- | --- |
| `POST /:id/revert-draft` | 草稿不存在了，它没有语义 |
| `POST /:id/cancel` | 它只允许取消 `draft`（`purchase-orders.service.ts:383` 的守卫），草稿消失后是**死代码**；"供应商说做不了"的出口改成退回计划 |

删的时候要一起删：控制器路由、service 方法、单测里对它们的断言、http 契约表里的条目。

### 5. 保留不动的端点

| 端点 | 为什么留 |
| --- | --- |
| `POST /purchase-orders` | 内部/兼容用（前端不再调用） |
| `POST /purchase-orders/split` | 计划下单**复用它**的分组口径；但 `place_order:false` 的用法**废弃**（注释写明） |
| `POST /:id/split` | 对已下单的单仍可再收束（前端不再有入口） |

## 验收与验证

| # | 验收点 | 怎么验 |
| --- | --- | --- |
| 1 | 列表不含 `cancelled` 与遗留 `draft` | `purchase-order-revert-to-plan.test.cjs` |
| 2 | `PATCH` 带明细字段 → 422 `PURCHASE_ORDER_DETAIL_READONLY`，文案指路"去计划改" | 同上 |
| 3 | `PATCH` 带打印字段 → 成功（既有行为不破） | `purchase-orders.test.cjs` 既有用例 |
| 4 | 无到货的 `ordered` 单可退回：状态 `cancelled`、软删、明细软删 | `purchase-order-revert-to-plan.test.cjs` |
| 5 | 退回后计划行回到未下单（链接被清空），**数量/单价/供应商原样保留** | 同上（最关键的一条；也是[已下单行内容被锁](./03-plan-save-and-delete.md)之后唯一的改法） |
| 6 | 计划不存在时自动补建一份（口径 15 ③） | 同上 |
| 7 | 没有 `bom_id` 的历史单 → 422 `PURCHASE_ORDER_WITHOUT_BOM_NOT_REVERTIBLE` | 同上 |
| 8 | 已有到货事实（`partially_arrived` / `arrived_complete`）→ 422 `PURCHASE_ORDER_NOT_REVERTIBLE`，且**什么都没改** | 同上 |
| 9 | 非 `ordered`（`cancelled`）→ 同一个 `PURCHASE_ORDER_NOT_REVERTIBLE`（不新造第二个同义码） | 同上 |
| 10 | `reason` 必填（空/纯空格 → 422） | 同上 |
| 11 | 审计 `purchase_order.revert_to_plan` 含 PO 号/计划号/原因/行数 | 同上 |
| 12 | `revert-draft` / `cancel` 两个端点已不存在（请求 → 404） | `purchase-orders-contract.test.cjs`（**环境阻断**）+ 源码静态断言 |
| 13 | 源码里**不出现** `partially_ordered` | 源码静态断言 |
| 14 | 类型检查 + 全量 API 单测 | `npm run typecheck`、`npm run test:unit:api` |

## 决策记录

- **删端点而不是标记废弃**：留着"看起来还能用"的死代码，下一个人会照它写前端入口。
- **详情端仍可查已作废的单**：审计与深链需要；但列表不出现它——可见性口径写进本任务决策记录。
- **有到货一律不可退**：可退只剩 `ordered` 一档（`partially_arrived` / `arrived_complete` 必然有到货，
  `cancelled` 已作废），与既有 `assertEditable` 同一条线，不新造第二套判断。
- **`partially_ordered` 不存在**：采购单状态只有 `draft` / `ordered` / `partially_arrived` /
  `arrived_complete` / `cancelled` 五个；设计文档 §4.3 那句"`ordered` / `partially_ordered` 之外"作废
  （已由设计文档作者确认）。
- **`PURCHASE_ORDER_NOT_REVERTIBLE` 是本批次新起的码**（仓库里没有同名的）：命名照同族既有
  `PURCHASE_ARRIVAL_NOT_REVERTIBLE`，但那个码的判据是"是不是到货状态"，与本处不同，不复用。

## 完成记录

| 项 | 内容 |
| --- | --- |
| 完成日期 / 提交 |  |
| 实际交付物（文件 + 条数） |  |
| 验证命令与结果 | `npm run typecheck`：｜`npm run test:unit:api`： |
| 与设计的差异（含理由） |  |
| 未验证项（环境阻断） |  |
| 踩到的坑 |  |

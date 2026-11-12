# 07 — 最后一行被退时整单作废

## 1. Where this task sits

- **Phase 2 改一行不用退一整单**, whose goal is a line-level exit.
- **This task moves R-3 已下单的一行可以单独退回采购计划** 的边界：退到一行不剩时，结果要与整单退回**一样**。
- **Starts after**: `06 行级退回`. **Waits on it**: `09 Phase 2 的证明`.

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/procurement/purchase-plans.service.ts` 的 `revertPurchaseOrder()` 事务尾段 — 整单作废的写法（`status: "cancelled"` + 软删），照抄不要另立一套。
- `apps/api/src/modules/procurement/purchase-orders.service.ts` 的 `list()` 与 `LISTED_PURCHASE_STATUSES` — 已取消的单不进列表，所以作废是"消失"而不是"多一条记录"。

**Settled**

- 「一行不剩」的判据是**软删之后**剩余未删明细数为 0，不是"退之前只有一行"。
- 整单作废时返回里要有 `orderCancelled: true`，让调用方与前端能分开说。
- 单头金额归零而不是留着旧值。

**Edges and seam**

- Touches `06` 落下的那个方法，不新增 seam。
- Leaves 到货链路不动。

**Run**

- `npm run build --workspace=@dilee/api`
- `node --test apps/api/test/unit/purchase-plans-service.test.cjs`

**Unknowns**

- 一张单被作废后，计划行的链接必须已经断干净；否则计划里会出现"已下单"指向一张已取消的单，而那张单不在列表里 —— 用户永远追不到。

## 3. The workflow

1. 读两个入口，用一句话复述。
2. 数剩余明细；为 0 时把单标 `cancelled` 并软删。
3. 单头金额写 0，并把 `orderCancelled` 放进返回值。
4. 跑用例。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 只有一行的单，退那一行 | 单 `cancelled` + 软删，返回 `orderCancelled: true` | `revertPurchaseOrderItem()` |
| 2 | 退完之后计划行 | `purchaseOrderItemId` 为空（链接断干净） | 同上 |
| 3 | 两行的单退其中一行 | 单仍然存在、`orderCancelled` 为假 | 同上 |

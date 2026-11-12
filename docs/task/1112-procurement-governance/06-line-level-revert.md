# 06 — 行级退回：把一行从已下单退回采购计划

## 1. Where this task sits

- **Phase 2 改一行不用退一整单**, whose goal is that a 采购员 can revert one line and re-order it back into the same purchase order, keeping the PO number.
- **This task moves R-3 已下单的一行可以单独退回采购计划** into place: the service method exists and does the four writes atomically.
- **Starts after**: Phase 1（它改了同一批文件的口径，先合更省冲突）. **Waits on it**: `07 最后一行的整单作废`, `08 HTTP 入口与审计`, `09 Phase 2 的证明`.

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/procurement/purchase-plans.service.ts` 的 `revertPurchaseOrder()` — 整单退回的既有实现：它已经解决过"计划不存在就补建"与"历史单没有认领行就镜像一条"，行级退回是它的按行版本。
- 同文件 `ensurePlanForBom()` — 退回时拿计划的那一步，不要另写一份。
- `apps/api/prisma/schema.prisma` 的 `PurchasePlanItem`（`purchaseOrderItemId @unique`）与 `PurchaseOrderItem` — 断开的是这条 1:1 链接，不是删计划行。
- `docs/audit/procurement-audit-2026-11-12.md` §2.1 B3·B4 与 §5 P2 — 为什么只有行级粒度才能救回"已有到货"，以及为什么这条路的落点仍然是计划。

**Settled**

- **有到货事实的行一律不准退**（`receipts.length > 0` → 422）。到货之上才有质检/入库/应付，零 receipt 即零下游。
- 断链而不是删行：数量/单价/供应商/币种/预计到货**原样留在计划行上**。
- 单头 `total_amount` 必须按剩余未删明细重算，用与建单同一口径（`Σ amount`）。
- 认领行的查找用 `purchaseOrderItemId in [...]`（既有假 Prisma 已支持这个形状）。

**Edges and seam**

- Touches `purchase-plans.service.ts` 一个文件。
- Leaves `purchase-orders.service.ts` 不动：行级退回不碰它的任何不变式（不改已有行、不追加、不重排）。

**Run**

- `npm run build --workspace=@dilee/api`
- `node --test apps/api/test/unit/purchase-plans-service.test.cjs`

**Unknowns**

- 假 Prisma 的 `purchaseOrder.findFirst` 直接返回 fixture 行、不认 `include`，所以用例里的订单 fixture 必须自己带 `items`（既有退回用例就是这么写的）。照它的形状抄。

## 3. The workflow

1. 读上面四个入口，把本条任务用一句话复述。
2. 在事务里锁单头，读出订单与它的明细（含 `receipts`）。
3. 校验：单存在、明细属于该单、该行零到货、状态可退；每条都给各自的错误码。
4. 找计划（复用 `ensurePlanForBom`），断开认领行；没有认领行就镜像建一条。
5. 软删该明细，按剩余明细重算单头合计。
6. 跑构建与用例。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 两行（一行已下单），退那一行 | 该明细软删、另一行不动、计划行 `purchaseOrderItemId` 变空 | `revertPurchaseOrderItem()` |
| 2 | 该行已有到货 | 422 `PURCHASE_ORDER_ITEM_NOT_REVERTIBLE`，且什么都没写 | 同上 |
| 3 | 明明细不属于这张单 | 404 `PURCHASE_ORDER_ITEM_NOT_FOUND` | 同上 |
| 4 | 单头合计 | 退完之后 `totalAmount` = 剩余明细 amount 之和 | 同上 |
| 5 | 历史单（计划行没有认领它） | 镜像建出一条计划行，数量/单价/供应商照搬 | 同上 |

期望值来自 §5 P2 的验收项与 `revertPurchaseOrder` 的既有行为，不来自重跑函数。

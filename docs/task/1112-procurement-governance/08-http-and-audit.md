# 08 — 挂上 HTTP 入口并写审计

## 1. Where this task sits

- **Phase 2 改一行不用退一整单**, whose goal is a line-level exit a 采购员 can actually reach.
- **This task moves R-3 已下单的一行可以单独退回采购计划** 到接口层：路径、鉴权、原因必填、审计留痕。
- **Starts after**: `06 行级退回`. **Waits on it**: `10 前端行级退回入口`.

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/procurement/purchase-orders.controller.ts` — `@Post(":id/revert-to-plan")` 那一行：整单退回就在 `PurchasePlansService` 上、路径留在 `/purchase-orders/:id`。行级入口照它挂，路径 `:id/items/:itemId/revert-to-plan`。
- 同文件 `ReasonDto` — 原因必填的既有形状，直接复用它，不新造 DTO。
- `apps/api/src/modules/procurement/purchase-plans.service.ts` 的 `audit.record("purchase_order.revert_to_plan", ...)` — 整单退回的审计条目，行级那条要与它同名同前缀，方便按单查。

**Settled**

- 路径挂在 `purchase-orders` 控制器下（用户手里的对象是那张采购单），实现在 `PurchasePlansService`（落点是计划行）——与整单退回同一个分工。
- 原因必填，空串 422 `CORRECTION_REASON_REQUIRED`（复用语汇，不新造码）。
- 审计动作名 `purchase_order_item.revert_to_plan`，带单号、明细 id、物料、数量、原因、剩余行数、是否整单作废。

**Edges and seam**

- Touches controller + service 的审计尾段。
- Leaves 模块注册与鉴权装饰器不动（同控制器同一个 `@RequireModules("procurement")`）。

**Run**

- `npm run build --workspace=@dilee/api`
- `node --test apps/api/test/unit/purchase-plans-service.test.cjs apps/api/test/unit/purchase-orders-contract.test.cjs`

**Unknowns**

- 契约测试可能对控制器上的路由数量或形状有断言；若挂了新端点让它变红，先读那条用例在断言什么，再决定是更新它还是改路径 —— 不要为了让测试变绿而换路径。

## 3. The workflow

1. 读三处入口，用一句话复述。
2. 加控制器方法，参数与非 UUID 校验照同文件既有写法。
3. 服务里补原因校验与审计条目。
4. 跑构建与两个用例文件。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 原因空串 | 422 `CORRECTION_REASON_REQUIRED`，什么都没写 | `revertPurchaseOrderItem()` |
| 2 | 正常退回 | 审计里出现 `purchase_order_item.revert_to_plan`，带单号与原因 | 同上 |
| 3 | 正常退回 | 审计里的剩余行数与实际剩余一致 | 同上 |

# 02 — 候选接口分类返回可建与被拦，`data` 保持数组

## 1. Where this task sits

- **Phase 1 选不到的时候，系统能说出为什么**, whose goal is that a 采购员 can see which BOMs can take a plan.
- **This task moves R-1 采购计划的候选要能解释「为什么选不到」** into place: the endpoint starts returning the blocked half with reasons.
- **Starts after**: `01 领域纯函数与原因码`. **Waits on it**: `04 计划页渲染原因`.

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/procurement/purchase-plans.service.ts:243-261` — `candidates()`, which becomes a thin loader plus the task-01 classifier.
- `apps/api/src/modules/procurement/purchase-plans.controller.ts:97-101` — the route, and the comment about `@Get("candidates")` needing to be declared before `@Get(":id")`.
- `apps/api/test/unit/purchase-plans-service.test.cjs` — the `makeService({ boms, plans, ... })` fake, and in particular its `bom.findMany`, which **already applies the old filter itself**.
- `apps/web/app/procurement/plans/page.tsx:151-156` — the only consumer, which reads `data` as an array.

**Settled**

- `data` stays an array of eligible candidates, byte-for-byte the same shape as today. `meta.blocked` is the new surface.
- Blocked entries carry `existingPlan: { id, planNo, status, statusLabel }` when a plan exists; the status is derived (`planStatusOf`), never a column.
- Cap `blocked` at 50. This is a dropdown aid, not a report.

**Edges and seam**

- Touches `purchase-plans.service.ts` and `purchase-plans.controller.ts`.
- Leaves the create path alone; task 03 owns that.

**Run**

- `npm run build --workspace=@dilee/api` (exits non-zero on the unrelated finance error; `dist` still emits — see brief 01 Unknowns).
- `node --test apps/api/test/unit/purchase-plans-service.test.cjs apps/api/test/unit/purchase-plans-controller.test.cjs`

**Unknowns**

- The fake Prisma `bom.findMany` pre-filters to `confirmed` + no plan. Once the service filters in memory instead, that fake must return the rows honestly, otherwise case 2 of the new tests can never pass. Changing the fake is expected and correct; changing what the *test asserts* is not.

## 3. The workflow

1. Read the four files, then restate this task in one line.
2. Replace the `where` filters with a load of non-deleted BOMs plus their sales order and their active plan (keep `include` shallow: sales order number/status/deletedAt, plan id/no plus its items' link flags).
3. Classify in memory with the task-01 function; split into eligible and blocked.
4. Return `{ data, meta: { blocked } }` from the controller. Keep the service's public `candidates()` returning the eligible array so existing callers and tests hold.
5. Update the fake Prisma in the test file so `bom.findMany` honours only the `where` the service actually sends, and hydrates `purchasePlans`.
6. Add the blocked-shape cases; run both test files.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | one closed-order BOM, no plan | appears in `data` | `GET /purchase-plans/candidates` |
| 2 | one BOM with an active plan | not in `data`; in `meta.blocked` with `existingPlan.planNo` | same |
| 3 | one draft-order BOM | not in `data`; `meta.blocked` reason `SALES_ORDER_NOT_CONFIRMED` | same |
| 4 | a plan whose lines are all ordered | `existingPlan.status === "completed"` and `statusLabel` is 已完成 | same |
| 5 | no BOMs at all | `data` is `[]` and `meta.blocked` is `[]` | same |

Case 4's expectation comes from `planStatusOf`'s documented contract (all lines ordered ⇒ completed), which is already pinned by existing tests — not from the new code.

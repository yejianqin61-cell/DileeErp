# 03 — 建计划的前置校验改用同一个纯函数

## 1. Where this task sits

- **Phase 1 选不到的时候，系统能说出为什么**, whose goal is that a 采购员 can see which BOMs can take a plan.
- **This task moves R-2 销售单已关闭（closed）的 BOM 也能建采购计划** into place for the write path: candidate and create stop disagreeing.
- **Starts after**: `01 领域纯函数与原因码`. **Waits on it**: `05 候选端到端用例`.

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/procurement/purchase-plans.service.ts:998-1003` — `loadBom()`, which hard-codes `salesOrder.status: "confirmed"` and throws a 404 whose sentence says "或所属销售单未确认".
- `apps/api/src/modules/procurement/purchase-plans.service.ts:342-346` — `loadBomForRevert()`, whose comment is the precedent: the revert path deliberately ignores both soft-delete and sales-order status so a single exit never blocks.
- `apps/api/test/unit/purchase-plans-service.test.cjs` — the case `新建：BOM 不存在或所属销售单未确认 → 404`, which pins today's behaviour.

**Settled**

- `loadBom()` keeps throwing 404 for a genuinely missing/soft-deleted BOM, and keeps the code `BOM_NOT_FOUND`; only the *reason* for the status branch changes, and `closed` stops being a reason.
- The rule comes from the task-01 constant. No second copy of the status list.
- `loadBomForRevert()` is **not** touched. Its permissiveness is deliberate and pinned.

**Edges and seam**

- Touches `purchase-plans.service.ts` (`loadBom` only).
- Leaves `revertPurchaseOrder`, `ensurePlanForBom`, and the create transaction alone.

**Run**

- `npm run build --workspace=@dilee/api` (see brief 01 Unknowns for the exit-code trap).
- `node --test apps/api/test/unit/purchase-plans-service.test.cjs`

**Unknowns**

- The existing 404 case may be written against a fixture whose sales order is `draft`. If so it still passes unchanged, which is the desired outcome — if it fails, the fixture was `confirmed` and the test was asserting something else; stop and re-read before editing it.

## 3. The workflow

1. Read the files, then restate this task in one line.
2. Point `loadBom()` at the shared eligible-status set.
3. Reword the 404 sentence so it names the real statuses it accepts instead of "未确认".
4. Run the test file and confirm the existing 404 case still passes.
5. Add one case asserting a `closed` order's BOM now loads (no throw).

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | BOM on a `closed` sales order | `create()` succeeds, plan row created | `PurchasePlansService.create()` |
| 2 | BOM on a `draft` sales order | 404 `BOM_NOT_FOUND` | same |
| 3 | soft-deleted BOM | 404 `BOM_NOT_FOUND` | same |
| 4 | `confirmed` order (regression) | still succeeds | same |

Case 1's expectation comes from R-2's acceptance list. Case 2/3 come from the pre-existing cases, unchanged.

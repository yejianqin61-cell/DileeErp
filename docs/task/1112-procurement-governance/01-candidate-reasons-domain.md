# 01 — 把「哪些 BOM 可建计划」抽成纯函数并配原因码

## 1. Where this task sits

- **Phase 1 选不到的时候，系统能说出为什么**，whose goal is that a 采购员 can see which BOMs can take a plan, and why the others cannot.
- **This task moves R-1 采购计划的候选要能解释「为什么选不到」** into place: the classification rule becomes one pure function instead of a `where` clause.
- **Starts after**: nothing. **Waits on it**: `02 候选接口分类返回`, `03 建计划前置校验复用`.

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/procurement/purchase-plans.domain.ts` — the shape of this repo's domain modules: pure functions, Prisma imported only for `Decimal`, and every export documented with the 口径 it encodes.
- `apps/api/src/modules/procurement/purchase-plans.service.ts:243-261` — `candidates()`, whose three filters (`deletedAt`, `salesOrder.status`, `purchasePlans.none`) are what this task replaces.
- `apps/api/src/modules/procurement/purchase-plans.service.ts:998-1003` — `loadBom()`, the second copy of the same rule, which task 03 will fold in.
- `apps/api/src/modules/sales/sales-orders.service.ts:1354` — the sales-order `closed` transition, and what it does *not* do.

**Settled**

- The eligible status set is `confirmed` **and** `closed`. Rationale: audit §1.3. The 口径 2 text never mentioned sales-order status; the status gate was an implementation addition.
- Reasons are codes plus a Chinese sentence. Codes are contract; sentences may change.
- The function takes already-loaded rows. It must not query.

**Edges and seam**

- Touches `purchase-plans.domain.ts` only.
- Leaves `purchase-plans.service.ts` untouched in this task; task 02 wires it.

**Run**

- Build: `npm run build --workspace=@dilee/api` (see Unknowns — it exits non-zero for an unrelated reason).
- `node --test apps/api/test/unit/purchase-plans-service.test.cjs`

**Unknowns**

- The API build currently fails on `src/modules/finance/finance-three-statements.ts` (3× TS2554), which is **someone else's uncommitted work**. `dist` is still emitted. Verify `apps/api/dist/modules/procurement/purchase-plans.domain.js` has a fresh mtime; if it does not, stop and say so — do not "fix" the finance file.

## 3. The workflow

1. Read the four files above, then restate this task in one line.
2. Add the eligible-status constant and the reason-code type to `purchase-plans.domain.ts`.
3. Add the classifier: given `{ bomDeleted, salesOrderDeleted, salesOrderStatus, activePlan }`, return the reason list (empty = eligible).
4. Add the reason-sentence builder, keyed by code, in the same file.
5. Add a small helper that derives plan status from item link flags, reusing `planStatusOf` rather than duplicating it.
6. Run the build and the test file.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | confirmed order, no plan | eligible (no reasons) | `planCandidateReasons()` |
| 2 | closed order, no plan | eligible | `planCandidateReasons()` |
| 3 | draft order, no plan | one reason, code `SALES_ORDER_NOT_CONFIRMED` | `planCandidateReasons()` |
| 4 | confirmed order, active plan | one reason, code `PLAN_ALREADY_EXISTS`, sentence contains the plan number | `planCandidateReasons()` |
| 5 | soft-deleted sales order | reason `SALES_ORDER_DELETED` wins over status | `planCandidateReasons()` |

Expected values come from the plan's R-2 acceptance list and audit §5 P1's reason table, not from re-running the function.

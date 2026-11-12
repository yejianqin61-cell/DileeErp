# 05 — 覆盖它：关闭单可建、有计划的被拦、草稿单被拦

## 1. Where this task sits

- **Phase 1 选不到的时候，系统能说出为什么**, and this is its proof task: the phase closes here.
- **This task moves R-1 采购计划的候选要能解释「为什么选不到」 and R-2 销售单已关闭（closed）的 BOM 也能建采购计划** to *proven*: one end-to-end path covers every acceptance item.
- **Starts after**: `02 候选接口分类返回`, `03 建计划前置校验复用`, `04 计划页渲染原因`.

## 2. What the developer needs to know

**Read first**

- `apps/api/test/unit/purchase-plans-service.test.cjs` — the `makeService` fake and its `salesOrders` map, which is where a `closed` order has to come from.
- `apps/api/src/modules/procurement/purchase-plans.domain.ts` — the task-01 exports you are asserting against.
- `docs/audit/procurement-audit-2026-11-12.md` §5 P1 — the reason-code table, the independent source for expected codes.

**Settled**

- The phase's proof is **the test run**, not a document. Write the cases; do not restate the audit.
- One end-to-end case walks: closed order ⇒ candidate ⇒ create ⇒ plan row exists. No mocking of the rule.
- Existing cases must not be weakened to make the new ones pass. If a red test needs an old assertion changed, stop and say which one and why.

**Edges and seam**

- Touches the two test files only — `purchase-plans-service.test.cjs` and `procurement-plans.test.tsx`.
- Leaves production code alone. Anything that must change in production here means a brief was wrong.

**Run**

- `npm run build --workspace=@dilee/api` (see brief 01 Unknowns).
- `node --test apps/api/test/unit/purchase-plans-service.test.cjs apps/api/test/unit/purchase-plans-controller.test.cjs`
- `npm run test:unit --workspace=@dilee/web`

**Unknowns**

- The fake's `salesOrders` is a hard-coded two-entry `Map`. A `closed` order needs a third entry or a parameter; prefer adding a `{ salesOrders }` option to `makeService` over mutating the shared map.

## 3. The workflow

1. Read the three files, then restate this task in one line.
2. Let `makeService` accept extra sales orders so a `closed` one can exist.
3. Write the end-to-end case: closed order, eligible candidate, create, plan exists.
4. Write the blocked cases at the endpoint seam, asserting codes and the plan number.
5. Run all three commands; record the counts.
6. Commit.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `closed` sales order with BOM | eligible, and `create()` produces a plan | `candidates()` + `create()` |
| 2 | BOM with a completed plan | blocked, code `PLAN_ALREADY_EXISTS`, plan number present | `candidates()` |
| 3 | `draft` sales order with BOM | blocked, code `SALES_ORDER_NOT_CONFIRMED` | `candidates()` |
| 4 | soft-deleted sales order with BOM | blocked, code `SALES_ORDER_DELETED` | `candidates()` |
| 5 | the whole phase on screen | the plan page shows at least one blocked reason | plans page jsdom |

Cases 1–4 take their expected codes from audit §5 P1's table; case 5 from R-4's acceptance list.

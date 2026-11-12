# 04 — 计划页把被拦原因渲染出来

## 1. Where this task sits

- **Phase 1 选不到的时候，系统能说出为什么**, whose goal is that a 采购员 can see why a BOM cannot take a plan, on screen.
- **This task moves R-1 采购计划的候选要能解释「为什么选不到」** into place on the界面.
- **Starts after**: `02 候选接口分类返回`. **Waits on it**: `05 候选端到端用例`.

## 2. What the developer needs to know

**Read first**

- `apps/web/app/procurement/plans/page.tsx:130-160` — the state, and the `apiGet` pair that loads plans and candidates in one `Promise.all`.
- `apps/web/app/procurement/plans/page.tsx:291-301` — `candidateField`, whose placeholder today reads `"没有可建计划的 BOM"` and says nothing else.
- `apps/web/components/ui/action-dialog.tsx:13` — the `ActionField` type, which already has `type: "info"`; the dialog renders it as a `panel-note` paragraph.
- `apps/web/test/procurement-plans.test.tsx` — how this page is driven in jsdom today.

**Settled**

- The reason list is rendered as `info` fields **inside the existing create dialog**. No new page, no new dialog, no new route.
- Show at most three blocked entries, most-actionable first (`PLAN_ALREADY_EXISTS` before status reasons).
- Text form: `单号 / 货号 — 原因`. Never a raw UUID (repo-wide rule: no `制单：6f3a1c8e-…` style output).

**Edges and seam**

- Touches `plans/page.tsx` only.
- Leaves the create submit path and the table columns untouched.

**Run**

- `npm run test:unit --workspace=@dilee/web`
- `npm run typecheck --workspace=@dilee/web`

**Unknowns**

- The dialog resets its values from `fields` on every open (`action-dialog.tsx:26-31`), so `info` fields must be derived at render time, not captured in state. If the reasons go stale after a refresh, re-derive rather than pushing into state.

## 3. The workflow

1. Read the four files, then restate this task in one line.
2. Widen the candidates response type to carry `meta.blocked`, keeping the list type as-is.
3. Store blocked entries in state next to `candidates`.
4. Build the info fields from blocked entries, capped at three, and append them to the create dialog's `fields`.
5. Improve the placeholder so an empty dropdown distinguishes "genuinely none" from "all blocked".
6. Add a component case; run web tests and typecheck.

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | candidates empty, one blocked `PLAN_ALREADY_EXISTS` | dialog shows the plan number and the add-a-line hint | create dialog |
| 2 | four blocked entries | exactly three info lines rendered | create dialog |
| 3 | candidates non-empty, nothing blocked | no info lines | create dialog |
| 4 | empty candidates and nothing blocked | placeholder still says there is nothing to build | create dialog |

Case 1's expectation comes from R-4's acceptance list (plan number visible), not from the component.

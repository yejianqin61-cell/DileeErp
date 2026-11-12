# 09 — Phase 2 的证明：退完能并回同一张单

## 1. Where this task sits

- **Phase 2 改一行不用退一整单**, and this is its proof task.
- **This task moves R-3 已下单的一行可以单独退回采购计划** to *proven*：退一行 → 改计划 → 重新收束 → **采购单号不变**。
- **Starts after**: `06 行级退回`, `07 最后一行被退时整单作废`, `08 HTTP 入口与审计`.

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/procurement/purchase-orders.service.ts` 的 `findMergeTarget()` / `appendItems()` — 判据是「同 orderNo + 同 BOM + 同供应商 + 同币种 + 已下单 + 零到货 + 有本计划的认领行」。
- `apps/api/src/modules/procurement/purchase-plans.service.ts` 的 `order()` — 收束下单会先问 `findMergeTarget`，命中就追加。
- `apps/api/test/unit/purchase-plans-service.test.cjs` 的 `existingOpenOrder()` 与 `wavePlanFixture()` — 现成的"已下单一波 + 还有未下单行"fixture。

**Settled**

- 证明的是**单号不变**这一个事实，不是"能并"这件事（那个已有用例）。
- 用假采购单服务或真服务都行，但断言必须落在 `purchaseOrderNo` 上：退之前与退之后是同一条字符串。
- 不要为了让并发生效而放宽 `findMergeTarget` 的判据。

**Edges and seam**

- Touches 用例文件。
- Leaves 生产代码不动：如果不改代码就并不上，说明 `06` 的实现漏了「退回后那张单仍要能被认出是本计划的」——停下来先修 `06`。

**Run**

- `npm run build --workspace=@dilee/api`
- `node --test apps/api/test/unit/purchase-plans-service.test.cjs`

**Unknowns**

- `findMergeTarget` 要求订单状态恰为 `ordered`。若退回那一行之后单头状态被改成别的（`07` 只在一行不剩时改），并合就会失败 —— 这正是这条用例要抓的。

## 3. The workflow

1. 读三个入口，用一句话复述。
2. 造一个"两行、其中一行已下单、并有一张可并入的单"的场景。
3. 退回那一行，改数量，再收束下单。
4. 断言采购单号前后相等，且没有新建第二张单。
5. 跑用例。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 退一行后重新下单（同供应商同币种） | `merged === true`，`purchaseOrderNo` 与退之前相同 | `order()` |
| 2 | 同上 | 没有新建采购单 | `order()` 的返回 `orders.length === 1` |
| 3 | 退的那行改成新数量 | 并回去那张单上的明细数量是**新**数量 | `appendItems()` 落库结果 |

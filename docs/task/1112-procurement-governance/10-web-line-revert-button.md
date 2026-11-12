# 10 — 采购单详情页每行加「退回这一行」

## 1. Where this task sits

- **Phase 3 让界面把出路递到手上**, whose goal is that a 采购员 sees why a step is blocked and where to click next.
- **This task moves R-5 采购单详情页要有行级退回入口** into place: the endpoint from Phase 2 gets a button.
- **Starts after**: `08 HTTP 入口与审计`（端点必须已存在）. **Waits on it**: `12 Phase 3 的证明`.

## 2. What the developer needs to know

**Read first**

- `apps/web/app/procurement/orders/[id]/page.tsx` — 每个物料块是一个 `purchase-item-block`，操作列里已有「登记下一批到货」「登记到货」；`ActionDialog` 的用法与 `cancelReceipt()` 一模一样（收一个原因）。
- `apps/web/app/procurement/orders/page.tsx:244` — 列表页整单退回的可退判据（`status === "ordered"` 且零到货），行级按钮的判据要从这里推出**按行**的版本。
- `apps/api/src/modules/procurement/purchase-plans.service.ts` 的 `revertPurchaseOrderItem()` — 服务端会拒什么：该行有到货、单状态不在 ordered/partially_arrived、没有 BOM。

**Settled**

- 按钮**只在该行零到货时出现**：有到货的行按下去必然被拒，让用户点一次撞一次墙是最差的可发现性。
- 原因用 `ActionDialog` 收，必填；提交后 `load()` 刷新整页（单头金额会变）。
- 文案用「退回这一行」，与列表页的「退回采购计划」区分开 —— 两个粒度不同的动作不能同名。

**Edges and seam**

- Touches `orders/[id]/page.tsx` 一个文件。
- Leaves 列表页与计划页不动。

**Run**

- `npm run test:unit --workspace=@dilee/web`
- `npm run typecheck --workspace=@dilee/web`

**Unknowns**

- 物料块的操作按钮已经挤在块头一行里；加第三个按钮可能挤爆 1366px。若挤不下，放到该行的到货批次表下方而不是删掉别的按钮 —— 先看现有 CSS 类 `.purchase-item-block-header` 的排布再决定。

## 3. The workflow

1. 读三处入口，用一句话复述。
2. 在物料块头加按钮，判据：该行 `receipts.length === 0` 且单状态可退。
3. 点击打开 `ActionDialog` 收原因，提交到新端点。
4. 成功后刷新并提示「已退回这一行」。
5. 跑 web 用例与 typecheck。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 零到货的行 | 出现「退回这一行」 | 详情页 |
| 2 | 有到货的行 | 不出现该按钮 | 详情页 |
| 3 | 提交原因 | 请求打到 `/purchase-orders/:id/items/:itemId/revert-to-plan`，body 带 reason | 详情页 |
| 4 | 服务端 422 `PURCHASE_ORDER_ITEM_NOT_REVERTIBLE` | 错误提示可见，页面不崩 | 详情页 |

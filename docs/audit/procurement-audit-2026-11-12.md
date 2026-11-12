# 采购板块审计：被业务规则拦住的三类生产现场（2026-11-12）

> 用户反馈（原话）：
> 1. 「采购计划有时候无法选中需要建立采购计划的 BOM 表。」
> 2. 「下了采购单之后，如果需要临时修改 BOM 表的一些信息，需要整批采购单全部回退再修改，再下单。
>    说明我们系统的**拆分性、回溯性**不够灵活。」
> 3. 「业务规则不明确。」
>
> 本文只做**审计**：症状 → 根因（文件:行号）→ 补丁方案。实施结果记在文末 §7。

---

## 0. 结论先行

三条反馈不是三个孤立 bug，而是**同一个设计取舍在三个方向上的溢出**：

| # | 症状 | 真正的根因（一句话） | 严重度 |
| --- | --- | --- | --- |
| 1 | 选不到 BOM | 「一份 BOM 一份计划」用**部分唯一索引**硬保证，而计划在**有已下单行时不可删除** —— 两者相乘把 BOM 锁进一个**永久不可选**的闭环 | P0（数据可及性死锁） |
| 2 | 改一行要退一整单 | 「退回采购计划」只有**整张采购单**一个粒度；行级没有任何出口。已有到货的行连整单退都退不了 = **零出口** | P0（流程刚性） |
| 3 | 规则不明确 | 拦截分两种：**报错的**（有中文说明，可自救）与**静默的**（候选项直接不返回，用户只看到"没有可建计划的 BOM"）。第 2 类占多数，且恰好是最贵的那几条 | P1（可解释性） |

**四个补丁**（详见 §5）：

- **P1** 候选列表变成**可解释**的：返回 `eligible[]` + `blocked[]（带原因码与出口）`；并把销售单 `closed` 纳入可建范围。
- **P2** 新增**行级退回**：`POST /purchase-orders/:id/items/:itemId/revert-to-plan`，只退一行，单号不变。
- **P3** 「已完成计划」的补料出路**显式化**（在候选被拦时直接给出「去这份计划加行」的跳转）。
- **P4** 采购单详情页每行加「退回这一行」入口 + 计划页显示不可选原因。

---

## 1. 症状 1：采购计划选不到 BOM

### 1.1 拦截点矩阵

| # | 拦截点 | 文件:行 | 条件 | 现场后果 | 是否合理 |
| --- | --- | --- | --- | --- | --- |
| A1 | 候选查询只要**已确认**销售单 | `purchase-plans.service.ts:245` | `salesOrder.status === "confirmed"` | 销售单一旦 `closed`，它的 BOM 从下拉里**消失**，且没有任何提示 | ❌ 过头。`close` 是销售侧动作（`sales-orders.service.ts:1354` 只要求当前是 confirmed），不代表料已买齐 |
| A2 | 候选查询排除**已有未删计划**的 BOM | `purchase-plans.service.ts:245` | `purchasePlans: { none: { deletedAt: null } }` | 只要建过计划，该 BOM 永远不再出现 | ⚠️ 口径 1 的要求，但缺出口（见 A4） |
| A3 | BOM 软删 | `purchase-plans.service.ts:245` | `deletedAt: null` | 已软删 BOM 不可建计划 | ✅ 合理 |
| A4 | **有已下单行的计划不可删除** | `purchase-plans.service.ts:648-657` | 任一行 `purchaseOrderItemId` 非空 → 422 `PURCHASE_PLAN_HAS_ORDERED_LINES` | 完成/部分下单的计划**永久删不掉** | ⚠️ 单看合理（删计划=抹掉采购线入口），但与 A2 组合成死锁 |
| A5 | 部分唯一索引 | `migrations/20260928090000_purchase_plan/migration.sql:115` | `UNIQUE (bom_id) WHERE deleted_at IS NULL` | 一份 BOM 同时只能有一份未删计划 | ⚠️ 口径 1 的字面实现 |
| A6 | 建计划时的二次校验 | `purchase-plans.service.ts:998-1003` | 再次要求 `status === "confirmed"`，否则 404 `BOM_NOT_FOUND`（消息："BOM 不存在或所属销售单未确认"） | 候选口径与创建口径**两处各写一遍**，未来必然漂移 | ❌ 应共用同一函数 |
| A7 | 前端下拉只装 eligible | `apps/web/app/procurement/plans/page.tsx:291-301` | `options: candidates.map(...)`；空态文案 `"没有可建计划的 BOM"` | 用户看到的是**一个空下拉**，没有任何原因 | ❌ 静默失败 |

### 1.2 死锁链（这是"有时候"的真正解释）

```
一份计划只要有 1 行下过单
   → A4：计划删不掉（422）
   → A5：bom_id 上的部分唯一索引一直占着
   → A2：candidates() 永远不返回这张 BOM
   → 用户："有时候无法选中需要建立采购计划的 BOM"
```

命中这条链的现场非常常见：**这张 BOM 上一轮已经买过（甚至买完了），现在要再买一轮**
（补料、客户加量、上批损耗补货）。系统里其实**有**出路——在原计划里「加一行」（`update()` 对
未下单行完全放开，见 `purchase-plans.service.ts:556-562`）——但：

- 候选下拉里没有这张 BOM（A2）；
- 计划列表页没有任何「已完成计划的补料入口」提示；
- 用户不知道这条路存在 = **规则不明确**。

所以症状 1 与症状 3 是同一件事的两面。

### 1.3 「销售单 closed」这一条的补充证据

- `sales-orders.service.ts:1354`：关闭只校验当前是 `confirmed`，关闭后 BOM 与采购计划**都不动**。
- `sales-orders.service.ts:1259`：回退草稿要 `confirmed`。
- 反证：`purchase-plans.service.ts:342-346`（`loadBomForRevert`）对**退回**这条路径明确写了
  「**不看软删、不看销售单状态**」，理由是"不能把唯一的出路堵死"。
  → 说明维护者已经意识到「按状态拦截 BOM」会堵路，但**只在退回路径上修了，新建路径没修**。

---

## 2. 症状 2：改一行必须整批回退

### 2.1 刚性点矩阵

| # | 想做的事 | 现在只能怎么做 | 文件:行 | 代价 |
| --- | --- | --- | --- | --- |
| B1 | 改已下单明细的数量/单价/供应商 | 不可能 —— `PATCH /purchase-orders/:id` 见到 `items`/`supplier_id`/`currency` 就 422 `PURCHASE_ORDER_DETAIL_READONLY` | `purchase-orders.service.ts:53`、`:502-512` | 单点改动不可达 |
| B2 | 在计划里改已下单行的数量 | 不可能 —— `orderedLineChanged()` 拦 物料/单位/供应商/型号/数量/单价，只放 `sequence`、`expected_date`、以及「0 价补价」 | `purchase-plans.service.ts:721-729` | 同上 |
| B3 | 退掉一行 | **不存在**行级退回；只有整张单的 `revertPurchaseOrder` | `purchase-plans.service.ts:360-371` | 退整单 = N 行全部回到未下单，重下 = 重新分组、重新填 |
| B4 | 已有到货的单改内容 | **完全无出口**：整单退要求 `status === "ordered"` 且 `items.some(receipts)` 为空 | `purchase-plans.service.ts:369-371`；前端同口径 `orders/page.tsx:244` | 只能走质检/退货，或财务应付调整；采购侧的"少买 20"说不出口 |
| B5 | 退整单后保住原单号 | 保不住 —— 退回把单标 `cancelled` 并软删，重下走 `createOrdersFromGroups()` 生成新 `PO-` 号 | `purchase-plans.service.ts:404-405`、`purchase-orders.service.ts:144` | 供应商手里那张纸与新单号**对不上**，对账靠人脑 |
| B6 | 把一张单"重收束"（拆成多张） | `splitExisting` 可以，但要求**整单零到货**，且是"整体替换"（`replaceOrder` 老行全软删） | `purchase-orders.service.ts:273-288`、`:337-342` | 不是行级工具，是整单工具；一有到货就不可用 |
| B7 | 改 BOM 后已下单明细的引用 | BOM 保存是"软删全部旧行 + 整批建新行"，**所有 BOM 行 ID 都换**；已下单明细与计划行的 `bom_item_id` 因此悬空 | `boms.service.ts:207-228`；摊回逻辑 `purchase-orders.service.ts:368-455`、`purchase-plans.service.ts:755-758` | 金额/到货/应付不受影响（它们不读 `bom_item_id`），但**展示层要靠摊回**，很容易看起来像"对不上" |

### 2.2 为什么"零出口"是最严重的一格

B4 不是"操作麻烦"，而是**业务上说不出口**：

> 供应商：「那 100 个我做完 60 了，剩下 40 你先别要了。」
> 采购员在系统里：① 改计划行数量？被锁（B2）；② 改采购单明细？被拒（B1）；
> ③ 退整单？因为已有到货被拒（B4）；④ 拆单？因为已有到货被拒（B6）。
> → 最终只能**在系统外记一笔**，而系统里的采购数量从此与实际不符。

**这正是"回溯性不够灵活"的准确描述。**

### 2.3 一个被低估的细节：退回后单号会变

`revertPurchaseOrder()` → 老单 `status = cancelled` + 软删；重新收束 → `createOrdersFromGroups()`
新 `PO-` 号。`splitExisting()` 里有 `reused_purchase_order_no` 的机制（`purchase-orders.service.ts:284`），
但**计划下单这条主路径没有复用它**。

行级退回（P2）恰好绕开这个问题：老单**不动**，只是少了一行；
重新下单时 `findMergeTarget()` 会判据命中同一张单（同 orderNo + 同 BOM + 同供应商 + 同币种 +
零到货 + 有本计划的链接行）→ `appendItems()` → **单号不变**。
（`purchase-orders.service.ts:195-215`、`:228-263`）

---

## 3. 症状 3：业务规则不明确

### 3.1 两类拦截，用户待遇完全不同

| 类型 | 表现 | 用户能否自救 | 例子 |
| --- | --- | --- | --- |
| **报错型** | 弹一句中文，指明下一步 | 能 | `PURCHASE_ORDER_DETAIL_READONLY`（"请先退回采购计划"）、`PURCHASE_PLAN_PRICE_REQUIRED`（"第 N 行没填单价…补价后再下一波"） |
| **静默型** | 列表/下拉里**没有这一项**，什么都不发生 | **不能** | `candidates()` 的三层过滤（A1/A2/A3）、采购单列表排除 `cancelled`（口径 11）、计划行禁用（B2，靠灰化的输入框） |

静默型拦截是"规则不明确"的**结构性成因**：它不是文案问题，而是**接口不返回原因**。

### 3.2 为什么静默型会长期存在

`candidates()` 的设计注释写得很清楚：

> 「这张清单就是"该建计划还没建"的待办，所以不返回已经有计划的 BOM ——
> 否则下拉里一堆点了会 409 的选项。」

这个理由在**只有一个用法**时成立。一旦出现"补料二轮""销售单关闭后补买"这类场景，
待办语义就与"选择器"语义冲突：**选择器需要知道"为什么不能选"**，待办列表不需要。
一个接口同时承担两件事，结果两件都不够用。

---

## 4. 影响面（谁在依赖现在的行为）

| 依赖方 | 依赖什么 | 补丁会不会破 |
| --- | --- | --- |
| `apps/api/test/unit/purchase-plans-service.test.cjs`（1274 行） | `candidates()` 返回**数组**；「只有已确认销售单+未删 BOM+还没有计划才出现」 | P1 **保留 `data` 仍为数组**，新原因走 `meta.blocked` → 不破 |
| `apps/web/app/procurement/plans/page.tsx:151-156` | `apiGet<Candidate[]>("/purchase-plans/candidates")` | 同上，向后兼容 |
| `purchase-orders.test.cjs` | `PURCHASE_ORDER_DETAIL_READONLY` 的键黑名单 | P2 只**新增**端点，不动黑名单 |
| 到货/质检/入库/应付链路 | 一切按 `purchase_order_id` / `purchase_order_item_id` 取值 | P2 只软删明细 + 重算单头合计；**已有到货的行一律不准退**，所以下游事实零影响 |
| `bomFacts()` / `bomHasDownstream()` | `purchaseOrder.count({ bomId, status: { not: "cancelled" } })` | 不受影响（P2 不整单作废时状态仍是 ordered） |

---

## 5. 补丁方案

### P1 —— 让候选"可解释"（`GET /purchase-plans/candidates`）

**契约（向后兼容）**：

```jsonc
{
  "data": [ /* 与现在完全同形：可建的 BOM */ ],
  "meta": {
    "blocked": [
      {
        "bomId": "...", "orderNo": "...", "bomVersion": 1,
        "itemNo": "...", "customerName": "...", "itemCount": 12,
        "reasons": [{ "code": "PLAN_ALREADY_EXISTS",
                      "message": "该 BOM 已有采购计划 PP-20260927-AB12CD34（已完成）：补料请打开那份计划、加一行" }],
        "existingPlan": { "id": "...", "planNo": "PP-...", "status": "completed" }
      }
    ]
  }
}
```

**原因码**（都在 `purchase-plans.domain.ts` 里定义，纯函数可单测）：

| code | 触发 | 给的出口 |
| --- | --- | --- |
| `PLAN_ALREADY_EXISTS` | 已有未删计划 | `existingPlan` → 打开它加行（补料） |
| `SALES_ORDER_NOT_CONFIRMED` | 销售单 `draft` | 先确认销售单 |
| `SALES_ORDER_DELETED` | 销售单软删 | 找管理员 |
| `BOM_DELETED` | BOM 软删 | 不可用（合理） |

**同时把门槛从 `confirmed` 放宽到 `confirmed | closed`**（A1）：
理由见 §1.3；风险是"关闭单被误选"，但 BOM 只可能建在 confirmed 单上，所以不会把草稿期噪音放进来。
`loadBom()` 与 `candidates()` **共用同一个纯函数**判定可建性（A6），口径只写一处。

### P2 —— 行级退回（核心）

`POST /purchase-orders/:id/items/:itemId/revert-to-plan`，body `{ reason }`（必填）。

事务内：

1. `SELECT ... FOR UPDATE` 锁采购单头；
2. 校验：单存在且未删；明细属于该单且未删；
3. **该明细零到货事实**，否则 422 `PURCHASE_ORDER_ITEM_NOT_REVERTIBLE`（提示走到货/质检线）；
4. 单状态必须是 `ordered` / `partially_arrived`（`cancelled`、`draft` 拒绝）；
5. 找目标计划：`order.bomId` → `ensurePlanForBom()`（没有就补建，与整单退回同一条路）；
6. 断开链接：指向该明细的计划行 `purchase_order_item_id = null`（数量/单价/供应商/币种**原样保留**）；
   历史单没有认领行 → 镜像建一条计划行（与整单退回的 `orphanItems` 分支同口径）；
7. 软删该采购明细；
8. 重算单头 `total_amount = Σ 剩余未删明细 amount`；
9. 若一行不剩 → 整单 `cancelled` + 软删（与整单退回同结果），响应 `orderCancelled: true`；
10. 审计 `purchase_order_item.revert_to_plan`（单号、物料、数量、原因、剩余行数）。

**为什么这样就够了**：退回之后计划行回到未下单 → 采购员改数量/供应商/单价（本来就允许）
→ 重新收束下单 → `findMergeTarget()` 判据命中同一张单 → `appendItems()` 追加 →
**采购单号不变**（§2.3）。"改一行"从"退 N 行 + 重下 N 行 + 换单号"变成"退一行 + 改 + 并回原单"。

**为什么不用「行级直接改单」**：那要在采购单上开一条写明细的旁路，与口径 7
（数量/单价的唯一编辑点是计划）直接冲突，等于把「同一批货两份数字」那个老 bug 制度化。
行级退回把编辑动作**留在计划里**，只是把"退的粒度"降到行 —— 口径 7 不需要改。

### P3 —— 补料出路显式化

- 计划页「新建采购计划」弹窗：候选为空或存在 `meta.blocked` 时，用 `ActionField.type = "info"`
  把最能自救的 3 条原因显示出来，并在 `PLAN_ALREADY_EXISTS` 时给出计划编号。
- 计划列表：`completed` 行加一句「已完成（补料可在这份计划里加一行）」的说明性提示。

### P4 —— 前端入口

- `orders/[id]/page.tsx`：每个物料块头部加「退回这一行」（仅当该行零到货、单状态可退），
  复用现有 `ActionDialog` 收原因。
- `orders/page.tsx`：整单「退回采购计划」保留，按钮 `title` 补一句"只改某一行请进详情页退那一行"。

---

## 6. 回归面与风险

| 风险 | 处置 |
| --- | --- |
| P1 放宽 `closed` 被质疑"改口径" | 记录在案：口径 2 的原文是"选一张还没有计划的 BOM"，**没写销售单状态**；状态门槛是实现加的。本文即改动依据 |
| P1 让 `candidates()` 多查一遍（含被拦的 BOM） | 量级：与销售单同阶（几百），且已按 `orderNo` 索引；`blocked` 只取最近 50 条 |
| P2 重算单头合计与实际不符 | 用与建单同一口径：`Σ items.amount`（`amount = 数量×单价 + extraFee`） |
| P2 误退有下游事实的行 | 硬校验 `receipts.length === 0`；`receipts` 之上才有 inspection/inbound/payable，所以零 receipt 即零下游 |
| P2 并发 | `FOR UPDATE` 锁单头，与 `order()`/`receipt()` 同一把锁 |
| P2 让"已下单行"重新变成未下单 → 重复采购 | 与整单退回完全同一风险面（既有机制），已由 `purchase_order_item_id` 的 `@unique` 与 `PURCHASE_PLAN_ORDER_LINE_ALREADY_ORDERED` 兜住 |

---

## 7. 实施结果

见文末更新（本轮补丁 P1/P2/P4 + 用例）。基线（改动前）：

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 绿（api / coding-worker / web 三个 workspace 全过） |
| `npm run test:unit:api` | 见 §7.1 |
| `npm run test:unit:web` | 见 §7.1 |

# BOM 删除 + 空壳 BOM 自动清理（2026-11-05）

## 1. 用户原话与现场

> 「用户反馈，想修改销售单，但是销售单显示 bom 表已经建立，但是 bom 其实也没有填入内容，这时候怎么办？可不可以增加一个 Bom 表的删除键？或者有别的办法」

现场复现路径（只读排查，不改数据）：

1. 销售单已确认 → 采购/生产在 BOM 表页点「新建 BOM 表」，但没录任何明细行就关掉 → 库里留下
   `boms` 一行（`status = draft`、`bom_items` 0 行）。
2. 销售单编辑页改品名/数量/单价/税率等**核心字段**并保存 → 服务端 `SALES_ORDER_CORE_FIELDS_LOCKED`
   （「销售单已有 BOM、采购或生产下游事实，核心字段需先回退下游」）。
3. 想「回退草稿」再改 → 同样被 `SALES_ORDER_DOWNSTREAM_EXISTS` 挡住。
4. 想去删那张 BOM → **没有任何删除入口**：`BomsController` 只有 list/get/create/patch/put items。

结论：**空 BOM 被当成下游事实，而 BOM 本身又不可删** —— 这是一条死路，不是用户操作问题。

为什么空 BOM 会出现：BOM 是「先建壳、再录行」的两步操作（`POST /boms/from-sales-order/:id`
只建表头，明细由 `PUT /boms/:id/items` 整批替换）。点开看一眼、或者建完发现选错销售单，都会留下空壳。

## 2. 既有设计与本轮定位

schema 与采购计划侧**早就按「BOM 可以软删」设计**了，只是删除入口一直没实现：

- `purchase_plans.bom_snapshot` 注释：「BOM 被软删之后，计划上仍要看得见『这是哪一版 BOM 的计划』」；
- `purchase-plans.service.ts` 的 `get()` 下发 `bomDeleted`，`loadBomForRevert` 明确允许「BOM 已软删」；
- 计划删除的口径（`PurchasePlansService.remove`）也是「有已下单行才拒绝，否则软删头 + 行」。

所以本轮**不是新造一种删除语义**，而是把既有设计缺的那半截补上，并顺手拆掉「空壳即下游」这个误判。

## 3. 决策（用户 2026-11-05 拍板）

| # | 决策 | 理由 |
|---|------|------|
| D1 | BOM 支持**软删**（表头 + 明细行一起软删），不物理删 | 38 类下游表的外键全是 RESTRICT；BOM 还被采购单/生产单/采购计划按 `bom_id` 引用，物理删永远会被数据库拒绝。软删后既有行还在，引用不断 |
| D2 | **空 BOM 一键删**（0 明细、无采购计划、无采购单、无生产单，确认框即可，不填原因） | 用户要解决的正是这一种；它不含任何业务事实，删除不损失信息 |
| D3 | **有明细的 BOM 也能删，但必须填原因** | 建错单要能重做。填原因是宪法 Reversible Business Changes 的口径：删掉的是有人录过的内容 |
| D4 | 已被**未删除且未取消的采购单**、或**未删除的生产单**引用时**拒绝删除**，给出「先回退下游」的可操作提示 | 与销售单核心字段锁同一口径：已经采购/投产的事实不能靠删源撤销；采购单可「退回采购计划」、草稿生产单可直接删 |
| D5 | 采购计划**不阻止**删除 BOM，BOM 软删后计划独立存活（计划页显示「BOM 已被删除」） | 既有设计（2026-09-27 拍板）：计划是独立历史记录；`bom_snapshot` 保证来源可读 |
| D6 | 销售单**保存核心字段时自动清理「空壳 BOM」**：0 明细 + 无采购计划 + 无采购单 + 无生产单 → 同一事务内软删并写审计；没有明细或计划/下游的 BOM 仍然照旧挡住 | 用户不必绕到采购页；「自动清理」只碰「谁都没用过、也没录过内容」的壳，非空 BOM 的修改路径不变 |
| D7 | 回退草稿（`revertToDraft`）用同一条空壳判定，同样自动清理 | 否则「回退草稿」还是一条被空壳堵死的死路，与 D6 自相矛盾 |
| D8 | 被挡时的报错要**说清在挡什么、下一步去哪**（BOM 有几项明细 / 有采购计划 / 有采购单…），不再是一句笼统的「已有 BOM」 | 用户正是被这句笼统报错误导到「其实没内容」的困惑里 |

D6/D7 的自动清理**不算**用户的删除动作，所以不要求填原因；审计里带 `auto: true` 与固定理由，
销售单保存响应回 `released_empty_boms`，前端在成功提示里说出来（不静默）。

## 4. 接口契约

### 4.1 `GET /boms/:id/delete-preview`

权限沿用控制器 `@RequireAnyModules("procurement", "production")`（BOM 由采购与生产共同维护）。

```json
{
  "bom_id": "…",
  "order_no": "SO-20261105-0001",
  "version": 1,
  "status": "draft",
  "item_count": 0,
  "purchase_plan": { "id": "…", "plan_no": "PP-…", "ordered_line_count": 0 },
  "purchase_order_count": 0,
  "production_order_count": 0,
  "deletable": true,
  "blocked_reason": null,
  "reason_required": false
}
```

- `item_count` 只数**未删除**的 `bom_items`。
- `purchase_order_count` 只数未删除、`status != "cancelled"` 的采购单（已取消不是事实）。
- `production_order_count` 数未删除的生产单（任何状态；生产单只有草稿能删，非草稿引用即视为在用）。
- `purchase_plan` 取该 BOM 未删除的计划（一张 BOM 至多一份，部分唯一索引）；`ordered_line_count`
  是其中 `purchase_order_item_id IS NOT NULL` 的未删除行数（诊断信息，不改变可删性）。
- `deletable = purchase_order_count == 0 && production_order_count == 0`。
- `blocked_reason` 是一句人话，例如
  「这张 BOM 已被 2 张采购单引用：请先在采购计划里「退回采购计划」或取消这些采购单，再删 BOM」。
- `reason_required = item_count > 0 || purchase_plan != null`（计划存在时即使 0 行也算「已经被用过」，
  删它要在审计里说得清为什么）。

### 4.2 `DELETE /boms/:id`

Body：`{ "reason"?: string }`（`reason` 最长 500，`reason_required` 为真时必填）。

成功：`{ id, order_no, version, deleted: true, item_count }`。

拒绝：

| HTTP | code | 触发 |
|------|------|------|
| 404 | `BOM_NOT_FOUND` | BOM 不存在或已软删 |
| 422 | `BOM_HAS_DOWNSTREAM` | 有未取消的采购单 / 未删除的生产单引用（details 给 `{ bom_id, order_no, purchase_order_count, production_order_count }`；单据号明细不在这里再查一遍 —— 「什么算下游」只允许有 `bom-facts.ts` 一处定义） |
| 422 | `BOM_DELETE_REASON_REQUIRED` | `reason_required` 为真而没填原因 |

执行顺序（事务内、锁 `boms` 行后**重算**一次计数，防并发建单穿透）：
`FOR UPDATE` → 重读 BOM → 重算 facts → 校验可删/原因 → `bom_items` 全量软删 →
`boms` 软删 → 事务外写审计 `bom.delete`（`order_no`/`version`/`item_count`/`reason`/`purchase_plan_id`/
`purchase_order_count`/`production_order_count`）。

## 5. 改动清单

### API

- `apps/api/src/modules/sales/bom-facts.ts`（新，共享判定）：
  `bomFactCounts` / `salesOrderBomFacts` / `isEmptyShellBom` / `bomBlockedReason`。
  销售单与 BOM 删除两条路径用**同一份**「下游事实」定义，避免两处口径漂移。
- `apps/api/src/modules/sales/boms.service.ts`：`deletePreview`、`delete`；删除时表头与明细行一起软删。
- `apps/api/src/modules/sales/boms.controller.ts`：`GET :id/delete-preview`、`DELETE :id` + `BomDeleteDto`。
- `apps/api/src/modules/sales/sales-orders.service.ts`：
  - `update`：核心字段守卫改为「先判采购/生产事实，再判 BOM」；BOM 全是空壳 → 事务内清理并放行；
    有内容/有计划的 BOM → 422 且 details 说清每张 BOM 的明细数与是否有计划。
  - `revertToDraft`：同一条空壳判定，清理后再数 BOM。
  - 响应新增 `released_empty_boms`（`[{ bom_id, version }]`）。

### Web

- `apps/web/app/procurement/boms/page.tsx`：每行「删除」按钮 → `delete-preview` → 弹窗
  （信息行 + 需要时必填原因）→ `DELETE` → 刷新列表；被挡住时把 `blocked_reason` 作为错误提示。
  孤立 BOM 行要保留真实 BOM id（`bom_id`），不能拿 `salesOrderId` 当删除目标。
- `apps/web/components/bom/bom-workbench.tsx`：空表时的提示补一句「建错了可到【采购 → BOM表】删除；
  销售单修改核心字段时系统会自动清理这样的空壳」。
- `apps/web/components/sales/sales-order-editor.tsx`：保存响应带 `released_empty_boms` 时，
  成功提示写成「销售单已保存（已自动清理 N 张未填内容的空 BOM）」。

### 测试

- `apps/api/test/unit/bom-delete.test.cjs`（新）：空 BOM 一键删；有明细必须填原因；被采购单/生产单
  引用时拒绝；采购计划允许删且不连带删；软删表头与明细行；审计参数；预览字段。
- `apps/api/test/unit/sales-order-empty-bom-release.test.cjs`（新）：确认单改核心字段时全空壳 → 清理 +
  放行 + 响应 `released_empty_boms`；有明细/有计划/有采购生产事实 → 仍 422 且文案说清原因；
  回退草稿同口径。
- `apps/web/test/procurement-bom-page.test.tsx`：空 BOM 一键删（弹窗无原因字段）、有明细要原因、
  被下游挡住时显示 blocked_reason、删除后列表刷新。
- `apps/web/test/bom-workbench.test.tsx`：空壳提示文案。

## 6. 不做 / 已知边界

- **不**给 BOM 做「恢复」入口：软删行还在库里，真要恢复由运维按审计事件处理（与采购计划删除同口径）。
- **不**物理删任何行：外键 RESTRICT + 历史可追溯。
- **不**在 BOM 工作区里直接放删除按钮：删除是「销毁一张表」，放在列表面板上有确认框，
  工作区（Sheet）里只留指路提示；采购与生产两个入口都能从【采购 → BOM表】到达同一行。
- 非草稿生产单引用 BOM 时不能删（没有回退路径），这是有意的：已经投过产的 BOM 不允许消失。
- 历史订单号改名会同步改 `boms.order_no`（既有 `ORDER_NO_RENAME_TARGETS`），本轮不涉及。

## 7. 验收口径

1. 用户场景：销售单已确认 + 空 BOM → 编辑页改数量保存成功，成功提示说明「已自动清理 1 张空 BOM」；
   或到【采购 → BOM表】点删除，确认后 BOM 消失、销售单可改。
2. 有明细的 BOM：不被自动清理，销售单保存仍被挡，报错说「这张 BOM 有 N 项明细，先删除 BOM」；
   到 BOM 表删除时必须填原因，审计可查。
3. 已下单/已投产：删除 BOM 被拒绝，提示先回退下游；采购计划存在时 BOM 可删，计划页显示「BOM 已被删除」。
4. `npm run test:unit:api` / `npm run test:unit:web` / `npm run typecheck` 全绿。

# 原料库存按供应商分桶 + 现存原料数量（2026-11-13）

用户反馈三条：

1. 仓库 → 原料仓储情况，还需要一列「现存原料数量」。
2. 贴纸库存 36000 张，全部领出却提示库存不足。
3. 同一订单里同一型号物料（伞头）来自不同供应商，到货入库没问题，领料时无法分开领用。

生产库快照已拉到本地 docker 卷（容器 `dilee-prod-snapshot`，库 `dilee_erp`，端口 127.0.0.1:55433），
下文的行数/数值都来自该快照，不是推测。

## 1. 贴纸领不出的根因（已复现）

```
materials   MAT-20261010-0008 伞头贴纸  default_unit = 个
raw_material_inbounds  RM-9B3F44A5-145  3000 张  posted  精码
                       RM-9FE936A7-FE3 33000 张  posted  精码
inventory_facts        36000 张 raw_material raw_material_inbound
bom_items (DL260135)   伞头贴纸  unit=张  required=36000
```

`InventoryService.rawMaterialBalance(client, materialId, unitId)` 是**按单位**求和的，
而 `RawMaterialMovementsService.previewLines` 永远传 `material.defaultUnitId`：

```ts
const availableBefore = await this.inventory.rawMaterialBalance(client, material.id, material.defaultUnitId);
```

`defaultUnitId` 是「个」，库存落在「张」→ 可用量恒为 0 → `submitOutbound` 抛
`INSUFFICIENT_INVENTORY`。业务上「贴纸有 36000 张」与系统的「0 个」说的是同一个物料。

生产库当前有 2 个物料踩这个坑（`u.name <> du.name` 且余额非 0）：

| 物料 | 默认单位 | 实际库存单位 | 数量 |
|---|---|---|---|
| MAT-20261010-0008 伞头贴纸 | 个 | 张 | 36000 |
| MAT-20261012-0004 1.0金色全铜平面扣 | 打 | 码 | 800 |

**结论**：领料行的单位必须跟随 BOM 行的单位（BOM 行有 `unitId`），没有 BOM 行时才回落
`material.defaultUnitId`。同时「可用量」必须按该单位求，而不是按默认单位求。

历史数据不动（不把张改个）：`inventory_facts` 已经按张记账，改单位等于改事实。

## 2. 同型号多供应商（已复现）

```
bom_items (DL260135, 金色大弯伞头, 单位 打)
  富达             320
  远强（远诚）塑料 2680
raw_material_inbounds posted
  富达             320 打
  远强（远诚）塑料  546 打
```

三处硬约束把两行合并成一行：

- `previewLines` / `createIssue`：`seen.has(line.material_id)` → 同一 material 第二次直接 422；
- `raw_material_movement_lines` 没有供应商列，出库事实无法表达「扣的是谁家的料」；
- `InventoryService.rawMaterialBalances` 只按 `material + unit` 分组，余额天然把两家的料混在一起。

生产库里 BOM 行有供应商 360 / 518 行；BOM 供应商与到货供应商不一致的物料有 18 个
（例如吊牌：BOM 记德行，到货实际是瀚祺）——所以**出库必须允许显式指定供应商**，
不能只按 BOM 行的默认供应商推断。

## 3. 数据模型改动

### 3.1 `inventory_facts` 增加 `supplier_id`

```prisma
supplierId String? @map("supplier_id") @db.Uuid
supplier   Supplier? @relation(fields: [supplierId], references: [id])
@@index([materialId, inventoryCategory, unitId, supplierId])
```

- 入库过账：写 `inbound.supplierId`（入库单本来就有供应商）。
- 领料/补料出库：写 `movement_line.supplierId`。
- 退料/报废/冲销/盘点：沿用来料的供应商；取不到时写 `null`。
- `null` 是**未指定供应商**这一真实档位（历史 43 条 `material_issue` 事实都是 `null`），
  不是「无所谓」：`null` 档位的量可以被任意供应商的领料消耗，但**不能**冒充某一家。

### 3.2 `raw_material_movement_lines` 增加 `supplier_id`

```prisma
supplierId String? @map("supplier_id") @db.Uuid
supplier   Supplier? @relation(fields: [supplierId], references: [id])
@@index([movementId, materialId, supplierId])
```

### 3.3 迁移与回填

新迁移 `20261113xxxxxx_supplier_level_raw_material_stock`：

1. 加两列 + 两个索引（`IF NOT EXISTS`）。
2. 回填入库事实的供应商：
   `UPDATE inventory_facts f SET supplier_id = i.supplier_id FROM raw_material_inbounds i WHERE f.raw_material_inbound_id = i.id AND f.supplier_id IS NULL;`
3. 回填时先统计命中行数并写进迁移注释（快照上应为 54 行）。

出库历史事实保持 `null`（当时确实没记供应商，回填任何值都是编造）。

## 4. 接口契约（三个子任务共同遵守）

### 4.1 `GET /inventory/raw-material-balances`

默认行为**不变**（按 material + unit 聚合，跨供应商求和），保证原料仓储页、采购计划页、
盘点导入、Agent 工具零改动。

新增查询参数 `group_by=supplier`：返回行按 `material + unit + supplier` 拆分，并多三个字段：

```json
{ "material_id": "...", "unit_id": "...", "unit_name": "打", "order_no": null,
  "quantity": "546.0000",
  "supplier_id": "49e80402-...", "supplier_code": "S-001", "supplier_name": "远强（远诚）塑料" }
```

`supplier_id` 为 `null` 表示「未指定供应商」档位。默认（不带参数）的响应**不得**出现这三个字段，
否则前端按 `material|unit` 建索引的地方会被同键多行覆盖。

### 4.2 `POST /production/material-movements/issue-preview`

请求行新增可选 `supplier_id`：

```json
{ "production_order_id": "...",
  "lines": [{ "material_id": "...", "quantity": "320", "supplier_id": "...", "remark": "" }] }
```

响应每行新增/变更：

- `unit_id` / `unit`：**BOM 行的单位**（`bomItem.unitId`），BOM 行没有 `unitId` 或该物料不在 BOM
  时回落 `material.defaultUnitId`；
- `supplier_id` / `supplier_name`：回显请求值（未传则 `null`）；
- `available_before` / `available_after` / `inventory_quantity`：传了 `supplier_id` 时只算
  该供应商档位（含 `null` 档位中的可用量？**不算**——指定供应商时只看该供应商自己的量）；
  未传时算该 `material + unit` 跨供应商合计；
- 新增 `available_by_supplier: [{ supplier_id, supplier_name, quantity }]`：该 `material + unit`
  下各档位结存，供前端下拉里显示「富达 320 打 / 远强 546 打 / 未指定 0」。

### 4.3 `POST /production/material-movements`（领料）/ `/replenishments`

- 明细行接受可选 `supplier_id`；
- 唯一性口径从 `material_id` 改为 `material_id + unit_id + supplier_id`：
  同一物料、同一供应商重复 → 422 `INVALID_MATERIAL_MOVEMENT_LINE`；
  同一物料、不同供应商 → **允许**，各自成行。
- `unit_id` 与 preview 一致（BOM 行单位优先）。

### 4.4 读取接口

- `GET /production/material-movements` 与 `/:id` 的 `lines[]` 增加
  `supplier: { id, name, supplierCode } | null`。
- `GET /production/material-movements/:id/slip-document` 的 `document.lines[]` 增加
  `supplierName: string`（空串表示未指定）。

### 4.5 过账时的库存校验

`postOutbound` 的 `lockedPreview` 按同一套口径校验：每行按 `material + unit + supplier`
取可用量，扣减写事实时带上 `supplierId`。`null` 供应商的行只能消耗 `null` 档位的量
（避免把「未指定的料」算给某一家，也避免反向把某一家算成未指定）。

> 兼容性：生产库现有 43 条 `material_issue` 事实都是 `null` 档位，且当前没有进行中的领料草稿
> 依赖非 `null` 档位，所以这条严格口径不会挡住历史操作。若前端不传 `supplier_id`，
> 行为与今天一致（只校验 `null` 档位 + 该物料总额？——**不**，只校验 `null` 档位，
> 见下文「前端必须传」）。

因为严格按档位校验，前端**必须**把供应商带上来；不带就等于领「未指定」的料。
为避免误伤，`submitOutbound` / `postOutbound` 对未传 `supplier_id` 的行采用
「该 material + unit 全档位合计」的宽松口径（历史行为），只在传了 `supplier_id` 时按档位严格校验。
这条差异写进代码注释，并有用例钉住。

## 5. 「现存原料数量」列

用户选定口径：**现存 = 已过账库存 + 待入库（未过账）**，即物理上已在库的量。

原料仓储页当前列：物料 / 规格型号 / 单位 / 待入库（未过账） / 已过账库存 / 合计。
`合计` 已经是这个和，所以新增列与 `合计` 数值相同。为避免同页两列同值：

- 把 `合计` 改名为 `现存原料数量`，列为最后一列，并保留 `合计` 的计算口径不变；
- 页内说明写明：现存 = 已过账库存 + 待入库（物理在库，含未过账草稿）。

若用户要求同页两列并存，再加回 `合计` 即可（口径已抽成同一个函数）。

## 6. 实现要点（给并行实现者的硬约定）

`InventoryService` 新增（**签名固定，不要改**）：

```ts
/** 按 物料+单位+供应商 求余额；supplierId 传 null 表示「未指定供应商」这一档。 */
async rawMaterialBalanceBySupplier(client, materialId: string, unitId: string, supplierId: string | null): Promise<Prisma.Decimal>

/** 同单位下各供应商档位的结存（含 supplierId=null 的「未指定」档），供下拉展示。 */
async rawMaterialSupplierBuckets(client, materialId: string, unitId: string): Promise<Array<{ supplier_id: string | null; supplier_code: string | null; supplier_name: string | null; quantity: Prisma.Decimal }>>
```

其余必须同步的落点（漏一个就会「有的地方按供应商分、有的地方合计」，数字对不上）：

1. `postOutbound()`：余额键、`inventoryFact` 写入、advisory lock key 都要带供应商。
2. `reverse()`：净额分组的 key 从 `material|unit|category` 改为 `material|unit|category|supplier`；
   冲销明细行按 `materialId|supplierId` 建映射（同物料多供应商时，只按 materialId 会互相覆盖）。
3. `reopen()`：冲抵事实沿用来源事实的 `supplierId`。
4. `derivedLines()`（退料/报废）：从来源领料明细继承 `supplierId`。
5. `material-slip-export.service.ts` 的 `assemble()`：「已领数量」原本按 `material+unit` 聚合，
   同一物料多供应商时两行会显示同一个累计已领数 —— 必须把 `supplierId` 加入聚合条件。
6. 盘点（stocktake）不按供应商拆分：确认时把差额写进 `supplierId = null` 档位。
   因此该档位在界面上叫「**未指定 / 未分摊**」，它同时承担历史数据与盘点差额。

## 7. 不在本轮范围

- 打印件 / 导出 xlsx 的版式（`docs/samples/领料单-样例.xlsx` 是业务给定的纸样，
  加列会让纸与导出件对不上）。供应商只进页面详情表与列表，不进纸面。
- 张/个 这类单位换算（没有换算率主数据，任何自动换算都是编造）。
- 历史 43 条 `material_issue` 事实的供应商回填。

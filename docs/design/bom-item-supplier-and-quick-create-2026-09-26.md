# BOM 明细行「默认供应商」+ 下拉快速新建（2026-09-26）

> 用户原话：「针对 BOM 表，要新增一个 column，供应商。同时允许在下拉列表中快速新建。」

## 1. 三处已拍板的口径

| 问题 | 选择 | 影响 |
| --- | --- | --- |
| 供应商挂在哪一层 | **BOM 明细行**（每个部件一个默认供应商） | 迁移加两列到 `bom_items`，不是加在 `boms` 表头 |
| 要不要预填到采购单 | **不预填**，BOM 上的供应商只是备查信息 | 采购流程**零改动**；采购仍逐行自己选供应商 |
| 快速新建的入口 | **下拉里的「＋ 新建供应商「xxx」」** | 新建动作有上下文（用户已经在打名字了），少一次跳转 |

"备查"的含义写清楚：这一列回答「这个部件通常找哪家做」（伞骨找五金厂、伞布找纺织厂），
**不是**采购承诺、也不参与任何门禁与计算。将来若要改成"按 BOM 下单时带出供应商"，改的是
`PurchaseOrdersService` 的按 BOM 建单路径 —— 与本次的字段设计不冲突（数据已经在了）。

## 2. 现状（动手前确认过的）

- BOM 工作区 `apps/web/components/bom/bom-workbench.tsx` 由**采购与生产共用**，三个入口：
  采购→BOM表、采购单→编辑BOM表、生产→BOM表。
- 明细保存是**整块替换**（老行软删 + 新行批量建），并发用乐观锁 `expected_updated_at`
  （冲突 422 `BOM_UPDATE_CONFLICT`，前端不覆盖、只提示重新加载）。
- 供应商主数据已有接口：`GET /suppliers`、`POST /suppliers`（`code_mode: auto|manual`，与物料同一套约定）。
- 「新建物料」已有"就地新建 + 回填当前行"的先例（`components/bom/material-create-dialog.tsx`）。

## 3. 字段设计

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `bom_items.supplier_id` | `UUID NULL` | 引用 `suppliers(id)`，**可选关系** |
| `bom_items.supplier_snapshot` | `JSONB NULL` | `{ id, supplierCode, name }`：供应商改名/停用后，BOM 上仍看得见当时记的是哪一家 |
| 索引 | `bom_items_supplier_id_idx` | 「这个供应商供哪些部件」要能查 |

三条取舍：

1. **可空**：历史 BOM 行没有供应商，加 NOT NULL 会让迁移在真实库上直接失败。
2. **`ON DELETE SET NULL ON UPDATE CASCADE`**：Prisma 对可选关系一律生成 SET NULL；
   写错会让 `prisma migrate diff` **长期**报漂移（漂移不报错、只是悄悄攒着，本仓库有过 6 行漂移的教训）。
3. **引用 + 快照并存**：引用保证主数据是唯一真源；快照保证改名/停用后记录还在。
   没选供应商时写 **`Prisma.DbNull`（SQL NULL）**，不是 `Prisma.JsonNull`
   —— 后者存的是 JSON 的 `null` 字面量，`WHERE supplier_snapshot IS NULL` 找不到它。

## 4. 接口

- `PUT /boms/:id/items` 的 `BomItemDto` 新增 `supplier_id?: string`（`@IsOptional() @IsUUID()`）。
- `BomsService.replaceItems`：与**单位**同一套校验（存在 + 启用 + 未软删），
  不合法抛 422 `BOM_SUPPLIER_NOT_FOUND`；落库写 `supplierId` + `supplierSnapshot`。
  - 只有真的填了供应商时才查那张表：轻量单测桩与其他老调用方没有 `supplier` 表也能跑
    （与 `unit` / `material` 的既有写法一致）。
- `BomsService.get` 的明细 `include` 里带上 `supplier: { id, supplierCode, name, isActive }`
  —— BOM 表要显示当前供应商，改名后也能显示最新名字。

## 5. 前端

- 新组件 `components/bom/supplier-select.tsx`：包一层 `SearchableSelect`，
  在选项末尾合成一个「＋ 新建供应商「<已输入的词>」」；选它即用该词作名称打开新建弹窗。
  - **名称与已有供应商相同时不提供"新建"**：那会撞 `suppliers.name` 的唯一约束，
    而正确的动作本来就是"选那一家"。
  - 新建失败（如编码冲突）弹窗**不关、已填内容不丢**、原因显示在弹窗里（沿用 ActionDialog 的行为）。
  - 新建走既有 `POST /suppliers`，成功后**自动选中**并通知调用方把它并进自己的供应商池。
- `bom-workbench.tsx`：新增「供应商」列（在"单位"之后）；**供应商池由工作区自己加载**
  （三个入口不必各写一遍；拉不到只影响下拉为空，不影响 BOM 打开与保存）。
  - 当行的供应商已停用（不在池里）时，用 `supplierSnapshot` 兜底显示 ——
    否则用户会以为这一格空了，一保存就把记录抹掉。
- `procurement/orders/page.tsx`：把新建的供应商并进它自己的池（那一页本来就有供应商列表）。

## 6. 范围之外

- **BOM 明细批量导入不含供应商列**（用户没提；导入映射加一列是另一件事）。
- **采购单流程零改动**（见 §1）：不预填、`PurchaseOrderItem.supplierId` 与它的快照都没碰。
- 不做"按供应商归集 BOM"的报表（索引已经建好，将来要做不用再迁移）。

## 7. 验收与验证

| # | 验收点 | 用例 |
| --- | --- | --- |
| 1 | 只给 `bom_items` 加两列 + 一索引 + 外键（SET NULL） | `apps/api/test/unit/bom-item-supplier-migration.test.cjs`（7 条） |
| 2 | 选中供应商后保存：请求体带 `supplier_id`，落库写 id + 快照 | `apps/api/test/boms.test.cjs`（4 条）+ `apps/web/test/bom-supplier.test.tsx` |
| 3 | 不存在/已停用的供应商被拒（422 `BOM_SUPPLIER_NOT_FOUND`） | 同上 |
| 4 | 留空写 SQL NULL；轻量桩（无 supplier 表）也能保存 | 同上 |
| 5 | 表头出现「供应商」列，每行一个选择器 | `bom-supplier.test.tsx` |
| 6 | 下拉里能搜到已有供应商；输入新名字出现「＋ 新建」；建完自动选中 | 同上 |
| 7 | 同名不提供「新建」；新建失败弹窗不关、内容不丢 | 同上 |
| 8 | 已停用的供应商在行内仍显示（快照兜底），保存不被抹掉 | 同上 |

命令：`npm run typecheck` → `npm run test:unit:api` → `cd apps/web; npm run test:unit`。

## 8. 实施结果（2026-09-26）

| 层 | 落地物 |
| --- | --- |
| 数据 | `bom_items` 两列 + `bom_items_supplier_id_idx` + 外键（SET NULL）；迁移 `20260927180000_bom_item_supplier` + 7 条守卫 |
| 接口 | `BomItemDto.supplier_id`；`replaceItems` 校验（422 `BOM_SUPPLIER_NOT_FOUND`）与落库（id + 快照 + DbNull）；`get` 带供应商关系 |
| 界面 | `components/bom/supplier-select.tsx`；BOM 工作区新增列 + 自取供应商池；采购单页把新建的供应商并进自己的池 |

验证：`npm run typecheck` 双绿；API **2139/2139**；web lib **284/284**；web 组件 **59 文件 1015 条**。

**未验证**：迁移没有在真实 PostgreSQL 上执行过（本机无库）；下拉弹层的定位与列宽观感未在真实浏览器目测
（jsdom 不排版）；`GET /suppliers` 在 BOM 工作区里是新增的一次请求，与采购单页各自的池可能短暂不一致
（已在采购单页用 `onSupplierCreated` 合并）。

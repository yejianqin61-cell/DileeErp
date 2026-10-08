# 材料明细「其它」：自定义类目行（2026-10-08）

## 0. 用户原话与那一问

> 「1.然后编辑销售订单的材料明细最后还需要加一个"其它"，可以自行添加类目。有时候还需要别的物料。
> 允许用户增删改。」

先问后做（题目给推荐项、等用户选）：

| 问题 | 选项与回答 |
|---|---|
| 「其它」行要不要也能像 18 格一样引用物料清单里的物料（带缩略图、导出可勾选带图） | **要，和 18 格一致** ✓ |

设计目标就一句：**材料明细末尾要能写下模板之外的物料，类目名由用户自己起，可增、可删、可改**。

## 1. 为什么需要这张表

材料明细那 18 项是**模板上印死的栏位**（2026-09-16 用户拍板「按两张样本的并集做成固定字段」，
见 `docs/design/sales-order-spec-refinement-and-production-sheet-export-2026-09-16.md`），
落在 `sales_orders` 的 18 个 `*_spec` 列上。模板之外偶尔还会用到别的物料（弹簧、螺丝、胶袋…），
这类物料既没有列、也没有稳定的栏位名 —— 加列加不出来，只能加**行**。

## 2. 数据模型：`sales_order_material_extras`

```prisma
model SalesOrderMaterialExtra {
  id, salesOrderId, label(VarChar 50), content(VarChar 1000 可空), materialId(FK 可空),
  sortOrder, 审计六列 + deletedAt/deletedBy
  @@index([salesOrderId, sortOrder]), @@index([materialId])
}
```

三条取舍（完整理由写在 `apps/api/prisma/schema.prisma` 的模型注释上）：

1. **为什么不复用 `sales_order_spec_details`**（同为「一行一条」的表）：那张表的形状是
   「分组名 + 品番/品名 + 颜色 + 条码 + 数量 + 单位」，导出时落在工艺单**下半部的明细区**；
   「其它」是材料区的一块，形状只有「类目 + 内容（+ 引用）」。混用就得让导出侧靠 `group_name`
   猜「这行到底是明细还是材料」，猜错就是整块版面错位。
2. **为什么不进 `sales_order_material_refs`**：那张表的唯一键是 `(sales_order_id, spec_key)`，
   而 `spec_key` 的语义是「18 个栏位之一」。「其它」行的条数用户随时增删，没有稳定的栏位键；
   拿序号当键的话，删掉中间一行会让后面每一行的引用整体错位 —— 而错位的表现是「图配到了别的物料上」，
   在纸上看不出来。所以引用是**这一行上的可空外键**。
3. **没有唯一键 + 软删父亲**：与整条销售链其他附表一致（草稿删除是软删，外键 RESTRICT）。

## 3. 语义：整块替换 + 上限

与 `spec_details` / `material_refs` 完全一致（`sales-orders.service.ts:941` `replaceMaterialExtras`）：

| 请求里的 `material_extras` | 含义 |
|---|---|
| 不传 | 整块不动（连查都不查） |
| `[]` | 全部删掉（软删现有行） |
| 若干行 | 软删现有行 + 按数组顺序重建（行 id 会变） |

校验（`normalizeMaterialExtras`，`sales-orders.service.ts:239`；错误码逐条可点名）：

| 规则 | 错误码 |
|---|---|
| 类目必填（去空格后） | `MATERIAL_EXTRA_LABEL_REQUIRED` |
| 类目 ≤ 50 字 | `MATERIAL_EXTRA_LABEL_TOO_LONG` |
| 内容 ≤ 1000 字 | `MATERIAL_EXTRA_CONTENT_TOO_LONG` |
| 内容与引用**至少有一个** | `MATERIAL_EXTRA_CONTENT_REQUIRED` |
| 最多 20 行 | `MATERIAL_EXTRA_LIMIT_EXCEEDED` |
| 引用的物料必须存在且未删 | 复用 `MATERIAL_NOT_FOUND` |

「内容与引用至少有一个」是刻意的：工艺单是给工厂照做的，一行只有类目、右边一格空着，
工人只会来问「这个到底要什么」。**先校验、后写**：任一行不合法时一个字节都不写。

上限 20 的理由是纸：工艺单是一张 A4 纸，材料区 18 行 + 20 行已经很长了。

## 4. 界面：材料明细面板里的一个子块

- 位置：与 18 格**同一块面板**（用户说的就是「材料明细最后」），CSS 分块见 `globals.css`
  的 `.material-extra-block` / `.material-extra-row`；组件在 `sales-order-editor.tsx:711` 起。
- 每一行三样：`类目` 输入框、`内容` 文本域、`从物料清单引用…`（可搜索下拉 + 缩略图 + 清除引用），
  外加「删除这一行」；区块头有「加一行」，到上限时按钮禁用并给出提示（`MATERIAL_EXTRA_LIMIT`）。
- 增删改都在本地 state 里做，保存时随单一起提交（不另开接口）：
  这与 18 格、明细、引用三块的既有形态一致 —— 一张销售单只有**一个**保存按钮。
- 校验在页面先拦一刀（`validateMaterialExtras`，逐行给出「第 N 行：原因」），后端仍会独立再判一次。

**与 18 格故意的两点不同**（都写在代码注释里）：

1. 选中物料时**只在内容为空时**预填「名称 规格 颜色」。18 格是模板上固定的「某部件的规格」，
   选中就是替人省掉手打；而「其它」行的内容是人手写的自由文本（可能写着
   「弹簧 5cm 不锈钢（按上次那批）」），无条件覆盖等于把工厂要照做的那句话悄悄改掉。
   引用本身照记（缩略图与导出带图都靠它）。
2. 「删除这一行」没有任何占位规则（明细表会保底留一行空行，「其它」允许 0 行）。

## 5. 导出：工艺单材料区 + 图片导出

1. **工艺单正文**（`sales-order-export.service.ts:127` `extraLines`）：这些行印在 18 项**之后**，
   类目名就是用用户起的字；内容取「人写的字」优先、空则退回引用物料的摘要 ——
   与 18 格同一条兜底规则（那条规则是 2026-09-26 现场问题换来的）。内容与引用都空的行不印
   （「空盘位自动省略」不变）。细分明细区在材料区之后，位置不动。
2. **图片导出候选**：这些行的键是 `extra:<行 id>`（`materialExtraRefKey`，`export.service.ts:47`），
   排在 18 项之后，标签用类目名；候选与实际嵌图**共用同一份查找表**
   （`materialRefLookup`），避免「弹窗里勾得到、导出时报没有图」这种两套映射的分叉。
3. **为什么键用行 id 而不是行序号**：行是整块替换语义、每次保存 id 都变。候选过期时按 id 查不到
   → 报「这一格没有可导出的图片」，重开一次弹窗就好；按序号查会在序号仍然有效时
   **把图悄悄配到另一行上**，而那种错在纸上看不出来。
4. 顺手把 multipart 的 `files` 上限从写死的 20 改成 `18 + MATERIAL_EXTRA_LIMIT`
   （`sales-orders.controller.ts`）：上限不跟着「能勾的格子数」走的话，勾满就会撞
   multer 的 `LIMIT_FILE_COUNT`，报一个用户看不懂的错。体积闸门仍在下游（单张 2MB + 合计 12MB）。

## 6. 返单与版本快照

- **版本快照**：`material_extras` 与 `spec_details` / `material_refs` 同一条规矩 ——
  这次请求带了才进快照，进的是整块（`specSnapshotSource` / `specSnapshotFields`）。
  「这一版下给工厂的材料口径」必须回看得出来。
- **返单**：请求没带就照抄来源单（含引用的物料摘要，编辑器不必依赖物料池请求成功）；
  请求带了就按请求的。来源单引用的物料**已被删**时：**保留那一行的文字、只摘掉引用**
  （与 18 格的引用不同 —— 那里剩下的是一格可能为空的文字，这里剩下的是用户写的规格说明），
  并把这件事回报成 `reorder_warnings` 的一条，不静默。

## 7. 顺手修掉的一处既有缺口

`sales-order-export.service.ts` 取物料摘要的 select 里**漏了 `specificationModel` 与 `color`**：
测试夹具带着这两个字段（所以单测全绿），而真实导出里「引用了物料但格子里没写字」的兜底文字
只有「MAT-1 伞骨」——规格与颜色在纸上消失。这正是 2026-09-26 那类现场问题的同一处。
现在抽成 `EXPORT_MATERIAL_SELECT`（`export.service.ts:34`），固定栏位与「其它」行共用一份，
并加了一条**钉住查询参数**的测试（夹具比真实查询更"全"是这类漏洞的温床）。

## 8. 已知边界（有意不做 / 做不到）

1. **没有独立 CRUD 接口**：一切都是「随销售单保存」，所以「其它」行的增删改在点保存之前不落库。
   与明细、引用一致；换来的是没有第二条写路径。
2. **行 id 每次保存都变**（整块替换的代价）。对界面无感，对图片导出候选有意义 —— 见 §5.3。
3. **不参与「明细数量合计 vs 单头数量」核对**：那些行没有数量/单位（模板的材料区本来也没有），
   给它们编一套数量口径只会造出一个用户看不懂的提示。
4. **不做类目字典 / 跨单复用**：用户要的是「自行添加类目」，类目名单不另立主数据，
   否则又多一份会漂移的真源（与货号「清单是投影、不建主数据表」同一条理由）。
5. **端到端未实测**：本环境没有 Postgres、也没有跑起来的 API，所以迁移与新表只在
   文本/SQL 形状、服务层单测、请求契约、导出件的字节层面验证过；**首单建议人工核对**
   「界面填 → 库里存 → 工艺单印 → 带图导出」四处。
6. 「其它」行**不进删除守卫的下游盘点**（它与版本快照/明细/引用一样，是草稿自带的内容，随父单软删）。

## 9. 验证

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | 双工作区干净 |
| `npm run test:unit:api` | **2325/2325**（+15 `sales-order-material-extras.test.cjs`、+2 DTO 契约） |
| web `npm run test:unit` | lib **308/308** + components **1055/1055**（+6 组件用例、+6 lib 用例） |
| `npm run build --workspace=@dilee/web` | 通过 |
| `npm run db:generate --workspace=@dilee/api` | 通过（新模型已生成，全量类型检查通过） |

新增/改动的测试文件：
`apps/api/test/unit/sales-order-material-extras.test.cjs`（新）、
`apps/api/test/unit/sales-order-dto.test.cjs`、
`apps/web/lib/sales-order-spec.test.mjs`、
`apps/web/test/sales-order-material-extra.test.tsx`（新）；
另修了 4 个既有服务夹具（返单来源单必须带上 `materialExtras`，否则返单复制会以
`Cannot read properties of undefined` 炸掉 —— 真实查询 `include` 一定会带这个关系）。

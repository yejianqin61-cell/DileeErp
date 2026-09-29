# 采购计划与按供应商收束下单（2026-09-27）

> 用户原话：
> 「现在，生产模块里面的 BOM 表里面不用填写供应商。然后采购模块那边多一个采购计划栏目。采购计划就承接的是
> 原来的采购单草稿。在采购计划里面，每个销售单对应一份的 BOM 对应一份的采购计划。还要加上供应商，供应商地址，
> 联系人这些 column。然后根据供应商收束下单，下单到采购单模块。也就是说，采购单模块就是所有已经经过供应商
> 收束下单的采购单了。注意，表单要保证一次性展示所有 column。可以限制每个 column 的宽度，如果超出就省略。
> 鼠标 hover 的时候再展示全部文本。」
>
> 本文档是实施依据。口径在实现中不得擅自改变；要改先改本文档，并在 `docs/log/` 里记下改的理由。

---

## 1. 这次为什么反转了一条有档案的决定

2026-08-20 采购模块集中确认时写的是「什么狗屁采购计划？只有采购单」
（`docs/memo/0820-采购模块集中待确认事项.md:43-45`），2026-09-17 的设计文档第 6 节据此明确
「**不给采购单加「采购计划」实体**」（`docs/design/purchase-order-collapse-and-edit-2026-09-17.md:213`）。

这次要加回来，**不是**当时判断错了，而是**粒度变了**：

| | 采购单 | 采购计划 |
| --- | --- | --- |
| 粒度 | 一个供应商 × 一个币种 | 一个销售单 / 一份 BOM |
| 头部语义 | 供应商、币种、金额**都有单一含义** | 这三样在下单前**没有**单一含义 |
| 寿命 | 对外的凭证（发出去就冻结） | 内部的工作台（一直改到买完） |

当时的"草稿"是多供应商工作台硬塞进单供应商凭证的产物：保存草稿要**按供应商拆成 N 行**
（`purchase-orders.service.ts:71-85` 的 `createSplit`），拆完之后每行的头部
`supplier_id` / `currency` / `total_amount` 才勉强有意义。用户这次要的是
「一个销售单的一份 BOM ↔ **一份**计划，计划里同时有多个供应商的行」——这个粒度
**装不进**采购单，所以才有这张表。

**保留的旧决定**：仍然不引入 `superseded` 状态、仍然不给采购单加第五个状态值
（见 `purchase-order-collapse-and-edit-2026-09-17.md:215`）。本次新增的状态全部在计划这一侧。

---

## 2. 口径（15 条，实现中不得擅自改）

| # | 口径 | 理由 / 代价 |
| --- | --- | --- |
| 1 | 新建 `purchase_plans` + `purchase_plan_items` 两张表；**"一份 BOM 一份计划"由数据库保证** | 粒度不同（见 §1）。部分唯一索引见 §3.3，漂移代价见 §7.3 |
| 2 | 计划**手动新建**（选一张还没有计划的 BOM），诞生时**自动带出该 BOM 全部明细行**，行可删、可加 | 计划的身份是"这张 BOM 的采购工作面"，那它诞生时就该已经包含全部需求——这是"漏买部件"唯一的防法。空计划噪音（"自动为每张 BOM 生成"）不做 |
| 3 | BOM 的「供应商」列**只在采购侧显示**（生产侧隐藏）；新建计划时从 BOM 行**预填供应商** | BOM 那列回答"这个部件**通常**找哪家"（跨订单、跨返单长期有效），计划回答"**这一批**找哪家买"。前者是后者的默认值，采购员只处理例外 |
| 4 | 供应商列 = **下拉选择 + 下拉里快速新建**（复用 `components/bom/supplier-select.tsx`）；**供应商地址 / 联系人**是选中那家供应商的**只读派生**，计划里不可改 | 地址/联系人是主数据的事实，不是采购员的决策。"这批送到别处"走采购单已有的「交货地址」字段（`purchase_orders.delivery_address`） |
| 5 | 「一次性展示所有 column」**两个表都做**：只读列表能 hover 看全文；明细编辑表只能保证"列不超出容器" | 编辑格里是输入框/下拉框，对输入框做省略号没有意义（输入框本来就能横向滚动看全） |
| 6 | 下单**多波次**：勾选本次要下的行（默认全选）→ 按供应商收束 → 落 N 张采购单；**下过的行留在计划里**并显示 PO 号 | 分批下单是采购现实（这家先下、那家还在等图纸）。已下单行离开工作面 = 没人再想得起来还差什么 |
| 7 | 数量/单价/供应商的**唯一编辑点是计划**；采购单页只保留打印字段（付款方式/交期条款/交货地址/回签） | 两个模块都能改数量 = 把「下单状态没及时更新」那类 bug 制度化（`orders/page.tsx:139-140` 的注释就是为它写的） |
| 8 | 历史草稿**迁移时归并成计划**（按 `bom_id` 分组，供应商/单价/交期原样保留），原草稿行软删 | 草稿里是采购员逐行填过的数据，丢掉是真实劳动损失。代价=搬数据的迁移本机无法验证（§7.2） |
| 9 | 计划明细 **13 列**：选择 / 名称 / 型号 / 下单状态 / 本次采购量 / 当前库存量 / 单位 / 单价 / **供应商** / **供应商地址** / **联系人**（含电话，合并一列）/ 预计到货 / 操作。「需求量」**改名**「本次采购量」 | 14 列在 1366px 上每列不到 100px，实际没法用。`contact_name` + `phone` 合并成「张伟 / 13800000000」 |
| 10 | **计划行不存币种**；币种在**收束下单预览里按供应商分组各选一个**（默认 CNY） | 币种是"一张采购单"的属性，而一张采购单=一个供应商。计划是"还没成为采购单"的工作面，不该提前替某张单决定币种 |
| 11 | 新路由 `/procurement/plans` + 采购枢纽页卡片；采购单页**去掉**「新建采购单」、「草稿」筛选 tab、「编辑明细」，「回到草稿」→「**退回采购计划**」 | 每个动作只有一个入口。"不建计划直接下单"的旁路**不做**：只要存在一条不经过计划的单，计划的计算就不再权威，而不可信的计划最后一定被绕过 |
| 12 | BOM 后续变更**不同步**进已有计划；但在计划列表上提示「这张 BOM 比计划多 N 个物料」 | 计划可能已经部分下单，自动同步会把"已下单"的行偷偷改成别的物料=数据损坏。漏买靠**人看提示**兜，不靠系统替他改数据 |
| 13 | 「下单状态」保留**累计口径**（这个物料累计买了多少 / 还要多少），第二档「草稿中」→「**计划中**」（数据源从草稿采购单改为**计划行**）；本行另标 PO 号 | 两个问题都答得了：**还差多少**（累计）+ **这行处理了没**（本行）。草稿时代的数据源过时了，不是这个列过时了 |
| 14 | 计划列表：计划编号 / 销售单号 / **货号** / 客户 / BOM 版本 / 行数 / 未下单行数 / 状态 / 最后更新（人 + 北京时间）。**不做** Excel 导出 | 货号是 2026-09-26 那批「返单」的归集键，计划列表能按它筛=采购员能回答"这个货号每批都买了什么、找的哪家"。导出用户没提，不擅自加 |
| 15 | 计划**未下单过可软删**；BOM 被软删后计划**独立存活**；已下单可**退回采购计划**（原因必填、该单无任何到货事实） | 三种真实场景都要有出路。第 ③ 条是本次唯一新增的可逆动作，**退回不删数据**（数量/单价/供应商留在计划行上） |

---

## 3. 数据模型

### 3.1 两张新表

```
purchase_plans
  id / plan_no(PP-YYYYMMDD-XXXXXXXX, unique) / order_no / sales_order_id
  bom_id / bom_version / bom_snapshot
  extension_data / 审计六列(created_at/updated_at/created_by/updated_by/deleted_at/deleted_by)

purchase_plan_items
  id / plan_id / sequence
  material_id / material_snapshot / unit_id / unit_snapshot
  bom_item_id(可空) / supplier_id(可空) / supplier_snapshot(可空)
  model / quantity / unit_price / expected_date
  purchase_order_item_id(可空, unique)   ← 「已下单」就是这个链接非空
  extension_data / 审计六列
```

### 3.2 为什么计划行与采购明细是 1:1 链接

`purchase_plan_items.purchase_order_item_id` 是「这一行已经下过单了」的**唯一表示**：

- 下单：在同一个事务里建采购单 + 明细，再把计划行的 `purchase_order_item_id` 指过去。
- **退回采购计划**：软删那张采购单与它的明细，再把指向它们的计划行的
  `purchase_order_item_id` 清空 —— 行回到「未下单」，而**数量/单价/供应商原样保留**。
  不用复制数据、不用重录，天然可逆。
- 多波次下单天然成立：一次只给勾选的行写链接，没勾的行保持空。

`@unique` 保证一条采购明细只能被一行计划认领（不能两个计划行指向同一条采购明细）。

### 3.3 「一份 BOM 一份计划」用部分唯一索引，**不在 schema 写 `@unique`**

`purchase_plans.deleted_at` 是软删列。若在 `schema.prisma` 里写 `@unique`（或 `@@unique([bomId])`），
生成的是**全量**唯一索引，那么"软删掉一份计划之后再也建不出第二份"——而这正是口径 15 要允许的事。

因此照抄 `20260826100000_unique_editable_bom` 的做法：

```sql
CREATE INDEX "purchase_plans_bom_id_idx" ON "purchase_plans"("bom_id");
CREATE UNIQUE INDEX "purchase_plans_bom_id_active_key" ON "purchase_plans"("bom_id") WHERE "deleted_at" IS NULL;
```

schema 里只声明 `@@index([bomId])`。漂移代价见 §7.3。

### 3.4 外键动作（写错会让 `migrate diff` 长期报漂移）

| 列 | 关系 | 必须写成 |
| --- | --- | --- |
| `purchase_plan_items.supplier_id` | `Supplier?` | `ON DELETE SET NULL ON UPDATE CASCADE` |
| `purchase_plan_items.bom_item_id` | `BomItem?` | `ON DELETE SET NULL ON UPDATE CASCADE` |
| `purchase_plan_items.purchase_order_item_id` | `PurchaseOrderItem?` | `ON DELETE SET NULL ON UPDATE CASCADE` |
| `purchase_plan_items.material_id` / `unit_id` | 必填 | `ON DELETE RESTRICT ON UPDATE CASCADE` |
| `purchase_plans.bom_id` / `sales_order_id` | 必填 | `ON DELETE RESTRICT ON UPDATE CASCADE` |

「供应商地址/联系人」**不落列**：它是选中供应商的只读派生，加了列就有两个真源。
（下单时冻结进采购单的那一份走 `supplier_snapshot`，见 §5.4。）

### 3.5 快照口径

- 计划行存 `material_snapshot` / `unit_snapshot` / `supplier_snapshot`，与采购明细同一形状。
- 计划头存 `bom_snapshot`（BOM 被软删后计划仍能说明"这是哪一版 BOM 的计划"）。
- `bom_snapshot` / `supplier_snapshot` 的"没有值"必须是 **`Prisma.DbNull`（SQL NULL）**，
  不是 `Prisma.JsonNull`（JSON 的 `null` 字面量）—— 后者会让 `WHERE x IS NULL` 查不到
  （2026-09-26 那批已经踩过一次，测试里钉着）。

---

## 4. 生命周期

### 4.1 计划状态是**派生**的，不落列

| 显示 | 判据 |
| --- | --- |
| 未下单 | 所有行 `purchase_order_item_id` 都为空 |
| 部分下单 | 有行已下单，也有行为空 |
| 已完成 | 所有行都已下单 |

不新增手工状态字段：手工状态一定会和行状态漂移。

### 4.2 「下单状态」四态（口径 13）

`GET /purchase-orders/bom-item-status?bom_id=` 的四档改为：

| 档 | 数据源 |
| --- | --- |
| `ordered` 已下单（足量） | 采购明细（`ORDERED_PURCHASE_STATUSES`），口径不变 |
| `partial` 部分下单 | 同上，口径不变 |
| `draft` **计划中** | **计划行**（`purchase_order_item_id IS NULL` 的行）的 `quantity` 之和 + 计划编号 |
| `none` 未下单 | 以上都没有 |

字段名保留 `draft_quantity` / `draft_purchase_order_nos`（避免动 4 个前端文件的契约），
但语义变成"计划中"；`state` 枚举值 `draft` 同样保留，前端文案改成「计划中」。

**行 ID 被换掉的摊回逻辑必须一起搬过来**：`BomsService.replaceItems` 是"软删全部旧行 + 整批建新行"，
存一次 BOM **所有行 ID 都会换**。计划行的 `bom_item_id` 也存的是当时那一版，所以计划行的累计
同样要按 §`bomItemOrderStatus` 既有的"行 ID 精确归集 → 换掉了就按物料摊回该物料第一行"处理
（`purchase-orders.service.ts:205-245` 的注释是这条的完整来历，别删）。

### 4.3 退回采购计划

`POST /purchase-orders/:id/revert-to-plan`，`reason` 必填。前置条件与既有 `assertEditable` 一致
（没有任何到货事实）。事务内：

1. 校验：**可退 = `status === "ordered"` 且该单没有任何到货事实**
   （`partially_arrived` / `arrived_complete` 必然已经有到货，`cancelled` 已经作废，
   迁移之后不会再有 `draft`）。错误码沿用既有的 `PURCHASE_ORDER_NOT_REVERTIBLE`，不新造同义码。
2. 找到目标计划：该单 `bom_id` 对应的未删计划；**不存在就自动补建一份**（口径 15）。
   连 `bom_id` 都没有的历史单 → 422 `PURCHASE_ORDER_WITHOUT_BOM_NOT_REVERTIBLE`。
3. 把指向这张单明细的计划行 `purchase_order_item_id` 清空。
4. 软删该采购单及其明细；`status` 记 `cancelled`。
5. 审计 `purchase_order.revert_to_plan`（含 PO 号、计划号、原因、行数）。

作废的采购单**不进采购单列表**（口径 11 + §5.2），只在审计里可查。
`POST /:id/revert-draft` 端点**删除**（草稿不存在了，它没有语义）。
`POST /:id/cancel` 同样删除 —— 它只允许取消 `draft`（`purchase-orders.service.ts:383`），
草稿消失后它是死代码；"供应商说做不了"的出口改成退回计划。

---

### 4.4 已下单的行在计划里还能改什么

一行一旦已下单（`purchase_order_item_id` 非空），它的内容就归那张采购单了。保存计划时：

| 字段 | 能不能改 | 为什么 |
| --- | --- | --- |
| 物料 / 单位 / 数量 / 单价 / 供应商 / 型号 | **不能** | 这些是"跟供应商谈定了什么"。计划里改掉，系统就出现"这张单的明细在计划里查不到"的状态，而「这张 BOM 还差什么没买」立刻失真。要改先**退回采购计划** |
| `sequence`（序号） | 能 | 只是展示顺序，不是业务内容 |
| `expected_date`（预计到货） | 能，**并同步写进对应的采购明细** | 它是「**预期**」不是「既成事实」（供应商说这周到不了、下周到）。而口径 7 已经关掉了采购单页的明细编辑——这里若也锁死，系统里就**再没有任何地方**能改这个日期。同步是为了不让同一行有两个预计到货 |

---

## 5. API 契约

新模块 `apps/api/src/modules/procurement/purchase-plans.{module,controller,service,domain}.ts`，
控制器 `@Controller("purchase-plans")`、`@RequireModules("procurement")`，与采购单同一道门。

### 5.1 端点

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `GET` | `/purchase-plans` | 列表（口径 14 的列）；参数 `order_no` / `item_no` / `status`（未下单/部分下单/已完成）/ `q` |
| `GET` | `/purchase-plans/plan-candidates` | 可建计划的 BOM 清单（已确认销售单 + 有 BOM + 还没有未删计划） |
| `POST` | `/purchase-plans` | 新建：`{bom_id}` → 自动带出全部 BOM 明细行（含从 BOM 行预填的供应商、BOM 需求量作为数量、单价 0） |
| `GET` | `/purchase-plans/:id` | 详情：头 + 行（含供应商地址/联系人/累计下单状态/本行 PO 号）+ `bom_extra_material_count`（口径 12 的提示） |
| `PATCH` | `/purchase-plans/:id` | 保存：整体替换行（软删旧行 + 建新行），乐观锁 `expected_updated_at`；已下单的行**不允许被删或被改成别的物料** |
| `DELETE` | `/purchase-plans/:id` | 软删；**只要有任意一行已下单就 422** `PURCHASE_PLAN_HAS_ORDERED_LINES` |
| `POST` | `/purchase-plans/:id/order` | 收束下单：`{groups:[{supplier_id, currency, items:[plan_item_id...]}]}`，同供应商合一张单；返回落成的采购单 |

### 5.2 采购单侧的变化

| 端点 | 变化 |
| --- | --- |
| `GET /purchase-orders` | **只返回已下单及之后**（`ordered` / `partially_arrived` / `arrived_complete`）；`cancelled` 与历史遗留 `draft` 不进列表 |
| `POST /purchase-orders` | 保留（内部/兼容用），但前端不再调用 |
| `POST /purchase-orders/split` | 保留（计划下单复用它的分组口径），但 `place_order:false` 的用法**废弃** |
| `PATCH /purchase-orders/:id` | **改为只接受打印字段**；明细变更一律 422 `PURCHASE_ORDER_DETAIL_READONLY`，提示"请在采购计划里改" |
| `POST /:id/split` | 保留（对已下单的单仍可再收束），但前端不再有入口 |
| `POST /:id/revert-draft`、`POST /:id/cancel` | **删除**（见 §4.3） |
| `POST /:id/revert-to-plan` | **新增**（见 §4.3） |

### 5.3 收束下单的复用

**不新写一套建单逻辑**。计划下单走既有 `PurchaseOrdersService.collectGroups()` + `orderData()`：

1. 计划行的 `bom_item_id` / `material_id` / `unit_id` / `supplier_id` / `quantity` / `unit_price` /
   `expected_date` 原样映射成 `SplitGroupDto.items`（字段名换成采购单那一套）。
2. 币种在请求体里按组给（口径 10）。
3. `place_order: true` → 既有的「一个供应商一张单」不变式、`assertOrderableItems` 的下单前校验、
   金额/快照/审计全部沿用。
4. 事务内回写计划行的 `purchase_order_item_id`：由 service 在同一个事务里按"第几组第几行"定位
   新建的采购明细（`createMany` 不返回 id，所以用 `create` 逐行建或在建完后按
   `(purchaseOrderId, bomItemId, materialId, sequence)` 反查）。

### 5.4 供应商快照要带上地址与联系人

现在 `refs()` 的 `supplierMap` 只装 `{id, name}`，写进 `supplierSnapshot` 的也就这两个字段
（`purchase-orders.service.ts:278` 取用、`:321` 写入）。口径 4 要求下单时**冻结**当时的地址/联系人，
所以 `refs()` 的 supplier 选择要扩成 `{id, supplierCode, name, contactName, phone, address}`。
这是**对既有行为的加强**（原来根本没冻结地址），不需要迁移：旧单的快照里没有这两格，
前端按"-"显示。

### 5.5 计划行引用的 BOM 行 ID 会被换掉（实现时发现，口径 12 的必然推论）

`BomsService.replaceItems` 是「软删全部旧行 + 整批建新行」，**存一次 BOM，所有行 ID 都换**。
采购单靠 `bomItemOrderStatus` 的"行 ID 精确归集 → 换掉了就按物料摊回"来兼容这件事（见 §4.2）。

计划是**长期存在**的（不像草稿是一次性的），所以它一定会持有"当前 BOM 里已经不存在"的行 ID。
如果按原样校验 `PURCHASE_BOM_ITEM_MISMATCH`，后果是 **BOM 改过一次之后这份计划再也保存不了**。

处理：保存计划时，若某行的 `bom_item_id` 在当前 BOM 里查不到，就**按物料找回**当前 BOM 的对应行；
找不回（物料已经不在 BOM 里）才当作 BOM 外的行处理 —— 那一步才要求填 `outside_bom_reason`。
与 §4.2 的摊回逻辑同一口径。

---

## 6. 前端

### 6.1 `/procurement/plans` 页面

- **列表**：口径 14 的列，`DataTable` + 每列显式 `meta.width` + `meta.ellipsis`。
- **详情/编辑**：`Sheet`，结构照搬 `orders/page.tsx` 现有的草稿工作区（它整套搬过来），
  13 列全部固定宽度、不横向滚动（口径 5）。
- **新建**：按钮 → 选一张候选 BOM → 建完直接进详情，行已经带好了。
- **收束预览**：现有 `draft-split-preview` 那一块搬过来，每组加一个币种下拉（口径 10）。
- 供应商那一格用 `SupplierSelect`（下拉 + 「＋ 新建供应商「xxx」」）。

### 6.2 13 列的固定宽度（百分比，和为 100）

| 列 | 宽 | 列 | 宽 |
| --- | --- | --- | --- |
| 选择 | 3% | 单价 | 7% |
| 名称 | 11% | 供应商 | 11% |
| 型号 | 8% | 供应商地址 | 12% |
| 下单状态 | 9% | 联系人 | 9% |
| 本次采购量 | 7% | 预计到货 | 7% |
| 当前库存量 | 7% | 操作 | 4% |
| 单位 | 5% | | |

### 6.3 采购单页瘦身

去掉：`新建采购单` 按钮、草稿工作区 `Sheet`、`草稿` 筛选 tab、`编辑` 按钮、`下单` 按钮。
`回到草稿` → `退回采购计划`（要原因）。保留：列表（已下单及之后）、导出、到货跟踪、
关闭到货、打印字段填写。

### 6.4 BOM 工作区的供应商列按入口显隐

`BomWorkbench` 加一个 prop（例如 `showSupplier?: boolean`，**默认 `true`**），**不复制组件**：

| 入口 | 传值 |
| --- | --- |
| `/procurement/boms` | 不传（默认显示） |
| `/production` | **显式传 `false`** |

> 为什么默认是 `true` 而不是文档初稿写的「不传即 false」：这一列是**采购**的知识
> （这个部件通常找哪家做），采购入口本来就要它；而组件是共用的，默认隐藏会让
> "这个入口要不要供应商"变成每个新入口都得记得判断一次的事 —— 忘了就是不显示，
> 而且要等采购员问"供应商列哪去了"才发现。
>
> 隐藏**只影响显示与编辑**：行状态里的 `supplierId` 仍在，保存时原样回传，
> 所以生产侧保存 BOM **不会**把采购标过的供应商抹掉。
>
> 另：`/procurement/orders` 不再是 BOM 工作区的入口 —— 那个入口挂在被删掉的草稿工作区 Sheet 里
> （§6.3）。BOM 仍在 `/procurement/boms` 与生产侧可编辑。

### 6.5 「一次性展示所有 column」的 CSS 要从 `.finance-page` 里提出来

现状（`apps/web/app/globals.css:217-223`）：

```css
.finance-page .ui-table.data-table-fixed { table-layout: fixed; }
.finance-page .ui-table.data-table-fixed .ui-table-cell.cell-ellipsis { white-space: nowrap; text-overflow: ellipsis; }
```

前缀挂着 `.finance-page`，所以采购计划页照抄会得到**静默失效**（宽度不生效、省略号永远不出现，
页面只是"看起来没省略"）。改成通用规则，财务的原有行为用同等或更高的权重保住，并对财务那几张表
（记账凭证 / 应付对账 / 应收对账 / 工资台账）做一次回归。

---

## 7. 迁移与部署

### 7.1 两条迁移，DDL 与 DML 分开

| 目录 | 内容 |
| --- | --- |
| `20260928090000_purchase_plan` | 两张新表 + 索引 + 外键 + 部分唯一索引 |
| `20260928100000_purchase_plan_backfill_drafts` | 把既有 `status='draft'` 的采购单按 `bom_id` 归并成计划，原草稿软删 |

分开的理由：搬迁数据比建表风险高，分开之后可以单独审、单独跳过。

### 7.2 搬迁迁移（口径 8）必须写成幂等

- 幂等：已存在计划（`deleted_at IS NULL` 且同 `bom_id`）时复用，不重复建。
- 同一 BOM 有多个草稿（按供应商拆过）时**合并进同一份计划**，行**不去重**——采购员填过的行
  一律保留（同一 BOM 行出现两行是允许的，正好表达"两家比价"）。
- 没有 `bom_id` 的草稿：**不动**（原样留在 `purchase_orders`，只是不进列表）。
- 迁移前必须 `pg_dump` 备份。**本机没有 PostgreSQL，这段 SQL 无法在本地验证**（§9）。

### 7.3 部分唯一索引会增加 `migrate diff` 的基线漂移

仓库既有基线是 **293 行**（`docs/log/2026-09-26.md:14`，含 `boms_sales_order_id_active_key` 与
`raw_material_inbound_notices` 的两条同源部分唯一索引）。本次再加一条
`purchase_plans_bom_id_active_key`，基线会小幅增加。**这是预期内的**，判定标准是
"新增漂移只来自这一条 Prisma 不认识的 partial unique index"，不是"漂移必须是 0"。
部署核验时请把新的行数与 md5 记进 `docs/log/`。

### 7.4 部署顺序

先 `prisma migrate deploy`（两条迁移），再切代码。反过来会出现：计划表不存在 → 计划页整体 500。

---

## 8. 刻意不做的事

- **不做**"不建计划直接下单"的旁路（口径 11）——它会毁掉计划作为唯一真源的地位。
- **不做**计划 Excel 导出（口径 14，用户没提；要加是纯增量）。
- **不做**"按 BOM 自动生成计划"（口径 2）。
- **不给** `purchase_plans` 加手工状态字段（§4.1，派生）。
- **不给**计划行加币种列（口径 10）。
- **不给**地址/联系人在计划行上加重写列（口径 4）。
- **不动** `BomsService.replaceItems`（它换行 ID 的行为是既有的，靠摊回逻辑兼容，不改它）。
- **不把**已下单采购单的明细编辑挪回采购单页（口径 7）。

---

## 9. 明确没做完 / 未验证

1. **两条迁移都没有在真实 PostgreSQL 上执行过**（本机没有库）。搬迁迁移尤其如此：
   归并逻辑只经过假 Prisma 单测与 SQL 静态审查，没有对真实数据跑过。
   部署时请先在影子库干跑、核对行数与金额，再上生产。
2. `prisma migrate status` 与 `migrate diff` 的实际漂移行数未测（§7.3）。
3. 13 列的固定宽度没有在真实浏览器里量过像素（本机只做构建与 jsdom）；建议部署后在
   1366 / 1440 / 1920 各看一眼，确认**没有横向滚动条**。
4. `test:api` / `test:integration` / `test:e2e` 未运行（需要真实库与已启动的 API）。
5. 退回采购计划这条路径的并发行为（两个人同时退同一张单）只靠事务与行锁推断，没有压测。
6. 计划页与采购单页的 jsdom 测试**不排版**：列宽与省略号生效与否只能目测（第 3 条）。

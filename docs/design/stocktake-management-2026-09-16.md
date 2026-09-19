# 仓库库存盘点：月度盘点表导入与库存调整（2026-09-16）

## 来源需求（用户原话）

> 「现在，针对仓库板块，仓库模块增加一个盘点管理，可以将每月一次的盘点数据导入系统，
> 调整库存物料数量。物料的产品代码作为唯一性，在新建物料是自动生成一个物料代码。
> 物料导入模板，需要有这些 column：
> 产品名称 / 产品规格 / 产品代码 / 仓位 / 货位 / 实际数量」

用户对四条追问的选择：

1. **产品代码 = 物料编码**（同一个字段）：模板里的产品代码就是物料清单里的物料编码，
   导入按它匹配物料（这也正是用户说的「产品代码作为唯一性」）；
2. **只盘原料/物料**：成品库存按「生产单 + 产品名称快照」记账，没有产品代码，套不进这套模板；
3. **仓位/货位只作为盘点行的文本记录**：V1 已确认不建库位/货架（集中待确认事项 1），
   这两列收下来是为了对照纸质盘点表与找货，不参与账簿键；
4. **差异按「确认当时的账面数」重算**：导入与确认之间仓库可能又发生领料/入库，
   按导入时冻结的差额调账会把那笔真实收发悄悄冲掉。

---

## 一、先盘点：系统里已经有什么、缺什么

| 环节 | 改前状态 |
| --- | --- |
| 物料唯一编码 + 自动生成 | ✅ **已有**：`Material.materialCode` 全站唯一；`POST /materials` 支持 `code_mode: "auto"`，生成 `MAT-当天日期-序号`（与供应商 `SUP-`、客户 `CUS-` 共用平台规则 `daily-sequence-code.ts`）；共享的「新建物料」弹窗**默认就是自动生成**，建完回显编码 |
| 原料库存余额 | ✅ 由 `inventory_facts` 聚合：`inventoryCategory ∈ {raw_material, scrap}` 的 `quantityDelta` 之和（`InventoryService.rawMaterialBalance(s)`），「原料仓储情况 → 库存汇总」用的就是它 |
| 库存可被调整 | ✅ 机制在（写一条数量事实即可），但**没有单据可依据**：领料/退料/报废各有自己的事实与单据，唯独「盘盈盘亏」没有落点 |
| 盘点单 / 盘点导入 | ❌ **缺**：`stocktakes` 表不存在，没有导入、没有页面 |

已确认的仓库盘点口径（`docs/design/warehouse-module-design.md` §6、集中待确认事项 28）：
**盘点单记录账面数、实盘数、差异、原因；确认后生成独立库存调整记录，不直接改余额。**
本轮就是把这句设计落成可用的单据。

## 二、做法

### 1. 数据模型：单头 + 明细，三个数量快照

```
stocktakes                       stocktake_lines
  stocktake_no (unique)            line_no（单内唯一）
  period_month  YYYY-MM            material_id / unit_id
  status        draft              product_code/name/specification 快照
                confirmed          warehouse_zone / bin_location（文本）
                reversed           actual_quantity              实盘数
  source_file_name                 book_quantity_snapshot      导入时账面
  imported_at                      difference_snapshot         导入时差异
  confirmed_at / confirmed_by      book_quantity_at_confirm    确认时账面
  reversed_at / reversed_by        applied_quantity            已应用调整
  reversal_reason                  difference_reason
  remark
```

`inventory_facts` 增加 `stocktake_line_id`（可空 + 索引 + FK `ON DELETE SET NULL`）：与原料流转行
（`raw_material_movement_line_id`）同一做法，让「这笔库存变动是哪一行盘点造成的」可直接查，
而不是靠 `source_id` 的约定去猜。

**为什么三个数量快照都要留**：导入时账面数是操作员当时看到的数，确认时账面数是真正参与计算的数，
已应用调整是实际写进库存事实的差额。只留一个，事后就无法回答「为什么差异和我导进来时看到的不一样」。

### 2. 导入：解析 → 匹配 → 建草稿单（三段式）

与「其他应付批量导入」「员工花名册导入」同一套纪律（操作员面对的是同一件事）：

1. **解析**（`stocktake-import.ts`，纯函数、无 Nest/Prisma 依赖）：表头**按名字认列**（列顺序可调、
   多余列如实上报）、逐行校验、**行级错误不连坐**；只有「找不到表头 / 缺必需列 / 没有数据行」
   才是整批失败。必需列只有两列：**产品代码**与**实际数量**；产品名称/规格/仓位/货位缺失只提示。
2. **匹配物料**：`产品代码` 按 `materialCode` 匹配（忽略大小写与空格）。找不到的**逐行报错**，
   不自动建档 —— 模板里没有单位，而 `Material.defaultUnitId` 必填，要建档就得凭空猜单位。
3. **写库**：通过校验的行在**一个事务**里建一张草稿单（表头 + 明细），要么全进要么全不进。
   账面数取导入当时的原料库存，与「原料仓储情况 → 库存汇总」同一个口径。

### 3. 逐行校验里的几条硬口径

- **一个产品代码在一份表里只能一行**：多个仓位请把数量相加后填一行。两行会各自与同一个账面数比较、
  各减一遍账面，确认后库存被扣两遍。报错里点名首次出现的行号。
- **实盘数允许 0，但留空报错**：盘没了就是要填 0；留空多半是漏填，静默当 0 会凭空盘亏一整行。
- **数量边界**与全站一致：最多 4 位小数、整数位最多 14 位（PG `numeric(18,4)` 会把 `0.00004`
  四舍五入成 `0`），拒绝负数与 `1e3`。
- 十进制单元格归一化（千分位 / 货币符号 / 全角数字 / 数字单元格）**复用**其他应付导入的
  `normalizeAmountCell`：再抄一份必然漂移，而漂移的表现是「同一张表有的列认得出、有的列认不出」。
- 表头不在第一行（有人先写标题行）按**文档形态**处理：数据块到第一个空行为止，表尾批注不当数据。

### 4. 确认：按确认当时的账面数重算，写独立调整事实

```
逐行（事务内，先锁盘点单头）：
  实际 = actual_quantity
  账面 = InventoryService.rawMaterialBalance(tx, materialId, unitId)   ← 确认当时
  差额 = 实际 − 账面
  差额 ≠ 0 → 写 inventory_facts(source_type = stocktake_adjustment, quantity_delta = 差额,
                                 stocktake_line_id = 该行)
  记录 book_quantity_at_confirm = 账面、applied_quantity = 差额
单头：status = confirmed / confirmed_at / confirmed_by
```

- **不直接改余额**：库存余额始终是事实的聚合，历史单据不被改写；已确认的单子不能改也不能删，
  只能冲销（按行写等额反向事实，`source_type = stocktake_reversal`）。
- **副作用正好是好的**：重复确认差额已经是 0；同一个月重传出第二张草稿单、两张都确认也**不会**
  把同一批差异应用两次（第二张算出来是 0）。
- **物料在导入之后被删除时拒绝确认**（422 并指明行号）：`rawMaterialBalance` 对已删除物料返回 0，
  差额就等于实盘数 —— 那等于给一个已删除的物料平白加库存。
- **差异行没有填原因不阻塞确认**，但确认结果里回报条数（关键风险强提示但不拦人，与告警口径一致；
  拦下来只会逼操作员随手填一个「无」）。
- **确认结果必须点名「导入后有变动」的行**：否则操作员看到「差异 10」而文件里写 −10 时，
  只能猜是系统算错或自己填错 —— 第三种解释（这期间仓库发过料）必须由系统说出来。
- 冲销原因**必填，且在查单子之前校验**：与成品出库冲销同一顺序，保证「忘记填原因」永远是
  可解释的 422，而不是一个把人引偏的 404。

### 5. 接口与页面

```
GET    /api/v1/stocktakes                    列表（含明细数、差异行数）
GET    /api/v1/stocktakes/import-template.xlsx  模板（6 列 + 填写说明页）
POST   /api/v1/stocktakes/import             上传（multipart: file + period_month）
GET    /api/v1/stocktakes/:id                详情（明细 + 按单位的汇总）
POST   /api/v1/stocktakes/:id/confirm        确认（写库存调整）
POST   /api/v1/stocktakes/:id/reverse        冲销（原因必填）
DELETE /api/v1/stocktakes/:id                删除草稿
PATCH  /api/v1/stocktakes/lines/:id          改实盘数 / 差异原因（仅草稿）
DELETE /api/v1/stocktakes/lines/:id          删行（仅草稿）
```

⚠️ `import-template.xlsx` **必须声明在 `@Get(":id")` 之前**：Nest 按声明顺序匹配，单段静态路径
会被 `:id` 当成盘点单 ID 去查库（`payable-entries/import-template.xlsx` 踩过同一个坑）。

页面 `/warehouse/stocktakes`（仓库首页新增「库存盘点」入口）：

- **导入**：盘点月份 + 下载模板 + 上传 + 逐行结果（行号 / 字段 / 原因）留在页面上（不做成一条 toast：
  「第 7 行产品代码找不到」必须能逐条看清）；
- **盘点单列表**：单号 / 月份 / 状态 / 明细数 / 差异行数 / 来源文件 / 导入时间 / 确认时间 / 操作；
- **明细**：三个账面口径 + 差异原因，草稿可「改实盘数 / 删行」，已确认只显示；
- **确认两步**：先在明细里展开确认条（写明「差异 N 行、按确认当时的账面写调整」）再提交；
- **冲销**：原因框为空时按钮禁用；
- 搜索与列表共用 `fuzzyMatch`（只过滤展示、不额外打接口）；窗口重新获得焦点时**静默刷新**
  （不切整页 loading，否则正在编辑的弹窗会被卸载）。

数量一律按字符串展示与提交，前端不做 `Number()` 累加；**不做跨单位合计**（件、米、kg 相加没有
业务含义），汇总按单位给「调增 / 调减」两个数。

## 三、刻意不做的事

- **不盘成品**（用户选择）：成品没有产品代码，要盘得另做一套按生产单匹配的模板；
- **不建库位维度**：仓位/货位只是文本（V1 已确认），库存仍按「物料 + 单位」记；
- **不做单位换算**：单位取物料默认单位（与全站一致）；
- **不做附件与导出**：设计文档里盘点单支持盘点照片、固定报表里有「盘点差异」，
  本轮都没做（模板里也没有附件列）；
- **不改单头**：盘点月份 / 来源文件 / 备注都是导入时定下的，填错只能删掉重导；
- **不加物料级锁**：确认时只锁盘点单头，逐行读账面余额时理论上存在极小的并发窗口
  （真实并发量低，差额本身会被「确认时账面」这个快照解释）。

## 四、验证

- API 单测 **1448 / 1448**：本轮新增 38 条（`test/unit/stocktake-management.test.cjs` 33 条
  纯函数 + 服务层 + DTO、`test/unit/stocktake-migration.test.cjs` 5 条库级守卫）；
- 契约测试新增 `test/http/stocktake-contract.test.cjs`（9 条路由 / 模板不被 `:id` 吃掉 /
  只读探测纪律），`authorization-matrix-contract.test.cjs` 的控制器清单 **37 → 38**；
- 前端组件测试 **42 文件 / 781 用例**（`test/stocktake-page.test.tsx` 14 条）；
- `npm run typecheck`（api + web）、`npm run build --workspace=@dilee/api` 通过。

**未在真实数据库上验证**：迁移 `20260916190000_warehouse_stocktake`、确认/冲销写入的库存事实、
并发窗口，以及契约测试（需要 `API_BASE_URL` 与 PostgreSQL，本机都没有）。

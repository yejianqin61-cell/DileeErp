# 任务：仓库库存盘点（月度盘点表导入 + 确认时生成库存调整）

## 状态
已完成

## 认领
负责人：全栈 Agent
开始日期：2026-09-16

## 来源需求（用户原话）

> 「现在，针对仓库板块，仓库模块增加一个盘点管理，可以将每月一次的盘点数据导入系统，
> 调整库存物料数量。物料的产品代码作为唯一性，在新建物料是自动生成一个物料代码。
> 物料导入模板，需要有这些 column：
> 产品名称 / 产品规格 / 产品代码 / 仓位 / 货位 / 实际数量」

用户对追问的选择：

1. **产品代码 = 物料编码**（同一个字段）：导入按物料编码匹配物料，这也正是「产品代码作为唯一性」；
2. **只盘原料/物料**：成品库存按「生产单 + 产品名称快照」记账，没有产品代码；
3. **仓位/货位只作盘点行的文本记录**：V1 已确认不建库位/货架；
4. **差异按「确认当时的账面数」重算**：导入与确认之间仓库又发生领料/入库时，那笔真实收发
   不会被盘点单悄悄冲掉。

设计见 [仓库库存盘点](../../design/stocktake-management-2026-09-16.md)。

## 目标

- 每月把盘点表（Excel）一次性导入系统，变成一张**盘点草稿单**；
- 草稿上可校核（改实盘数、写差异原因、删行），**确认**时按确认当时的账面数写库存调整事实；
- 已确认的盘点单不可改不可删，只能**冲销**（反向写等额事实）；
- 模板里的「产品代码」= 物料清单里的物料编码（新建物料时自动生成），匹配不到逐行报错。

## 关联决策

- **不直接改余额**：确认时写 `inventory_facts`（`source_type = stocktake_adjustment`，
  并回指盘点行），库存余额始终是事实的聚合（已确认口径 28）；
- **差异按确认时账面重算**，并同时保留导入时账面快照 —— 两个数都留下才解释得清差异；
- **一份表里一个产品代码只能一行**（用户说的「产品代码唯一」）：多仓位请先相加，
  否则两行各减一遍账面，确认后库存被扣两遍；
- **匹配不到物料时不自动建档**：模板没有单位，`defaultUnitId` 必填，猜单位比少导一行危险；
- **实盘数允许 0、留空报错**：0 是「盘没了」，留空是漏填；
- **差异原因缺失不阻塞确认，但要回报条数**：关键风险强提示但不拦人；
- **仓位/货位只作文本、盘点只覆盖原料、不做单位换算**：见用户选择与 V1 口径；
- **不做跨单位合计**：明细汇总按单位给调增/调减。

## 范围与非范围

**做**：

- 新增 `apps/api/src/modules/warehouse/stocktake-import.ts`（纯函数：表头别名、逐行校验、
  模板生成）、`stocktake.service.ts`（导入 / 列表 / 详情 / 确认 / 冲销 / 行编辑删除）、
  `stocktake.controller.ts`（9 路由，`import-template.xlsx` 声明在 `:id` 之前）；
- `apps/api/prisma/schema.prisma` + 迁移 `20260916190000_warehouse_stocktake`：
  `stocktakes` / `stocktake_lines` / `inventory_facts.stocktake_line_id`；
- `apps/api/src/modules/production/production.module.ts`：注册新控制器与服务（仓库侧控制器
  历史上都挂在这里）；
- 新增 `apps/web/app/warehouse/stocktakes/page.tsx`，仓库首页加「库存盘点」入口；
- 测试：`apps/api/test/unit/stocktake-management.test.cjs`（33）、
  `apps/api/test/unit/stocktake-migration.test.cjs`（5）、
  `apps/api/test/http/stocktake-contract.test.cjs`（新增）、
  `apps/api/test/http/authorization-matrix-contract.test.cjs`（控制器 37 → 38）、
  `apps/web/test/stocktake-page.test.tsx`（14）、`apps/web/test/testid-pages.test.ts` 登记新页面；
- 顺手修掉一处**日期敏感的既有红点**：`apps/api/test/unit/other-payable-import.test.cjs` 把
  `SUP-20260916-0002` 写死在断言里（自动编码前缀带当天日期，只有写测试那天才会绿）。

**不做**：

- 不做成品盘点（成品没有产品代码）；
- 不建仓位/货位主数据、不改库存账簿键（仍按「物料 + 单位」）；
- 不做单位换算；
- 不做盘点单附件（盘点照片）与导出（「盘点差异表」）；
- 不能改单头（月份/来源文件/备注），填错只能删掉重导；
- 不加物料级锁（只锁盘点单头）；
- 不做导入幂等/批次去重（重传会产生第二张草稿单，但因差额按确认时账面重算，两张都确认
  不会重复调整）。

## 验收与验证

1. `test/unit/stocktake-management.test.cjs`（33 条）：
   - 纯函数：模板闭环（两行示例合法、列全部属于口径、示例里有一个 0）/ 按表头名认列与忽略列 /
     缺产品代码列、缺实际数量列各一条整体错误 / 表头下没有数据行 / 实盘数允许 0 但留空报错 /
     千分位·货币符号·全角数字·数字单元格归一化与负数·`1e3`·5 位小数·超长整数被拒 /
     同一产品代码两行被拒并指向首次出现行 / 仓位货位缺失只提示 / 文档形态与表尾说明行 /
     行数上限常量；
   - 服务层：匹配忽略大小写与空格、快照以物料主数据为准、账面数取原料库存口径、单号 `PD-当天-序号` /
     匹配不到逐行报错且不自动建档（partial）、全部匹配不到不建单（failed）/ 无文件与非 Excel 422 /
     同月份已有单子只提示 / **确认按确认时账面重算并回报「导入后有变动」** / 0 差额不写事实、
     无原因的差异行仍可确认 / 物料被删除 422 并指明行号 / 重复确认 409 / 空单不能确认 /
     冲销按行反向写事实 / 草稿不能冲销 / **冲销原因必填且在查单子之前校验** /
     草稿可改实盘数（差异重算）与删行、已确认一律 409 / 草稿行物理删除、单头软删除 /
     列表计数 / 详情汇总按单位分开；
   - DTO：盘点月份 `YYYY-MM`、实盘数允许 0 且空串按未填写、负数与科学计数被拒。
2. `test/unit/stocktake-migration.test.cjs`（5 条）：盘点单号唯一 / 单内行号唯一 /
   `inventory_facts.stocktake_line_id` 与索引 / 四个数量列的 NOT NULL 边界 /
   确认与冲销的可追溯列与默认草稿状态。
3. `test/http/stocktake-contract.test.cjs`：9 条路由匿名 401；**模板不被 `:id` 吃掉**且能被
   自己的解析器读回；无文件 / 非 Excel 的 422 与月份校验的 400；不是盘点表的文件整批失败且不建单；
   未知 id 的 404；冲销空原因是 422 而不是 404；实盘数校验；方法与子路径不匹配一律 404；x-request-id。
4. `test/stocktake-page.test.tsx`（14 条）：列表与空态 / 失败可重试 / 搜索只过滤不打接口 /
   明细摊开三个账面口径与按单位汇总 / 已确认不给改删 / 下载模板 / 上传 multipart 带
   `file` 与 `period_month` 且逐行回显并自动打开新单 / 一行都没进来时明确说「没有可导入的行」/
   确认两步并回报「导入后有变动」且刷新列表 / 冲销原因必填 / 改实盘数成功与失败两条路径 / 删行。
5. `npm run build --workspace=@dilee/api`、`npm run typecheck`（api + web）通过。

## 决策记录

- **先查证再动手**：「在新建物料时自动生成一个物料代码」在系统里**早就成立**（`code_mode: "auto"`
  是新建物料弹窗的默认值），所以本轮没有重做这件事，只把它接进导入链路（按物料编码匹配 +
  匹配不到时指向物料清单）。若按字面重做一遍，会白改一遍已经对的东西。
- **导入只建草稿，确认才动库存**：草稿不是业务事实，所以草稿行可以物理删除、实盘数可以随便改；
  一旦确认就变成事实，只能用冲销更正。这与领料/出库的单据纪律一致。
- **一个产品代码一行**：与其在确认时做「同物料合并再统一算差额」的隐式归一，不如在导入时直接拒绝
  并告诉操作员怎么改 —— 错误停在操作员手上，比藏在系统里等他三个月后发现库存不对要好。
- **匹配不到不自动建档**：与「其他应付导入」的供应商自动建档相反，因为模板里没有单位；
  猜错单位会让库存记在错误的计量上。用户改一行模板的成本远低于一次静默错误建档。
- **两个账面数都留下**：只留一个就无法回答「为什么差异和我导进来时看到的不一样」。
  确认结果里点名「导入后有变动」的行，是把第三种解释（期间真实收发）交给系统说，而不是让用户猜。
- **差异原因不阻塞确认**：拦下来只会逼操作员随手填一个「无」，反而让原因字段失去意义；
  回报条数让仓库自己决定要不要补填。
- **`import-template.xlsx` 必须排在 `:id` 之前**：Nest 按声明顺序匹配。代码里留注释、
  契约测试里留护栏（断言它 200 且是 xlsx，而不是 404 `STOCKTAKE_NOT_FOUND`）。
- **复用而不是重写**：十进制单元格归一化复用财务的 `normalizeAmountCell`、单元格读法复用
  `textCell`、自动编码复用 `daily-sequence-code`、库存口径复用 `InventoryService`、
  搜索复用 `fuzzyMatch` —— 每处都留了「为什么共用」的注释。

## 完成记录

- 新增：`apps/api/src/modules/warehouse/stocktake-import.ts`、
  `apps/api/src/modules/warehouse/stocktake.service.ts`、
  `apps/api/src/modules/warehouse/stocktake.controller.ts`、
  `apps/api/prisma/migrations/20260916190000_warehouse_stocktake/migration.sql`、
  `apps/web/app/warehouse/stocktakes/page.tsx`、
  `apps/api/test/unit/stocktake-management.test.cjs`、
  `apps/api/test/unit/stocktake-migration.test.cjs`、
  `apps/api/test/http/stocktake-contract.test.cjs`、
  `apps/web/test/stocktake-page.test.tsx`、
  `docs/design/stocktake-management-2026-09-16.md`、本文件；
- 修改：`apps/api/prisma/schema.prisma`、`apps/api/src/modules/production/production.module.ts`、
  `apps/web/app/warehouse/page.tsx`、`apps/web/test/testid-pages.test.ts`、
  `apps/api/test/http/authorization-matrix-contract.test.cjs`、
  `apps/api/test/unit/other-payable-import.test.cjs`（日期敏感断言）、
  `apps/api/src/modules/warehouse/README.md`、`docs/log/2026-09-15.md`；
- 验证：API 单测 **1448 / 1448**（+38）、web 组件 **42 文件 / 781 用例**（+14）、
  web lib 156 条、`tsc --noEmit`（api + web）与 `nest build` 通过。
- **未在真实数据库上验证**：迁移、确认/冲销写入的库存事实与并发窗口，以及
  `test/http/*` 契约测试（都需要 `API_BASE_URL` 与 PostgreSQL，本机都没有）。

# 待用户提交的 Git 命令

本文件记录已完成、但因本地 `.git` ACL 暂不能由 Codex 执行的提交。请在仓库根目录按顺序执行；每条提交独立对应一个完成的任务。

> **2026-09-26 现状：下面这些命令的「代码」部分已经全部入库并上线，不要再照着跑。**
> 部署 agent 已按 pathspec 把代码提交为
> `06bdd8e`（第六轮）/ `3663019`（第七轮）/ `08824d9`（09-26 生产 500 修复），
> 生产 release = `08824d9`，四条迁移均已应用（`migrations applied = 91 / failed = 0`）。
> 未入库的只剩**文档**（本文件里那串 `docs/...` 路径），以及 `example/` 下的样本文件 ——
> 部署侧的既定口径是「作者的 docs 改动不入库，部署时暂存、之后归还」。
> 因此这个文件现在的用途是一份**变更清单**（每轮改了什么、部署要注意什么），
> 而不是待执行命令；命令里对代码路径的 `git add` 会命中「已经提交、无改动」的空操作。

## 人事绩效入口

```powershell
git add apps/web/app/hr/page.tsx
git commit -m "fix: expose performance registration in hr"
```

## 初始化标准业务字典

```powershell
git add apps/api/prisma/seed.ts
git commit -m "fix: initialize standard business dictionaries"
```

## 来料质检完成前数量校验

```powershell
git add apps/api/src/modules/procurement/incoming-inspections.service.ts apps/api/test/incoming-inspections.test.cjs docs/task/PENDING-USER-COMMITS.md
git commit -m "fix: require inspection quantity before completion"
```

## 采购单到货状态准确展示

```powershell
git add apps/web/app/procurement/page.tsx docs/task/PENDING-USER-COMMITS.md
git commit -m "fix: distinguish purchase over-receipt status"
```

## 财务应付批次追溯

```powershell
git add apps/api/src/modules/finance/supplier-payable.service.ts apps/api/test/unit/supplier-payable-service.test.cjs docs/task/PENDING-USER-COMMITS.md
git commit -m "feat: expose payable purchase batch traceability"
```

## 原料入库冲销同步应付来源

```powershell
git add apps/api/src/modules/procurement/raw-material-inbounds.service.ts apps/api/test/unit/raw-material-inbounds-service.test.cjs docs/task/PENDING-USER-COMMITS.md
git commit -m "fix: void pending payable source on inbound reversal"
```

## 应付确认校验来源状态

```powershell
git add apps/api/src/modules/finance/supplier-payable.service.ts apps/api/test/unit/supplier-payable-service.test.cjs docs/task/PENDING-USER-COMMITS.md
git commit -m "fix: reject confirmation of voided payable source"
```

## 财务应付条目显示批次追溯

```powershell
git add apps/web/app/finance/page.tsx docs/task/PENDING-USER-COMMITS.md
git commit -m "feat: show payable batch traceability"
```

## 到货完成前继续登记批次

```powershell
git add apps/web/app/procurement/page.tsx docs/task/PENDING-USER-COMMITS.md
git commit -m "fix: allow open purchase batches before arrival closure"
```

## 空质检登记保持待检

```powershell
git add apps/api/src/modules/procurement/incoming-inspections.service.ts apps/api/test/incoming-inspections.test.cjs docs/task/PENDING-USER-COMMITS.md
git commit -m "fix: keep empty incoming inspection pending"
```

## 销售单回退事务门禁

```powershell
git add apps/api/src/modules/sales/sales-orders.service.ts apps/api/test/sales-order-chain.test.cjs docs/task/PENDING-USER-COMMITS.md
git commit -m "fix: lock sales order before draft reversion"
```

## 采购单库存键兼容

采购库存查询同时保留物料+单位键，并提供物料总量键，避免库存列因单位维度缺失而始终显示 0。

```powershell
git add apps/web/app/procurement/page.tsx docs/task/PENDING-USER-COMMITS.md
git commit -m "fix: display purchase stock by material unit"
```

## PWA 安装图标声明

Manifest 明确声明 192×192 和 512×512 安装图标尺寸，继续复用现有图标资源。

```powershell
git add apps/web/public/manifest.webmanifest docs/task/PENDING-USER-COMMITS.md
git commit -m "fix: declare pwa install icon sizes"
```

## 统一发布包入口

根目录新增 `npm run release:pack`，统一调用安全发布包脚本，避免从错误目录打包用户目录内容。

```powershell
git add package.json docs/task/PENDING-USER-COMMITS.md
git commit -m "chore: add standard release package command"
```

## 编辑到货后重算采购状态

到货批次编辑完成后重新汇总有效到货量，采购单状态同步回到 `ordered`、`partially_arrived` 或 `arrived_complete`。

```powershell
git add apps/api/src/modules/procurement/purchase-orders.service.ts docs/task/PENDING-USER-COMMITS.md
git commit -m "fix: recalculate purchase status after receipt edit"
```

## 统一扩大居中 Sheet

通用居中 Sheet 使用不超过 1280px 的 80vw 宽度和 80vh 高度，满足宽敞展示要求；采购和领料专用工作区样式保持不变。

```powershell
git add apps/web/app/globals.css docs/task/PENDING-USER-COMMITS.md
git commit -m "style: widen centered sheet workspaces"
```

## 原料入库列表补齐批次追溯

原料入库表展示订单号、采购单号、到货批次、到货记录和质检状态，与后端批次管线数据保持一致。

```powershell
git add apps/web/app/procurement/page.tsx docs/task/PENDING-USER-COMMITS.md
git commit -m "feat: show inbound batch traceability"
```

## 原料入库应付按单据精确关联

原料入库列表的应付来源优先按入库单号匹配，避免同一订单多个批次之间串联应付金额。

```powershell
git add apps/web/app/procurement/page.tsx docs/task/PENDING-USER-COMMITS.md
git commit -m "fix: scope inbound payables by document"
```

## 原料入库冲销填写原因

仓储情况页面的入库冲销改为使用原因弹窗，不再提交硬编码原因，确保审计记录具备业务说明。

```powershell
git add apps/web/app/warehouse/raw-material-storage/page.tsx docs/task/PENDING-USER-COMMITS.md
git commit -m "fix: require reason for inbound reversal"
```

## 仓储页面补齐入库批次追溯

原料仓储情况页展示采购单号、到货批次、到货记录和质检状态，便于从库存汇总回溯采购批次管线。

```powershell
git add apps/web/app/warehouse/raw-material-storage/page.tsx docs/task/PENDING-USER-COMMITS.md
git commit -m "feat: show storage inbound batch details"
```

## 仓储库存按单位隔离

原料仓储汇总不再跨单位相加，按物料与单位分别展示，并补充单位列；无库存的启用物料仍显示零行。

```powershell
git add apps/web/app/warehouse/raw-material-storage/page.tsx docs/task/PENDING-USER-COMMITS.md
git commit -m "fix: separate storage balances by unit"
```

## 离职日期校验

办理离职时复用入职/离职日期校验，拒绝非法日期及早于入职日期的离职日期。

```powershell
git add apps/api/src/modules/production/production-master-data.service.ts docs/task/PENDING-USER-COMMITS.md
git commit -m "fix: validate employee leave dates"
```

## 采购原料边界回归

补充回归测试：即使提交了 BOM 外物料原因，销售产品也会被采购引用校验拒绝，不能作为原料采购、到货或入库。

```powershell
git add apps/api/test/purchase-orders.test.cjs docs/task/PENDING-USER-COMMITS.md
git commit -m "test: cover purchase raw material boundary"
```

## 新增类目自动回填

共享表单在父表单仍打开时，保留已填写草稿；新建类目返回时，原本为空的下拉字段会采用新建项的默认值并自动选中。

```powershell
git add apps/web/components/ui/action-dialog.tsx docs/task/PENDING-USER-COMMITS.md
git commit -m "fix: select newly created category in parent form"
```

## 日报唯一键业务提示

当工序日报关联的唯一约束发生冲突时，接口以“工序员工日报 / 工序与日期组合”说明冲突，不再泄露数据库字段名或显示笼统的“业务记录”。

```powershell
git add apps/api/src/platform/http/api-exception.filter.ts apps/api/test/http/api-exception-filter.test.cjs docs/task/PENDING-USER-COMMITS.md
git commit -m "fix: clarify daily report uniqueness conflict"
```

## 收支项目并入会计科目（财务口径归一）

用户的科目表成为全站财务收支口径的唯一来源：新建 `accounting_subjects`（分类 = 科目类别，项目 = 科目名称，121 条，不含科目代码），
旧 37 个收支项目并入这 121 条并改指历史流水与已确认单据，列名 `item_id` / `cash_flow_item_id` → `subject_id`，
「收支项目维护」与「会计科目」合并成一个栏目（`/finance/cash-flow?tab=subjects`），收支明细/汇总报表按 分类 + 项目 统计（汇总表带分类小计）。

**部署顺序是硬约束**：先 `npm run db:generate --workspace=@dilee/api`，再 `prisma migrate deploy`，
最后切代码 —— 不跑迁移直接上新代码会让全站收支相关功能立刻不可用。

37 条并入对照表见 `docs/memo/0917-收支项目并入会计科目对照表.md`（请财务过目），
设计与未验证事项见 `docs/design/accounting-subject-chart-2026-09-17.md` 与 `docs/log/2026-09-17.md`。

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/seed.ts apps/api/prisma/migrations/20260917120000_accounting_subjects apps/api/src/modules/finance apps/api/src/modules/hr/salary-payment.service.ts apps/api/test/unit apps/web/lib apps/web/app/finance/cash-flow/page.tsx apps/web/components/finance apps/web/test scripts/import-accounting-subject-chart.cjs scripts/generate-accounting-subject-migration.cjs scripts/generate-accounting-subject-memo.cjs scripts/dump-legacy-xls.cjs docs/design/accounting-subject-chart-2026-09-17.md docs/task/0917-accounting-subject.md docs/memo/0917-收支项目并入会计科目对照表.md docs/log/2026-09-17.md docs/product/术语词典.md docs/product/module-capability-catalog.md docs/task/PENDING-USER-COMMITS.md "example/财务/科目表(2).xls"
git commit -m "feat: make the finance chart of accounts the single classification source"
```

## 财务第二轮：采购列序、工资批量付款与按月导出、外汇一览表

四件事，建议**拆成三个提交**（外汇一览表与它依赖的收支流水新列必须同一个提交，否则 deploy 时点不一致）：

### 1. 采购对账明细表：产品名称提到采购单号之前

用户要求的唯一一处与老表不同的列序（老表是 `日期/采购单号/供应商名称/产品名称`）。
金额与含税金额仍在最后两列，合计列下标不变。

```powershell
git add apps/api/src/modules/finance/finance-report.tables.ts apps/api/test/unit/finance-report-workbook.test.cjs docs/task/0917-finance-round2.md
git commit -m "feat: put product name before purchase order no in purchase reconciliation detail"
```

### 2. 工资付款：多选批量付款 + 按月导出（含「是否付款」列）

- `POST /hr/payroll-ledgers/pay-batch`：**每人一张付款单**（用户选定），串行执行、逐条失败隔离，
  发放银行在动手之前校验一次。
- `GET /hr/payroll-ledgers/payment-sheet.xlsx`：18 列，含「是否付款」（无需付款/已付清/部分付款/未付款）；
  金额列为 Excel 数值类型；**单币种才给合计**，混币种不给并在表尾说明。
- 两条静态路由都排在 `payroll-ledgers/:id` 之前（Nest 按声明顺序匹配）。

```powershell
git add apps/api/src/modules/hr/salary-payment.service.ts apps/api/src/modules/hr/hr.controller.ts apps/api/src/modules/hr/payroll-payment-sheet.ts apps/api/test/unit/salary-payment-batch.test.cjs apps/api/test/unit/payroll-payment-sheet.test.cjs apps/web/components/finance/salary-workspace.tsx apps/web/test/salary-page.test.tsx docs/task/0917-finance-round2.md
git commit -m "feat: batch salary payment and monthly salary payment export"
```

### 3. 外汇一览表（含收支流水的款项性质与订单号）

- `cash_flow_entries` 新增 `payment_nature`（定金/货款/尾款/其他）与 `order_no`（可空），
  迁移 `20260917140000_cash_flow_payment_nature`（只加列 + 建索引，不改写历史数据）。
- 确认应收的三条入口（逐条 / 勾选批量 / 按对账单一键）都在弹窗里问款项性质，默认货款；
  收支流水表单新增「款项性质（收入用）」与「订单号（收入用）」两个字段。
- 新增报表 `forex-receipts`：一个工作簿两张工作表（外汇一览 + 客户汇总），
  期间按**收款到账日期**，一行 = 一次成品出库。
- `tableFor()` 返回 `ReportTable[]`、`sendWorkbook()` 接受数组（多工作表成为普通能力）。

**部署顺序是硬约束**：先 `npm run db:generate --workspace=@dilee/api`，再 `prisma migrate deploy`，
最后切代码 —— 不先跑迁移的话 `cash_flow_entries.payment_nature / order_no` 不存在，确认应收会整批失败。

设计与刻意偏离见 `docs/design/foreign-exchange-register-2026-09-17.md`，
**请财务过目的字段映射与三件待确认事项**见 `docs/memo/0917-外汇一览表字段映射.md`。

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260917140000_cash_flow_payment_nature apps/api/src/modules/finance apps/api/src/modules/hr/salary-payment.service.ts apps/api/test/unit apps/web/lib/finance-sections.ts apps/web/lib/payment-natures.ts apps/web/components/finance apps/web/test/finance-report-page.test.tsx apps/web/test/finance-page.test.tsx apps/web/test/cash-flow-page.test.tsx docs/design/foreign-exchange-register-2026-09-17.md docs/memo/0917-外汇一览表字段映射.md docs/task/0917-finance-round2.md docs/log/2026-09-17.md docs/product/术语词典.md docs/product/module-capability-catalog.md docs/task/PENDING-USER-COMMITS.md "example/财务/外汇一览表.xlsx"
git commit -m "feat: add the foreign exchange receipt register with payment nature"
```

> `example/财务/外汇一览表.xlsx` 是本轮口径的依据（列映射逐列来自它），建议一并纳入版本库。

## 采购第三轮：编辑已建单、列宽、下单状态列、按供应商收束

四件事，建议**拆成一个提交**：请求体与前端调用点是一套（前端只走 `/split` 与 `/:id/split`，
旧代码上没有 `POST :id/split`），拆开会让中间那个提交点不可用。
schema 有**两处**改动：一条纯新增索引，一条**放松约束**
（`purchase_order_items.supplier_id / supplier_snapshot` 改回可空，让「刚导入 BOM、还没选供应商」
的草稿存得下来）。放松约束的那条必须与代码**同一个提交点** ——
否则「保存还没选供应商的草稿」会撞上数据库的 NOT NULL 违约。

- `PATCH /purchase-orders/:id` 放开到「已下单但无任何到货」（必填 `reason`，审计留前后值）；
  有到货事实或状态在 `draft|ordered` 之外的一律拒绝。
- 新增 `POST /purchase-orders/:id/split`：收束一张**已存在**的单，第 1 组沿用原单（单号不变），
  其余组新建；草稿收束后仍是草稿，已下单的收束后仍是已下单。
- 新增 `GET /purchase-orders/bom-item-status?bom_id=`：BOM 每行的四态下单情况
  （**必须声明在 `@Get(":id")` 之前**）。
- 前端「保存草稿 / 收束下单」统一按供应商收束；草稿表新增「下单状态」列与「BOM 外新增原因」输入；
  换物料时清掉 `bom_item_id`；列表的编辑入口放开到「已下单未到货」。
- **导入 BOM 明细后即可保存草稿**：草稿允许「还没选供应商」的行，它们单独落成一张供应商为空的草稿；
  收束下单仍然要求每行都有供应商。明细行的供应商因此可空
  （迁移 `20260920120000_purchase_order_item_supplier_nullable`），
  而「一个供应商一张采购单」改由**下单门禁**（`assertOrderableItems`）与
  **写入门禁**（`refs()` → `PURCHASE_ORDER_MULTIPLE_SUPPLIERS`）共同保证。
- 修掉 CSS 权重泄漏：采购工作区复用了 `.material-issue-sheet`，继承了写给领料单的
  `td:nth-child(1) { width: 24% }`，把行首复选框列撑到 460px（详见设计文档第 4.1 节）。

部署顺序：先 `npm run db:generate --workspace=@dilee/api` → `prisma migrate deploy` → 再切代码。
迁移后确认放松生效：
```sql
SELECT column_name, is_nullable FROM information_schema.columns
WHERE table_name = 'purchase_order_items' AND column_name IN ('supplier_id', 'supplier_snapshot');
-- 期望两行都是 YES
```

设计与口径见 `docs/design/purchase-order-collapse-and-edit-2026-09-17.md`，
**请业务过目的五件待确认事项**见 `docs/memo/0917-采购单收束与编辑待确认事项.md`。

> **提交前先看 `git status`**：写这份清单时，财务侧的并行工作流已经把
> `apps/api/prisma/schema.prisma` 里它自己的改动**暂存**（`git add`）进了索引（`MM` 状态）。
> 直接 `git commit` 会把它的半成品一起提交。两个办法：
> 先 `git restore --staged apps/api/prisma/schema.prisma` 把索引清干净，或改用
> `git commit -m "..." -- <上面那串路径>`（pathspec 限定的提交，只提交指定路径）。
> 更稳妥的是先和那条工作流对齐，别把两边的东西混进一个提交。

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260920100000_purchase_order_item_bom_item_index apps/api/prisma/migrations/20260920120000_purchase_order_item_supplier_nullable apps/api/src/modules/procurement apps/api/src/modules/production/outsource-logistics.service.ts apps/api/test/purchase-orders.test.cjs apps/api/test/http/purchase-orders-contract.test.cjs apps/api/test/unit/purchase-order-edit-ordered.test.cjs apps/api/test/unit/purchase-order-split-existing.test.cjs apps/api/test/unit/purchase-order-split.test.cjs apps/api/test/unit/purchase-order-bom-item-status.test.cjs apps/api/test/unit/purchase-order-bom-item-index-migration.test.cjs apps/api/test/unit/purchase-order-item-supplier-nullable-migration.test.cjs apps/web/app/procurement/orders/page.tsx apps/web/app/globals.css apps/web/test/procurement-order-collapse.test.tsx apps/web/test/procurement-draft.test.tsx docs/design/purchase-order-collapse-and-edit-2026-09-17.md docs/memo/0917-采购单收束与编辑待确认事项.md docs/task/0917-procurement-collapse-and-edit.md docs/log/2026-09-17.md docs/product/术语词典.md docs/product/module-capability-catalog.md docs/task/PENDING-USER-COMMITS.md
git commit -m "feat: collapse purchase orders by supplier and allow editing built orders"
```

## 财务三大报表（标准格式）全量落地：手工凭证 / 期初余额 / 期末汇率

用户 2026-09-24：「2 按你说的做，1,3,4 都要」。方案与口径见
`docs/design/finance-three-statements-2026-09-24.md`（§8.2/8.5 已落地）、
下一步的权责发生制两步方案见 `docs/design/finance-accrual-two-step-2026-09-24.md`（**待财务拍板，代码未动**）。

**三条迁移尚未执行，部署时先跑**：
```powershell
npm run db:generate --workspace=@dilee/api
npm run db:migrate:deploy
```
```sql
-- 迁移后确认三处生效
SELECT is_nullable FROM information_schema.columns WHERE table_name = 'vouchers' AND column_name = 'source_id';            -- 期望 YES
SELECT to_regclass('public.accounting_opening_balances');                                                                   -- 期望非空
SELECT to_regclass('public.exchange_rates');                                                                                -- 期望非空
```

> `apps/api/prisma/schema.prisma` 同时含其它并行工作流的改动：提交前先看 `git status`，
> 用下面这条 pathspec 限定的提交（别把别人的半成品一起提交），或先 `git restore --staged` 清索引。
> 三个新表/新模型（`vouchers.source_id` 可空、`AccountingOpeningBalance`、`ExchangeRate`）都在 `schema.prisma` 里，
> **另注**：本轮之后「确认应收」= 挂账（不再写收支流水），涉及 `receivable.service.ts` / `reconciliation.service.ts` /
> `customer-payment.service.ts` / `voucher.service.ts` —— 都在 `apps/api/src/modules/finance` 这一条 `git add` 里。
> 漏了它 API 编译不过 —— 若索引里混了别人的改动，改用 `git commit -m "..." -- <下面这串路径>`。

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260924100000_voucher_manual_source apps/api/prisma/migrations/20260924130000_accounting_opening_balances apps/api/prisma/migrations/20260924160000_exchange_rates apps/api/src/modules/finance apps/api/test/unit apps/api/test/http/finance-contract.test.cjs apps/web/lib apps/web/components/finance apps/web/test docs/design/finance-three-statements-2026-09-24.md docs/design/finance-accrual-two-step-2026-09-24.md docs/log/2026-09-24.md docs/product/module-capability-catalog.md docs/task/PENDING-USER-COMMITS.md
git commit -m "feat: ship the three standard financial statements end to end"
```

## 物料图片 + 销售单引用物料 + 工艺单行高与带图导出

用户 2026-09-24 的第二批四件事：① 付款单/收款单的我方与对方账户分开（旧的
`bank_name`/`bank_account` **已删除**，前后端必须同一个提交点）；② 工艺单导出按内容自动算行高；
③ 物料清单支持上传图片（浏览器压成 WebP 入库，服务端只校验容器与尺寸）；
④ 销售单材料明细 18 项可引用物料并在工艺单导出时勾选带图。

设计文档：`docs/design/material-images-and-sales-order-material-refs-2026-09-24.md`。

**一条迁移尚未执行**（`material_images` 与 `sales_order_material_refs` 两张表），部署时先跑：
```powershell
npm run db:generate --workspace=@dilee/api
npm run db:migrate:deploy
```
```sql
-- 迁移后确认两张表都建出来了
SELECT to_regclass('public.material_images');                 -- 期望非空
SELECT to_regclass('public.sales_order_material_refs');       -- 期望非空
```

> ⚠️ **`finance-slip.ts` 的字段改名是破坏性改动**：`bank_name` / `bank_account` 换成了
> `our_bank_name` / `our_bank_account` / `counterparty_bank_name` / `counterparty_bank_account`。
> 后端与前端（`apps/web/lib/finance-slip.ts` + `finance-slip-editor.tsx`）必须**一起**上线，
> 只发一侧会让导出接口 422（DTO 有 `forbidNonWhitelisted`）。
>
> `apps/api/prisma/schema.prisma` 同时含其它并行工作流的改动：提交前先看 `git status`，
> 用下面这条 pathspec 限定的提交，或先 `git restore --staged apps/api/prisma/schema.prisma` 清索引。

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260924180000_material_images_and_sales_order_material_refs apps/api/src/platform/excel apps/api/src/modules/procurement apps/api/src/modules/sales apps/api/src/modules/finance/finance-slip.ts apps/api/src/modules/finance/finance-slip.service.ts apps/api/src/modules/finance/finance-slip.controller.ts apps/api/test/unit apps/api/test/sales-order-production-sheet.test.cjs apps/web/lib apps/web/components/procurement apps/web/components/sales apps/web/app/procurement/materials/page.tsx apps/web/app/sales/page.tsx apps/web/app/globals.css apps/web/test docs/design/material-images-and-sales-order-material-refs-2026-09-24.md docs/log/2026-09-24.md docs/product/module-capability-catalog.md docs/task/PENDING-USER-COMMITS.md
git commit -m "feat: material images and sales order material references"
```

## 收付款单存档 + 汇率与折合人民币 + 交税凭证模板

用户 2026-09-26：**「付款单要有填写汇率的地方，保存键。生成凭证时要有交税的那一项。」**

设计文档：`docs/design/finance-slip-archive-and-tax-voucher-template-2026-09-26.md`。

**一条迁移尚未执行**（`finance_slips` + `finance_slip_lines` 两张表），部署时先跑：
```powershell
npm run db:generate --workspace=@dilee/api
npm run db:migrate:deploy
```
```sql
-- 迁移后确认两张表都建出来了（以及汇率/折合人民币两列可空：人民币付款留空 = NULL）
SELECT to_regclass('public.finance_slips');        -- 期望非空
SELECT to_regclass('public.finance_slip_lines');   -- 期望非空
SELECT column_name, is_nullable FROM information_schema.columns
WHERE table_name = 'finance_slips' AND column_name IN ('exchange_rate', 'amount_cny');  -- 期望两行都是 YES
```

> **口径边界（部署/验收时别搞混）**：保存一张付款单**不改任何账** —— 不写收支流水、不生成凭证、
> 不动应付/应收状态。单子仍然是拿去银行/走签字的纸；「钱到底付没付」由确认付款那条链回答。
>
> **没有破坏性改动**：`finance-slips.xlsx` 那几条导出接口的请求体只**新增**了
> `exchange_rate` / `amount_cny` 两个可选字段（DTO 有 `forbidNonWhitelisted`，所以旧前端调用仍可用，
> 只是导出的单子上汇率与折合人民币两格是空的）。前后端可以不同时上线。

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260926120000_finance_slips apps/api/src/modules/finance apps/api/test/unit apps/web/lib/finance-slip.ts apps/web/lib/finance-slip.test.mjs apps/web/lib/audit-columns-coverage.test.mjs apps/web/components/finance apps/api/src/modules/finance/voucher-template.ts apps/web/app/finance/slips/page.tsx apps/web/lib/finance-sections.ts apps/web/test/finance-slips-workspace.test.tsx apps/web/test/finance-page.test.tsx apps/web/test/payable-page.test.tsx apps/web/test/testid-pages.test.ts docs/design/finance-slip-archive-and-tax-voucher-template-2026-09-26.md docs/log/2026-09-26.md docs/product/module-capability-catalog.md docs/task/PENDING-USER-COMMITS.md
git commit -m "feat: archive finance slips with exchange rate and add the tax voucher template"
```

## 销售板块二级页 + 引用物料的导出兜底 + 明细自定义列名

用户 2026-09-30 的五件事：① 成品出库总览 / 客户池 / 销售单收进二级页面；
② 引用了物料的材料明细在导出的 Excel 里印不出来（那一格是空的）；③ 引用下拉支持搜索；
④ 细分明细的列名可按单自定义；⑤ 工艺要求每一点带标题。

设计文档：`docs/design/sales-order-subpages-and-detail-labels-2026-09-30.md`。

**一条迁移尚未执行**（给 `sales_orders` 加 `spec_detail_labels`），部署时先跑：
```powershell
npm run db:generate --workspace=@dilee/api
npm run db:migrate:deploy
```
```sql
-- 迁移后确认列建出来了：JSONB、NOT NULL、默认空对象（空对象 = 全部用默认列名）
SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
WHERE table_name = 'sales_orders' AND column_name = 'spec_detail_labels';
-- 期望一行：jsonb / NO / '{}'::jsonb
```

> **前后端可以不同时上线**：`spec_detail_labels` 是**新增可选字段**（DTO 里没传 = 这一块不动），
> 旧前端调用照常可用（只是不能改列名）；旧版本导出件里明细表头那一格的默认名从「颜色」变成
> 「颜色/配色」——这是"列名只有一个真源"的结果，不是漂移（见设计文档 §四）。
>
> **没有破坏性改动**：工艺要求多印了标题（`1.样品要求：…`）、材料明细多了一层
> 「引用了物料但格子里没字」的兜底 —— 都是"纸上多印/多一行"，不动任何数据结构。
>
> `apps/api/prisma/schema.prisma` 同时含其它并行工作流的改动：提交前先看 `git status`，
> 用下面这条 pathspec 限定的提交（别把别人的半成品一起提交），或先
> `git restore --staged apps/api/prisma/schema.prisma` 清索引。

```powershell
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260930120000_sales_order_spec_detail_labels apps/api/src/modules/sales apps/api/test/unit apps/api/test/sales-order-production-sheet.test.cjs apps/web/lib apps/web/components/sales apps/web/app/sales apps/web/app/customers/page.tsx apps/web/test docs/design/sales-order-subpages-and-detail-labels-2026-09-30.md docs/log/2026-09-30.md docs/product/module-capability-catalog.md docs/task/PENDING-USER-COMMITS.md
git commit -m "feat: sales subpages, material-ref export fallback and per-order detail labels"
```

> **2026-09-30 16:00 现状**：上面这一轮的**代码**已经入库（`62b92de`，作者 Ye Jianqin），
> 未入库的只剩本文档末尾那串 `docs/...` 路径（以及 `example/` 下的样本文件）——
> 与文件顶部那条「作者的 docs 改动不入库」的既定口径一致。
> 所以下面这一轮的命令里，路径对已提交的文件是空操作，新代码只有前端与测试。

## 采购计划明细加高 + 不在池里的物料仍显示 + 引用下拉长文字换行

用户 2026-09-30 的三件事：① 采购计划要展示采购物料（**他后来确认第 1 条前半句是自己看错了**，
所以采购计划列表没有加列）、采购物料表单太矮；② 检查采购计划下单后能否自动流转到采购单；
③ 销售单引用下拉的信息若放不下就**换行**，而不是超出页面。

设计文档：`docs/design/purchase-plan-readability-and-ref-wrap-2026-09-30.md`。

**没有迁移、没有 API 行为改动**（API 侧只有测试文件）—— 前后端可以不同时上线，
两边都不动数据结构；`ordered`（下单落成的状态）本来就由计划服务写下。

> 「采购计划下单后是否自动流转」的核查结论：**是**。同一个事务里建采购单 + 回写计划行链接，
> 落成 `ordered`，而采购单列表的范围就是 `ordered / partially_arrived / arrived_complete`。
> 本轮补的守卫断言的是"落成的是**已下单**而不是草稿"——落成草稿的话，单子永远不进采购单列表，
> 而界面上不会有任何报错（唯一那种"错了也不响"的风险点）。

> ⚠️ **写这份清单时，另一条并行工作流（采购计划定价，`docs/design/purchase-plan-pricing-2026-09-30.md`）
> 正在同一个目录里动手**：它已经改了 `apps/api/prisma/schema.prisma`（给 `purchase_plan_items`
> 加 `currency`），并且大概率会改**同一个** `components/procurement/plan-detail-sheet.tsx`
> 与 `app/globals.css`。所以下面这条**逐文件列路径**，不要用目录：
> 用目录的话会把那条工作流的半成品一起提交（它可能还没有迁移文件，提了会当场坏了别人的单）。
> 提交前先 `git status` + `git diff -- <文件>` 确认每一个文件里只有这一轮的改动。

```powershell
git add apps/api/test/unit/purchase-plans-service.test.cjs apps/web/app/globals.css apps/web/components/procurement/plan-detail-sheet.tsx apps/web/components/procurement/plan-order-preview.tsx apps/web/lib/purchase-plan-table.test.mjs apps/web/lib/searchable-select-wrap.test.mjs apps/web/test/procurement-plans.test.tsx docs/design/purchase-plan-readability-and-ref-wrap-2026-09-30.md docs/log/2026-09-30.md docs/product/module-capability-catalog.md docs/task/PENDING-USER-COMMITS.md
git commit -m "feat: enlarge purchase plan rows and wrap long reference labels"
```

> `apps/web/app/globals.css` 里同时有上一轮（销售板块）那批样式，也可能混进定价工作流的样式：
> 这一条提交会把它们一起带上。只想提本轮那四处的话，先 `git add -p apps/web/app/globals.css` 逐块挑，
> 或者干脆等两条工作流都落地后一次提交（本轮与定价工作流**没有**功能依赖关系）。

> **2026-09-30 收尾现状**：这一轮（采购计划明细加高 / 不在池里的物料仍显示 / 引用下拉换行）
> 与并行的**采购计划定价**那一轮**已经一起入库**（同一天第三批的三个提交）。
> 上面那条命令因此是**空操作**，留着只为说明"哪几处属于这一轮"。

## 采购计划加价格字段（单价 / 行总价 / 计划合计）+ 采购↔财务对齐度排查

用户 2026-09-30：

> 「针对当前的采购计划，要求添加价格字段，单价，总价。不然财务没法付钱。
> 你也排查一下采购链路和财务链路的对齐度」

设计文档：[`purchase-plan-pricing-2026-09-30.md`](../design/purchase-plan-pricing-2026-09-30.md)；
对齐度排查（13 条，含 4 条高严重度，**本轮一条都没动账务**）：
[`procurement-finance-alignment-2026-09-30.md`](../design/procurement-finance-alignment-2026-09-30.md)。

**一条迁移尚未执行**（给 `purchase_plan_items` 加 `currency`），部署时先跑：

```powershell
npm run db:generate --workspace=@dilee/api
npm run db:migrate:deploy
```

```sql
-- 迁移后确认列建出来了：VARCHAR(10) / NOT NULL / 默认 'CNY'
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'purchase_plan_items' AND column_name = 'currency';
-- 期望一行：character varying / NO / 'CNY'::character varying
```

> **加列是唯一的数据库改动**，纯新增 + 常量默认值（PostgreSQL 11+ 不重写全表）；
> 历史行自动得到 `CNY`。**前后端不需要同时上线**：`currency` 只参与计划的读取展示，
> 旧前端（不传这个字段）下单时服务端仍会按组币种写回。
>
> ⚠️ **有一处行为收紧（不是数据结构改动）**：**单价为 0 的采购行不能再下单**
> （计划侧 `PURCHASE_PLAN_PRICE_REQUIRED`，采购单侧的下单门禁从"不为负"收紧成"必须大于 0"）。
> 上线前建议先查一次有没有"正在流程里、单价还是 0"的计划行：
>
> ```sql
> SELECT pp.plan_no, ppi.id, ppi.quantity, ppi.unit_price
> FROM purchase_plan_items ppi JOIN purchase_plans pp ON pp.id = ppi.plan_id
> WHERE ppi.deleted_at IS NULL AND pp.deleted_at IS NULL
>   AND ppi.purchase_order_item_id IS NULL AND ppi.unit_price = 0;
> ```
>
> 有的话不影响升级，但那几行必须由采购员补上单价才能下单（这正是本轮要拦的事）。
>
> **历史数据不迁移**：过去已经产生的 0 元采购单/0 元应付仍留在库里（见对齐度文档 §4 的核查 SQL）。
>
> 本轮改动已随同一天第三批的三个提交入库（后端 / 前端 / 文档），无需再手工 `git add`。

## 销售单订单号可改 + 全链联动改名

用户 2026-09-30：

> 「创建销售单，订单号写错了要支持编辑和修改。要做好全链条订单号的联动调整」

设计文档：[`sales-order-no-rename-2026-09-30.md`](../design/sales-order-no-rename-2026-09-30.md)。

**没有任何数据库迁移、没有新列/新表** —— 改号只更新既有列的值。部署就是普通代码发布。

> ⚠️ **行为变化（会被人当成 bug 报上来，先知道）**：
> 1. 销售单编辑页的「订单号」**现在真的能改了**。此前那一格可编辑、但保存时被
>    `delete payload.order_no` 丢掉（`sales-order-editor.tsx`），点保存不报错、号还是旧的 ——
>    这一条是本轮修掉的主症；
> 2. 改号会**弹一张影响面确认并强制填原因**（原因进审计）。改号不是"改一格"：
>    同一个事务里会改掉 **38 张冗余 `order_no` 的表** + 别的销售单上的返单来源引用 + 本单全部版本快照，
>    末尾还有残留校验（并发建单时整事务回滚，提示"请稍后重试"）；
> 3. **PATCH 请求体里现在允许 `order_no`**（此前 DTO 白名单会 400）。若有外部脚本依赖
>    "PATCH 带 order_no 必然 400"这条行为，需要同步；`customer_id` 仍然只读；
> 4. 空订单号仍然 400（空串不是"不动"，是"没填"）。

> **上线后需要业务做一件事（只有业务知道改什么）**：把历史上写错的订单号在销售单编辑页逐张改一次。
> 先查有哪些候选（单号形态明显异常的，按需要人工判断）：
>
> ```sql
> -- 人工判断用：数据里长什么样的单号各有多少（不自动判对错）
> SELECT order_no, status, count(*) OVER () AS total
> FROM sales_orders WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 50;
> -- 已经跑到下游、且单号里带空格/小写这类明显输入痕迹的（按需放宽）
> SELECT so.order_no, so.status,
>        (SELECT count(*) FROM purchase_orders po WHERE po.order_no = so.order_no AND po.deleted_at IS NULL) AS purchase_orders,
>        (SELECT count(*) FROM production_orders mo WHERE mo.order_no = so.order_no AND mo.deleted_at IS NULL) AS production_orders
> FROM sales_orders so
> WHERE so.deleted_at IS NULL AND (so.order_no <> btrim(so.order_no) OR so.order_no <> upper(so.order_no))
> ORDER BY so.created_at DESC;
> ```
>
> 改号**不需要**先回退下游：改号不动任何一张单的数量与金额。但**已关闭单只能单独改号**（要原因），
> 不能顺手改别的字段。**审计里的旧号不会回写** —— 按旧号反查要走
> `audit_events` 里 `action = 'sales_order.rename_order_no'` 的事件（details 带 `from` / `to` / 逐表条数）。
>
> **JSON 快照里的旧号不追改**（`purchase_orders.bom_snapshot`、`purchase_plans.bom_snapshot`、
> `production_orders.bom_snapshot`、`production_payroll_sources.source_snapshot`、`payroll_ledgers.source_snapshot`）——
> 它们只写不读（`grep -n 'bomSnapshot\|sourceSnapshot' apps/api/src` 全是写入与类型声明），
> 属于"存档证据"；唯一例外是本单的版本快照 `sales_order_versions.snapshot.order_no`，那个跟着改。




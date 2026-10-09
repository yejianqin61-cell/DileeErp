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

## 草稿销售单删除 + 生产月报表导出 + 应付合并付款

用户 2026-10-08 三件事：

> 「1.销售单部分，draft状态的销售单支持删除。
> 2.财务部分，请问现在支不支持，应付部分，同一个供应商的多个订单一起支付
> 3.生产部分，要支持，导出每月的生产月报表。展示这个月所有的订单的生产总量。这个是模板：`Dilee\example\财务\2026.6月同安.xlsx`」

第 2 条先是问答（**答案：部分支持** —— 合并出一张付款单早就支持，但那次「付款单」只是打印件，
不写核销、不改应付状态、不动银行；真核销的那条路后端一直有、界面没接），查清后用户把界面也排进了本轮。

设计文档：[`production-monthly-report-2026-10-08.md`](../design/production-monthly-report-2026-10-08.md)、
[`payable-merge-payment-2026-10-08.md`](../design/payable-merge-payment-2026-10-08.md)。

**第一轮三件事没有数据库迁移**（都是读既有表 + 写既有列）；**第二轮（同日，用户对三个待定项的回答
「1 可以 / 2 可以 / 3 不行」）加了一次迁移**：`20261008100000_sales_order_no_active_unique`
（把订单号唯一性改成「未删除行上唯一」，让删除释放订单号）。部署顺序：**先 `prisma migrate deploy`，再发代码**。

> ⚠️ **这次有迁移**（第二轮加的），内容就两句：
> `DROP INDEX "sales_orders_order_no_key";` 和
> `CREATE UNIQUE INDEX "sales_orders_order_no_active_key" ON "sales_orders"("order_no") WHERE "deleted_at" IS NULL;`
>
> 迁移**自带重复数据守卫**：未删除的行里若已有重复订单号，它会 `RAISE EXCEPTION` 中止
> （不会留下"索引只建了一半"的状态）。上线前可先自查，下面这条应返回 0 行：
>
> ```sql
> SELECT order_no, count(*) FROM sales_orders WHERE deleted_at IS NULL GROUP BY order_no HAVING count(*) > 1;
> ```
>
> 真有重复就先人工处理那几张单，再跑迁移。schema 侧 `SalesOrder.orderNo` 也**去掉了 `@unique`**
> （留着它会生成全量唯一索引，等于把这次改动偷偷改回去），改成 `@@index([orderNo])`。

> ⚠️ **行为变化（会被人当成 bug 报上来，先知道）**：
> 1. **销售单列表的草稿行多了一个「删除」**：点一下即删（**不弹确认框、不用填原因**，用户 2026-10-08 选定），
>    服务端是**软删** + 审计 `sales_order.delete`。只有草稿能删；有下游事实（BOM/采购/计划/生产/
>    成品出库/出库通知/退货/应收/收款/应收调整/应收对账）会被 422 拒绝并列出卡在哪几类。
> 2. **删除会释放订单号**（2026-10-08 第二轮，用户拍板「可以」）：唯一性从全表唯一改成
>    **未删除行上唯一**的部分唯一索引，所以「删掉一张号写错的草稿 → 再用同一个号重新建单」这条
>    顺手的路走得通（此前会被数据库直接拒掉）。占用预检与建单报错都只认**未删除**的行，
>    文案里不再出现「被一张已删除的销售单占着」。
>    要知道的**窄例外**：两张手工单据（收支流水 / 其他应付）的订单号是**手输**的 ——
>    若有人把号输成一张草稿的号、随后删掉那张草稿、再用同一个号建单，这张草稿的号码会被后续改号
>    一起带走（只动那一格的引用文本，金额与账务不受影响）。彻底消除它需要把这两张表也加进删除守卫。
> 3. 销售域新增一条 `DELETE /api/v1/sales-orders/:id` 路由（controller 18 → **19** 条）。
>    若有外部脚本依赖"DELETE 在这个路径上必然 404"，需要同步。
> 4. 生产页导出面板多了**第 6 个按钮「生产月报表」**，对应新路由
>    `GET /api/v1/production/reports/monthly-production-report.xlsx?month=YYYY-MM`（管理员）。
> 5. 财务「确认应付」页：**勾选放宽到已确认/部分付款的应付**（此前只有草稿能勾），
>    并新增「未核销余额」列与**「合并付款（N 条）」按钮**。
>    **这个按钮会真的动账面**：一次核销多条应付（可跨订单）→ 写核销行、改应付状态、
>    记收支流水并扣银行余额。它与旁边的「集中付款单」（**只是打印件，不动账**）是两回事，
>    培训时务必讲清哪一个才是记账。
> 6. **台账「付款情况 / 收款情况」的分档口径改了**（2026-10-08 第二轮，用户拍板「可以」）：
>    **未付/未收 = 草稿 + 已确认 + 部分付款**，**已付/已收 = 已付清/已收清**，作废/冲销仍只在「全部」。
>    依据：2026-09-24 起「确认」只是**挂账**（钱没动），旧口径（`confirmed` 算已付）来自「确认即记账」年代。
>    影响三处：① 「确认应付 / 确认应收」页默认的「未付 / 未收」视图里**现在能看到已确认但未结清的条目**
>    （以前要切「全部」才能看到）；② 界面上的「未付（N）/ 已付（M）」与导出台账的条数会同步变化
>    （现有数据下"未付"计数会变大，这是预期结果）；③ 导出台账的「付款情况」列里，
>    已确认从「已付」变成「未付」（草稿与已确认靠旁边「状态」列区分：应付草稿 / 应付已确认）。
>    应收侧一并生效（两边共用同一份口径文件与同一个 `payment` 参数）。

> **上线后需要业务做三件事**：
> 1. **第一次合并付款后人工核四处**：应付状态 → 核销行 → 收支流水 → 银行余额。
>    本环境没有数据库与 API，「真实过账确实改了台账与银行余额」没有端到端实测（只有服务层单测与请求契约）。
> 2. **生产月报表拿一个有真实数据的月份导出一次**，与车间手工台账对一遍 ——
>    重点看两处：「拉边」是否按本厂/外发分列正确、「同一订单同一工序出现多个单位」的格是否按单位分行列出
>    而没有相加。对不上时先查这两个口径，再看是不是某天的量只录了一个登记面。
> 3. **清历史草稿单**：确认无误的草稿可以直接删；已被下游引用过的不会被删掉（会报哪几类下游挡着）。

> **用户 2026-10-08 对三个待定项的决定（都已落地，只留结论在此）**：
> 1. 台账「已付 / 未付」口径重定义 → **可以**，已实施（见上面第 6 条与
>    [`payable-merge-payment-2026-10-08.md`](../design/payable-merge-payment-2026-10-08.md) 第 4 节）。
> 2. **让「删除」释放订单号 → 可以**，已实施（迁移见上面 ⚠️ 块；`SalesOrder.orderNo` 已去掉 `@unique`）。
> 3. **把「确认 + 付款」并成一步 → 不行**，未动：「接收 → 确认 → 付款」仍是三步，
>    合并付款只对**已确认**应付开放这一点也不变。

## 材料明细「其它」：自定义类目行

用户 2026-10-08（第三轮）：

> 「1.然后编辑销售订单的材料明细最后还需要加一个"其它"，可以自行添加类目。有时候还需要别的物料。
> 允许用户增删改。」

先问后做：**「其它」行要不要也能引用物料清单的物料 → 用户选「要，和 18 格一致」**。

设计文档：[`sales-order-material-extras-2026-10-08.md`](../design/sales-order-material-extras-2026-10-08.md)。

> ⚠️ **这一轮又有一次迁移**：`20261008110000_sales_order_material_extras`
> （建 `sales_order_material_extras` 一张表 + 两个索引 + 两个外键，**不改任何既有表、不动数据**）。
> 部署顺序：**先 `prisma migrate deploy`，再发代码** —— 不先跑迁移，销售单编辑页一保存就会
> 在「写其它行」这一步报数据库错（表不存在）。

> ⚠️ **行为变化**：
> 1. 销售单编辑页的「材料明细」面板末尾多了一块**「其它」**：一行是「类目 + 内容 +（可选）引用物料」，
>    可以**加行、删行、改任何一格**。类目由用户自己起名（弹簧 / 螺丝 / 胶袋…），
>    没有类目字典、也不跨单复用。
> 2. 这些行**随销售单保存**（与明细、引用同一形态），不是即时落库 ——
>    界面上加了行、没点保存就关掉，行会没。
> 3. 规则（前后端各判一次）：类目必填、**内容与引用至少要有一个**、类目 ≤ 50 字、
>    内容 ≤ 1000 字、**最多 20 行**。留空的行不提交、导出也不印。
> 4. **导出会多出这些行**：工艺单的材料区印在原来 18 项**之后**；类目名照用户起的字印，
>    内容空时用引用物料的摘要兜底。有图的引用物料同样出现在「带图片导出」的勾选弹窗里
>    （排在 18 项之后，键是内部用的 `extra:<行 id>`）。
> 5. **两处与 18 格故意不同**（会被人当成 bug 报上来，先知道）：
>    ① 选中物料时**只在内容为空时**预填名称/规格/颜色（18 格是无条件覆盖）——
>    因为「其它」的内容是人手写的、工厂要照做的那句话；
>    ② 删除行后**不保留空行**（「其它」允许 0 行）。
> 6. 顺手修掉一处既有缺口：导出的物料摘要查询漏了「规格 / 颜色」两个字段，
>    所以「引用了物料但格子里没写字」的兜底文字此前只有「MAT-1 伞骨」。
>    现在会带上规格与颜色（如 `MAT-1 伞骨 50cm 黑`）——导出件与以前不完全逐字一致，属修好。

> **上线后需要业务做一件事**：拿一张单填两三行「其它」（其中一行引用一个有图的物料），
> 走一遍**界面填 → 保存 → 重新打开 → 导出工艺单 → 带图片导出**，四处核对一致。
> 本环境没有数据库与 API，这条链路没有端到端实测过（只有服务层单测、请求契约与导出件字节层面的验证）。

## BOM 参考单价（采购单价链路）+ 报表只含已出货

用户 2026-10-08（第五轮）：

> 「1.采购计划要下单需要填写单价，但是BOM表没办法填写单价，检查一下这条链路。尤其是前端。
> 2.财务，财务报表，核算表，用户要求出了货才要进核算表。改进！」

先问后做（三题都给了推荐项）：**① 单价放哪 → 「BOM 表加「参考单价」列，建采购计划时预填到计划行」**；
**② 「出了货」的判据 → 「任一 posted/shipped/signed 成品出库单，或 dispatched 外加工直装柜」**；
**③ 只改核算表还是连毛利表 → 「两张表一起改」**。

设计文档：[`bom-reference-unit-price-2026-10-08.md`](../design/bom-reference-unit-price-2026-10-08.md)、
[`finance-shipped-only-reports-2026-10-08.md`](../design/finance-shipped-only-reports-2026-10-08.md)。

> ⚠️ **这一轮有迁移**：`20261008150000_bom_item_reference_price`
> （给 `bom_items` 加 `reference_unit_price DECIMAL(18,4)` + `reference_currency VARCHAR(10)` 两列，
> **可空、无默认值、无外键、无索引** —— 纯加列，历史 BOM 行都是 NULL，不改任何数据）。
> 部署顺序：**先 `prisma migrate deploy`，再发代码** —— 不先跑迁移，BOM 表一保存就会在写明细这一步
> 报「列不存在」。

> ⚠️ **行为变化**（第 1 件，采购单价链路）：
> 1. **排查结论先说**：计划里**前端本来就有单价输入框**（采购计划 → 打开计划 → 明细表第 8 列），
>    保存与下单都正常 —— 断点不在代码里，是 `itemsFromBom` 把单价写死 `"0"`，采购员只能凭记忆逐行打。
> 2. BOM 表多一列**「参考单价」**（一格 = 币种下拉 + 价；位置在「供应商」右侧）：
>    填了之后**新建采购计划时会自动预填到计划行的单价**（采购员仍按实际报价改）；
>    留空就是还没谈价，计划行单价仍是 0、**不能下单**。
> 3. 它是"这个部件通常多少钱"的**备查 + 预填**信息，与「默认供应商」同一条地位：
>    **不参与任何金额计算**（成本/毛利/应付一律取采购单上的实际单价，取价口径一行没动）。
> 4. **生产模块的 BOM 表不显示这一列**（价是采购的知识），但**保存时行里的价照旧回传**——
>    生产侧保存 BOM 不会把采购填过的价或供应商抹掉。
> 5. 表里多了一句话说明这条链路（「填了会预填到采购计划…」），BOM 表也**重新配平了十列宽度**。

> ⚠️ **行为变化**（第 2 件，财务报表）：
> 1. **核算表与销售利润表(毛利)现在只含「已出货」的销售单**：
>    已确认/已关闭 且（成品出库单 `posted/shipped/signed` **或** 外加工直装柜 `dispatched`）。
>    → **已确认但还没出货的单不再出现在这两张表里**（这是本轮最主要的可见变化，报表行数会变少）。
> 2. **只出了一部分的单照旧进表**（一行仍是整单的数），但表尾会写「SO-x（已出 30 / 订单 100 打）」；
>    未出货被排除的单也**列出单号**（让你一眼看出"这张单还没发货"，而不是以为漏了）。
> 3. **期间口径没变**，仍是**销售单日期**：一张 8 月的单若 9 月才出货，它出现在 **8 月**的报表里，
>    9 月的报表看不到它。**这一条要不要改成按出货日期，等你一句话**（改动不大，见设计文档 §五）。
> 4. 其它报表（销售/采购对账、收支、外汇一览、三大报表）**一行没动**：它们取的是钱的事实（应收/应付/流水）。
> 5. 前端不需要改：表尾说明页面上本来就会显示（页面上看到的与导出的同一份）。

> **上线后建议业务核对两件事**：
> ① 在一张 BOM 上填几行参考单价（其中一行换币种为 USD）→ 新建采购计划 → 看计划行单价与币种是否带过来了
>    （计划里改价仍照旧生效）；
> ② 打开「财务报表 → 核算表」看行数是否等于"已确认且已出货"的单数，并确认表尾的未出货名单对不对。
> 本环境没有数据库与 API，这两条链路都**没有端到端实测**（只有服务层单测、请求契约与组件测试）。

## 已有计划也能拿到 BOM 参考单价（用户报障的补丁）

用户 2026-10-08（第六轮）：

> 「为什么BOM表保存了单价之后，采购计划显示不了单价，下单不了」

**根因**：从 BOM 预填单价**只发生在"新建采购计划那一刻"**（计划的明细是建立时的快照，口径 12）——
先建计划、后去 BOM 填价的人，计划行永远停在 0 价，而 0 价不能下单。

设计文档：[`purchase-plan-bom-reference-refill-2026-10-08.md`](../design/purchase-plan-bom-reference-refill-2026-10-08.md)。
**本轮无迁移**（只加了一个只读字段与前端预填）。

> ⚠️ **行为变化**：
> 1. **打开采购计划时**，**未下单且单价还是 0** 的行会按 **BOM 表上当前填的「参考单价」自动带入**那一格
>    （带可能的币种）：那几格是**浅黄底**，鼠标停上去写明来源；表上方一句说明写清"几行、来自 BOM 参考单价、
>    **保存计划后才写进计划**、逐行都能改"。
> 2. **只填空格**：单价已经 > 0 的行、以及**已下单**的行一律不动（已下单行在服务端是硬锁的）。
> 3. 所以修好之后的操作是：**重新打开那份计划 → 保存计划 → 下单**。
>    想在保存前改价、或不想用 BOM 上的价，直接改那一格即可（一改，标记就消失）。
> 4. 计划列表的「计划金额」列显示的是**库里已存**的价，**保存计划之后**才会更新。
> 5. 单价 0 被拦住下单时的提示也补上了出路：「可以在这格里手填，或去 BOM 表给这些物料填「参考单价」
>    后重新打开本计划」。
> 6. **供应商不做同样的回填**（它决定"这张单发给谁"，规则要先定）。

> **上线后请拿一份已有计划验证一次**：在它的 BOM 上给某行填参考单价 → 重新打开那份计划（价应自动带过来、
> 浅黄底 + 面板说明）→ 保存计划 → 下单应能通过。本环境没有数据库与 API，这条没有端到端实测。






# 待用户提交的 Git 命令

本文件记录已完成、但因本地 `.git` ACL 暂不能由 Codex 执行的提交。请在仓库根目录按顺序执行；每条提交独立对应一个完成的任务。

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

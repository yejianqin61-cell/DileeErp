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

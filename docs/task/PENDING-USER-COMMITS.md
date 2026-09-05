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

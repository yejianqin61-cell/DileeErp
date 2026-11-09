# 任务：会计科目「类目」可增删改查（2026-11-07）

需求原文（用户 2026-11-07）：「针对财务模块的会计科目，现在要允许用户自行对会计科目的类目进行增删改查，现在是否有前后端支持？如果没有，加上去」。

设计文档：[`docs/design/accounting-subject-category-crud-2026-11-07.md`](../../design/accounting-subject-category-crud-2026-11-07.md)（数据模型 / API 契约 / 业务规则 / 迁移 / 验证计划全在里面，本文件只列交付与验收）。

## 1. 现状结论（回答「是否有前后端支持」）

- 科目本身有前后端 CRUD；
- **类目没有**：后端只有一个只读派生接口 `GET /finance/accounting-subjects/categories`（5 个内置类目 ∪ 库里出现过的取值），前端的分类只是个下拉，不能新增、不能改名、不能删除。

## 2. 交付清单

| # | 交付物 | 位置 | 负责 |
| --- | --- | --- | --- |
| 1 | 表模型 `AccountingSubjectCategory` | `apps/api/prisma/schema.prisma` | api |
| 2 | 迁移：建表 + 种 5 个内置类目 + 回填历史类目 | `apps/api/prisma/migrations/20261107200000_accounting_subject_categories/migration.sql` | api |
| 3 | 新库 seed：先种类目再种科目 | `apps/api/prisma/seed.ts` | api |
| 4 | 类目服务（列表/新增/改名级联/删除守卫/审计） | `apps/api/src/modules/finance/accounting-subject-category.service.ts`（新） | api |
| 5 | 类目控制器（读 finance、写仅管理员） | `apps/api/src/modules/finance/accounting-subject-category.controller.ts`（新） | api |
| 6 | 注册进 FinanceModule | `apps/api/src/modules/finance/finance.module.ts` | api |
| 7 | 科目写入口校验类目存在 | `apps/api/src/modules/finance/accounting-subject.service.ts` | api |
| 8 | 兼容：`/accounting-subjects/categories` 改读类目表 | `accounting-subject.service.ts` | api |
| 9 | API 单测（类目服务 + 科目类目校验 + 迁移守卫） | `apps/api/test/unit/accounting-subject-category-service.test.cjs`（新）等 | api |
| 10 | 前端类型/路径共用件 | `apps/web/lib/accounting-subjects.ts` | web |
| 11 | 会计科目页「科目类目」面板（列表/新增/改名/删除） | `apps/web/components/finance/accounting-subject-workspace.tsx` | web |
| 12 | 科目筛选与弹窗改用新类目清单 | 同上 | web |
| 13 | 组件测试（类目 CRUD + 既有科目 CRUD 不回归） | `apps/web/test/accounting-subject-page.test.tsx`、`cash-flow-page.test.tsx` 等 | web |
| 14 | 独立验证探针 + 真实 Chromium 截图 | `.agent/verify/`、`docs/test/results/accounting-subject-category-crud/` | verifier |
| 15 | 日志 / 能力目录 / 证据索引 | `docs/log/2026-11-07.md`、`docs/product/module-capability-catalog.md` | lead |

## 3. 验收清单

- [x] `GET /finance/accounting-subject-categories` 返回类目 + 科目数 + 内置标记 + 创建人/最后修改人，排序为「内置五类按会计制度顺序 → 自建按 sortOrder/名称 → 历史类目」
- [x] 新增类目：管理员可建，重名 422，非管理员 403；审计事件落库
- [x] 改名自建类目：同一事务内级联更新**全部**科目（含软删）的 `category`；三大报表与凭证不受影响（内置五类不可改名）
- [x] 内置五类改名/删除 → 422；有科目的类目删除 → 422 且 message 说明还有几个科目
- [x] 空类目删除成功且可用同名重建（物理删除）
- [x] 科目新增/编辑时填一个不存在的类目 → 422（类目清单是唯一口径）
- [x] 迁移：建表、唯一索引、种 5 个内置类目、`DISTINCT category` 回填、空库跳过；种子与 `ACCOUNTING_SUBJECT_CATEGORIES` 逐字一致
- [x] 前端：类目面板可见可操作；内置/历史行无改名删除按钮；科目弹窗与筛选下拉来自新清单（新增科目下拉不含历史类目，编辑含）
- [x] API 全量单测 / web lib / 组件测试 / typecheck（api、web、coding-worker）/ `next build` / 两条覆盖守卫全绿
- [x] 独立验证：真实 Chromium 截图（桌面宽屏）+ 手写 Prisma 替身跑真实 service 的 CRUD 断言（121/121）
- [ ] **未验证项写明**：真实 PostgreSQL 未跑迁移（本机无库），部署前需在测试库执行 `migrate deploy`（部署顺序见 §4）

## 4. 部署步骤（上线前必做）

```bash
npm run db:generate --workspace=@dilee/api
npx prisma migrate deploy
```

# 会计科目类目 CRUD 独立验证报告（2026-11-07，task-10）

- 需求（用户 2026-11-07）：「针对财务模块的会计科目，现在要允许用户自行对会计科目的类目进行增删改查，现在是否有前后端支持？如果没有，加上去」
- 权威文档：[`docs/design/accounting-subject-category-crud-2026-11-07.md`](../../docs/design/accounting-subject-category-crud-2026-11-07.md)、[`docs/task/2026-11-07-accounting-subject-category/README.md`](../../docs/task/2026-11-07-accounting-subject-category/README.md)
- 结论：**通过 —— 发现 0 个真实缺陷**（三个层面全部通过；未改源码、未 git commit）
  - API 语义探针（手写 Prisma 替身跑 dist 真实 service + 控制器）：**63/63**
  - 迁移 / schema / seed 静态检查：**30/30**
  - 真实 Chromium（next dev -p 3107 + `page.route` 打桩，不连数据库）：**28/28**；非注入路径 console error **0**、pageerror **0**；1440 / 1920 截图 8 张
  - 合计 **121/121** 条断言通过

## 1. 产物路径

| 产物 | 路径 |
| --- | --- |
| API + 迁移探针 | `C:\Users\USER\Desktop\Dilee\.agent\verify\accounting-subject-category-probe.mjs` |
| API + 迁移结果 JSON | `C:\Users\USER\Desktop\Dilee\.agent\verify\accounting-subject-category-results.json` |
| 浏览器视觉探针 | `C:\Users\USER\Desktop\Dilee\.agent\verify\accounting-subject-category-visual.mjs` |
| 浏览器结果 + 截图清单（summary.json） | `C:\Users\USER\Desktop\Dilee\docs\test\results\accounting-subject-category-crud\summary.json` |

截图（均在 `C:\Users\USER\Desktop\Dilee\docs\test\results\accounting-subject-category-crud\`）：

| 截图 | 视口 | 证明什么 |
| --- | --- | --- |
| `desktop-1440-full.png` | 1440×900 | 整页：类目面板在科目面板上方、5 内置 + 自建 + 历史三态行、科目表与两个维护面板 |
| `desktop-1440-category-panel.png` | 1440×900 | 类目面板特写：内置行「内置类目（会计制度口径，不可改）」、自建行改名/删除、历史行标签 |
| `desktop-1920-full.png` | 1920×1080 | 宽屏整页（同上，无横向溢出） |
| `desktop-1920-category-panel.png` | 1920×1080 | 宽屏类目面板特写 |
| `category-create-dialog.png` | 1440×900 | 「新增科目类目」弹窗 |
| `category-delete-toast.png` | 1440×900 | 删除 422 时 toast 原样显示「该类目下还有 2 个科目，请先把这些科目改到其它类目后再删除」 |
| `subject-create-category-options.png` | 1440×900 | 新增科目弹窗：分类下拉**不含**历史类目「未分类」 |
| `history-subject-edit.png` | 1440×900 | 编辑历史类目上的科目：分类下拉**含**「未分类」（默认选中） |

## 2. API 语义探针（63/63，手写 Prisma 替身 + dist 真实实现）

不读实现者单测；直接 `require apps/api/dist/modules/finance/accounting-subject-category.service.js` 与 `accounting-subject.service.js`，用内存 Prisma 替身（记录调用形状、事务边界、写操作）逐条断言：

### 2.1 `list()` 排序与计数（12 条）

- 固定数据故意把 5 个内置类目的 `sortOrder` 打乱（50/50/30/20/10），并放两个自建类目（共同类 60、其他类 70）与一个只存在于科目行的历史类目「未分类」；
- 实测顺序 = **资产类 → 负债类 → 成本类 → 所有者权益类 → 损益类 → 共同类 → 其他类 → 未分类**（内置按会计制度顺序、不看权重；自建按 sortOrder；历史 `id=null` 最后）；
- `subjectCount` = 未软删科目数（含停用）：资产类 **2**、共同类 **2**（3 个里软删 1 个不计）、未分类 **2**；`activeSubjectCount` = 其中启用：资产类 **1**、共同类 **2**、未分类 **1**；空类目 0/0；
- 历史行 `id=null / isSystem=false / createdBy=null / createdAt=null`，排在最后；
- 三个查询口径：1 次 `accountingSubjectCategory.findMany` + 2 次 `accountingSubject.groupBy`（`{deletedAt:null}` 与 `{deletedAt:null,isActive:true}`），不随科目行数拉明细。

### 2.2 `create()`（8 条）

- 默认 `sortOrder` = 当前最大值 + 10（数据最大 70 → **80**）；显式 `sort_order: 99` 原样使用；
- 落库 `isSystem=false`、`name` trim、审计人 = 当前用户；审计事件 `accounting_subject_category.create`（含 name/sort_order/actor）；
- 重名 → 422 `ACCOUNTING_SUBJECT_CATEGORY_DUPLICATED`（不写库）；空名/纯空格、>30 字 → 422 `ACCOUNTING_SUBJECT_CATEGORY_FIELD_REQUIRED`（不写库）。

### 2.3 `update()` 改名级联 / 排序 / 保护（16 条）

- **改名在同一个 `$transaction` 里**：`accountingSubjectCategory.update` 与 `accountingSubject.updateMany` 都记录 `inTransaction=true` 且 `transactionId` 相同；
- 级联 `updateMany` 的 `where` **只有 `{category: 旧名}`，没有 `deletedAt` 过滤**（唯一键不认软删 → 必须连软删行一起改）；`data = {category: 新名, updatedBy}`；
- 级联覆盖全部 3 行（含 1 个软删科目），**`affectedSubjects = 3`**，审计 `accounting_subject_category.rename` 带 before/after 与 `affected_subjects: 3`；
- 只改排序：不级联（updateMany 0 次），审计 action = `.update` 且不带 `affected_subjects`，before/after 的 sort_order 正确；
- no-op（名称与排序都没变）：只做一次 get 查询，不写库/不进事务/不记审计；
- 内置类目改名或改排序 → 422 `ACCOUNTING_SUBJECT_CATEGORY_SYSTEM`（被拒时不进事务、不写库）；
- rename 撞已有类目名 → 422 `DUPLICATED`（不进事务）；改到自己当前名字不算重名（放行）；
- 不存在的 id → 404 `ACCOUNTING_SUBJECT_CATEGORY_NOT_FOUND`；名称 trim 后落库。

### 2.4 `remove()` 删除守卫（6 条）

- 内置类目 → 422 `SYSTEM`（不下发 delete）；
- 有未软删科目的类目 → 422 `ACCOUNTING_SUBJECT_CATEGORY_IN_USE`，message 含「**2 个科目**」，details `subject_count:2`，不下发 delete、不记审计（共同类 3 个科目里 1 个软删 → 计 2）；
- 空类目 → **物理删除**（`delete where id`），审计 `accounting_subject_category.delete` 带类目名与操作人；
- 不存在的 id → 404 `NOT_FOUND`。

### 2.5 科目写入口的类目校验（8 条）

- `AccountingSubjectService.create`：类目不存在 → 422 `ACCOUNTING_SUBJECT_CATEGORY_NOT_FOUND`（message「分类「不存在类」不存在，请先到「科目类目」里新增」），不写科目；类目存在 → 正常落库（sortOrder 接同分类最后一个 +10）；
- `AccountingSubjectService.update`：**编辑历史类目上的科目且不换分类 → 放行，且不查类目表**（历史科目仍可改名/改方向）；改到不存在的类目 → 422 且不写科目；改到已存在类目 → 放行并写新分类。

### 2.6 控制器契约（7 条）

- 路由前缀 `finance/accounting-subject-categories`，类级 `@RequireModules("finance")`；
- `GET /`、`POST /`、`PATCH /:id`、`DELETE /:id`；**写操作（POST/PATCH/DELETE）都有 `@RequireAdministrator`，读列表没有**。

## 3. 迁移 / schema / seed 静态检查（30/30）

本机无 PostgreSQL（未跑迁移），按设计 §5/§7 做静态检查：

- 迁移 `20261107200000_accounting_subject_categories/migration.sql`：
  - 建表 9 列全对（`id UUID`、`name VARCHAR(30) NOT NULL`、`sort_order INTEGER NOT NULL DEFAULT 0`、`is_system BOOLEAN NOT NULL DEFAULT false`、`created_at/updated_at TIMESTAMP(3)`、`created_by/updated_by UUID`、主键）；
  - `CREATE UNIQUE INDEX accounting_subject_categories_name_key ("name")`、`CREATE INDEX accounting_subject_categories_sort_order_idx ("sort_order")`；
  - 5 个内置类目名与顺序与 `accounting-subject-catalog.ts` 的 `ACCOUNTING_SUBJECT_CATEGORIES` **逐字一致**（资产类/负债类/成本类/所有者权益类/损益类），排序 10/20/30/40/50；
  - 回填：`SELECT DISTINCT category FROM accounting_subjects` 里不在类目表的取值，`60 + (row_number() OVER (ORDER BY legacy.category) - 1) * 10`，`NOT EXISTS` 防重 + `ON CONFLICT DO NOTHING`；内置五类先于回填插入；
  - 空库（无 users）：`SELECT id INTO actor_id FROM users ORDER BY created_at LIMIT 1` + `IF actor_id IS NULL THEN RETURN;`（建表仍执行，种入/回填跳过）；审计人取最早用户；
  - 不建 `deleted_at`（类目是物理删除）。
- `schema.prisma`：`model AccountingSubjectCategory` 存在，`name @unique @db.VarChar(30)`、`sortOrder @map("sort_order") @default(0)`、`isSystem @map("is_system")`、审计列 UUID、`@@index([sortOrder])`、`@@map("accounting_subject_categories")`、无 deletedAt。
- `seed.ts`：5 个内置类目的 `upsert(by name)` 循环**在科目种入循环之前**；`sortOrder=(index+1)*10`、`isSystem=true`；常量与迁移/目录同源导入。

## 4. 真实 Chromium 视觉/交互（28/28）

环境：`apps/web` 下 `npx next dev -p 3107`（真实 Next dev，跑完已关闭、端口已释放）+ Playwright 真实 Chromium；所有 `/api/v1/**` 由 `page.route` 打桩（不连数据库），页面 `/finance/cash-flow?tab=subjects`。

- **面板与行集**：「科目类目」面板可见、位于「会计科目」表上方；「共 7 个类目」；行顺序 = 内置五类 → 自建「共同类」→ 历史「未分类」；科目数显示「启用 58 / 共 60」这类；类型列 = 内置/自建/历史。
- **内置只读**：5 个内置行都只有「内置类目（会计制度口径，不可改）」标签，**没有**改名/删除按钮；自建「共同类」行有改名 + 删除按钮；历史「未分类」行只有「历史类目（仅存在于历史科目）」标签、**没有**按钮。
- **新增类目**：弹窗标题「新增科目类目」；提交时捕获到的请求 = `POST /api/v1/finance/accounting-subject-categories`，body 恰为 `{"name":"测试类目"}`；成功 toast「已新增科目类目「测试类目」」。
- **改名**：弹窗标题「改名科目类目：共同类」且预填当前名；请求 = `PATCH /api/v1/finance/accounting-subject-categories/cat-custom`，body 恰为 `{"name":"共同类（改名）"}`；成功 toast 文案正确。
- **删除 422**：弹窗标题「删除科目类目：共同类」+ 删除说明；请求 = `DELETE /api/v1/finance/accounting-subject-categories/cat-custom`；mock 422 的 message 以 toast **原样显示**：「该类目下还有 2 个科目，请先把这些科目改到其它类目后再删除」。
- **新增科目分类下拉**：选项 = 资产类/负债类/成本类/所有者权益类/损益类/共同类，**不含**「未分类」（历史类目会被后端 422 拦掉，不能给必然失败的选项）。
- **编辑历史类目上的科目**：分类默认值「未分类」；下拉选项**包含**「未分类」。
- **布局**：1440 与 1920 均无横向溢出。
- **控制台**：`pageerror = 0`；console error 原始 **1 条 = 本次故意注入的 DELETE 422 资源日志**（验证删除守卫文案所必需），**非注入路径 0**。`summary.json` 里同时记录 `consoleErrorsRaw`（1）与 `consoleErrors`（0，非注入）。

## 5. 缺陷 / 未覆盖点

- **真实缺陷：0 个**。本轮未发现与设计文档不符的实现行为；没有为了通过而放宽断言（浏览器探针全部按设计 §3/§4/§6 断言）。
- **未验证项（环境限制，须在部署前补）**：
  1. **真实 PostgreSQL 未执行迁移**：DDL 与回填逻辑只做了静态检查（列/索引/常量/空库跳过/回填 SQL 形状）；部署前需在测试库跑一次 `npm run db:generate --workspace=@dilee/api` + `npx prisma migrate deploy`（设计 §5.3 同口径）。
  2. 浏览器层面是 **page.route 打桩**，未与真实 API/数据库联调；后端语义由探针的 Prisma 替身覆盖。
  3. 只覆盖桌面 1440/1920（类目面板是后台维护页，设计未要求移动端）；窄屏表现未验证。
  4. 设计 §4.6/§8 明确不做：类目合并、科目批量迁类目、界面拖拽排序 —— 这些不是缺陷。
- **过程记录**：验证期间同一 checkout 另有会话在跑 vitest（与本页面无关，未影响）；我起的 3107 dev server 已关闭，端口无监听。

## 6. 复现命令

```powershell
cd C:\Users\USER\Desktop\Dilee

# 1) API 语义 + 迁移静态检查（不需要数据库、不需要 dev server）
node .agent\verify\accounting-subject-category-probe.mjs
#    期望：API 63/63、迁移 30/30，结果写 .agent/verify/accounting-subject-category-results.json

# 2) 浏览器视觉/交互（独立端口 3107）
cd apps\web
npx next dev -p 3107
#    另一个终端：
cd C:\Users\USER\Desktop\Dilee
node .agent\verify\accounting-subject-category-visual.mjs
#    期望：28/28、pageerror 0、非注入 console error 0，截图 + summary.json 落在
#    docs\test\results\accounting-subject-category-crud\
#    跑完关掉 dev server 并确认端口释放：
Get-NetTCPConnection -LocalPort 3107 -State Listen -ErrorAction SilentlyContinue
```

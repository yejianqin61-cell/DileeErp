# 会计科目类目（分类）可维护化 —— 设计（2026-11-07）

## 1. 需求与现状盘点

用户 2026-11-07：「针对财务模块的会计科目，现在要允许用户自行对会计科目的类目进行增删改查，现在是否有前后端支持？如果没有，加上去」

### 1.1 现状：科目有 CRUD，**类目没有**

| 能力 | 后端 | 前端 | 结论 |
| --- | --- | --- | --- |
| 会计科目 增 / 改 / 停用 / 删 / 查 | `GET/POST/PATCH/DELETE /finance/accounting-subjects`（`accounting-subject.controller.ts`，写仅管理员） | `/finance/cash-flow?tab=subjects` 会计科目页（`accounting-subject-workspace.tsx`） | ✅ 已有 |
| 类目（分类）查 | `GET /finance/accounting-subjects/categories`：**只读派生**，返回「5 个内置类目 ∪ 库里出现过的取值」的字符串数组 | 分类筛选下拉、新增/编辑科目弹窗的「分类」下拉 | ⚠️ 只有派生清单，不是可维护的数据 |
| 类目 增 | ❌ 只能「新建科目时填一个没人用过的 category 字符串」才能顺带出现，UI 的分类是下拉，连这条路都走不通 | ❌ | 要做 |
| 类目 改（改名） | ❌ 只能逐个科目改分类；类目名本身不是实体 | ❌ | 要做 |
| 类目 删 | ❌ 无法删除；旧口径是「有科目的类目就永远留着」 | ❌ | 要做（有科目时按规则拒绝） |

根因：`accounting_subjects.category` 是 `VARCHAR(30)` 字符串，类目只是科目行上的一个取值，不存在「类目」这张表，所以没有可增删改的对象。

### 1.2 为什么不能只靠「去重 category 字符串」继续做

「查」可以靠 `SELECT DISTINCT category` 派生，但：
- **改名**必须改一批科目行且要原子（半途失败 = 科目散落在新旧两个名字下，报表的分类小计被拆成两段）；
- **删除**必须能判断「这个类目下还有没有科目」，否则删掉的类目会从下拉里消失，而科目还在；
- **新增**必须落成一条可审计的记录（谁在什么时候加了一个类目），派生清单没有任何地方存这件事；
- 类目排序（5 个内置类目按会计制度顺序、自建类目接在后面）需要持久化。

宪法《Configurable Business Categories》要求分类必须能通过管理界面增删改停用，且被业务数据引用的分类要留成历史快照 —— 类目成为一等实体才满足这条。

## 2. 数据模型

新增表 `accounting_subject_categories`（`AccountingSubjectCategory`）：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | UUID PK | |
| `name` | VARCHAR(30) **UNIQUE** | 类目名，全表唯一 |
| `sort_order` | INTEGER | 排序权重：5 个内置类目 = 10/20/30/40/50（会计制度顺序），自建类目接在最大值之后 +10 |
| `is_system` | BOOLEAN | 内置类目（会计制度五类）。**不许改名、不许删除**（见 §4.2） |
| `created_at / updated_at / created_by / updated_by` | 审计列 | 与全站一致；列表经 `AuditActorInterceptor` 自动补 `created_by_name / updated_by_name` |

**`accounting_subjects.category` 继续保留字符串，不改成外键**，理由：
1. 三大报表（`finance-three-statements.ts` 的资产负债表/利润表行映射）与凭证（`voucher.service.ts` 的「资产类」银行存款候选）**按类目名匹配科目**，这些映射是会计制度口径、不随用户配置漂移，改成外键反而要在运行时把名字翻译一遍，读代码的人看不出「为什么这行只认资产类」；
2. 一个科目只属于一个类目，字符串没有冗余问题；类目改名由服务层在同一事务里级联 UPDATE 全部科目（含软删的，理由见 §4.3）；
3. 历史数据（已记过账的科目）不需要迁移任何引用，风险最小。

代价与对策：字符串可能指向一个不存在的类目行（历史数据 / 绕过接口写入）。对策见 §4.5「历史类目的显示」。

## 3. API 契约

新控制器 `apps/api/src/modules/finance/accounting-subject-category.controller.ts`，路由前缀 `/finance/accounting-subject-categories`；读走 `finance` 模块权限，**写仅管理员**（与会计科目维护同一约定：这是全站财务口径的基础数据）。

### 3.1 `GET /finance/accounting-subject-categories`

```jsonc
{ "data": [{
  "id": "uuid | null",          // null = 只存在于科目表里的历史类目（见 §4.5），不可改名/删除
  "name": "损益类",
  "sortOrder": 50,
  "isSystem": true,
  "subjectCount": 71,           // 该类目下未软删的科目数（含停用）
  "activeSubjectCount": 70,     // 其中启用中的
  "createdBy": "uuid", "updatedBy": "uuid",
  "createdAt": "...", "updatedAt": "...",
  "created_by_name": "张三", "updated_by_name": "李四"
}], "meta": {} }
```

排序：内置类目按 `ACCOUNTING_SUBJECT_CATEGORIES` 的顺序（资产类 → 负债类 → 成本类 → 所有者权益类 → 损益类），自建类目接在后面按 `sortOrder`、再按名称；历史类目最后。

### 3.2 `POST /finance/accounting-subject-categories`

请求 `{ "name": "共同类", "sort_order": 60 }`（`sort_order` 可省略，默认 = 当前最大 +10）。
- 名称 trim 后必填，≤30 字；
- 与已有类目重名 → 422 `ACCOUNTING_SUBJECT_CATEGORY_DUPLICATED`；
- 审计事件 `accounting_subject_category.create`。

### 3.3 `PATCH /finance/accounting-subject-categories/:id`

请求 `{ "name": "共同类（新）", "sort_order": 70 }`，两者都可选。
- **改名**：同一事务内
  1. 改 `accounting_subject_categories.name`；
  2. `UPDATE accounting_subjects SET category = 新名 WHERE category = 旧名`（**不带 `deleted_at IS NULL`**，见 §4.3）；
  3. 审计事件 `accounting_subject_category.rename`，带 `before/after` 与受影响科目数。
- 内置类目改名或改排序 → 422 `ACCOUNTING_SUBJECT_CATEGORY_SYSTEM`；
- 重名 → 422 `ACCOUNTING_SUBJECT_CATEGORY_DUPLICATED`；
- 不存在的 id → 404 `ACCOUNTING_SUBJECT_CATEGORY_NOT_FOUND`。

### 3.4 `DELETE /finance/accounting-subject-categories/:id`

- 内置类目 → 422 `ACCOUNTING_SUBJECT_CATEGORY_SYSTEM`；
- 该类目下还有未软删的科目 → 422 `ACCOUNTING_SUBJECT_CATEGORY_IN_USE`，message 写明「还有 N 个科目，请先把这些科目改到其它类目」；
- 否则**物理删除**该类目行（不是软删）：类目行不承载任何业务事实，删除时科目一条都没有，硬删让「删掉写错的类目 → 用同名重新建」成为可能（软删 + 唯一索引会让同名永远建不回来）；
- 审计事件 `accounting_subject_category.delete` 留下类目名与操作人。

物理删除与宪法《Configurable Business Categories》第 2 条不冲突：**已使用**的类目不会被删除（直接拒绝），用户要「不再用」应当先把科目迁走；这里拒绝删除而不是留一条 disabled 的类目行，是因为类目不参与任何账务计算，留空壳只会让下拉里多一个永远选不到科目的项。

### 3.5 兼容：`GET /finance/accounting-subjects/categories`

保持原有返回形状（`string[]`）与地址不变：类目表里的名称 ∪ 科目表里出现但类目表没有的历史名称，按同一顺序。已有调用方（老前端版本、第三方脚本）不需要改。

### 3.6 科目写入口增加类目校验

`AccountingSubjectService.create / update` 在写库前校验 `category` 在类目表里存在，否则 422 `ACCOUNTING_SUBJECT_CATEGORY_NOT_FOUND`（「分类「X」不存在，请先到「科目类目」里新增」）。
这是「类目是唯一清单」的守门：没有它，任何客户端都能再写进一个没人看得见的类目字符串，§3.1 的清单就不再可信。

## 4. 业务规则与边界

### 4.1 为什么内置五类不许改名 / 删除

`finance-three-statements.ts`（资产负债表 / 利润表）与 `voucher.service.ts` 的科目匹配**硬编码了「资产类 / 负债类 / 成本类 / 所有者权益类 / 损益类」这五个名字**：
- 它们不是「用户可配置的展示分组」，而是会计制度对科目的法定分类，报表行次（货币资金、应付账款、营业收入…）就按这五类取数；
- 允许改名会让三大报表静默变成一张空表（没有任何报错，只是所有行次取不到科目），这是财务核对时最难查的一类问题；
- 用户要的是「自己增加类目」，内置五类保持只读不影响这一点。

### 4.2 自建类目能做什么

新增、改名、改排序、删除（仅在无科目时）。改名级联全部科目，历史流水/凭证展示的 `分类 / 名称` 会跟着变成新类目名 —— 这正是「改口径」的含义（流水存的是 `subject_id`，展示时按主键取科目当前名字与当前类目）。

### 4.3 改名为什么连软删的科目一起改

科目表唯一键是 `@@unique([category, name])`，**唯一索引不认 `deleted_at`**。若只改未删除的科目，删掉一个科目后「旧类目 + 同名新科目」仍会被数据库挡住（服务层 `assertUnique` 已把这条解释过）。改名时一并更新软删行，避免在旧类目名下留一颗未来的唯一键地雷。

### 4.4 删除守卫为什么挡住停用的科目

停用的科目仍在会计科目页列出（`include_inactive=true`），历史流水上也还挂着它们的名字。类目被删后这些科目会失去「所属类目」，下拉里选不到。所以「有未软删科目（含停用）」就拒绝删除。

### 4.5 历史类目的显示（`id: null` 行）

若某科目行的 `category` 在类目表里查不到（只在极端情况出现：迁移前的旧备份被整库恢复、或绕过接口直写数据库），`GET` 列表把该名称合成一行 `id: null` 的历史类目返回：
- 它出现在**筛选下拉与「编辑科目」的分类下拉**里，保证这些科目还能被编辑（编辑时不必被迫先改分类；后端 `update` 只在分类真的变了才校验）；
- **「新增科目」的分类下拉不列历史类目**：历史类目在类目表里没有实体，用它新建科目必然被 §3.6 拦成 422（「分类不存在，请先到科目类目里新增」），给一个必然失败的选项是坏交互；
- 「改名 / 删除」按钮不出现（没有实体可操作）；
- 正常情况这类行不存在 —— 迁移会按 §5 把科目表里出现过的每个取值都回填成类目行。

### 4.6 不做

- 不做类目「停用」：类目只在「还有没有科目」这一个维度上有意义，没有科目的类目可以直接删；
- 不做「合并类目 / 批量把科目迁到另一个类目」：用户没提；单个科目改类目已能完成迁移，强行加一条批量路径要处理唯一键冲突与部分失败，风险大于收益（记入 §8 未做项）；
- 不改三大报表/凭证按类目名匹配的硬编码（见 §4.1）；
- 不动 `accounting_subjects.category` 的存储形态（见 §2）。

## 5. 迁移与 seed

### 5.1 迁移 `20261107200000_accounting_subject_categories`

1. 建表 + 唯一索引 `name` + 索引 `sort_order`；
2. 有 users 时（空库跳过，交给 seed）：种入 5 个内置类目（`is_system = true`，顺序 10..50），`created_by/updated_by` 取最早的用户（与 20260917 会计科目迁移同一写法）；
3. 回填历史类目：`SELECT DISTINCT category FROM accounting_subjects` 里不在类目表的取值，按名称排序插成 `is_system = false` 的自建类目，`sort_order` 从 60 起 +10（典型来源：「未分类」）；
4. 空库（无 users）整段跳过 —— `prisma/seed.ts` 负责建 5 个内置类目后再种科目。

### 5.2 `prisma/seed.ts`

在种科目**之前**种 5 个内置类目（`upsert` by name，幂等）。科目种子全部落在这五类里，所以新库不需要回填历史类目。

### 5.3 部署顺序

```bash
npm run db:generate --workspace=@dilee/api   # schema 改了先重生成 client
npx prisma migrate deploy                    # 生产：先跑迁移再上新代码
```

不跑迁移直接上新代码 = 新接口 500（表不存在）、科目写入口校验也会失败（查不到类目表）。

## 6. 前端

页面仍是「财务 → 收支管理 → 会计科目」（`/finance/cash-flow?tab=subjects`），新增一块**「科目类目」**面板（在「新增科目」列表之前）：

- 表格列：类目 / 科目数（启用 x / 共 y）/ 类型（内置 / 自建 / 历史）/ 操作（改名、删除，内置与历史行不给按钮）+ 创建人 / 最后修改人（`auditColumns()`）；
- 头部：「新增类目」按钮（弹窗只要一个名称）；
- 改名：弹窗预填当前名称；
- 删除：二次确认（说明「只在类目下没有科目时可删；有科目请先改科目分类」），后端 422 的 message 原样提示；
- 科目列表的「分类」筛选与编辑科目的「分类」下拉读新接口的类目清单（含历史类目），新增科目时只列实体类目（理由见 §4.5），顺序与后端一致；
- 类目面板与科目面板一样区分加载中 / 加载失败 / 成功三态：加载失败时不能显示「共 0 个类目」或让人去跑迁移的误导文案。

前端共用件 `apps/web/lib/accounting-subjects.ts` 增加 `AccountingSubjectCategory` 类型与 `ACCOUNTING_SUBJECT_CATEGORIES_PATH`。

## 7. 验证计划

| 层 | 检查 |
| --- | --- |
| API 单测（手写 Prisma 替身） | 列表排序/计数、新增、重名、改名级联（事务内两条 UPDATE）、内置保护、删除守卫、审计事件；科目写入口的类目校验（不存在 → 422） |
| 迁移守卫测试 | 新迁移 SQL：建表列、唯一索引、5 个内置类目、回填 DISTINCT、空库跳过 |
| 迁移常量一致性 | 5 个内置类目名与 `ACCOUNTING_SUBJECT_CATEGORIES` 逐字一致（防手抄漂移） |
| Web lib / 组件测试 | 会计科目页：类目面板渲染、新增/改名/删除请求体、内置行无操作按钮、科目下拉包含历史类目；既有科目 CRUD 与筛选不回归 |
| 独立验证 | `.agent/verify/` 新探针：手写 Prisma 替身跑真实 service 断言 CRUD 语义；Playwright + 路由打桩截取类目面板/新增/改名/删除拒绝的真实渲染 |
| 全站守卫 | `typecheck`（api/web/coding-worker）、`next build`、`audit-columns-coverage`、`table-width-coverage` |

## 8. 未决 / 未做

- **真实 PostgreSQL 未执行迁移**（本机无数据库）：DDL 与回填逻辑只能由迁移守卫测试与静态检查覆盖，部署前建议先在测试库跑一遍 `migrate deploy`；
- 不做类目合并 / 科目批量改类目（见 §4.6）；
- 类目排序只支持在新建时给 `sort_order`，不提供界面上的拖拽排序（当前按创建顺序追加，够用）。

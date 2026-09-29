# 0927 采购计划与按供应商收束下单（任务批次）

> 设计依据：[purchase-plan-and-supplier-collapse-2026-09-27.md](../../design/purchase-plan-and-supplier-collapse-2026-09-27.md)
> 用户原话：「现在，生产模块里面的 BOM 表里面不用填写供应商。然后采购模块那边多一个采购计划栏目。
> 采购计划就承接的是原来的采购单草稿。在采购计划里面，每个销售单对应一份的 BOM 对应一份的采购计划。
> 还要加上供应商，供应商地址，联系人这些 column。然后根据供应商收束下单，下单到采购单模块。
> 也就是说，采购单模块就是所有已经经过供应商收束下单的采购单了。注意，表单要保证一次性展示所有 column。
> 可以限制每个 column 的宽度，如果超出就省略。鼠标 hover 的时候再展示全部文本。」

## 批次目标

把「采购单草稿」这个**多供应商工作台硬塞进单供应商凭证**的产物，还原成一个独立的实体
**采购计划**：一份 BOM 一份计划，计划里同时有多个供应商的行；采购员在计划里填数量/单价/供应商，
勾选后**按供应商收束下单**，落成 N 张采购单；**采购单模块从此只保留已经下单的凭证**。

这次反转 `2026-08-20` / `2026-09-17` 那条「不给采购单加采购计划实体」的旧决定，**不是**当时判断错了，
而是**粒度变了**（设计文档 §1）：采购单是「一个供应商 × 一个币种」的对外凭证，计划是「一份 BOM」的
内部工作面。保留的旧决定：仍然不引入 `superseded`、仍然不给采购单加第五个状态值。

## 已拍板口径（15 条，实现中不得擅自改；要改先改设计文档 §2）

1. 新建 `purchase_plans` + `purchase_plan_items` 两张表；**「一份 BOM 一份计划」由数据库保证**（部分唯一索引）。
2. 计划**手动新建**（选一张还没有计划的 BOM），诞生时**自动带出该 BOM 全部明细行**，行可删可加。
   **不做**"按 BOM 自动生成计划"（空计划噪音）。
3. BOM 的「供应商」列**只在采购侧显示**（生产侧隐藏）；新建计划时从 BOM 行**预填供应商**。
4. 供应商 = **下拉选择 + 下拉里快速新建**（复用 `components/bom/supplier-select.tsx`）；
   **供应商地址 / 联系人**是选中那家供应商的**只读派生**，计划里不可改。
5. 「一次性展示所有 column」**两个表都做**：只读列表能 hover 看全文；明细编辑表只保证"列不超出容器"
   （编辑格里是输入框/下拉框，对输入框做省略号没有意义）。
6. 下单**多波次**：勾选本次要下的行（默认全选）→ 按供应商收束 → 落 N 张采购单；
   **下过的行留在计划里**并显示 PO 号。
7. 数量/单价/供应商的**唯一编辑点是计划**；采购单页只保留打印字段
   （付款方式/交期条款/交货地址/回签）。
8. 历史草稿**迁移时归并成计划**（按 `bom_id` 分组，供应商/单价/交期原样保留），原草稿行软删。
9. 计划明细 **13 列**（选择/名称/型号/下单状态/本次采购量/当前库存量/单位/单价/供应商/供应商地址/联系人/
   预计到货/操作）；「需求量」**改名**「本次采购量」；`contact_name` + `phone` 合并成一列。
10. **计划行不存币种**；币种在**收束下单预览里按供应商分组各选一个**（默认 CNY）。
11. 新路由 `/procurement/plans` + 采购枢纽页卡片；采购单页**去掉**「新建采购单」「草稿」筛选 tab
    「编辑明细」，「回到草稿」→「**退回采购计划**」。**不做**"不建计划直接下单"的旁路。
12. BOM 后续变更**不同步**进已有计划；计划列表提示「这张 BOM 比计划多 N 个物料」。
13. 「下单状态」保留**累计口径**，第二档「草稿中」→「**计划中**」（数据源从草稿采购单改为**计划行**）；
    本行另标 PO 号。
14. 计划列表 9 列（计划编号/销售单号/货号/客户/BOM 版本/行数/未下单行数/状态/最后更新）；
    **不做** Excel 导出。
15. 计划**未下单过可软删**；BOM 被软删后计划**独立存活**；已下单可**退回采购计划**
    （原因必填、该单无任何到货事实）——退回**不删数据**。

## 任务清单

| # | 任务 | 期 | 依赖 | 交付面 | 可并行 |
| --- | --- | --- | --- | --- | --- |
| [01](./01-plan-schema-and-migrations.md) | 计划数据层：`purchase_plans`/`purchase_plan_items` schema + 两条迁移 + 迁移守卫 | P1 | — | prisma | 与 06 并行 |
| [02](./02-plan-api-skeleton.md) | 计划 API 骨架：module/controller/service，列表·候选·新建（自动带 BOM 明细）·详情 | P1 | 01 | api/procurement | — |
| [03](./03-plan-save-and-delete.md) | 计划 API：保存（整体替换行 + 乐观锁 + 已下单行保护）与软删 | P1 | 02 | api/procurement | — |
| [04](./04-plan-collapse-order.md) | 计划 API：按供应商收束下单（复用 collectGroups/orderData，回写 1:1 链接，币种按组） | P1 | 02 | api/procurement | 与 03 并行 |
| [05](./05-purchase-order-revert-and-readonly.md) | 采购单 API：退回采购计划（替换 revert-draft/cancel）+ 明细只读 + 列表只含已下单及之后 | P1 | 04 | api/procurement | — |
| [06](./06-bom-item-order-status-plan.md) | 下单状态四态改造：「草稿中」→「计划中」，数据源改为计划行（含换行 ID 摊回） | P1 | 02 | api/procurement | 与 01 并行 |
| [07](./07-supplier-snapshot-address-contact.md) | 供应商快照扩字段：地址与联系人冻结进采购单 | P1 | 05 | api/procurement | — |
| [08](./08-api-tests-and-guards.md) | API 单测与迁移守卫补齐 | P1 | 01–07 | api/procurement + test | — |
| [09](./09-web-plans-list-page.md) | Web：`/procurement/plans` 列表页 + 采购枢纽卡 | P2 | 02,03 | web | 与 13 并行 |
| [10](./10-web-plan-detail-sheet.md) | Web：计划详情/编辑 Sheet（13 列固定宽度 + 供应商快速新建 + 收束预览含币种） | P2 | 09 | web | — |
| [11](./11-web-purchase-order-slimming.md) | Web：采购单页瘦身（去新建/草稿 tab/编辑明细，加退回采购计划） | P2 | 05 | web | 与 10 并行 |
| [12](./12-web-bom-supplier-visibility.md) | Web：BOM 工作区供应商列按入口显隐（生产隐藏）+ 计划从 BOM 预填供应商 | P2 | 10 | web | 与 11 并行 |
| [13](./13-web-fixed-table-css.md) | Web：`.data-table-fixed` CSS 从 `.finance-page` 提为通用规则 + 财务四表回归 | P2 | 10 | web（css） | 与 09、12 并行 |
| [14](./14-web-test-migration.md) | Web 测试：采购页 4 个测试文件搬迁到计划页 + 计划页新用例 | P2 | 09–13 | web/test | — |
| [15](./15-docs-and-close.md) | 文档收口：数据字典 / 日志 / 设计文档实施结果 / 部署说明 | P3 | 全部 | docs | — |

## 建议执行顺序与提交节奏

```
P1  : 01 → 02 → (03 ∥ 04) → 05 → 06 → 07 → 08
      ↑ 06 只依赖 02，可与 03/04 并行；05 必须在 04 之后（退回计划要先有计划的 1:1 链接）
P2  : (09 ∥ 13) → 10 → (11 ∥ 12) → 14
      ↑ 11 只依赖 05（后端），可与 09/10 并行；12 依赖 10 的 SupplierSelect 用法定了再动
P3  : 15
```

一个任务一个提交，消息前缀 `feat(procurement)` / `feat(web)` / `docs`（`fix(...)` 只在修缺陷时用）。
两条硬纪律：

- **提交必须带显式 pathspec**（`git commit -m "…" -- <paths>`）——同一工作树里有其它工作流在跑财务模块，
  `git add -A` 会把别人的半成品带进历史。
- 提交信息里的中文用 **`git commit -F .git/dilee-commit-msg.txt`**：PowerShell 引号会吃掉中文
  （本仓库已经踩过两次，报错长得像 pathspec 不存在）。

## 全批次通用规矩

**验证命令**（与本仓库既有口径一致，不要自创）：

| 检查 | 命令 | 说明 |
| --- | --- | --- |
| 类型 | `npm run typecheck` | 根目录，api + web |
| API 单测 | `npm run test:unit:api` | 内部先 `nest build` 再 `node --test`；**改了 API 必须走这条**，直接跑 `node --test` 会读到过期 `dist` |
| Web 单测 | `cd apps/web; npm run test:unit` | = `test:lib`（`node --test lib/**/*.test.mjs`）+ `test:components`（vitest） |
| 部署脚本 | `npm run test:deploy` | 只在动了 `scripts/` 时相关 |
| http / integration / e2e | `npm run test:api` / `test:integration` / `test:e2e` | **需要真实 PostgreSQL 与已启动的 API**；本机没有 —— 跑不了就在「完成记录」里写**环境阻断**，不要假装跑过 |

**迁移与部署红线**（本批特有，违反会直接 500）：

- **先 `prisma migrate deploy`（两条迁移），再切代码**。反过来会出现：计划表不存在 → 计划页整体 500（§7.4）。
- 两条迁移**分两个目录**（DDL 与 DML 分开，可单独审、单独跳过）：`20260928090000_purchase_plan`、
  `20260928100000_purchase_plan_backfill_drafts`。
- 搬迁迁移**必须幂等**，且**迁移前 `pg_dump` 备份**；本机无库 → 部署时先在**影子库干跑**、核对行数与金额。
- 「一份 BOM 一份计划」用**部分唯一索引**（`WHERE deleted_at IS NULL`），**不在 schema 写 `@unique`**；
  schema 里只声明 `@@index([bomId])`。代价是 `migrate diff` 基线小幅增加（§7.3）——
  判定标准是「新增漂移只来自这一条 Prisma 不认识的 partial unique index」，**不是**漂移必须为 0。
- 可选关系的外键一律 `ON DELETE SET NULL ON UPDATE CASCADE`，必填关系 `ON DELETE RESTRICT ON UPDATE CASCADE`（§3.4）。
- `bom_snapshot` / `supplier_snapshot` 的"没有值"写 **`Prisma.DbNull`（SQL NULL）**，不是 `Prisma.JsonNull`
  （JSON 的 `null` 字面量会让 `WHERE x IS NULL` 查不到 —— 2026-09-26 那批踩过，测试里钉着）。

**口径红线**（跨越每个任务）：

- 金额**不跨币种合计**；数量**不跨单位合计**；Decimal 一律**字符串**出口，日期一律 ISO 字符串。
- 软删记录默认排除（`deleted_at IS NULL`）；审计事件由既有 `AuditService` 写，不手写 SQL。
- 北京时间统一走 `apps/web/lib/audit-time`（不要用 `toLocaleString`）。
- 不引入原生浏览器控件（`datalist` / `window.confirm`）——全站治理轮已移除。
- 新页面根节点要有 `data-testid="page-…"`，并在 `apps/web/test/testid-pages.test.ts` **登记**
  （那份约定检查会把未登记的新页面判红）。

**本批次不做的事**（设计文档 §8，避免实现者顺手扩面）：

- **不做**"不建计划直接下单"的旁路（会毁掉计划作为唯一真源的地位）。
- **不做**计划 Excel 导出、**不做**"按 BOM 自动生成计划"。
- **不给** `purchase_plans` 加手工状态字段（状态是**派生**的，见 §4.1）。
- **不给**计划行加币种列；**不给**地址/联系人在计划行上加重写列。
- **不动** `BomsService.replaceItems`（它"换行 ID"的行为是既有的，靠摊回逻辑兼容）。
- **不把**已下单采购单的明细编辑挪回采购单页。
- 仍然**不引入** `superseded` 状态、**不给采购单加第五个状态值**。

## 完成判定

1. 15 个任务文档里的「验收与验证」逐条可对照；每个任务的「完成记录」写了实际命令与结果。
2. 后端：计划四态/派生状态/1:1 链接/退回计划全部有单测；`npm run typecheck` 与 `npm run test:unit:api` 全绿。
3. 前端：`/procurement/plans` 建 → 改 → 收束下单 → 采购单列表出现；采购单页只剩打印字段与到货跟踪；
   13 列在 1366px 下**没有横向滚动条**（部署后目测）。
4. 采购单列表**不再出现** `cancelled` 与历史遗留 `draft`；「退回采购计划」后计划行回到未下单且
   **数量/单价/供应商原样保留**。
5. 数据字典 / 当日日志 / 设计文档实施结果三处与代码一致；§9 的 6 条未验证项**逐条**落到文档里
   （迁移未在真库跑过 → 影子库干跑 + `pg_dump`；漂移行数记进 `docs/log/`）。

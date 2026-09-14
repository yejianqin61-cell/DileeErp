# 交接：第 3 批需求（QC 模块 / 分批出库 / 导出拆表 / 财务收纳）+ 三轮对抗评审收尾

- 交接时间：2026-09-14 12:40
- 仓库：`C:\Users\USER\Desktop\Dilee`（Windows / PowerShell；`apps/api` = NestJS + Prisma + PostgreSQL，`apps/web` = Next.js 15 + React 19）
- HEAD：`dcc2aa7`
- 状态：**第 3 批 7 项需求全部交付完毕，三轮对抗评审闭环，我的改动全部已提交、工作区无我方遗留**；当前 `npm test` 不能全绿，红灯全部来自**另一位写者正在进行的「币种字典」未提交工作**（见 §4）。

---

## 1. 本会话交付（第 3 批 7 项）

需求原文与澄清见提交信息；逐项落点：

| # | 需求 | 主要落点 |
|---|---|---|
| 1 | 成品支持分批入库/分批出库 | `apps/api/src/modules/warehouse/finished-goods-outbound.service.ts`（`createOutbound` / `createOutboundFromNotice` / `noticeRemaining` / `syncNoticeStatus`）、`apps/api/src/modules/sales/finished-goods-outbound-notice.service.ts`、迁移 `20260912200000_outbound_notice_partial_outbound`、`apps/web/app/warehouse/finished-goods-storage/page.tsx`、`apps/web/app/sales/page.tsx` |
| 2 | 成品仓储按订单号收束（现存/已入库/已出库） | `apps/web/app/warehouse/finished-goods-storage/page.tsx`（`finishedGroups` + 展开明细 + 口径说明） |
| 3 | 订单号盘点表含计时工人的计件数量 | `apps/api/src/modules/production/production-payroll-export.service.ts`（`detailRow` 恒输出计件数量；汇总含「其中计件/其中计时」） |
| 4 | QC 收拢为独立模块 + Tab（含成品入库登记/次品登记） | 新增 `apps/web/app/qc/page.tsx`、`apps/web/components/qc/{incoming-inspections-panel,finished-goods-qc-panel,qc-inbound-panel,qc-refresh}.tsx`、`apps/web/components/layout/app-shell.tsx`（导航 9 项）；采购/仓库/成品仓储页改为入口链接 |
| 5 | 财务应付条目显示原料名称 | `apps/api/src/modules/finance/supplier-payable.service.ts`、`apps/web/components/finance/finance-workspace.tsx` |
| 6 | 财务板块可收纳 + 进入独立子页面 | `apps/web/components/finance/finance-workspace.tsx`、`apps/web/app/finance/[section]/page.tsx`、`apps/web/lib/finance-sections.ts`、`apps/web/lib/collapsible-panel.ts` |
| 7 | 材料与车间对应表拆成「原料对应表」「生产进度表」 | `apps/api/src/modules/production/production-payroll-export.service.ts` + `.controller.ts`、`apps/web/components/production/payroll-export-panel.tsx` |

评审后又补齐的两个「后端有接口、前端无入口」：**取消送检**、**质检记录更正**
（`apps/web/components/qc/finished-goods-qc-panel.tsx`；更正所需的原始口径由
`apps/api/src/modules/production/finished-goods-qc.service.ts` 的 `availableInboundSources` 补出）。

## 2. 提交清单（本会话，按时间）

`f74f9b9` 拆表/应付原料/成品按订单收束/财务收纳 · `31380cc` 分批出库 · `f7a939a` QC 模块与导航 ·
`9731b25` 质检拒收拆分与配平/取消送检 · `72e4679` 财务注册表移出 client 模块（**构建阻断**）·
`7ac0b0a` 出库链路阻断与重要项 · `58fe21c` QC 深链/入库门控/跨面板刷新 · `ede0af4` 分批出库应收尾差与存量口径说明 ·
`0fd1f6d` Server/Client 边界守卫测试 · `69f4a8e` 第二轮收尾 · `c940350` 通知重发（**已在 `dcc2aa7` 回退其语义**）·
`150b4b4` 补钉住用例 · `5ce8e0c` 质检记录更正 · `dcc2aa7` 第三轮收尾

每个提交的信息里都有「为什么」与验证方式，别重复它们。

## 3. 常见命令与当前数字

```powershell
# API（测试 require apps/api/dist，先 build）
npm run build --workspace=@dilee/api
node --test "apps/api/test/*.test.cjs" "apps/api/test/unit/**/*.test.cjs"   # 853 通过 / 1 失败

# Web
npm run typecheck --workspace=@dilee/web
npm run test:lib --workspace=@dilee/web                                     # 114 通过 / 1 失败
npx vitest run                                                             # 全量；本批相关 8 文件 136 通过
npm run build --workspace=@dilee/web                                       # next build（真正的发布门禁）
```

- 本批相关 8 个 vitest 文件全绿：`qc-module`(20) `outbound-notice-pages`(18) `finished-goods-qc-panel`(16)
  `finished-goods-panel`(25) `app-shell`(22) `workbench` `testid-pages` `testid-contract`。
- 我的改动最后一次全绿（含 `next build` 31 页）在 `69f4a8e`。

## 4. 当前红灯：全部来自另一位写者的在途工作（不要误当成自己的回归）

同一工作区有另一位 agent 在做**币种字典**（未提交，171 条改动 / 112 个未跟踪）：

1. `apps/api/test/unit/frontend-route-contract.test.cjs`（S11）：他们新增的未跟踪
   `apps/web/lib/currency-options.ts` 请求 `/api/v1/dictionaries/currency/items`，后端还没有该路由。
2. `apps/web/lib/page-data-alignment.test.mjs`：他们在 `apps/web/app/sales/page.tsx` 多加了币种请求，
   `LOAD_ORDER` 表未同步（4 个 vs 期望 3 个）。
3. `npm run typecheck` / `next build`：`CurrencyOption[]` 与 `CurrencyDictionaryItem[]` 类型不匹配，
   分布在 `app/hr/page.tsx`、`app/sales/page.tsx`、`components/finance/finance-workspace.tsx`、`app/customers/page.tsx`
   与新增的 `apps/api/src/platform/currency/`。
4. `npx vitest run`：`hr-page` / `production-page` / `salary-page` 三个文件长期是他们的半成品；
   `finance-page` 的「11 个接口」变成 12 个（他们新增的币种请求）。
5. 他们还在改 `apps/api/src/modules/procurement/purchase-orders.{controller,service}.ts`。

**处理原则**：不要替他们改这些断言，也不要 `git add` 他们的文件。等他们提交后再跑一次全量门禁。

## 5. 待办（按优先级）

**P0 — 金额入口的 NaN 漏洞（评审 F2，我故意未做，因为 7/9 个文件正被上述写者改动）**
这些 `decimal`/`positive`/`nonNegative` 守卫用 `lte(0)` / `lt(0)` 判正数，而
`new Prisma.Decimal("NaN")` 不抛异常且比较恒为 false → `amount: "NaN"` 可穿透（DTO 是裸 `@IsString()`）：

`finance/customer-payment.service.ts:64`、`finance/receivable-adjustment.service.ts:133`、
`finance/supplier-payment.service.ts:100`、`finance/supplier-payable.service.ts:161`、
`finance/receivable.service.ts:79`、`finance/supplier-payable-reconciliation.service.ts:53`、
`finance/reconciliation.service.ts:93`、`hr/payroll-ledger.service.ts:111`、`hr/attendance-performance.service.ts:22`

修法：`if (result.lte(0))` → `if (result.isNaN() || result.lte(0))`（`lt(0)` 同理）；
已有同类修复可参照 `apps/api/src/platform/database/quantity.ts`、
`apps/api/src/modules/warehouse/finished-goods-inventory.service.ts:164`（该处刻意只挡 NaN，保留亚标度数量）。

**P0 — 用户必须在真实环境验证**（本地无 PostgreSQL/Docker/浏览器，全部未实测）：
`npm run db:migrate:deploy` 执行本批相关迁移；成品分批出库/入库闭环；`/qc` 渲染与深链；
财务 7 个板块的折叠与 `/finance/<section>` 子页面。

**P1 — 「按质检记录建原料入库草稿」两套规则**（评审 M3）：
`apps/web/app/warehouse/raw-material-storage/page.tsx:94-104`（无剩余量校验、无结算三字段）
与 `apps/web/components/qc/incoming-inspections-panel.tsx`（有校验、部分入库强制结算三字段）并存。
要么合并为一套，要么在文档里明确「仓库侧是补建通道」。

**P1 — `/qc` 的权限门禁横跨两个模块**（评审 M4）：来料质检/原料入库接口是 `@RequireModules("warehouse")`，
创建入库通知是 `procurement`；只有单一模块权限的账号会在同一页面遇到 403，而全站没有 403 分支呈现。

**P2 — 提交信息与实际不符的点**：`apps/web/test/**` 整体仍未跟踪（含 `qc-module.test.tsx`、
`finished-goods-qc-panel.test.tsx` 及对 `testid-pages` / `outbound-notice-pages` 的适配），
且这些用例依赖他们未提交的 `components/ui/action-dialog.tsx` testid 补丁；提交信息里提到「已改这些测试」时
指的是工作区已验证、并不在提交里。

**P2 — 文档漂移**：`docs/test/00-recon-frontend-coverage.md`（未跟踪）仍写「8 个模块」；
`docs/product/module-capability-catalog.md` 已在本会话补上「质检」（一级菜单 9 项）。

## 6. 复查历史（谁已经看过什么）

| 轮次 | 范围 | 结论 |
|---|---|---|
| 1 | 第 3 批 7 项（两个 subagent 分工） | 3 条阻断（财务子页面 `next build` 失败、`partially_outbound` 无法取消、QC 拒收/深链/入库门控）+ 若干重要项 |
| 2 | 对修复的验证（两个 subagent） | 阻断全关；新增 1 条重要（成品入库仍接受 NaN → 已修）+ 若干次要 |
| 3 | 对 `69f4a8e`/`c940350` 的验证（一个 subagent） | 5 条修复全部成立；指出 F2（金额 NaN）、F3（重发通知不可达，已回退）、F4/F5/F7（文案与提示承载，已修）、F6（幂等键上限，已补）、F8（测试依赖未提交 testid） |

## 7. 关键约定与坑（接手必读）

- **并发写者**：工作区长期有第二方在改文件；提交前只 `git add` 自己的具体路径，
  绝不要 `git add -A` / `git checkout` / `git stash`。若同一文件混入对方 hunk，
  用 `git diff --output=<patch>` + 截取我方 hunk + `git apply --cached` 的方式只暂存自己的部分
  （本会话对 `components/layout/app-shell.tsx` 用过这一招）。
- **Server/Client 边界**：Server Component 不得从 `"use client"` 模块导入普通常量
  （`next build` 才报 `X.map is not a function`）。守卫：`apps/web/lib/server-client-boundary.test.mjs`。
- **数量入口统一守卫**：`apps/api/src/platform/database/quantity.ts`（拒 NaN/指数/超 4 位小数）；
  亚标度数量的例外只允许在 `finished-goods-inventory.service.ts`。
- **ActionDialog 提交语义**：`onSubmit` 要 **return/await** 提交 Promise；校验失败要 **抛错**
  （弹窗保留并就地显示原因），不要 `setError` + 提前 return（那会关窗丢输入）。
- **QC 跨面板刷新**：`apps/web/components/qc/qc-refresh.ts`（emit/subscribe，发出方忽略自己的事件）。
- **分批出库状态机**：通知 `pending → outbound_created → partially_outbound → completed`，
  由 `syncNoticeStatus` 按「已过账出库量 + 在途草稿」推导；`cancelled` 不可复活；
  取消通知要求没有在途草稿（`finished-goods-outbound-notice.service.ts:150-164`）。
- **成品存量三列不是同一口径**：现存取库存事实余额（含退货回仓、扣转次品/冲销），
  已入库/已出库是单据口径；文案已写在 `finished-goods-storage/page.tsx` 表上方，别「修」成恒等式。
- **原材料入库通知的库约束**：`raw_material_inbound_notices(incoming_inspection_id) WHERE deleted_at IS NULL`
  部分唯一索引 → 一张质检单最多一张通知；要支持重发只能软删旧通知。

## 8. 建议调用的 skills

- `code-review`：对下一批改动做「Standards + Spec」双轴评审时用；本仓库更常用的是自派
  `subagent` 做对抗评审（prompt 模板见 `docs/task/**` 与上一轮的评审报告，要点：只读、给 file:line、
  分 blocker/major/minor、明确「未能验证」）。
- `diagnosing-bugs`：处理 §4 的红灯或用户反馈的 500/422 时用。
- `tdd`：补 P0/P1 那几处守卫与入口时用（先写会红的用例，本仓库 API 用例在 `apps/api/test/unit/*.test.cjs`）。
- `domain-modeling`：若要把「质检 / 入库 / 应付」的口径固化进 `docs/` 术语表时用。
- `research`：查 Next.js RSC 边界、Prisma 部分唯一索引等外部事实时用（本会话第 1 轮的构建阻断正是这类问题）。

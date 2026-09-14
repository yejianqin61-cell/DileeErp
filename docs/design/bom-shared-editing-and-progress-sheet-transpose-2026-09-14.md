# BOM 双模块共同维护（乐观锁） + 生产进度表横纵表头互换

- 状态：已实现（待真实 PostgreSQL / 浏览器验收）
- 日期：2026-09-14
- 来源需求：业务方 2026-09-14 提出的两项整改
  1. 采购模块的 BOM 表现在允许生产模块也能操作，两个地方都能操作 BOM 表；冲突怎么处理？
  2. 生产进度表的横纵表头互换——横表头换成工序，纵表头是日期，使表格更好融进一张 A4 纸。

## 1. 决策

### 1.1 BOM 的归属从「采购独占」改为「采购 + 生产共同维护」

| # | 决策 | 依据 | 影响 |
| --- | --- | --- | --- |
| D1 | `BomsController` 的模块门禁从 `@RequireModules("procurement")` 改为 `@RequireAnyModules("procurement", "production")` | 采购按 BOM 下单、生产按 BOM 建生产单并领料，两边都需要按现场情况改用量与明细 | 生产角色可用全部 BOM 端点（列表/详情/新建/改扩展数据/替换明细）；sales 角色仍然被拒 |
| D2 | 冲突处理用**乐观锁 + 冲突提示**，不用「最后写入者获胜」 | 宪法《Reversible Business Changes》：「不得静默覆盖历史」「影响上下游时必须先让操作者看到影响并确认」。BOM 直接决定生产单领料量与采购单用料快照，静默覆盖等于让一个人的现场修正凭空消失 | 保存必须带令牌；冲突时返回 422 并保留双方数据，由操作者决定 |
| D3 | 令牌用 `updatedAt`（字段名 `expected_updated_at`），**不新增表结构** | 已有 `updated_at` 足够表达「这张 BOM 是否被人动过」，且 Bom.version 语义是「BOM 版本」不能挪用 | 不引入迁移；API 已返回 `updatedAt`，前端直接回传 |
| D4 | 服务端在事务里先 `SELECT … FOR UPDATE` 再比对，比对失败**连软删旧行都不做** | 两个并发保存在数据库里被行锁排成先后；若先软删再比对，冲突会留下一张残缺的 BOM | 冲突是「零写入」，不是「半写入」 |
| D5 | 前端不自动重试、不自动合并，只显示冲突提示 + 「重新加载最新版本（放弃本次修改）」 | 自动合并会替业务做决定；BOM 行的语义是人工确认过的用量 | 本地未保存的改动在冲突时仍留在屏幕上，不会被清掉 |
| D6 | 采购与生产**共用同一个编辑组件** `components/bom/bom-workbench.tsx` | 各自实现一套必然导致字段口径与冲突处理漂移（历史上「规格型号/颜色被 material_snapshot 覆盖」就是这样出现的） | 两边体验一致，冲突逻辑只写一次、只测一次 |
| D7 | 「新建物料」入口只在采购侧开放；生产侧只提示「物料池由【采购 → 物料清单】维护」 | 物料池是主数据（宪法 Configurable Business Categories 的边界：主数据归其所属模块），生产要的是**用**物料不是**建**物料 | 生产仍可增删 BOM 行、切换物料、改数量/单位/规格/颜色 |

### 1.2 生产进度表：列 = 工序，行 = 日期

| # | 决策 | 依据 | 影响 |
| --- | --- | --- | --- |
| D8 | 导出表从「行 = 工序、列 = 日期」改为「列 = 工序、行 = 日期」 | 客户按 A4 打印反馈：一个月 30+ 个日期列，横向必然溢出；换成工序做列后列数 = 工序数（本厂约 14 个），行数随日期纵向增长，纸面可翻页 | 同一订单里工序越多日期越少时越省纸；反之行数变多但仍在纵向 |
| D9 | 「目标数量」「加工地点」保留为表头下两行标注（每个工序列填自己的值） | 用户选择「保留为表头下的两行标注」 | 信息不丢，且只需扫一眼表头就能对照计划 |
| D10 | 表尾增加一行「合计」（按工序累计 + 全部合计）；没有日报时也输出这一行（值为 0） | 横置后「列合计」不再天然可见；缺行会让人误以为漏数据 | 读者能确认「确实是 0」 |
| D11 | 「出货数量」是单一数值，移到表头上方的元信息行，不再逐工序重复 | 它不属于任何单个工序，原来在每个工序行重复同一数字 | 列数更少，表格更窄 |
| D12 | 同一工序名在多个生产单里重复时，列名补生产单号（`裁剪（MO-1）`） | 横置后列头必须唯一可辨识，否则无法判断是哪个生产单的工序 | 列名唯一 |

## 2. 后端改动

### 2.1 BOM 权限与乐观锁

- `apps/api/src/modules/sales/boms.controller.ts`
  - `@RequireAnyModules("procurement", "production")`；
  - `BomDto` / `BomItemsDto` 新增 `expected_updated_at`（`@IsOptional() @IsDateString()`），透传给服务。
- `apps/api/src/modules/sales/boms.service.ts`
  - 新增 `assertNotStale(tx, id, expectedUpdatedAt)`：`SELECT id FROM boms WHERE id = … FOR UPDATE` → 读 `updated_at` → 与令牌比对，不一致抛 422 `BOM_UPDATE_CONFLICT`，`details` 同时给出 `expected_updated_at` 与 `actual_updated_at`；
  - `replaceItems(id, items, user, expectedUpdatedAt?)`：**比对在任何写入之前**；
  - `update(id, extensionData, user, expectedUpdatedAt?)`：带令牌时走事务 + 同一套比对；
  - 令牌缺省时跳过比对（兼容旧调用方与既有单测桩）。

错误契约：

```json
{ "error": { "code": "BOM_UPDATE_CONFLICT",
  "message": "BOM 已被他人（采购或生产）修改，本次保存没有写入；请重新加载最新版本后再改一次",
  "details": [{ "expected_updated_at": "…", "actual_updated_at": "…" }] } }
```

### 2.2 生产进度表版式

`apps/api/src/modules/production/production-payroll-export.service.ts` 的 `progressSheet()`：

```
生产进度表
订单号 | SO-…
产品   | …
生成时间 | …
操作人 | …
出货数量 | 12
说明 | 每列为一个工序，行为生产日期，单元格为当日该工序的完成数量
日期      | 裁剪 | 包装 | 当日合计
目标数量   | 100  | 100  | —
加工地点   | 一车间 | 一车间 | —
2026-09-01 | 30  |     | 30
2026-09-02 | 20  | 50  | 70
合计       | 50  | 50  | 100
```

- `progressSheet()` 现在返回 `{ progressHeader, progressRows, shippedQuantity }`；
- 旧入口 `exportMaterialProduction()`（上表原料 + 下表进度的合并工作表）沿用同一份新版式，标题文案同步改为「每列为一个工序」。

## 3. 前端改动

- 新增 `apps/web/components/bom/bom-workbench.tsx`：BOM 工作区（Sheet）。自己 GET `/boms/:id`、记住 `updatedAt`、保存时回传 `expected_updated_at`；捕获 `BOM_UPDATE_CONFLICT` 后显示 `data-testid="bom-conflict"` 的冲突块（含「重新加载最新版本（放弃本次修改）」）并保留本地编辑。
- `apps/web/app/procurement/page.tsx`：删掉内联的 BOM 编辑区（`updateBomItem`/`changeBomMaterial`/`addBomItem`/`saveBom` 与那段 Sheet JSX），改为挂载共享组件，并把「新建物料」通过 `onCreateMaterial(apply)` 回调继续由采购页提供。
- `apps/web/app/production/page.tsx`：新增「BOM表」面板（`data-testid="production-bom-panel"`），按订单显示「新建BOM表 / 编辑BOM表」，挂载同一个 `BomWorkbench`（不传 `onCreateMaterial`）；`load()` 增加一次只读的 `/materials`。
- `apps/web/lib/production-candidates.ts`：缺 BOM 的提示文案改为「请在本页【BOM表】或【采购 → BOM表】为其建立 BOM」，少一次跨模块跳转。

## 4. 验证

| 层次 | 命令 | 结果 |
| --- | --- | --- |
| API 类型检查 | `npm run typecheck --workspace=@dilee/api` | 通过 |
| API 单元测试 | `npm run test:unit:api` | **884 / 884 通过**（新增 `boms-concurrent-edit` 5 条、进度表版式 8 条） |
| Web 类型检查 | `npm run typecheck --workspace=@dilee/web` | 通过 |
| Web 单元测试 | `cd apps/web && npm run test:unit` | **510 组件用例 + 124 lib 用例全部通过**（新增 `bom-workbench` 6 条、生产页 BOM 入口 3 条） |
| 迁移实际执行 / 浏览器验收 | `db:migrate:deploy`、Playwright | **未执行**：本机无可用 PostgreSQL，Docker 守护进程未运行 |

新增/更新的测试：

- `apps/api/test/unit/boms-concurrent-edit.test.cjs`（5）：令牌一致放行、令牌过期拒绝且零写入、无令牌跳过比对、非法令牌拒绝、`PATCH` 扩展数据同一套守卫。
- `apps/api/test/unit/material-production-export-layout.test.cjs`（8，重写）：列头是工序/行头是日期、目标数量与加工地点两行标注、单元格与两级合计、出货只出现一次、说明文案、无日报时仍输出合计行、重名工序补生产单号、合并工作表沿用新版式。
- `apps/web/test/bom-workbench.test.tsx`（6）：保存回传 `expected_updated_at`、人工改过的数量原样发出、冲突提示且保留本地改动、冲突后重新加载显示服务端最新版本、无 `onCreateMaterial` 时不渲染「新建物料」、有回调时新物料回填进保存体。
- `apps/web/test/production-page.test.tsx`（+3）：BOM 面板按订单状态给出新建/编辑入口、点编辑打开共享工作区并 GET 明细、点新建用销售单内部 id 调 `from-sales-order` 后自动打开同一张 BOM。
- `apps/api/test/http/authorization-matrix-contract.test.cjs`：`boms.list` 的允许角色加上 `production`。
- `apps/web/lib/page-data-alignment.test.mjs`：生产页接口顺序表补 `/materials`（该守卫专门防止位置型解构错位）。

## 5. 未验证 / 待确认

- 乐观锁只做了单元测试（假 Prisma 模拟 FOR UPDATE 与 updatedAt 变化）；真实的两个并发 HTTP 请求在 PostgreSQL 上的排布未实测。
- `BOM 变更对下游的影响预览`（`docs/design/procurement-module-design.md` 已要求：编辑前展示对采购单/生产单/领料的影响）仍未实现——本轮只解决了「不静默覆盖」，没有做「提前告知影响」。
- 生产侧的 BOM 编辑目前不做「同一销售单已有生产单时锁定用量」之类的业务门禁；如果生产现场希望已开工的 BOM 不允许改数量，需要再定规则。

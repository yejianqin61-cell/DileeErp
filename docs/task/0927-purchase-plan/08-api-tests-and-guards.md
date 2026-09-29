# T08 API 单测与迁移守卫补齐

> 设计依据：[purchase-plan-and-supplier-collapse-2026-09-27.md](../../design/purchase-plan-and-supplier-collapse-2026-09-27.md) §7.2–7.3、§9
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T01](./01-plan-schema-and-migrations.md) – [T07](./07-supplier-snapshot-address-contact.md) 全部。
后续 P2 的 [T09](./09-web-plans-list-page.md) 起可以并行，但**本任务必须在 P2 之前把后端闸门跑绿**。

## 目标

把 P1 七个子任务各自的单测**合并跑通**、**补齐缺口**，并把三处契约登记做对：
授权矩阵（第 41 个控制器）、采购单 http 契约（删 2 条、加 1 条）、迁移守卫（两条迁移都覆盖）。
产出物是一份"P1 后端闸门"的证据，而不是新功能。

## 口径与决策（依据设计文档）

- **§7.2**：搬迁迁移的幂等性、合并规则、跳过规则都需要用例钉住（本机无库 → 只能用假 Prisma 与
  **SQL 文本断言**两种手段，两者的边界要在完成记录里写清）。
- **§7.3**：部分唯一索引会让 `migrate diff` 基线小幅增加；判定标准见 README 红线，
  部署核验时把**新的行数与 md5 记进 `docs/log/`**。
- **§9**：6 条未验证项 —— 本任务负责把它们**逐条落到文档**（不能验证的要写明环境阻断），
  不是把它们"消掉"。

## 范围与非范围

**范围**

- 复核并补齐：`purchase-plan-migration.test.cjs`（[T01](./01-plan-schema-and-migrations.md) 写的，本任务复核覆盖度）、
  `purchase-plan-service.test.cjs`、`purchase-plan-save.test.cjs`、`purchase-plan-order.test.cjs`、
  `purchase-plan-bom-item-status.test.cjs`、`purchase-order-revert-to-plan.test.cjs`、
  `supplier-snapshot-fields.test.cjs`。
- 契约登记：`apps/api/test/http/authorization-matrix-contract.test.cjs`（+1 控制器、+1 端点）、
  `apps/api/test/http/purchase-orders-contract.test.cjs`（-2 端点、+1 端点）。
- 跑全量闸门：`npm run typecheck`、`npm run test:unit:api`。

**非范围**

- 不新增业务行为（发现缺口要么补测试、要么回对应的任务文档记 bug，**不要**在本任务里改口径）。
- Web 侧测试（[T14](./14-web-test-migration.md)）。
- 真实库的迁移执行与漂移核验（环境阻断，写进完成记录 + [T15](./15-docs-and-close.md)）。

## 交付物

| 文件 | 关键改动 |
| --- | --- |
| `apps/api/test/unit/*.test.cjs`（上列 6 个 + 复核 1 个） | 补齐缺口；每条用例的断言对准对应任务文档的「验收与验证」 |
| `apps/api/test/http/authorization-matrix-contract.test.cjs` | `CONTROLLER_FILES` 加 `modules/procurement/purchase-plans.controller.ts`（39 → **41**：财务侧那轮已到 40）；`ENDPOINTS` 加 `purchase-plans.list`（`allow: {procurement: 200}`、`deny: [NO_MODULE]`） |
| `apps/api/test/http/purchase-orders-contract.test.cjs` | 路由表：删 `POST /:id/revert-draft`、`POST /:id/cancel`；加 `POST /:id/revert-to-plan`（payload 只放 `{reason:"contract-probe"}` 这类**非业务数据**） |

## 实施要点

### 1. 覆盖度复核（对着任务文档逐条勾）

| 任务 | 必须有用例的点（最少） |
| --- | --- |
| [T01](./01-plan-schema-and-migrations.md) | 部分唯一索引带 `WHERE deleted_at IS NULL`；schema 无 `@unique`；外键动作；两迁移顺序；搬迁幂等（`WHERE NOT EXISTS`）；搬迁只软删不 `DELETE` |
| [T02](./02-plan-api-skeleton.md) | 派生状态三态；新建带全 BOM 明细（需求量 / 单价 0 / 供应商预填）；同 BOM 重复建 → 409；候选过滤；`bom_extra_material_count`；路由顺序静态断言 |
| [T03](./03-plan-save-and-delete.md) | 整体替换；乐观锁冲突 `PURCHASE_PLAN_UPDATE_CONFLICT` 时零写入；已下单行**内容不可改**（`PURCHASE_PLAN_ORDERED_LINE_LOCKED`）/ **不可删**（`PURCHASE_PLAN_ORDERED_LINE_REMOVED`）；**两个例外**：`sequence` 可重排、`expected_date` 可改**并同步写进 `purchase_order_items`**；软删守卫 `PURCHASE_PLAN_HAS_ORDERED_LINES`；软删后可再建；`DbNull` |
| [T04](./04-plan-collapse-order.md) | 组=单；币种按组；1:1 回写；未勾选行不动；重复下单 422；空组 422；事务回滚无半截数据 |
| [T05](./05-purchase-order-revert-and-readonly.md) | 列表过滤；明细只读 422 + 指路文案；退回清链接**保数据**；自动补建计划；无 BOM 单 422；有到货 422；reason 必填 |
| [T06](./06-bom-item-order-status-plan.md) | `draft` 档来自计划行；字段名/枚举未变；换行 ID 摊回；软删计划不计入 |
| [T07](./07-supplier-snapshot-address-contact.md) | 快照含地址/联系人；取当时值；`DbNull`；旧快照读侧不炸 |

**"最少"不是上限**：发现某条口径没有用例看着，就补；发现某条用例断言的是**假实现**
（例如断言排序而假 Prisma 根本不排序、断言时间线顺序却没断言 `orderBy`）—— 那是缺陷，改成断言
"要求数据库怎么排"，并在完成记录里写明（本仓库 2026-09-26 那批踩过两次）。

### 2. 契约登记的三个陷阱

- **矩阵的控制器计数**：那条注释里的数字（现在是 40）**要一起改**，否则下一个人会以为漏登记。
- **http 契约的 payload 只能是非业务数据**：`revert-to-plan` 探测用 `{reason:"contract-probe"}`，
  且必须确保它必然在校验层被拒（否则会在真实库里改数据）。文件头对这件事有约定，照它写。
- **删掉的端点要连用例一起删**：留着对 `revert-draft` 的断言，等于给死代码续命。

### 3. 本机跑不了的东西（写清楚，不要假装跑过）

- `npm run test:api`（`test/http/**`）需要 `API_BASE_URL` + 真实库；`test:integration`、`test:e2e` 同理。
- `prisma migrate deploy` / `migrate diff` / `migrate status` 需要真实库。
- 这些一律在**完成记录**里写「环境阻断」，并在 [T15](./15-docs-and-close.md) 的部署说明里列出
  "部署前必须补跑的清单"。

### 4. 闸门口径

- `npm run test:unit:api` 的内部顺序是 `nest build` → `node --test`；**改了 API 必须走这条**
  （直接 `node --test` 会读到过期 `dist`）。
- 记录计数时写明**用的是哪条命令**（作者侧与部署侧的计数口径不同，本仓库为这个对齐浪费过时间）。

## 验收与验证

| # | 验收点 | 怎么验 |
| --- | --- | --- |
| 1 | 上表 7 个任务的"最少用例"逐条有对应用例 | 逐条在测试文件里能指到 |
| 2 | 单测全绿 | `npm run test:unit:api` |
| 3 | 类型检查通过 | `npm run typecheck` |
| 4 | 授权矩阵登记了第 41 个控制器与 `purchase-plans.list` | 源码断言 + （环境允许时）`npm run test:api` |
| 5 | 采购单 http 契约表与控制器实际路由**一一对应** | 源码静态断言（路由数量与名称） |
| 6 | 没有"断言假实现"的用例 | 人工复核 + 完成记录写明复核结论 |
| 7 | 环境阻断项已逐条记录 | 完成记录 |

## 决策记录

- **本任务不改业务代码**：发现缺口先补测试；若必须改行为，那是原任务的 bug，回到原任务提交
  （保持"一个任务一个提交"的可追溯性）。

## 完成记录

| 项 | 内容 |
| --- | --- |
| 完成日期 / 提交 |  |
| 实际交付物（文件 + 条数） |  |
| 验证命令与结果 | `npm run typecheck`：｜`npm run test:unit:api`（计数口径）： |
| 与设计的差异（含理由） |  |
| 未验证项（环境阻断） |  |
| 踩到的坑 |  |

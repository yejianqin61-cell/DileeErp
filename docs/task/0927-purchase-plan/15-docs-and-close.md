# T15 文档收口：数据字典 / 日志 / 设计文档实施结果 / 部署说明

> 设计依据：[purchase-plan-and-supplier-collapse-2026-09-27.md](../../design/purchase-plan-and-supplier-collapse-2026-09-27.md) §7、§9
> 批次：[README.md](./README.md)

## 状态

待认领（**P3 收口时执行一次**；P1/P2 各自的期次收口按下面的"每期都做"清单走）

## 认领

负责人：
开始日期：

## 依赖

P1 + P2 全部任务（[T01](./01-plan-schema-and-migrations.md) – [T14](./14-web-test-migration.md)）。

## 目标

保证「文档里写的」与「代码里跑的」一致，并把**本机无法验证的那几件事**写成一份可执行的部署说明——
下一个执行部署的人不该从对话记录里猜。

## 口径与决策（依据设计文档）

- **§7.4 部署顺序**：先 `prisma migrate deploy`（两条迁移）再切代码；反过来 → 计划表不存在 → 计划页整体 500。
- **§7.3 漂移**：部分唯一索引会让 `migrate diff` 基线小幅增加；**把新的行数与 md5 记进 `docs/log/`**。
- **§9 未验证（6 条）**：必须逐条落进文档，**不是**被"消掉"。
- **README 的完成判定第 5 条**：数据字典 / 日志 / 设计文档实施结果三处与代码一致。

## 范围与非范围

**范围**（收口时逐条过一遍；没做就写「本期未涉及」，不要留空）

| 文档 | 写什么 |
| --- | --- |
| 本批次 15 个任务文档 | 认领人、开始日期、**完成记录**（实际命令 + 结果 + 未验证项 + 踩到的坑） |
| [purchase-plan-and-supplier-collapse-2026-09-27.md](../../design/purchase-plan-and-supplier-collapse-2026-09-27.md) | 「实施结果」：实际落地物、与设计的差异及原因 |
| `docs/data-dictionary.md` | 两张新表的字段与关系指针（计划头/计划行、1:1 链接、快照列、部分唯一索引） |
| `docs/data-dictionary.html` | **无生成脚本**，与 `.md` 手工同步（照同样的小节结构补） |
| `docs/product/module-capability-catalog.md` | 采购模块新增「采购计划」能力与页面；采购单从"含草稿"变为"仅已下单及之后" |
| `docs/task/coding-roadmap-todolist.md` | **默认写「本期未涉及」**：那份清单是 V1.0 的 A–G 计划，近期几轮（`0916-*`、`0917-*`、`0926-*`）都没有往里加条目 |
| `docs/log/<当天>.md` | 当天那一节：改了什么、踩了什么坑、验证计数、**迁移漂移行数与 md5**、未验证项 |
| `docs/log/<当天>.md` 或本批次 README | **部署说明**：迁移顺序、`pg_dump` 备份、影子库干跑、补跑清单（见下） |

**非范围**

- 不新建一套文档体系；不改既有文档的**历史结论**（历史记录是证据；错了另起一节说明）。
- 不把 §9 的未验证项写成"已验证"。

## 交付物

| 文件 | 关键改动 |
| --- | --- |
| `docs/design/purchase-plan-and-supplier-collapse-2026-09-27.md` | 追加「实施结果」节（不改 §1–§9 的既有口径） |
| `docs/data-dictionary.md`（+ `.html`） | `purchase_plans` / `purchase_plan_items` 的字段行（编号接在既有最大号之后） |
| `docs/product/module-capability-catalog.md` | 采购计划能力条目 |
| `docs/log/<当天>.md` | 本轮一节 + 部署核验段（漂移行数/md5） |
| 本批次 README 或 log | 部署说明（下面"实施要点 1"的清单） |

## 实施要点

### 1. 部署说明必须写清的清单（照 §7 与 §9）

1. **顺序**：`prisma migrate deploy`（`20260928090000_purchase_plan`、`20260928100000_purchase_plan_backfill_drafts`）
   → 再切代码。
2. **迁移前 `pg_dump` 备份**（搬迁迁移会改数据：归并草稿 + 软删原草稿行）。
3. **影子库干跑**：先在影子库跑两条迁移，核对
   「归并出的计划数 / 计划行数 / 供应商·单价·交期是否与草稿一致 / 没有 `bom_id` 的草稿是否原样未动」。
4. **幂等复跑**：干跑完后**再跑一次**搬迁迁移，确认不会重复建计划（口径 8 的幂等要求）。
5. **漂移核验**：`prisma migrate status` / `migrate diff` 的**新行数与 md5** 记进 `docs/log/`；
   判定标准：新增漂移**只**来自 `purchase_plans_bom_id_active_key` 这条 partial unique index（§7.3）。
6. **补跑清单**（本机环境阻断、部署环境必须补）：
   `npm run test:api`（`test/http/**`）、`npm run test:integration`、`npm run test:e2e`。
7. **目测清单**：采购计划页 13 列在 1366 / 1440 / 1920 下**无横向滚动条**、长文本出现省略号、
   hover 有全文；财务四表（记账凭证/应付对账/应收对账/工资台账）样式未回归。

### 2. §9 的 6 条未验证项怎么落

| §9 条目 | 落到哪 |
| --- | --- |
| 1. 两条迁移未在真实库执行（搬迁尤其） | 部署说明第 1–4 条 + [T01](./01-plan-schema-and-migrations.md) 完成记录 |
| 2. `migrate status` / `diff` 漂移未测 | 部署说明第 5 条 + `docs/log/` 记住行数/md5 |
| 3. 13 列固定宽度未量像素 | 部署说明第 7 条 + [T10](./10-web-plan-detail-sheet.md)/[T14](./14-web-test-migration.md) 完成记录 |
| 4. `test:api`/`integration`/`e2e` 未运行 | 部署说明第 6 条 + [T08](./08-api-tests-and-guards.md) 完成记录 |
| 5. 退回计划的并发行为未压测 | [T05](./05-purchase-order-revert-and-readonly.md) 完成记录（写明"靠事务与行锁推断，未压测"） |
| 6. jsdom 不排版 | [T13](./13-web-fixed-table-css.md)/[T14](./14-web-test-migration.md) 完成记录 |

### 3. 三处一致性自检（收口时必做）

- 数据字典里列出的**列**能在 `schema.prisma` 里找到；`schema.prisma` 里没有的数据字典不写。
- 设计文档「实施结果」里的**提交与测试计数**和 `docs/log/` 当天的数字一致。
- 本批次 15 个任务文档的"完成记录"表格**没有空行**（脚本 grep 一次 `| 完成日期 / 提交 |  |` 这种空值）。

### 4. 提交纪律

- 文档收口一个提交，消息前缀 `docs`；**显式 pathspec**；中文消息走 `git commit -F .git/dilee-commit-msg.txt`。
- 同一工作树有其它工作流在跑财务模块：`git add -A` 会把别人的半成品带进历史。

## 验收与验证

| # | 验收点 | 怎么验 |
| --- | --- | --- |
| 1 | 上表 8 处文档都动过，或明确写了「本期未涉及」 | 逐条对照 |
| 2 | 设计文档新增「实施结果」节，且**未改动** §1–§9 | `git diff` 只看新增 |
| 3 | 数据字典与 `schema.prisma` 一致（双向） | 逐列对照 |
| 4 | 15 个任务文档的完成记录无空值 | grep 空表格行 |
| 5 | 部署说明 7 条齐全（顺序/备份/干跑/幂等复跑/漂移/补跑/目测） | 文档自查 |
| 6 | §9 的 6 条未验证项都能在文档里指到 | 上表对照 |
| 7 | 类型检查与两端单测复跑一次并记数 | `npm run typecheck`、`npm run test:unit:api`、`cd apps/web; npm run test:unit` |

## 决策记录

- **不引入文档生成器**（`data-dictionary.html` 手工同步）：与 2026-09-26 那批同一条理由 ——
  生成器一旦与手写内容风格不一致，就会变成第三份真源。
- **未验证项不"消掉"**：本机没有库，能做的只有把手上的证据与补跑清单写清楚。

## 完成记录

| 项 | 内容 |
| --- | --- |
| 完成日期 / 提交 |  |
| 实际交付物（文档 + 节） |  |
| 验证命令与结果 | `npm run typecheck`：｜API：｜web： |
| 部署说明落在哪一处 |  |
| 与设计的差异（含理由） |  |
| 未验证项（环境阻断） |  |
| 踩到的坑 |  |

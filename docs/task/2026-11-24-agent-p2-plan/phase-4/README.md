# P2 阶段 4：缺口变成候选

计划：[P2 施工计划 v1.5](../plan.md) 阶段 4。设计：[P2 设计 v1.5](../../../design/dilee-consultant-p2-tool-catalog-2026-11-24.md) §2.4、§4.2。

**这一批只做归并、门槛与可注入的建单器。** 目标：同一差异反复出现只攒一条候选，
三个不同会话报过才交给建单器一次；候选里没有用户原话。不接真工单通道，不做可行性探针。

覆盖需求：R-6。

## 任务

| # | 任务 | 产物 | 依赖 |
|---|---|---|---|
| 1 | [两张候选表与迁移](task-1-tables.md) | `schema.prisma`、迁移、迁移守卫测试 | — |
| 2 | [归并与计数](task-2-record.md) | `gap-candidates.ts` | 1 |
| 3 | [门槛与建单器](task-3-threshold.md) | 同上 | 2 |
| 4 | [编排器与模块装配](task-4-wiring.md) | 编排器、模块 | 3 |
| 5 | [端到端](task-5-e2e.md) | `agent-gap-candidate-e2e.test.cjs` | 4 |

按序做：1 → 2 → 3 → 4 → 5。

## 本批已定（实施者不得重开）

| 决定 | 内容 | 出处 |
|---|---|---|
| 归并键 | `(nearest_operation, missing)` | 设计 §2.4 |
| 门槛 | 3 | 用户 2026-11-25 |
| 计数口径 | **按不同会话**：报过该键的不同 `session_id` 数。同一会话多次只算 1 | 用户 2026-11-25 |
| 存储 | 两张表：候选一张、每次声明一张（只追加）。计数现算，不存计数列，避免并发丢更新 | 本批决定 |
| 外键 | 不建任何外键 | `agent_*` 表惯例，见 `agent-tables-migration.test.cjs` |
| 原话 | 两张表与工单内容都不含问题原文 | 计划 R-6 |
| 升级 | 状态只有 `accumulating` → `ready`，由带状态条件的更新保证建单器**至多调一次** | 计划 R-6 验收 |
| 默认建单器 | 只记一行日志，返回「未送出」；候选停在 `ready` 且 `dispatched_at` 为空，留给 P3 补送 | 桥接尚未存在（设计 §4.2） |
| 建单失败 | 吞掉并记日志，不重试，不影响问答 | 本批决定 |
| 注释 | 新写的代码与 schema 不写散文注释 | 设计 §7.2 |

## 命令（仓库根目录执行）

```bash
npm run typecheck
npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-gap-*.test.cjs
npm run test:unit
```

## 本批明确不做

- 真工单通道、可行性探针（P3 桥接之后）。
- 候选的查看页面、关闭、合并、拆分。
- 连接真实数据库执行迁移（本机没有测试库，只做静态守卫）。

## 交付时要告诉用户的

生产上线前，迁移之后要手工给 `AGENT_STATE_DATABASE_URL` 的账号授两张新表的
`SELECT, INSERT, UPDATE` 权限；仓库里没有授权脚本。漏授的表现是缺口静默记不下来，问答照常。

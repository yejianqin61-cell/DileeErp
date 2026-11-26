# 任务 5：一次性环境与试跑

<task-brief>

## 1. 在哪里

- **阶段 8 时延有数**。
- **本任务为全量重跑扫雷**：环境可复现，几条用例确认指标都录得到，估出时长。
- **开工前提**：任务 4 已提交；环境里有 `DEEPSEEK_API_KEY`。**后续**：任务 6。

## 2. 要知道的

**先读**

- `.github/workflows/test.yml` 链路门禁：库与账号的测试值。
- `scripts/seed-mock-data.mjs` 与 `scripts/bootstrap-permission-accounts.mjs`：黄金集依赖的数据与账号。
- `scripts/agent/golden-eval.mjs`：`GOLDEN_*` 环境变量。

**已定**

- 一次性容器 `dilee-p2-golden`，只绑 `127.0.0.1:55499`；不碰任何已有容器。
- 顺序：迁移 → `prisma/seed.ts` → `seed-mock-data.mjs` → `bootstrap-permission-accounts.mjs --keep-legacy`。
- `bootstrap` 输出含密码：重定向到临时目录文件，读进环境变量，**不打印**，用完删。
- API 端口 3111，`AGENT_LLM_PROVIDER=deepseek`；`DATABASE_URL` 显式给，不读 `.env`。
- 试跑：`--group known_answer --reps 1`，再 `--group gap --reps 1`。

**边界与接缝**

- 只新增手册 `docs/review/agent-golden-p2-runbook.md`。接缝：真实命令行。

**运行**

- `GOLDEN_API_BASE=http://127.0.0.1:3111/api/v1`、`GOLDEN_USERNAME/PASSWORD`、`GOLDEN_FULL_USERNAME/PASSWORD`、`GOLDEN_DATABASE_URL`
- `node scripts/agent/golden-eval.mjs --group known_answer --reps 1 --json-out <临时路径>`

**可能卡住**

- 没有密钥：**停下上报**，请用户设置环境变量，不索要密钥内容。
- 种子脚本对现有表结构报错，或 `known_answer` 大面积失败：停下上报，不改脚本与期望值。

## 3. 步骤

1. 读上面三处，用一行复述任务。
2. 只检查密钥是否存在。
3. 起容器、迁移、灌数据、建账号、起 API。
4. 试跑两组，确认快照里有步数、轮次号、缺口声明。
5. 按耗时估全量三轮时长，写进手册与回报。
6. 提交：`docs(agent): P2 黄金集重跑手册`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | `known_answer` 5 条 | 都有终态，步数大于 0 | 命令行 |
| 2 | `gap` 20 条 | 每项有 `gapDeclarations` 字段，至少一条非空 | 快照 |
| 3 | 手册与快照 | 不含任何密码或密钥 | 文本检查 |

</task-brief>

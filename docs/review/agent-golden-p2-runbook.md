# 黄金集 P2 重跑手册

日期：2026-11-26｜适用：`scripts/agent/golden-eval.mjs`（`--reps`、`--resume`、`--baseline`）

环境是一次性的：独立容器、模拟数据、跑完删除。不要对着任何有真实数据的库跑。

## 1. 前提

- Docker 可用，本机已有 `postgres:16-alpine`。
- 环境变量 `DEEPSEEK_API_KEY` 已设置。只检查有没有，不打印、不写进文件。
- 端口 `55499`、`3111` 空闲。
- 库账号与管理员的测试值见 `.github/workflows/test.yml` 的链路门禁。下文用 `<…>` 代指。

## 2. 起库与灌数据

按顺序执行，每一步退出码为 0 再做下一步。

1. 起容器 `dilee-p2-golden`，库名 `dilee_test`，只绑 `127.0.0.1:55499`。
2. 设 `TEST_DATABASE_URL`、`DATABASE_URL` 指向它；设 `INITIAL_ADMIN_USERNAME/PASSWORD/DISPLAY_NAME`。
3. `npm run db:test:prepare`
4. `npx tsx apps/api/prisma/seed.ts`
5. `node scripts/seed-mock-data.mjs`
6. `node scripts/bootstrap-permission-accounts.mjs --keep-legacy`，输出重定向到临时目录的文件。
   该输出含初始密码：只从文件读进环境变量，跑完删除文件。
7. `npm run build --workspace=@dilee/api`

## 3. 起 API

环境变量：`DATABASE_URL`、`PORT=3111`、`COOKIE_SECURE=false`、`AGENT_LLM_PROVIDER=deepseek`。
命令：`node apps/api/dist/main.js`。

## 4. 评测

| 变量 | 值 |
|---|---|
| `GOLDEN_API_BASE` | `http://127.0.0.1:3111/api/v1` |
| `GOLDEN_USERNAME` / `GOLDEN_PASSWORD` | 管理员测试值 |
| `GOLDEN_FULL_USERNAME` / `GOLDEN_FULL_PASSWORD` | `laoban1` 与第 2.6 步读出的值 |
| `GOLDEN_DATABASE_URL` | 同一个测试库，库名必须含 `test` |

试跑（先做，确认指标录得到）：

```bash
node scripts/agent/golden-eval.mjs --group known_answer --reps 1 --json-out <临时快照>
node scripts/agent/golden-eval.mjs --group gap --reps 1 --json-out <临时快照>
```

全量：

```bash
node scripts/agent/golden-eval.mjs --reps 3 --baseline docs/review/agent-golden-p1-2026-11-23.snapshot.json --json-out <快照> --out <报告>
```

中断后把 `--json-out <快照>` 换成 `--resume <快照>` 接着跑：有终态的项跳过，只补缺项与 `unknown` 项。
免模型重渲染：`--from-json <快照> --baseline <P1 快照> --out <报告> --analysis <分析文件>`。

## 5. 收尾

停 API，删容器 `dilee-p2-golden`（`docker rm -f -v`），删账号文件。

## 6. 试跑记录（2026-11-26）

| 组 | 条数 | 用时 | 结果 |
|---|---|---|---|
| `known_answer` | 5 | 23 秒 | 5 条通过，步数中位数 2 |
| `gap` | 20 | 128 秒 | 全部完成；真缺口 10 条里 8 条有放行声明，干扰 10 条里 0 条 |

据此估计全量三轮约 35 至 45 分钟。

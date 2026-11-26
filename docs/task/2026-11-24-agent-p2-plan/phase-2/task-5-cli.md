<task-brief>

## 1. Where this task sits

- **阶段 2 方案用数据定**，目标是不写缺口代码就知道 C 方案行不行。
- **本任务把前几块接成一个入口脚本**：读题集、按组按题按次跑、写快照、算指标；带 `--dry` 用假模型干跑，不花钱。
- **Starts after**：任务 1、3、4。**Waits on it**：任务 6。

## 2. What the developer needs to know

**Read first**

- `scripts/agent/golden-eval.mjs` — 既有入口脚本如何解析参数、写输出文件、在缺少环境变量时退出。
- `scripts/agent/gap-experiment/run-one.mjs`（任务 3）与 `metrics.mjs`（任务 4）— 本脚本要调的两个函数。
- `apps/api/test/agent-golden/gap-cases/gap-questions.json`（任务 1）— 含 `reviewedBy` 门。
- `apps/api/src/modules/business-query-agent/deepseek-llm-provider.ts` — 构造 `createDeepSeek` 的方式，实跑时用同一个模型名 `deepseek-chat`。

**Settled**

- 命令形状：`node scripts/agent/gap-experiment.mjs [--dry] [--group A,B,C] [--reps 3] [--limit N] --out <目录>`。默认三组、3 次、全部题。
- **审阅门**：非 `--dry` 时，题集的 `reviewedBy` 为 `null` 就退出，退出码 2，消息「题集未审，不实跑」；`--dry` 不受限（README；计划 R-3 验收）。
- 非 `--dry` 时缺 `DEEPSEEK_API_KEY` 退出码 2，消息「缺少 DEEPSEEK_API_KEY」；**不读也不打印**该变量的值。
- 输出：`<out>/records.json`（全部运行记录，原样）、`<out>/metrics.json`（`computeMetrics` 与 `decide` 的结果）。目录不存在则创建。
- `--dry` 的假模型：永远只回一段文本，不调任何工具。目的只是验证脚本的全流程与产物形状。
- 运行顺序：按题、按组、按次嵌套，**串行**，失败的一次记一条 `error` 字段的记录并继续，不中断全批。

**Edges and seam**

- 新文件 `scripts/agent/gap-experiment.mjs`，与 `golden-eval.mjs` 同级；测试 `scripts/agent/gap-experiment-cli.test.mjs`。不改既有脚本。
- Seam：导出 `main(argv, env)` 供测试调用，不在测试里起子进程；文件末尾只在 `process.argv[1]` 指向本文件时才执行 `main`。

**Run**

- `npm run build --workspace=@dilee/api && node --test scripts/agent/gap-experiment-cli.test.mjs`
- `node scripts/agent/gap-experiment.mjs --dry --limit 3 --out <系统临时目录>/gap-dry`（人工看产物）

**Unknowns**

- 实跑时模型偶发超时或限流：本任务只要求「记一条 `error` 记录并继续」，不加重试；若想加重试，停下问。
- `main` 要能用假 `fs` 吗：不需要，测试用系统临时目录真写。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1（干跑产物），红，再实现 `main` 的读题集、跑、写两个文件。
3. 写用例 2、3（审阅门；缺 key），红，再加两道退出。
4. 写用例 4（`--group` 与 `--limit`），红，再实现参数。
5. 写用例 5（单次失败不中断），红，再实现 `error` 记录。
6. 跑 Run 的两条命令，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `main(["--dry","--out",临时目录], {})`，题集用真文件 | `records.json` 恰 270 条（30 题 × 3 组 × 3 次，来源：设计 §2.7）；`metrics.json` 含 `A`、`B`、`C` 三个键；退出码 0 | `main` |
| 2 | 非干跑，题集 `reviewedBy` 为 `null` | 返回退出码 2；不创建 `records.json` | `main` |
| 3 | 非干跑，题集 `reviewedBy` 已填，`env` 里没有 `DEEPSEEK_API_KEY` | 返回退出码 2；输出里不含任何密钥值 | `main` |
| 4 | `--dry --group C --limit 4` | `records.json` 恰 12 条（4 题 × 1 组 × 3 次），`group` 全是 `C` | `main` |
| 5 | 用注入的假 `runOne` 在第 5 次调用时抛错 | `records.json` 里有恰 1 条带 `error` 的记录，其余照常，总条数不变 | `main` |

</task-brief>

# 任务 3：漂移率与误报

<task-brief>

## 1. 在哪里

- **阶段 8 时延有数**。
- **本任务推进 R-13**：评测结果里带上模型实际放行的缺口声明，算出漂移率与误报率。
- **开工前提**：任务 2 已提交。**后续**：任务 4。

## 2. 要知道的

**先读**

- `apps/api/src/modules/business-query-agent/agent-orchestrator.ts` 的 `declareGap`：什么时候写事件、写什么。
- 同目录 `stream-transport.ts`：该事件为什么从事件流拿不到。
- `scripts/agent/golden-eval.mjs`：快照在哪一步写。
- `scripts/provision-test-databases.mjs`：库名必须含 `test` 的检查写法。

**已定**

- 新模块 `scripts/agent/golden-gap-metrics.mjs`：`gapMetrics(entries)` 纯函数；`readDeclarations(client, runIds)` 读 `agent_run_events` 中类型 `gap_declared` 的行。
- 库连接只来自 `GOLDEN_DATABASE_URL`，库名不含 `test` 直接报错；只读。有缺口用例而没给该变量：开跑前就退出。
- 每项结果写 `outcome.gapDeclarations: [{ nearest_operation, missing }]`，随快照保存。
- 返回 `{ declarations, mismatched, driftRate, undeclared, gapRuns, decoyRuns, falsePositives, falsePositiveRate }`；分母为 0 时比率为 `null`。终态 `unknown` 的项不计入任何分母。
- 不改 API 代码，不让事件进事件流。

**边界与接缝**

- 动新模块、`golden-eval.mjs`、新测试（登记进两条 npm 脚本）。接缝：两个导出函数，库用假对象。

**运行**

- `npm run test:agent-golden:unit`

**可能卡住**

- 装置脚本里加载不了 Prisma 客户端（部署门禁在构建前跑）：客户端只在命令行入口动态引入；仍不行就停下上报。

## 3. 步骤

1. 读上面四处，用一行复述任务。
2. 用例 1–3，红后绿。
3. 用例 4、5，红后绿。
4. 接进命令行。
5. 跑装置单测，提交：`feat(agent): 评测读出缺口声明并算漂移率与误报率`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | 真缺口题（标注 `get_payables`）三轮声明：`get_payables`、`get_receivables`、无 | 声明 2、不一致 1、漂移率 0.5、未声明 1、缺口轮次 3 | `gapMetrics` |
| 2 | 一轮里两条声明，一条一致一条不一致 | 声明 2、不一致 1 | `gapMetrics` |
| 3 | 干扰题 4 轮，1 轮有声明；另 1 轮终态 `unknown` | 干扰轮次 3、误报 1 | `gapMetrics` |
| 4 | 没有任何声明 | 漂移率 `null` | `gapMetrics` |
| 5 | 假客户端返回两条事件；连接串库名 `dilee_erp` | 前者得两条声明；后者报错且不查询 | 读取函数与入口检查 |

</task-brief>

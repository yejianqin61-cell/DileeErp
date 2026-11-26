<task-brief>

## 1. Where this task sits

- **阶段 2 方案用数据定**，目标是不写缺口代码就知道 C 方案行不行。
- **本任务是实跑与写结论**：跑 270 次、快照入库、按判据写三选一报告。这是本批唯一花真钱、唯一产出结论的一步。
- **Starts after**：任务 5，且题集与 B 组轴声明**已被用户审过**。**Waits on it**：阶段 3、4 的走向。

## 2. What the developer needs to know

**Read first**

- `docs/task/2026-11-24-agent-p2-plan/plan.md` 阶段 2 一节 — 三种结论各自如何改写阶段 3、4。
- `docs/design/dilee-consultant-p2-tool-catalog-2026-11-24.md` §2.7 — 判据原文与六项指标。
- `docs/review/agent-golden-p1-2026-11-23.md` — 既有评测报告的结构，新报告沿用。
- `apps/api/test/agent-golden/gap-cases/gap-questions.json` — 确认 `reviewedBy` 已填。

**Settled**

- 开跑前提：题集 `reviewedBy` 与 `reviewedAt` 已由**用户**填写；密钥 `DEEPSEEK_API_KEY` 在环境里。缺任一，**停下问用户**，不得自己填审阅字段（README）。
- 命令：`node scripts/agent/gap-experiment.mjs --out docs/review/agent-gap-experiment-2026-11-24-snapshot`，三组各 3 次、全部 30 题（设计 §2.7）。
- 结论只取 `metrics.json` 里 `decide` 的值，**不自行解读**：`adopt_C`、`reopen_matrix`、`observe_only` 三者之一直接写入；若是 `undecided`，报告写「判据未覆盖」并把三组关键指标并排列出，**停下交用户定**。
- 报告位置 `docs/review/agent-gap-experiment-2026-11-24.md`，原始快照目录入库（设计 §2.7；计划 R-3 验收）。
- 报告按「简报」写：先给结论与三组对照表，再说它改变什么，最后列未覆盖的局限。限制必须写：工具由桩应答不连库、`deepseek-chat` 单一模型、B 组轴声明待审过的版本、无结构类标注有争议。

**Edges and seam**

- 只新增报告与快照。**不改任何脚本、不改题集内容**；发现题集标注疑似有误，只在报告「局限」里记下，不动文件。
- Seam：无新代码。

**Run**

- `node scripts/agent/gap-experiment.mjs --out docs/review/agent-gap-experiment-2026-11-24-snapshot`
- `node --test scripts/agent/gap-experiment/*.test.mjs scripts/agent/gap-experiment-cli.test.mjs`

**Unknowns**

- 270 次运行耗时与费用未知：先用 `--limit 2` 跑一遍并估算，再向用户报一个数字，得到同意才跑全量。
- 多次出现 `error` 记录（模型超时或限流）：超过总记录的 5% 就停下报告，不要自己重跑拼数。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 确认题集 `reviewedBy` 已填、密钥在环境里；缺则停下问。
3. 用 `--limit 2` 小跑，估算全量耗时与费用，向用户报数并等同意。
4. 全量实跑，产物写入快照目录；检查 `error` 记录占比。
5. 读 `metrics.json`，把三组六项指标与 `decide` 的结论写进报告，按简报结构成文。
6. 把「结论如何改写阶段 3、4」抄进报告末尾（取自计划阶段 2 一节，不加新意见）。
7. 提交报告与快照。

## 4. The test cases

本任务不新增测试，验收对象是产物：

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 快照目录 | 含 `records.json`（270 条）与 `metrics.json`；`error` 记录不超过 13 条（5%） | 文件 |
| 2 | 报告 | 含三组 × 六项指标的对照表，数字与 `metrics.json` 逐项一致（抽查三格） | 文件 |
| 3 | 报告结论句 | 与 `metrics.json` 里 `decide` 的值一致，三选一或「判据未覆盖」 | 文件 |
| 4 | 报告「局限」 | 含桩应答、单一模型、B 组轴声明版本、无结构类标注争议四条 | 文件 |

</task-brief>

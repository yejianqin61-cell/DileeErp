<task-brief>

## 1. Where this task sits

- **阶段 2 方案用数据定**，目标是不写缺口代码就知道 C 方案行不行。
- **本任务交付六项指标的计算与三选一判据**：纯函数，输入是运行记录与题集，输出是各组指标与结论。
- **Starts after**：无（只依赖记录形状，已在任务 3 钉死）。**Waits on it**：任务 5、6。

## 2. What the developer needs to know

**Read first**

- `docs/design/dilee-consultant-p2-tool-catalog-2026-11-24.md` §2.7 — 六项指标与三条判据的原文。
- `docs/task/2026-11-24-agent-p2-plan/phase-2/task-3-run-one.md` — 运行记录字段（Settled 一段）。
- `scripts/agent/golden-report.mjs` 与 `golden-report.test.mjs` — 既有「纯函数算指标 + 手算期望」的写法。

**Settled**

- 记录里 `gap !== null` 即「本次判出缺口」；`capped` 的记录不特殊处理，按 `gap` 如实算。
- 指标定义（分母都是该类别下该组的**运行次数**，即题数 × 3）：
  - `recall` 真缺口召回率：`class=gap` 的运行里判出缺口的比例。
  - `decoyFp` 诱饵误报率：`class=decoy` 的运行里判出缺口的比例。
  - `nodataFp` 缺数据误报率：`class=nodata` 的运行里判出缺口的比例。
  - `callsBeforeGap`：判出缺口的 `class=gap` 运行里，`domainCallsBeforeGap` 的平均值；没有这样的运行时为 `null`。
  - `consistency` 一致率：30 题里，该题 3 次的「是否判缺口」全相同的题数 ÷ 30。
  - `nearestAgree` 最近邻一致率：只算 C 组、判出缺口且题目 `nearest` 非空的运行，`gap.nearest_operation` 等于题目 `nearest` 的比例；A、B 组为 `null`。
- 无结构类不进上面前三项，只额外给 `unstructuredGapRate` 描述用。
- 比较用**整数交叉相乘**，不用浮点相等：`count * 10 >= 8 * total` 表示 ≥ 80%，`count * 10 <= total` 表示 ≤ 10%，「好 10 个百分点」为 `(x.count * y.total - y.count * x.total) * 10 >= x.total * y.total`（设计 §2.7）。
- 判据 `decide(metrics)` 按序：（1）C 达底线（召回 ≥ 80% 且 `decoyFp` ≤ 10%），且**不是**「B 在召回与误报上同时比 C 好 10 个百分点以上」→ `adopt_C`；（2）B 在召回高于 C 至少 10 个百分点，且 `decoyFp` 低于 C 至少 10 个百分点 → `reopen_matrix`；（3）A、B、C 三组都未达底线 → `observe_only`；（4）其余 → `undecided`。（1）（2）（3）的原文见设计 §2.7「判据」；（4）是本批补的：原文没覆盖「C 未达底线而 B 或 A 达底线，且 B 没有同时领先 10 点」的情形，此时**不替用户做选择**。

**Edges and seam**

- 新文件 `scripts/agent/gap-experiment/metrics.mjs`，导出 `computeMetrics(records, questions)` 与 `decide(metricsByGroup)`。不依赖模型与网络。
- Seam：这两个纯函数，测试喂手造记录。

**Run**

- `node --test scripts/agent/gap-experiment/metrics.test.mjs`

**Unknowns**

- 手造记录的期望数字必须**手算**，写在测试注释以外的字面量里；若发现自己在用被测函数算期望，停下。
- 一致率分母是题数（30）不是运行次数，别混。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1（三项误报与召回），红，再实现 `computeMetrics` 的前三项。
3. 写用例 2、3（`callsBeforeGap`、`consistency`、`nearestAgree`），红，再补齐。
4. 写用例 4、5、6（`decide` 四种结论），红，再实现。
5. 写用例 7（边界：恰 80% 与恰 10%），红，再确认用整数比较。
6. 跑 Run 的命令，提交。

## 4. The test cases

题集用：真缺口 2 题（g1、g2）、诱饵 2 题（d1、d2），其余类不出现；每题 3 次，故各类分母为 6。

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 组 C：g1 三次都报、g2 三次中报 2 次；d1 一次不报、d2 三次中报 1 次 | `recall` 为 5/6，`decoyFp` 为 1/6 | `computeMetrics` |
| 2 | 同上，g1 三次 `domainCallsBeforeGap` 为 1、1、3，g2 报的两次为 0、2 | `callsBeforeGap` 为 7/5（1.4） | `computeMetrics` |
| 3 | 同上 | `consistency` 为 2/4（g1 三次全报、d1 三次全不报，一致；g2 报 2 次、d2 报 1 次，不一致） | `computeMetrics` |
| 4 | 组 C 的 g1 三次报的 `nearest_operation` 为 `a`、`a`、`b`，题目 `nearest` 为 `a`；g2 两次报，题目 `nearest` 为 `c`，报的为 `c`、`c` | `nearestAgree` 为 4/5；A、B 组为 `null` | `computeMetrics` |
| 5 | C：召回 24/30、`decoyFp` 3/30；B：召回 25/30、`decoyFp` 2/30 | `adopt_C`（恰好达底线；B 只高 1/30，不到 10 点） | `decide` |
| 6 | C：召回 20/30、`decoyFp` 6/30；B：召回 24/30、`decoyFp` 2/30（高 4/30，约 13.3 点；低 4/30，约 13.3 点） | `reopen_matrix` | `decide` |
| 7 | A、B、C 的召回都是 15/30，`decoyFp` 都是 0/30 | `observe_only`（召回都低于 80%） | `decide` |
| 8 | C：召回 20/30、`decoyFp` 3/30；B：召回 25/30、`decoyFp` 3/30 | `undecided`（C 未达底线；B 在误报上没有领先，不满足同时领先） | `decide` |

</task-brief>

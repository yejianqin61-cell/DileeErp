# 任务 2：多轮与断点续跑

<task-brief>

## 1. 在哪里

- **阶段 8 时延有数**。
- **本任务推进 R-12**：评测能跑三轮，中途断掉能接着跑，不重复花钱。
- **开工前提**：任务 1 已提交。**后续**：任务 3。

## 2. 要知道的

**先读**

- `scripts/agent/golden-eval.mjs`：现在的循环与 `--json-out`。
- `scripts/agent/golden-runner.mjs` 的 `runCase`、`mergeOutcomes`：一条用例返回什么。
- `scripts/agent/gap-experiment.mjs`：`main(argv, env, deps)` 的可测写法。

**已定**

- 新模块 `scripts/agent/golden-reps.mjs`：`runReps({ cases, reps, previous, runOne, save })`。
- 结果按轮：每项带 `caseDef`、`outcome`、`missing`、`rep`（从 1 起）。先跑完第 1 轮全部用例再进第 2 轮。
- 每跑完一项就调 `save` 写快照（先写临时文件再改名）。
- `--reps N` 默认 1；`--resume 路径` 读快照，已有 `(用例号, rep)` 跳过；快照里用例定义与现在不一致则报错退出。
- 单条抛错（超时、断流）记一条终态 `unknown` 的结果继续跑，续跑时**重跑**这类结果。
- 多轮合并后 `outcome.runIds` 含该用例每一问的轮次号。不带 `--reps` 时现有输出与退出码不变。

**边界与接缝**

- 动新模块、`golden-eval.mjs`、`golden-runner.mjs`、新测试 `golden-reps.test.mjs`（登记进两条 npm 脚本）。接缝：`runReps` 与 `mergeOutcomes`。

**运行**

- `npm run test:agent-golden:unit`

**可能卡住**

- `golden-eval.mjs` 的 `--from-json` 旧快照（无 `rep`）渲染结果必须不变；做不到就停下上报。

## 3. 步骤

1. 读上面三处，用一行复述任务。
2. 用例 1–3，红后绿。
3. 用例 4、5，红后绿。
4. 接进命令行。
5. 跑装置单测，提交：`feat(agent): 黄金集支持多轮与断点续跑`。

## 4. 用例

用两条假用例、`reps: 3`、记录调用的假 `runOne`。

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | 从头跑 | 调 6 次，顺序是第 1 轮两条、第 2 轮两条……；`save` 6 次 | `runReps` |
| 2 | `previous` 含 4 项完成结果 | 只调 2 次，返回 6 项 | `runReps` |
| 3 | 某次 `runOne` 抛错；再用结果续跑 | 首次得 `unknown` 且其余照跑；续跑只重跑它 | `runReps` |
| 4 | `previous` 里同号用例的问题文字不同 | 抛错，一次不调 | `runReps` |
| 5 | 两问用例，轮次号为 `a`、`b` | `runIds` 为 `["a","b"]` | `mergeOutcomes` |

</task-brief>

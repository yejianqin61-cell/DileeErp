# 任务 4：P2 报告渲染与判据

<task-brief>

## 1. 在哪里

- **阶段 8 时延有数**。
- **本任务推进 R-12**：从快照直接渲染出 P2 报告，三条判据由代码给结论。
- **开工前提**：任务 3 已提交。**后续**：任务 5。

## 2. 要知道的

**先读**

- `scripts/agent/golden-report.mjs`：现有汇总与中位数算法。
- `docs/review/agent-golden-p1-2026-11-23.snapshot.json`：基线数据形状（`judged`）。
- 本批 README「已定」：三条判据与两个比率的定义。

**已定**

- 新模块 `scripts/agent/golden-p2-report.mjs`：`evaluate({ entries, baseline })` 与 `renderP2(result, meta)`；现有报告模块不改。
- 多轮快照（含 `rep`）经 `golden-eval.mjs --from-json` 时走 P2 报告，`--baseline` 指向 P1 快照。
- 步数缺失（0）的轮次不参与取中间值，报告写出缺失个数。
- 报告含：结论与三条判据逐条「达成/未达成」、按组中位数与 P1 对照、逐轮通过数、失败码分布、漂移与误报、未通过清单。
- 任一判据未达成，命令退出码 1。

**边界与接缝**

- 动新模块、`golden-eval.mjs`、新测试（登记进两条 npm 脚本）。接缝：两个导出函数。

**运行**

- `npm run test:agent-golden:unit`

**可能卡住**

- 用 P1 快照算出的分组中位数与用例 1 不符：停下上报，不改期望值。

## 3. 步骤

1. 读上面三处，用一行复述任务。
2. 用例 1，红后绿。
3. 用例 2–4，红后绿。
4. 用例 5，渲染与命令行。
5. 跑装置单测，提交：`feat(agent): P2 黄金集报告与三条判据`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | 只给 P1 快照作基线 | 总中位数 3；entry 3、finance_positive 3、followup 6、known_answer 2、miss 2、permission 3、relation 3 | `evaluate` |
| 2 | 某条三轮步数 2、5、2；另一条 3、0、3 | 取 2 与 3；缺失计 1 | `evaluate` |
| 3 | 基线内用例中位数 2，基线外用例步数全是 9 | 判据一达成 | `evaluate` |
| 4 | 70 条×3 轮里带失败码 3 项；另一次 4 项 | 判据三前者达成、后者未达成 | `evaluate` |
| 5 | 某条第 2 轮未通过 | 判据二未达成；报告列出用例号与轮次 | `renderP2` |

</task-brief>

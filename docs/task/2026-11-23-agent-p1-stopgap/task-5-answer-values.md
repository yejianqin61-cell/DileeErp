<task-brief>

## 1. Where this task sits

- **Phase P1 止血**，目标之一是验掉 P0 的盲区。
- **本任务交付 R-5 答案数值正确性**：P0 只断言了链路通，本任务断言答案里的数字对。
- **Starts after**：任务 1、2（归一的数字要靠它们取）。**Waits on it**：任务 6。

## 2. What the developer needs to know

**Read first**

- `scripts/seed-mock-data.mjs` — 期望数字的唯一来源。`MOCK-ORD-001`：数量 1000、单位 个、交期 2026-09-20；`MOCK-ORD-002`：600、2026-09-30。
- `apps/api/src/modules/business-query-agent/tools/order-overview-tools.ts` — 概览返回哪些数量字段，名字是什么。
- `apps/api/test/agent-golden/cases/` 现有 61 条 — 本任务新增 `known-answer` 组，不改既有组。

**Settled**

- 数字断言**只断来源单里必然出现的值**：数量、交期、状态。不断言金额（种子数据里金额字段有 DECIMAL 格式化差异，容易假红）。
- 断言对象是**答案文本里出现某个数字串**，而不是「等于」：模型会说「1000 个」「共 1000」，两种都算对。
- 数字串必须带边界：`1000` 不能匹配到 `10000`，也不能匹配到单号里的 `1000`。用一个「前后不接数字」的正则判据。
- 已知答案的期望值全部抄自种子脚本的字面量，不跑一次反推。

**Edges and seam**

- 新增 `apps/api/test/agent-golden/cases/known-answer.json`；`golden-judge.mjs` 加一类期望 `answerIncludesDigits`。
- 不改 `apps/api/src`。

**Run**

- `npm run test:agent-golden:unit`（新判据要有单测）
- `npm run test:agent-golden -- --group known_answer`

**Unknowns**

- 中文数字（「一千」）会让数字串断言失败。若真机出现这种答案，停下来报告：那要么改判据接受中文数字，要么承认模型措辞不可控，两者是不同决定。

## 3. The workflow

1. 读三个文件，一句话复述本任务。
2. 先给 `golden-judge.mjs` 写失败测试：答案含 `1000`、期望 `1000` → pass；答案含 `10000`、期望 `1000` → fail（边界）；答案含 `一千` → fail。
3. 实现 `answerIncludesDigits`：对每个期望数字，用 `(?<!\d)<num>(?!\d)` 判存在。
4. 写 `known-answer.json` 5 条：数量、交期、状态、两张单的数量对比、产品名。
5. 跑真机该组，记录结果。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 答案「共 1000 个」，期望 `["1000"]` | pass | `judge()` |
| 2 | 答案「共 10000 个」，期望 `["1000"]` | fail（不得越界匹配） | `judge()` |
| 3 | 答案「单号 MOCK-ORD-1000」，期望 `["1000"]` | fail（单号里的数字不算） | 见 Unknowns |
| 4 | 答案「一千个」，期望 `["1000"]` | fail | `judge()` |
| 5 | 答案「1000 个，600 个」，期望 `["1000","600"]` | pass | `judge()` |

</task-brief>
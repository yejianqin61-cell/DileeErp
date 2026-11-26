<task-brief>

## 1. Where this task sits

- **阶段 2 方案用数据定**，目标是不写缺口代码就知道 C 方案行不行。
- **本任务交付题集与它的格式校验**：30 题、四类、每题有期望判定与期望最近邻；文件带「待审」状态，用户审过前任务 6 不得实跑。
- **Starts after**：无。**Waits on it**：任务 5、6。

## 2. What the developer needs to know

**Read first**

- `docs/task/2026-11-24-agent-p2-plan/phase-2/README.md` — 「题集种子」四张表，是题集内容的唯一来源。
- `apps/api/test/agent-golden/cases/miss-unknown.json` — 既有黄金集用例的文件形状，题集放在它旁边的新目录里。
- `scripts/agent/golden-cases.test.mjs` — 既有 `.mjs` 校验测试的写法与断言风格。
- `apps/api/src/modules/business-query-agent/tools/tool-registry.ts` — `TOOL_CAPABILITIES`，期望最近邻必须出自这张表。

**Settled**

- 题集路径 `apps/api/test/agent-golden/gap-cases/gap-questions.json`，**不放进** `cases/` 目录：既有 `loadCases` 读 `cases/` 全部文件，放进去会被黄金集当成用例（README「本批已定」）。
- 文件形状：`{ "reviewedBy": null, "reviewedAt": null, "questions": [ {id, class, question, expect, nearest, missing, stub} ] }`。`class` 取 `gap|decoy|nodata|unstructured`；`expect` 取 `gap|no_gap`；`missing` 在真缺口取 `group_by|filter|metric|time_series|object`，其余类为 `null`；`stub` 取 `rows|empty`（设计 §2.2、§2.7）。
- 题面与标注**逐字取自 README 的种子表**，不增删、不润色、不自行再想题。

**Edges and seam**

- 只新增题集 JSON、一个校验测试、`package.json` 的一条脚本。不读也不改 `golden-cases.mjs`。
- Seam：校验测试读题集文件，并用 `createRequire` 读 `apps/api/dist/.../tool-registry.js` 的 `TOOL_CAPABILITIES`。

**Run**

- `npm run build --workspace=@dilee/api && node --test scripts/agent/gap-experiment/questions.test.mjs`
- `npm run test:agent-golden:validate`（确认既有黄金集的计数没被新文件影响）

**Unknowns**

- 种子表里有 operation 名在 `TOOL_CAPABILITIES` 里找不到：停下报告，不要改名。
- `package.json` 的 `test:deploy` 已是一长串；只在末尾追加新测试文件，不重排。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1（文件形状与计数），红，再把 30 题转写成 JSON，`reviewedBy` 与 `reviewedAt` 填 `null`。
3. 写用例 2、3（`nearest` 都在能力表；`stub` 与类别的对应），红，再补正转写错误。
4. 写用例 4（待审状态可读），红，再保证两个字段存在。
5. 在 `package.json` 加 `test:agent-gap:unit` 指向 `scripts/agent/gap-experiment/*.test.mjs`，并把新测试文件追加到 `test:deploy`。
6. 跑 Run 的两条命令，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 读题集 | `questions` 共 30 条；四类计数依次为 10、10、5、5（来源：设计 §2.7）；`id` 全不重复 | 题集文件 |
| 2 | 每题的 `nearest` | 30 个值都在 `TOOL_CAPABILITIES` 的 operation 名里（来源：能力表，35 条） | 题集 + 能力表 |
| 3 | 每题的 `expect`、`stub`、`missing` | `class=gap` 的 10 题 `expect=gap` 且 `missing` 在五个枚举内；其余 20 题 `expect=no_gap` 且 `missing=null`；`stub=empty` 的恰为 `nodata` 类 5 题（来源：README 种子表） | 题集文件 |
| 4 | 题集的审阅状态 | 文件含 `reviewedBy` 与 `reviewedAt` 两个键；转写完成时两者为 `null` | 题集文件 |
| 5 | `gap-04` 与 `unstructured-05` | 题面逐字等于「本月所有订单的应收账款总额是多少」与「MOCK-ORD-001 和 MOCK-ORD-002 哪个更急」（来源：README 种子表，防转写走样） | 题集文件 |

</task-brief>

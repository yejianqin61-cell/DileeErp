# 任务 1：目录问法与缺口题入集

<task-brief>

## 1. 在哪里

- **阶段 8 时延有数**。
- **本任务推进 R-12、R-13**：黄金集多一条「该用列表入口」的问法和 20 条缺口题。
- **开工前提**：无。**后续**：任务 2。

## 2. 要知道的

**先读**

- `scripts/agent/golden-cases.mjs`：用例允许哪些字段、分组怎么校验。
- `apps/api/test/agent-golden/gap-cases/gap-questions.json`：题目与标注。
- `apps/api/test/agent-golden/cases/entry-sales.json`：用例写法。
- `package.json` 的 `test:deploy`、`test:agent-golden:unit`：新测试文件登记在哪。

**已定**

- 新组 `gap`；用例多一个只许该组使用且该组必填的字段 `gap: { class: "gap"|"decoy", nearest }`。
- `cases/gap.json`：20 条，号与题目、标注取自题集的前两类，不改一个字。
- 缺口题期望只有 `terminal: "completed"` 与排除三个内部失败码（照 `entry-sales.json`）。
- 目录问法：`entry-catalog-list`，组 `entry`，问「最近有哪些已确认的销售订单」，期望完成、`opsInclude: ["list_documents"]`、排除同样三个码。
- 题集文件不改。

**边界与接缝**

- 动用例解析、两个用例文件、新测试 `scripts/agent/golden-gap-cases.test.mjs` 与 `package.json`。接缝：`loadCases`、`parseCase`。

**运行**

- `npm run test:agent-golden:unit`，`npm run test:agent-golden:validate`

**可能卡住**

- 现有装置测试断言了分组清单或总数而变红：只更新清单与总数，提交说明写明；其他断言要改就停下上报。

## 3. 步骤

1. 读上面四处，用一行复述任务。
2. 用例 1、2，红后绿。
3. 写两份用例文件，用例 3、4。
4. 登记新测试，跑两条命令。
5. 提交：`test(agent): 黄金集并入目录问法与缺口题`。

## 4. 用例

| # | 输入 | 期望 | 接缝 |
|---|---|---|---|
| 1 | `gap` 组缺 `gap` 字段；`class: "nodata"`；`entry` 组带 `gap` | 三者都抛用例错误 | `parseCase` |
| 2 | 合法缺口用例 | 解析结果保留 `gap` | `parseCase` |
| 3 | 读全部用例 | 91 条；`gap` 组 20 条，两类各 10 | `loadCases` |
| 4 | 逐条对照题集 | 题目、类别、最近邻完全一致 | `loadCases` |

</task-brief>

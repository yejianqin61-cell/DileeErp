<task-brief>

## 1. Where this task sits

- **阶段 2 方案用数据定**，目标是不写缺口代码就知道 C 方案行不行。
- **本任务交付单题单次运行器**：给一个组、一道题、一个模型，跑一次带桩工具的对话，返回一条记录（有没有报缺口、报了什么、报之前调了几次领域工具）。
- **Starts after**：任务 2。**Waits on it**：任务 5。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/deepseek-llm-provider.ts` — `TOOL_DESCRIPTIONS`、`domainInputSchema`、`CATALOG_TOOL_DESCRIPTION`、`catalogInputSchema`：实验要用线上同一份工具声明。
- `scripts/agent/gap-experiment/groups.mjs`（任务 2 产出）— `buildGroup` 给出系统指令与 `report_gap` 声明。
- `apps/api/src/modules/business-query-agent/tools/tool-catalog.ts` — `describeModule`，展开工具的桩直接调它。
- `apps/api/test/unit/agent-deepseek-provider.test.cjs` — 如何用 `MockLanguageModelV4` 脚本化模型；本任务的测试用同一种假模型。

**Settled**

- 唯一允许的 `src` 改动：在 `deepseek-llm-provider.ts` 里给上面四个标识符加 `export`，只加关键字（README）。改完立即 `npm run typecheck --workspace=@dilee/api`。
- 用 `ai` 的 `generateText` 带 `tools`（每个工具有 `execute`）与 `stopWhen: stepCountIs(8)`，让 SDK 自己跑多步，不手写循环；从 `result.steps` 按序读工具调用（设计 §2.7 的「方式」）。
- 工具桩：六个领域工具各用 `domainInputSchema(tool)` 与 `TOOL_DESCRIPTIONS[tool]`；`catalog_query` 的 `execute` 调 `describeModule(args.module, "full")`；`report_gap` 用任务 2 的 `gapTool`；领域工具应答规则见 README「工具结果」。
- 记录字段固定：`{ group, id, rep, gap: 参数对象|null, domainCallsBeforeGap: 数|null, domainCalls: 数, catalogCalls: 数, capped: 布尔, answered: 布尔 }`。`gap` 取**第一次** `report_gap` 的参数；`domainCallsBeforeGap` 为该次之前的领域工具调用数，没报则 `null`。
- `capped` 为真当且仅当跑满 8 步且最后一步仍是工具调用；此时 `gap` 仍按已发生的如实记录。

**Edges and seam**

- 新文件 `scripts/agent/gap-experiment/run-one.mjs`，导出 `runOne({ group, question, model, rep })`。`model` 是 AI SDK 的 `LanguageModel`，由调用方给；本任务不读 API key。
- Seam：`runOne` 配假模型，测试断言返回记录与桩的应答。

**Run**

- `npm run build --workspace=@dilee/api && node --test scripts/agent/gap-experiment/run-one.test.mjs`
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 假模型的多步脚本写法与 `agent-deepseek-provider.test.cjs` 不同（那边只测单步）：若 `result.steps` 读不出调用顺序，停下报告，不要改用手写循环。
- `ai` 的导入：`node -e "import('ai')"` 在仓库根应成功；失败则停下报告。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 给提供方四个标识符加 `export`，跑 typecheck。
3. 写用例 1（没报缺口的一次），红，再实现 `runOne` 骨架与桩。
4. 写用例 2、3（报缺口前调用计数；`stub: empty` 的应答），红，再补齐。
5. 写用例 4、5（步数上限；展开工具），红，再补齐。
6. 跑 Run 的命令，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 假模型：第 1 步调 `order_query/search_documents{q:"MOCK-ORD-001"}`，第 2 步回文本；组 C，题 `decoy-06` | `gap` 为 `null`，`domainCalls` 为 1，`domainCallsBeforeGap` 为 `null`，`answered` 为真，`capped` 为假 | `runOne` |
| 2 | 假模型：第 1 步调 `warehouse_query/list_low_stock_materials`，第 2 步调 `report_gap` 带 C 的参数，第 3 步回文本；题 `gap-03` | `gap.nearest_operation` 为 `list_low_stock_materials`；`domainCallsBeforeGap` 为 1；`domainCalls` 为 1 | `runOne` |
| 3 | 假模型对 `stub: empty` 的题调 `search_documents` 再调 `get_reconciliations`；题 `nodata-01` | 假模型第 3 步收到的 `search_documents` 结果是含 `o_1` 的一行，`get_reconciliations` 的结果是 `[]`（来源：README「工具结果」） | `runOne` |
| 4 | 假模型每一步都调一次 `search_documents`，从不收尾 | 记录 `capped` 为真，`gap` 为 `null`，`domainCalls` 为 8 | `runOne` |
| 5 | 假模型第 1 步调 `catalog_query{operation:"describe_module",module:"procurement_query"}` | `catalogCalls` 为 1，`domainCalls` 为 0；该调用的桩结果的 `operations` 长度为 5（来源：阶段 1 任务 4 用例 1，采购模块 5 条） | `runOne` |

</task-brief>

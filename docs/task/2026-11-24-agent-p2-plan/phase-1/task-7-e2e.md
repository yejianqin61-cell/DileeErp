<task-brief>

## 1. Where this task sits

- **阶段 1 模型能看见目录**，目标是 prompt 里有六段模块声明、模型能按需展开 operation 条目。
- **本任务交付阶段 1 的 Proof**：一条端到端细线——模型看到目录、展开采购模块、直接选中无根入口，全程没有试错。
- **Starts after**：任务 3、4、5。**Waits on it**：阶段 2。

## 2. What the developer needs to know

**Read first**

- `apps/api/test/unit/agent-orchestrator.test.cjs` — `scriptedProvider`、`captured`、`toolFacts`、`fakeExecutor`：本任务只拼这些，不另造测试座。
- `apps/api/test/unit/agent-model-steps.test.cjs` — 现有 `model_steps` 的断言写法，照用。
- `apps/api/src/modules/business-query-agent/tools/tool-catalog.ts` — `describeModule` 的返回形状，期望值从它**之外**的规格文件取。
- `docs/task/2026-11-24-agent-p2-plan/phase-1/README.md` — 本批「不做」清单，尤其是不跑真模型。

**Settled**

- 本任务**只写一个测试文件**，不改业务代码。若测试红，原因在任务 1 至 5 的产物里：停下报告，不要在这里补丁。
- 提供方用脚本化假提供方，**不调真模型**。真模型与黄金集重跑留给阶段 8。
- 场景是 P0 里失败过的那一类：「哪些采购到货超期」。
- 期望的工具与入口名来自能力表与设计文档示例，不来自被测代码的返回。

**Edges and seam**

- 只新增 `apps/api/test/unit/agent-catalog-e2e.test.cjs`。
- Seam：`AgentOrchestrator.run`，加假执行器（返回固定 `list_overdue_arrivals` 事实）与脚本化提供方。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-catalog-e2e.test.cjs`
- 全套：`npm run typecheck --workspace=@dilee/api && npm run build --workspace=@dilee/api && node --test apps/api/test/*.test.cjs apps/api/test/unit/*.test.cjs`，再 `npm run test:lib --workspace=@dilee/web`

**Unknowns**

- 假执行器要按 `list_overdue_arrivals` 返回一条合法 `QueryFact`（含 `sources`），形状抄 `agent-tool-unrooted.test.cjs` 里的既有样例。找不到合适样例就停下报告，不要自编字段。
- 全套测试里可能有与本阶段无关的既有红灯。只报告，不修；并把它们与本批改动是否相关分开写。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1（三步脚本），红或绿都先记下。
3. 逐个加用例 2 至 4。
4. 跑 Run 里的单文件命令，再跑全套。
5. 提交。任务报告写明：阶段 1 的 Proof 是否成立，哪些没验证（真模型、黄金集）。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 脚本三轮：①`catalog_query/describe_module{module:"procurement_query"}`；②`procurement_query/list_overdue_arrivals{}`；③无调用 | run 终态 `completed`；`model_steps` 为 3；`usage.tool_calls` 为 1（只有真查询算事实） | `AgentOrchestrator.run` |
| 2 | 同上，读第二轮 `messages` | 其中一条 `tool` 消息含 `list_overdue_arrivals` 的 `question_shape` 原文（取自规格文件，不取自 `describeModule` 返回） | 同上 |
| 3 | 同上，读事件流 | 没有任何 `tool_status` 为 `failed`；没有 `ORDER_SEARCH_REQUIRED`、`ORDER_REF_REQUIRED` | 同上 |
| 4 | 同上，读第一轮 `messages[0]` | 系统指令含六个模块标题（`full` 档）；`operational` 档下重跑，不含 `finance_query` | 同上 |

</task-brief>

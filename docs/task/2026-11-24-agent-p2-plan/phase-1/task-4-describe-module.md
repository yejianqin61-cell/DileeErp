<task-brief>

## 1. Where this task sits

- **阶段 1 模型能看见目录**，目标是 prompt 里有六段模块声明、模型能按需展开 operation 条目。
- **本任务交付 R-2 的展开工具**：模型调 `catalog_query/describe_module`，拿到该模块全部 operation 的条目；编排器本地处理，不碰库。
- **Starts after**：任务 1、2。**Waits on it**：任务 5、7。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/deepseek-llm-provider.ts` — `toolSetFor`、`domainInputSchema`、`plan()` 里「未授权工具名直接丢弃」的过滤。
- `apps/api/src/modules/business-query-agent/agent-orchestrator.ts` — `queryPhase` 的调用循环、`rejectBeforeExecution`（本地处理的样板：仍发 running 与终态两个 `tool_status`）、`SKIP_ROOT_OPERATIONS`、`RECOVERABLE_TOOL_ERROR_CODES`。
- `apps/api/src/modules/business-query-agent/llm-provider.ts` 与 `tools/tool-registry.ts` — `AgentToolName` 在哪些类型里出现。
- `apps/web/lib/agent-tool-labels.ts` — 步骤文案表；没有标签时会兜底成「业务数据」。

**Settled**

- 工具名 `catalog_query`，唯一 operation `describe_module`，参数 `module`（取值是本档位可见的六个或五个领域工具名）。**不进** `TOOL_CAPABILITIES`、**不进** `AGENT_TOOLS`：进了会连带改写「35 个 operation」「5/6 个可见工具」「前端标签正则」三处既有断言；本工具不查业务数据，用不着执行器的档位复查与行数截断。
- 新增导出 `CATALOG_TOOL = "catalog_query"` 与联合类型 `AgentCallableToolName = AgentToolName | typeof CATALOG_TOOL`，放在 `tool-registry.ts`；`llm-provider.ts` 里调用与工具消息的 `tool` 字段改用它。
- 展开结果**不是事实**：不进 `facts`、不发 `source` 事件、不计入 `usage.tool_calls`，但计入 `attempted` 与 `model_steps`，并记 `tool_executed` 观测（`operation: "describe_module"`），好观察「按需」有没有被用成「每次」。
- 返回内容逐字取自规格：`{module,title,operations:[{operation,question_shape,input,output,boundary,accepts}]}`，不改写、不截断。
- 档位可见性由 `candidateOperations` 决定，不另写一份过滤。
- 模块名不在本档位可见集合时，本任务临时抛 422，`code` 用既有的 `AGENT_TOOL_ARGUMENT_INVALID`，消息写「未知模块」；专用错误码与可用列表由任务 5 整体替换，本任务不做。
- 系统指令里补一句使用说明：「需要某模块里各 operation 的适用问法与边界时，调用 `catalog_query`（`describe_module`）」；仍由 `buildSystemPrompt` 生成。

**Edges and seam**

- 改 `tool-registry.ts`（只加导出）、`llm-provider.ts`、`deepseek-llm-provider.ts`、`agent-orchestrator.ts`、`tools/tool-catalog.ts`（加 `describeModule(module, accessLevel)`）、`tools/system-prompt.ts`、`apps/web/lib/agent-tool-labels.ts`。**不改** `ToolExecutor`。
- Seam：编排器 `AgentOrchestrator.run`（`scriptedProvider` 脚本一轮 describe 调用）；提供方 `plan`（`MockLanguageModelV4` 看 `doGenerateCalls[0].tools`）。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-describe-module.test.cjs apps/api/test/unit/agent-deepseek-provider.test.cjs apps/api/test/unit/agent-orchestrator.test.cjs`
- `npm run typecheck --workspace=@dilee/api`；`npm run test:lib --workspace=@dilee/web`

**Unknowns**

- 提供方既有测试「输入 schema 提供 order_ref 句柄」遍历**全部**声明的工具，新工具会让它红。目录工具必须声明在工具集**末尾**，该测试改为只遍历领域工具；**不得**删掉对领域工具的任何断言。
- 流式回答阶段 `streamAnswer` 带 `toolChoice: none` 声明同一工具集；目录工具也必须在里面，否则历史里的 `catalog_query` 调用会成为未声明工具。若假模型上看不出这一点，停下报告，不要凭印象删。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1（`describeModule` 纯函数），红，再实现它。
3. 写用例 2（提供方声明工具），红，再改 `toolSetFor` 与 `plan()` 的过滤；修正既有 order_ref 测试的遍历范围。
4. 写用例 3、4（编排器），红，再接本地分支：绕过 `resolveRootCall`、发 `tool_status`、写 `tool` 消息、记观测。
5. 补前端两个标签：工具 `catalog_query` →「工具目录」，operation `describe_module` →「查看工具说明」。
6. 跑 Run 的全部命令，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `describeModule("procurement_query", "operational")` | `operations` 恰 5 个，名字依次与能力表采购模块一致（`get_purchase_plans`、`list_overdue_arrivals`、`get_purchase_orders`、`get_receipts`、`get_incoming_inspections`，来源：既有提供方测试的枚举断言）；每条五个字段齐全；`list_overdue_arrivals` 的 `accepts` 为 `["page"]` | `describeModule` |
| 2 | `plan([...], ["order_query","procurement_query"])` | 声明的工具里有 `catalog_query`，它在末尾；其 `module` 枚举恰为 `["order_query","procurement_query"]`；`operation` 枚举恰为 `["describe_module"]` | 提供方 `plan` |
| 3 | 脚本：第一轮调 `catalog_query/describe_module{module:"procurement_query"}`，第二轮无调用 | 第二轮 `messages` 里有一条 `tool` 消息，内容逐字等于 `describeModule("procurement_query", 档位)` 序列化；run 终态 `completed`；`usage.tool_calls` 为 0；没有 `source` 事件 | `AgentOrchestrator.run` |
| 4 | 同上，读事件流 | 有 `tool_status` 的 running 与 completed 各一条，`tool` 为 `catalog_query`；没有任何 `ORDER_SEARCH_REQUIRED` | 同上 |
| 5 | 前端 `toolOperationLabel("catalog_query","describe_module")` | 返回「查看工具说明」；既有「35 项都有标签」测试仍绿 | `agent-tool-labels.test.mjs` |

</task-brief>

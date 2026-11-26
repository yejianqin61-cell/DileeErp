<task-brief>

## 1. Where this task sits

- **阶段 3 缺口能被核对**，目标是缺口声明能被代码核对后记下。
- **本任务把 R-4、R-5 接进运行时**：编排器本地处理 `report_gap`，放行写内部事件，驳回回给模型。
- **Starts after**：任务 3、4。**Waits on it**：任务 6。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/agent-orchestrator.ts` — 调用循环里 `CATALOG_TOOL` 分支与 `describeCatalog`（本地处理的样板），`recoverableFailures`、`facts`。
- `apps/api/src/modules/business-query-agent/state-manager.ts` 与 `stream-transport.ts` — `AGENT_EVENT_TYPES`、`INTERNAL_EVENT_TYPES`。
- `apps/api/test/helpers/agent-fake-prisma.cjs` — 脚本化提供方与假库。
- `apps/web/lib/agent-tool-labels.ts` — 工具、operation 与错误码三张标签表。

**Settled**

- 流程：`tool_status` running → `parseGapDeclaration(call.args, run.question)` → `checkGap` → `tool_status` completed 或 failed（带 code）；记 `tool_executed` 观测。放行的 tool 消息为 `{"result":"已记录"}`，驳回为 `{"error":{code,message}}`（README）。
- 缺口调用计入 `attempted`，**不**计 `recoverableFailures`、不进 `facts`、不发 `source`、不写 `tool_args`、不计入 `usage.tool_calls`。
- 本轮执行记录只收**成功**的领域调用，行数口径见 README。
- 内部事件 `gap_declared`，payload 恰为 `nearest_operation, missing, missing_detail, needed_fields, unverified_fields`，填了时加 `missing_param`；不含问题原文。加进事件类型与内部事件集合，同步改 `agent-run-constraints.test.cjs` 的清单。同轮同键只写一次。

**Edges and seam**

- 改编排器、`state-manager.ts`、`stream-transport.ts`、前端标签（`report_gap`→「缺口声明」，`declare_gap`→「登记缺口」，四个错误码依次「缺口声明格式不对」「最近的工具名不存在」「现有工具支持这个条件」「查到 0 行，缺的是数据」）。不改 `ToolExecutor`，不改数据库结构。
- Seam：`AgentOrchestrator.run`。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-gap-orchestrator.test.cjs apps/api/test/unit/agent-orchestrator.test.cjs apps/api/test/unit/agent-run-constraints.test.cjs apps/api/test/unit/agent-stream-transport.test.cjs`
- `npm run typecheck`；`npm run test:lib --workspace=@dilee/web`

**Unknowns**

- 事件写入若因类型长度或数据库约束失败：停下报告（`type` 列是 `VARCHAR(20)`，`gap_declared` 在限内，本任务不写迁移）。
- 写 `gap_declared` 事件失败时是否放行：与 `persistRefs` 一致，吞掉写入错误，不拖垮问答。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1（放行），红，再接本地分支与内部事件。
3. 写用例 2（驳回不计预算），红，再补。
4. 写用例 3（执行记录），红，再收集行数。
5. 写用例 4、5（重复声明、浏览器收不到），红，再补；改约束测试清单。
6. 补前端标签并加一条标签测试，跑 Run 的全部命令，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 脚本：一轮调 `report_gap`（合法声明），次轮无调用 | 事件里恰一条 `gap_declared`，payload 键恰为 Settled 所列且不含问题原文；tool 消息逐字 `{"result":"已记录"}`；终态 `completed`；`usage.tool_calls` 为 0 | `run` |
| 2 | 脚本：同一批里 4 个最近邻为 `made_up` 的声明，次轮无调用 | 4 条 tool 消息都带 `AGENT_GAP_OPERATION_UNKNOWN`（没有在第 3 个处中断）；系统消息里没有「连续失败」；终态 `completed` | `run` |
| 3 | 执行器对 `list_low_stock_materials` 返回 `data:[]`；脚本先调它再声明同一最近邻 | 声明得 `AGENT_GAP_NO_DATA`；没有 `gap_declared` | `run` |
| 4 | 同一批里两个同 `(nearest_operation, missing)`、短语不同的合法声明 | `gap_declared` 恰一条；两条 tool 消息都是「已记录」 | `run` |
| 5 | `AGENT_EVENT_TYPES` 与流传输重放含 `gap_declared` 的事件列表 | 类型清单含它；推给浏览器的帧里没有它（按 `tool_args` 现有用例同法断言） | `StreamTransport` |

</task-brief>

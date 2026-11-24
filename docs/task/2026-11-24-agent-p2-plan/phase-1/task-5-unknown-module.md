<task-brief>

## 1. Where this task sits

- **阶段 1 模型能看见目录**，目标是 prompt 里有六段模块声明、模型能按需展开 operation 条目。
- **本任务交付 R-2 的错误契约**：模型传了不存在或看不见的模块名，得到可读错误，并被告知本档位有哪些模块可选；可回传，不终止本轮。
- **Starts after**：任务 4。**Waits on it**：任务 7。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/tools/tool-catalog.ts` — 任务 4 的 `describeModule`，本任务只改它的未知分支。
- `apps/api/src/modules/business-query-agent/agent-orchestrator.ts` — `RECOVERABLE_TOOL_ERROR_CODES`、`AGENT_MAX_RECOVERABLE_TOOL_FAILURES`、`rejectBeforeExecution`。
- `apps/api/src/modules/business-query-agent/tools/tool-registry.ts` — `capability()` 里 `UnprocessableEntityException` 的错误信封写法，照它。

**Settled**

- 错误码 `AGENT_CATALOG_MODULE_UNKNOWN`，HTTP 422，信封 `{code, message, details}`，与 `AGENT_TOOL_UNKNOWN` 同形。
- 消息列出**本档位可见**的模块名；`operational` 档请求 `finance_query` 与请求一个根本不存在的名字，**返回完全相同**的错误，且不出现 `finance_query`——不泄露财务模块存在。
- 该码进 `RECOVERABLE_TOOL_ERROR_CODES`，沿用现有失败预算，不新增预算。

**Edges and seam**

- 只改 `tool-catalog.ts` 与编排器里那一张码表；不动提供方（提供方的枚举已拦住大多数写错，这里是兜底）。
- Seam：`describeModule` 纯函数；编排器 `run` 用脚本化提供方传一个枚举外的 `module`。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-describe-module.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 任务 4 里临时用的未知模块处理（若有）要被本任务完整替换，不留两条路径。若找不到那段临时代码，停下报告。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1，红，再改 `describeModule` 的未知分支。
3. 写用例 2、3，红，再把码加进可回传集合。
4. 跑 Run 的两条命令，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `describeModule("no_such_module", "full")` | 抛 422，`code` 为 `AGENT_CATALOG_MODULE_UNKNOWN`，消息含全部六个模块名 | `describeModule` |
| 2 | `describeModule("finance_query", "operational")` 与 `describeModule("no_such_module", "operational")` | 两个错误的 `code` 与 `message` 完全相同；消息含五个模块名，**不含** `finance_query` | `describeModule` |
| 3 | 脚本：第一轮传 `module:"no_such_module"`，第二轮传合法模块 | run 终态 `completed`；第一条 `tool` 消息是错误信封 `{error:{code:"AGENT_CATALOG_MODULE_UNKNOWN",...}}`；第二轮正常展开 | `AgentOrchestrator.run` |
| 4 | 连续三次传非法模块（预算为 3，来源：`AGENT_MAX_RECOVERABLE_TOOL_FAILURES`） | run 仍以 `completed` 收尾（预算耗尽走部分回答，不是 `failed`） | `AgentOrchestrator.run` |

</task-brief>

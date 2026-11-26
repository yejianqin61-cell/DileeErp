<task-brief>

## 1. Where this task sits

- **阶段 3 缺口能被核对**，目标是缺口声明能被代码核对后记下。
- **本任务是本批的验收**：用脚本化提供方走通三种情形——真缺口放行、误报被驳回后改用工具、0 行判缺数据。
- **Starts after**：任务 5。**Waits on it**：阶段 4。

## 2. What the developer needs to know

**Read first**

- `docs/task/2026-11-24-agent-p2-plan/plan.md` R-5 — 验收条件原文。
- `apps/api/test/unit/agent-catalog-e2e.test.cjs` — 阶段 1 端到端的搭法，照此写。
- `apps/api/test/helpers/agent-fake-prisma.cjs` — `scriptedProvider` 记录每轮 `messages`。
- `apps/api/src/modules/business-query-agent/tools/tool-executor.ts` — 假执行器返回的 `QueryFact` 形状。

**Settled**

- 只新增测试；任一用例要改 `src` 才能过，停下报告是哪个任务漏了。
- 脚本提供方，不跑真模型、不连库（README「本批明确不做」）。
- 三种情形各一条用例，外加一条「驳回不把 run 打成失败」。

**Edges and seam**

- 新文件 `apps/api/test/unit/agent-gap-e2e.test.cjs`。
- Seam：`AgentOrchestrator.run` 与事件表。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-gap-e2e.test.cjs`
- `npm run typecheck`；`npm run test:unit`

**Unknowns**

- 脚本超过 `AGENT_MAX_PLAN_STEPS`（4 轮）时后续轮次不会执行：脚本控制在 4 轮内，超出就停下报告。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1（真缺口），跑。
3. 写用例 2（误报后改用工具），跑。
4. 写用例 3（缺数据），跑。
5. 写用例 4（连续驳回），跑。
6. 跑 `npm run typecheck` 与 `npm run test:unit`，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 问「各仓库库存多少」；脚本：展开 `warehouse_query` → 声明 `list_low_stock_materials/group_by` → 收尾 | 终态 `completed`；恰一条 `gap_declared`；执行器未被调用；没有 `source` 事件（来源：设计 §2.4 示例） | `run` |
| 2 | 问「列出已确认的订单」；脚本：声明 `list_documents/filter` 带 `missing_param:"status"` → 调 `list_documents{status:"confirmed"}` → 收尾 | 第二轮 messages 里有含 `AGENT_GAP_PARAM_SUPPORTED` 与 `"accepts"` 的 tool 消息；执行器恰调 1 次；无 `gap_declared`；终态 `completed` | `run` |
| 3 | 执行器返回空数组；脚本：调 `list_overdue_arrivals` → 声明同一最近邻 → 收尾 | 声明得 `AGENT_GAP_NO_DATA`；无 `gap_declared`；终态 `completed` | `run` |
| 4 | 脚本：连续三轮各一个格式错误的声明（缺 `missing`）→ 收尾 | 终态 `completed`；回答阶段的 messages 里没有「连续失败」系统消息；事件里有三条失败的 `tool_status`，code 为 `AGENT_GAP_ARGUMENT_INVALID` | `run` |

</task-brief>

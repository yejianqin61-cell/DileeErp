<task-brief>

## 1. Where this task sits

- **阶段 1 模型能看见目录**，目标是 prompt 里有六段模块声明、模型能按需展开 operation 条目。
- **本任务交付 R-1 的接线**：编排器构造系统指令时，把按档位渲染的 L1 目录接进去，替换现在那段「哪个入口答哪类问」的话。
- **Starts after**：任务 1。**Waits on it**：任务 7。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/agent-orchestrator.ts` — 第 27 行 `SYSTEM_PROMPT`，以及 `queryPhase` 里组装 `messages` 的位置（用 `run.accessLevel`）。
- `apps/api/src/modules/business-query-agent/tools/tool-catalog.ts` — 任务 1 的 `renderL1`。
- `apps/api/test/unit/agent-orchestrator.test.cjs` — `scriptedProvider` 与 `captured`：记录每轮 `messages` 的假提供方，本任务的测试座。
- `docs/review/agent-golden-p1-2026-11-23.md` §3 — P1 靠哪几句话把失败率降下来；这些行为约束不能丢。

**Settled**

- 现有系统指令里的三类内容**行为约束**必须留下，其余换成目录：
  ① 只依据本轮工具事实、引用数字说明来自哪张单据、查不到就明说、不得编造；
  ② 任何单号先 `search_documents` 检索，后续只用结果里的 `order_ref`，不复制改写单号；
  ③ 无单号、问列表或跨单汇总时的三个无根入口——这一句由 L1 的 `scope` 取代（任务 1 用例 6 已钉死 L1 含这三个入口名）。
- 新增 `buildSystemPrompt(accessLevel)`：固定前缀（①②）+ `renderL1(accessLevel)`。放在 `tool-catalog.ts` 旁边的新文件 `tools/system-prompt.ts`，编排器只调用它。
- 展开工具 `describe_module` 的使用说明**本任务不写**，任务 4 再加；这里不得提前提到它。

**Edges and seam**

- 改编排器里 `SYSTEM_PROMPT` 的使用点，新增 `tools/system-prompt.ts`；不改工具、提供方、历史上下文。
- Seam：编排器现有入口 `AgentOrchestrator.run`，用 `scriptedProvider` 读第一轮收到的 `messages[0]`。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-system-prompt.test.cjs apps/api/test/unit/agent-orchestrator.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 删掉第三句后黄金集会不会退步，本批**不验证**（它要真库和真模型，留给阶段 8）。不要为此恢复旧句子；若觉得任务 1 的 `scope` 写得承担不了这三个入口，停下报告，改 `scope` 而不是回填旧句子。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 在新测试文件里写用例 1，红。
3. 建 `tools/system-prompt.ts`，导出 `buildSystemPrompt`。
4. 编排器改用它，用 `run.accessLevel` 取档位。
5. 转绿用例 2 至 4。
6. 跑 Run 的两条命令（既有编排器测试必须仍绿）。
7. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `full` 档 run，读第一轮 `messages[0]` | `role` 为 `system`，内容含六个模块标题 | `AgentOrchestrator.run` |
| 2 | `operational` 档 run | 内容不含 `finance_query`，含其余五个模块标题 | 同上 |
| 3 | 任一档位 | 内容含 `order_ref` 与 `search_documents`（来源：既有系统指令的第二条约束），且含 `不得编造`（来源：既有系统指令） | 同上 |
| 4 | 任一档位 | 内容含 `list_documents`、`list_low_stock_materials`、`list_overdue_arrivals`；不含 `describe_module` | 同上 |
| 5 | 用 `buildCatalog` 传入多一条带规格的 capability 得到 `catalog`，再 `renderL1("full", catalog)` | 对应模块的 operation 数加一，其余文案不变 | `renderL1` |

</task-brief>

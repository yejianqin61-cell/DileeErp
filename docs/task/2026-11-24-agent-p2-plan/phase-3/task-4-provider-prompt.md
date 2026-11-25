<task-brief>

## 1. Where this task sits

- **阶段 3 缺口能被核对**，目标是缺口声明能被代码核对后记下。
- **本任务交付 R-4 的模型侧声明**：模型看得到 `report_gap` 的工具声明与何时该用它。
- **Starts after**：任务 1。**Waits on it**：任务 5。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/deepseek-llm-provider.ts` — `catalogInputSchema`、`toolSetFor`、`plan()` 里丢弃无 `operation` 调用的那段。
- `apps/api/src/modules/business-query-agent/tools/system-prompt.ts` — 现有拼法。
- `scripts/agent/gap-experiment/groups.mjs` — `GAP_HINT`、`NEAREST_HINT`、`GAP_RULE` 的原文（实验验证过的措辞），以及它为何依赖 `buildSystemPrompt`。
- `apps/api/test/unit/agent-deepseek-provider.test.cjs` — 第 45 行与第 160 行附近两处会受新工具影响的断言。

**Settled**

- 声明里**没有 `operation` 参数**；`plan()` 遇到 `report_gap` 时把 operation 固定为 `declare_gap`，参数原样进 `args`。工具顺序：领域工具、`report_gap`、`catalog_query`（目录工具仍在最后）。
- 参数：`nearest_operation` 枚举为所传领域工具的 operation 名；`missing`、`missing_param` 用任务 1 导出的枚举；`needed_fields` 字符串数组。必填三项（README）。
- 描述 = `GAP_RULE` + 「从现有 operation 里选最接近用户问题的一个，并说明它差什么。」+「只在缺某个筛选参数时填 missing_param。needed_fields 用 `<Prisma 模型>.<字段>` 格式，例如 SalesOrder.orderNo；不确定就不填。」。系统指令 = 现有内容 + 空行 + `GAP_HINT` + 空行 + `NEAREST_HINT`。
- `system-prompt.ts` 另导出 `buildBaseSystemPrompt`（即现有内容，不含两段提示）；`groups.mjs` 改用它，实验的提示保持不变。

**Edges and seam**

- 改提供方、`system-prompt.ts`、`groups.mjs` 与 `groups.test.mjs` 的导入。不改编排器。
- Seam：提供方 `plan`（`MockLanguageModelV4`）与 `buildSystemPrompt`。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-gap-provider.test.cjs apps/api/test/unit/agent-deepseek-provider.test.cjs apps/api/test/unit/agent-system-prompt.test.cjs apps/api/test/unit/agent-tool-describe-module.test.cjs`
- `npm run test:agent-gap:unit`；`npm run typecheck --workspace=@dilee/api`

**Unknowns**

- 既有断言需要改的预期只有两处：order_ref 遍历要同时排除 `report_gap`；声明工具名列表变为 `order_query, production_query, report_gap, catalog_query`。有第三处变红就停下报告。

## 3. The workflow

1. 读 part 2，用一句话复述本任务。
2. 写用例 1、2（声明形状），红，再加声明；按 Unknowns 改两处既有断言。
3. 写用例 3（`plan` 解析），红，再放行 `report_gap`。
4. 写用例 4（系统指令），红，再拆出 `buildBaseSystemPrompt`。
5. 改 `groups.mjs` 导入，跑实验测试确认仍绿。
6. 跑 Run 的全部命令，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | `plan([...], ["order_query","procurement_query"])` | 工具名依次 `order_query, procurement_query, report_gap, catalog_query`；`report_gap` 的 `required` 恰为三项，`properties` 里没有 `operation` | `plan` |
| 2 | 同上 | `nearest_operation` 枚举含 `list_overdue_arrivals`、长度 13（订单 8 + 采购 5，来源：既有提供方测试的两条枚举断言）、不含 `get_receivables`；描述含「查到 0 行，都不是缺口」与「SalesOrder.orderNo」 | `plan` |
| 3 | 假模型返回 `report_gap` 调用，输入含三个必填项 | `toolCalls` 一项：`tool:"report_gap"`，`operation:"declare_gap"`，`args` 等于输入 | `plan` |
| 4 | `buildSystemPrompt("full")` 与 `buildBaseSystemPrompt("full")` | 前者以后者开头，且含「调用 report_gap 说明缺口」与「先在上面的模块里找最接近用户问题的 operation」；后者两句都不含 | `buildSystemPrompt` |

</task-brief>

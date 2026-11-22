<task-brief>

## 1. Where this task sits

- **Phase P0 尺子**，目标是让「查询工具失败率高」变成可读的数字。
- **本任务交付 R-3 判定器**：把用例的期望与一次 `CaseOutcome` 比出 `pass / fail / baseline_missing`。
- **Starts after**：任务 1。**Waits on it**：任务 4（报告）、任务 7（基线报告）。

## 2. What the developer needs to know

**Read first**

- `docs/review/agent-tool-invocation-audit-2026-10-27.md` — D-1…D-6 是这批用例要钉住的历史缺陷，失败码名以此为准。
- `apps/api/src/modules/business-query-agent/stream-transport.ts` — 终态类型 `completed/error/cancelled` 与 `ACCESS_REVOKED`。
- `apps/api/src/modules/business-query-agent/tools/tool-registry.ts` — operation 真名清单。

**Settled**

- 判定是纯函数：无 IO、无时钟、无随机。
- 期望值只能来自**独立来源**：数据基线里的单号、事件协议里的类型名。绝不能用「跑一次看结果」反推期望。
- `answerExclude` 只用否定式（答案里不得出现某串），不用 `answerInclude`：正向文本断言会跟模型措辞一起漂。
- 前置检查缺失的基线单号 → `baseline_missing`，**不算 fail**，否则缺点数据会被读成工具坏了。

**Edges and seam**

- 只新增 `scripts/agent/golden-judge.mjs`。

**Run**

- `node --test scripts/agent/golden-judge.test.mjs`

**Unknowns**

- 一条用例同时踩两个原因（如终态 fail 又缺来源）时，`reasons` 要全部列出，不要只报第一个。若发现某条期望无法从 `CaseOutcome` 判出，停下来报告。

## 3. The workflow

1. 读三个文件，一句话复述本任务。
2. 写 `judge({ caseDef, outcome, missingBaseline })`，返回 `{ id, verdict, reasons[] }`。
3. 先写失败测试（终态不符 → fail 且 reason 含期望值与实际值），再实现。
4. 依次实现六类期望：`terminal`、`sourcesInclude`、`sourcesExcludeTypes`、`opsInclude`、`failureCodesExclude`、`maxToolCalls`、`answerExclude`。
5. 补 `missingBaseline` 非空 → `baseline_missing` 且 reason 列出缺的单号。
6. 跑测试，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 期望 `completed`，实际 `failed` | `fail`，reason 含 `completed` 与 `failed` | `judge()` |
| 2 | 期望来源含 `MOCK-ORD-001`，实际来源为空 | `fail` | `judge()` |
| 3 | 期望来源排除 `finance`，实际含一条 `finance` | `fail` | `judge()` |
| 4 | 期望 ops 含 `search_documents`，实际未调用 | `fail` | `judge()` |
| 5 | 期望禁用 `ORDER_NOT_FOUND`，实际出现 | `fail` | `judge()` |
| 6 | `maxToolCalls=6`，实际 7 | `fail` | `judge()` |
| 7 | `answerExclude=["逾期"]`，答案含「逾期」 | `fail` | `judge()` |
| 8 | `missingBaseline=["MOCK-ORD-002"]` | `baseline_missing`，reason 含该单号 | `judge()` |
| 9 | 全部期望满足 | `pass`，`reasons` 为空 | `judge()` |

</task-brief>
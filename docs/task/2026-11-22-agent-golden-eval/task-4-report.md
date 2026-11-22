<task-brief>

## 1. Where this task sits

- **Phase P0 尺子**，目标是让「查询工具失败率高」变成可读的数字。
- **本任务交付 R-4 报告生成**：把一堆判定结果压成一张能贴进 `docs/review` 的表。
- **Starts after**：任务 3。**Waits on it**：任务 7。

## 2. What the developer needs to know

**Read first**

- `docs/review/agent-tool-invocation-audit-2026-10-27.md` — 报告要长得像它的 §1、§2：表格优先，结论在前。
- `scripts/verify-quality.mjs` — 本仓命令行输出的既有风格。
- `docs/task/2026-11-22-agent-golden-eval/README.md` — 报告必须回答的四个数。

**Settled**

- 报告分两层：`summarize()` 出结构体，`renderMarkdown()` 出文本。两层都纯函数。
- 通过率的分母是 `total - baselineMissing`：缺数据不该拉低通过率，但要单独计数。
- 失败码分布按出现次数排序，同次数按码名字典序 —— 输出必须确定，否则两次跑出两份 diff。
- 软观测（答案全文、耗时）只放在附录，不参与任何比值。

**Edges and seam**

- 只新增 `scripts/agent/golden-report.mjs`。

**Run**

- `node --test scripts/agent/golden-report.test.mjs`

**Unknowns**

- 一组用例全为 `baseline_missing` 时，该组通过率是 `null` 还是 0？按 `null` 并在表格里写 `—`；若这会让调用方难受，停下来报告。

## 3. The workflow

1. 读三个文件，一句话复述本任务。
2. 写 `summarize(results)`：`{ total, pass, fail, baselineMissing, passRate, byGroup[], failureCodes[] }`。
3. 先写失败测试（3 pass / 1 fail / 1 missing → `passRate=0.75`），再实现。
4. 实现 `renderMarkdown(summary, meta)`：标题、四个总数、分组表、失败码表、未通过清单。
5. `meta` 至少含：运行时间、API 地址、模型名、数据基线说明、用例总数。
6. 补一条「同一输入两次渲染逐字相同」的测试。
7. 跑测试，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 3 pass、1 fail、1 baseline_missing | `passRate` = `0.75`，`baselineMissing` = 1 | `summarize()` |
| 2 | 某组 2 pass 0 fail | 该组 `passRate` = `1` | `summarize()` |
| 3 | 某组 0 pass 0 fail 2 missing | 该组 `passRate` = `null` | `summarize()` |
| 4 | 失败码 `ORDER_NOT_FOUND`×2、`AGENT_TOOL_UNKNOWN`×3 | 列表首项是后者 | `summarize()` |
| 5 | 同上输入渲染两次 | 两个字符串逐字相同 | `renderMarkdown()` |
| 6 | 含 1 条 fail | 文本里出现该用例 id 与 reason | `renderMarkdown()` |

</task-brief>
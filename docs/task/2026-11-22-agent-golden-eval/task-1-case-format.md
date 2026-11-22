<task-brief>

## 1. Where this task sits

- **Phase P0 尺子**，目标是让「查询工具失败率高」变成可读的数字。
- **本任务交付 R-1 用例集格式与装载器**：一个用例文件是什么、坏用例怎么被拒绝。
- **Starts after**：无。**Waits on it**：运行器、判定器、两组用例内容。

## 2. What the developer needs to know

**Read first**

- `apps/api/src/modules/business-query-agent/stream-transport.ts` — 事件信封的字段名与终态类型，判定器只认这些。
- `apps/api/src/modules/business-query-agent/agent-orchestrator.ts` — 失败码从哪来（`HttpException` 的 `code`）。
- `apps/api/src/modules/business-query-agent/tools/tool-registry.ts` — 31 个 operation 名，用例里写 `opsInclude` 要用真名。
- `scripts/agent-run-replay.mjs` — 本仓脚本的既有风格：纯函数导出 + `main()` 里读 argv。

**Settled**

- 用例是 JSON，不是 JSONC：仓库禁止注释，JSON 天然满足。
- 判定分两类：**硬断言**来自事件协议与数据基线；**软观测**（答案全文）只进报告，不判成败。
- 用例可以是一轮（`question`）或多轮（`turns`），两者互斥。

**Edges and seam**

- 只新增 `scripts/agent/golden-cases.mjs`，不动 `apps/api/src`。
- Seam：导出的纯函数 `parseCase` / `loadCases`，单测直接调它。

**Run**

- `node --test scripts/agent/golden-cases.test.mjs`
- `npm run typecheck --workspace=@dilee/api`（本任务不碰 TS，但仍要跑，证明没波及）

**Unknowns**

- `turns` 与 `question` 同时出现算不算坏用例？按「拒绝并报错」处理，不要静默取一个。若实现中发现现有前端或测试依赖别的形状，停下来报告。

## 3. The workflow

1. 读上面四个文件，用一句话复述本任务。
2. 写 `parseCase`：白名单校验 `id/group/question/turns/baselineDocs/expect`，越界字段抛错，产出规范化用例对象。
3. 先写失败测试（用例：缺 `id`、未知 `group`、`question` 与 `turns` 同时给、`expect` 出现未知键），再实现。
4. 写 `loadCases(dir)`：读目录下全部 `*.json`，逐个 `parseCase`，id 重复即报错。
5. 补一条「合法用例原样通过」的测试，含多轮形状。
6. 跑测试与 typecheck，提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 合法单轮用例 | 返回对象含 `id/group/question/expect`，无 `turns` | `parseCase()` |
| 2 | 合法多轮用例（3 轮） | `turns` 长度为 3 | `parseCase()` |
| 3 | 缺 `id` | 抛错，消息含 `id` | `parseCase()` |
| 4 | `group` 为 `bogus` | 抛错，消息列出允许的组 | `parseCase()` |
| 5 | `question` 与 `turns` 同时给 | 抛错 | `parseCase()` |
| 6 | `expect` 里出现 `fooBar` | 抛错，消息含 `fooBar` | `parseCase()` |
| 7 | 两个文件同 `id` | `loadCases()` 抛错，消息含该 id | `loadCases()` |

</task-brief>
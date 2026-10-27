## 1. Where this task sits

- **阶段 4 查不到也说得清楚**，目标是工具连续失败时用户拿到解释，而不是一个错误气泡。
- **本任务推进 R-6 部分答案**：失败预算耗尽不再终结整轮，改成带解释的回答。
- **Starts after**：任务 7 空结果把检索词与命中数写进回答上下文。**Waits on it**：任务 9 回归。

## 2. What the developer needs to know

**Read first**

- `agent-orchestrator.ts` 的失败预算分支 — 现在直接抛 `AGENT_TOOL_RETRIES_EXHAUSTED`。
- `agent-orchestrator.test.cjs:397-417` — 现有两条断言整轮失败，语义要改。
- `agent-orchestrator.ts` 的 `failRun` — 终态收口，改动后不再走这条。

**Settled**

- 失败预算耗尽时停止工具循环，转入回答阶段，run 以 `completed` 收尾。
- 回答上下文必须带最后一次错误码与错误说明。
- 已经取得的事实全部保留，不得丢弃。

**Edges and seam**

- 只碰编排器的循环收口与回答前处理。
- Seam：`agent-orchestrator.test.cjs` 现有编排器入口。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-orchestrator.test.cjs`

**Unknowns**

- 失败超预算算「完成」还是「降级」是产品口径。默认完成并在上下文里说明原因；若要求前端区分，停下来问。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 改写那两条现有用例，跑红。
3. 把抛错改成打标 + 跳出循环 + 注入错误上下文。
4. 用例 2 到 4 补齐并转绿。
5. 跑测试与 typecheck。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 连续三次工具失败 | run 终态 `completed`，不再是 failed | 编排器 |
| 2 | 同一场景 | 模型收到最后错误码 | 捕获式 provider |
| 3 | 先成功一次再连续失败 | 已取得的来源仍进最终回答 | 状态事件 |
| 4 | 撤权导致的失败 | 仍然直接 failed，不降级 | 编排器 |

## 1. Where this task sits

- **阶段 4 查不到也说得清楚**，目标是空结果时用户知道「按什么查、查到几条」。
- **本任务推进 R-6 部分答案**：把检索词与命中数写进回答上下文。
- **Starts after**：任务 6 检索词与单号归一后再匹配。**Waits on it**：任务 8 降级答案。

## 2. What the developer needs to know

**Read first**

- `agent-orchestrator.ts` 回答阶段 — `streamAnswer` 前构造消息的那一段。
- `agent-orchestrator.ts` 的 `registerSearchResults` — 事实里的 `data` 是行数组，空结果就是空数组。
- `agent-deepseek-provider.test.cjs` 的捕获式 provider — 可用同样方式断言模型收到的消息。

**Settled**

- 只在「本轮检索过、但一条事实都没取到」时追加一条提示，不改正常路径。
- 提示里带检索词与 0 条，要求回答点名检索词，不得编造业务结论。
- 提示是系统侧的，不写进用户的问题。

**Edges and seam**

- 只碰编排器的回答前处理，不碰 provider。
- Seam：`agent-orchestrator.test.cjs` 现有编排器入口。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-orchestrator.test.cjs`

**Unknowns**

- 提示放 system 还是 user 角色会影响模型行为。默认 system，若测试发现 DeepSeek 忽略它，停下来问。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 先写用例 1，跑红。
3. 实现空结果时的上下文追加。
4. 用例 2 到 4 红后转绿。
5. 跑测试与 typecheck。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 检索返回空 | 模型最后收到的消息含检索词 | 捕获式 provider |
| 2 | 检索返回空 | 提示写明 0 条 | 捕获式 provider |
| 3 | 检索有结果 | 不追加任何提示 | 捕获式 provider |
| 4 | 没有调用检索 | 不追加提示 | 捕获式 provider |

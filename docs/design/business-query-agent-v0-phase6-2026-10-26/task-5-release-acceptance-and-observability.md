## 1. Where this task sits

- **Phase 6 发布验收与回退演练**：权限、并发、SSE、提示注入与观测满足发布门槛。
- **本任务推进 R-11 可观测性与成本**：保留可审计的用量和时延基线。
- **开始于** Task 3、Task 4。**后续等待它**：回退演练。

## 2. What the developer needs to know

**Read first**

- `agent-observability.test.cjs` — 日志脱敏与关联字段。
- `business-query-concurrency.test.cjs` — 许可边界。
- `business-query-recovery.spec.mjs` — 浏览器恢复边界。
- `agent-model-errors.test.cjs` — 模型异常的稳定码。

**Settled**

- 日志不记录问题全文、原始事实或模型上下文。
- 用量、模型、run ID 和耗时可记录为发布基线。

**Edges and seam**

- 触及现有验收套件和发布记录。保留业务查询实现。

**Run**

- `npm run test:unit:api`
- 预发布 HTTP 与浏览器验收集。

**Unknowns**

- 没有预发布日志访问权时，停止在本地回归结果，不编造模型用量。

## 3. The workflow

1. 阅读第 2 部分并复述：可观测不泄露业务正文。
2. 运行本地权限、并发、模型错误和恢复套件。
3. 在预发布运行同一验收集。
4. 收集 run ID、模型、耗时、用量和错误码。
5. 检查日志不含敏感正文。
6. 提交验收记录。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 五用户并发 | 最多四条 run | gate |
| 2 | 注入式问题 | 无写入能力 | registry |
| 3 | 模型超时 | 稳定错误码 | orchestrator |
| 4 | 结构化日志 | 无业务正文 | observability |

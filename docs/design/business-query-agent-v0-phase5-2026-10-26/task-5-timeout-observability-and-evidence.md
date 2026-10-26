## 1. Where this task sits

- **Phase 5 用户恢复体验与异常闭环**：超时、结果保护和日志不泄露业务内容。
- **本任务推进 R-8 小规模并发控制、R-11 可观测性与成本**：完成本阶段证据。
- **开始于** T1–T4。**后续等待它**：Phase 6 发布验收。

## 2. What the developer needs to know

**Read first**

- `agent-orchestrator.ts` — 超时、失败映射、工具步骤和 usage 记录。
- `tools/tool-executor.ts` — 行数与字节截断规则。
- `observability.ts` — 允许记录的结构化字段。
- `agent-observability.test.cjs` — 日志不得包含业务文本的期望。
- `agent-concurrency-gate.test.cjs` — 许可释放和忙碌反馈。

**Settled**

- 输入不设应用层 token 配额；运行时间和结果字节受限。
- 日志不含问题、答案、工具参数或结果正文。
- 失败、取消和超时都释放许可并落稳定错误码。

**Edges and seam**

- 触及编排、观测、结果限制与证据测试；不引入监控平台。
- 缝是 `AgentOrchestrator.run()`。

**Run**

- `node --test apps/api/test/unit/agent-observability.test.cjs apps/api/test/unit/agent-concurrency-gate.test.cjs`。
- `npm run typecheck --workspace=@dilee/api`。

**Unknowns**

- 若真实浏览器流程需要外部模型密钥，保留为 Phase 6 预发布证据。

## 3. The workflow

1. 阅读第 2 部分并复述：限制运行与结果，但不记录业务正文。
2. 为超时、截断和脱敏记录写失败用例。
3. 修复最小失败路径，并检查许可 finally。
4. 汇总刷新、断线、取消、429、409、撤权证据。
5. 回归 API 相关测试与 typecheck。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 超时 provider | failed/AGENT_RUN_TIMEOUT | `run()` |
| 2 | 大结果数组 | 按能力行数和字节裁剪 | `truncateData()` |
| 3 | 含业务文本的记录 | 日志字段不含正文 | observability |
| 4 | 第五个用户 | 429 且不建队列 | concurrency gate |
| 5 | 取消或失败 | 许可归还 | controller finally |

## 1. Where this task sits

- **Phase 5 用户恢复体验与异常闭环**：页面能解释忙碌、失败、断线与取消。
- **本任务推进 R-10 查询页状态机**：收口 reducer、重试和草稿保留。
- **开始于** T1/T2 的服务端事件契约。**后续等待它**：可访问性检查。

## 2. What the developer needs to know

**Read first**

- `business-query-state.ts` — 合法 phase、事件去重和终态锁。
- `business-query-stream.ts` — 断线重试与 401/403 映射。
- `app/business-query/page.tsx` — 提交、取消、提示和草稿的用户缝。
- `business-query-state.test.mjs` — reducer 的独立行为期望。
- `business-query-contract.test.cjs` — 429/409 的服务端错误码。

**Settled**

- 429、409 与流错误不能丢失用户问题。
- 终态不可被迟到事件改写；撤权清空财务片段。
- 重试仅重连 SSE，不自动重复 POST。

**Edges and seam**

- 触及 reducer、页面和流读取器；不改变 API 错误信封。
- 缝是 `reduce()` 和 `followRunStream()`。

**Run**

- `npm run test:lib --workspace=@dilee/web`。
- `npm run typecheck --workspace=@dilee/web`。

**Unknowns**

- 若页面缺少可重试的流入口，停止并说明最小交互决定。

## 3. The workflow

1. 阅读第 2 部分并复述：错误时保留问题，只重连流。
2. 为 429、409、断线、取消和撤权写失败用例。
3. 修复 reducer 的合法迁移或页面的草稿回填。
4. 检查终态和 seq 去重。
5. 回归 web 库测试与 typecheck。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 429 提交失败 | 输入问题恢复 | 页面 submit |
| 2 | 409 提交失败 | 输入问题恢复 | 页面 submit |
| 3 | 流断开 | 进入 disconnected 后续接 | `reduce()` |
| 4 | cancelled 事件 | 显示 cancelled | `reduce()` |
| 5 | ACCESS_REVOKED | 清空答案与来源 | `reduce()` |

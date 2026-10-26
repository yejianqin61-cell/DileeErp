## 1. Where this task sits

- **Phase 5 用户恢复体验与异常闭环**：刷新后恢复同一轮回答，不重复查询。
- **本任务推进 R-7 持久状态与幂等、R-9 JSON 与 SSE 协议**：核对快照、序号和续接。
- **开始于** Phase 4 的权限收口。**后续等待它**：页面恢复与浏览器流程。

## 2. What the developer needs to know

**Read first**

- `business-query-agent.controller.ts` — 快照的可见 run、答案和 latest_seq 从何而来。
- `state-manager.ts` — 事件序号与状态迁移如何同事务落库。
- `business-query-stream.ts` — 浏览器怎样携带 Last-Event-ID 续接。
- `business-query-state.ts` — 快照先于增量进入 reducer 的规则。
- `business-query-contract.test.cjs` — HTTP/SSE 契约已有的独立期望。

**Settled**

- 刷新先读服务端快照，再从 latest_seq 续接；不得再次 POST。
- 同一 client_message_id 只返回既有 run，不再次调用模型。
- 降权后的 full run 不进入快照。

**Edges and seam**

- 触及快照控制器、流读取器和 reducer；不改 Agent 表结构。
- 缝是 `sessionSnapshot()` 与 `followRunStream()`。

**Run**

- `node --test apps/api/test/http/business-query-contract.test.cjs`。
- `npm run test:lib --workspace=@dilee/web`，再运行 API typecheck。

**Unknowns**

- 若快照无法给出连续 seq，停止并说明迁移缺口。

## 3. The workflow

1. 阅读第 2 部分并复述：刷新从快照恢复，再续接同一 run。
2. 为快照与 after_seq 写失败用例。
3. 核对同键 POST 不会重启编排。
4. 修复快照或续接的最小路径。
5. 回归 HTTP、reducer 和 typecheck。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 回答中刷新 | 快照含已有答案与 latest_seq | `sessionSnapshot()` |
| 2 | latest_seq 后续接 | 只收到新增事件 | `followRunStream()` |
| 3 | 重复幂等键 | 返回原 run | `createRun()` |
| 4 | 降权 full run | 快照不含该 run | `sessionSnapshot()` |

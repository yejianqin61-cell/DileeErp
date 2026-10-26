## 1. Where this task sits

- **Phase 5 用户恢复体验与异常闭环**：断线、取消和重放都有稳定终态。
- **本任务推进 R-7 持久状态与幂等、R-9 JSON 与 SSE 协议**：收口 transport 行为。
- **开始于** T1 快照序号。**后续等待它**：页面错误与重试呈现。

## 2. What the developer needs to know

**Read first**

- `stream-transport.ts` — 重放、轮询、心跳与权限检查的发送顺序。
- `state-manager.ts` — cancelled 与终态事件的原子写入。
- `business-query-agent.controller.ts` — cancel 如何中断本进程编排。
- `agent-state-manager.test.cjs` — 终态不可离开的独立期望。
- `business-query-stream.ts` — 浏览器如何识别终态和拒绝。

**Settled**

- 重连只读事件，不能重复工具调用。
- cancel 后迟到结果不能写入 run；终态事件关闭连接。
- 心跳不入事件表，不影响 seq。

**Edges and seam**

- 触及 transport、取消与事件测试；不增加队列或消息总线。
- 缝是 `StreamTransport.follow()`。

**Run**

- `node --test apps/api/test/unit/agent-state-manager.test.cjs apps/api/test/unit/agent-finance-access.test.cjs`。
- `npm run typecheck --workspace=@dilee/api`。

**Unknowns**

- 若轮询和重放之间不能以 seq 连续读取，停止并说明缺口。

## 3. The workflow

1. 阅读第 2 部分并复述：SSE 只重放，不重做查询。
2. 为心跳、末端事件和取消竞争写失败用例。
3. 检查 transport 先验权再取事件。
4. 修复最小顺序或终态处理。
5. 回归状态和流测试。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | Last-Event-ID=3 | 只发送 seq 大于 3 的事件 | `follow()` |
| 2 | cancelled run | 发送 cancelled 后关闭 | `follow()` |
| 3 | 心跳周期 | 写 SSE 注释，不写状态事件 | `follow()` |
| 4 | cancel 与增量竞争 | 增量不能越过 cancelled | `transitionAndAppend()` |

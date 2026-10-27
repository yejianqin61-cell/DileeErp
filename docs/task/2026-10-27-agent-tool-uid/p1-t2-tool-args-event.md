## 1. Where this task sits

- **阶段 1 先能看清线上发生了什么**，目标是能说出模型每个工具传了什么。
- **本任务推进 R-5 工具入参以脱敏摘要落库**：把入参写进事件表，不写进观测日志。
- **Starts after**：无。**Waits on it**：任务 3 内部事件不进 SSE、任务 4 回放入口。

## 2. What the developer needs to know

**Read first**

- `agent-orchestrator.ts:241-266` — `executeTool` 现在写哪些事件、哪些观测。
- `state-manager.ts:17-19` — 事件类型白名单常量。
- `agent-orchestrator.test.cjs:15-43` — 内存假 Prisma 的 `createMany` 形状。

**Settled**

- 参数只进事件表，观测日志继续保持不含业务值。
- 只记 `order_no`、`q`、`page`、`order_ref` 四个键，单值截断 100 字符。
- 新事件类型是内部事件，前端契约不改。

**Edges and seam**

- 触碰编排器与事件类型常量，不碰执行器与 provider。
- Seam：`agent-orchestrator.test.cjs` 现有编排器入口。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-orchestrator.test.cjs`

**Unknowns**

- 每次调用多写一行事件，轮询成本略升。若与状态迁移抢同一个事务导致 seq 冲突，停下来问。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 先写用例 1：一次 `search_orders` 之后事件表里出现入参摘要。
3. 在事件白名单加类型，并在执行前写入摘要。
4. 用例 2 到 4 红后转绿：根查询单号、超长截断、未知键不落。
5. 跑该测试文件与 typecheck。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | plan 返回一次 `search_orders`，`q="SO"` | 事件里 `args.q` 为 `SO` | 编排器 |
| 2 | 根查询带 `order_no="SO-001"` | 事件里 `args.order_no` 原样 | 编排器 |
| 3 | `q` 为 150 字符 | 落库值长度 100 | 编排器 |
| 4 | 调用里带 `filters` 键 | 事件里没有 `filters` | 编排器 |

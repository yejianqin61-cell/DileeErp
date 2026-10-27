## 1. Where this task sits

- **阶段 1 先能看清线上发生了什么**，目标是参数可取证但不扩大暴露面。
- **本任务推进 R-5 工具入参以脱敏摘要落库**：内部事件只进数据库，不进浏览器。
- **Starts after**：任务 2 工具入参写进事件表。**Waits on it**：任务 4 回放入口。

## 2. What the developer needs to know

**Read first**

- `stream-transport.ts:38-64` — 重放与轮询两个发送点。
- `stream-transport.ts:82-85` — 单条事件的写出格式。
- `agent-orchestrator.ts:241-266` — 内部事件在哪个状态段写入。

**Settled**

- 内部事件既不重放也不轮询发送，其它事件行为不变。
- 浏览器拿不到入参；前端契约零改动。
- 终态事件的关闭逻辑不受影响。

**Edges and seam**

- 只碰传输层与其测试，不碰编排器与状态机。
- Seam：新建 `agent-stream-transport.test.cjs`。计划没给这个接缝，因为原计划没有这条任务；
  传输层此前没有单元接缝，只有 HTTP 契约测试，这里补最低的一层。

**Run**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-stream-transport.test.cjs`

**Unknowns**

- 若发现传输层已有可复用的假 Response 夹具，改用它，不要再造一个。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 建传输层测试文件与最小假 Response，先写用例 1 为红。
3. 在重放与轮询两处加内部事件跳过。
4. 用例 2 到 4 红后转绿。
5. 跑测试与 typecheck。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 重放里含一条内部事件 | 输出不含该事件 | `follow()` |
| 2 | 轮询到一条内部事件 | 输出不含该事件 | `follow()` |
| 3 | 重放里含 `tool_status` | 该事件照常输出 | `follow()` |
| 4 | 重放里含 `completed` | 发完即关闭 | `follow()` |

## 1. Where this task sits

- **阶段 1 先能看清线上发生了什么**，目标是一次真实提问之后能还原每个工具入参。
- **本任务推进 R-5 工具入参以脱敏摘要落库**：给一个不用连生产库也能跑的回放入口。
- **Starts after**：任务 2 工具入参写进事件表。**Waits on it**：无。

## 2. What the developer needs to know

**Read first**

- `scripts/verify-agent-database-privileges.mjs` — 仓库现有只读诊断脚本的写法与退出码约定。
- `agent-orchestrator.ts:241-266` — 入参事件在哪一步写入、payload 长什么样。
- `state-manager.ts` 的 `eventsAfter` — 事件按 seq 升序取出的形状。

**Settled**

- 脚本只读：只 SELECT 事件，不写库、不改 run 状态。
- 入口是一个 run id；不给 id 时列出最近 5 个 run 供选。
- 输出按 seq 升序，一次工具调用一行。

**Edges and seam**

- 新增一个脚本目录下的文件与它的测试，不碰应用代码。
- Seam：脚本内导出的纯函数 `summarizeRunEvents`，由同目录测试调用。

**Run**

- `node --test scripts/agent-run-replay.test.mjs`

**Unknowns**

- 若事件表里还没有任务 2 的新类型，脚本要能降级显示「该 run 没有入参记录」而不是报错。

## 3. The workflow

1. 读三处，用一句话复述本任务。
2. 先写用例 1，跑红。
3. 在 `scripts/` 新建回放脚本，导出纯函数并接上只读查询。
4. 用例 2 到 4 红后转绿。
5. 把新测试登记进根 `package.json` 的 `test:deploy`。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 两条事件：入参摘要与工具完成 | 输出两行，按 seq 升序 | `summarizeRunEvents` |
| 2 | 只有工具完成事件 | 降级为「没有入参记录」 | `summarizeRunEvents` |
| 3 | 入参里有 `q` 与 `order_no` | 两者都打印，单行不换行 | `summarizeRunEvents` |
| 4 | 事件 payload 缺字段 | 打印占位符，不抛错 | `summarizeRunEvents` |

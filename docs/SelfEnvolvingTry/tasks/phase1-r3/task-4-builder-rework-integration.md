# 任务 4：验证原 Builder 返工闭环

## 1. 任务位置

- 属于阶段一 `R-3 失败返工可追溯`，目标是用一次故意失败的纵切证明返工闭环。
- 本任务让 Validator 拒绝 `h1`，母 Agent 续接原 Builder 产生 `h2`，再验证 `h2`。
- 开始条件是门禁、Activation trace 和 `session/wait` 已完成；R-4 强制动作预算等待本任务之后。

## 2. 开发者须知

**先读**

- `tmp/deepseek-harness/packages/subagent/tool-subagent-control/src/index.ts` — `send_message` 如何授权直接子会话。
- `tmp/deepseek-harness/packages/subagent/subagent/tests/continuation.spec.ts` — 同一子 Session 的冷恢复证据是什么。
- `apps/coding-worker/test/scripted-llm-plugin.mjs` — 当前 R-2 脚本模型如何驱动父子轮次。
- `apps/coding-worker/test/parent-child.integration.test.ts` — 固定父 Session 的断言基线是什么。
- `apps/coding-worker/src/revision-evidence.ts` — `h1/h2` 放行判定如何调用。

**已定**

- 母 Agent 用 DSH 内置 `send_message` 续接原 Builder，不新建会话管理器。
- Builder 两轮复用同一子 Session，但必须有两个不同 `runId`。
- 第二次 Validator 只审 `h2`；重放 `h1` 通过记录必须拒绝。

**边缘与接缝**

- 新增独立 R-3 脚本模型与集成测试，保留 R-2 基线测试不变。
- 使用真实 SDK、Agent loop、Activation、冷恢复和 wait；不调用外部模型。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- rework-loop.integration`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 若冷恢复不产生新 `runId` 或不唤醒母 Agent，停止并记录上游差异，不伪造成功事件。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 写 `h1` 拒绝到 `h2` 通过的红色集成测试。
3. 驱动母 Agent 调用原 Builder 的 `send_message`。
4. 读取 trace，核对同 Session 的两个 `runId`。
5. 重放旧哈希通过证据并核对门禁拒绝。
6. 运行完整 Worker 测试、类型检查和配置装载。
7. 提交测试，再提交实现。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | Validator 拒绝 `h1` | 母 Agent 调用 `send_message` | 父 Session |
| 2 | 原 Builder 接到返工 | 子 Session 相同，`runId` 不同 | Activation trace |
| 3 | Builder 产生 `h2` | 第二个 Validator 审 `h2` | 父 Session |
| 4 | `h1` 通过记录套到 `h2` | `revision-mismatch` | 证据判定函数 |
| 5 | `h2` 通过记录 | 母 Agent 完成，wait 收口 | Worker 批次入口 |


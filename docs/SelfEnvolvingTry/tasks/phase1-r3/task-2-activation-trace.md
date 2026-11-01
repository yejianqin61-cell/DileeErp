# 任务 2：记录 Activation 轮次

## 1. 任务位置

- 属于阶段一 `R-3 失败返工可追溯`，目标是冷恢复复用 Session 时仍能区分每轮执行。
- 本任务把 DSH 内部 `subagent/start/end` 写成 Worker 可读取的 JSONL 记录。
- 开始条件是修订证据门禁已完成；全树等待和返工纵切在后续任务。

## 2. 开发者须知

**先读**

- `tmp/deepseek-harness/packages/subagent/subagent/src/types.ts` — start/end 的公开字段与配对规则是什么。
- `tmp/deepseek-harness/packages/subagent/subagent/tests/continuation.spec.ts` — 冷恢复为何产生新 `runId`。
- `apps/coding-worker/config/coding-agents.cordis.patch.yml` — Host 插件从哪里挂载。
- `apps/coding-worker/test/parent-child.integration.test.ts` — 真实 SDK 测试如何取得临时目录。

**已定**

- 每条记录只含序号、事件种类、`runId`、子 Session、provider、local 和结束原因。
- 记录路径由 Worker 环境显式传入；缺失路径时 R-3 trace patch 启动失败。
- JSONL 是阶段一证据桥，不是 Artifact Registry。

**边缘与接缝**

- 新增独立 trace patch、极小 Cordis 插件和 Worker 解析器。
- 只观察公开生命周期事件，不改 DSH 内核，也不记录对话正文。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- activation-trace`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 若 Windows 追加写无法保持单行完整，停止并报告；不能用内存状态代替落盘证据。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 为两次真实 Activation 的配对记录写红测试。
3. 挂载观察插件并写入最小 JSONL。
4. 加入解析与畸形记录拒绝测试。
5. 运行目标测试、完整 Worker 测试和类型检查。
6. 提交测试，再提交实现。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | Builder 与 Validator 各一次 | 两组 start/end | JSONL trace |
| 2 | 一组正常记录 | start/end 使用同一 `runId` | trace 解析器 |
| 3 | 两轮执行 | 两个不同 `runId` | trace 解析器 |
| 4 | 截断 JSON 行 | 明确拒绝 | trace 解析器 |
| 5 | trace 路径缺失 | 插件启动失败 | Cordis patch |


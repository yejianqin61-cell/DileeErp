# 任务 4：验证规则层对抗纵切

## 1. 任务位置

- 属于阶段一 `R-4 Cordis 与 Worker 强制规则`，目标是证明提示词失误也不能越过规则层。
- 本任务用真实 SDK、Root、双 preset 和脚本模型运行合法链路与非法动作序列。
- 开始条件是任务 1 至任务 3 已完成；R-5 源码与数据隔离等待本任务。

## 2. 开发者须知

**先读**

- `apps/coding-worker/test/rework-loop.integration.test.ts` — 当前真实返工纵切怎样收集证据。
- `apps/coding-worker/test/rework-scripted-llm-plugin.mjs` — 脚本模型怎样驱动 Root 与子会话。
- `apps/coding-worker/src/activation-trace.ts` — Activation 轮次怎样独立核对。
- `apps/coding-worker/src/runtime-lifecycle.ts` — 超时和全树完成的 Worker 边界在哪里。

**已定**

- 非法动作必须由 Cordis/Worker 拒绝，不能依赖母 Agent 文字承诺。
- 合法链路只提交最新通过哈希；拒绝链路不得产生候选提交结果。
- 测试不调用外部模型，不读业务数据，不写生产工具目录。

**边缘与接缝**

- 接触测试脚本、测试 patch 和集成测试。
- 接缝是真实 `runCodingBatch()`；不实现多能力并行和 ERP 独立发布门禁。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- policy-adversarial`
- `npm run test --workspace=@dilee/coding-worker && npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 若事件乱序让规则层无法绑定 Activation，停止并保存原始通知，不用固定延时掩盖竞态。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 为完整合法链路写集成红测试。
3. 让最新通过哈希生成候选申请，再跑绿。
4. 逐例注入越序验证、提前提交、旧哈希重验和超额返工。
5. 加入真实 runtime 超时收口用例。
6. 运行全部 Worker 测试、类型检查和配置装载。
7. 提交测试，再提交实现或夹具修正。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | `h1` 构建并验证通过 | 候选申请绑定 `h1` | SDK 纵切 |
| 2 | Builder 前启动 Validator | `builder-not-complete` | Cordis 动作 |
| 3 | Validator 前提交 | `capability-not-approved` | 候选动作 |
| 4 | 拒绝后重验旧 `h1` | `revision-not-advanced` | Cordis 动作 |
| 5 | 第二次返工超过上限 | `rework-budget-exhausted` | Cordis 动作 |


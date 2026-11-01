# 任务 2：打通 SDK 生命周期

## 1. 任务位置

- **阶段一 R-1/R-2 批次**，目标是同版 Harness 可独立运行，且母 Agent 可委派双子会话。
- **本任务推进 R-1 同版 Harness 独立运行**：Worker 负责启动、运行请求并可靠关闭 Harness。
- **开始条件**：任务 1 的运行契约通过。**后续依赖**：preset 组合和父子会话集成。

## 2. 开发者须知

**先读**

- `tmp/deepseek-harness/packages/sdk/client/src/api.ts` — `DeepSeekHarness` 的启动、Session 与关闭语义。
- `tmp/deepseek-harness/packages/sdk/client/src/types.ts` — `dshHome`、patch、环境和超时选项。
- `tmp/deepseek-harness/packages/sdk/client/src/client.ts` — 关闭时怎样回收子进程。
- `docs/SelfEnvolvingTry/phase1-architecture-validation-build-plan-2026-10-31.md` — R-1 的验收与失败边界。

**已定**

- 每个构建批次拥有一个 Harness runtime 和固定父 Session ID。
- Worker 显式传入完整子进程环境、工作目录、`dshHome` 和 patch 列表。
- 请求成功或失败都必须关闭 runtime；SDK 超时不是服务端取消。

**边缘与接缝**

- 接触 Worker 生命周期；不接 Query Agent、数据库或发布目录。
- 测试接缝：Worker 启动与关闭入口；使用注入的 Harness 工厂测试错误收口。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- runtime-lifecycle`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 无模型凭据时只能验证真实 initialize/shutdown。若 profile 初始化需要模型调用，记录为任务 4 的脚本模型验证。

## 3. 工作流

1. 读完本节列出的入口，用一句话复述任务。
2. 先写成功、请求失败和启动失败的生命周期用例。
3. 实现最小 Worker 运行入口和稳定结果信封。
4. 用真实 SDK 运行 initialize/shutdown smoke。
5. 运行生命周期测试和类型检查。
6. 提交本任务。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 正常请求 | 返回 Session 结果并关闭一次 | Worker 运行入口 |
| 2 | 请求抛错 | 原错误上抛并关闭一次 | Worker 运行入口 |
| 3 | 初始化抛错 | 不发请求，仍执行关闭 | Worker 运行入口 |
| 4 | 真实 `sdk` profile | initialize 成功并正常退出 | SDK 启停 smoke |


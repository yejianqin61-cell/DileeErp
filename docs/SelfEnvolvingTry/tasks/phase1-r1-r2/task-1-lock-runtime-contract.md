# 任务 1：锁定 Worker 运行契约

## 1. 任务位置

- **阶段一 R-1/R-2 批次**，目标是同版 Harness 可独立运行，且母 Agent 可委派双子会话。
- **本任务推进 R-1 同版 Harness 独立运行**：固定 Node、SDK、CLI 版本与可重复安装契约。
- **开始条件**：Node 24 可用。**后续依赖**：SDK 生命周期和 Agent preset 组合。

## 2. 开发者须知

**先读**

- `docs/SelfEnvolvingTry/business-query-agent-deepseek-harness-sdk-phase1-2026-10-29.md` — 为什么 Worker 必须独立于 Node 22 API。
- `tmp/deepseek-harness/packages/sdk/client/package.json` — SDK 与 CLI 的同版依赖规则。
- `tmp/deepseek-harness/packages/sdk/client/src/launch.ts` — 运行前怎样核对 CLI 版本。
- `package.json` — 新 Worker 如何加入现有 npm workspace。

**已定**

- 使用 Node `>=24.9.0`；本机验证版本为 `24.15.0`。
- SDK 与 CLI 固定为 `0.2.2-alpha.2`，不得使用范围版本。
- Worker 独立成 workspace，不把 Harness 载入 NestJS API。

**边缘与接缝**

- 接触 npm workspace 和 Worker 包清单；不改 API 镜像。
- 测试接缝：Worker 包的运行契约检查入口；新增一个独立进程接缝。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- runtime-contract`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- npm peer 依赖可能扩大锁文件。若出现不同版本的 Harness 包，停止并报告依赖树。

## 3. 工作流

1. 读完本节列出的入口，用一句话复述任务。
2. 先写运行契约失败用例，固定 Node 下限和两个包版本。
3. 建立最小 Worker workspace 清单，让用例通过。
4. 安装精确依赖并记录 registry integrity。
5. 运行契约测试和类型检查。
6. 提交本任务。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | Node `24.8.0` | 拒绝启动 | 运行契约检查 |
| 2 | Node `24.9.0` | 允许启动 | 运行契约检查 |
| 3 | SDK/CLI 版本不同 | 拒绝配置 | 运行契约检查 |
| 4 | 两包均为 `0.2.2-alpha.2` | 返回固定版本信息 | 运行契约检查 |


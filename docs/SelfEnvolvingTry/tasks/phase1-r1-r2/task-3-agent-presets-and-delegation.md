# 任务 3：组合三类 Agent preset

## 1. 任务位置

- **阶段一 R-1/R-2 批次**，目标是同版 Harness 可独立运行，且母 Agent 可委派双子会话。
- **本任务推进 R-2 母 Agent 统筹双子会话**：声明 Orchestrator、Builder、Validator 角色与委派工具。
- **开始条件**：任务 2 能启动 runtime。**后续依赖**：父会话双子 Agent 集成验证。

## 2. 开发者须知

**先读**

- `tmp/deepseek-harness/packages/preset/agent-preset-registry/README.md` — preset 的声明与默认选择。
- `tmp/deepseek-harness/packages/subagent/tool-subagent/README.md` — 固定子 preset 和 parent delivery。
- `tmp/deepseek-harness/packages/bundle/base/cordis.patch.yml` — SDK profile 已有的 subagent 运行模块。
- `docs/SelfEnvolvingTry/deepseek-harness-root-parent-activation-2026-10-30.md` — 三类 Agent 的职责和顺序。

**已定**

- SDK 根 Agent 是 Coding Orchestrator；Builder 与 Validator 使用独立 spawn preset。
- 根 Agent 只看到固定的 Builder、Validator 委派工具和子会话控制工具。
- 两类子 Agent 不能继续委派；角色差异由 preset 固定。

**边缘与接缝**

- 接触 Cordis patch 与 Agent preset；不实现 R-3 的哈希状态机。
- 测试接缝：`dsh --dump-config` 和运行时工具清单；沿用 Harness preset 接缝。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- profile-contract`
- `npm run harness:config --workspace=@dilee/coding-worker`

**未知项**

- SDK 根 Agent 是否自动选择 registry 默认 preset。若 dump-config 成功但运行时工具缺失，停止并修正根 Agent 挂载方式。

## 3. 工作流

1. 读完本节列出的入口，用一句话复述任务。
2. 先写 patch 契约用例，固定三类 preset 和两条委派工具。
3. 增加最小 Cordis patch，关闭通用委派入口。
4. 运行 `--dump-config`，确认插件和 preset 能解析。
5. 检查 Builder/Validator 不含委派工具。
6. 提交本任务。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 组合 patch | 声明 Orchestrator、Builder、Validator | profile 契约 |
| 2 | Orchestrator preset | 只含 Builder/Validator 委派入口 | profile 契约 |
| 3 | Builder/Validator preset | 不含子 Agent 委派入口 | profile 契约 |
| 4 | `sdk` profile 加 patch | dump-config 成功 | DSH 配置入口 |


# DeepSeekHarness SDK 与子 Agent 源码核查

> 核查日期：2026-10-29。上游仓库：`deepseek-ai/deepseek-harness`，本地克隆 `tmp/deepseek-harness`，固定提交 `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`。以下链接均固定到该提交；npm 元数据为本日实时查询结果。

## 结论

ERP 应在独立的 Node 24 构建 worker 中使用 TypeScript `@deepseek-ai/dsh-sdk-client`，通过它启动 Harness 的 `sdk` profile 子进程。NestJS API 当前部署为 Node 22，不能直接载入上游要求 Node ≥24.9 的 Harness。`sdk-minimal` 缺少子 Agent，不能作为 Tool Builder/Validator 的起点。SDK 只提供会话与事件接口；“每次 run 必有 Builder 与 Validator”需要在 Harness 侧受控编排，并由 ERP 作业门禁核实，不能仅靠根 Agent 提示词。

## 已证实的公开 SDK

| 能力 | 源码证据 | 对 ERP 的用法 |
| --- | --- | --- |
| TypeScript 客户端与进程模型 | [`packages/sdk/client/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/client/src/index.ts#L1-L30)、[`api.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/client/src/api.ts#L22-L48) | `DeepSeekHarness` 拥有一个独立 `dsh` 子进程；跨 run 复用同一实例须在隔离边界允许时才做。 |
| 启动配置 | [`types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/client/src/types.ts#L23-L72)、[`launch.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/client/src/launch.ts#L128-L155) | 可指定 `profile`、补丁文件、`dshHome`、工作目录、完整子进程环境与超时；ERP 应显式提供精简环境。 |
| 高层 run 与恢复 | [`api.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/client/src/api.ts#L106-L139)、[`api.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/client/src/api.ts#L210-L255) | `run()` 返回根会话事件、后代通知和最后一次已提交文本；`resumeSession()` 恢复持久会话，不恢复 shell 等外部进程。 |
| 低层协议 | [`protocol/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/protocol/src/types.ts#L167-L185) | `initialize`、`session/prompt`、`session/resume`、`session/wait`、目录读写、`shutdown`；没有外部直接创建子 Agent 的 RPC。 |
| 事件订阅 | [`client.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/client/src/client.ts#L439-L475)、[`server.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/server/src/server.ts#L154-L198) | 可订阅 `session.event/status` 与本地子 Agent 的 `started/finished`。SDK 在客户端按 lineage 过滤；ERP 仍需把所需状态写入自己的作业事件。 |
| 等待后代 | [`server.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/server/src/server.ts#L425-L455)、[`protocol/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/protocol/src/types.ts#L176-L185) | `session/wait` 等待根会话与受管理后代；高层 `run()` 只等下一次 root idle，不能据此认定全部 Builder/Validator 完成。 |
| 取消与关闭 | [`client.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/client/src/client.ts#L177-L185)、[`api.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/client/src/api.ts#L132-L147) | 无 prompt 级取消；超时只是客户端放弃等待，服务端仍运行。取消整项构建需关闭该作业的 Harness 进程。 |
| 错误分类 | [`client/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/client/src/index.ts#L12-L32)、[`client.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/client/src/client.ts#L395-L435) | 区分远端 RPC、超时、协议错误和进程死亡；超时后必须主动终止或隔离悬挂工作。 |

`RunResult.finalResponse` 是“本次接收回执至下一次 root idle 区间的最后回复”，并非与某个 prompt 严格因果绑定。并发提示、steering、后台子 Agent 都可能影响区间。ERP 不应把这段文本作为工具包发布的唯一凭据；应读取文件产物、子 Agent 事件和独立测试结果。来源：[`api.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/client/src/api.ts#L210-L255) 与[客户端 README](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/client/README.md#L57-L74)。

## 子 Agent 与 Builder/Validator 拓扑

Harness 内部的 `ctx.subagents` 是有名称的 provider 注册与 activation 管理器；`startActivation()` 需要**确切的 live parent Agent**，返回子 Agent ID、结果 Promise 和释放句柄。它不暴露在上述 SDK RPC 中。来源：[`subagent/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent/src/index.ts#L252-L285)、[`subagent/src/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent/src/types.ts#L29-L62)。

内置 `spawn` provider 在同一 Harness 进程中创建独立会话、无父对话历史的子 Agent；可选择独立 `agentPreset`，因此适合分离 Builder 和 Validator 的工具与指令。`fork` 继承历史，隔离审查时不宜默认选它。来源：[`spawn-in-process/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent-spawn-in-process/src/index.ts#L1-L58)、[子 Agent README](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent/README.md#L64-L92)。

模型可见的 `tool-subagent` 可按 provider、tool name 和 preset 配置；调用后立即返回子 ID，完成通知稍后到达。它能让模型在一个消息里并行派发多个 Builder，但不能保证模型一定派发，也不能保证 Validator 在对应产物提交后才开始。入口：[`tool-subagent/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/tool-subagent/src/index.ts#L45-L102)、[`index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/tool-subagent/src/index.ts#L313-L331)、[`index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/tool-subagent/src/index.ts#L365-L374)。

公开 SDK 只报告**进程内**子 Agent 的 `subagent.finished`；外部子进程 provider 的中间消息与工具流不会完整投射到父 SDK 事件。若页面要稳定呈现 Builder/Validator 拓扑，第一阶段应选本地 `spawn`，并将原始事件归一化到 ERP 自有作业事件；以后换外部 provider 时补观测机制。来源：[`sdk/server/src/server.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/server/src/server.ts#L180-L198)、[`subagent-dsh-sdk/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent-dsh-sdk/README.md#L10-L35)。

建议在 Harness 侧做一个 ERP 专用 Cordis 编排插件，负责按系统任务明确启动 Builder，等其产物落盘后启动独立 Validator，并记录每个 activation 的 ID、结果和审查证据。插件需用 `ctx.subagents.startActivation({ delivery: 'caller', ... })`；不要让外部 NestJS 直接依赖 Harness 内部对象。第一阶段先验证此插件是否能在 `sdk` profile 下安全挂载。若暂时只用模型可见的两个 delegation tool，必须在 ERP 门禁拒绝缺任一角色/证据的 run，不能声称“每次 run 必有两个子 Agent”。

## Cordis 能复用到哪里

Cordis 的 profile、patch、preset 让同一 Harness 运行时组合不同工具和提示；Agent Preset 以 scoped plugin tree 选择工具，并保留活跃 Agent 使用的修订。适合在构建 worker 内定义 Builder 与 Validator 的不同工具面。来源：[`agent-preset-registry/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/preset/agent-preset-registry/README.md#L29-L77)、[`tool-subagent/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/tool-subagent/src/index.ts#L45-L102)。

`cordis-host-runner` 的动态定义可以做进程内试验，但定义按会话、进程保存，重启消失；其 `node:vm` 沙箱明确不是安全边界。它不能充当 ERP 的持久 Artifact Registry 或生产工具隔离。来源：[`cordis-host-runner/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/extensions/cordis-host-runner/README.md#L10-L16)、[`README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/extensions/cordis-host-runner/README.md#L54-L63)、[`README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/extensions/cordis-host-runner/README.md#L74-L94)。

`sdk` profile 基于 `dsh-base`，含 spawn/fork 子 Agent 和 shell/fs/sandbox；SDK app 禁用模块 HMR。`sdk-minimal` 明确排除子 Agent，且默认 `danger-full-access`。ERP 应从 `sdk` 的锁定组合出发，用显式 patch 限工具与权限；不能把 Harness 的 HMR 当成 ERP 工具包热切换。来源：[`base/cordis.patch.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/bundle/base/cordis.patch.yml#L240-L276)、[`base/cordis.patch.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/bundle/base/cordis.patch.yml#L359-L391)、[`sdk-app/cordis.patch.yml`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/bundle/sdk-app/cordis.patch.yml#L22-L24)、[`sdk-minimal/README.md`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/bundle/sdk-minimal/README.md#L10-L15)。

## 版本与部署前提

固定提交的根包和 CLI 是 `0.2.2-alpha.2`，要求 Node `>=24.9.0`；ERP API/Web Dockerfile 和 CI 当前使用 Node 22。来源：[`package.json`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/package.json#L2-L10)、[`apps/cli/package.json`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/apps/cli/package.json#L175-L182)、本仓库 `apps/api/Dockerfile:1,11` 与 `apps/web/Dockerfile:1,12`。保留 API 的 Node 22，另建 Node 24 构建 worker 是最小侵入路径。

2026-10-29 执行 `npm view`：`@deepseek-ai/dsh-sdk-client` 的 `latest=0.0.1-rc.1`，`@deepseek-ai/dsh` 的 `latest=0.2.1-rc.2`，两者 `alpha` 均为 `0.2.2-alpha.2`，且此版本的 tarball 均存在。必须**显式固定两包的 `0.2.2-alpha.2`**；不能按默认 latest 安装。已发布 SDK 的依赖会把 CLI 固定为同版，SDK 启动器也会校验两者版本相同。来源：本次 `npm view <pkg> version dist-tags --json`、`npm view <pkg>@0.2.2-alpha.2 dist.tarball --json`、[`launch.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/client/src/launch.ts#L49-L65)。尚未做安装和启动 smoke；若发布包与此提交不一致，应改为锁定 Git 提交构建，不能混装版本。

上游安全声明明确其为未经安全审计的开发预览；沙箱与审批不能作为唯一隔离。ERP 构建 worker 必须放在可丢弃容器/虚拟机、最小挂载与凭据、独立网络策略之内。来源：[`SAFETY.md`](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/SAFETY.md#L5-L23)。

## 第一阶段最小验证

1. 在独立 Node 24 环境显式安装 `@deepseek-ai/dsh-sdk-client@0.2.2-alpha.2`，验证同版 CLI、profile patch、受控环境变量、启动与关闭。
2. 在 Harness 侧配置 Builder/Validator 独立 preset，验证同一请求的两个 Builder 并行，以及每个 Builder 完成后 Validator 才审查其文件；保存 activation 与测试证据。
3. 订阅 SDK 通知，验证 `session/wait` 覆盖子 Agent 完成，失联/取消通过进程关闭收口；把事件落入 ERP 自有作业状态。
4. 对隔离容器做越界写入、读密钥与网络出站实验；验证失败任务不会产生可发布工具包。

以上为源码和元数据核查，未声称 Harness 已在 ERP 中运行。

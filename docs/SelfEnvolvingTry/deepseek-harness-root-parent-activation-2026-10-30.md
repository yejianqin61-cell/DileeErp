# DeepSeekHarness 根 Agent、父会话与子 Agent Activation 核查

> 2026-10-30｜上游固定提交 `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`｜本轮为源码核查，尚未运行 SDK 实验。

## 结论

用户提出的 Coding Orchestrator 可以复用 Harness 的**根 Agent**：ERP worker 通过 SDK 向一个固定 session ID 提交 `Tool Build Request`；SDK server 在 Harness 内创建没有 `parentAgent` 的根 Agent。该 Agent 在整批作业期间保持可用，等待子 Agent 时可处于 idle，由模型理解需求、拆分能力、阅读 Builder/Validator 反馈并决定返工。Builder、Validator 是它的直接子 Agent，父会话保留子 Agent 目录与完成通知。Cordis 插件只限制允许的动作与次序，worker 再独立核验可发布证据。

前一版“插件直接调度 Builder→Validator、`delivery: 'caller'`”不适合作为默认主流程：`caller` 结果只交给插件，不会给母 Agent 发送完成通知。要让母 Agent智能统筹，应使用 `delivery: 'parent'`，并通过根 Agent 可调用的受控工具启动子 Agent。来源：[Activation 类型](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent/src/types.ts#L30-L58)、[上游说明](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent/README.md#L58-L70)。

## 源码证据

| 问题 | 已证实机制 | 对 ERP 的含义 |
| --- | --- | --- |
| 母 Agent 是什么？ | SDK server 的 `createSession()` 调用 `ctx.agents.create({ sessionId, meta, agentOptions })`，未传 `parentAgent`；上游 Agent API 规定省略 `parentAgent` 即运行时根 Agent。[SDK server](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/server/src/server.ts#L481-L514)、[Agent API](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/agent/src/index.ts#L59-L70) | 不必另造母 Agent 循环；固定 `sessionId` 可把一项构建的决策和反馈放在同一个父会话。 |
| 如何确认父子关系？ | `startActivation()` 的 `request.parent` 必须是注册表中的**确切实时 Agent 对象**，否则拒绝。[Subagent API](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent/src/index.ts#L252-L285) | Cordis 工具从当前执行上下文的 `exec.agent` 取得母 Agent，不能靠仅有的 session ID 伪造父身份。 |
| Parent Session 保存什么？ | 本地子 Agent 创建时在父 Session 追加子目录记录；子 Session header 记录 `parentSession`。`listChildren()` 可在不恢复子 Agent 的情况下查父目录。[子 Agent 文档](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent/README.md#L119-L123)、[SDK started 通知](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/server/src/server.ts#L171-L198) | 父会话是可审计的代理拓扑与对话记录，但 ERP 的作业状态仍需自己持久化。 |
| Builder/Validator 如何回报？ | `delivery:'parent'` 让 runtime 在子 Agent 结算后，把结果作为父会话的状态通知；父 Agent 空闲时会被唤起新一轮。`caller` 则没有父通知。[结算实现](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent/src/manager.ts#L1194-L1224)、[模型可见语义](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent/README.md#L163-L175) | Validator 可写审查文件并在结束时向母 Agent 报告缺失测试；母 Agent 决定返工或结束。早期阻塞可用 `send_message` 通知，但不能只依赖聊天文本作为发布证据。 |
| 母 Agent 怎样让 Builder 返工？ | 内置 `send_message` 调用 `ctx.subagents.sendMessage(exec.agent, childId, ...)`；同一父 Agent 可向直接子 Agent 发消息。已结算的本地子 Agent 可从持久会话冷恢复，继续同一对话。[控制工具](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/tool-subagent-control/src/index.ts#L27-L73)、[冷恢复](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent/src/manager.ts#L1345-L1403) | 返工可以复用原 Builder 的上下文与子 Session；每次修订仍要有新的代码哈希，并重新触发 Validator。 |
| 能否并行？ | `dsh-tool-subagent` 启动后立即返回子 ID，后台执行；一份配置对应一个 delegation tool，可按 `agentPreset` 固定子角色；服务默认最多 8 个活动子 Agent。[tool README](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/tool-subagent/README.md#L28-L71)、[容量](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent/README.md#L49-L55) | 多个能力的 Builder 可并行，各自 Validator 需等待该能力的 Builder 产物；不能靠默认工具本身保证这个业务次序。 |
| 怎样知道母 Agent 真正结束？ | `run()` 只等下一次根 Agent idle；SDK server 的 `session/wait` 循环等待根 idle 和 `waitForChildren(agent)`，再复核根 Session seq 与状态。[SDK wait](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/server/src/server.ts#L301-L320) | worker 应在完成候选前调用 `session/wait`，并核对文件、审查和测试证据；不能把 `finalResponse` 当完成信号。 |

**轮次标识要补桥接。** SDK 的 `subagent.started` 只含父/子 Session ID，`subagent.finished` 也不含 Activation `runId`；`started` 由 `session/created` 发出，Builder 冷恢复时不会再创建新 Session。Harness 内部 `subagent/start` 与 `subagent/end` 才以 `runId` 配对。Cordis 插件需将这对内部事件写入受控作业记录，再由 worker 映射为每轮进度；只靠 SDK 通知不能准确显示返工轮次。[SDK 协议](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/protocol/src/types.ts#L141-L165)、[SDK server](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/server/src/server.ts#L171-L198)、[内部事件](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent/src/index.ts#L149-L166)。

## 推荐职责与边界

- **Coding Orchestrator（Harness 根 Agent）**：理解问题、提出能力拆分、指定每项 Builder 任务、阅读子 Agent 反馈、判断修复方向、决定何时请求发布。它是智能决策者，但无权直接改变 ERP 活动工具目录。
- **Builder / Validator（本地 `spawn` 子 Agent）**：各有独立会话和 preset。Builder 写工具代码；Validator 检查逻辑与权限、补测试、运行测试、报告问题。Validator 不直接修改 Builder 的候选实现，也不与 Builder 作为兄弟互发消息；反馈先到母 Agent。
- **Cordis 策略插件**：把 `declare_capabilities`、`start_builder`、`start_validator`、`revise_builder`、`submit_candidate` 做成受控模型工具，内部复用 `ctx.subagents.startActivation`/`sendMessage`。插件检验确切根 Agent、角色 preset、能力 ID、Builder 产物哈希、同一修订的 Validator 结果、并行写入目录和返工上限。母 Agent选择下一步，插件拒绝非法步骤。第一版可先试内置 `tool-subagent` 两个固定 preset 的方案；若无法在委派前核验业务前置条件，就用薄包装工具替代，不重写 Activation 管理器。
- **Worker / ERP 发布门禁**：worker 持有作业租约与独立 Harness 进程，映射事件并在退出前 `session/wait`；ERP Host 独立检查源码范围、权限、测试和内容哈希。插件进程内状态不是唯一放行凭据；作业重启要重新核实产物。失败、取消或超过时限时不发布。

对话与机器证据分开：母 Agent 可读 Validator 的“缺少跨订单隔离测试”结论，发布器只接受落盘的对抗用例、测试结果和对应代码哈希。`send_message` 仅确认消息已接受，不证明 Builder 已修好；Validator 的下一次通过必须关联修订后的哈希。[消息语义](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/tool-subagent-control/src/index.ts#L30-L33)。

## 订单 A 包装工序示例

1. Query Agent 证明当前目录缺少“按订单、工序、员工、日期的产量与累计完成量”能力，创建 `Tool Build Request`。
2. 母 Agent 在父会话中把需求拆为一个能力（若现有数据源使每日和累计必须分开，也可拆成两个），声明输入、输出、订单边界和验收样例。
3. 母 Agent启动 Builder；Builder 在独立候选目录写工具和基础测试，完成通知回到母 Agent。
4. 母 Agent 启动 Validator 审查该**具体代码哈希**。Validator 发现跨订单隔离用例缺失，写入审查报告和失败用例，通知母 Agent。
5. 母 Agent 向原 Builder 发送修复要求；Builder 继续其子会话并提交新哈希。母 Agent 对新哈希再启动 Validator。只有最新修订通过审查与测试，母 Agent 才能提交候选。
6. Worker 等待全树空闲并核对通知和文件；ERP 独立发布门禁重新运行权限与越订单检查。任何一层失败都不激活工具。

## 需要运行验证的细节

- 在 `sdk` profile 中加载母 Agent 专用提示与策略插件，确认根 Agent 的受控工具可见、Validator/Builder 预设真正分离；SDK server 目前创建根 Agent 时未显式选择 preset，不能假设“根 preset”自动套用。[SDK server](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/sdk/server/src/server.ts#L481-L510)。
- 验证 Builder 结算后 `send_message` 冷恢复、父通知再唤醒、`session/wait` 对返工轮次的覆盖；通过插件桥接记录每次 activation 的 `runId` 与子 Session ID，不把 Session ID 当作唯一轮次 ID。[生命周期类型](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent/src/types.ts#L76-L105)。
- 验证母 Agent 在 Validator 失败时不会直接提交候选，策略插件能拒绝“未编写先验证”“旧哈希通过后又修改”“未验证直接提交”等路径。内置子 Agent 的通知可能被模型误读，外部发布门禁仍需按结构化证据判定。
- 若 runtime 崩溃，Parent Session 可持久，但 Subagent Activation 的 live 所有权与父消息箱不跨进程；先按新 attempt 重试，不承诺自动续接中断中的 Builder。[上游限制](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/subagent/subagent/README.md#L204-L212)。

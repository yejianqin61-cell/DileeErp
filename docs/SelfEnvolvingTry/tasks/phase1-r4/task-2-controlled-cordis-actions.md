# 任务 2：接入受控 Cordis 动作

## 1. 任务位置

- 属于阶段一 `R-4 Cordis 与 Worker 强制规则`，目标是模型不能绕开作业策略直接委派。
- 本任务用薄 Cordis 插件提供声明、构建、验证、返工、结论和候选提交动作。
- 开始条件是任务 1 的状态机已完成；真实对抗纵切等待本任务。

## 2. 开发者须知

**先读**

- `tmp/deepseek-harness/packages/subagent/tool-subagent/src/index.ts` — 原生委派工具怎样启动 Activation。
- `tmp/deepseek-harness/packages/core/tools/src/index.ts` — 工具注册和单调 guard 的真实接缝是什么。
- `apps/coding-worker/config/coding-agents.cordis.patch.yml` — 当前 Root 与双 preset 怎样组合。
- `apps/coding-worker/config/restrict-delegation-tools.mjs` — 子 Agent 工具隔离怎样实施。

**已定**

- Root 只能使用受控动作；通用委派和原始双委派工具保持禁用。
- Builder 与 Validator preset 不变；插件调用 DSH 原生 Activation 和冷恢复消息。
- 候选提交只是交给 ERP 门禁的申请，不等于发布通过。

**边缘与接缝**

- 接触 Coding Worker 的 Cordis patch、策略插件、精确版 DSH 工具依赖和测试夹具。
- 接缝是模型可见工具；不复制 Session 管理器，不实现 Artifact Registry。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- profile-contract cordis-policy`
- `npm run typecheck --workspace=@dilee/coding-worker && npm run harness:config --workspace=@dilee/coding-worker`

**未知项**

- 若发布包不能从插件调用原生 Activation 或 `sendMessage()`，停止并报告上游接缝差异。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 为最终 profile 只暴露受控动作写红测试。
3. 注册最小 Cordis 动作并接入任务 1 的策略。
4. 将 Activation 完成事件映射回对应能力和角色。
5. 更新既有脚本夹具以使用结构化能力和哈希参数。
6. 运行目标测试、类型检查和配置装载。
7. 提交测试，再提交实现。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 最终 profile 装载 | 只有受控动作持有双角色 | Cordis 配置 |
| 2 | Root 启动 Builder | 固定 `tool-builder` Activation | `build_tool` |
| 3 | Root 启动 Validator | 固定 `tool-validator` Activation | `validate_tool` |
| 4 | 拒绝后返工 | 消息只发原 Builder | `revise_tool` |
| 5 | 子 Agent 调用受控动作 | `UNKNOWN_TOOL` | preset 隔离 |


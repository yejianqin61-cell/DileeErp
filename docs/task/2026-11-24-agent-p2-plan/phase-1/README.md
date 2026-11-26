# P2 阶段 1：模型能看见目录

计划：[P2 施工计划](../plan.md) 阶段 1。设计：[P2 设计](../../../design/dilee-consultant-p2-tool-catalog-2026-11-24.md) §3。

**这一批只做目录。** 不做缺口声明、不做坐标、不动前端布局、不碰黄金集。
目标：prompt 里出现六段模块声明，模型需要细节时能展开该模块的 operation 条目。

覆盖需求：R-1、R-2、R-7、R-13（接口部分）。

## 任务

| # | 任务 | 产物 | 依赖 |
|---|---|---|---|
| 1 | [目录数据、生成器与候选集接口](task-1-catalog-generator.md) | `tools/tool-catalog.ts`、`tools/tool-catalog-specs.ts` | — |
| 2 | [收拢 accepts 并与执行器对账](task-2-accepts.md) | specs 加 `accepts`；`agent-tool-catalog-accepts.test.cjs` | 1 |
| 3 | [目录接进系统指令](task-3-system-prompt.md) | `buildSystemPrompt`；`agent-system-prompt.test.cjs` | 1 |
| 4 | [展开工具 `describe_module`](task-4-describe-module.md) | 提供方、编排器、前端标签接线 | 1、2 |
| 5 | [未知模块的可读错误](task-5-unknown-module.md) | 专用错误码与可用模块列表 | 4 |
| 6 | [目录与能力表双向对账](task-6-reconcile.md) | `reconcileCatalog`；`agent-tool-catalog-reconcile.test.cjs` | 1、2 |
| 7 | [端到端：一句话命中正确模块](task-7-e2e.md) | `agent-catalog-e2e.test.cjs` | 3、4、5 |

建议顺序：1 → 2 → 3 → 6 → 4 → 5 → 7。任务 3 与任务 6 彼此独立，可并行。

## 本批已定（实施者不得重开）

| 决定 | 内容 | 出处 |
|---|---|---|
| 模块名 | 沿用现有六个领域工具名（`order_query` 等），不另起名 | 设计 §3 |
| `status` 字段 | **不设**。`registered_not_implemented` 中间态不允许；审计测试已钉死 35 个都 implemented | 用户 2026-11-24；设计 §10-1 |
| 展开工具 | 工具名 `catalog_query`，唯一 operation `describe_module`，参数 `module`；**不进** `TOOL_CAPABILITIES` 与 `AGENT_TOOLS`，编排器本地处理，不走 `ToolExecutor`、不碰库 | 本批决定，理由见任务 4 |
| 文案真源 | 条目文案手写在 `tool-catalog-specs.ts`；结构、数量、可见性、顺序全由 `TOOL_CAPABILITIES` 生成 | 设计 §3.2 |
| 注释 | 新写的代码**不写散文注释**；功能性指令除外 | 设计 §7.2 |
| `row(` 调用形状 | 不得改动 `tool-registry.ts` 里 `row("tool", "op"` 的写法：前端标签测试用正则解析这份源码 | `apps/web/lib/agent-tool-labels.test.mjs` |

## 命令（仓库根目录执行）

```bash
npm run typecheck --workspace=@dilee/api
npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-catalog.test.cjs
npm run test:lib --workspace=@dilee/web
```

## 本批明确不做

- 缺口声明 `report_gap`、四条代码核对、候选归并（阶段 3、4）。
- 对照实验（阶段 2）。
- 黄金集重跑与 `model_steps` 对比（阶段 8）。本批不运行 `npm run test:agent-golden`，它要真库与真模型。
- 删除或改写工具的执行逻辑。

## 交付前需要用户审的东西

任务 1 产出的 35 条「边界」文案是域语义。实施者只写代码里能看到的行为，写不准的在任务报告里列出「待审」，**不得编造**。

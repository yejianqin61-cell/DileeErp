# P2 阶段 3：缺口能被核对

计划：[P2 施工计划 v1.3](../plan.md) 阶段 3。设计：[P2 设计 v1.3](../../../design/dilee-consultant-p2-tool-catalog-2026-11-24.md) §2.2、§2.3。
依据：[缺口对照实验](../../../review/agent-gap-experiment-2026-11-25.md)（`adopt_C`）。

**这一批只做声明与核对。** 目标：对确实无入口的问法，模型报出最近邻与差异并被记下；
对已被覆盖或只是没数据的问法，声明被驳回。不做候选归并、门槛、建单（阶段 4）。

覆盖需求：R-4、R-5。

## 任务

| # | 任务 | 产物 | 依赖 |
|---|---|---|---|
| 1 | [缺口声明的格式校验](task-1-parse.md) | `tools/report-gap.ts` | — |
| 2 | [所需字段对照 schema 分组](task-2-fields.md) | `tools/gap-fields.ts` | — |
| 3 | [三条驳回核对](task-3-checks.md) | `tools/gap-check.ts` | 1、2 |
| 4 | [提供方声明与系统指令](task-4-provider-prompt.md) | 提供方、`system-prompt.ts`、实验脚本一处 | 1 |
| 5 | [编排器接线与内部事件](task-5-orchestrator.md) | 编排器、事件类型、前端标签 | 3、4 |
| 6 | [端到端三种情形](task-6-e2e.md) | `agent-gap-e2e.test.cjs` | 5 |

建议顺序：1 → 2 → 3 → 4 → 5 → 6。

## 本批已定（实施者不得重开）

| 决定 | 内容 | 出处 |
|---|---|---|
| 工具形状 | 工具 `report_gap`，内部 operation 名 `declare_gap`；**不进** `TOOL_CAPABILITIES` 与 `AGENT_TOOLS`，编排器本地处理，不走执行器、不碰库 | 同阶段 1 的 `catalog_query` |
| 声明字段 | `nearest_operation`、`missing`、`missing_detail` 必填；`missing_param`、`needed_fields` 可选 | 设计 §2.2；`missing_param` 为用户 2026-11-25 拍板 |
| 核对 2 | **仅当**填了 `missing_param` 且最近邻的 `accepts` 含它时驳回，回传该条目。没填则不触发 | 用户 2026-11-25「加可选参数名」 |
| `missing_param` 取值 | 各条目 `accepts` 的并集**去掉 `order_ref` 与 `page`**：`q`、`status`、`customer_q`、`product_q`、`from`、`to`。去掉的两个是单据根与翻页，不是筛选参数，留着会把「需要跨订单」误驳回 | 本批决定 |
| 核对 4 | **只看最近邻**：本轮最近邻 operation 成功执行过，且每次都是 0 行，才判缺数据。别的 operation 落空不算；执行失败的调用不算 | 用户 2026-11-25「只看最近邻」 |
| 行数口径 | 结果 `data` 是数组按长度计；`null`/`undefined` 记 0；其它对象记 1 | 与编排器现有 `hasRows` 判断一致 |
| 字段核对 | 不驳回，只分成 `needed_fields`（存在）与 `unverified_fields` | 设计 §2.3 第 3 条 |
| 驳回的代价 | 所有缺口驳回（含格式不合法）**不计失败预算**，但计入调用总数与规划轮数，所以循环有界 | 设计 §2.3 |
| 同轮重复 | 同一轮里 `(nearest_operation, missing)` 相同的第二次声明照回「已记录」，不再写事件 | 本批决定：避免阶段 4 计数虚高 |
| 注释 | 新写的代码不写散文注释 | 设计 §7.2 |

## 错误码与文案（逐字使用）

| 码 | 何时 | message |
|---|---|---|
| `AGENT_GAP_ARGUMENT_INVALID` | 格式不合法 | 见任务 1 |
| `AGENT_GAP_OPERATION_UNKNOWN` | 最近邻不存在或本档位不可见 | `nearest_operation 不是可用的 operation。可用：` 后接顿号分隔的可见 operation 名 |
| `AGENT_GAP_PARAM_SUPPORTED` | 核对 2 | `<operation> 本来就接受参数 <param>，直接用它查询。条目：` 后接该条目的 JSON |
| `AGENT_GAP_NO_DATA` | 核对 4 | `<operation> 本轮查到 0 行，这是缺数据，不是缺工具。直接告诉用户没有查到记录。` |

放行时回给模型的工具结果固定为 `{"result":"已记录"}`。

## 命令（仓库根目录执行）

```bash
npm run typecheck --workspace=@dilee/api
npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-gap-*.test.cjs
npm run test:unit
```

## 本批明确不做

- 候选表、归并、门槛、建单器（阶段 4）。
- 可行性探针（P3 桥接之后）。
- 跑真模型或黄金集：`missing_param` 与新系统指令在真模型上的表现本批不验证（阶段 8）。

## 交付时要告诉用户的

`missing_param` 没有经过实验；系统指令新增了两段话，黄金集尚未重跑。

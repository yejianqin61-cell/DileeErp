# P2 阶段 2：方案用数据定

计划：[P2 施工计划](../plan.md) 阶段 2。设计：[P2 设计](../../../design/dilee-consultant-p2-tool-catalog-2026-11-24.md) §2.7。

**这一批只做离线实验。** 不改编排器、不加 `report_gap` 的任何生产代码、不动前端、不碰黄金集。
目标：用数据回答「最近邻差异是否够好、闭合矩阵是否值得重开」，结论三选一：采用 C / 重开矩阵 / 停在观测层。

覆盖需求：R-3。

## 任务

| # | 任务 | 产物 | 依赖 |
|---|---|---|---|
| 1 | [缺口题集与格式校验](task-1-question-set.md) | `apps/api/test/agent-golden/gap-cases/gap-questions.json`；`scripts/agent/gap-experiment/questions.test.mjs` | — |
| 2 | [三组提示与假 `report_gap`](task-2-group-configs.md) | `scripts/agent/gap-experiment/groups.mjs`；`groups.test.mjs` | — |
| 3 | [单题单次运行器](task-3-run-one.md) | `scripts/agent/gap-experiment/run-one.mjs`；`run-one.test.mjs` | 2 |
| 4 | [六项指标与三选一判据](task-4-metrics.md) | `scripts/agent/gap-experiment/metrics.mjs`；`metrics.test.mjs` | — |
| 5 | [入口脚本与干跑](task-5-cli.md) | `scripts/agent/gap-experiment.mjs`；`cli.test.mjs` | 1、3、4 |
| 6 | [实跑、快照与结论报告](task-6-run-and-report.md) | `docs/review/agent-gap-experiment-2026-11-24.md` 与快照 | 5，且题集已审 |

建议顺序：1、2、4 可并行 → 3 → 5 → 6。任务 6 之前，**用户必须审过题集标注与 B 组轴声明**，缺一不跑。

## 本批已定（实施者不得重开）

| 决定 | 内容 | 出处 |
|---|---|---|
| 档位 | 实验一律以 `full` 档运行，六个模块、35 条全部可见 | 设计 §2.7（题集含财务缺口） |
| 模型 | `deepseek-chat`，每题每组 3 次，三组 30 题，共 270 次运行 | 设计 §2.7 |
| 不放行 | 假 `report_gap` 只记录参数，固定回「已记录」，不建单、不驳回 | 设计 §2.7 |
| 工具结果 | 领域工具由**桩**应答，不连库：`search_documents` 恒返回一行 `[{"order_ref":"o_1","order_no":"MOCK-ORD-001"}]`；其余领域工具，题目 `stub` 为 `rows` 时返回 `[{"示例字段":"示例值"}]`，为 `empty` 时返回 `[]` | 本批决定：实验只测「模型选什么、判不判缺口」，不测数据；桩使每题可复现 |
| 目录 | A/B/C 三组的目录与展开工具原样取自阶段 1 的 `buildSystemPrompt("full")` 与 `describeModule`，不另写 | 阶段 1 总结 |
| 单次运行步数上限 | 8 步；到顶仍无最终回答记为 `capped`，不算判缺口 | 本批决定 |
| 唯一允许的 `src` 改动 | 任务 3 在 `deepseek-llm-provider.ts` 里给 `TOOL_DESCRIPTIONS`、`domainInputSchema`、`CATALOG_TOOL_DESCRIPTION`、`catalogInputSchema` 加 `export`，**只加关键字**，不改任何行为 | 本批决定：让实验与线上用同一份工具声明 |
| 注释 | 新写的代码不写散文注释 | 设计 §7.2 |
| 脚本语言 | `.mjs`，与 `scripts/agent/golden-*.mjs` 同；读 API 编译产物用 `createRequire` 指向 `apps/api/dist` | 既有惯例 |

## 共用文案（逐字使用，各任务引用）

**缺口判据句（三组 `report_gap` 描述的共同第一句）**：

> 只在确认现有工具都答不了用户的问题时调用；换个问法就能答、或查到 0 行，都不是缺口。

**GAP_HINT（三组系统指令共同追加，接在 `buildSystemPrompt("full")` 之后，前面空一行）**：

> 如果现有工具确实答不了用户的问题，调用 report_gap 说明缺口，然后告诉用户目前无法回答；能答的就直接查。

**C 组追加（接在 GAP_HINT 之后，前面空一行）**：

> 判断缺口时：先在上面的模块里找最接近用户问题的 operation，再说它差什么（分组、筛选、度量、时间序列，或现有工具都不以该对象为主体）。

**B 组追加（接在 GAP_HINT 之后，前面空一行）**：`可用查询模块的轴声明：` 一行，加六行轴声明，见任务 2。

## 题集种子（任务 1 照此转写；标注经用户审）

字段：`class` 类别；`expect` 期望判定（`gap` 判缺口 / `no_gap` 不判）；`nearest` 期望最近邻 operation；
`missing` 主要差异类型（仅信息，不进指标）；`stub` 桩应答。除标明处，`stub` 均为 `rows`。

**真缺口 10（`expect: gap`）**

| id | 问法 | nearest | missing |
|---|---|---|---|
| gap-01 | 按供应商汇总本月采购金额 | `get_payables` | `group_by` |
| gap-02 | 最近六个月每月的销售订单数量趋势 | `list_documents` | `time_series` |
| gap-03 | 各个仓库的原料库存分别是多少 | `list_low_stock_materials` | `group_by` |
| gap-04 | 本月所有订单的应收账款总额是多少 | `get_receivables` | `group_by` |
| gap-05 | 每个客户累计下了多少张订单 | `list_documents` | `group_by` |
| gap-06 | 每个员工本月报工总量排名 | `get_order_payroll` | `group_by` |
| gap-07 | 哪些供应商的采购单延期最多 | `list_overdue_arrivals` | `group_by` |
| gap-08 | 这个月和上个月的成品出库数量对比 | `get_finished_goods_outbounds` | `time_series` |
| gap-09 | 管理费用科目本月发生额是多少 | `get_order_cost_profit` | `object` |
| gap-10 | 全公司各订单的毛利排名 | `get_order_cost_profit` | `group_by` |

**诱饵 10（`expect: no_gap`，现有工具能答，只是换了说法）**

| id | 问法 | nearest |
|---|---|---|
| decoy-01 | 有哪些采购单已经过了预计到货日还没到齐 | `list_overdue_arrivals` |
| decoy-02 | 仓库里什么料快没了 | `list_low_stock_materials` |
| decoy-03 | 上个月更新过的、已确认的单子列一下 | `list_documents` |
| decoy-04 | 单号里带 0001 的销售订单有哪些 | `search_documents` |
| decoy-05 | MOCK-ORD-001 现在走到哪个环节了 | `get_order_overview` |
| decoy-06 | MOCK-ORD-001 的客户是谁 | `get_customer` |
| decoy-07 | MOCK-ORD-001 货发出去多少了 | `get_finished_goods_outbounds` |
| decoy-08 | MOCK-ORD-001 的来料质检都合格吗 | `get_incoming_inspections` |
| decoy-09 | MOCK-ORD-001 用了哪些物料、各要多少 | `get_bom` |
| decoy-10 | MOCK-ORD-001 每道工序做完了多少 | `get_operation_progress` |

**缺数据 5（`expect: no_gap`，有入口但库里 0 行，`stub: empty`）**

| id | 问法 | nearest |
|---|---|---|
| nodata-01 | MOCK-ORD-001 有没有对账记录 | `get_reconciliations` |
| nodata-02 | MOCK-ORD-001 有没有客户退货 | `get_sales_returns` |
| nodata-03 | MOCK-ORD-001 有没有外加工发料 | `get_outsource_flow` |
| nodata-04 | MOCK-ORD-001 有哪些附件 | `get_order_attachments` |
| nodata-05 | MOCK-ORD-001 收到过客户付款吗 | `get_customer_payments` |

**无结构 5（`expect: no_gap`，需要综合现有工具回答；此档标注争议最大，重点审）**

| id | 问法 | nearest |
|---|---|---|
| unstructured-01 | MOCK-ORD-001 为什么还没发货 | `get_order_overview` |
| unstructured-02 | MOCK-ORD-001 这张单有什么风险 | `get_order_alerts` |
| unstructured-03 | MOCK-ORD-001 整体情况怎么样 | `get_order_overview` |
| unstructured-04 | MOCK-ORD-001 下一步该做什么 | `get_order_overview` |
| unstructured-05 | MOCK-ORD-001 和 MOCK-ORD-002 哪个更急 | `get_order_overview` |

## 命令（仓库根目录执行）

```bash
npm run build --workspace=@dilee/api
node --test scripts/agent/gap-experiment/*.test.mjs scripts/agent/gap-experiment-cli.test.mjs
npm run typecheck --workspace=@dilee/api
```

## 本批明确不做

- `report_gap` 的生产实现、四条代码核对、候选归并（阶段 3、4）。
- 修改系统指令、编排器、目录规格。
- 黄金集重跑；缺口题并入黄金集（阶段 8）。
- 把 B 组的轴声明写进注册表：它只为实验存在。

## 交付前需要用户审的东西

1. 上面 30 题的 `expect`、`nearest`，尤其「无结构」五题与「真缺口」里 `nearest` 不唯一的几题（gap-01、gap-09、gap-10）。
2. 任务 2 里 B 组的六行轴声明。它按 v1.0 §2.3 初稿并按今天的 35 条规格修正过（采购模块今天**没有**金额，v1.0 初稿写错了）。

审过后在题集文件里填 `reviewedBy` 与 `reviewedAt`，任务 6 才允许实跑。

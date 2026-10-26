# P3-T4 生产领域 4 个 operation

## 1. 位置

- 阶段：Phase 3 非财务订单全链路。
- 本任务落生产领域：get_production_orders、get_operation_progress、get_operation_reports、get_outsource_flow。
- 前置：P3-T1 订单根验证器。

## 2. 开发者须知

**先读**

- `apps/api/src/modules/production/production-orders.service.ts` — 生产单、工序顺序与状态口径。
- `apps/api/src/modules/production/production-progress.service.ts` 与 `production-progress.domain.ts` — 纯进度计算与阻塞规则（复用纯函数，禁止任何重算写入路径）。
- `apps/api/src/modules/production/operation-daily-reports.service.ts` — 报工的日期/工序筛选口径。
- `apps/api/src/modules/production/outsource-logistics.service.ts` — 批次、发出、回厂、直发状态。
- `apps/api/prisma/schema.prisma` 的 ProductionOrder/ProductionOrderOperation/OperationDailyReport/OutsourceLogistics 模型。
- `docs/design/business-query-agent-v0-module-design-2026-10-25.md` 映射表（production_query 四行）。

**定案（不得重开）**

- 全部先过 `assertOrderRoot`；`get_operation_progress` 若按生产单 ID 查询，必须先证实该生产单属于当前订单。
- `get_production_orders` 投影：生产单号、状态、执行模式、计划数量、工序清单（名称/顺序/状态）；不传整个 BOM 或生产单原对象。
- `get_operation_progress` 复用 `production-progress.domain` 纯函数算进度与阻塞；投影：各工序完成/计划数量、进度、阻塞原因；禁止使用任何重算写入路径。
- `get_operation_reports` 投影：工序、报工数量、单位、时间、（若模型有）合格数量；**员工姓名、工时单价、工资金额一律排除**——计薪字段在模型里存在就不选。
- `get_outsource_flow` 投影：批次、发出/回厂/直发状态、数量、物流节点时间；剔除采购价、应付来源、自由备注（remark 整体不给）。
- 文件：`tools/production-query-tools.ts`；executor 分支；registry 翻开关。

**边界**

- 新文件 `tools/production-query-tools.ts`。不改业务模块；production-progress.domain 的纯函数直接 import 复用。

**运行**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-production-domain.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**未知**

- 进度纯函数的入参形状（按生产单还是按订单聚合）以 domain 实现为准；若它内部依赖 Prisma client 类型，传入只读 client 同样成立（类型是结构化的）。

## 3. 工作流

1. 读上面 6 处，然后一句话复述本任务。
2. 写测试（红）：四个 op 喂「带工资/工时单价/采购价/应付来源」的宽行。
3. 写 `production-query-tools.ts` 四个实现；executor 分支；registry 翻开关。
4. 跑本任务命令 + 全量 agent 单测回归；提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | 生产单带整块 BOM 对象 | 投影只有单号/状态/模式/计划量/工序清单 | `get_production_orders` |
| 2 | 按生产单查进度 | 先证实属于当前订单，否则 404 | `get_operation_progress` |
| 3 | 进度计算与现有页面口径一致 | 复用 domain 纯函数（同输入同输出） | `get_operation_progress` |
| 4 | 报工行带员工/计薪字段 | 投影只有工序/数量/单位/时间 | `get_operation_reports` |
| 5 | 外加工行带采购价/应付来源/备注 | 投影只有批次/状态/数量/时间 | `get_outsource_flow` |

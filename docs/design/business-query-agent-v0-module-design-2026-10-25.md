# 业务查询 Agent V0 模块细化设计

> 类型：实施规格｜日期：2026-10-25｜状态：待实施  
> 上位设计：[业务查询 Agent V0 工程布局](business-query-agent-v0-architecture-2026-10-23.md)。本文给出模块接口、数据流、状态与验收条件；业务表只读是不可放宽的约束。

## 本轮应按什么形态实现？

在现有 API 进程中接入一个只读查询模块。DeepSeek 调用交给 AI SDK；业务数据只经静态工具目录和只读数据库连接进入模型。后端持久化用户会话、运行和 SSE 事件，前端通过 JSON 建立运行、通过 SSE 接收进度。最近 8 轮问答进入上下文，应用层不限制输入 token。每个用户同时只允许一个运行，全进程最多 4 个运行；没有空位就返回 `429 AGENT_BUSY`，不排队。这个设计支持当前少量用户并发，同时保留以后拆独立 worker 的入口。

## 哪些代码放在一起？

```text
apps/api/src/modules/business-query-agent/
  business-query-agent.module.ts
  business-query-agent.controller.ts
  business-query-agent.dto.ts
  agent-orchestrator.ts
  llm-provider.ts
  query-permission.guard.ts
  context-manager.ts
  state-manager.ts
  stream-transport.ts
  concurrency-gate.ts
  observability.ts
  tools/
    tool-registry.ts
    tool-executor.ts
    tool-permission.ts
    order-query-tools.ts
    sales-query-tools.ts
    procurement-query-tools.ts
    production-query-tools.ts
    warehouse-query-tools.ts
    finance-query-tools.ts
    query-read-client.ts
apps/web/app/business-query/page.tsx
apps/web/lib/business-query-state.ts
apps/web/lib/business-query-stream.ts
```

`tool-registry` 只拥有工具声明，`tool-executor` 只拥有执行路径，领域工具只拥有业务查询及输出投影。每个领域文件在实际需要第二个查询时才建立；初始实现可以先把纯查询函数放在 `order-query-tools.ts`，避免为目录表制造空文件。后端模块只导出控制器，不把 Prisma client 或工具执行器暴露给其他业务模块。

## 每个模块的 Interface 是什么？

| 模块 | 最小 Interface | 必须保持的不变量 |
| --- | --- | --- |
| LLM provider | `plan(messages, tools, signal)`；`streamAnswer(messages, signal)` | 只接收已授权工具和已过滤事实；密钥只在服务端；不自带业务读写能力。 |
| Agent orchestrator | `run(runId, signal): Promise<void>` | 唯一运行入口。按 `planning → querying → responding → terminal` 推进；所有异常都落终态并释放许可。 |
| Tool registry | `visibleTools(accessLevel)`；`definition(name, operation)` | 固定 6 个领域工具；未注册的 `name/operation` 必须拒绝。不给模型暴露执行函数。 |
| Tool executor | `execute(call, userId, signal): Promise<QueryFact>` | 重新取角色、验证输入、核对订单、调用只读实现并投影结果；超时和结果截断由此处统一执行。 |
| Permission guard | `principal(request)`；`assertOwner(userId, resourceId)` | 从当前会话和服务端角色得到 `full/operational`；API 请求不能自报档位；任何资源读取都核对归属。 |
| Context manager | `history(userId, sessionId, accessLevel)` | 只取本人当前可见的最近 8 个已完成问答；不以 token 数裁剪，不带旧工具原始结果。 |
| State manager | `createRun`、`transitionAndAppend`、`eventsAfter`、`cancel`、`failInterrupted` | 状态与事件在同一数据库事务提交；终态不可再改；同一用户只有一个活动 run。 |
| Stream transport | `follow(runId, afterSeq, userId)` | 先查归属和档位，再重放事件与持续推送；所有 `data` 均为版本化 JSON；同一事件可重放但前端只应用一次。 |
| Concurrency gate | `tryAcquire(userId): Permit | Busy` | 进程内至多 4 个活动许可；`finally` 释放；不缓存问题、不创建等待队列。 |
| Observability | `record(runId, event)` | 关联请求、运行、工具和模型用量；日志默认不含问题全文、原始订单数据或模型上下文。 |
| Web reducer | `reduce(state, action): state` | 只按合法迁移更新页面；通过 `seq` 去重；刷新后以后端快照重建。 |

这里的 `QueryFact` 是内部结果：`{operation, order_no, as_of, data, sources, access_level}`。`data` 必须是显式 DTO，不能是 Prisma 原始对象。`sources` 包含业务类型、业务单号或记录 ID、查询时间；最终回答只能引用本轮真实返回的来源。

## LLM provider 与 orchestrator 如何配合？

1. `State manager` 创建 `planning` run，`Agent orchestrator` 读取本人最近 8 轮历史和本次问题。
2. `Tool registry` 按当前角色给出 5 个或 6 个领域工具。`operational` 看不到 `finance_query`。AI SDK 负责 DeepSeek 工具参数解析和模型消息组装；工具的 `execute` 回调只委托给本项目的 `Tool executor`。
3. 模型在有限步骤内请求查询。每个工具调用先过 `Tool executor`；返回 `QueryFact` 后，orchestrator 记录来源并更新 `querying` 状态。一次模型请求可提出多个工具调用，但同一 run 内工具调用按顺序执行，避免多个重查询同时压数据库。
4. 查询结束后重查角色，调用 `streamAnswer`，关闭工具调用。只有最终回答阶段产生 `answer_delta`，不会把模型的规划文本或推理内容送到浏览器。
5. 流结束后校验来源 ID 属于本轮事实，写入最终答案和 `completed` 事件。无事实时只能要求补充条件或明确“未查到”，不能编造业务结论。

工具步骤和运行时间要有上限，防止模型循环或服务故障长期占用并发许可；这与**输入 token 不限额**是不同控制项。DeepSeek 的模型上下文窗口仍然存在。若提供商返回上下文过长错误，run 进入 `failed/MODEL_CONTEXT_EXCEEDED`，系统不静默删减用户原话或最近 8 轮。模型名、端点、超时和最多工具步骤均为服务端配置；Web 不接触模型密钥。具体模型 ID 在接入时按 DeepSeek 官方接口核对。

## 工具注册和查询执行如何划清责任？

每个领域工具在模型侧只接受以 `operation` 区分的固定 JSON 对象，例如 `{operation:"search_orders",q,page}` 或 `{operation:"get_receipts",order_no,page}`；不接受任意 `filters` 字典。`search_orders` 可用搜索词；其余操作先由只读连接查未软删的销售单，确认当前 `order_no`，再按该单关联读取。输入中的 UUID、客户名或供应商名不能直接变成跨订单查询范围。分页、日期和状态值由各操作校验；不接受额外字段。

`Tool executor` 的顺序固定：

```text
查 registry → 验证 name/operation/参数 → 重查用户档位 → 核对当前订单
→ 使用只读连接查询 → 按档位投影字段 → 生成来源 → 限制返回行数/字节数
→ 交给模型；浏览器只收到工具名称和完成/失败状态
```

两档权限作用在**字段投影**。`operational` 不得从销售单、采购单、生产日报、工作台汇总、审计详情或自由 JSON 快照里得到价格、金额、工资、应收应付、成本利润、银行账号等字段。对没有可审计投影的现有服务，不直接复用返回值；先复用其纯查询口径或领域计算函数。工具运行所用的 Prisma client 必须连接只读数据库账号。角色重查也走这个账号的 `users/roles/user_roles` 读取授权。agent 会话状态走另一组只可读写 `agent_*` 表的凭据。现有 API 进程仍持有原业务凭据，认证守卫用它验证 Cookie；它不注入模型可达的工具路径。registry/executor 不注入全局 `PrismaService`、任意 HTTP 客户端或业务写服务。

初始能力目录按[上位设计的 operation 清单](business-query-agent-v0-architecture-2026-10-23.md#工具如何做到广覆盖而不撑大上下文)实施。每个 operation 需在注册表记录：所属领域、最低档位、输入 schema、业务查询函数、输出 DTO、来源类型、默认分页与最大行数。领域工具的输入采用按 `operation` 区分的固定 schema；不传任意 `filters` 对象。库存余额读取余额口径，库存事实读取流水口径，两者不能混用。附件仅返回元数据。`get_order_timeline` 必须投影审计详情，不能原样返回任意 JSON。

## 每个 operation 怎样复用现有查询？

下表是**取数口径映射，不是可直接注入的服务清单**。现有服务大多注入全局 `PrismaService`，且同文件有写方法。`沿用`表示沿用其查询条件、计算规则或纯函数，再以只读 client 执行；`新投影`表示必须显式 `select` 或构造允许字段的 DTO。任何行都不能把原服务返回的 Prisma 对象直接交给模型。所有非搜索操作先验证未软删的销售单 `order_no`，限制为该单关联事实。

| operation | 现有口径或读取点 | V0 实现要点 |
| --- | --- | --- |
| `search_orders` | `ReportsService.orders()`；`SalesOrdersService.list()` | 沿用搜索、状态与分页；新投影单号、品名、数量、交期，禁止返回原销售单或关联客户对象。 |
| `get_order_overview` | `OrderWorkbenchService.detail()/summary()` | 沿用数量与进度规则，单独构造非财务汇总；`full` 可另合并财务事实。原返回含应收应付和受财务影响的 `overall_status/blockers`，不得直用或仅删金额字段。 |
| `get_order_status` | `OrderWorkbenchService.summary()`；`ProductionProgressService.listOrderStatuses()` | `operational` 只用非财务事实重新计算状态与阻塞原因；不能从含应收应付的 `overall_status` 结果里删字段了事。 |
| `get_order_timeline` | `OrderWorkbenchService.timeline()`、`ProductionProgressService.timeline()` | 按订单读审计事件；`operational` 仅允许非财务动作类型，投影时间、单据号与固定描述，不传 `details` 自由 JSON。 |
| `get_order_alerts` | `AlertsService.list()`；`ProductionDailyAlertsService.list()` | 复用告警类型与去重规则；按订单下推过滤。现有 `AlertsService.list()` 会聚合全库库存，须改为订单范围的只读查询。 |
| `get_order_attachments` | `AttachmentLink`/`Attachment`，`platform/attachments` | 只解析当前订单及其非财务关联单据的链接；`operational` 不展示可含敏感内容的自由文件名，仅给类型、大小、上传时间和记录 ID；不给存储键、下载 URL 或文件内容。 |
| `get_sales_order` | `SalesOrdersService.get()` | 沿用销售单版本、规格与物料引用口径；按档位新投影。原 `get()` 含单价、金额、客户完整对象。 |
| `get_customer` | 销售单 `customerSnapshot`/客户关联 | 只从已验证订单解析客户；显式选客户名称、编码等允许字段，不能调用无订单约束的 `CustomersService.list()`。 |
| `get_bom` | `BomsService.list()/get()` | 沿用版本及明细排序；新投影物料与用量，排除 `reference_unit_price/reference_currency` 和快照里的财务键。 |
| `get_sales_returns` | `FinishedGoodsOutboundService.listReturns()` | 订单约束读取退货单；`operational` 只投影数量、日期和状态，不透传自由原因、JSON 或附件字段。 |
| `get_purchase_plans` | `PurchasePlansService.list()/get()` | 沿用计划行和状态；新投影。原列表计算计划金额并读取 `unitPrice/currency`，不能直接复用结果。 |
| `get_purchase_orders` | `PurchaseOrdersService.list()/get()` | 沿用采购单状态与到货关系；新投影采购数量、状态、供应商，排除总额、单价、结算与应付关联。 |
| `get_receipts` | `PurchaseOrdersService.get()` 中的 receipts | 按订单及采购单关系读取分批到货，沿用批次序号规则；不返回 payableSources 或结算扩展数据。 |
| `get_incoming_inspections` | `IncomingInspectionsService.list()` | 沿用质检数量和批次规则；新投影并剔除 `extensionData` 中未审计字段。 |
| `get_production_orders` | `ProductionOrdersService.list()/get()` | 沿用生产单、工序顺序和状态；新投影，不传整个 BOM 或生产单原对象。 |
| `get_operation_progress` | `ProductionProgressService.getProductionOrderProgress()/listOrderStatuses()` | 沿用纯进度计算和阻塞规则；若按生产单 ID 查询，先证实它属于当前订单。禁止使用任何重算写入路径。 |
| `get_operation_reports` | `OperationDailyReportsService.list()` | 沿用日期和工序筛选；新投影报工数量、单位、时间，检查备注及关联工序对象。 |
| `get_outsource_flow` | `OutsourceLogisticsService.list()/listReturns()/listDirectShipments()` | 沿用批次、发出、回厂与直发状态；新投影数量和物流节点，剔除采购价、应付来源与自由备注。 |
| `get_raw_material_balance` | `InventoryService.rawMaterialBalance()/rawMaterialBalances()` | 沿用按物料和单位汇总库存事实的口径；从当前订单 BOM 确定物料集合，再查这些物料的**全局实存量**，标明它不是该订单专属库存；不能用 `order_no` 过滤事实后称为余额。 |
| `get_inventory_facts` | `ReportsService.inventory()` | 沿用 `InventoryFact` 流水口径并按订单分页；返回增减量与来源，明确不是余额。 |
| `get_material_movements` | `RawMaterialMovementsService.list()` | 沿用领、退、补、报废单及状态；新投影数量，排除原对象里的自由附件/扩展字段。 |
| `get_finished_goods_qc` | `FinishedGoodsQcService.listQcRecords()`；`ReportsService.productionQc()` | 沿用 QC 与可入库量规则；新投影数量、结论、状态。 |
| `get_finished_goods_inbounds` | `FinishedGoodsInboundNoticesService.list()`；`FinishedGoodsInventoryService.listInbounds()` | 区分通知与实际入库，保留草稿/已过账状态；新投影，避免整块 `qcRecord/inventoryFacts` 透传。 |
| `get_finished_goods_outbounds` | `FinishedGoodsOutboundService.listOutbounds()` | 沿用出库状态与退货关联；必须重写 `select`/DTO：现有返回的 `salesOrder` 含 `unitPrice/settlementUnitPrice/receivableAmount`。 |
| `get_receivables` | `ReceivableService.list()/orderSummary()` | 仅 `full`；按订单读取来源、状态、余额和币种，沿用已过账分摊口径。 |
| `get_customer_payments` | `CustomerPaymentService.list()/orderSummary()` | 仅 `full`；按订单读取收款及分摊，银行账号是否展示仍须显式列入财务 DTO。 |
| `get_payables` | `SupplierPayableService.list()/orderSummary()` | 仅 `full`；按订单读取应付来源、状态、余额，沿用已过账付款口径。 |
| `get_supplier_payments` | `SupplierPaymentService.list()/orderSummary()` | 仅 `full`；按订单读取付款及分摊，金额和币种留在财务 DTO 内。 |
| `get_reconciliations` | `ReconciliationService.list()`；`SupplierPayableReconciliationService.list()` | 仅 `full`；限定订单及其客户/供应商关联，再投影对账期间、状态和金额。 |
| `get_order_cost_profit` | `FinanceReportQueryService.salesGrossProfit()/costAccounting()` | 仅 `full`；传精确订单号，沿用出货、采购成本、人工等口径及脚注；无可核算数据要说明，不能自行补算。 |
| `get_order_payroll` | `FinanceReportQueryService.costAccounting()` 的订单人工合计；`EmployeeDailyReportsService.list()` | 仅 `full`；给出该订单人工合计及分页的订单关联计件/计时日报，显式选员工、工序、数量、单价、金额。不得扩张为全员薪资台账或透传员工完整对象。 |

> `ponytail:` 能沿用领域纯函数与查询规则时不复制一套报表算法；现有服务如果绑定写权限或返回宽对象，就只沿用口径，在只读 client 上构建窄查询和 DTO。此方式的上限是查询口径可能与原服务漂移；实施时对关键样例做同单据对照，出现漂移再抽公共纯函数。

## API 权限与数据表如何落地？

沿用现有会话 cookie 和 `/api/v1` 返回信封。创建会话、读取会话、创建 run、取消 run、订阅 SSE 都先经过 `AuthenticationGuard` 和新 `QueryPermissionGuard`。归属校验以 `userId` 加资源 ID 查询，不先按 ID 取出他人的会话再做过滤。角色重查限定 `users.is_active = true`、用户未软删、`roles.deleted_at IS NULL`；只选判权所需列，不读取密码哈希。`full` 只由当前有效 `laoban/caiwu` 角色取得；有其他有效角色的用户为 `operational`；无有效角色拒绝。不能用 `surface_scope` 或前端的 `surface_sections` 决定数据档位。

JSON 协议保留 `data/meta` 信封。`POST /sessions/:id/runs` 请求体是 `{question,client_message_id}`：`question` 必须是非空字符串，但不按 token 数或字符数另设产品配额；`client_message_id` 是客户端生成的 UUID。成功返回 HTTP 202 和 `{data:{run_id,state:"planning"},meta:{}}`。相同幂等键且问题相同返回原 run；键相同而问题不同返回 `409 IDEMPOTENCY_CONFLICT`。`GET /sessions` 列本人会话；`GET /sessions/:id` 返回会话内当前档位可见的 run 状态、答案（活动 run 从已持久化 `answer_delta` 拼接）、已完成来源和对应的 `latest_seq`，让刷新页能恢复内容并从该序号续接。取消返回 `{data:{state:"cancelled"},meta:{}}`。

SSE 在发送首个事件前校验身份、归属和当前档位；此时的 401/403 仍按现有 JSON 错误信封返回。开始流式传输后，运行失败和取消分别通过版本化 `error`、`cancelled` 终态事件报告，随后关闭连接。正常完成时 `completed` 事件包含最终 `{answer,sources,usage}`。连接到已完成的 run 时，服务端重放未见事件并在终态事件后关闭。每次发送或重放数据事件前重查档位；降权者不能读取旧 `full` run。已建立的连接只发不含业务内容的 `error/ACCESS_REVOKED` 后关闭；浏览器收到该事件或在重连时收到 403，清除当前 `full` run 的可见片段与缓存。

新增三张 agent 自有表：

| 表 | 必要字段与约束 | 用途 |
| --- | --- | --- |
| `agent_sessions` | `id`、`user_id`、创建/更新时间 | 用户自己的会话容器；所有查询必须带 `user_id`。 |
| `agent_runs` | `id`、`session_id`、`user_id`、`client_message_id`、`question`、`answer`、`access_level`、`state`、`error_code`、`usage`、时间戳 | 一轮问答；`(session_id, client_message_id)` 唯一；活动状态下 `user_id` 部分唯一，阻止同一用户在多个会话里同时运行。 |
| `agent_run_events` | `run_id`、`seq`、`type`、`payload`、时间戳；`(run_id, seq)` 唯一 | SSE 重放和恢复。序号由 State manager 在事务中分配。 |

`question/answer/payload` 可能包含业务信息，查询权限和保留期按财务数据处理；每轮保存创建时 `access_level`。运行中的有效档位是创建时与当前档位的较低者，升权要开新 run 才能用新工具。当用户从 `full` 降为 `operational`，其旧 `full` run 不进入上下文，也不能通过快照或 SSE 重放读取。角色在运行中改变时，后续工具、最终回答和 SSE 数据事件均重新校验并终止不再获准的运行。已在授权期间发送给浏览器的内容无法收回，前端不得把它复制到新档位的会话上下文。

## 并发控制具体怎样工作？

`POST /sessions/:id/runs` 按下面顺序处理：

1. 校验会话归属和问题 JSON；先按 `(sessionId, clientMessageId)` 查幂等结果。相同键且问题相同、当前仍有权读取该 run，才返回既有 `run_id`，不再调用模型；问题不同则返回 `409 IDEMPOTENCY_CONFLICT`，已降权的旧 `full` run 返回权限错误。
2. 检查该用户是否已有活动 run；有则返回 `409 RUN_IN_PROGRESS`。
3. 调用进程内 `ConcurrencyGate.tryAcquire()`。4 个许可均被占用时返回 `429 AGENT_BUSY`、`Retry-After: 3`，不创建 run。
4. 在数据库事务里创建 `planning` run 和初始事件。若另一请求在步骤 2 后抢先创建，则检查冲突类型：同幂等键且同问题返回既有 run；不同问题或同用户另一活动 run 返回 `409`。这两种路径都释放刚取得的许可。
5. API 返回 `202 {data:{run_id,state:"planning"},meta:{}}`，本进程开始编排。编排的 `finally` 无条件释放许可。前端遇到 `429` 保留提问草稿，由用户重试；不自动建队列。

部分唯一约束是跨同进程竞态的最后闸门，需在 PostgreSQL 迁移中建立 `WHERE state IN ('planning','querying','responding')` 索引；进程内许可只控制总负载。`transitionAndAppend` 以当前状态为条件更新，在同一事务中写事件，取消后迟到的模型结果不能再写 `answer_delta/completed`。当前部署是单 API 进程。若未来增加副本，先替换全局许可与任务领取机制，再扩大部署；不能继续把每个进程的“4”误当成全局“4”。启动时把遗留非终态 run 标为 `failed/INTERRUPTED`，不自动重放模型调用。

## SSE 与前后端状态机怎样恢复？

前端先 POST 创建 run，再以 cookie 认证建立 `GET /runs/:id/events` 的 SSE。服务端发 `id: <runId>:<seq>` 和 `data: {v,run_id,seq,type,at,data}`；`Last-Event-ID` 必须匹配当前 `runId`，`after_seq` 必须是非负整数，两者只决定重放起点，不能代替归属校验。服务端先重放数据库事件，再持续读取新事件；轮询与重放之间按持久 `seq` 连续读取，避免遗漏。V0 少用户场景可短间隔轮询事件表，不增加 Redis 或消息总线。`answer_delta` 可以合并成较少的事件再持久化；心跳是 SSE 注释，不写事件表。浏览器按 `seq` 去重，直到收到 `completed/error/cancelled` 才认定终态。

后端初态是 `planning`，允许 `planning → querying → responding → completed`；澄清问题可由 `planning → responding`。活动状态均可到 `failed/cancelled`。终态不能离开。前端状态是 `idle → submitting → connecting → streaming → done`，并支持 `disconnected`、`error`、`cancelled`；`disconnected` 可回到 `connecting/streaming/done/error/cancelled`。断线只重连 SSE，不重复 POST；刷新页面先读会话快照恢复答案和状态，再按最后**已应用**事件序号续接。取消请求让 run 进入 `cancelled` 并触发模型请求的 `AbortSignal`；已经发出的只读数据库查询可能完成，但其结果不得再进入模型或 SSE。

## 怎样观察问题，又不泄露业务数据？

复用现有 `StructuredLogger`、请求 ID 和 API 错误信封。每轮结构化记录 `run_id`、`user_id`、档位、模型、工具 operation、结果行数、耗时、token 用量、状态、错误码和权限拒绝次数。默认日志不写 prompt、答案、工具参数中的业务值或查询结果。SSE 的 `tool_status` 只展示“正在查询采购到货”等固定文案。模型提供商错误只映射为稳定的 API 错误码；原始响应体不回传给浏览器。

V0 先观察三项：同时活动 run 数、成功/失败/取消比例、单轮模型用量与耗时。不引入新的监控平台。若响应慢，先查是哪一个已有查询服务耗时，而不是扩大并发上限。

## 最小验收集是什么？

| 风险 | 可运行检查 |
| --- | --- |
| 越权读取 | `qita/renshi` 不能调用 `finance_query`，也不能从其他 5 个工具、SSE、历史记录取得财务字段；`laoban/caiwu` 能取得。 |
| 跨用户会话 | 用户 B 对用户 A 的会话快照、run、SSE 与取消请求全部拒绝。 |
| 竞态与幂等 | 同一用户并发两次不同问题只创建一个活动 run；相同 `client_message_id` 只调用一次模型；5 个不同用户同时请求时最多 4 个进入运行。 |
| 只读 | 所有业务查询使用只读数据库账号；提示注入请求写单、执行 SQL、改文件均找不到可调用工具。 |
| 状态与流 | 失败、取消、重启中断均落终态并释放许可；SSE 断开重连不重复工具调用，事件序号不倒退。 |
| 上下文 | 第 9 轮不包含第 1 轮；不因应用层 token 预算裁剪用户问题；模型窗口超限返回明确错误。 |
| 业务口径 | 订单、采购、生产、库存、财务各取真实样例，与已有页面/领域服务核对数值、单位、状态及软删过滤。 |

## 范围外与待定项是什么？

V0 不做业务写入、代码修改、任意 SQL/HTTP、文件内容读取、动态插件、分布式队列或多副本部署。输入 token 没有应用层配额；DeepSeek 自身窗口限制仍由模型决定。

待定口径只有两项，实施前用真实账号和真实订单样例确认：① 客户联系人电话、地址是否对 `operational` 可见；② DeepSeek 使用公有 API 还是企业内网端点。两项不影响模块 Interface，但影响字段投影与部署配置。

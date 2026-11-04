# 业务查询 Agent V0 工程布局

> 类型：工程设计｜创建：2026-10-23｜修订：2026-10-25｜状态：待评审  
> 本文锁定工程形态、只读边界、两档数据权限、会话与流式协议。模型的具体套餐和部署密钥留在部署配置中。

## 决定：V0 如何接入？

在现有 NestJS API 内新增独立的 `business-query-agent` 模块，Next.js 增加查询页。模型默认走 DeepSeek；模型调用、工具调用与流式解析优先复用 `ai` 和 `@ai-sdk/deepseek`，不自写 LLM 协议解析器。业务查询工具复用现有领域查询口径，但只通过固定的只读工具入口调用。模型没有任意 HTTP、SQL、shell、文件、代码修改或业务写入能力。会话按 `userId + sessionId` 隔离，最近 8 轮进入模型上下文，**应用层不设输入 token 上限**。前端与后端各维护明确的运行状态，并通过 JSON 与 SSE 同步。当前规模采用单用户一个活动 run、进程内最多 4 个活动 run 的简单并发控制，不引入队列。主要风险是现有页面权限不能直接当作数据权限，必须在新 API 和每次工具执行时独立校验。

## 为什么采用这个形态？

- 现有应用已有会话认证、NestJS 守卫、Prisma、订单工作台、报表和领域服务。新模块复用这些能力，不建立第二套账号和业务规则。代码入口见 `apps/api/src/app.module.ts`、`platform/auth`、`platform/authorization`、`modules/order-workbench` 和 `modules/reports`。
- 当前四个表面角色的后端模块授权基本等同管理员；页面可见范围由 `surface_sections` 控制。工作台 API 返回应收与应付汇总，前端才隐藏财务卡片。因此 agent 不能复用 `@RequireAnyModules(...)` 作为两档数据权限的唯一闸门。
- [DeepSeek 官方接口](https://api-docs.deepseek.com/api/create-chat-completion/)支持工具调用、JSON 输出和 SSE。模型返回的工具参数仍须由应用校验。模型地址、模型名和密钥只在 API 服务端配置；每次只发送回答所需的投影字段。
- [AI SDK 的 DeepSeek provider](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek)提供模型适配与流式工具调用；[AI SDK 工具循环](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)提供有上限的多步调用。`ai` 与 `@ai-sdk/deepseek` 当前尚未安装，实施时只增加这两个协议依赖，以免自写模型流和工具调用解析；业务权限和状态仍由本项目控制。
- [DeepSeekHarness](https://github.com/deepseek-ai/deepseek-harness)的会话事件日志、工具注册和执行管线可作设计参考。但其 SDK 启动的是完整 Harness 子进程；即使 `sdk-minimal` 也默认带可写 shell。[项目安全声明](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)明确它仍是未完成安全审计的开发预览。V0 不把完整编码 agent 运行时嵌入 ERP。

## 模块放在哪里？

| 模块 | 建议位置 | 对外 Interface 与职责 |
| --- | --- | --- |
| LLM provider | `apps/api/src/modules/business-query-agent/llm-provider.ts` | `stream(request, signal)`；封装 DeepSeek 模型、超时、用量与错误映射，内部使用 AI SDK。 |
| Agent orchestrator | `.../agent-orchestrator.ts` | `startTurn(user, session, question)`；协调鉴权、上下文、工具循环、状态和事件；限制工具步骤与运行时间。 |
| Tool registry | `.../tools/tool-registry.ts` | 注册静态只读工具描述、输入协议、数据级别和来源；按权限生成固定的领域工具集。 |
| Tool executor | `.../tools/tool-executor.ts` | `execute(call, principal, signal)`；再次校验工具权限和参数，只调用已注册实现，限制行数、时间与输出大小。 |
| orderQueryTools | `.../tools/order-query-tools.ts` 及按领域拆分的相邻文件 | 订单、销售、采购、生产、仓库、质检、财务的只读查询；返回筛选后的事实和来源标识。 |
| Permission guard | `.../query-permission.guard.ts`、`.../tools/tool-permission.ts` | API 层校验登录者、会话归属及角色档位；工具层重查当前档位与字段可见性。 |
| Context manager | `.../context-manager.ts` | 只取该用户该会话最近 8 个已完成轮次；不按输入 token 裁剪，旧工具原始结果不进入后续轮次。 |
| State manager | `.../state-manager.ts` | 持久化 session、run 和事件；负责幂等、单用户单活动 run、合法状态迁移及恢复。 |
| Concurrency gate | `.../concurrency-gate.ts` | 进程内最多同时执行 4 个 run；无空位返回 `AGENT_BUSY`，不建队列。 |
| Stream transport | `.../stream-transport.ts`、`.../business-query-agent.controller.ts` | JSON 请求/响应、SSE JSON 事件、心跳、断线续接和取消。 |
| Observability | `.../observability.ts` | 记录 `requestId/runId/userId`、模型、token、工具名、耗时、拒绝原因与错误码；默认不记录问题全文和业务结果。 |
| Web 状态机 | `apps/web/lib/business-query-state.ts` | 纯状态迁移与 reducer，供查询页复用及单测。 |
| Web 查询页 | `apps/web/app/business-query/page.tsx` | 展示提问、流式回答、来源、工具进度、取消、重连和错误。 |
| 页面权限映射 | `platform/authorization/surface-scope.ts`、`apps/web/lib/surface-permission.ts`、`app-shell.tsx` | 新增“业务查询”栏目，四类表面角色都能进入；数据档位只由后端判断。 |

各模块的 Interface 不暴露 Prisma、DeepSeek 消息格式或前端视图模型。`Agent orchestrator` 是唯一编排入口；`Tool executor` 是唯一执行入口。第一版只有一个模型 provider，不为假设中的其他 provider 先造适配层。

## 请求如何流转？

```text
浏览器 JSON 请求 → API Permission guard → State manager 建立 run
                                      ↓
浏览器 SSE ← Stream transport ← Agent orchestrator
                                      ├─ Context manager → 本人最近 8 轮
                                      ├─ LLM provider → DeepSeek
                                      └─ Tool registry → Tool executor → Tool Permission → 只读业务查询
                                                                            ↓
                                                                       脱敏事实与来源
```

模型只能看到本轮获准的工具描述和已经过滤的数据。编排分为有上限的查询步骤和最终回答步骤：查询步骤允许工具调用，最终回答步骤关闭工具并通过 SSE 流式输出。模型输出中的“请调用其他接口”“执行命令”等文本只是文本，不能扩充 registry。数据库字段、客户备注和单据备注同样视作不可信输入。每个 run 的可见范围取**创建时档位与当前档位的较低者**；运行中升权不会扩张本轮工具集，降权会中止原 `full` run。

## 两档权限如何判定？

| 档位 | 服务端角色条件 | 可用查询 |
| --- | --- | --- |
| `full` | 当前有效角色含 `laoban` 或 `caiwu` | 所有已注册订单查询，含财务金额、价格、工资及对账信息。 |
| `operational` | 已登录且有有效角色，但不含上述 full 角色；包括 `qita`、`renshi` 和单独的 `administrator` | 订单全链路的非财务信息：单号、客户与产品、BOM、采购数量、到货、质检、库存、生产进度、出入库、告警等。 |
| 拒绝 | 未登录、无有效角色、会话不属本人 | 不创建运行，不返回会话内容。 |

多角色取最高档。`administrator` 不因现有模块全授权而自动取得 `full`；如管理员需要查询财务，应显式分配 `laoban` 或 `caiwu`。API 层对创建、列出、读取、取消 run 逐项校验 `userId`；工具层每次执行前重新读取有效角色，不信任前端传来的档位。SSE 发送数据事件和断线续接时也重查档位。

**财务字段按数据而非页面划分。** `operational` 输出不得包含销售价、采购价、金额、币种与汇率、应收应付、收付款、利润成本、工资单价与金额、银行账号。销售、采购或生产工具即使读取到这些字段，也必须在送入模型和 SSE 前投影为非财务 DTO，不能返回原始 Prisma 对象或 `customerSnapshot`。权限被降级时，旧 `full` 上下文不可再送入模型，既有流式运行立即取消；历史会话按新档位拒绝访问包含财务内容的轮次。用户自己输入的问题可原样保存在本人会话中，但不能让模型把未授权的业务事实补进去。

**待确认口径：** 客户联系人的电话、地址在本方案中按非财务订单信息处理；若该类个人资料也要限制，应在工具投影中另列隐私等级。

## 工具如何做到广覆盖而不撑大上下文？

Registry 覆盖以下只读能力，初版以已有服务口径为准。为避免把二十多个 schema 反复送给模型，模型只看到 6 个领域工具：`order_query`、`sales_query`、`procurement_query`、`production_query`、`warehouse_query`、`finance_query`。每个领域工具以受限的 `operation` 枚举分发到下表的内部查询能力；`finance_query` 只对 `full` 档可见。没有关键词预分类器，任何订单问题都能访问其档位允许的领域工具。每个内部能力仍有自己的输入 schema、最大返回行数、超时、数据级别和业务来源。

| 领域 | 能力目录 | 可复用口径 |
| --- | --- | --- |
| 订单/销售 | 搜索订单、订单概览、状态与阻塞、时间线、附件元数据、销售单明细、客户快照筛选 | `order-workbench`、`sales-orders`、`attachments` |
| BOM/采购 | BOM 与明细、采购计划、采购单、分批到货、来料质检 | `boms`、`purchase-plans`、`purchase-orders`、`incoming-inspections` |
| 生产 | 生产单、工序进度、工序日报、外加工流转、生产告警 | `production-progress`、`production-orders`、`operation-daily-reports`、`outsource-logistics` |
| 仓库/质检 | 原料库存余额、库存事实、领退报废、成品质检、入库通知与入库、出库与退货 | `inventory`、`raw-material-movements`、`finished-goods-*` |
| 财务（仅 full） | 应收与收款、应付与付款、对账、利润与成本、订单关联工资来源 | `finance`、`finance-report-query`、`payroll` |

内部 `operation` 清单建议如下，名称也是审计日志与测试的稳定标识：

| 模型可见工具 | 内部 `operation` |
| --- | --- |
| `order_query` | `search_orders`、`get_order_overview`、`get_order_status`、`get_order_timeline`、`get_order_alerts`、`get_order_attachments` |
| `sales_query` | `get_sales_order`、`get_customer`、`get_bom`、`get_sales_returns` |
| `procurement_query` | `get_purchase_plans`、`get_purchase_orders`、`get_receipts`、`get_incoming_inspections` |
| `production_query` | `get_production_orders`、`get_operation_progress`、`get_operation_reports`、`get_outsource_flow` |
| `warehouse_query` | `get_raw_material_balance`、`get_inventory_facts`、`get_material_movements`、`get_finished_goods_qc`、`get_finished_goods_inbounds`、`get_finished_goods_outbounds` |
| `finance_query` | `get_receivables`、`get_customer_payments`、`get_payables`、`get_supplier_payments`、`get_reconciliations`、`get_order_cost_profit`、`get_order_payroll` |

除 `search_orders` 外，内部能力都必须以当前有效 `order_no` 为根解析关联数据；`get_customer` 不能用任意客户 ID 查询客户池。目录中的“库存余额”应使用余额口径；现有 `reports.inventory()` 返回库存变动记录，不能直接当余额。任何只读方法若会触发重建、同步或审计写入，就不进入工具集。禁止把通用 GET/HTTP、`ReportsService.query(report: string)` 的任意报告名、Prisma client 或 SQL 编辑器直接暴露给模型。

## JSON 与 SSE 协议是什么？

保留现有 `/api/v1` 前缀：

| 方法与路径 | 返回 | 用途 |
| --- | --- | --- |
| `POST /business-query/sessions` | JSON `{session_id}` | 建立本人的会话。 |
| `GET /business-query/sessions` | JSON 会话列表 | 只列本人当前档位可见的会话摘要。 |
| `GET /business-query/sessions/:id` | JSON 会话快照 | 刷新后恢复，服务端按本人过滤。 |
| `POST /business-query/sessions/:id/runs` | JSON `{run_id,state}` | 提交问题；请求带 `client_message_id` 幂等键；忙碌时返回 409 或 429。 |
| `GET /business-query/runs/:id/events` | `text/event-stream` | 从 `Last-Event-ID` 续接事件；只允许 run 所属用户。 |
| `POST /business-query/runs/:id/cancel` | JSON `{state}` | 取消 agent 运行，仅改 agent 状态，不操作业务数据。 |

每条 SSE `data` 是 JSON：`{v:1,run_id,seq,type,at,data}`。`type` 固定为 `state`、`tool_status`、`answer_delta`、`source`、`usage`、`completed`、`cancelled` 或 `error`；`seq` 单调递增，供断线去重。`tool_status` 不发原始参数或结果。`completed` 带最终结构化结果 `{answer,sources,usage}`，来源由服务端工具结果生成，不能只采信模型自报。`cancelled` 和 `error` 也是终态事件。心跳使用 SSE 注释。前端使用 `fetch` 或 `EventSource` 读取 GET SSE；浏览器不会收到 DeepSeek 原始事件。

## 前后端状态机如何对应？

| 后端 run 状态 | 合法下一状态 | 前端状态 | 可见行为 |
| --- | --- | --- | --- |
| `planning`（初态） | `querying/responding/failed/cancelled` | `submitting/connecting` | 读取上下文与选择工具。 |
| `querying` | `responding/failed/cancelled` | `streaming` | 展示已脱敏的工具进度。 |
| `responding` | `completed/failed/cancelled` | `streaming` | 累积答案片段。 |
| `completed` | 无 | `done` | 显示最终答案和来源。 |
| `failed/cancelled` | 无 | `error/cancelled` | 保留已收到的片段但标记为未完成，可新开 run。 |

前端另有 `disconnected`：SSE 断开后读取 run 快照并用最后 `seq` 续接，不重新提交同一问题。后端以数据库状态为准；客户端状态只驱动展示。每个用户最多一个活动 run，即使他开启多个会话也是如此。相同 `client_message_id` 返回既有 run；不同问题遇到本人活动 run 返回 `409 RUN_IN_PROGRESS`。

**并发与部署假设：** V0 沿用当前单个 API 进程，不增加分布式队列。全进程同时最多 4 个 run；第 5 个请求返回 `429 AGENT_BUSY` 和 `Retry-After`，不创建 run，前端保留问题供用户重试。许可必须在运行结束或失败时释放。`POST /runs` 持久化后启动本进程的编排任务；进程重启时，State manager 将遗留的非终态 run 标为 `failed/INTERRUPTED` 并写终态事件，用户可新开 run。多个 API 副本运行之前，需要补上共享并发控制与任务领取机制。

## 会话、成本与可观测性如何控制？

- 仅 agent 自有的 `agent_sessions`、`agent_runs`、`agent_run_events` 可写；业务表只读。会话查询一律加 `userId` 条件，禁止只凭 UUID 获取。原始工具结果不持久化到下一轮上下文。
- Context manager 保留最近 **8 轮**已完成问答，不按输入 token 数裁剪用户问题或这 8 轮上下文，也不在 V0 自动发起摘要模型调用。DeepSeek 自身上下文窗口仍是硬限制；若提供商拒绝过长请求，返回明确的 `MODEL_CONTEXT_EXCEEDED`，不静默删改问题。工具结果仍按查询行数、字节数和字段投影限制；这些是数据库与输出保护，不是输入 token 配额。单轮模型步骤和工具次数另设上限，具体阈值在性能测试后固化。
- 每轮记录模型、token 用量、耗时、工具名与数量、拒绝次数、最终状态及来源 ID。默认日志不记录完整问题、模型上下文、原始工具结果或个人资料；持久会话内容设明确保留期与清理策略。
- 全部业务读取及角色重查通过单独的数据库只读账号。agent 状态写入使用另一组仅限 `agent_*` 表的权限。现有认证守卫继续验证 Cookie，但其常规 Prisma 连接不进入模型可达的查询路径。若现有领域服务无法注入只读连接，先抽出其纯查询口径或复用领域纯函数，不为了复用而给 agent 宽泛写权限。具体 operation 与现有代码的映射见[模块细化设计](business-query-agent-v0-module-design-2026-10-25.md#每个-operation-怎样复用现有查询)。
- **外部模型假设：** 若调用 DeepSeek 公有 API，经投影的订单事实会离开本系统。部署前应按企业数据政策确认该路径；如果要求数据留在内网，仍沿用同一 provider Interface，改配受控的内网模型端点。

## 如何验收与回退？

1. **权限门禁**：两档角色分别请求同一订单；`operational` 的 API、工具结果、SSE、历史上下文均不得出现任一财务字段。运行中降权必须停止后续工具调用与输出。
2. **只读证明**：对全部已注册工具做静态清单检查与集成测试；使用只读数据库账号运行查询，业务写入尝试应由数据库拒绝。测试提示注入要求写单、执行 SQL、读文件或改代码时，registry 不存在对应能力。
3. **会话隔离**：用户 B 读取、续接或取消用户 A 的 session/run 均返回 403/404；断线续接不能重复执行工具。第 9 轮不再把第 1 轮送入模型。
4. **状态与流式**：后端所有状态迁移有单测；前端 reducer 覆盖完成、失败、取消、断线续接；SSE 用 UTF-8 分块、事件去重和终态测试验证。
5. **答案核对**：每个领域选真实业务样例，对照现有页面或领域服务；库存、金额、单位、状态和软删除口径逐项校验。

回退时关闭 agent 入口与模型调用配置；不触碰业务表。保留 agent 自有会话表供排查，待保留期到期后清理。

## V0 明确不做什么？

不开放写业务数据、确认/处理告警、导入导出、任意 SQL/HTTP、shell、文件读写、代码修改、动态插件安装和外部网页搜索。附件只查元数据，不读取或解析二进制内容。`POST /runs` 与 `POST /cancel` 只管理 agent 自身会话，不改变业务事实。V0 不做长期记忆、跨用户共享会话或自主后台任务。

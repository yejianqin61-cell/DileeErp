# 业务查询 Agent V0 实现完成度评估

评估日期：2026-10-27
窗口：2026-10-23（首份架构设计）至 2026-10-27（HEAD `a71b704`）
基线：三份上游设计（工程布局、模块细化设计、开发计划）与 6 个阶段的 36 份任务单
代码版本：`a71b704`，API 模块 33 个文件 2,556 行；前端 19 个文件 2,304 行

状态词只用三个：**完成**（实现且接线，有可指认的文件）；**部分**（实现存在，但在册能力或设计硬约束有缺口）；缺失（设计有要求，仓库里没有实现）。

## 1. 头条

**能力已经成形，验收没有签核：54 个实现类功能点里 33 个完成、19 个部分、2 个缺失。**

| # | 层 | 功能 | 对应文件 | 状态 |
|---|---|---|---|---|
| L-1 | 数据 | 3 张 `agent_*` 表、单用户单活动 run 部分唯一索引 | `prisma/schema.prisma`、`prisma/migrations/20261025100000_business_query_agent_tables/` | 完成 |
| L-2 | 权限 | full/operational 两档、守卫、降权收口 | `business-query-agent/access-level.ts`、`query-permission.guard.ts` | 完成 |
| L-3 | 工具 | 6 个领域工具、31 个 operation、只读执行器 | `business-query-agent/tools/tool-registry.ts`、`tools/tool-executor.ts` | 部分 |
| L-4 | 编排 | planning → querying → responding → completed | `business-query-agent/agent-orchestrator.ts` | 部分 |
| L-5 | 流与状态 | SSE 重放/心跳/取消、事务内状态迁移 | `business-query-agent/state-manager.ts`、`stream-transport.ts` | 完成 |
| L-6 | 模型 | DeepSeek 接入、5 类稳定错误码、fake/deepseek 切换 | `business-query-agent/deepseek-llm-provider.ts`、`model-errors.ts` | 完成 |
| L-7 | 上下文 | 最近 8 轮已完成问答、降权过滤旧 full 轮 | `business-query-agent/context-manager.ts` | 完成 |
| L-8 | 并发 | 4 许可/进程、`429 AGENT_BUSY`、不排队 | `business-query-agent/concurrency-gate.ts` | 完成 |
| L-9 | 观测 | 每 run 一条结构化日志、不含业务正文 | `business-query-agent/observability.ts` | 部分 |
| L-10 | 前端 | 迪礼顾问对话页、reducer、SSE 客户端、9 个组件 | `app/business-query/page.tsx`、`lib/business-query-state.ts`、`components/agent/` | 完成 |
| L-11 | 运维 | 生产配置硬门禁、回退开关、只读账号证明脚本 | `platform/config/validate-environment.ts`、`scripts/verify-agent-database-privileges.mjs` | 部分 |

常规：31 个 operation 的逐个投影、9 个前端组件、37 个测试文件不占头条，逐条列在附录 A、B、C。

## 2. 这意味着什么

主链路在生产上真的跑通了：提问 → 先 `search_orders` 拿准订单号 → 领域工具 → 流式回答 → 来源 → 刷新恢复，`8238430` 上的一次真实提问连续调用 15 次工具并给出带来源的答案。

代码层面的缺失只剩 2 项（双角色验收、会话保留期清理）；压在 19 个「部分」背后的东西更像同一件事：设计写定的硬约束被实现悄悄放宽了（工具预算 8 变 16、注册表没登记输入 schema 与超时），而验证链断在「有脚本、无结果」。

## 3. 仍未关闭

- Phase 6 的真实 DeepSeek 双角色验收零产物，所以 `full` 与 `operational` 的真实输出边界至今没有签核。
- 会话保留期没有落地任何清理任务，含财务级问答内容的 `agent_runs` 会长期留在库里。
- 工具层没有单工具超时，注册表也没登记输入 schema、超时与来源类型，长查询只靠 run 级 120 秒兜底。
- 幂等竞态下唯一约束冲突一律转 409 `RUN_IN_PROGRESS`，同一个 `client_message_id` 并发重试拿不到原 run。
- 降权用户重连收到 403 时页面只弹提示、不清空已渲染的财务片段，设计要求两路都清。
- 前端不感知 `BUSINESS_QUERY_ENABLED`，关闭后仍能进页；SSE 403 一律提示「当前档位无法读取」，与实际原因不符。
- 观测缺 requestId/traceId，HTTP 请求与 Agent 日志无法互相定位。
- 权限证明脚本从未留下一次 `AGENT_DATABASE_PRIVILEGE_OK` 产物，31 个 operation 的真库对照被 `TEST_DATABASE_URL` 门禁挡在门外。
- 三份上游设计、五份评审报告仍是未跟踪文件，证据无法按版本复现。
- `docs/review` 里 P1-3（前端错误码被终态锁吞）、P1-4（控制器未捕获编排器拒绝）、P1-5 三项仍未修。

## 附录 A：后端 38 条

路径前缀省略 `apps/api/src/modules/business-query-agent/`；测试文件用仓库相对路径。

| # | 功能点 | 文件（证据） | 状态 | 缺口 |
|---|---|---|---|---|
| B-1 | P1-T1 三表与迁移 | `prisma/schema.prisma:3261-3312`；`migrations/20261025100000_business_query_agent_tables/migration.sql:19-60` | 完成 | 与设计一致，无业务表外键 |
| B-2 | P1-T2 档位与权限守卫 | `access-level.ts:19-27`；`query-permission.guard.ts:38-54` | 完成 | 角色重查走只读连接 |
| B-3 | P1-T2 状态管理器 | `state-manager.ts:33-148` | 完成 | 状态与事件同事务提交 |
| B-4 | P1-T3 只读工具链 | `query-read-client.ts:11-19`；`tools/tool-registry.ts:26-95`；`tools/tool-executor.ts:30-99` | 部分 | 注册表缺输入 schema、超时、来源类型 |
| B-5 | P1-T4 编排器/SSE/6 路由 | `business-query-agent.controller.ts:17-158`；`agent-orchestrator.ts:80-191`；`stream-transport.ts:23-98` | 部分 | 预算 16 调用/4 轮，定案是 8，且硬编码 |
| B-6 | P1-T6 隔离与只读证据 | `apps/api/test/integration/business-query-agent.test.cjs:19-92`；`apps/api/test/http/business-query-contract.test.cjs:41-126` | 完成 | 文件齐备，本次未复跑 |
| B-7 | P2-T1 并发许可闸 | `concurrency-gate.ts:9-34`；`business-query-agent.controller.ts:98-127` | 完成 | 单进程语义，注释已声明 |
| B-8 | P2-T2 八轮上下文与多步循环 | `context-manager.ts:16-34`；`agent-orchestrator.ts:115-190` | 完成 | 不带旧工具原文 |
| B-9 | P2-T3 DeepSeek provider | `deepseek-llm-provider.ts:70-155`；`model-errors.ts:19-43`；`llm-provider-factory.ts:18-26` | 完成 | 生产强制 deepseek + 密钥 |
| B-10 | P2-T4 结构化观测 | `observability.ts:12-40`；`agent-orchestrator.ts:118,183-190` | 部分 | 缺 requestId/traceId、denied_count |
| B-11 | P2-T5 并发与超窗证据 | `apps/api/test/http/business-query-concurrency.test.cjs`；`agent-context-exceeded.test.cjs` | 完成 | 需真库与延迟钩子 |
| B-12 | P3-T1 订单域 5 个 operation | `tools/order-query-tools.ts:75-124`；`tools/order-overview-tools.ts:52-188`；`tools/attachment-tools.ts:15-60` | 部分 | timeline 无固定描述；告警库存源 `source_id` 是伪 UUID |
| B-13 | P3-T2 销售域 4 个 operation | `tools/sales-query-tools.ts:13-95` | 部分 | returns 多给 `destination`；透出自由备注 |
| B-14 | P3-T3 采购域 4 个 operation | `tools/procurement-query-tools.ts:18-105` | 部分 | 到货未复刻批次序号；计划投影缺状态 |
| B-15 | P3-T4 生产域 4 个 operation | `tools/production-query-tools.ts:14-131` | 部分 | 进度投影缺阻塞原因 |
| B-16 | P3-T5 仓库域 6 个 operation | `tools/warehouse-query-tools.ts:16-100` | 部分 | 余额自建聚合，未沿用领域口径；出库缺退货关联 |
| B-17 | P3-T6 24 个 operation 审计 | `apps/api/test/unit/agent-tool-catalog-audit.test.cjs:9-53` | 部分 | 真库同单据对照未运行 |
| B-18 | P4-T1 应收与客户回款 | `tools/finance-query-tools.ts:15-66` | 完成 | operational 在读库前 403 |
| B-19 | P4-T2 应付、付款与对账 | `tools/finance-query-tools.ts:68-150` | 完成 | 对账经采购单下推订单 |
| B-20 | P4-T3 成本利润与订单人工 | `tools/finance-query-tools.ts:156-208` | 部分 | 未复用报表服务；缺人工合计 |
| B-21 | P4-T4 降权收口 | `stream-transport.ts:68-79`；`tool-executor.ts:37-43`；`context-manager.ts:26-29` | 完成 | 撤销帧 seq 固定 0 |
| B-22 | P5-T1 快照与续接 | `business-query-agent.controller.ts:47-72,172-179`；`state-manager.ts:120-122` | 完成 | 只支持 `Last-Event-ID`，无 `after_seq` 参数 |
| B-23 | P5-T2 SSE 取消与重放 | `stream-transport.ts:23-66`；`state-manager.ts:128-134` | 完成 | 轮询 200ms、心跳 15s |
| B-24 | P5-T5 超时、截断与脱敏 | `agent-orchestrator.ts:85-94,280-297`；`tool-executor.ts:22-23,93-99` | 部分 | 128KB/行数有，工具级超时无 |
| B-25 | P6-T1 发布预检 | `platform/config/validate-environment.ts:5-15` | 完成 | 部署脚本本体无 Agent 检查 |
| B-26 | P6-T2 数据库最小权限证明 | `scripts/verify-agent-database-privileges.mjs:4-43` | 完成 | 需两组真连接串，无产物 |
| **B-27** | P6-T3 DeepSeek 双角色验收 | — | **缺失** | 仓库内零验收记录 |
| B-28 | P6-T4 目录审计与样例对照 | `apps/api/test/unit/agent-tool-catalog-audit.test.cjs:9-28`；`integration/business-query-operations.test.cjs:19` | 部分 | 样例对照无留档 |
| B-29 | P6-T5 发布验收与用量基线 | — | 部分 | 无用量、时延基线 |
| B-30 | P6-T6 回退开关 | `query-permission.guard.ts:42-45`；`.env.example:13-14` | 完成 | 无关闭演练记录 |
| B-31 | 横向 只读约束 | `query-read-client.ts`；`business-query-agent.module.ts:76-90` | 完成 | 写权限仅靠数据库 GRANT |
| B-32 | 横向 SSE 协议 | `stream-transport.ts:23-98`；`state-manager.ts:17-19` | 完成 | 事件类型常量定义后无引用 |
| B-33 | 横向 并发闸门 | `concurrency-gate.ts:9-34` | 完成 | 多副本前必须替换 |
| B-34 | 横向 幂等 | `business-query-agent.controller.ts:81-95,109-113` | 部分 | 唯一冲突一律 409，未区分幂等键冲突 |
| B-35 | 横向 证据落库 | `agent-orchestrator.ts:176-182,241-255`；`business-query-agent.controller.ts:56-64` | 完成 | 无独立 evidence 表，设计未要求 |
| B-36 | 横向 观测与 traceId | `observability.ts:12-40`；`platform/http/response-envelope.interceptor.ts:17` | 部分 | request_id 未进 Agent 日志 |
| B-37 | 横向 超时与取消 | `agent-orchestrator.ts:85-94`；`business-query-agent.controller.ts:143-158` | 部分 | 取消依赖进程内 Map |
| **B-38** | 横向 保留期与清理 | — | **缺失** | 无任何清理任务 |

后端合计：完成 20、部分 16、缺失 2。

## 附录 B：前端 16 条

路径前缀省略 `apps/web/`。

| # | 功能点 | 文件（证据） | 状态 | 缺口 |
|---|---|---|---|---|
| W-1 | 查询页主链路 | `app/business-query/page.tsx:140-189,254-293`；`components/agent/agent-composer.tsx:46-86` | 完成 | POST 未返回时取消按钮禁用 |
| W-2 | reducer 状态机 | `lib/business-query-state.ts:52-154` | 完成 | 同工具同 operation 多次调用合并一行 |
| W-3 | SSE 解析与断线重连 | `lib/business-query-stream.ts:25-87` | 完成 | 1.5s×5 次后转整页刷新 |
| W-4 | 刷新快照恢复 | `app/business-query/page.tsx:89-133` | 完成 | 只恢复最近会话 |
| W-5 | 取消与终态重放 | `app/business-query/page.tsx:180-189`；`lib/business-query-state.ts:122-130` | 完成 | 取消后不主动断开本地流 |
| W-6 | 页面状态、重试与草稿 | `app/business-query/page.tsx:79-83,164-172` | 部分 | 403 不清空片段；无仅重连入口；幂等键不复用 |
| W-7 | 可访问性 | `components/agent/agent-composer.tsx:46-86`；`agent-message.tsx:47-49` | 完成 | 答案与工具进度无 live region |
| W-8 | 浏览器恢复与取消证据 | `tests/e2e/business-query-recovery.spec.mjs:77-100` | 完成 | 依赖环境变量才运行 |
| W-9 | 浏览器异常流程证据 | `tests/e2e/business-query-recovery.spec.mjs:102-194` | 部分 | 未建独立 spec，本次未执行 |
| W-10 | 前端降级与禁用 | `components/layout/app-shell.tsx:16-58`；`lib/business-query-stream.ts:79` | 部分 | 不感知关闭开关；403 文案误导 |
| W-11 | Markdown 渲染 | `lib/agent-markdown.ts:52-626`；`components/agent/agent-markdown.tsx:13-50` | 完成 | 自写 GFM 子集，属超设计 |
| W-12 | 工具步骤展示 | `components/agent/agent-tool-steps.tsx:16-42`；`lib/agent-tool-labels.ts:14-132` | 完成 | 历史轮无步骤快照 |
| W-13 | 来源引用展示 | `components/agent/agent-sources.tsx:9-18`；`lib/agent-sources.ts:9-61` | 完成 | 不展示查询时间，上限 12 条 |
| W-14 | 导航与入口接线 | `lib/surface-permission.ts:15-126`；`components/layout/app-shell.tsx:16-58` | 完成 | 栏目名改为「迪礼顾问」 |
| W-15 | 错误与降级呈现 | `lib/business-query-state.ts:129-130`；`lib/agent-tool-labels.ts:112-132` | 完成 | 用户可见内部错误码 |
| W-16 | 历史回放与会话切换 | `app/business-query/page.tsx:211-252`；`components/agent/agent-history-dialog.tsx:34-63` | 完成 | 超设计，每会话多一次快照请求 |

前端合计：完成 13、部分 3、缺失 0。

## 附录 C：验收 18 项

| # | 验证项 | 文件（证据） | 状态 | 缺口 |
|---|---|---|---|---|
| R-1 | 只读边界与业务写被拒 | `apps/api/test/integration/business-query-agent.test.cjs:69-101` | 部分 | 无注入式问题的专门用例 |
| R-2 | 数据库最小权限证明 | `scripts/verify-agent-database-privileges.mjs:30-34` | 部分 | 无一次执行记录 |
| R-3 | 两档数据权限 | `apps/api/test/unit/agent-finance-access.test.cjs:9-31` | 完成 | 真实双角色输出未签核 |
| R-4 | 用户会话隔离 | `agent-state-manager.test.cjs:132-147`；`http/business-query-contract.test.cjs:126-141` | 完成 | 跨用户用例在缺账号时跳过 |
| R-5 | DeepSeek 查询编排 | `agent-deepseek-provider.test.cjs`；`agent-orchestrator.test.cjs:125-161` | 部分 | 只有单账号生产冒烟 |
| R-6 | 31 个 operation 目录 | `agent-tool-catalog-audit.test.cjs:17-57` | 完成 | 目录层面已闭环 |
| R-7 | 八轮上下文与超窗 | `agent-context-manager.test.cjs:48-95`；`agent-model-errors.test.cjs` | 完成 | 无 |
| R-8 | 持久状态、幂等与重启 | `agent-state-manager.test.cjs:67-184` | 完成 | 真库约束用例受门禁 |
| R-9 | 并发控制 | `agent-concurrency-gate.test.cjs`；`http/business-query-concurrency.test.cjs` | 完成 | 无 CI 历史日志 |
| R-10 | JSON 与 SSE 协议 | `http/business-query-contract.test.cjs:111-123` | 完成 | 无 |
| R-11 | 查询页状态机 | `lib/business-query-state.test.mjs:61-76`；`test/agent-chat-page.test.tsx` | 完成 | 无键盘焦点与读屏断言 |
| R-12 | 可观测与成本 | `agent-observability.test.cjs`；`agent-orchestrator.test.cjs:141` | 部分 | 无量与时延基线 |
| **R-13** | DeepSeek 双角色验收 | — | **缺失** | 无对照签核记录 |
| **R-14** | 31 个 operation 样例口径审计 | `test/integration/business-query-operations.test.cjs:19-49` | **缺失** | 用例存在但被环境门禁挡住 |
| **R-15** | 发布验收与观测基线 | — | **缺失** | 无预发布验收集与基线 |
| R-16 | 禁用与回退演练 | `query-permission.guard.ts:43-45`；`agent-access-level.test.cjs:77-87` | 部分 | 无关闭/恢复演练记录 |
| R-17 | 发布前检查 | `platform/config/validate-environment.ts:9-14`；`scripts/deploy/remote-build.sh:46-49` | 完成 | 生产部署用了 `-SkipTests` |
| R-18 | 七项财务真库矩阵 | `agent-tool-finance-*.test.cjs` 三份 | 部分 | 未用真实订单覆盖 |

验收合计：完成 9、部分 6、缺失 3。
实施类功能点 54 项（后端 38 + 前端 16）：完成 33（61%）、部分 19（35%）、缺失 2（4%）。

## 附录 D：设计 ↔ 实现偏差

设计写了、实现没做：

1. 重连收到 403 时不清空已渲染的 full 片段（`app/business-query/page.tsx:79-83`）。
2. 401 不跳登录页，与 `lib/business-query-stream.ts:8` 的注释相反。
3. 「仅重连 SSE」没有独立入口，流失败只能整页刷新。
4. 幂等键每次提交重新生成，设计里的同键重试在 UI 路径不可达。
5. 工具预算设计定 8，实现为 16 次调用 / 4 轮规划且不可配置。
6. 注册表没有登记输入 schema、超时与来源类型（模块设计第 85 行要求逐 operation 登记）。
7. 会话保留期与清理策略没有实现（模块设计第 143 行要求）。
8. 观测没有 requestId/traceId 关联。
9. 前端不感知 `BUSINESS_QUERY_ENABLED`。

实现做了、设计没写：

1. 前端 9 个组件与 4 个 lib，设计文件清单只有 1 个页面与 2 个 lib。
2. 自写 GFM 子集 Markdown 解析器，偏离「纯文本分段渲染、不引依赖」的定案。
3. 历史会话弹窗、会话切换、新建对话、复制、回到顶部。
4. `ORDER_SEARCH_REQUIRED` 运行时守卫、可回传工具失败、3 次失败预算。
5. 工具步骤可展开详情、来源去重上限 12、四个推荐问题。
6. 栏目与页面改名为「迪礼顾问」。

## 变更记录

- 2026-10-27：基于三份上游设计、36 份阶段任务单、`a71b704` 代码、203 例测试与 5 份评审报告创建本评估。

# P3-T1 订单领域 5 个 operation 与订单根验证器

## 1. 位置

- 阶段：Phase 3 非财务订单全链路，目标是 24 个非财务 operation 全部可用且不泄财务事实。
- 本任务落订单领域 5 个 op 与全批公用的「订单根验证器」：get_order_overview、get_order_status、get_order_timeline、get_order_alerts、get_order_attachments。
- 前置：阶段 2 的工具链（registry/executor/query-read-client）。后续各领域任务复用根验证器与输入解析模式。

## 2. 开发者须知

**先读**

- `apps/api/src/modules/order-workbench/order-workbench.service.ts` 与 `order-workbench.domain.ts` — 数量/进度规则与 `overallStatus` 的状态来源清单。
- `apps/api/src/modules/alerts/alerts.service.ts` 与 `alerts.domain.ts` — 三源告警与去重规则（`deduplicateAlerts` 纯函数）。
- `apps/api/src/platform/attachments/`（模型 AttachmentLink/Attachment）— 链接与文件元数据的形状。
- `apps/api/prisma/schema.prisma` 的 SalesOrder/AuditEvent/AttachmentLink 模型 — 字段与软删列。
- `docs/design/business-query-agent-v0-module-design-2026-10-25.md` 的 operation 映射表（order_query 五行）。

**定案（不得重开）**

- 新 `tools/order-root.ts`：`assertOrderRoot(client, orderNo)` —— 只读连接查未软删销售单，查不到抛 `NotFoundException(ORDER_NOT_FOUND)`；返回根行（id/orderNo/quantity 等）。除 search_orders 外所有 op 必先过它。
- `get_order_overview` / `get_order_status`：沿用 workbench 的数量与进度规则**重建非财务汇总**——各模块 summary 的 counts/quantities 保留，`receivable_summary/payable_summary` 不出现；`overall_status` 用非财务状态源（销售单/BOM/生产/出货）重算；数量对账 blockers 保留，财务口径 blockers（应收应付/对账缺认）不进 operational 输出。不是「删字段」，是新投影。
- `get_order_timeline`：审计事件按订单读，**非财务动作白名单**过滤（财务动作类型一律不进，白名单常量放 order-query-tools.ts 顶部并列出依据）；投影 `{time, action(固定描述), document_no?}`，不传 details 自由 JSON。
- `get_order_alerts`：在 agent 侧按订单下推三源查询（只读 client + orderNo 条件），复用 `deduplicateAlerts` 纯函数去重与分级；不改 AlertsService 本身。
- `get_order_attachments`：解析当前订单及其**非财务关联单据**的链接；operational 投影固定 5 字段（文件类型、大小、上传时间、关联实体类型、关联单号/记录 ID）——不给文件名、存储键、下载 URL、内容。
- 输入形状统一：`{order_no: 非空字符串 ≤100, page?: 1..1000}`；QueryFact.order_no = 根单号；每行来源 business_type 按领域登记。

**边界**

- 新文件：`tools/order-root.ts`、`tools/order-overview-tools.ts`（overview/status 共用计算）、`tools/attachment-tools.ts`、timeline/alerts 实现放 `order-query-tools.ts`（已有文件）。
- registry：5 个 op 翻 `implemented: true`；executor 增加分发分支与输入解析。
- 不改业务模块与全局平台代码。

**运行**

- `npm run build --workspace=@dilee/api && node --test apps/api/test/unit/agent-tool-order-domain.test.cjs`
- `npm run typecheck --workspace=@dilee/api`

**未知**

- 审计动作类型的全集要从代码里枚举（grep `audit.record(`）；若白名单覆盖不全导致 timeline 空洞，以「宁可少给不可错给」为原则，停下来说明再扩。
- 告警三源里库存净变动源聚合全库，下推到订单后语义是否成立需要对照 alerts 页面；不成立就先只下推两源并注明。

## 3. 工作流

1. 读上面 5 处，然后一句话复述本任务。
2. 写 `order-root.ts` + 单测（红→绿）。
3. timeline/alerts：先枚举审计动作类型、定白名单；实现 + 单测。
4. overview/status：重建非财务汇总与状态机，单测断言无财务键、blockers 数量类齐全。
5. attachments：链接解析与 5 字段投影，单测断言无文件名/URL/存储键。
6. registry 翻开关 + executor 分支；全量 agent 单测回归；提交。

## 4. 测试用例

| 用例 | 输入 | 期望 | 缝 |
|---|---|---|---|
| 1 | 未软删订单号 | 根验证通过并返回根行 | `assertOrderRoot` |
| 2 | 软删/不存在的订单号 | 404 `ORDER_NOT_FOUND`，不触达后续查询 | `assertOrderRoot` |
| 3 | 假 client 返回含应收应付的宽行 | overview/status 结果无 `receivable/payable/amount/currency` 键 | 投影 |
| 4 | 审计事件混财务动作（如凭证/收付款） | timeline 只含白名单动作的固定描述，无 details | `get_order_timeline` |
| 5 | 三源告警（订单范围） | 去重分级与 alerts.domain 同口径 | `get_order_alerts` |
| 6 | 附件含敏感文件名/存储键 | 投影只有类型/大小/时间/实体类型/单号 | `get_order_attachments` |
| 7 | BOM 缺失 + QC 不合格 | blockers 含 BOM_MISSING、QC_REJECTED | `get_order_status` |

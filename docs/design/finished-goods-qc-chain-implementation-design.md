# E1 成品送检与成品 QC 链路实施设计

> 文档类型：跨模块纵向链路开发设计文档
>
> 链路：生产单完成/外加工成品回厂 -> 成品送检 -> 成品 QC 判定 -> 成品可入库来源
>
> 对应路线图：E1；依赖 D3-D7、A1-A3、A5、A6
>
> 状态：待开发

## 1. 问题与目标

D5-D7 已提供厂内生产的工序产量、生产单进度和订单推进状态；D6 已提供外加工成品回厂的待验收来源。它们都不能直接增加厂内成品库存。仓库需要一个可追溯的成品检验关口，区分合格、条件接收和不合格数量，并向 E2 提供唯一、可分批消费的成品入库来源。

本链路以 `order_no` 为订单身份证，以生产单为完成归属。它交付成品送检与 QC 事实、可入库余额、异常风险和审计，不交付成品库存、发货、应收或收款。

## 2. 业务边界

### 2.1 纳入的来源

| 来源 | 送检前置条件 | 送检数量口径 | E1 结果 |
| --- | --- | --- | --- |
| 厂内完工 | 厂内生产单有效、未关闭/取消；D7 没有生产阻塞且全部有效工序达到目标或超单完成 | 操作员录入本次送检数量；累计不得超过该生产单有效完工量减去已送检/已关闭数量 | 形成厂内成品 QC 来源 |
| 外加工成品回厂 | D6 `finished_goods_return` 已提交 `pending_qc`、未删除、未被后续关闭 | 回厂交接数量减去该来源已送检/已关闭数量 | 形成外加工回厂 QC 来源 |

同一生产单支持多次送检和多次检验。数量全部使用 Decimal 字符串；不做跨单位换算。`order_no`、生产单号、产品描述/规格快照和单位均由来源服务端回填，前端不得拼接。

### 2.2 明确不在 E1 范围

- 成品入库、成品库存单、不良品库存事实、退库、报废、返工实物移动，由 E2 负责。
- 成品出库、装箱、报关、客户退货、应收和收款，由 E3-E5 负责。
- QC 项目模板、抽样规则、AQL、检验项目和产品规格字段由物控后续在 A5 可版本化表单能力中扩展；E1 只提供核心数量、结论、备注和 `attachment` 容器。
- 外加工直装柜在 D6 当前只是物流事实，且“直装柜前是否必须成品 QC”未确认。E1 不追溯性地为已发出的直装柜记录创建 QC，也不改变 D6 发出规则；待 E3 设计明确后再建立发货前 QC 门禁。
- 不建立审批流；保留操作执行人、审批人预留字段和完整审计思想，不新增审批动作。

## 3. 领域对象与状态机

### 3.1 成品送检单 `finished_goods_inspection_submission`

送检单是可编辑的业务申请，承载一次待检批次，不是库存事实。

核心字段：`id`、`submission_no`、`order_no`、`production_order_id`、`production_order_no_snapshot`、`source_type`、`source_id`、`product_name_snapshot`、`product_specification_snapshot`、`unit_id`、`unit_name_snapshot`、`submitted_quantity`、`submission_date`、`status`、`remark`、`attachment` 关联、审计字段、逻辑删除字段和乐观锁 `version`。

`source_type` 为 `in_house_completion` 或 `outsource_finished_goods_return`。厂内来源以生产单为来源 ID；外加工来源以 D6 成品回厂交接 ID 为来源 ID。一个来源可创建多个送检单，但有效送检累计不得超过可送检数量。

```text
draft -> submitted -> inspecting -> qc_completed
  |         |              |          |
  +-> cancelled            +-> corrected
```

- `draft`：可编辑、逻辑删除；不占用可入库数量。
- `submitted`：送检数量冻结，进入待检队列；只可取消或通过更正产生新事实。
- `inspecting`：QC 操作员正在录入检验；不允许直接删除。
- `qc_completed`：已有有效 QC 结论；不得原位修改数量或结论。
- `cancelled`：仅无有效 QC 结论的送检可取消，释放送检占用。
- `corrected`：原送检被完整更正后保留历史；更正必须关联原因和替代送检/QC 事实。

### 3.2 成品 QC 记录 `finished_goods_qc_record`

QC 记录是一次判定事实，必须关联一个处于 `submitted` 或 `inspecting` 的送检单。核心字段：`id`、`qc_no`、`submission_id`、`order_no`、`production_order_id`、`source_type`、`source_id`、`inspection_date`、`inspected_quantity`、`qualified_quantity`、`conditional_accept_quantity`、`rejected_quantity`、`conclusion`、`rejection_reason`、`remark`、附件、审计字段、逻辑删除字段、`version`。

不变量：

```text
inspected_quantity = qualified_quantity + conditional_accept_quantity + rejected_quantity
0 < inspected_quantity <= submission.submitted_quantity - already_closed_quantity
available_for_inbound_quantity = qualified_quantity + conditional_accept_quantity - valid_finished_goods_inbound_quantity
```

`conclusion` 由数量推导而不是由页面自由填写：

- `qualified`：不合格和条件接收均为零。
- `conditional_accepted`：条件接收大于零且不合格为零。
- `rejected`：合格和条件接收均为零。
- `mixed`：同一批次同时存在可接收和不合格数量。

送检单可以被分批 QC；所有有效 QC 记录累计不得超过送检数量。若一次检验只覆盖部分送检数量，送检单保持 `inspecting`；全部覆盖后转为 `qc_completed`。

### 3.3 QC 与下游状态

E1 只生成下游可读来源，不直接创建 E2 库存事实：

| QC 数量 | E1 状态 | E2 可消费来源 | 库存影响 |
| --- | --- | --- | --- |
| 合格 | `qualified` | 可入库，数量等于合格数量减已入库量 | 无 |
| 条件接收 | `conditional_accepted` | 可入库，必须保留条件接收标识、备注和 QC 来源 | 无 |
| 不合格 | `rejected` 或 `mixed` | 不可入库；作为 E2 不良品/返工/报废处理来源 | 无 |

厂内或外加工来源被更正、删除、冲销或 D7 出现阻塞时，系统不得静默修改已完成 QC 或未来 E2 入库事实。应返回影响预览；未被 E2 消费的送检/QC 可按更正状态机处理，已被消费的事实必须在 E2 用反向库存事实和新的 QC 更正闭环。

## 4. 来源校验、联动和“后悔药”

### 4.1 来源查询与锁定

提供统一只读“待送检来源”查询。厂内来源服务端使用 D7 的生产单进度、生产阻塞和已有效送检数量计算；外加工来源使用 D6 回厂交接状态、已有效送检数量计算。来源变更后重新计算可送检余额，保存时以事务内条件校验防止并发超送检。

来源不满足条件时返回稳定错误码，例如 `FINISHED_GOODS_QC_SOURCE_NOT_READY`、`FINISHED_GOODS_QC_SOURCE_BLOCKED`、`FINISHED_GOODS_SUBMISSION_QUANTITY_EXCEEDED`，并携带订单、生产单、来源、可用数量和阻塞详情。

### 4.2 更正和冲销

- 草稿送检允许修改和逻辑删除；已提交/已检验送检不能直接删除。
- 已完成 QC 不允许原位覆盖。录入错误必须创建更正记录，填写原因，引用原 QC；原 QC 转为 `corrected` 或由等量反向更正抵消。
- 任何更正先返回影响预览，至少显示受影响的送检余额、QC 可入库余额、已消费 E2 入库数量、D7 状态和待处理风险。
- 若已生成成品入库，E1 只标记 `DOWNSTREAM_FINISHED_GOODS_INBOUND_EXISTS` 并阻止破坏性更正；E2 负责先冲销/调整库存事实后，E1 才允许完成对应更正。
- 所有状态流转、更正、取消、拒绝和影响预览确认写入审计，保存操作人、时间、`order_no`、来源、原因、前后数量和请求 ID。

### 4.3 与 D6/D7 的联动

- E1 读取 D7，不复制或手工修改生产进度。厂内 QC 结论改变时，D7 后续可从 E1 读取“已送检/待 QC/已 QC”能力状态，但 E1 不覆盖 D7 的生产计量。
- E1 消费 D6 外加工成品回厂；送检、完成 QC、更正和取消在同一业务事务内同步回写 D6 可读交接状态（如 `pending_qc`、`under_qc`、`qc_completed`），不产生库存。
- 来源事实后来被冲销或失效时，E1 产生风险标记和审计，而非删除历史 QC；D7 继续通过来源冲销阻塞提示操作员。

## 5. API、权限与前端

复用 `/api/v1`、REST、JSON 信封、`snake_case`、请求 ID、UUID、统一错误响应和 Decimal 字符串契约。

建议资源：

- `GET /finished-goods-qc/sources`：按 `order_no`、生产单、来源类型、状态检索待送检来源。
- `GET/POST /finished-goods-inspection-submissions`
- `GET/PATCH /finished-goods-inspection-submissions/:id`
- `POST /finished-goods-inspection-submissions/:id/submit`
- `POST /finished-goods-inspection-submissions/:id/cancel`
- `GET/POST /finished-goods-qc-records`
- `POST /finished-goods-qc-records/:id/correct`
- `GET /finished-goods-qc-records/:id/impact-preview`
- `GET /finished-goods-qc-records/:id/audit-events`
- `GET /finished-goods-qc/available-inbound-sources`：只读，供 E2 消费。

权限沿用 RBAC：管理员全权；QC 角色可维护送检和 QC；仓库、物控和生产角色可查看来源、状态、可入库余额及审计；销售和财务只读订单级状态；普通角色不得绕过 QC 创建库存来源。模块权限在具体实现时复用 `quality` 与 `warehouse` 能力，若现有角色无 `quality`，先以管理员和仓库/生产组合权限过渡，不新增审批流。

前端在仓库模块提供“成品送检与 QC”真实工作台：待送检来源表、送检草稿/提交、QC 记录、数量分流、条件接收/不合格显著标识、来源详情、影响预览和审计时间线。前端不计算可用量、不拼接 `order_no`、不展示演示数据；所有不可用动作显示服务端返回的原因。

## 6. 测试与交付门槛

最高验证缝隙为真实 PostgreSQL 事务上的 E1 REST API；浏览器验收覆盖操作员从生产完成来源到 QC 可入库余额的完整工作流。沿用现有 Node 单元测试、集成/API 测试、独立测试库、Playwright 和 `verify:chain`，只断言外部业务行为与不变量。

至少覆盖：

1. 厂内生产单在 D7 生产完成且无阻塞时可分批送检；缺日报、超单待确认或来源数量不足被拒绝。
2. 外加工成品回厂 `pending_qc` 可送检，且送检/QC 前后均不改变厂内成品库存。
3. 同一来源分批送检、分批 QC、重复请求和并发提交不超过来源可送检量。
4. 合格、条件接收、不合格、混合结论的数量守恒、可入库余额和不可入库门禁正确。
5. QC 更正、来源冲销、已有 E2 下游入库三种情况分别产生可执行影响预览和风险提示，不丢失审计。
6. 未认证 401、越权 403、来源不存在 404、非法状态/数量 422、版本或并发冲突 409 均符合全局契约。
7. 生产 -> 成品送检 -> QC -> 可入库来源的 PostgreSQL、HTTP 和 Playwright 旅程通过；测试报告明确真实环境未具备时的阻断，禁止虚报。

## 7. 后续衔接

- E2 只消费有效 QC 的 `available_for_inbound_quantity`，创建成品入库、不良品和库存事实；不得自行判断 QC 合格。
- E3 消费 E2 的可用成品库存和后续确认的外加工直装柜发货 QC 门禁。
- E4/E5 消费 E3 成品出库来源，不从 E1 直接创建应收。
- G1 复用 D7 生产状态和 E1 的待检、已检、可入库/不合格风险，形成订单全链路工作台。

## 8. 待业务确认事项

1. 外加工直装柜是否必须在发出前完成 QC，以及由厂内、外加工点还是客户验货形成 QC 事实。
2. 不合格成品在 V1 中优先进入返工、报废还是不良品库存；E1 只保留可追溯来源，不预设实物处置。
3. 条件接收是否必须填写固定条件类别、复检日期和责任人；本批默认仅要求备注和附件。
4. QC 单号生成格式、送检/检验日期是否允许早于完工日期，以及最终由哪个岗位维护检验项目模板。

# BOM -> 采购 -> 来料 QC -> 原料入库 -> 应付来源实现设计

## 文档信息

- 文档类型：跨模块纵向链路实现设计
- 版本：V1.0 初版
- 状态：待编码
- 编制日期：2026-08-21
- 上游基线：销售单已确认、`order_no` 主线、BOM 来源版本

## 1. 目标与边界

本设计将已确认销售单的 BOM 需求，沿采购、分批到货、来料 QC、原料入库，最终形成财务可接收的应付来源草稿。它是订单主线的第一段中游闭环，所有记录必须能够通过 `order_no` 追溯回销售单。

本链路只实现“应付来源”的生成和交接，不实现财务应付确认、付款、核销和对账；不实现生产领料。原料库存只由入库、退货、冲销和调整等动态事实推导，不允许直接修改库存余额。

```text
已确认销售单 + BOM 版本
        -> 物料/供应商基础资料
        -> 采购单（系统生成采购单号）
        -> 分批到货/送检
        -> 来料 QC（合格/条件接收/不合格）
        -> 原料分批入库（可用原料/不良品）
        -> 应付来源草稿（按实际合格入库数量）
```

## 2. 固定业务原则

### 2.1 订单身份和来源

- `order_no` 是采购、到货、QC、入库和应付来源共同的业务追踪身份；任何订单来源记录不得只保存采购单号。
- 每张采购单只归属一个 `order_no`，采购单号由系统生成，不能替代 `order_no`。
- 采购单保存创建时使用的 BOM ID、BOM 版本和必要快照；BOM 后续变更不自动改写采购单。
- 应付来源必须引用实际原料入库明细、采购明细、供应商和 `order_no`，不可仅按采购下单数量生成。

### 2.2 可配置与固定核心

固定核心由系统保护：订单号、来源 ID/版本、采购单身份、供应商、物料、数量、单位、单价/金额、QC 数量分流、入库事实、应付来源关系、状态、审计和逻辑删除。

以下明细由物控或授权操作员通过版本化表单定义扩展：BOM 物料属性、损耗、工艺说明、QC 检验项目/标准/检测值、到货备注和附件。扩展字段不得替代固定核心关系，历史记录保存所使用的定义版本。

### 2.3 进退皆可

- 采购单、到货、QC、入库和应付来源允许在规则范围内更正，但不静默覆盖原事实。
- 影响已入库数量或应付来源的编辑先返回影响预览；确认后在同一事务中重算派生数据或生成差异/复核告警。
- 已确认入库和已生成应付来源是独立事实；退货、冲销和调整通过新记录更正，不直接修改历史事实。
- 采购数量不足、超收、QC 不合格、退货、价格变化和应付数量差异均可持续记录并产生告警。

## 3. 参与对象和职责

| 对象 | 职责 | 本链路输出 |
| --- | --- | --- |
| 物控 | 维护 BOM、物料需求、损耗和可扩展工艺信息 | BOM 版本供采购参考 |
| 采购员 | 维护物料/供应商，手工依据 BOM 创建采购单和成本 | 采购单、采购明细、供应商价格快照 |
| 仓库/QC | 登记到货、送检、检验结果和原料分批入库 | QC 结果、入库动态事实 |
| 财务 | 接收并确认应付来源，后续付款/核销 | 本设计只接收应付来源草稿 |
| 系统 | 校验来源、数量、状态、库存和审计 | 影响预览、告警、订单链路摘要 |

## 4. 领域对象与核心数据

### 4.1 基础资料

- `material`：物料池。名称/编码唯一，默认单位、启用状态、备注和审计字段；已被业务引用后只能停用或逻辑删除。
- `supplier`：供应商。名称/编码、联系人、联系方式、结算信息、启用状态和审计字段；敏感银行信息按后续财务规则决定是否保存。
- `unit`：单位池。V1 初始包含“打、码、个、包、捆”，操作员可增删改查；被引用的单位保留历史快照并优先停用。

### 4.2 BOM 采购视图

BOM 明细由物控维护，但采购读取时必须得到稳定快照：

```text
bom_id
bom_version
order_no
material_id / material_snapshot
required_quantity
unit
loss_quantity 或 loss_rate（若定义版本提供）
extension_data
```

采购员可以参考 BOM 手工填写采购数量和价格。系统不得默认把 BOM 明细自动变成采购明细，也不得在 BOM 修改时覆写已有采购单。

### 4.3 采购单与明细

采购单核心字段：

- `id`、系统生成的 `purchase_order_no`；
- `order_no`、销售单 ID、BOM ID、BOM 版本和来源快照；
- 供应商 ID/快照、采购日期、预计到货日期、币种、备注；
- 状态、总金额、扩展字段、统一审计字段和逻辑删除字段。

采购明细核心字段：

- 采购单 ID、物料 ID/快照、采购数量、单位；
- 单价、税率、费用、金额快照；
- 已到货数量、已 QC 合格数量、已入库数量、退货数量等派生汇总；
- 扩展字段、审计字段和来源 BOM 明细引用。

派生数量不可由客户端直接提交覆盖，由到货、QC、入库和退货事实汇总得到。

### 4.4 到货与来料 QC

到货记录表示供应商实际送达，不等于可用库存。核心字段：采购单/明细、`order_no`、到货批次/参考号、到货日期、送检数量、供应商、附件和审计。

来料 QC 核心字段：到货记录、送检数量、合格数量、条件接收数量、不合格数量、结果、检验时间、检验人、扩展检验数据、附件和审计。数量约束：

```text
accepted_quantity + conditional_quantity + rejected_quantity = inspected_quantity
```

合格数量和条件接收数量均可在仓库明确确认后进入可用原料库存；系统必须保留 QC 结果类型和仓库确认关系，避免将条件接收误记为普通合格。应付来源以实际可计价的合格或条件接收入库数量为基础；不合格数量进入不良品或退供应商路径。

### 4.5 原料入库与库存事实

原料入库是仓库确认的动态库存事实，核心字段：入库单号、`order_no`、采购单/明细、到货记录、QC 记录、物料、入库数量、单位、库存分类、批次、入库日期、供应商、备注、附件和审计。

库存分类至少区分：原料、退料、不良品。可用原料和不良品不得共用一个可用余额。库存卡是由动态库存事实汇总的静态读模型，禁止直接编辑余额。

### 4.6 应付来源草稿

应付来源是向财务表达“某笔合格原料入库对应一笔待确认应付”的来源记录，核心字段：

- `order_no`、采购单/明细、供应商、原料入库明细和 QC 记录；
- 实际可计价入库数量、单位、单价/币种、金额快照；
- 来源状态（待财务确认/已接收/已拒绝/已冲销等由财务设计细化）；
- 差异、备注、附件、审计和幂等键。

同一原料入库事实只能生成一条有效应付来源草稿；更正通过冲销/调整产生新记录，不能重复报送。

## 5. 状态与动作

### 5.1 采购单

```text
draft -> ordered -> partially_arrived -> arrived_complete -> closed
  \-> cancelled（无已确认下游事实时）
```

- `draft` 可编辑供应商、明细、价格和日期。
- `ordered` 表示已发出采购指令；修改需影响预览。
- `partially_arrived` 表示存在到货但未完成采购数量。
- `arrived_complete` 表示采购明细达到完成条件，不代表全部 QC 合格。
- 有已入库或应付来源时不可直接取消，必须走退货/冲销/调整。

### 5.2 到货、QC、入库

- 到货：`draft -> received -> inspected/partially_inspected -> closed`。
- QC：`pending -> accepted/conditionally_accepted/rejected/partially_accepted`；允许分批检验，但每次检验结果必须绑定到货批次。
- 入库：`draft -> posted -> reversed`；`posted` 后库存事实生效，撤销只能生成冲销记录。

所有状态动作使用显式 API，不允许客户端直接 PATCH 内部状态值。

## 6. 端到端操作流程

### 6.1 创建采购单

1. 采购员打开已确认销售单及指定 BOM 版本。
2. 系统展示 BOM 物料快照、已采购数量、已入库数量、差异和未解决告警。
3. 采购员选择供应商、物料、单位、采购数量、价格、预计到货日期和备注。
4. 系统校验单位启用状态、数量/金额格式和来源版本，并生成采购单号。
5. 保存草稿；执行“下单”动作前展示影响预览并写入审计。

### 6.2 分批到货与 QC

1. 仓库按采购明细登记本次到货，生成到货记录。
2. 到货记录进入 QC 待检队列；到货数量不改变可用库存。
3. QC 录入本批检验核心结果和可扩展检验明细。
4. 系统校验分流数量合计，合格/条件接收/不合格分别进入对应后续路径。

### 6.3 原料入库与应付来源

1. 仓库只能从 QC 允许入库数量创建原料入库单。
2. 入库过账在一个事务中写入入库事实、更新库存读模型/派生汇总、更新采购到货进度并生成幂等应付来源草稿。
3. 应付来源金额使用入库数量乘采购价格快照，并保留税率、币种和差异信息。
4. 财务在应付模块接收草稿；本链路不直接确认应付或写入付款。

## 7. API 契约

所有接口使用 `/api/v1`、统一 JSON 信封、`snake_case`、UUID、十进制字符串、ISO 8601 和 `request_id`。

### 基础资料

```text
GET    /materials
POST   /materials
PATCH  /materials/{id}
POST   /materials/{id}/disable

GET    /suppliers
POST   /suppliers
PATCH  /suppliers/{id}
POST   /suppliers/{id}/disable

GET    /units
POST   /units
PATCH  /units/{id}
POST   /units/{id}/disable
```

### 采购

```text
GET    /purchase-orders?order_no=&status=&page=&page_size=
POST   /purchase-orders
GET    /purchase-orders/{id}
PATCH  /purchase-orders/{id}
GET    /purchase-orders/{id}/impact-preview
POST   /purchase-orders/{id}/order
POST   /purchase-orders/{id}/cancel
GET    /purchase-orders/{id}/receipts
```

采购创建请求必须包含 `order_no`、`bom_id`、`bom_version`、供应商和明细；服务端再次确认销售单/BOM 来源有效。

### 到货与 QC

```text
POST   /purchase-orders/{id}/receipts
GET    /receipts/{id}
POST   /receipts/{id}/submit-inspection
GET    /quality-inspections?order_no=&source_type=raw_material_receipt
POST   /quality-inspections
PATCH  /quality-inspections/{id}
POST   /quality-inspections/{id}/accept
POST   /quality-inspections/{id}/reject
```

### 原料入库与应付来源

```text
POST   /raw-material-inbounds
GET    /raw-material-inbounds?order_no=&purchase_order_id=
GET    /raw-material-inbounds/{id}
POST   /raw-material-inbounds/{id}/post
POST   /raw-material-inbounds/{id}/reverse

GET    /payable-sources?order_no=&source_type=raw_material_inbound
GET    /payable-sources/{id}
POST   /payable-sources/{id}/accept
```

`POST /raw-material-inbounds/{id}/post` 是本链路关键事务入口：QC 数量门禁、库存事实、采购派生数量和应付来源幂等生成必须同事务完成。

## 8. 事务、一致性与幂等

- 创建/编辑采购单版本、来源快照和审计记录在同一事务中完成。
- QC 结果过账与数量校验必须原子完成；分流数量不合法时不得写入部分结果。
- 原料入库过账使用数据库事务和幂等键（入库单明细/来源 QC 明细组合），重复请求不得重复增加库存或应付来源。
- 冲销入库使用反向动态事实，不删除原入库事实。
- 并发保存使用版本/更新时间校验；冲突返回 `409 VERSION_CONFLICT`。
- 关键错误码至少包括：`BOM_NOT_FOUND`、`BOM_VERSION_CONFLICT`、`PURCHASE_ORDER_CONFLICT`、`INVALID_PURCHASE_STATE`、`INSPECTION_QUANTITY_MISMATCH`、`INBOUND_QUANTITY_EXCEEDED`、`INVENTORY_INSUFFICIENT`、`PAYABLE_SOURCE_DUPLICATE`、`DOWNSTREAM_RECORD_EXISTS`。

## 9. 影响预览与告警

采购单或 BOM 编辑前至少展示：订单号、来源 BOM 版本、采购/到货/合格/入库数量、价格和金额变化、应付来源变化、库存影响、采购状态变化以及需人工复核的风险。

告警不默认阻塞保存，但以下情况必须阻止过账：

- QC 分流数量超过送检数量或出现负数；
- 入库数量超过 QC 允许入库数量；
- 应付来源幂等键已存在；
- 冲销/退货后会造成库存负数；
- 来源采购单、BOM 或销售单已逻辑删除且没有受控替代来源。

## 10. 测试设计

- 单元/领域测试：采购数量汇总、QC 分流合计、单位/金额十进制校验、状态转换、应付来源幂等键。
- API 集成测试：已确认销售单创建采购单；草稿销售单/BOM 不可采购；重复采购单号/应付来源返回冲突；到货分批和分批 QC；入库过账生成库存事实与应付来源。
- 回退测试：不合格分流、供应商退货、入库冲销、采购价格变更后的差异预览，均保留原事实。
- 权限测试：采购、仓库/QC、财务操作分别受模块权限保护；未登录 401、无权限 403。
- 端到端验收：`order_no -> BOM 版本 -> 采购单 -> 到货 -> QC 合格 -> 原料入库 -> 应付来源草稿`，检查每个页面均可追溯来源。

## 11. 本设计不实现

- BOM 具体业务字段的最终清单和 QC 检验项目模板；
- 采购计划单、自动补货、自动采购建议；
- 财务应付确认、付款、核销、对账和会计总账；
- 生产领料、成品入库、外加工完整结算；
- 移动端、离线操作和外部系统对接。

## 12. 交付门槛

1. 先完成基础资料、版本化扩展字段和数据库迁移设计。
2. 再完成采购单与分批到货，保证订单号/BOM 来源可追溯。
3. 再完成 QC 与原料入库门禁，禁止直接改库存余额。
4. 最后完成应付来源交接和链路端到端测试。
5. 每个纵向切片均需更新任务文档、测试记录和每日开发日志；PostgreSQL 真实迁移验收作为部署环境检查项执行。

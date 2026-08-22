# G1 订单全链路工作台开发设计

## 1. 目标

为操作员提供以 `order_no` 为主键的只读订单全链路视图，集中查看销售、BOM、采购、原料库存、生产、成品 QC、成品库存、发货、应收和应付的当前状态、数量摘要、未决风险与审计时间线。

工作台是查询和汇总层，不替代各业务模块的编辑表单，不直接修改订单、库存、QC、收付款或生产事实。

## 2. 范围与边界

### 包含

- 订单列表：按订单号、客户、订单状态、阻塞状态和更新时间筛选。
- 订单详情：订单基本信息、各模块状态卡片、关键数量/金额摘要、派生单据编号和待处理风险。
- 模块状态：销售/BOM、采购/应付、原料库存、生产、成品 QC/库存、发货/应收。
- 统一 `order_no` 关联；没有下游事实时显示“未建立”，不得伪造完成状态。
- 只读审计时间线，展示订单相关事实的操作、操作人、时间和来源编号。
- 分页、日期范围筛选、刷新、空状态、错误状态和权限保护。

### 不包含

- 工作台内编辑、审批、过账、冲销、删除和批量业务操作。
- 新的业务状态机、库存余额表或财务计算规则。
- CSV/Excel 导出、通用告警中心、移动端和离线能力；这些属于 G2/G3 或系统交付阶段。

## 3. 读模型契约

新增只读接口：

```text
GET /api/v1/order-workbench/orders
GET /api/v1/order-workbench/orders/:order_no
GET /api/v1/order-workbench/orders/:order_no/timeline
```

统一返回 `{ data, meta }`。列表参数：`order_no`、`customer_id`、`status`、`has_blockers`、`from`、`to`、`page`、`page_size`。金额和 Decimal 数量以字符串返回，日期使用 ISO 字符串。

订单摘要至少包含：

```text
order_no, customer, sales_status, bom_status,
procurement_summary, raw_material_inventory_summary,
production_summary, finished_goods_qc_summary,
finished_goods_inventory_summary, shipping_summary,
receivable_summary, payable_summary,
overall_status, blockers, updated_at
```

每个模块摘要统一包含 `status`、`label`、`counts`、`amounts`、`source_ids` 和 `missing`。模块未实现或无数据时使用明确的 `missing: true`/`status: not_started`，不能用 0 冒充已完成。

## 4. 聚合规则

1. 订单集合以 `SalesOrder.orderNo` 为根；可由生产、采购或财务事实反查到的孤立订单只在明确指定 `order_no` 时展示。
2. 采购摘要读取采购单、到货/来料 QC、原料入库及应付来源；不重复计算应付金额，复用财务服务的已确认快照/摘要规则。
3. 原料和成品库存摘要读取 `InventoryFact` 动态事实汇总；禁止读取或写入人工余额缓存。
4. 生产与 QC 摘要复用 D7/E1-E4 已有只读服务或领域计算，保留生产单号、QC 单号和来源 ID。
5. 发货、应收和应付摘要复用现有订单摘要接口/服务，金额始终使用 Decimal 字符串。
6. 总体状态按最严重阻塞优先派生：`blocked` > `in_progress` > `ready_to_ship` > `completed` > `not_started`；模块状态和阻塞明细必须同时返回。
7. 聚合读取失败不得静默吞掉；返回统一 5xx/业务错误并记录 request id。单个模块没有事实属于正常 `not_started`，不是异常。

## 5. 权限与审计

- 接口必须经过认证和模块权限；允许 `sales`、`procurement`、`production`、`warehouse`、`finance`、`hr` 任一模块角色读取工作台。
- 工作台所有接口只读，不产生业务审计事件；时间线只读已有 `AuditEvent`，按 `order_no` 查询并限制最近 200 条。
- 不返回身份证、银行卡、密码哈希或附件二进制；附件只返回引用 ID/名称（如已有摘要支持）。

## 6. 前端交互

- 首屏显示订单筛选栏、状态/阻塞计数和订单表格。
- 选择订单后显示模块状态卡、金额/数量摘要、阻塞清单、派生单号和审计时间线。
- 金额、数量、状态均来自服务端；不在前端重新计算业务余额。
- 各模块使用颜色仅表达状态，不以颜色作为唯一信息；阻塞提供文字原因和处理入口链接。
- 工作台提供刷新按钮、加载/空/错误状态；详情链接跳转到对应模块只读页面或列表筛选，不在工作台内编辑。

## 7. 测试与验收

- 领域测试覆盖 `order_no` 聚合、缺失模块、阻塞优先级、Decimal 字符串和时间线排序。
- API 测试覆盖认证、任一业务模块权限、分页/筛选、404、统一响应和敏感字段排除。
- Web 构建与浏览器测试覆盖列表 -> 详情 -> 刷新、空状态、错误状态和模块链接。
- 真实 PostgreSQL/API/Playwright 环境不可用时必须记录为环境阻断，不将静态测试视为现场验收。

## 8. 完成判定

G1 只有在读模型 API、前端工作台、领域/API/Web 测试、审计时间线和路线图记录均完成后，才可标记为“代码/单元/构建完成；真实链路待环境”。

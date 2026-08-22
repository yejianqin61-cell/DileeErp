# E2 成品分批入库、不良品与库存单链路开发设计

## 1. 目标与边界

本链路承接 E1 成品送检与成品 QC，完成：

```text
E1 QC 可入库来源 -> 成品分批入库 -> 成品库存事实
E1 QC 不合格数量 -> 不良品记录 -> 不良品库存事实/后续处置来源
```

V1.0 不实现销售出库、客户退货、盘点调整和不良品最终处置；这些由后续 E3 或独立库存链路承接。库存余额不允许人工修改，只能由有效库存事实汇总得到。

## 2. 全局契约

- 所有记录使用 UUID 主键和统一审计字段；业务编号由系统生成。
- 订单身份证始终为 `order_no`，同时保存生产单号、QC 单号、QC 记录 ID 和来源批次。
- 数量使用 PostgreSQL `numeric(18,4)`，API 以十进制字符串传输，禁止 JS 浮点计算。
- 过账接口必须支持幂等键；同一业务单重复过账不得重复生成库存事实。
- 已过账记录不得直接编辑或物理删除；更正通过冲销事实完成，并保留原因、操作人和时间。
- 所有跨表变更在同一数据库事务内完成，失败时整体回滚。

## 3. 数据模型

### 3.1 `FinishedGoodsInbound`

动态成品入库单，字段包括：`id`、`inbound_no`、`order_no`、`production_order_id`、`qc_record_id`、`submission_id`、`unit_id`、产品/规格快照、`quantity`、`inventory_category=finished_goods`、`status`、`idempotency_key`、`remark`、统一审计字段及软删除字段。

状态：`draft -> posted -> reversed`。草稿可删除/修改；已过账只能冲销。

### 3.2 `FinishedGoodsDefective`

成品不良品动态记录，字段包括：`id`、`defective_no`、`order_no`、`production_order_id`、`qc_record_id`、`submission_id`、`unit_id`、产品/规格快照、`quantity`、`status`、`idempotency_key`、`disposition`、`remark`、统一审计字段及软删除字段。

状态：`draft -> posted -> reversed`。`disposition` 初始为 `pending`，不在 E2 自动报废或退货。

### 3.3 `InventoryFact` 扩展

复用既有 `InventoryFact`：

- 成品入库：`inventory_category=finished_goods`，`source_type=finished_goods_inbound`。
- 成品不良品：`inventory_category=defective_goods`，`source_type=finished_goods_defective`。
- 冲销：对应 `*_reversal`，数量为负数。

库存查询按 `material_id + unit_id + inventory_category` 汇总。由于当前成品没有独立产品主数据，成品记录以 `product_name_snapshot`/生产单维度追溯，E2 保留 `material_id` 为空的成品事实扩展字段或使用生产单作为来源维度；不得将成品错误计入原料余额。

## 4. 业务规则

1. 入库来源必须是 E1 active QC 记录，且 QC 记录所属送检单未取消/更正。
2. 可入库量 = `qualified_quantity + conditional_accept_quantity - 已过账入库量 - 已冲销恢复量`。不得超过可入库量；允许分批入库。
3. 不良品可记录量 = `rejected_quantity - 已过账不良品量 - 已冲销恢复量`。不得超过可记录量；允许分批登记。
4. QC 更正若已产生下游入库/不良品事实，必须返回影响预览并阻止静默更正；E2 提供按来源查询下游数量的影响信息。
5. 过账时检查数量大于零、单位与 QC 一致、来源状态有效，并在同一事务中写入动态单、库存事实和审计事件。
6. 冲销时检查对应库存类别余额不会变成负数；成功后写入负库存事实并将原单标记为 `reversed`。
7. 告警不阻塞合法保存，但来源超量、重复过账、库存不足等完整性错误必须阻塞。

## 5. API 草案

### 成品入库

- `GET /api/v1/finished-goods/inbounds?order_no=`：查询入库单及事实。
- `POST /api/v1/finished-goods/inbounds`：创建草稿，参数 `qc_record_id`、`quantity`、`remark`。
- `POST /api/v1/finished-goods/inbounds/:id/post`：过账，写入 `finished_goods` 库存事实。
- `POST /api/v1/finished-goods/inbounds/:id/reverse`：带原因冲销。

### 成品不良品

- `GET /api/v1/finished-goods/defectives?order_no=`：查询不良品记录。
- `POST /api/v1/finished-goods/defectives`：从 QC 记录创建不良品草稿。
- `POST /api/v1/finished-goods/defectives/:id/post`：过账到 `defective_goods`。
- `POST /api/v1/finished-goods/defectives/:id/reverse`：带原因冲销。

### 库存查询与影响预览

- `GET /api/v1/inventory/balances?category=finished_goods|defective_goods`：按事实汇总余额。
- `GET /api/v1/finished-goods/qc-records/:id/impact-preview`：返回已入库、已登记不良品及可用余量。

## 6. 权限与审计

成品入库、不良品由 `warehouse` 模块权限保护；库存汇总同样需要 `warehouse`。每次创建、修改、过账、冲销均记录 action、entity、entity_id、`order_no`、来源 ID、数量、原因、操作人和时间。

## 7. 验收标准

- 一条 E1 QC 记录可分两次入库，累计不得超过可入库量，第三次被拒绝。
- 一条 QC 记录可分批登记不良品，累计不得超过不合格量。
- 入库和不良品过账各生成一条可追溯库存事实；重复请求不重复记账。
- 冲销生成负向事实，余额恢复，冲销后原单不可再次过账。
- 原料库存查询不受成品/不良品事实影响。
- API 类型检查、构建、单元测试通过，并形成 E2 测试记录。

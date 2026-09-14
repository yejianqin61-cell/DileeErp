# Dilee ERP 全站业务字段字典

> 版本：静态代码/设计基线 v1.0  
> 范围：数据库业务字段、API 请求字段、前端录入/编辑字段、只读计算字段、状态/审计/联动字段。  
> 业务主键：`order_no`；UUID 仅作为内部关联值。

## 1. 编号规则

- `F-xxxx`：统一业务字段编号，同一语义字段跨表单复用同一编号。
- `B-模块-表单-序号`：字段在具体表单中的绑定位置。
- `R-xxxx`：数据联动关系编号。
- `UP` 表示上游来源；`DOWN` 表示下游消费。
- 联动类型：`引用`、`外键`、`快照`、`派生`、`汇总`、`状态门禁`、`库存事实`、`告警`、`回退/冲销`、`工作台聚合`。

## 2. 全局联动主图

```text
客户/联系人
   ↓
销售单(order_no)
   ↓
BOM表
   ├──────────────→ 采购单 → 到货批次 → 来料QC → 原料入库 → 原料库存 → 应付/付款
   └──────────────→ 生产单 → 原料领料 → 工序日报 → 员工日报 → 工资来源 → 工资台账/工资支付
                                      ↓
                         外加工直发/签收/回厂或直装柜
                                      ↓
                  成品QC → 成品入库/不良品 → 成品出库/发货/退货
                                      ↓
                            应收来源 → 收款核销 → 对账 → 订单关闭

所有业务事实 → 订单工作台 / 报表 / 告警 / 审计 / 附件
```

## 3. 模块字段字典

### 3.1 平台基础与公共字段

| 字段编号 | 字段 | 类型 | 表单/对象 | 上游 | 下游 | 联动 | 状态 |
|---|---|---|---|---|---|---|---|
| F-0001 | `id` | UUID | 所有实体 | 系统生成 | 所有关联表 | 外键 | 已实现 |
| F-0002 | `order_no` | string | 销售单、BOM、采购、生产、仓库、财务 | 销售单人工录入 | 全链路 | 引用/工作台聚合 | 已实现 |
| F-0003 | `status` | enum | 所有状态单据 | 状态机 | 页面、下游门禁 | 状态门禁 | 已实现 |
| F-0004 | `reason` | string | 编辑、回退、冲销、调整 | 操作人录入 | 审计/更正事实 | 审计 | 已实现 |
| F-0005 | `idempotency_key` | string | 到货、库存、付款、出库 | 请求方生成 | 幂等校验 | 状态/事实门禁 | 已实现 |
| F-0006 | `extension_data` | JSON | 销售、BOM、采购、生产、财务 | 动态表单 | 模板/扩展字段 | 快照/扩展 | 已实现 |
| F-0007 | `created_at` | datetime | 所有实体 | 系统生成 | 审计/时间线 | 审计 | 已实现 |
| F-0008 | `updated_at` | datetime | 所有实体 | 系统生成 | 审计/并发显示 | 审计 | 已实现 |
| F-0009 | `created_by` | UUID | 所有实体 | 当前用户 | 审计 | 外键/审计 | 已实现 |
| F-0010 | `updated_by` | UUID | 所有实体 | 当前用户 | 审计 | 外键/审计 | 已实现 |
| F-0011 | `deleted_at` | datetime | 可软删除实体 | 删除动作 | 查询过滤/审计 | 回退/审计 | 已实现 |
| F-0012 | `deleted_by` | UUID | 可软删除实体 | 当前用户 | 审计 | 外键/审计 | 已实现 |
| F-0013 | `attachment` | array | 业务单据操作 | 文件上传 | 业务单据/审计 | 外键/附件 | 已实现 |
| F-0014 | `expected_version` | int | 日报、可并发编辑单据 | 前端读取版本 | 更新冲突校验 | 并发门禁 | 已实现 |

### 3.2 客户池与销售模块

#### 表单：客户、联系人、销售单

| 编号 | 字段 | 类型 | 上游 | 下游 | 联动 | 状态 |
|---|---|---|---|---|---|---|
| F-0015 | `customer_code` | string | 人工/系统 | 客户、销售单、财务 | 引用 | 已实现 |
| F-0016 | `customer_name` | string | 客户表单 | 客户快照、销售单、应收 | 快照/引用 | 已实现 |
| F-0017 | `country_region` | string | 客户表单 | 客户资料、报表 | 查询 | 已实现 |
| F-0018 | `address` | string | 客户表单 | 客户资料 | 查询 | 已实现 |
| F-0019 | `payment_terms` | string | 客户表单 | 应收/收款 | 结算条件 | 已实现 |
| F-0020 | `customer_currency` | string | 客户表单 | 销售单、应收 | 默认值/引用 | 已实现 |
| F-0021 | `contact_id` | UUID | 联系人表单 | 销售单 | 外键 | 已实现 |
| F-0022 | `contact_name` | string | 联系人表单 | 联系人快照、销售单 | 快照 | 已实现 |
| F-0023 | `contact_phone` | string | 联系人表单 | 销售单、发货沟通 | 快照 | 已实现 |
| F-0024 | `customer_po_no` | string | 销售单表单 | 销售单、导出 | 引用 | 已实现 |
| F-0025 | `external_contract_no` | string | 销售单表单 | 销售单、导出 | 引用 | 已实现 |
| F-0026 | `order_date` | date | 销售单表单 | 采购/生产/报表 | 引用 | 已实现 |
| F-0027 | `product_name` | string | 销售单表单 | BOM、生产、出库 | 快照/引用 | 已实现 |
| F-0028 | `product_spec` | string | 销售单表单 | BOM、生产、发货 | 快照/引用 | 已实现 |
| F-0029 | `order_quantity` | decimal | 销售单表单 | BOM、生产计划、出库上限 | 引用/数量门禁 | 已实现 |
| F-0030 | `order_unit` | string | 销售单表单 | BOM、生产、出库 | 单位校验 | 已实现 |
| F-0031 | `delivery_date` | date | 销售单表单 | 采购、生产、报表 | 交期提示 | 已实现 |
| F-0032 | `currency` | string | 销售单表单 | 应收、报表 | 结算币种 | 已实现 |
| F-0033 | `sales_unit_price` | decimal | 销售单表单 | 应收来源、出库过账门禁 | 派生/金额门禁 | 已实现 |
| F-0034 | `sales_total_amount` | decimal | 销售单表单 | 应收/报表 | 派生 | 已实现 |
| F-0035 | `customer_snapshot` | JSON | 销售单确认 | 客户主数据 | 应收、审计、导出 | 快照 | 已实现 |
| F-0036 | `sales_order_version` | int | 销售单/BOM | 销售单确认 | BOM/生产 | 版本引用 | 已实现 |
| F-0037 | `sales_confirmed_at` | datetime | 销售单确认 | 销售单 | BOM 创建门禁 | 状态门禁 | 已实现 |

### 3.3 BOM 模块

#### 表单：BOM 新建、BOM 编辑、BOM 发布

| 编号 | 字段 | 类型 | 上游 | 下游 | 联动 | 状态 |
|---|---|---|---|---|---|---|
| F-0038 | `bom_id` | UUID | 销售单 | 采购单、生产单 | 外键 | 已实现 |
| F-0039 | `bom_no` | string | 系统生成 | 采购/生产/导出 | 引用 | 已实现 |
| F-0040 | `bom_version` | int | 销售单版本 | 采购单、生产单 | 版本引用 | 已实现 |
| F-0041 | `bom_status` | enum | BOM 操作 | 采购/生产门禁 | 状态门禁 | 已实现 |
| F-0042 | `bom_item_id` | UUID | BOM 明细 | 采购明细 | 外键 | 已实现 |
| F-0043 | `material_id` | UUID | 原料主数据 | BOM、采购、库存、领料 | 外键/边界校验 | 已实现 |
| F-0044 | `material_type` | enum | 物料主数据 | BOM/采购/库存 | 类型门禁 | 已实现 |
| F-0045 | `material_code` | string | 物料主数据 | BOM、采购、库存 | 快照/展示 | 已实现 |
| F-0046 | `material_name` | string | 物料主数据 | BOM、采购、库存 | 快照/展示 | 已实现 |
| F-0047 | `material_model` | string | BOM 明细 | 采购、领料、报表 | 快照 | 已实现 |
| F-0048 | `material_color` | string | BOM 明细 | 采购、领料 | 快照 | 已实现 |
| F-0049 | `required_quantity` | decimal | BOM 明细 | 采购计划、领料预览 | 派生/汇总 | 已实现 |
| F-0050 | `base_usage` | decimal | BOM 明细 | 领料参考 | 计算 | 已实现 |
| F-0051 | `approved_usage` | decimal | BOM 明细 | 领料预览、生产 | 计算/门禁 | 已实现 |
| F-0052 | `production_batch_base` | decimal | BOM 明细 | 生产用量 | 计算 | 已实现 |
| F-0053 | `material_unit_id` | UUID | 单位池 | BOM、采购、库存、生产 | 外键/单位隔离 | 已实现 |
| F-0054 | `material_add_reason` | string | 采购/BOM外物料 | 审计、采购单 | 审计门禁 | 已实现 |

### 3.4 采购与来料质检模块

#### 表单：采购单、采购明细、到货批次、来料质检

| 编号 | 字段 | 类型 | 上游 | 下游 | 联动 | 状态 |
|---|---|---|---|---|---|---|
| F-0055 | `purchase_order_no` | string | 系统生成 | 到货、QC、入库、应付 | 引用 | 已实现 |
| F-0056 | `supplier_id` | UUID | 供应商主数据 | 采购、应付、付款 | 外键 | 已实现 |
| F-0057 | `supplier_code` | string | 供应商主数据 | 采购、对账 | 快照/展示 | 已实现 |
| F-0058 | `supplier_name` | string | 供应商主数据 | 采购、应付、对账 | 快照/展示 | 已实现 |
| F-0059 | `purchase_date` | date | 采购单表单 | 采购、报表 | 引用 | 已实现 |
| F-0060 | `expected_date` | date | 采购单表单 | 到货提醒、报表 | 告警 | 已实现 |
| F-0061 | `purchase_item_id` | UUID | 采购单 | 到货批次、QC、入库 | 外键 | 已实现 |
| F-0062 | `purchase_quantity` | decimal | BOM/采购单 | 到货完成量、采购状态 | 数量门禁 | 已实现 |
| F-0063 | `purchase_unit_price` | decimal | 采购单 | 应付金额、报表 | 派生 | 已实现 |
| F-0064 | `purchase_tax_rate` | decimal | 采购单 | 应付/报表 | 派生 | 已实现 |
| F-0065 | `purchase_extra_fee` | decimal | 采购单 | 应付/报表 | 派生 | 已实现 |
| F-0066 | `purchase_currency` | string | 采购单 | 应付/付款 | 引用 | 已实现 |
| F-0067 | `receipt_id` | UUID | 采购明细 | QC、入库、应付 | 外键 | 已实现 |
| F-0068 | `receipt_no` | string | 系统生成 | QC、入库、应付 | 引用 | 已实现 |
| F-0069 | `batch_sequence` | int | 到货批次 | QC、入库、应付 | 批次追溯 | 已实现 |
| F-0070 | `received_date` | date | 到货表单 | QC、入库、应付 | 引用 | 已实现 |
| F-0071 | `received_quantity` | decimal | 到货表单 | QC上限、应付来源 | 数量门禁/派生 | 已实现 |
| F-0072 | `over_receipt_reason` | string | 超收批次 | 审计、采购状态 | 审计/告警 | 已实现 |
| F-0073 | `arrival_closed` | boolean | 采购关闭动作 | 到货接口 | 状态门禁 | 已实现 |
| F-0074 | `inspected_quantity` | decimal | 来料QC | 可入库量 | 汇总 | 已实现 |
| F-0075 | `accepted_quantity` | decimal | 来料QC | 原料入库 | 数量门禁 | 已实现 |
| F-0076 | `conditional_quantity` | decimal | 来料QC | 原料入库/财务调整 | 数量门禁 | 已实现 |
| F-0077 | `rejected_quantity` | decimal | 来料QC | 不良品/退供应商 | 分流 | 已实现 |
| F-0078 | `inspection_status` | enum | QC操作 | 原料入库门禁 | 状态门禁 | 已实现 |
| F-0079 | `inspection_remark` | string | QC表单 | 审计/不良品处置 | 审计 | 已实现 |

### 3.5 原料仓库与生产领料模块

#### 表单：原料入库、生产领料、退料、报废、冲销

| 编号 | 字段 | 类型 | 上游 | 下游 | 联动 | 状态 |
|---|---|---|---|---|---|---|
| F-0080 | `raw_material_inbound_id` | UUID | 来料QC | 原料库存、应付 | 外键 | 已实现 |
| F-0081 | `raw_material_inbound_no` | string | 系统生成 | 仓储、应付、审计 | 引用 | 已实现 |
| F-0082 | `inventory_category` | enum | 入库表单 | 库存事实 | 类型门禁 | 已实现 |
| F-0083 | `inventory_quantity` | decimal | 入库/库存事实 | 库存余额 | 库存事实 | 已实现 |
| F-0084 | `movement_id` | UUID | 库存单据 | 反向事实、审计 | 外键 | 已实现 |
| F-0085 | `movement_no` | string | 系统生成 | 仓库、生产、审计 | 引用 | 已实现 |
| F-0086 | `document_type` | enum | 领料/退料/报废 | 库存余额 | 库存事实 | 已实现 |
| F-0087 | `production_order_id` | UUID | 生产单 | 领料、日报、进度 | 外键 | 已实现 |
| F-0088 | `movement_line_id` | UUID | 库存单据明细 | 退料/报废 | 外键 | 已实现 |
| F-0089 | `movement_quantity` | decimal | 领料表单 | 库存余额、生产消耗 | 库存事实 | 已实现 |
| F-0090 | `source_issue_line_id` | UUID | 已过账领料明细 | 退料/报废 | 来源约束 | 已实现 |
| F-0091 | `movement_reason` | string | 退料/报废/冲销 | 审计、告警 | 审计 | 已实现 |
| F-0092 | `available_before` | decimal | 当前库存 | 领料预览 | 只读计算 | 已实现 |
| F-0093 | `available_after` | decimal | 领料草稿 | 领料预览 | 只读计算 | 已实现 |
| F-0094 | `cumulative_issued_quantity` | decimal | 历史领料事实 | 领料预览/生产 | 汇总 | 已实现 |
| F-0095 | `production_outstanding_quantity` | decimal | 生产计划/领料 | 领料预览 | 派生 | 已实现 |
| F-0096 | `inventory_balance_quantity` | decimal | 有效库存事实 | 仓储、报表 | 汇总 | 已实现 |

### 3.6 生产主数据、生产单与进度模块

#### 表单：员工/部门/岗位/工序/地点、生产单、生产工序

| 编号 | 字段 | 类型 | 上游 | 下游 | 联动 | 状态 |
|---|---|---|---|---|---|---|
| F-0097 | `department_id` | UUID | 部门池 | 员工、报表 | 外键 | 已实现 |
| F-0098 | `position_id` | UUID | 岗位池 | 员工、报表 | 外键 | 已实现 |
| F-0099 | `employee_id` | UUID | 员工目录 | 员工日报、工资、考勤 | 外键 | 已实现 |
| F-0100 | `employee_no` | string | 员工目录 | 工资台账、导入导出 | 引用 | 已实现 |
| F-0101 | `employee_type` | enum | 员工表单 | 工资规则、报表 | 类型门禁 | 已实现 |
| F-0102 | `operation_id` | UUID | 工序池 | 生产工序、日报 | 外键 | 已实现 |
| F-0103 | `operation_name` | string | 工序池 | 生产工序快照 | 快照 | 已实现 |
| F-0104 | `operation_unit_id` | UUID | 单位池/工序池 | 日报、计量 | 外键 | 已实现 |
| F-0105 | `location_id` | UUID | 加工地点池 | 生产单、外加工 | 外键 | 已实现 |
| F-0106 | `location_type` | enum | 地点池 | 厂内/外加工分支 | 分支门禁 | 已实现 |
| F-0107 | `production_order_no` | string | 系统生成 | 仓库、日报、QC、出库 | 引用 | 已实现 |
| F-0108 | `execution_mode` | enum | 生产单表单 | 领料/外加工分支 | 分支 | 已实现 |
| F-0109 | `planned_quantity` | decimal | 销售单 | 工序目标、完工、出库 | 引用/门禁 | 已实现 |
| F-0110 | `planned_started_on` | date | 生产单表单 | 进度、报表 | 引用 | 已实现 |
| F-0111 | `delivery_due_on` | date | 销售交期/生产单 | 告警、报表 | 告警 | 已实现 |
| F-0112 | `production_order_operation_id` | UUID | 生产单工序 | 工序日报、员工日报 | 外键 | 已实现 |
| F-0113 | `sequence_no` | int | 工序配置 | 生产排序、进度 | 引用 | 已实现 |
| F-0114 | `target_quantity` | decimal | 生产工序 | 完工门禁、进度 | 数量门禁 | 已实现 |
| F-0115 | `operation_status` | enum | 工序状态机 | 完工校验 | 状态门禁 | 已实现 |
| F-0116 | `completed_quantity` | decimal | 工序日报 | 进度、完工 | 汇总/门禁 | 已实现 |
| F-0117 | `progress_percent` | decimal | 完成量/计划量 | 工作台、报表 | 派生 | 已实现 |

### 3.7 生产日报、员工日报与工资来源

#### 表单：工序日报、员工计件日报、员工计时日报、日报更正

| 编号 | 字段 | 类型 | 上游 | 下游 | 联动 | 状态 |
|---|---|---|---|---|---|---|
| F-0118 | `report_date` | date | 日报表单 | 日汇总唯一键、工资 | 引用/唯一性 | 已实现 |
| F-0119 | `operation_report_quantity` | decimal | 工序日报 | 进度、超单告警 | 汇总/告警 | 已实现 |
| F-0120 | `daily_report_id` | UUID | 日报记录 | 工资来源、审计 | 外键 | 已实现 |
| F-0121 | `payroll_mode` | enum | 员工日报 | 工资计算 | 类型门禁 | 已实现 |
| F-0122 | `piece_quantity` | decimal | 计件日报 | 工资金额 | 派生 | 已实现 |
| F-0123 | `work_hours` | decimal | 计时日报 | 工资金额 | 派生 | 已实现 |
| F-0124 | `manual_unit_price` | decimal | 员工日报人工录入 | 工资金额 | 派生 | 已实现 |
| F-0125 | `daily_salary_amount` | decimal | 件数/时长×单价 | 工资来源/台账 | 派生 | 已实现 |
| F-0126 | `daily_report_remark` | string | 日报表单 | 审计/告警 | 审计 | 已实现 |
| F-0127 | `discrepancy_alert_id` | UUID | 工序日报 vs 员工日报 | 告警中心 | 告警 | 已实现 |
| F-0128 | `over_order_alert_id` | UUID | 工序完成量 > 计划量 | 告警中心 | 告警 | 已实现 |
| F-0129 | `payroll_source_id` | UUID | 员工日报 | 工资台账 | 外键/汇总 | 已实现 |
| F-0130 | `payroll_source_amount` | decimal | 日报工资金额 | 工资台账 | 汇总 | 已实现 |

### 3.8 外加工模块

#### 表单：直发、签收、余料回厂、成品回厂、直装柜

| 编号 | 字段 | 类型 | 上游 | 下游 | 联动 | 状态 |
|---|---|---|---|---|---|---|
| F-0131 | `outsource_batch_id` | UUID | 外加工生产单 | 直发/签收/回厂 | 外键 | 已实现 |
| F-0132 | `outsource_batch_no` | string | 系统生成 | 外加工工作台 | 引用 | 已实现 |
| F-0133 | `dispatch_quantity` | decimal | 采购/生产物料 | 外加工签收 | 数量追溯 | 已实现 |
| F-0134 | `received_quantity_at_site` | decimal | 外加工点签收 | 余料/成品回厂 | 汇总 | 已实现 |
| F-0135 | `returned_material_quantity` | decimal | 外加工余料 | 原料QC/入库 | 下游来源 | 已实现 |
| F-0136 | `returned_finished_goods_quantity` | decimal | 外加工成品回厂 | 成品QC | 下游来源 | 已实现 |
| F-0137 | `direct_container_quantity` | decimal | 外加工直装柜 | 成品出库/应收 | 下游来源 | 已实现 |
| F-0138 | `outsource_receipt_reference` | string | 外加工签收 | 应付/审计 | 引用 | 已实现 |

### 3.9 成品质检、成品仓库与客户退货

#### 表单：成品送检、成品QC、成品入库、不良品、成品出库、客户退货

| 编号 | 字段 | 类型 | 上游 | 下游 | 联动 | 状态 |
|---|---|---|---|---|---|---|
| F-0139 | `finished_qc_id` | UUID | 生产完成/外加工回厂 | 成品入库 | 外键 | 已实现 |
| F-0140 | `finished_qc_source_quantity` | decimal | 生产/外加工来源 | 成品QC | 数量门禁 | 已实现 |
| F-0141 | `finished_qc_accepted_quantity` | decimal | 成品QC | 成品入库 | 数量门禁 | 已实现 |
| F-0142 | `finished_qc_conditional_quantity` | decimal | 成品QC | 成品入库 | 数量门禁 | 已实现 |
| F-0143 | `finished_qc_rejected_quantity` | decimal | 成品QC | 不良品 | 分流 | 已实现 |
| F-0144 | `finished_inbound_id` | UUID | 成品QC | 成品库存 | 外键 | 已实现 |
| F-0145 | `finished_inbound_quantity` | decimal | 成品入库草稿 | 成品库存余额 | 库存事实 | 已实现 |
| F-0146 | `defective_goods_quantity` | decimal | QC不合格/退货 | 不良品库存 | 库存事实 | 已实现 |
| F-0147 | `finished_goods_balance` | decimal | 成品库存事实 | 出库预览/工作台 | 汇总 | 已实现 |
| F-0148 | `finished_outbound_id` | UUID | 成品库存 | 应收来源 | 外键 | 已实现 |
| F-0149 | `finished_outbound_quantity` | decimal | 出库表单 | 成品库存、应收 | 库存事实/派生 | 已实现 |
| F-0150 | `shipment_date` | date | 发货表单 | 应收/物流 | 引用 | 已实现 |
| F-0151 | `carrier` | string | 发货表单 | 发货资料、客户 | 引用 | 已实现 |
| F-0152 | `tracking_no` | string | 发货表单 | 签收、对账 | 引用 | 已实现 |
| F-0153 | `packing_list_no` | string | 发货表单 | 导出/对账 | 引用 | 已实现 |
| F-0154 | `signed_at` | datetime | 签收表单 | 应收/对账 | 状态联动 | 已实现 |
| F-0155 | `customer_return_id` | UUID | 客户退货 | 库存/财务调整 | 外键 | 已实现 |
| F-0156 | `return_quantity` | decimal | 客户退货表单 | 成品/不良品库存 | 库存事实 | 已实现 |
| F-0157 | `return_destination` | enum | 客户退货表单 | 成品/不良品分流 | 分支门禁 | 已实现 |
| F-0158 | `return_reason` | string | 客户退货表单 | 审计/应收调整 | 审计 | 已实现 |

### 3.10 应收、收款与客户对账

#### 表单：应收来源、应收确认、收款、收款核销、退款/红字/调整、应收对账

| 编号 | 字段 | 类型 | 上游 | 下游 | 联动 | 状态 |
|---|---|---|---|---|---|---|
| F-0159 | `receivable_source_id` | UUID | 成品出库 | 应收单、收款核销 | 外键 | 已实现 |
| F-0160 | `receivable_source_amount` | decimal | 出库数量×销售单价 | 应收确认 | 派生 | 已实现 |
| F-0161 | `receivable_status` | enum | 应收状态机 | 收款门禁、订单关闭 | 状态门禁 | 已实现 |
| F-0162 | `receivable_due_date` | date | 应收来源/财务 | 账龄/报表 | 派生 | 已实现 |
| F-0163 | `customer_payment_id` | UUID | 收款草稿 | 应收核销 | 外键 | 已实现 |
| F-0164 | `payment_date` | date | 收款表单 | 核销/报表 | 引用 | 已实现 |
| F-0165 | `payment_amount` | decimal | 收款表单 | 核销金额 | 汇总/门禁 | 已实现 |
| F-0166 | `payment_method` | string | 收款表单 | 财务报表 | 引用 | 已实现 |
| F-0167 | `bank_reference` | string | 收款表单 | 审计/对账 | 引用 | 已实现 |
| F-0168 | `allocation_amount` | decimal | 核销表单 | 应收余额 | 汇总/门禁 | 已实现 |
| F-0169 | `receivable_balance` | decimal | 应收 - 已核销 - 调整 | 订单关闭、账龄 | 派生 | 已实现 |
| F-0170 | `adjustment_type` | enum | 调整表单 | 应收余额 | 分支 | 已实现 |
| F-0171 | `adjustment_effect` | enum | 调整表单 | 应收余额 | 派生 | 已实现 |
| F-0172 | `adjustment_amount` | decimal | 调整表单 | 应收余额 | 派生 | 已实现 |
| F-0173 | `external_balance` | decimal | 外部对账 | 对账差异 | 对账 | 已实现 |
| F-0174 | `reconciliation_status` | enum | 对账处理 | 订单关闭 | 状态门禁 | 已实现 |
| F-0175 | `order_close_preview` | JSON | 全链路聚合 | 订单关闭操作 | 工作台聚合/门禁 | 已实现 |

### 3.11 应付、付款与供应商对账

#### 表单：应付来源、应付确认、付款、付款核销、供应商对账

| 编号 | 字段 | 类型 | 上游 | 下游 | 联动 | 状态 |
|---|---|---|---|---|---|---|
| F-0176 | `payable_source_id` | UUID | 到货/原料入库/外加工签收 | 应付单 | 外键 | 已实现 |
| F-0177 | `payable_source_type` | enum | 来源事实 | 应付确认 | 分支 | 已实现 |
| F-0178 | `payable_source_quantity` | decimal | 到货/入库数量 | 应付金额 | 派生 | 已实现 |
| F-0179 | `payable_source_amount` | decimal | 数量×采购单价 | 应付确认 | 派生 | 已实现 |
| F-0180 | `payable_amount_reason` | string | 金额覆盖 | 审计/对账 | 审计门禁 | 已实现 |
| F-0181 | `payable_status` | enum | 应付状态机 | 付款核销/对账 | 状态门禁 | 已实现 |
| F-0182 | `supplier_payment_id` | UUID | 付款草稿 | 应付核销 | 外键 | 已实现 |
| F-0183 | `supplier_payment_amount` | decimal | 付款表单 | 应付核销 | 汇总/门禁 | 已实现 |
| F-0184 | `supplier_allocation_amount` | decimal | 付款核销 | 应付余额 | 汇总/门禁 | 已实现 |
| F-0185 | `payable_balance` | decimal | 应付 - 已付款 - 调整 | 供应商对账 | 派生 | 已实现 |
| F-0186 | `supplier_external_balance` | decimal | 外部对账 | 对账差异 | 对账 | 已实现 |

### 3.12 人事、考勤、绩效、工资台账与工资支付

#### 表单：员工、考勤、绩效、工资台账、工资调整、工资支付

| 编号 | 字段 | 类型 | 上游 | 下游 | 联动 | 状态 |
|---|---|---|---|---|---|---|
| F-0187 | `employee_name` | string | 员工表单 | 日报、工资、考勤 | 引用 | 已实现 |
| F-0188 | `employment_status` | enum | 员工表单 | 日报/工资/权限 | 状态门禁 | 已实现 |
| F-0189 | `onboarded_at` | date | 员工表单 | 人事报表 | 引用 | 已实现 |
| F-0190 | `offboarded_at` | date | 员工表单 | 日报/工资门禁 | 状态门禁 | 已实现 |
| F-0191 | `attendance_date` | date | 考勤表单 | HR报表/工资参考 | 引用 | 已实现 |
| F-0192 | `attendance_status` | enum | 考勤表单 | HR报表 | 引用 | 已实现 |
| F-0193 | `performance_period` | string | 绩效表单 | 工资台账参考 | 引用 | 已实现 |
| F-0194 | `performance_score` | decimal | 绩效表单 | 工资参考/报表 | 引用 | 已实现 |
| F-0195 | `payroll_ledger_id` | UUID | 工资台账 | 工资支付 | 外键 | 已实现 |
| F-0196 | `payroll_period` | string | 工资台账 | 工资来源筛选 | 引用 | 已实现 |
| F-0197 | `payroll_total_amount` | decimal | 工资来源汇总/人工维护 | 工资支付 | 汇总 | 已实现 |
| F-0198 | `payroll_status` | enum | 工资台账状态机 | 编辑/支付/关闭门禁 | 状态门禁 | 已实现 |
| F-0199 | `payroll_source_expired` | boolean | 日报/来源变化 | 工资台账 | 状态联动 | 已实现 |
| F-0200 | `salary_adjustment_amount` | decimal | 工资调整单 | 工资台账 | 派生 | 已实现 |
| F-0201 | `salary_payment_id` | UUID | 工资付款草稿 | 工资台账核销 | 外键 | 已实现 |
| F-0202 | `salary_payment_amount` | decimal | 工资支付表单 | 工资台账余额 | 汇总/门禁 | 已实现 |
| F-0203 | `salary_payment_allocation` | decimal | 工资核销 | 工资余额 | 汇总/门禁 | 已实现 |

### 3.13 工作台、报表与告警

| 编号 | 字段 | 类型 | 上游 | 下游 | 联动 | 状态 |
|---|---|---|---|---|---|---|
| F-0204 | `search_order_no` | string | 工作台查询 | 全模块查询 | 查询引用 | 已实现 |
| F-0205 | `blocking_reasons` | JSON | 各模块状态/告警 | 工作台、关闭预览 | 工作台聚合 | 已实现 |
| F-0206 | `audit_timeline` | JSON | 审计事件 | 工作台、详情页 | 审计聚合 | 已实现 |
| F-0207 | `report_period_start` | date | 报表查询 | 报表结果 | 查询 | 已实现 |
| F-0208 | `report_period_end` | date | 报表查询 | 报表结果 | 查询 | 已实现 |
| F-0209 | `report_status_filter` | enum | 报表查询 | 报表结果 | 查询 | 已实现 |
| F-0210 | `alert_id` | UUID | 业务规则 | 告警中心 | 外键 | 已实现 |
| F-0211 | `alert_type` | enum | 超单/差异/库存/阻塞 | 告警中心 | 告警 | 已实现 |
| F-0212 | `alert_status` | enum | 告警处理 | 工作台/报表 | 状态联动 | 已实现 |
| F-0213 | `alert_remark` | string | 告警处理 | 审计、工作台 | 审计 | 已实现 |

## 4. 表单索引与字段绑定

| 模块 | 表单/工作区 | 主要字段编号 | 上游 | 下游 |
|---|---|---|---|---|
| 客户 | 客户新建/编辑 | F-0015~F-0020 | 人工录入 | 销售、财务 |
| 客户 | 联系人新建/编辑 | F-0021~F-0023 | 客户 | 销售单 |
| 销售 | 销售单新建/编辑 | F-0002、F-0024~F-0037 | 客户、人工 | BOM、采购、生产、应收 |
| BOM | BOM新建/编辑/发布 | F-0038~F-0054 | 已确认销售单、原料池 | 采购、生产 |
| 采购 | 采购单新建/编辑/下单 | F-0002、F-0038、F-0055~F-0066 | BOM、供应商 | 到货、应付 |
| 采购 | 到货批次 | F-0002、F-0061~F-0073 | 采购明细 | QC、入库、应付 |
| 来料QC | 来料检验 | F-0067~F-0079 | 到货批次 | 原料入库、不良品 |
| 仓库 | 原料入库 | F-0080~F-0083 | 来料QC | 原料库存、应付 |
| 仓库 | 领料/退料/报废/冲销 | F-0005、F-0084~F-0096 | 生产单、库存 | 生产、库存、审计 |
| 生产 | 生产主数据 | F-0097~F-0106 | 人事/单位池 | 生产单、日报 |
| 生产 | 生产单/工序 | F-0002、F-0107~F-0117 | 销售单、BOM | 领料、日报、QC |
| 生产 | 工序日报/员工日报 | F-0118~F-0130 | 生产单、员工、工序 | 进度、告警、工资 |
| 外加工 | 直发/签收/回厂/直装柜 | F-0131~F-0138 | 采购、生产 | QC、库存、应付、应收 |
| 成品 | 成品QC/入库/不良品 | F-0139~F-0147 | 生产完成/外加工 | 出库、库存 |
| 成品 | 出库/发货/客户退货 | F-0148~F-0158 | 成品库存、销售单 | 应收、库存调整 |
| 财务 | 应收/收款/核销/对账 | F-0159~F-0175 | 出库、客户 | 订单关闭 |
| 财务 | 应付/付款/核销/对账 | F-0176~F-0186 | 到货、入库、外加工 | 供应商结算 |
| 人事 | 员工/考勤/绩效 | F-0097~F-0101、F-0187~F-0194 | 人工录入 | 日报、工资 |
| 人事/财务 | 工资台账/支付 | F-0118~F-0130、F-0195~F-0203 | 员工日报、HR数据 | 财务、报表 |
| 工作台 | 订单全链路 | F-0002、F-0204~F-0206 | 全模块 | 关闭检查 |
| 报表/告警 | 查询/导出/告警 | F-0207~F-0213 | 全模块事实 | 管理决策 |

## 5. 关系指针字典

| 关系编号 | 上游 | 下游 | 类型 | 规则 |
|---|---|---|---|---|
| R-0001 | 客户 `id` | 销售单 `customer_id` | 外键 | 销售单必须关联有效客户 |
| R-0002 | 销售单 `order_no` | BOM/采购/生产/仓库/财务 `order_no` | 引用 | 全链路业务身份证 |
| R-0003 | 销售单确认状态 | BOM创建 | 状态门禁 | 未确认销售单不可创建正式BOM |
| R-0004 | BOM明细 `material_id` | 采购明细 `material_id` | 引用 | 只能使用启用原料 |
| R-0005 | 采购明细 | 到货批次 | 外键/数量门禁 | 累计到货计算剩余量/超单 |
| R-0006 | 到货批次 | 来料QC | 外键/一对一 | 一批到货只生成一条有效QC记录 |
| R-0007 | 来料QC合格/条件接收量 | 原料入库 | 数量门禁 | 入库量不得超过可入库量 |
| R-0008 | 原料入库过账 | 原料库存余额 | 库存事实 | 仅过账事实改变库存 |
| R-0009 | 生产单 | 领料单 | 外键/状态门禁 | 进行中生产单才能领料 |
| R-0010 | 领料事实 | 退料/报废 | 来源约束 | 退料/报废只能引用已过账领料 |
| R-0011 | 生产单工序 | 工序日报/员工日报 | 外键/唯一性 | 按生产单、工序、员工、日期隔离 |
| R-0012 | 员工日报 | 工资来源 | 汇总/派生 | 件数或时长×人工单价 |
| R-0013 | 生产完成/外加工回厂 | 成品QC | 来源约束 | 发出量不等于外加工完成量 |
| R-0014 | 成品QC合格/条件接收量 | 成品入库 | 数量门禁 | 未检验/不合格不可入可用库存 |
| R-0015 | 成品入库过账 | 成品库存余额 | 库存事实 | 过账才增加可用成品库存 |
| R-0016 | 成品出库过账 | 应收来源 | 派生/一对一 | 出库数量×销售单价 |
| R-0017 | 应收来源 | 收款核销 | 外键/金额门禁 | 收款必须核销有效应收 |
| R-0018 | 到货/入库/外加工签收 | 应付来源 | 派生 | 默认数量×采购单价 |
| R-0019 | 应付来源 | 付款核销 | 外键/金额门禁 | 付款不得无来源或超额核销 |
| R-0020 | 全模块事实 | 订单工作台 | 工作台聚合 | 按order_no形成状态快照 |
| R-0021 | 业务规则 | 告警中心 | 告警 | 超单、差异、库存不足、链路阻塞 |
| R-0022 | 日报来源变化 | 工资台账 | 状态联动 | 草稿刷新；已确认/已支付转过期 |
| R-0023 | 退货/退款/红字/冲销 | 原事实 | 回退/冲销 | 不删除原事实，生成反向或调整事实 |

## 6. 当前实现与验收状态

- 本地快速质量门禁：TypeScript、单元测试、API/Web 构建、发布归档已通过。
- 真实 PostgreSQL、HTTP API、Playwright 链路受测试环境变量阻塞：`TEST_DATABASE_URL`、`API_BASE_URL`、`PLAYWRIGHT_BASE_URL`。
- 字段“已实现”表示代码/接口/页面至少存在，不等同于已完成真实业务验收。
- 采购退货、自动排产、自动采购建议、标准自动计薪、税费社保、银行自动对账、库位/批号成本、无审批盘盈盘亏不属于当前 V1.0 主链。

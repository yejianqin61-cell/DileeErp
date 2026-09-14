# 财务示例表格（example/财务）解析 · 字段映射与导出设计

- 日期：2026-09-14
- 状态：**口径已确认（见 §6）；三期全部已实施**，见 §9、§10、§11
- **老系统那 6 份表已全部落地**：销售对账明细表（23 列）、销售对账汇总表（10 列）、
  采购对账明细表（16 列）、销售利润报表(毛利)（10 列）、收支明细表（6 列）、收支汇总表（4 列，多一列「币种」）
- 负责人：导出表单负责人
- 需求来源：用户 2026-09-14 直接指令「解析 example/财务 下的财务表单，逐个表单确认字段映射、实施方案、前后端设计」
- 关联文档：`docs/memo/0914-财务示例表格待确认事项.md`（同日 16:39 的初步记录）、
  `docs/design/finance-module-refactor-2026-09-14.md`、`docs/design/export-numeric-cells-and-progress-sheet-2026-09-14.md`、
  `docs/design/reports-export-alert-center-implementation-design.md`

---

## 0. 结论速览

1. **这 6 份表是老系统（WPS 表格 / 管家）导出的报表**：`销售利润报表(毛利).xls` 的工作簿属性里
   `Application = "WPS 表格"`、`LastAuthor = "管家"`、`KSOProductBuildVer = 2052-12.1.0.20784`。
   数据行里的单号（`XSDD2026090700001`、`CGDH1319`）与产品代码（`WPTM2026090700003`、`DL260173`）
   都是**老系统的编号**，不是本系统的编号规则。→ 它们应当被当作**目标报表版式（列清单 + 列序）**，
   而不是「要导入的历史数据」。
2. **按落地难度分三档**：

   | 档 | 表单 | 现状 |
   | --- | --- | --- |
   | A 可直接落地 | 销售对账明细表、采购对账明细表 | 底层事实齐全，缺 4~6 个字段（含税单价/税额/折扣/调整金额/产品代码），本币列可由汇率派生 |
   | B 需补字段或补口径 | 销售对账汇总表、销售利润报表(毛利) | 「开票金额」「税额（汇总层）」字段不存在；「成本金额」**完全没有数据来源** |
   | C 需新建模型 | 收支明细表、收支汇总表 | 「收支流水」与「收支项目字典」在系统里完全不存在 |

3. **一个必须说的技术事实**：6 份表的**所有数据单元格都是文本型数字**（BIFF 单元格格式 `z="@"`、类型 `s`），
   表头才是 `General`。这正是 `docs/design/export-numeric-cells-and-progress-sheet-2026-09-14.md` 里已经修掉的毛病
   （文本型数字在 Excel 里 `SUM` 得 0、按字典序排序）。→ 我们的导出**必须落数值类型**，
   这是对模板的**有意偏离**（是改进，不是不一致）。
4. **汇总层的币种被混加**：`收支汇总表` 的「货款」收入 5428 是**美元**（1000 + 4428），
   支出 2900 是**人民币**，而表只有「收入/支出」两列。**已确认按币种分行、不做跨币种相加**（§6-R7）。

---

## 1. 解析结果（逐表原文）

解析方式：`xlsx@0.18.5`（`XLSX.readFile`）读取 BIFF8，逐单元格打印地址/类型/格式/值。

### 1.1 收支明细表.xls

| 项 | 值 |
| --- | --- |
| Sheet | `SaleOrderAmout Management`（注意：沿用老系统的 sheet 名，`Amout` 是拼写错误） |
| 范围 | `A1:F4`（表头 1 行 + 3 行样本） |
| 列 | 日期 / 对方名称 / 币种 / 收入 / 支出 / 结算方式 |
| 数据格式 | 表头 `General`；数据 `z="@"` 全文本 |

样本行：

| 日期 | 对方名称 | 币种 | 收入 | 支出 | 结算方式 |
| --- | --- | --- | --- | --- | --- |
| 2026-09-14 | 兴田 | 人民币 | 0 | 2900 | 转账--农业银行5706 |
| 2026-09-14 | 中谷ZG | 美元 | 1000 | 0 | 转账--中国银行（美元）7624 |
| 2026-09-14 | 法国NA | 美元 | 4428 | 0 | 转账--中国银行（美元）7624 |

关键观察：**收入与支出是两个并列列而不是一个带符号的金额**；「结算方式」把**方式 + 银行账户**写在一格
（`转账--农业银行5706`），说明它同时承担了「结算方式」和「结算账户」两个概念。

### 1.2 收支汇总表.xls

| 项 | 值 |
| --- | --- |
| Sheet | `List` |
| 范围 | `A1:C39`（表头 1 行 + **37 个具名项目** + 1 行空项目） |
| 列 | 项目 / 收入 / 支出 |
| 数据 | 只有「货款」一行有值：收入 5428、支出 2900，其余全为 0 |

项目清单（原文照抄，含原文里的多余空格）：

```
备用金 / 货款 / 美金转入 / 原材料 成本 / 外加工费 晋江大田工资 / 成品外加工费 / 房租支出 /
会展费用 / 销售费用 / 货代费 / 水电费 / 国际快递费 / 机器折旧费用 / 辅料费 /
制造费用-货拉拉 / 制造费用-物流 / 销售费用-货拉拉 / 生产用品、工具费用 / 管理费用 /
销售样品费 / 销售知识产权费用 / 顺丰快递费 / 办公费用 / 差旅费 / 验厂费 / 杂费车间装修费 /
财务费用-手续费 / 财务费用-外账 / 银行费用利息 / 电商费用 / 机械维修费 / 员工福利费 /
员工餐费 / 国家退税 / 人 工费 / 加工费 / 中国银行 美元
（第 39 行：空项目名，收入 0、支出 0）
```

> 修正 `docs/memo/0914-财务示例表格待确认事项.md` 的一处笔误：那里写「39 个项目」，
> 实际是 **37 个具名项目 + 1 行空行**（39 是含表头的行数）。

关键观察（影响建模）：
- 这份清单**不是纯费用类目**：它混了 **收入项目**（美金转入、国家退税）、**支出项目**（房租支出、水电费）、
  以及 **银行账户**（`中国银行 美元`）。也就是说它其实是「资金头寸/现金流汇总」，不是「费用科目表」。
- 项目之间没有层级（`制造费用-货拉拉` 用连字符表达层级、`销售费用-货拉拉` 与 `货代费` 语义重叠）。
- 与明细表的对应关系被验证了：明细表 3 行（+1000、+4428 USD；-2900 CNY）→ 汇总表「货款」行
  （收入 5428、支出 2900）。**明细表的「对方名称」在汇总里完全消失**，说明汇总只按「项目」聚合，
  而「项目」是流水的属性而不是对方的属性。

### 1.3 采购对账明细表.xls

| 项 | 值 |
| --- | --- |
| Sheet | `Purchase Management` |
| 范围 | `A1:P2`（表头 1 行 + 1 行样本） |
| 列数 | 16（A–P） |

列序：`日期 / 采购单号 / 供应商名称 / 产品名称 / 产品代码 / 规格型号 / 单位 / 币种 / 单价 / 含税单价 /
数量 / 折扣 / 税额 / 调整金额 / 金额 / 含税金额`

样本行（关键值）：`2026-09-08 / CGDH1319 / 碧江 / 23寸*10K 三折自开收 / WPTM2026090700003 /
<长规格串> / 打 / 人民币 / 99 / 99 / 42 / (空) / (空) / (空) / 4158 / 4158`

> 样本里 **含税单价 = 单价 = 99、含税金额 = 金额 = 4158**（42 × 99 = 4158 ✓），
> 而 折扣 / 税额 / 调整金额 三列**全空**。这与本系统采购侧的既有约定一致：
> 见 `purchase-order-export.service.ts` 第 16 行注释「含税单价 = 采购明细单价（系统单价即含税价）」。

### 1.4 销售对账明细表.xls

| 项 | 值 |
| --- | --- |
| Sheet | `Saleorder Management`（老系统拼写：`Saleorder` 而不是 `SaleOrder`） |
| 范围 | `A1:W3`（表头 1 行 + 2 行样本） |
| 列数 | **23（A–W）**，其中后 6 列是「(本)」本币列 |

列序：`日期 / 销售单号 / 客户名称 / 产品名称 / 产品代码 / 规格型号 / 单位 / 币种 / 单价 / 含税单价 /
税额 / 调整金额 / 折扣 / 数量 / 金额 / 含税金额 / 汇率 / 单价(本) / 含税单价(本) / 税额(本) /
调整金额(本) / 金额(本) / 含税金额(本)`

两个样本行（已核对算术关系，**这条很重要**）：

| 列 | 行1 | 行2 |
| --- | --- | --- |
| 日期 | 2026-09-07 | 2026-09-14 |
| 销售单号 | XSDD2026090700001 | XSDD2026091400001 |
| 客户名称 | Matthew Jackson | 静心文化学会 |
| 产品名称 | DL260173-23寸*10K三折自开收伞 | DL260172-30寸*8K 自动直骨伞 |
| 产品代码 | DL260173 | DL260172 |
| 币种 | 美元 | 人民币 |
| 单价 | 44.685 | 384 |
| 数量 | 41.67 | 25 |
| 金额 | 1862.024 | 9600 |
| 汇率 | 6.7 | 1 |
| 单价(本) | 299.389 | 384 |
| 金额(本) | 12475.56 | 9600 |

**算术校验全部通过**，由此确定了三个口径：
1. `金额 = 单价 × 数量`（44.685 × 41.67 = 1862.0239… → 1862.024）
2. `单价(本) = 单价 × 汇率`（44.685 × 6.7 = 299.3895 → 299.389，**截断**而非四舍五入）
3. `金额(本) = 金额 × 汇率`（1862.024 × 6.7 = 12475.5608 → 12475.56）

并且 `日期` 与 `销售单号` 内嵌的日期一致（`XSDD`**20260907** ↔ 2026-09-07；`XSDD`**20260914** ↔ 2026-09-14）
→ **「日期」= 销售单日期**，不是出库日期。

> 另一个发现：`产品名称` 是「产品代码 + 连接符 + 名称」的拼接（`DL260173-23寸*10K三折自开收伞`），
> 而 `产品代码` 是它的前缀（`DL260173`）。本系统没有「产品代码」这个字段。

### 1.5 销售对账汇总表.xls

| 项 | 值 |
| --- | --- |
| Sheet | `SaleOrderAmout Management` |
| 范围 | `A1:J1` —— **只有表头，没有任何数据行** |

列：`日期 / 客户名称 / 单号 / 币种 / 销售金额 / 调整金额 / 税额 / 已收金额 / 开票金额 / 欠款`

> 「只有表头」这一点在 `docs/memo/0914-...` 里已记录，本次复核确认：`!ref = A1:J1`。
> 没有样本数据 → **「单号」指什么、「欠款」怎么算，无法从文件反推，必须问业务**（见 §6-Q4）。

### 1.6 销售利润报表(毛利).xls

| 项 | 值 |
| --- | --- |
| Sheet | `AllGoods Management` |
| 范围 | `A1:J2`（表头 1 行 + 1 行样本） |
| 工作簿 | `Application=WPS 表格`、`LastAuthor=管家`、`CreatedDate=2026-09-14T08:32:12Z` |

列：`日期 / 单号 / 客户名称 / 币种 / 销售金额 / 成本金额 / 销售利润 / 销售金额(本) / 成本金额(本) / 销售利润(本)`

样本行：`2026-06-05 / XSDD2026060500002 / 中谷ZG / 美元 / 24525 / 0 / 24525 / 164317.5 / 0 / 164317.5`

关键观察：
- `销售金额(本) = 24525 × 6.7 = 164317.5` ✓ → 同样隐含汇率 6.7（美元）。
- **`成本金额 = 0`**：样本里成本是 0，很可能是老系统没维护成本而不是真的零成本。
  → 「成本金额」的数据来源是本轮**最大的未知**（见 §6-Q5）。
- 表头写「(毛利)」但列名是「销售利润」，且 销售金额 − 成本金额 = 销售利润（24525 − 0 = 24525 ✓）。

---

## 2. 逐表字段映射（表单列 → 本系统业务字段）

图例：✅ 直取 ｜ 🔁 需转换（字典/格式）｜ 🧮 派生（可算）｜ ⚠️ 口径待定 ｜ ❌ 缺口

### 2.1 销售对账明细表（23 列）

数据源建议：`receivable_sources`（应收来源，一条 = 一次成品出库过账）为主表，
关联 `finished_goods_outbounds` / `sales_orders` / `customers`。

| # | 表单列 | 系统来源 | 结论 |
| --- | --- | --- | --- |
| 1 | 日期 | `sales_orders.order_date` | ✅（已由单号内嵌日期验证） |
| 2 | 销售单号 | `sales_orders.order_no`（= `receivable_sources.order_no`） | ✅ |
| 3 | 客户名称 | `customers.name`（列表接口已给 `customer_name`） | ✅ |
| 4 | 产品名称 | `finished_goods_outbounds.product_name_snapshot`（接口已给 `product_name`） | ✅ |
| 5 | 产品代码 | **无字段** | ❌ 建议新增 `sales_orders.product_code` |
| 6 | 规格型号 | `finished_goods_outbounds.product_specification_snapshot` | ✅ |
| 7 | 单位 | `receivable_sources.unit` | ✅ |
| 8 | 币种 | `sales_orders.currency`（存 `CNY`/`USD` 代码） | 🔁 需代码→中文标签（`dictionary_items` label） |
| 9 | 单价 | `receivable_sources.unit_price` | ✅ |
| 10 | 含税单价 | **无字段** | ❌ |
| 11 | 税额 | **无字段**（只有 `tax_rate` 税率，没有税额） | ❌ |
| 12 | 调整金额 | `receivable_adjustments`（独立单据，需按应收来源聚合 `amount`+`effect`） | 🧮 可派生（非本表字段） |
| 13 | 折扣 | **无字段** | ❌ |
| 14 | 数量 | `receivable_sources.quantity` | ✅ |
| 15 | 金额 | `receivable_sources.amount` | ✅ |
| 16 | 含税金额 | **无字段**（若「单价即含税价」则 = 金额） | ⚠️ 口径待定 |
| 17 | 汇率 | **无字段**；可由 `sales_orders.local_currency_amount ÷ total_amount` 反推 | 🧮 派生（已验证 6.7 ✓） |
| 18 | 单价(本) | `单价 × 汇率` | 🧮 |
| 19 | 含税单价(本) | `含税单价 × 汇率` | 🧮 |
| 20 | 税额(本) | `税额 × 汇率` | 🧮 |
| 21 | 调整金额(本) | `调整金额 × 汇率` | 🧮 |
| 22 | 金额(本) | `sales_orders.local_currency_amount`（拆分到出库行）/ `金额 × 汇率` | 🧮（样本吻合） |
| 23 | 含税金额(本) | `含税金额 × 汇率` | 🧮 |

### 2.2 采购对账明细表（16 列）

数据源建议：`supplier_payable_entries`（应付条目）+ `payable_sources` / `purchase_order_items` / `materials`。

| # | 表单列 | 系统来源 | 结论 |
| --- | --- | --- | --- |
| 1 | 日期 | `purchase_orders.purchase_date`（退路 `created_at`） | ⚠️ 待定：采购日 vs 入库日 vs 应付确认日 |
| 2 | 采购单号 | `purchase_orders.purchase_order_no` | ✅（编号规则不同，见 §4.5） |
| 3 | 供应商名称 | `suppliers.name`（接口已给 `supplier_name`） | ✅ |
| 4 | 产品名称 | `materials.name` | ✅ |
| 5 | 产品代码 | `materials.material_code` | ✅ |
| 6 | 规格型号 | `materials.specification_model` | ✅ |
| 7 | 单位 | `units.name` | ✅ |
| 8 | 币种 | `purchase_orders.currency` | 🔁 代码→中文标签 |
| 9 | 单价 | `supplier_payable_entries.unit_price` / `purchase_order_items.unit_price` | ✅ |
| 10 | 含税单价 | 与「单价」同值（系统约定采购单价即含税价） | ✅（待确认，见 §6-Q3） |
| 11 | 数量 | `supplier_payable_entries.quantity` | ✅ |
| 12 | 折扣 | **无字段** | ❌ |
| 13 | 税额 | **无字段**（只有 `tax_rate`） | ❌ |
| 14 | 调整金额 | **应付侧连调整单据模型都没有**（应收有 `receivable_adjustments`，应付没有） | ❌ |
| 15 | 金额 | `supplier_payable_entries.amount`（含 `extra_fee`） | ✅ |
| 16 | 含税金额 | 与「金额」同值 | ✅（待确认） |

### 2.3 销售对账汇总表（10 列）

数据源（**已确认：按销售单汇总**）：`sales_orders` 为主表，聚合
`receivable_sources`（应收）、`receivable_allocations`（已收，仅 `status=active` 且付款 `status=posted`）、
`receivable_adjustments`（调整净额，`increase` 为正、其余为负）。

| # | 表单列 | 系统来源 | 结论 |
| --- | --- | --- | --- |
| 1 | 日期 | `created_at` / `period_end` | ⚠️ 待定 |
| 2 | 客户名称 | `customers.name` | ✅ |
| 3 | 单号 | `sales_orders.order_no` | ✅ **已确认：销售单号** |
| 4 | 币种 | `receivable_reconciliations.currency` | 🔁 |
| 5 | 销售金额 | `receivable_amount_snapshot` | ✅ |
| 6 | 调整金额 | `adjustment_amount_snapshot` | ✅ |
| 7 | 税额 | **无字段** | ❌ |
| 8 | 已收金额 | `payment_amount_snapshot` | ✅ |
| 9 | 开票金额 | **无字段**：`ReceivableSource` 只有 `invoice_no` / `invoice_date`，**没有发票金额** | ❌ |
| 10 | 欠款 | `应收合计 + 调整净额 − 已收合计`（该销售单未收余额） | ✅ **已确认**（与 `adjustmentOutstanding` 同口径） |

### 2.4 销售利润报表(毛利)（10 列）

数据源建议：`sales_orders` + `customers`。

| # | 表单列 | 系统来源 | 结论 |
| --- | --- | --- | --- |
| 1 | 日期 | `sales_orders.order_date` | ✅ |
| 2 | 单号 | `sales_orders.order_no` | ✅ |
| 3 | 客户名称 | `customers.name` | ✅ |
| 4 | 币种 | `sales_orders.currency` | 🔁 |
| 5 | 销售金额 | `sales_orders.total_amount`（或 `receivable_amount`） | ⚠️ 两者取一 |
| 6 | 成本金额 | **BOM 原料成本**（已确认口径）= Σ(单件用量 × 销售单数量 × 物料采购单价) | 🧮 新增 `BomCostService` |
| 7 | 销售利润 | 销售金额 − 成本金额 | 🧮 |
| 8 | 销售金额(本) | `sales_orders.local_currency_amount` | ✅（样本 164317.5 ✓） |
| 9 | 成本金额(本) | 成本金额 × 汇率 | 🧮 |
| 10 | 销售利润(本) | 销售金额(本) − 成本金额(本) | 🧮 |

### 2.5 收支明细表（6 列）

| # | 表单列 | 系统来源 | 结论 |
| --- | --- | --- | --- |
| 1 | 日期 | `customer_payments.payment_date` / `supplier_payments.payment_date` / `salary_payments.payment_date` | 🧮 需按日 UNION（若不做新模型） |
| 2 | 对方名称 | `payer_name`（收）/ `payee_name`（付）**分列在两张表**，且可为空（不强制） | ❌ 需统一字段 |
| 3 | 币种 | `currency`（三张付款表都有） | 🔁 |
| 4 | 收入 | `customer_payments.amount`（`status=posted`） | 🧮 |
| 5 | 支出 | `supplier_payments.amount` + `salary_payments.amount` | 🧮 |
| 6 | 结算方式 | `payment_method`（自由字符串），模板里含**银行账户** | ⚠️ 需「结算方式 + 结算账户」两个概念 |

现系统里与这张表最接近的是「收付款单」，但**语义不同**：
收付款单是**单据**（有草稿/已过账/冲销状态机、必须核销到应收应付），
而「收支明细」是**资金流水视角**（谁、什么币种、收还是支、走哪个账户），并且要求**收入/支出同排两列**。

### 2.6 收支汇总表（3 列）

| # | 表单列 | 系统来源 | 结论 |
| --- | --- | --- | --- |
| 1 | 项目 | **无字典**（需要新的可配置类目：宪法《Configurable Business Categories》） | ❌ 需新建 `dictionary_type = cash_flow_item`（**已确认新建收支管理板块**） |
| 2 | 收入 | 按项目聚合流水收入 | ❌ 依赖 §2.5 |
| 3 | 支出 | 按项目聚合流水支出 | ❌ 依赖 §2.5 |

---

## 3. 缺口清单（汇总）

| 类型 | 具体项 | 涉及表单 |
| --- | --- | --- |
| 需新增字段（销售） | `product_code`、`tax_amount`（税额）、`tax_included_unit_price`（含税单价）、`discount_amount`（折扣）、`exchange_rate`（汇率） | 销售对账明细表、汇总表、利润表 |
| 需新增字段（应付） | `discount_amount`、`tax_amount`、调整金额（应付侧无调整单据模型） | 采购对账明细表 |
| 需新增字段（发票） | `invoice_amount`（开票金额，现在只有发票号/日期） | 销售对账汇总表 |
| 需新增模型 | 收支流水（含统一「对方名称」「收支项目」「结算方式+账户」） | 收支明细表、收支汇总表 |
| 需新增字典 | `cash_flow_item`（37 个项目 + 收入/支出属性） | 收支汇总表 |
| 需新增字典 | 结算账户（`农业银行5706`、`中国银行（美元）7624`） | 收支明细表 |
| 口径未定 | 欠款公式、单号含义、成本金额来源、采购对账日期基准、含税口径、`total_amount` vs `receivable_amount` | 汇总表、利润表、采购明细 |
| 无需改动 | 汇率/本币 6 列（可由 `local_currency_amount ÷ total_amount` 派生，样本已校验吻合） | 销售对账明细表 |

---

## 4. 设计方案

### 4.1 后端总体

沿用仓库既有导出的三条硬约定（见 `purchase-order-export.controller.ts` / `material-slip-export.controller.ts`）：

1. **端点形态**：`GET /api/v1/finance/reports/<报表名>.xlsx`，二进制响应，
   `Content-Type = application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`，
   `Content-Disposition: attachment; filename*=UTF-8''<URL 编码的中文名>`，`Cache-Control: no-store`。
2. **权限**：`@UseGuards(AuthenticationGuard, ModulePermissionGuard)` + `@RequireModules("finance")` +
   `@RequireAdministrator()`（与采购订单导出、领料单导出同一档；若要求「财务角色也能导出」需另立规则）。
3. **写数值不写文本**：用 **ExcelJS** 写入 `number` 并设 `numFmt`（采购订单/领料单的既有做法），
   **不能**把 `Prisma.Decimal.toString()` 直接写进单元格（这是 2026-09-14 刚修掉的问题）。

建议新增文件（`apps/api/src/modules/finance/`）：

| 文件 | 职责 |
| --- | --- |
| `finance-report-export.controller.ts` | 6~8 个导出端点 + DTO 校验（`from`/`to`/`customer_id`/`supplier_id`/`order_no`/`currency`） |
| `finance-report-export.service.ts` | 编排：查询 → 组装行 → 交给 `finance-report-workbook.ts` |
| `finance-report-workbook.ts` | 纯函数：把「报表行 + 列定义」渲染成 ExcelJS 工作簿（可单测，不碰数据库） |
| `finance-report-query.service.ts` | 各报表的取数（`Prisma` 查询 + 派生列计算） |
| `sales-reconciliation-detail.report.ts` 等 | 每张表的列定义（表头文字、列宽、`numFmt`、取数函数） |

设计要点：
- **列定义即模板**：把示例表的列名与列序写成常量数组（表头文字、列宽、数字格式），
  这样「版式一致」这件事是被数据结构保证的，而不是散落在渲染代码里。
- **派生列集中在一处算**：汇率/本币 5~6 列、利润、欠款等派生公式统一放在 `*.domain.ts`（纯函数 + 单测），
  避免「页面显示的和导出的不一样」。
- **Decimal 全程字符串 → 出口转 number**：查询层保持 `Prisma.Decimal`，
  只在写单元格时 `Number(...)`（4 位小数精度足够，金额上限 DECIMAL(18,4) 在 IEEE754 双精度内精确表示到分）。
- **行数上限 + 明确报错**：超过上限（建议 20000 行）返回 422 并提示缩小期间，
  不静默截断（宪法：不能让人以为导出是全量）。
- **审计**：导出是读操作，但「谁在什么时候导出了哪个期间的对账」是财务要留痕的，
  建议写一条 `audit_events`（`finance_report.export`，details 记录筛选条件与行数）；
  这与「读取接口不产生审计事实」的既有约定有冲突，**需要确认**。
- **币种标签**：新增 `currencyLabel(code)`，从 `dictionary_items`（`dictionary_types.key='currency'`）取 `label`，
  找不到时回落原代码 —— 与全站「未登记枚举回落字典」的做法一致。

### 4.2 端点清单

```text
GET /finance/reports/sales-reconciliation-detail.xlsx     # 销售对账明细表（23 列）
GET /finance/reports/purchase-reconciliation-detail.xlsx  # 采购对账明细表（16 列）
GET /finance/reports/sales-reconciliation-summary.xlsx    # 销售对账汇总表（10 列）
GET /finance/reports/sales-gross-profit.xlsx              # 销售利润报表(毛利)（10 列）
GET /finance/reports/cash-flow-detail.xlsx                # 收支明细表（6 列）      ← 依赖新模型
GET /finance/reports/cash-flow-summary.xlsx               # 收支汇总表（3 列）      ← 依赖新模型
GET /finance/reports/<name>.csv                           # 同上，CSV 兜底（可选）
```

统一查询参数：`from`、`to`（必填，限定期间，默认本月）、
`customer_id` / `supplier_id`、`order_no`、`currency`、`include_draft`（是否含草稿，**默认不含**）。

> 「默认不含草稿」是财务口径的默认值：草稿应收/应付还没确认，把它算进对账金额会让「欠款」虚高。
> 这与 `docs/design/finance-module-refactor-2026-09-14.md` 里「已付/未付只算已过账」的口径一致。

### 4.3 前端设计

**入口**：`/finance` 一级页由 4 个板块扩为 **6 个**，新增：

- 「财务报表」→ `/finance/reports?tab=<key>`：6 张表各一个 tab（沿用 `searchParams` 读 tab 的既有约定，
  客户端组件不需要 `useSearchParams`）；
- 「收支管理」→ `/finance/cash-flow`：资金流水的手工录入与项目字典维护（见 §4.6）。

- `apps/web/lib/finance-sections.ts` 增加 `FINANCE_BOARDS` 第 5/6 项（财务报表、收支管理）
  + `FINANCE_REPORT_TABS`（6 个 tab）。
  该文件是**无 `"use client"` 的纯数据模块**，是硬约束（从 client 模块导入常量会让 `next build` 失败，
  仓库有守卫 `apps/web/lib/server-client-boundary.test.mjs`）。
- 新增 `apps/web/components/finance/finance-report-workspace.tsx`（客户端组件）：
  - 顶部筛选条：期间（默认本月）、客户/供应商、币种、订单号、`包含草稿` 开关；
  - 「导出 XLSX」按钮 → 复用 `apps/web/lib/download.ts` 的 `downloadFile()`（已带 120s 超时与错误信封解析）；
  - 导出中禁用按钮 + 文案改「导出中...」（沿用 `payroll-export-panel.tsx` 的成熟交互）；
  - 页面表格：同一份数据先走 JSON 端点预览，再导出（避免「看到的和导出的不是一批」）。
- 表格预览用的 JSON 端点：`GET /finance/reports/<name>`（`{ data, meta }`），与 xlsx 共用同一个取数服务，
  保证页面与导出版式一致。
- 空态/错误态：`EmptyState` / `ErrorState`，与全站一致。
- testid：`page-finance-reports`，并更新 `testid-pages` 约定。

**为什么不把导出按钮直接挂在「应收对账 / 应付对账」列表上**：
这 6 张表里有 4 张是**跨板块汇总表**（含收支），挂在单一子栏目下会让人找不到；
而汇总表的「客户 + 期间」筛选与「应收对账」列表的筛选语义也不同（前者是导出范围，后者是单据筛选）。

### 4.4 数据模型改动

**一期 / 二期：零迁移。** 已确认「缺的列导出留空」（Q2）与「成本取 BOM 原料成本」（Q5），
因此缺口字段**不落库**，改动全部在查询与派生层：

| 报表 | 缺列 | 处理 |
| --- | --- | --- |
| 销售对账明细表 | 产品代码 / 含税单价 / 税额 / 折扣 / 调整金额列 / 含税金额 | 导出留空 |
| 销售对账汇总表 | 税额 / 开票金额 | 导出留空 |
| 采购对账明细表 | 折扣 / 税额 / 调整金额 | 导出留空 |

> 「留空」是**空单元格，不写 0**：0 是「确实为零」的事实，空是「系统没有这个数据」，
> 两者在财务上完全不同（宪法：不得因缺少下游事实而填充为已完成）。

**三期（收支管理）需要 1 个加法迁移**，可安全重跑：

```sql
-- 1) 字典：收支项目（37 个，含 收入/支出 属性）+ 结算账户
INSERT INTO dictionary_types(key='cash_flow_item',  name='收支项目') ...
INSERT INTO dictionary_types(key='settlement_account', name='结算账户') ...
-- 迁移内同时写入示例表的 37 个项目与已知的 2 个账户（农业银行5706 / 中国银行（美元）7624）

CREATE TABLE cash_flow_entries (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_no               varchar(100) NOT NULL UNIQUE,
  entry_date             date         NOT NULL,
  counterparty_name      varchar(200) NOT NULL,   -- 「对方名称」统一字段（模板要求）
  counterparty_type      varchar(30),             -- customer / supplier / other
  direction              varchar(10)  NOT NULL,   -- income / expense
  amount                 decimal(18,4) NOT NULL,  -- 恒为正，方向由 direction 决定
  currency               varchar(10)  NOT NULL,
  exchange_rate          decimal(18,6),
  local_amount           decimal(18,4),
  item_id                uuid NOT NULL REFERENCES dictionary_items(id),
  settlement_method      varchar(50),
  settlement_account_id  uuid REFERENCES dictionary_items(id),
  source_type            varchar(40),             -- 本期恒空，为将来与收付款单联动预留
  source_id              uuid,
  status                 varchar(30) NOT NULL DEFAULT 'posted',
  remark                 varchar(1000),
  created_at/updated_at/created_by/updated_by/deleted_at/deleted_by ...
);
```

两个必须写清楚的设计取舍：

1. **不存「收入列 / 支出列」，存 `direction` + 正数 `amount`**：一表两列是**报表版式**，
   不是存储形态；存成有符号金额则「支出被填成负数」这类错误无法被校验拦住。
2. **与收付款单不做自动联动**（Q6 选的是「手工录入」）：`source_type/source_id` 本期恒空。
   **已知代价**：收付款单过账后不会自动出现在收支流水里，财务需要手工补一条。
   这是本次确认的结果，不是遗漏。

### 4.5 必须写清楚的三个「不一致」

1. **单据编号规则不同**：老系统 `XSDD2026090700001` / `CGDH1319`；
   本系统销售单号是**用户手工录入**（`input.order_no`，可以继续沿用老格式 ✓），
   但**采购单号是系统生成** `PO-YYYYMMDD-XXXXXXXX`（`purchase-orders.service.ts` 第 89 行）
   → 导出的采购单号会与老系统/供应商习惯不一致。若供应商按 `CGDH####` 对账，**需要支持手工录入采购单号**。
2. **Sheet 名不照抄**：老系统 sheet 名有拼写错误（`SaleOrderAmout Management`、`Saleorder Management`）。
   建议用规范中文名（「销售对账明细」「采购对账明细」…）。**列名与列序照抄**。
3. **数字单元格类型**：照抄模板即照抄「数字存成文本」的毛病。我们**写数值类型**，这是有意改进。

### 4.6 收支管理板块（三期）

后端：

| 文件 | 职责 |
| --- | --- |
| `cash-flow.controller.ts` | `GET/POST/PATCH /finance/cash-flow-entries`、`POST /:id/reverse`（软删，保留历史事实） |
| `cash-flow.service.ts` | 校验（金额 > 0、币种走已有 `CurrencyDictionaryService.assertSupported`、项目必须存在且启用、账户必须在字典内）；单号 `CF-YYYYMMDD-XXXXXXXX` |
| `cash-flow-report.service.ts` | 收支明细表 / 收支汇总表取数 |

前端：`/finance/cash-flow` 满页表格 + 「新增流水」对话框
（日期 / 对方名称 / 收支方向 / 金额 / 币种 / 收支项目 / 结算方式 / 结算账户 / 备注）；
**项目字典维护复用现有字典管理入口**，不另做界面。

收支汇总表按 Q7 的确认**按币种分行、不跨币种相加**：

| 项目 | 币种 | 收入 | 支出 |
| --- | --- | --- | --- |
| 货款 | 美元 | 5428 | 0 |
| 货款 | 人民币 | 0 | 2900 |

- 导出参数带 `currency` 时只出该币种并省略「币种」列；
- 「合计」只在同一币种内小计，**跨币种不给出总计**（给出来就是错的）。

### 4.7 销售利润表的成本口径（二期）

`BomCostService.materialCost(salesOrderId)`：

1. **单件用量** = `bom_items.approved_usage ÷ production_batch_base`
   （`approved_usage` 空 → 回落 `base_usage` → 再回落 `required_quantity`；基准空按 1）；
2. **取价** = 该 `material_id` 最近一次有效采购明细单价
   （`purchase_order_items.unit_price`，含税；条件 `deleted_at is null` 且采购单 `status != 'cancelled'`，
   按采购日期/创建时间倒序取第一条）；
3. **成本金额** = Σ(单件用量 × 销售单数量 × 取价)；
4. **找不到采购价的物料**：该物料成本按 0 计入，并在导出表底部附「缺采购价物料」清单 ——
   必须显式列出而不是静默按 0 算完，否则利润会被高估且从表上看不出来。

---

## 5. 实施分期建议

| 期 | 内容 | 迁移 |
| --- | --- | --- |
| 一期 | 「财务报表」板块骨架 + 销售对账明细表 + 采购对账明细表（JSON 预览 + XLSX 导出）；`finance-report-workbook.ts`、列定义、汇率/本币派生、币种标签 | 无 |
| 二期 | 销售对账汇总表（按销售单汇总 + 未收余额口径）+ 销售利润报表(毛利)（BOM 原料成本） | 无 |
| 三期 | 「收支管理」板块：`cash_flow_entries` + 收支项目/结算账户字典 + 录入界面 + 收支明细表 + 收支汇总表（按币种分行） | 1 个加法迁移 |

---

## 6. 已确认的业务口径（2026-09-14，用户逐表确认）

| 编号 | 表 | 确认结果 |
| --- | --- | --- |
| R1 | 全部 6 份 | 交付形态 = **导出 XLSX（列名列序照抄模板）+ 页面表格预览**；数字落数值类型，sheet 名用规范中文 |
| R2 | 销售对账明细表 | 缺口列（产品代码 / 含税单价 / 税额 / 折扣 / 调整金额 / 含税金额）**导出留空**；其余按现模型直取；汇率与本币 6 列由 `local_currency_amount ÷ total_amount` 派生 |
| R3 | 采购对账明细表 | 确认「系统采购单价即含税价」：**含税单价 = 单价、含税金额 = 金额** |
| R4 | 销售对账汇总表 | **单号 = 销售单号**（按销售单汇总）；**欠款 = 该销售单未收余额** = 应收合计 + 调整净额 − 已收合计 |
| R5 | 销售利润报表(毛利) | **成本金额 = BOM 原料成本**（BOM 用量 × 采购单价含税），见 §4.7 |
| R6 | 收支明细表 / 收支汇总表 | **新建独立「收支管理」板块**：手工录入资金流水 + 可配置收支项目字典 |
| R7 | 收支汇总表 | **按币种分行/分列，不做跨币种相加** |

---

## 7. 任务拆分（建议，按仓库 `docs/task/<批次>/` 约定）

| 期 | 任务文件 | 内容 |
| --- | --- | --- |
| 一 | `01-finance-report-board-and-shell.md` | 板块入口、`finance-sections.ts` 常量、`/finance/reports` 壳与 tab |
| 一 | `02-report-workbook-and-domain.md` | `finance-report-workbook.ts`（ExcelJS 数值单元格 + `numFmt`）、币种标签、汇率/本币派生（纯函数 + 单测） |
| 一 | `03-sales-reconciliation-detail.md` | 销售对账明细表取数 + 23 列列定义 + 端点 |
| 一 | `04-purchase-reconciliation-detail.md` | 采购对账明细表取数 + 16 列列定义 + 端点 |
| 一 | `05-finance-report-frontend-and-tests.md` | 筛选条、导出交互、页面预览、组件测试、`testid-pages` |
| 二 | `06-sales-reconciliation-summary.md` | 按销售单汇总 + 未收余额 + 10 列 |
| 二 | `07-bom-material-cost-service.md` | `BomCostService`（用量折算 + 最近采购价 + 缺价清单） |
| 二 | `08-sales-gross-profit.md` | 利润表 10 列（销售金额取 `total_amount`，见 §8） |
| 三 | `09-cash-flow-schema-and-dictionaries.md` | 迁移：`cash_flow_entries` + 两个字典 + 37 个项目种子 |
| 三 | `10-cash-flow-entry-api-and-ui.md` | 流水 CRUD 端点 + `/finance/cash-flow` 录入界面 |
| 三 | `11-cash-flow-reports-currency-rows.md` | 收支明细表 / 汇总表（按币种分行） |
| 三 | `12-acceptance-and-regression.md` | 单测 + HTTP 契约 + Web 构建 + 浏览器验收 |

---

## 8. 剩余默认值（不阻塞；如无异议按此实施）

1. 销售对账汇总表的「税额」「开票金额」两列**同样导出留空**（字段确实不存在，是 R2 决策的延伸）；
2. 采购对账明细表的「日期」= `purchase_orders.purchase_date`（空则回落 `created_at`）；
3. 利润表的成本按**销售单数量**折算（不是已出库数量）—— 若希望只计已发货部分请指出；
4. 取价用「最近一次有效采购明细单价」，**不做加权平均**；
5. 导出权限先按**仅管理员**实现，与采购订单导出、领料单导出一致；
6. 导出**默认不含草稿**应收/应付（与既有「已付/未付只算已过账」口径一致）；
7. 单次导出行数上限 **20000**，超出报 422 而不是静默截断；
8. 导出**不写** `audit_events`（读操作，与「读取接口不产生审计事实」的既有约定一致）；
   若财务要求导出留痕，再加 `finance_report.export` 事件。

---

## 9. 一期实施记录（2026-09-14，已实施）

范围：一期的两张表 —— 销售对账明细表（23 列）、采购对账明细表（16 列）。
**零迁移**（R2 的缺口列留空、汇率本币派生，都不需要新字段）。

### 9.1 新增文件

| 文件 | 职责 |
| --- | --- |
| `apps/api/src/modules/finance/finance-report.domain.ts` | 纯口径：汇率、本币金额/单价、数值转换、日期文本、币种标签、数值格式 |
| `apps/api/src/modules/finance/finance-report.types.ts` | 版式类型（`ReportColumn`/`ReportCell`/`ReportTable`/`FinanceReportFilter`） |
| `apps/api/src/modules/finance/finance-report.tables.ts` | 两张表的列定义（照抄老表）+ 行构造 + 合计行 |
| `apps/api/src/modules/finance/finance-report-workbook.ts` | ExcelJS 渲染：数值类型硬约束、合计公式、表尾说明 |
| `apps/api/src/modules/finance/finance-report-query.service.ts` | 取数（含默认不含草稿、期间边界、行数上限） |
| `apps/api/src/modules/finance/finance-report.controller.ts` | 4 个端点（2 张表 × 预览/xlsx） |
| `apps/web/components/finance/finance-report-workspace.tsx` | 财务报表页（筛选 + 预览 + 导出） |
| `apps/web/app/finance/reports/page.tsx` | 路由装配（服务端读 `searchParams`） |
| `apps/api/test/unit/finance-report-*.test.cjs`（4 个） | 口径 18 + 工作簿 11 + 取数 14 + 接口 8 = 51 条 |
| `apps/web/test/finance-report-page.test.tsx` | 页面行为 14 条 |

改动的既有文件：`finance.module.ts`（注册 controller/service）、
`lib/finance-sections.ts`（新增 `reports` 板块与 `FINANCE_REPORT_TABS`）、
`finance-board-index.tsx`（板块说明文字）、`test/testid-pages.test.ts`（登记 `page-finance-reports`）、
`test/finance-page.test.tsx`（板块数 4 → 5）。

### 9.2 相对 §4 设计的三处细化（都是为了对账能对上账）

1. **本币金额按比例分摊，而不是「原币 × 汇率」**：汇率是收敛到 6 位的展示值，
   乘回去会与销售单上权威的 `local_currency_amount` 差 0.0008
   （样本：1862.024 × 6.7 = 12475.5608，而本币金额是 12475.56）。
   改为 `本币金额 × (本行原币 ÷ 订单原币)`：整单出库精确相等，分批出库各行相加也回到整单金额。
2. **本币单价由本币金额 ÷ 数量反算**，保证 `单价(本) × 数量 == 金额(本)` 恒成立。
3. **数值格式统一 `0.####`**（不是固定 2 位）：老表同一列里既有 `99`、`1862.024`，
   也有 `12475.56`，固定小数位还原不了老表显示。

另外：合计行导出时**公式与缓存结果一起写** —— 只写公式的话，不重算公式的读取器
（包括断言用的 SheetJS）读到的公式格是空的。

### 9.3 端点

```text
GET /finance/reports/sales-reconciliation-detail          # 预览（finance 模块权限）
GET /finance/reports/sales-reconciliation-detail.xlsx     # 导出（仅管理员）
GET /finance/reports/purchase-reconciliation-detail       # 预览
GET /finance/reports/purchase-reconciliation-detail.xlsx  # 导出（仅管理员）
```

筛选参数：`from` / `to` / `order_no` / `currency` / `customer_id`（销售）/ `supplier_id`（采购）/ `include_draft`。

### 9.4 验证

- `npm run typecheck`（api + web）：通过。
- `npm run test:unit:api` → **959 / 959 通过**（新增 51 条）。
- `npm run test:unit --workspace=@dilee/web` → **组件 543 条 + lib 全部通过**。
- `npm run build --workspace=@dilee/web`：通过，`/finance/reports` 按需渲染。
- **未执行**：真实 PostgreSQL / HTTP 契约 / 集成 / Playwright（本机无可用 PostgreSQL）、
  用真实 Excel 打开导出文件核对（单测已用 `xlsx` 读回并逐格断言单元格类型与取值）。

---

## 10. 二期实施记录（2026-09-14，已实施）

范围：销售对账汇总表（10 列）、销售利润报表(毛利)（10 列）。**仍然零迁移。**

### 10.1 新增与改动

| 文件 | 职责 |
| --- | --- |
| `apps/api/src/modules/finance/finance-report-cost.service.ts` | **新增**：BOM 原料成本（批量取价，避免逐单 N+1） |
| `apps/api/test/unit/finance-report-cost-service.test.cjs` | **新增**：14 条（含取价的 NULL 排序陷阱） |
| `apps/api/test/unit/finance-report-summary-profit.test.cjs` | **新增**：16 条（两张表的版式 + 口径 + 表尾说明） |
| `finance-report.domain.ts` / `finance-report.tables.ts` / `finance-report-query.service.ts` / `finance-report.controller.ts` | 追加两张表的列定义、取数与端点 |
| `apps/web/lib/finance-sections.ts` | `FINANCE_REPORT_TABS` 2 → 4 个，新增 `scope`（客户/供应商筛选是数据驱动，不再写 if 分支） |
| `apps/web/components/finance/finance-report-workspace.tsx` | 渲染表尾说明（缺采购价物料必须在页面上也看得到） |

### 10.2 二期口径

- **销售对账汇总表**（R4）：以**应收来源**为基准按销售单分组（不是以销售单左连接），
  这样「出现在表里的」恰好是「有纳入对账的应收来源的」销售单，销售金额天然等于明细表里
  同一销售单的金额合计 —— 两张表的总额一定对得上。
  - 单号 = 销售单号；欠款 = 应收合计 + 调整净额 − 已收合计；
  - 调整只用**已过账**的（草稿未生效、冲销后的不算），净额式子直接复用
    `receivable-adjustment.domain.ts` 的 `adjustmentNet`，不在这里重写一遍；
  - 已收只算「有效核销（`status = active`）且付款已过账」；
  - 税额、开票金额留空（系统没有这两个字段，§8 第 1 条）。
- **销售利润报表(毛利)**（R5）：以**销售单**为基准（默认 `confirmed` / `closed`，
  `include_draft=true` 才带草稿），成本 = BOM 原料成本：
  - 单件用量 = `核定用量 ÷ 生产批量基数`（回落顺序 approved → base → required；基数空/0 按 1）；
  - 取价 = 该物料**最近一次有效采购明细单价（含税）**，只排除已取消的采购单
    （草稿采购单的报价也算报价：新物料常常只有草稿单上有价）；
  - 成本 = Σ(单件用量 × 销售单数量 × 单价)；
  - **缺采购价 / 没有 BOM 时成本按 0 计入，但在表尾显式列出**，页面也渲染这段说明 ——
    只写进导出文件的话，看页面的人会以为毛利就是这么多；
  - 本币三列：销售额取销售单上权威的 `local_currency_amount`（按比例分摊），
    成本按汇率折算；**外币缺本币金额时三列 (本) 留空**，不拿原币冒充本币。
- 只算**材料成本**，不含人工/外加工/制造费用 —— 因此「销售利润」是**毛利的上界**，
  表头沿用老表列名「销售利润」，口径在表尾与文档里写明。

### 10.3 「最近采购价」的一个真实陷阱

`purchase_order_items.purchase_date` 可空，而 PostgreSQL 的 `ORDER BY … DESC` 默认 **NULLS FIRST**：
直接 `order by purchase_date desc` 会让**没有采购日期的单据把真正的近期价格顶掉**。
因此取价在内存里按 `采购日期 ?? 采购单创建时间` 比较最大值（有单测钉住两种情形）。

### 10.4 验证

- `npm run typecheck`（api + web）：通过。
- `npm run test:unit:api` → **1003 / 1003 通过**（新增 44 条）。
- `npm run test:unit --workspace=@dilee/web` → **组件 548 条 + lib 全部通过**。
- `npm run build --workspace=@dilee/web`：通过。
- **列名与列序比对原 `.xls` 文件**：销售对账明细 23 列、销售对账汇总 10 列、
  采购对账明细 16 列、销售利润(毛利) 10 列，四张表**逐列一致**。
- **未执行**：真实 PostgreSQL / HTTP 契约 / 集成 / Playwright；真实 Excel 打开核对。

---

## 11. 三期实施记录（2026-09-14，已实施）

范围：「收支管理」板块（手工流水 + 可配置项目字典）+ 收支明细表（6 列）+ 收支汇总表。
**这是三期里唯一需要改库的一期**：1 个加法迁移。

### 11.1 迁移 `20260914190000_cash_flow_entries`

- `dictionary_types`：`cash_flow_item`（收支项目，37 项）、`settlement_account`（结算账户，2 项）；
  清单单独成模块 `cash-flow-catalog.ts`，**迁移、`seed.ts` 与守卫测试共用一份**。
- `cash_flow_entries` 表：22 列 + 3 个库层 CHECK
  （`direction IN ('income','expense')`、`amount > 0`、`status IN ('posted','reversed')`）。
- 字典写入幂等（`ON CONFLICT DO NOTHING`），无用户（空库）时直接返回，由 `seed.ts` 接管。
- **列/索引/外键用 `prisma migrate diff --from-empty --to-schema-datamodel` 逐条比对过**：
  22 个列定义一致、7 条索引与外键一致。比对中发现并修正了一处真实漂移：
  `settlement_account_id` 是**可空**关联，Prisma 期望 `ON DELETE SET NULL`，
  而手写 SQL 时很容易照抄上一行的 `RESTRICT` —— 写错会让 `migrate status` 认为库与 schema 漂移。

### 11.2 收支管理板块

- 端点：`GET/POST /finance/cash-flow-entries`、`GET/PATCH /:id`、`POST /:id/reverse`。
- 收支项目 / 结算账户**复用既有字典接口**（`/dictionaries/<key>/items`、`PATCH /dictionaries/items/:id`），
  不另造一套平行接口；字典写操作仅管理员。
- 前端 `/finance/cash-flow`：满页流水表 + 新增/更正/冲销 + 「收支项目维护」面板（新增 / 停用 / 启用）。
- 三条业务约束：金额**恒为正**、收/支由 `direction` 决定（库层 CHECK 兜底）；
  更正只对生效中的流水开放；冲销必须填原因并**保留整行**（报表默认不计入，`include_reversed=true` 可查）。

### 11.3 收支两张表

- **收支明细表**（6 列）：收入 / 支出两列，没有的那一边写 `0`（照抄老表样本 `收入 0 / 支出 2900`）。
  **不设合计行** —— 本表一行一个币种，跨币种相加没有意义（R7）。
- **收支汇总表**：`项目 | 币种 | 收入 | 支出`，比老表**多一列「币种」**（R7 确认的分行维度）。
  - 一个币种一段，**段末给该币种的合计**；绝不跨币种相加。
    老表样本把美元 5428 与人民币 2900 加在同一列，现在分解为「人民币段 0/2900、美元段 5428/0」。
  - 37 个项目**全部列出**（本期没发生的写 0），保留老表「项目清单 + 收支」的形态。
  - 项目清单 = 启用项目 ∪ **本期出现过的停用项目**（标「（已停用）」）：
    只用启用项目会让停用项目的旧流水在汇总表里凭空消失 —— 明细有、汇总没有就是对不上账。

### 11.4 一个前端契约坑（记录在案）

`ActionDialog` 的契约是「`onSubmit` 正常返回 → 关闭弹窗；**抛异常 → 弹窗内显示错误并保持打开**」。
最初我在 submit 里自己 `catch` + `notifyError`，并且用 `void dialog.submit(values)` 丢掉返回的 Promise，
结果是**失败时弹窗照关、原因无处可看**，还留下一个未处理的 Promise 拒绝（被 vitest 报成 Unhandled Rejection）。
现在：submit 不吞异常，且把 Promise 交回给 `ActionDialog`；测试断言错误显示在弹窗内且弹窗仍在。

### 11.5 验证

- `npm run typecheck`（api + web）：通过。
- `npm run test:unit:api` → **1044 / 1044 通过**（三期新增 41 条：流水服务 16、迁移守卫 7、两张表 10、取数 5、接口 3）。
- `npm run test:unit --workspace=@dilee/web` → **组件 564 条 + lib 全部通过**（新增收支管理页 12 条、报表页 23 条）。
- `npm run build --workspace=@dilee/web`：通过，`/finance/cash-flow` 生成。
- **列名与列序比对原 `.xls`**：6 张表里 5 张逐列一致；收支汇总表是有意的 4 列（多「币种」，R7）。
- **未执行**：迁移未在真实 PostgreSQL 上跑过（本机无可用库）——
  因此迁移的真实执行、`migrate status` 无漂移、以及四个新端点的鉴权矩阵与真实 SQL 都未端到端验证；
  也未用真实 Excel 打开导出文件核对。

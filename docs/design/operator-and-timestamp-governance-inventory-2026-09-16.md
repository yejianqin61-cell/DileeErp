# 操作人与操作时间 · 全站盘点（2026-09-16）

> 用户要求：**每个操作行为都要有操作人的姓名作为一个 column；每次操作都要记录最后改动时间。**
> 本文只做**盘点**，不做改造。目的：说清「现在的底座是什么样、哪些表单能直接展示、哪些还缺东西、上柱之前必须拍板什么」。

---

## 一、结论先行（五条）

1. **写侧是齐的。** 87 张表里 `createdBy` 84 张、`updatedBy` 83 张、`deletedAt` 71 张且 `deletedBy` **71 张完全配对**（没有一张表「有删除时间却没记删除人」）。写入靠 `AuditService.create/update/softDelete` 统一约定，服务层有 **230 处** `audit.record(...)` 审计事件。**不需要补「记录」这件事，它一直在记。**

2. **表结构真缺口只有 1 张：`DailyReportMergeAnomaly`。** 它会被更新（`production-daily-alerts.service.ts:47` 把 `status` 改成 `resolved`、写 `resolvedAt`），但模型上没有 `updatedBy`/`updatedAt`（`schema.prisma:2220-2234`）——「谁在什么时候解决的」只存在于 `audit_events` 里，行上没有。

3. **接口层两头不讨好。** 服务层 696 个 Prisma 读查询里，**469 个不带 `select`**（把 `created_by/updated_by` 的 **UUID** 原样返回给前端，涉及 70 个 model），**227 个带 `select`**（把审计字段整个裁掉）。**而且全站没有任何一个「按 id 换姓名」的接口** —— 前端唯一能拿到的用户信息是 `/auth/me`（只有自己）。

4. **显示层几乎是零。** 133 个前端源文件里，「操作人 / 操作时间 / 创建人 / 最后修改 / 修改人」这些字样**出现 0 次**。72 处 `<DataTable>`、61 个列定义里，只有 4 处的「更新时间/最后更新」是从 `updated_at` 来的。

5. **全站只有 3 处显示「操作人」，2 处显示的是 UUID。**
   - ✅ 正确：采购单 Excel 导出（`purchase-order-export.service.ts:223-226` 把 `createdBy/updatedBy` 换成 `user.displayName`）——**全站唯一一处**。
   - ❌ 凭证纸弹窗（`voucher-workspace.tsx:386`「制单：{voucher.createdBy}」）与凭证 PNG 导出（`lib/voucher-image.ts:163`）：渲染的是 **UUID**。链路是前端只声明 `createdBy?: string`（`:46`）→ 后端 `voucher.service.ts:77` 用 `{ ...row }` 整体透传、没有 join user → `schema.prisma:1775` 是 `@db.Uuid`。
   - ⚠️ 生产工序导出的「操作人」是 `user.username`（`production-payroll-export.service.ts:34` 等 6 处）——它是**当前点导出的人**，不是这条记录的操作人。

---

## 二、盘点口径

分四条线，每条线的「全量 vs 抽样」说清楚，避免把推断当事实：

| 线 | 覆盖 | 方法 |
| --- | --- | --- |
| 数据层 | **全量** 87 个 model | 解析 `schema.prisma` 逐个 model 检查 5 个审计字段 |
| 接口层 | **全量** 服务层读查询做统计；**抽样** 逐端点核对响应体 | 括号配对法扫描 `apps/api/src/modules/**/*.ts` 的 696 个 `find*` 调用，判断该次调用是否带 `select:` |
| 界面层 | **全量** 133 个前端源文件（`apps/web/app` + `components`，排除 test/node_modules） | 逐文件读列定义、详情字段数组、弹窗 fields 数组；关键结论二次复核 |
| 导出层 | **全量** 3 个导出 service + 5 个后端报表/名单表头 | 读表头定义与取值来源 |

行号均来自上述通读；**凡是涉及的「钱、权限、时区」结论，我都亲自复核过并给出链路**。本轮没做到的见第八节。

「表单」在本文按四个层次拆：**列表列 / 详情字段 / 弹窗字段 / 导出表头**。用户说的 "column" 主要指第一层，但同一份数据常常只在导出里露出来，所以四层都盘。

---

## 三、数据层：底座是什么样

### 3.1 审计字段矩阵（附录 A 给出生成方式）

87 个 model 里，只有 4 张不满足「四个审计字段齐全」：

| model | 缺什么 | 判定 |
| --- | --- | --- |
| `AuditEvent`（`schema.prisma:220`） | 只有 `createdAt` | **合理**：审计事件是追加型账本，全仓 `auditEvent.update/delete` **0 处**，永远不会改 |
| `InventoryFact`（`:788`） | 无 `updatedBy`/`updatedAt`/`deletedAt` | **合理**：库存事实是追加型账本，全仓 `inventoryFact.update/delete` **0 处**；更正靠反向事实（冲销写负数），不靠改行 |
| `UserRole`（`:59`） | 四个都没有 | **可接受**：纯关联表，角色变更走 `auth.service.ts:90-92` 整体重建，但父行 `user.updatedBy` 落了 actor（`:92`）、且写了 `user.roles_changed` 审计事件（`:95`） |
| `DailyReportMergeAnomaly`（`:2220`） | 无 `updatedBy`/`updatedAt` | ⚠️ **真缺口**：这张表**会**被 update（`:47`），行上却没有「谁改的/什么时候改的」 |

另有一批表只缺 `deletedAt`（`Session`/`RolePermission`/`StateRecord`/`StateChange`/`StateTransition`/`AttachmentLink`/`FormField`/`PayableSource`/`AlertHandling`/`VoucherLine`/`StocktakeLine`）——这些是纯追加或随父级级联的表，不需要逻辑删除，**不算缺口**。

### 3.2 一个必须先说清的时区隐患

全部时间列的物理类型是 **`TIMESTAMP(3)`（无时区）**，不是 `timestamptz`。这是全库一致的约定，而且是有意为之——`20260915120000_bank_pool_and_other_payable/migration.sql:4-6` 的注释写明：有人用 `TIMESTAMPTZ` 建过表，会被 `prisma migrate diff` 报漂移，而且**「全库其余 68 个迁移用的都是 TIMESTAMP(3)，单独一张表用 timestamptz 会造成时区语义不一致」**。

在这个前提下，同一行的两个时间**来源不同**：

- `created_at`：迁移里是 `DEFAULT CURRENT_TIMESTAMP`（`20260819123000_platform_foundation/migration.sql:11`）→ **由数据库在写入时按会话时区换算后落盘**。
- `updated_at`：`NOT NULL` 且**没有默认值**（同文件 `:12`），由 Prisma 客户端在 `@updatedAt` 时写入 → **按 UTC 落盘**。

> **推断（未在真库验证）**：数据库会话时区若不是 UTC，同一行「创建时间」与「最后修改时间」会差一个时区偏移（例如库在 +08，则差 8 小时）。**这正好是用户要的两个 column**，所以上柱之前必须在真库上验一次。这一条我标为推断——本机没有 PostgreSQL，跑不了。

### 3.3 已有的操作历史能力（比想象中多）

- `AuditEvent`：`action / entityType / entityId / actorId / orderNo / details(JSON) / createdAt`，索引 `@@index([actorId, createdAt])` —— **按操作人查是设计好的**。
- 已有 6 个只读端点：4 个 `:id/audit-events`（`/production/orders/:id`、`/production/material-movements/:id`、`/production/outsource-logistics-batches/:id`、`/production/daily-alerts/:id`），加 2 条时间线（`/order-workbench/orders/:order_no/timeline`、`/production-progress/order-statuses/:orderNo/timeline`）。
- ⚠️ 但这 6 个端点**前端一处都没有调用**（`apps/web` 全仓 grep `audit-events|timeline` 零命中）。它们返回的是原始 `AuditEvent` 行，`actorId` 是 **UUID**，没有换成姓名。
- 与设计文档的差距：`docs/design/production-module-design.md:309-321` 要求审计至少记录「操作结果（成功/失败）」，`AuditEvent` 没有这个列；`docs/product/module-capability-catalog.md:40` 写「审计日志查询和实体操作时间线：**已接入**」——**按界面事实这是超额声明**（接口有、界面没有、姓名也没换）。

---

## 四、接口层：读出来的东西

### 4.1 三类形态

| 形态 | 表现 | 后果 | 例子 |
| --- | --- | --- | --- |
| **A** | 不带 `select`，整行透传 | `createdBy/updatedBy` 是 **UUID**，`createdAt/updatedAt` 可用 | `suppliers`（`procurement-master-data.service.ts:47`）、`materials`（`:41`）、`units`（`:18`）、`customers`（`customers.service.ts:20`）、`sales-orders`（`sales-orders.service.ts:17`）、`vouchers`（`voucher.service.ts:56` `{ ...row }`） |
| **B** | 带 `select`，只挑了业务列 | 时间、操作人**都没了**（前端连「有时间可用」都不成立） | `reports`（`reports.service.ts:11-14` 只挑 `updatedAt`/`createdAt`，没有操作人）、`alerts`（`alerts.service.ts:13-14` 只挑 `createdAt`）、`qc`（`reports.service.ts:14` 连时间都没挑） |
| **C** | 专门写了 join，把 UUID 换成姓名 | 可直接展示 | 只有 2 处：`purchase-order-export.service.ts:199-201`、`material-slip-export.service.ts:250`（后者是逐行 `findFirst`，**批量导出时会 N+1**） |

### 4.2 数字

- 服务层读查询 **696** 个：**469 个形态 A**、**227 个形态 B**，涉及 **70 个 model**、**49 个 service 文件**。
- 口径提醒：这 696 个是**服务层调用**，不是端点——里面有一部分是内部查表（算余额、校验 BOM），不直接下发。所以「469」应当读作**「有 469 处会顺手把 UUID 带出去」的上界**，不是「469 个接口漏了」。

### 4.3 姓名解析通道：现在没有

- 前端能拿到的只有 `/auth/me`：`{ display_name, username }`（`app-shell.tsx:32`），**只有当前用户**。
- `admin/users`（`admin-users.controller.ts`）是**只写不读列表**的管理员控制器：create / setActive / resetPassword / setRoles，**没有 GET 列表**，且带 `@RequireAdministrator()`。
- 所以：**任何界面想显示操作人姓名，都必须由服务端在响应里带上姓名**，或者新增一个「批量 id → 姓名」的读取通道。这一条是全站改造的**共同前置**。

---

## 五、界面层：全站表单盘点

### 5.1 规模

| 指标 | 数量 |
| --- | --- |
| 前端源文件（app + components，排除 test） | 133 |
| 页面路由 `page.tsx` | 43 |
| `<DataTable>` 使用点 | 72 |
| 列定义（`ColumnDef<`） | 61 |
| 出现「操作人 / 操作时间 / 创建人 / 最后修改 / 修改人」字样的源码行 | **0** |

### 5.2 已经在显示「时间」的 27 处

按口径分三类。**「系统时刻」才是用户要的「操作时间」，「业务日期」是用户自己填的日期、不是操作时间。**

| # | 界面单元 | 显示成什么 | 来源字段 | 口径 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 1 | 采购单 Excel 导出（单张 + 批量） | 下单录入时间 / 操作时间 | `createdAt` / `updatedAt` | 系统·创建 + 系统·最后修改 | `purchase-order-export.service.ts:276-277` |
| 2 | 领料单/补料单 Excel 导出 | 操作人 / 操作时间 | `createdBy`·姓名 / `createdAt` | 系统·创建 | `material-slip-export.service.ts:307,411` |
| 3 | 生产工序导出（6 张表） | 操作人 / 生成时间 | **当前导出人** / `new Date()` | ⚠️ 非记录的操作人 | `production-payroll-export.service.ts:34,59,86,107,126,237` |
| 4 | 员工名单导出 | 创建时间 / 更新时间 | `createdAt` / `updatedAt` | 系统·创建 + 系统·最后修改 | `employee-roster.ts:218-219` |
| 5 | 应收台账 Excel 导出 | 出库日期 | `createdAt` | 系统·创建（借用成业务日期） | `ledger-workbook.ts:179-180` |
| 6 | 工作台·订单全链路 | 更新时间 | `updated_at` | 系统·最后修改 | `workbench.tsx:52` |
| 7 | BOM 工作区状态行 | 最后更新 | `updatedAt` | 系统·最后修改 | `bom-workbench.tsx:167` |
| 8 | 报表页·订单报表 | 更新时间（动态列） | `updated_at` | 系统·最后修改 | `reports/page.tsx:45` + `reports.service.ts:11` |
| 9 | 报表页·采购报表 | 更新时间（动态列） | `updated_at` | 系统·最后修改 | 同上 `:12` |
| 10 | 报表页·库存报表 | 创建时间（动态列） | `created_at` | 系统·创建 | 同上 `:13` |
| 11 | 领料单/补料单列表 | 登记时间 | `createdAt` | 系统·创建 | `material-issues/page.tsx:192` |
| 12 | 领料单详情弹窗 | 提交时间 | `submittedAt` | 系统·动作 | `material-issues/page.tsx:213` |
| 13 | 生产单详情·领料单列表 | 业务日期 | `businessDate ?? createdAt` | 兜底，界面看不出是哪个 | `material-issues-panel.tsx:186` |
| 14 | 仓库页·待入库通知 | 通知时间 | `notifiedAt` | 系统·动作 | `warehouse/page.tsx:117` |
| 15 | 仓库页·待出库通知 | 提交时间 | `submittedAt` | 系统·动作 | `warehouse/page.tsx:135` |
| 16 | 成品仓储页·待入库通知 | 通知日期 | `noticeDate` | 业务日期（录入） | `finished-goods-storage/page.tsx:154` |
| 17 | 成品质检·质检记录 | 检验日期 | `inspection_date` | 业务日期（录入） | `finished-goods-qc-panel.tsx:186` |
| 18 | 盘点单列表 | 导入时间 / 确认时间 | `imported_at` / `confirmed_at` | 系统·动作 | `stocktakes/page.tsx:336-337` |
| 19 | 盘点明细区头部 | 导入时间 / 确认时间 | 同上 | 系统·动作 | `stocktakes/page.tsx:455` |
| 20 | 应收·待创建对账列表 | 待对账月份 / 出库日期 | `createdAt` | 系统·创建 | `receivable-workspace.tsx:554,560` |
| 21 | 应付·待创建对账列表 | 待对账月份 / 确认日期 | `confirmationDate ?? createdAt` | 业务日期（录入） | `payable-workspace.tsx:702,709` |
| 22 | 应收来源详情弹窗 | 创建时间 | `createdAt` | 系统·创建 | `receivable-workspace.tsx:583` |
| 23 | 应收对账详情弹窗 | 创建时间 | `createdAt` | 系统·创建 | `receivable-workspace.tsx:605` |
| 24 | 应付来源详情弹窗 | 创建时间 | `createdAt` | 系统·创建 | `payable-workspace.tsx:728` |
| 25 | 应付条目详情弹窗 | 创建时间 / 确认日期 | `createdAt` / `confirmationDate` | 创建 + 业务日期 | `payable-workspace.tsx:767` |
| 26 | 应付对账详情弹窗 | 创建时间 | `createdAt` | 系统·创建 | `payable-workspace.tsx:789` |
| 27 | 工资付款 Excel 导出 | 末次付款日期 | 后端 | 业务日期 | `payroll-payment-sheet.ts:38` |

**统计口径**：系统时刻 23 处、业务日期 4 处（#16/#17/#21/#27）。
**但没有一处的列名是「操作时间」**，且**没有任何一处同时给出「谁改的」**。

### 5.3 已经在显示「操作人」的 3 处

| 界面单元 | 显示 | 实际是什么 | 证据 |
| --- | --- | --- | --- |
| 采购单 Excel 导出 | 采购人 / 操作人 = 姓名 | ✅ `createdBy`/`updatedBy` → `displayName` | `purchase-order-export.service.ts:199-201,223-226` |
| 凭证纸弹窗 + `window.print()` | 制单：`{voucher.createdBy}` | ❌ **UUID**；同行「审核/记账/单位负责人」是空标签 | `voucher-workspace.tsx:386`（打印 `:356`） |
| 凭证 PNG 导出 | 制单：UUID | ❌ 同上，同一个值进图片 | `lib/voucher-image.ts:163` |

另有 3 处显示的是**业务当事人**，不是操作人，容易混淆：领料/日报的「员工」（`daily-reports-panel.tsx:299,303`）、外加工签收的「签收人」（`outsourcing` panel `receiver_name`）、生产单的「执行地点」。**这三类在改造时不能顺手当成操作人。**

### 5.4 「无」的清单（按模块）

以下是**每个模块里没有任何操作人/操作时间呈现**的界面单元。为可读性，这里按页面归并（明细到单元的完整版见各模块盘点记录）。

**采购 / 销售 / 客户**
- `procurement/boms`（BOM 表列表）、`procurement/materials`（物料列表 + 编辑/删除弹窗）、`procurement/suppliers`（供应商列表 + 新建/编辑/删除弹窗）、`procurement/inbounds`（入库列表 + 编辑/冲销弹窗）、`procurement/orders`（采购单列表、草稿明细表、打印信息弹窗、回退弹窗）、`orders/[id]`（详情单头、批次表）、`sales`（成品出库总览、客户池、销售单列表、销售单详情抽屉、客户详情抽屉、7 个弹窗）、`components/bom/*`（BOM 明细表、新建物料/单位弹窗）

**生产 / 质检 / 仓库**
- `production`（生产单列表、BOM 表、新建弹窗）、`production/orders/[id]`（概览、工序与进度、3 个弹窗）、`production/locations|operations|units`（三个池子列表 + 各自的建/编弹窗）、`production/material-issues`（列表已有登记时间，但**详情内「领用物料」子表、3 个动作弹窗无**）、`material-slip-editor`（全屏编辑页）、`components/production/*`（外加工批次/回厂/直装柜列表与 6 个弹窗、员工日报全部表格与弹窗、导出面板、列序编辑器）、`qc/incoming`（来料质检列表 + 7 个弹窗）、`qc/finished-goods`（来源/送检/质检三张表 + 7 个弹窗）、`qc/inbound`（待入库、次品两张表 + 5 个弹窗）、`warehouse/page`（缺入库草稿列表）、`warehouse/finished-goods-storage`（存量、次品、待入库、入库单、出库通知、出库单 6 张表 + 6 个弹窗）、`warehouse/raw-material-storage`（库存汇总、入库单列表 + 3 个弹窗）、`warehouse/stocktakes`（明细列表、改实盘数弹窗、导入错误表）

**财务 / 人事**
- `bank-workspace`（账户池 + 3 弹窗）、`bank-transfer-workspace`（余额表、互转记录表 + 2 弹窗）、`cash-flow-workspace`（流水表 + 3 弹窗）、`accounting-subject-workspace`（科目表 + 2 弹窗）、`voucher-workspace`（收支流水表、凭证表 + 编辑/红冲等弹窗；凭证纸只差姓名）、`receivable-workspace`（4 张列表 + 对账/明细子表）、`payable-workspace`（6 张列表 + 明细子表 + 导入错误表）、`salary-workspace`（工资台账/付款两张满页表、详情弹窗与 3 张子表、6 个弹窗）、`finance-report-workspace`（动态报表 + XLSX）、`components/hr/organization-pool`（部门池、岗位池 + 2 弹窗）、`app/hr`（员工目录、考勤绩效表、5 类弹窗、导入错误表）

### 5.5 定义了却从未渲染的（顺手发现的死代码）

| 位置 | 情况 | 性质 |
| --- | --- | --- |
| `app/hr/page.tsx:922-993` | `ledgerColumns`（工资台账）、`paymentColumns`（工资付款）**定义了但全文件没有 DataTable 用它们**（只有 `:1226` employeeColumns、`:1238` recordColumns） | 工资台账/付款已搬到 `/finance/salary`，这里是遗留 |
| `stocktakes/page.tsx:42` | `Stocktake.reversed_at` 声明了、只渲染了 `reversal_reason` 文字 | 冲销时间有数据不显示 |
| `unit-pool-page.tsx:26` | `Unit.createdAt/updatedAt` 声明了、列定义只用 name/remark/isActive | 有数据不显示 |
| `finished-goods-storage/page.tsx:20,23` | `Inbound.createdAt`、`OutboundNotice.notifiedAt` 声明了未渲染 | 有数据不显示 |
| `bank-transfer-workspace.tsx:41` | `BankTransfer.createdAt` 声明了未渲染 | 有数据不显示 |
| `sales/page.tsx:23` | `OutboundNotice.notified_at` 声明了未渲染 | 有数据不显示 |
| `voucher-workspace.tsx:43-50` | 前端 `Voucher` 类型**连 `createdAt/updatedAt` 都没声明**，但后端 `{ ...row }` 运行时是有的 | 类型缺口 |

> 这一类是**成本最低的改造点**：数据已经在响应里，只差一列。和上一轮「采购单导出按钮定义了没人调」是同一类问题。

---

## 六、可展示性分档（这是「可以展示」的答案）

### 甲档：数据已经在响应里，只差前端一列

**判断依据**：该列表的服务端查询属于形态 A（不带 `select`）。已核实的代表：供应商、物料、单位、客户、销售单、采购单、凭证、银行账户。
**注意**：`createdBy/updatedBy` 拿到的是 **UUID**，直接渲染就是第二个「制单：3f2a…」——所以甲档**必须先解决姓名**，否则只能先上「操作时间」这一列。

### 乙档：接口用 `select` 裁掉了，要先补字段

代表：`reports`（`:11-14`）、`alerts`（`alerts.service.ts:13-14`）、质检类报表。
这一档**必须改接口**，前端改不了。

### 丙档：表里根本没有

- `DailyReportMergeAnomaly` 的 `updatedBy/updatedAt` → **要加列 + 迁移**。
- `InventoryFact`、`AuditEvent`、`UserRole` → **建议不加**（追加型账本/关联表语义），改用「审计事件时间线」呈现，而不是在行上加最后修改人。

### 共同前置（甲乙丙都绕不开）

1. **姓名解析通道**：服务端 join（像 `purchase-order-export.service.ts:199-201` 那样，但要做成公共工具，且必须批量取、不能逐行查）。全站现在**没有**这个能力。
2. **时区口径**（见 3.2）：`created_at` 与 `updated_at` 来源不同，先定死「展示按哪个时区」。
3. **公共列工厂**：现在 72 处 `<DataTable>` 各自写列数组，逐页加两列会有 50+ 个改动点且容易漏。更省的做法是在 `components/data/data-table.tsx` 或一个 `auditColumns<T>()` 工厂里统一提供——**这一条是方案选择，需要用户拍板**。

---

## 七、上柱之前必须拍板的 4 个口径

1. **「操作人」到底指谁？** 现状是三种含义并存，不统一就会同名不同义：
   - 记录的创建人（`createdBy`）——采购单导出叫「采购人」
   - 记录的最后修改人（`updatedBy`）——采购单导出叫「操作人」
   - 本次动作的执行人（如生产工序导出的「操作人」是**点导出的人**）
   建议：**「创建人 + 最后修改人」两列**，「谁导出的」另外单列或放页脚（它是动作日志，不是记录属性）。
2. **一列还是两列？** 用户原话是「操作人的姓名作为一个 column + 每次操作都要记录最后改动时间」。若只给一列，就必须回答「同一行被两个人改过，剩谁」。
3. **时间口径与时区**：`创建时间` / `最后修改时间` 是否都要？展示到「分」还是「秒」？按服务器时区、浏览器时区还是固定北京时间？（导出目前是服务端 `toLocaleString("zh-CN")`，等于**服务器时区**，与界面可能不一致。）
4. **覆盖范围**：只覆盖列表列，还是详情/弹窗/导出一起？历史数据没有姓名快照要不要回填（现在只有 UUID，用户改名后历史显示会变成新名字——如果要「当时叫什么」就得存快照，这是另一个量级的改动）。

---

## 八、本轮没做到的（别当成已验）

- **没有真库**：本机没有 PostgreSQL，所以 ① 迁移从来没在真库跑过；② 3.2 的时区推断没验证；③ 接口实际响应体没有抓包核对——**形态 A/B/C 是按代码静态判定的**，逐端点响应需要真环境抽检一遍。
- **导出的 xlsx 没有用真实 Excel/WPS 打开看过**（表头观感、列宽、分页）。
- **没有核对每个端点的权限**：哪些角色能看到这些新列，本轮没盘（`test/http/*` 契约测试与权限矩阵本轮未运行）。
- **`test/http/*` 契约测试需要 `API_BASE_URL` + 数据库**，本轮没有执行。
- 5.4 的「无」清单来自逐文件通读，我没有对其中每一行做二次复核；标了行号的 5.2/5.3/5.5 是我亲验或复核过的。

---

## 九、下一步（两个可选动作）

- **A（推荐先做，半天量级）**：只做「甲档 + 姓名通道」的最小闭环——在 API 加一个批量的 `id → displayName` 解析工具，在**用户最常看的 5~8 张列表**（采购单、销售单、物料、供应商、客户、领料单、应付/应收台账）加「操作时间 + 操作人姓名」两列，并顺手修掉 5.5 的死代码与凭证纸的 UUID。**不改表、不加迁移**，风险最低，能立刻看到效果。
- **B（彻底）**：全站统一治理——先补 `DailyReportMergeAnomaly` 迁移，再把时区口径定死，然后在 `DataTable` 层做统一的审计列工厂，逐模块铺开（含导出表头与 `:id/audit-events` 时间线界面）。工作量大且要动公共组件，建议在 A 验完口径之后再做。

---

## 附录 A：数据层审计字段矩阵的生成方式

`schema.prisma` 逐个 `model` 检查 `createdBy / updatedBy / createdAt / updatedAt / deletedAt` 五个字段，得：

- 87 个 model；`createdBy` 84、`updatedBy` 83、`createdAt` 86、`updatedAt` 83、`deletedAt` 71；
- `deletedAt` 与 `deletedBy` 各 71 个 —— **完全配对**；
- 4 个例外见 3.1。

## 附录 B：关键证据索引

| 事实 | 证据 |
| --- | --- |
| 写入侧统一约定 | `apps/api/src/platform/audit/audit.service.ts:10-12` |
| 审计事件表结构与「按操作人查」索引 | `apps/api/prisma/schema.prisma:220-233` |
| 全站唯一的 UUID→姓名解析 | `apps/api/src/modules/procurement/purchase-order-export.service.ts:199-201` |
| 凭证纸渲染 UUID | `apps/web/components/finance/voucher-workspace.tsx:386` + `apps/api/src/modules/finance/voucher.service.ts:77` |
| 生产工序导出把「导出人」当操作人 | `apps/api/src/modules/production/production-payroll-export.service.ts:34` |
| 前端拿不到他人姓名 | `apps/web/components/layout/app-shell.tsx:32` + `apps/api/src/platform/authorization/admin-users.controller.ts`（无 GET） |
| 报表页动态列会把 `updated_at` 显示成「更新时间」 | `apps/web/app/reports/page.tsx:45` + `apps/web/lib/display-text.ts:3` |
| 时间戳无时区 + created/updated 来源不同 | `apps/api/prisma/migrations/20260915120000_bank_pool_and_other_payable/migration.sql:4-6`、`20260819123000_platform_foundation/migration.sql:11-12` |
| 审计时间线接口存在但界面未用 | 5 个 `:id/audit-events` 端点；`apps/web` grep `audit-events|timeline` 零命中 |

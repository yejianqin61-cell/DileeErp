# T09 单据清单与时间线接口

> 设计依据：[reorder-item-no-and-summary-2026-09-26.md](../../design/reorder-item-no-and-summary-2026-09-26.md) §三.2、§一.1
> 批次：[README.md](./README.md)

## 状态

待认领

## 认领

负责人：
开始日期：

## 依赖

[T08](./08-reorder-article-detail-api.md)。后续 [T11](./11-reorder-page.md) 依赖它。

## 目标

老板的原话落点：**「查看当时该批货号的采购，生产，QC 的所有表单，信息」**——
给一个货号 + 一个批（订单号），按模块分组把这批的**每一张单**列出来，带单号、日期、数量、状态、来源 id。

## 关联决策

- 单据清单**在页面内直接列出**，跳转只是加速：因为采购页/财务页目前不读 `order_no`
  （见 [T13](./13-order-deeplink-procurement.md)），靠跳转等于半个功能。
- `document_type` 是**稳定枚举**，API **不拼 URL**（跳转映射是展示层职责，放前端一处）。

## 范围与非范围

**范围**

- `GET /reorder/articles/:item_no/documents?order_no=`
- `GET /reorder/articles/:item_no/timeline?order_no=`
- `apps/api/test/unit/reorder-documents.test.cjs`

**非范围**

- 不做批量（一次只能看一批，见守卫）。
- 不返回附件二进制、不返回身份证/银行卡等敏感字段。
- 不改任何单据模块的既有接口。

## 交付物

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/modules/reorder/reorder.controller.ts` | 两条 `@Get` |
| `apps/api/src/modules/reorder/reorder.service.ts` | `orderDocuments(itemNo, orderNo)`、`articleTimeline(itemNo, orderNo?)` |
| `apps/api/src/modules/reorder/reorder.domain.ts` | `DOCUMENT_GROUPS` 常量（类型→中文名）与映射函数 |
| `apps/api/test/unit/reorder-documents.test.cjs` | 新建（约 14 条） |
| `apps/api/test/http/authorization-matrix-contract.test.cjs` | 端点登记 |

## 实施要点

**1. 两条守卫（先写，不然后面全白做）**

| 条件 | 状态码 | 错误码 |
| --- | --- | --- |
| 没给 `order_no` | 400 | `ORDER_NO_REQUIRED`（不给就一次吐出该货号全部批次的单据，响应会大到没人看得懂） |
| `order_no` 不属于该货号 | 404 | `ORDER_NOT_IN_ARTICLE` |

第二条尤其重要：`/reorder/articles/27621/documents?order_no=别的货号的单` 必须被拒，
否则这就是一条**绕过货号口径**取任意订单全部单据的通道。

**2. 十四个分组（`document_type` → 来源表 → 关键字段）**

字段名以 `apps/api/prisma/schema.prisma` 的**实际列名**为准；下表括号里是本次核对过的字段：

| `document_type` | 中文 | 来源 | 单号 / 日期 / 数量 / 状态 |
| --- | --- | --- | --- |
| `bom` | BOM 表 | `Bom` | `orderNo` / — / 明细条数 / `status`（版本号放 `extra`） |
| `purchase_order` | 采购单 | `PurchaseOrder` | `purchaseOrderNo` / `purchaseDate` / — / `status`（金额+币种、供应商放 `extra`） |
| `purchase_receipt` | 采购到货 | `PurchaseReceipt` | `receiptNo` / `receivedDate` / `quantity` / `status` |
| `incoming_inspection` | 来料质检 | `IncomingInspection` | **无单号** → 用 `purchaseReceipt.receiptNo` + `source_id` / —（无业务日期，用 `createdAt`） / 四个数量放 `extra` / `qcResult` + `status` |
| `raw_material_inbound` | 原料入库 | `RawMaterialInbound` | `inboundNo` / **无业务日期** → `createdAt` / `quantity` / `status` |
| `production_order` | 生产单 | `ProductionOrder` | `productionOrderNo` / `plannedStartedOn`（空则 `createdAt`） / `plannedQuantity` / `status`（执行方式、地点放 `extra`） |
| `material_movement` | 领料/补料/退料 | `RawMaterialMovement` | `movementNo` / `businessDate` / `lines[].quantity` 合计 / `status` + `documentType` |
| `operation_daily_report` | 工序日报 | `OperationDailyReport` | **聚合**：按 `operationNameSnapshot` 分组，日期取 `min/max(reportDate)`，数量取 `completedQuantity` 合计，`extra.report_count` 条数 |
| `finished_submission` | 成品送检 | `FinishedGoodsInspectionSubmission` | `submissionNo` / `submissionDate` / `submittedQuantity` / `status`（来源类型放 `extra`） |
| `finished_qc` | 成品 QC | `FinishedGoodsQcRecord` | `qcNo` / `inspectionDate` / `inspectedQuantity` / `conclusion` + `status`（四个数量放 `extra`） |
| `finished_inbound_notice` | 成品入库通知 | `FinishedGoodsInboundNotice` | `noticeNo` / `noticeDate` / `noticeQuantity` / `status` |
| `finished_inbound` | 成品入库 | `FinishedGoodsInbound` | `inboundNo` / **无业务日期** → `createdAt` / `quantity` / `status` |
| `finished_defective` | 次品 | `FinishedGoodsDefective` | `defectiveNo` / **无业务日期** → `createdAt` / `quantity` / `status` + `disposition` |
| `finished_outbound` | 成品出库 | `FinishedGoodsOutbound` | `outboundNo` / `shipmentDate`（空则 `createdAt`） / `quantity` / `status` |
| `receivable` | 应收来源 | `ReceivableSource` | `sourceNo` / `createdAt` / `amount` / `status` |
| `payable_source` | 应付来源（待财务） | `PayableSource` | `sourceNo`（若无则 `source_id`） / `createdAt` / `amount` / `status` |
| `supplier_payable` | 应付单 | `SupplierPayableEntry` | `payableNo` / `createdAt` / `amount` / `status` |

- 共 17 组（上表 17 行）。**只列有事实的组**还是**全列出来带空数组**？
  **决策：全列**，空组给 `documents: []` —— 老板的问题包含"当时有没有做 QC"，
  空组和"没有这个模块"是两条不同的信息；前端把空组显示成「未建立」，与工作台的 `missing` 口径一致。
- 日期列不齐（原料入库/成品入库/次品/来料质检没有业务日期列）：统一回落到 `createdAt`，
  并在每个 document 上标 `date_source: "business" | "created_at"`，**前端据此显示「（登记时间）」小字**。
  不标出来的话，业务会以为原料入库日期就是那张单的真实业务日期。
- `raw_material_movement` 只有 `documentType` 区分领料/补料/退料（`issue` / `replenishment` / …）：
  在 `extra.document_type_label` 里给中文（映射表放 `reorder.domain.ts`，不要散落在查询里）。
- 查询全部走 `where: { orderNo, deletedAt: null }`（`InventoryFact` 那类没有软删列的除外——
  本任务不查库存事实表，库存看工作台）。

**3. 响应形状**

```jsonc
{
  "data": {
    "order_no": "DL260001-1",
    "item_no": "27621",
    "groups": [{
      "document_type": "purchase_order",
      "label": "采购单",
      "documents": [{
        "document_no": "PO260001", "date": "2026-05-03T00:00:00.000Z",
        "date_source": "business", "quantity": null, "unit": null,
        "status": "ordered", "status_label": "已下单",
        "source_id": "…",
        "extra": { "amount": "12345.6000", "currency": "CNY", "supplier_name": "…" }
      }]
    }]
  },
  "meta": {}
}
```

- `quantity` / `unit` 对"没有单一数量"的单据（采购单、BOM、日报聚合）给 `null`，**不要**硬凑一个数。
- `status_label` 出中文：映射表若已存在于对应模块就复用（`production-orders`、`incoming-inspections`
  等面板里都有中文映射），**不要**在前端再维护一份——这是本任务最容易产生第三份真源的地方。
- `source_id` 是 UUID，供前端拼深链；**不要在 API 里拼路径**。

**4. 时间线**

- `timeline?order_no=`（可选）：不给则把该货号**全部批次**的订单号集合起来查
  `auditEvent.findMany({ where: { orderNo: { in: orderNos } }, orderBy: { createdAt: "desc" } })`。
- `take: 200` 上限 + **必须返回 `truncated: boolean`**：老板要的是"查得到"，
  静默截断会让人以为这就是全部（工作台的 timeline 现在就是静默 `take: 200`，
  本接口不要复制那个缺陷）。
- 返回 `{ data: { events: [...], truncated: boolean }, meta: {} }`。

## 验收与验证

| # | 验收点 | 用例 |
| --- | --- | --- |
| 1 | 缺 `order_no` → 400 `ORDER_NO_REQUIRED` | `unit/reorder-documents.test.cjs` |
| 2 | `order_no` 不属于该货号 → 404 `ORDER_NOT_IN_ARTICLE` | 同上 |
| 3 | 17 个分组恒存在（无事实时 `documents: []`） | 同上 |
| 4 | 每组映射到正确来源表与单号字段（逐组断言，不抽查） | 同上 |
| 5 | 领料/补料/退料按 `documentType` 分类 | 同上 |
| 6 | 工序日报是**聚合**行（数量合计 + `report_count`），不是逐条 | 同上 |
| 7 | 无业务日期的单据 `date_source = "created_at"` | 同上 |
| 8 | 软删单据被排除 | 同上 |
| 9 | 金额/数量是字符串；没有单一数量的单据 `quantity: null` | 同上 |
| 10 | `status_label` 出中文 | 同上 |
| 11 | 不返回附件二进制与敏感字段 | 同上（断言响应 JSON 里不含 `attachment`、`data`、`idCard` 等键） |
| 12 | 时间线合并多批次；`take=200` 时 `truncated=true` | 同上 |
| 13 | 与工作台交叉一致：同一订单的采购金额、QC 合格数与 `order-workbench.service.summary()` 相等 | 同上（**这条是防止两套口径漂移的关键断言**） |
| 14 | 货号归一后取单批（大小写变体都能通过第 2 条守卫） | 同上 |

命令：`npm run typecheck` → `npm run test:unit:api`。

## 决策记录

- **空组也返回**：见实施要点 2。
- **不在 API 拼 URL**：见实施要点 3。
- **`truncated` 标记**：不复制工作台静默截断的缺陷。

## 完成记录

（认领后填写。）

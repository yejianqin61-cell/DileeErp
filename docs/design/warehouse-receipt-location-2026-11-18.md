# 原料到货入库地点与仓库档案（T-0018，2026-11-18）

## 1. 需求与边界

用户原话：公司采购回来的物料，收货仓库包含同安仓、晋江仓、大田仓；目前 ERP 系统只维护了同安仓，
晋江仓、大田仓在系统中不存在。要求：

1. 新增【晋江仓】、【大田仓】两个仓库档案；
2. 物料到货入库登记增加入库地点选择项（同安、晋江、大田）；
3. 支持录入、保存对应的到货登记数据。

本工单的硬边界：不执行 `prisma migrate`、不新增/修改 `prisma/migrations`、不向生产库写数据。
因此本次**不新建仓库主数据表**，仓库档案先作为代码内置目录，入库地点存在到货批次已有的
`purchase_receipts.extension_data` JSON 中。

## 2. 决策

### 2.1 仓库档案（内置目录）

`apps/api/src/modules/procurement/warehouse-catalog.ts` 定义三份稳定档案：

| code | name |
| --- | --- |
| `tongan` | 同安仓 |
| `jinjiang` | 晋江仓 |
| `daitan` | 大田仓 |

`GET /purchase-orders/warehouses` 返回该目录，采购到货登记页用它渲染「入库地点」下拉。

理由：

- 本仓 V1 设计（`docs/design/warehouse-module-design.md`）明确不建设实体仓库、分仓、库位；
  仓库档案属于本次新增业务分类，但新增表必须配套迁移，与工单黑名单冲突。
- 三个仓库是固定收货地点，不是会频繁增减的业务分类；编码写进历史到货单后不可改，名称只用于展示。
- 接口失败时前端回落同一份内置清单，避免后端未部署/字典未配置时到货登记不可用。

未决项：以后要由管理员增删仓库，需要新建 `warehouses` 主数据表与迁移，属于需要人工处理的后续项。

### 2.2 到货批次上的入库地点

`purchase_receipts.extension_data` 追加：

```json
{ "warehouse_code": "jinjiang", "warehouse_name": "晋江仓" }
```

- 新登记到货：前端默认选同安仓，传 `warehouse_code`；后端校验必须在目录内。
- 老客户端/历史数据不传仓库：按历史口径回落 `tongan`（系统此前实际只维护同安仓），
  不让老接口失败，也不让老单显示成「未知地点」。
- 编辑到货批次可改地点；不传 `warehouse_code` 时保持原值，避免只改数量把地点清空。
- 非法编码在写任何到货/质检/采购单状态之前返回 422 `INVALID_WAREHOUSE`。
- 入库单不重复存地点：`GET /raw-material-inbounds` 从关联到货批次派生 `warehouse_code` / `warehouse_name`。

## 3. 影响面

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/modules/procurement/warehouse-catalog.ts` | 新增仓库目录与解析函数 |
| `purchase-orders.controller.ts` | 到货 DTO 增加 `warehouse_code`；新增 `GET /purchase-orders/warehouses` |
| `purchase-orders.service.ts` | 到货创建/修改校验并保存仓库；详情透出 `warehouseCode/Name` |
| `raw-material-inbounds.service.ts` | 入库列表从到货批次透出入库地点 |
| `apps/web/lib/warehouse-catalogue.ts` | 仓库下拉选项与接口兜底 |
| `apps/web/app/procurement/orders/[id]/page.tsx` | 登记/编辑到货的入库地点下拉；批次行展示仓库 |
| `components/warehouse/raw-material-inbound-detail-dialog.tsx` | 入库单详情展示入库地点 |

## 4. 验证

- `npm run typecheck` 三个 workspace 通过。
- 定向 API 单测：`purchase-order-receipt-warehouse.test.cjs` + 到货批次相关既有测试，37 条通过。
- 定向 Web 组件测试：新增到货仓库测试 + 超收到货、入库详情相关既有测试，13 条通过。
- 未跑全量 `npm test` / `test:unit` / `integration`（工单要求，2 核机器会超时）。

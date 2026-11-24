# 跨仓库调拨（T-0028，2026-11-24）

## 1. 需求与边界

用户原话：

> 新增跨仓库调拨业务，源仓库为同安仓库，目标仓库可选大田仓库、晋江仓库；调拨目的是供目标仓库生产使用，调拨完成后自动更新两边仓库库存，保留调拨记录可追溯。

结构化入口：仓库模块 → 调拨单。

本工单硬边界（与 T-0018 相同）：

- 不执行 `prisma migrate` / `migrate deploy`；
- 不新增或修改 `apps/api/prisma/migrations` 下的文件；
- 不向生产库写入数据；
- 不删除 `/opt/dilee/db-snapshots`。

因此**不能新增 `warehouse_transfers` 表或给 `inventory_facts` 加仓库列**。本次沿用 T-0018 的思路，
用现有结构承载，不触碰迁移链。

## 2. 数据口径

### 2.1 调拨单头 = 不可变审计事件

| audit_events 字段 | 值 |
| --- | --- |
| `action` | `warehouse_transfer.posted` |
| `entity_type` | `warehouse_transfer` |
| `entity_id` | 调拨单 UUID（库存事实的 `source_id` 指向它） |
| `actor_id` | 操作人 |
| `details` | 单号、源/目标仓、用途、状态、备注、明细快照、幂等键 |

调拨单一经提交不可修改、不可删除；更正只能反向再做一笔调拨。这与仓库模块「历史事实不篡改、
差异用冲销/调整表达」的原则一致，也天然满足「保留调拨记录可追溯」。

### 2.2 库存事实

每行写两条 `inventory_facts`：

| 来源类型 | 数量 | 归属仓库 | 路由快照 |
| --- | --- | --- | --- |
| `warehouse_transfer_out` | `-数量` | 源仓（同安） | `source_version = "tongan>daitan"` |
| `warehouse_transfer_in` | `+数量` | 目标仓 | 同上 |

全局原料余额 = 两条相加 = 0，所以总量不变；两个仓库各自的余额一减一增。`source_id` 都指向单头
UUID，可按单追溯。

### 2.3 仓库归属

`inventory_facts` 没有仓库列，本工单用「事实 + 关系」推导归属：

1. 调拨事实：`source_version` 的 `from` / `to`；
2. 原料入库事实：`raw_material_inbound -> purchase_receipt.extension_data.warehouse_code`（T-0018）；
3. 其余历史事实（领料、退料、盘点调整等）：系统此前只有同安仓，按历史口径归同安仓。

已知限制：生产领料目前没有仓库字段，因此从大田/晋江仓领料不会自动扣减目标仓，而是按历史口径扣同安仓。
要让领料也带仓库维度，需要新增列/迁移，属于**需要人工处理**的后续项。

## 3. 业务规则

1. 源仓库固定 `tongan`（同安仓），传其他值 422 `INVALID_TRANSFER_SOURCE`；
2. 目标仓库只允许 `daitan`（大田仓）、`jinjiang`（晋江仓），其他值 422 `INVALID_TRANSFER_TARGET`；
3. 调拨目的固定 `target_production`，文案「供目标仓库生产使用」，不接受自由文本；
4. 明细至少 1 行、最多 100 行；同一物料一张单只能一行；数量必须是大于零、最多 4 位小数的十进制；
5. 数量单位取物料默认单位（与全站「每种物料只有一个计量单位」一致），前端不传单位；
6. 事务内先锁涉及的 `materials` 行，再按同安仓归属重算余量；任一行不足则整单 422
   `TRANSFER_SOURCE_STOCK_INSUFFICIENT`，一条事实都不写，禁止负库存；
7. 单号 `DB-YYYYMMDD-0001`，按天递增；用 `pg_advisory_xact_lock` 串行化当天编号段；
8. `idempotency_key` 相同返回原单，不重复扣加库存。

## 4. 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/warehouse-transfers` | 调拨记录（最新在前，可按 `target_warehouse` 过滤） |
| GET | `/warehouse-transfers/balances` | 按仓库汇总原料库存（同安/大田/晋江三列） |
| POST | `/warehouse-transfers` | 新建并立即完成调拨 |

全部 `@RequireModules("warehouse")`。

请求示例：

```json
{
  "source_warehouse": "tongan",
  "target_warehouse": "daitan",
  "purpose": "target_production",
  "remark": "大田车间下周生产用",
  "idempotency_key": "web-transfer-...",
  "lines": [{ "material_id": "uuid", "quantity": "12.5" }]
}
```

## 5. 页面

`/warehouse/transfers`：

- 新建调拨单：目标仓下拉（大田/晋江）、原料搜索下拉、数量、备注、添加明细、提交；
- 三仓原料库存：同安 / 大田 / 晋江三列，调拨后立即刷新；
- 调拨记录：单号、时间、源/目标仓、用途、物料明细、状态、备注、创建人/最后修改人；
- 关键字搜索（全站统一 `fuzzyMatch`：空格分词 AND、忽略大小写与空白）。

仓库首页增加「跨仓调拨」入口。

## 6. 验证

- `npm run typecheck`（三个 workspace）；
- 定向 API 单测：`node --test apps/api/test/unit/warehouse-transfer.test.cjs`（先 `npm run build --workspace=@dilee/api`）；
- 定向 Web 纯函数单测：`node --test apps/web/lib/warehouse-transfer.test.mjs`；
- 覆盖率守卫：`node --test apps/web/lib/audit-columns-coverage.test.mjs apps/web/lib/table-width-coverage.test.mjs`。

未跑全量 `npm test` / `test:unit` / `integration`（工单明确禁止，2 核机器会超时）。

## 7. 需要人工处理的后续项

1. 正式建 `warehouses` 主数据表、`warehouse_transfers` / `warehouse_transfer_lines` 表，并给
   `inventory_facts` 加 `warehouse_code` 列；届时把本工单的审计单头一次性回填成业务表。
2. 生产领料/退料增加仓库维度，目标仓生产领料才能真正自动扣减目标仓。
3. 调拨单如需草稿、审批、打印/导出，再按业务流程补；本工单只做「提交即完成」的最小闭环。

上面的第 1 项必须改迁移，属于黑名单，需人工排期，不在本工单内绕过。

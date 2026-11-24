/**
 * 跨仓库调拨（T-0028，2026-11-24）。
 *
 * 用户原话：新增跨仓库调拨业务，源仓库为同安仓库，目标仓库可选大田仓库、晋江仓库；
 * 调拨目的是供目标仓库生产使用，调拨完成后自动更新两边仓库库存，保留调拨记录可追溯。
 *
 * ## 为什么不建 `warehouse_transfers` 表
 *
 * 本工单硬性禁止新增/修改 `prisma/migrations`，而建新表必须配套迁移。沿用 T-0018
 * （`warehouse-catalog.ts`）已确立的做法：**不新增列、不新增表**，把调拨单头作为一条
 * 不可变的审计事件保存（`audit_events.entity_type = "warehouse_transfer"`），库存变动
 * 仍旧写 `inventory_facts`。这样历史数据、迁移链和并发口径都不动。
 *
 * 调拨单是**一次提交即完成**的不可变单据：没有草稿/编辑/删除。要更正只能反向再做一笔调拨，
 * 与原仓库「进退皆可、历史事实不篡改」的原则一致。
 *
 * ## 仓库维度怎么来
 *
 * 系统 V1 的 `inventory_facts` 没有仓库列。本工单只给**原料**做调拨，且只在事实层区分归属：
 *   - 调拨事实：`source_version = "tongan>daitan"`，出库事实归源仓、入库事实归目标仓；
 *   - 原料入库事实：归属到货批次 `purchase_receipts.extension_data.warehouse_code`（T-0018）；
 *   - 其余历史事实（领料、退料、盘点调整等）没有仓库信息，按历史口径归同安仓。
 *
 * 因此「同安仓余量」= 总库存 − 已调出 + 已调入 − 直接入到大田/晋江的到货量。这是在不改表
 * 的前提下能给出的最接近事实的口径；等后续允许迁移时，再把这些归属变成 `inventory_facts`
 * 上的正式仓库列（属于需要人工处理的后续项，见设计文档）。
 */

import { DEFAULT_WAREHOUSE_CODE, WAREHOUSE_CATALOG, warehouseByCode, warehouseOf, type Warehouse } from "../procurement/warehouse-catalog";

/** 调拨单在 `audit_events` 里的实体类型；列表与幂等查询都认它。 */
export const WAREHOUSE_TRANSFER_ENTITY = "warehouse_transfer";
/** 调拨单头事件的动作名。 */
export const WAREHOUSE_TRANSFER_POSTED_ACTION = "warehouse_transfer.posted";
/** 库存事实里的来源类型。 */
export const WAREHOUSE_TRANSFER_OUT = "warehouse_transfer_out";
export const WAREHOUSE_TRANSFER_IN = "warehouse_transfer_in";

/** 源仓库固定同安仓。 */
export const WAREHOUSE_TRANSFER_SOURCE = DEFAULT_WAREHOUSE_CODE;
/** 目标仓库只允许大田仓、晋江仓（顺序即页面展示顺序）。 */
export const WAREHOUSE_TRANSFER_TARGET_CODES = ["daitan", "jinjiang"] as const;
export type WarehouseTransferTarget = (typeof WAREHOUSE_TRANSFER_TARGET_CODES)[number];

/** 调拨目的固定为「供目标仓库生产使用」，不接受自由文本，避免口径漂移。 */
export const WAREHOUSE_TRANSFER_PURPOSE = "target_production";
export const WAREHOUSE_TRANSFER_PURPOSE_LABEL = "供目标仓库生产使用";

/** 单据号前缀：DB-YYYYMMDD-0001，与盘点/物料/供应商共用同一套自动编码规则。 */
export const WAREHOUSE_TRANSFER_CODE_CATEGORY = "DB";
/** 一张调拨单最多多少行（与生产领料单的 100 行上限同一量级）。 */
export const WAREHOUSE_TRANSFER_MAX_LINES = 100;

const ROUTE_SEPARATOR = ">";

export type WarehouseTransferRoute = { from: string; to: string };

export function isWarehouseTransferTarget(code: string | null | undefined): code is WarehouseTransferTarget {
  return WAREHOUSE_TRANSFER_TARGET_CODES.includes((code ?? "").trim() as WarehouseTransferTarget);
}

/** 源/目标仓的中文名；未知编码原样返回，避免历史单据显示成空白。 */
export function warehouseNameOf(code: string | null | undefined): string {
  const key = (code ?? "").trim();
  if (!key) return warehouseByCode(WAREHOUSE_TRANSFER_SOURCE)?.name ?? WAREHOUSE_TRANSFER_SOURCE;
  return warehouseByCode(key)?.name ?? key;
}

/** 目标仓下拉选项（后端校验与前端展示同源）。 */
export function warehouseTransferTargets(): Warehouse[] {
  return WAREHOUSE_TRANSFER_TARGET_CODES.map((code) => warehouseByCode(code)!).filter(Boolean);
}

/** 事实上的仓库快照：`tongan>daitan`。 */
export function transferRoute(from: string, to: string): string {
  return `${from}${ROUTE_SEPARATOR}${to}`;
}

/** 解析事实快照；格式不对返回 null，调用方自行回落。 */
export function parseTransferRoute(sourceVersion: string | null | undefined): WarehouseTransferRoute | null {
  const [fromRaw, toRaw] = (sourceVersion ?? "").split(ROUTE_SEPARATOR);
  const from = (fromRaw ?? "").trim();
  const to = (toRaw ?? "").trim();
  if (!from || !to) return null;
  return { from, to };
}

/**
 * 把一条库存事实归到某个仓库。
 *
 * 纯函数：不查库。`inboundExtensionData` 只对原料入库事实有意义（到货批次 JSON）。
 * 调拨事实优先按来源类型 + 路由快照判定，避免历史调拨在仓库档案改名后漂移。
 */
export function warehouseCodeOfFact(fact: {
  sourceType?: string | null;
  sourceVersion?: string | null;
  inboundExtensionData?: unknown;
}): string {
  const route = parseTransferRoute(fact.sourceVersion);
  if (fact.sourceType === WAREHOUSE_TRANSFER_OUT && route) return route.from;
  if (fact.sourceType === WAREHOUSE_TRANSFER_IN && route) return route.to;
  if (fact.inboundExtensionData !== undefined && fact.inboundExtensionData !== null) {
    return warehouseOf(fact.inboundExtensionData).code;
  }
  return WAREHOUSE_TRANSFER_SOURCE;
}

/** 三个仓库的固定列，页面与接口共用，顺序不随档案增删漂移。 */
export const WAREHOUSE_TRANSFER_WAREHOUSES: ReadonlyArray<{ code: string; name: string }> = WAREHOUSE_CATALOG.map((item) => ({ code: item.code, name: item.name }));

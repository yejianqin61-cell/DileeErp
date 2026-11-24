import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { dailyCodePrefix, nextSequenceCode } from "../../platform/database/daily-sequence-code";
import { parseQuantity } from "../../platform/database/quantity";
import { PrismaService } from "../../platform/database/prisma.service";
import {
  WAREHOUSE_TRANSFER_CODE_CATEGORY,
  WAREHOUSE_TRANSFER_ENTITY,
  WAREHOUSE_TRANSFER_IN,
  WAREHOUSE_TRANSFER_MAX_LINES,
  WAREHOUSE_TRANSFER_OUT,
  WAREHOUSE_TRANSFER_POSTED_ACTION,
  WAREHOUSE_TRANSFER_PURPOSE,
  WAREHOUSE_TRANSFER_PURPOSE_LABEL,
  WAREHOUSE_TRANSFER_SOURCE,
  WAREHOUSE_TRANSFER_WAREHOUSES,
  isWarehouseTransferTarget,
  transferRoute,
  warehouseCodeOfFact,
  warehouseNameOf,
} from "./warehouse-transfer.domain";

type TransferClient = PrismaService | Prisma.TransactionClient;
type TransferLineInput = { material_id: string; quantity: string };

export type WarehouseTransferLineSnapshot = {
  material_id: string;
  material_code: string;
  material_name: string;
  specification_model: string | null;
  unit_id: string;
  unit_name: string;
  quantity: string;
};

/** 调拨单头在 `audit_events.details` 里的形状。只读解析，写入前由 create 组装。 */
type WarehouseTransferDetails = {
  transfer_no: string;
  source_warehouse: string;
  source_warehouse_name: string;
  target_warehouse: string;
  target_warehouse_name: string;
  purpose: string;
  purpose_label: string;
  status: "posted";
  remark: string | null;
  lines: WarehouseTransferLineSnapshot[];
  idempotency_key: string | null;
};

type TransferAuditRow = { id: string; entityId: string | null; details: unknown; createdAt: Date; actorId: string | null };

const POSTED = "posted" as const;

/**
 * 跨仓库调拨（仓库模块）。
 *
 * 关键口径：
 *   1. 源仓固定同安仓、目标仓只允许大田/晋江；调拨目的固定「供目标仓库生产使用」；
 *   2. 一张单一次提交，写两条库存事实（源仓 −、目标仓 +），全局净额不变；
 *   3. 同安仓余量在事务内**先锁物料行再算**，任何一行不足则整单回滚，不允许负库存；
 *   4. 单头是不可变审计事件（不建表、不建迁移），库存事实的 `sourceId` 指向它，可逐笔追溯。
 *
 * 为什么锁 `materials` 行而不是新表：调拨不新增表；同一物料的并发调拨都先争这把行锁，
 * 后到手的事务重新算余额，避免两张单各看到「够」而一起调空库存。
 */
@Injectable()
export class WarehouseTransferService {
  constructor(private readonly prisma: PrismaService) {}

  /** 调拨记录列表（最新在前）。 */
  async list(input: { targetWarehouse?: string; limit?: number } = {}) {
    const target = (input.targetWarehouse ?? "").trim();
    if (target && !isWarehouseTransferTarget(target)) throw this.invalid("INVALID_TRANSFER_TARGET", "目标仓库只能是晋江仓或大田仓");
    const take = Number.isFinite(input.limit) ? Math.min(Math.max(Number(input.limit), 1), 500) : 200;
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        entityType: WAREHOUSE_TRANSFER_ENTITY,
        action: WAREHOUSE_TRANSFER_POSTED_ACTION,
        ...(target ? { details: { path: ["target_warehouse"], equals: target } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take,
    });
    return this.attachActorNames(rows as TransferAuditRow[]);
  }

  /**
   * 按仓库汇总原料库存。
   *
   * 与「原料仓储情况」同一库存分类口径（raw_material + scrap），逐条事实归仓后按
   * 「物料 + 单位」分组。没有发生额的仓库列也返回 0，页面不用自己做缺列兜底。
   */
  async balances(materialId?: string) {
    const id = (materialId ?? "").trim();
    const facts = await this.prisma.inventoryFact.findMany({
      where: {
        inventoryCategory: { in: ["raw_material", "scrap"] },
        ...(id ? { materialId: id } : {}),
        material: { deletedAt: null, materialType: "raw_material" },
        unit: { deletedAt: null },
      },
      select: {
        materialId: true,
        unitId: true,
        quantityDelta: true,
        sourceType: true,
        sourceVersion: true,
        rawMaterialInbound: { select: { purchaseReceipt: { select: { extensionData: true } } } },
        material: { select: { materialCode: true, name: true, specificationModel: true } },
        unit: { select: { name: true } },
      },
    });
    const balances = new Map<string, {
      material_id: string;
      material_code: string;
      material_name: string;
      specification_model: string | null;
      unit_id: string;
      unit_name: string;
      quantities: Map<string, Prisma.Decimal>;
    }>();
    for (const fact of facts) {
      if (!fact.materialId || !fact.material || !fact.unit) continue;
      const key = `${fact.materialId}|${fact.unitId}`;
      const current = balances.get(key) ?? {
        material_id: fact.materialId,
        material_code: fact.material.materialCode,
        material_name: fact.material.name,
        specification_model: fact.material.specificationModel ?? null,
        unit_id: fact.unitId,
        unit_name: fact.unit.name,
        quantities: new Map(WAREHOUSE_TRANSFER_WAREHOUSES.map((warehouse) => [warehouse.code, new Prisma.Decimal(0)])),
      };
      const warehouseCode = warehouseCodeOfFact({
        sourceType: fact.sourceType,
        sourceVersion: fact.sourceVersion,
        inboundExtensionData: fact.rawMaterialInbound?.purchaseReceipt?.extensionData,
      });
      current.quantities.set(warehouseCode, (current.quantities.get(warehouseCode) ?? new Prisma.Decimal(0)).plus(fact.quantityDelta));
      balances.set(key, current);
    }
    return [...balances.values()]
      .sort((a, b) => a.material_code.localeCompare(b.material_code) || a.unit_name.localeCompare(b.unit_name))
      .map((row) => ({
        material_id: row.material_id,
        material_code: row.material_code,
        material_name: row.material_name,
        specification_model: row.specification_model,
        unit_id: row.unit_id,
        unit_name: row.unit_name,
        ...Object.fromEntries(WAREHOUSE_TRANSFER_WAREHOUSES.map((warehouse) => [warehouse.code, (row.quantities.get(warehouse.code) ?? new Prisma.Decimal(0)).toString()])),
      }));
  }

  /**
   * 新建并立即完成一张调拨单。
   *
   * `idempotency_key` 相同视为同一次提交：返回原单，不重复写库存事实。前端每次打开页面
   * 生成一个键，重复点击/网络重试都落到同一张单上。
   */
  async create(input: {
    source_warehouse?: string;
    target_warehouse: string;
    purpose?: string;
    remark?: string;
    idempotency_key?: string;
    lines: TransferLineInput[];
  }, user: CurrentUser) {
    const source = (input.source_warehouse ?? "").trim();
    if (source && source !== WAREHOUSE_TRANSFER_SOURCE) {
      throw this.invalid("INVALID_TRANSFER_SOURCE", `调拨源仓库固定为${warehouseNameOf(WAREHOUSE_TRANSFER_SOURCE)}`);
    }
    const target = (input.target_warehouse ?? "").trim();
    if (!isWarehouseTransferTarget(target)) throw this.invalid("INVALID_TRANSFER_TARGET", "目标仓库只能是晋江仓或大田仓");
    const purpose = (input.purpose ?? "").trim() || WAREHOUSE_TRANSFER_PURPOSE;
    if (purpose !== WAREHOUSE_TRANSFER_PURPOSE) throw this.invalid("INVALID_TRANSFER_PURPOSE", "调拨目的固定为供目标仓库生产使用");
    const rawLines = input.lines ?? [];
    if (!rawLines.length) throw this.invalid("TRANSFER_LINES_REQUIRED", "调拨单至少需要一条物料明细");
    if (rawLines.length > WAREHOUSE_TRANSFER_MAX_LINES) throw this.invalid("TRANSFER_LINES_EXCEEDED", `一张调拨单最多 ${WAREHOUSE_TRANSFER_MAX_LINES} 行`);
    const seen = new Set<string>();
    for (const line of rawLines) {
      const materialId = (line.material_id ?? "").trim();
      if (!materialId) throw this.invalid("TRANSFER_MATERIAL_REQUIRED", "调拨明细必须选择物料");
      if (seen.has(materialId)) throw this.invalid("TRANSFER_MATERIAL_DUPLICATED", "同一物料在一张调拨单里只能出现一行");
      seen.add(materialId);
      parseQuantity(line.quantity, "INVALID_TRANSFER_QUANTITY", "调拨数量必须是大于零、最多 4 位小数的十进制数");
    }
    const idempotencyKey = (input.idempotency_key ?? "").trim() || null;

    const result = await this.prisma.$transaction(async (tx) => {
      const prefix = dailyCodePrefix(WAREHOUSE_TRANSFER_CODE_CATEGORY);
      // 单号按天递增：先锁住当天的编号段，避免两个并发事务拿到同一个 DB-...-0001。
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, `warehouse_transfer:${prefix}`);
      if (idempotencyKey) {
        const existing = await tx.auditEvent.findFirst({
          where: {
            entityType: WAREHOUSE_TRANSFER_ENTITY,
            action: WAREHOUSE_TRANSFER_POSTED_ACTION,
            details: { path: ["idempotency_key"], equals: idempotencyKey },
          },
          orderBy: { createdAt: "desc" },
        });
        if (existing) return this.serialize(existing as TransferAuditRow, new Map());
      }

      const materialIds = rawLines.map((line) => line.material_id.trim());
      const materials = await tx.material.findMany({
        where: { id: { in: materialIds }, deletedAt: null, materialType: "raw_material" },
        select: { id: true, materialCode: true, name: true, specificationModel: true, defaultUnitId: true, defaultUnit: { select: { name: true } } },
      });
      const materialMap = new Map(materials.map((material) => [material.id, material]));
      const missing = materialIds.filter((id) => !materialMap.has(id));
      if (missing.length) throw this.invalid("TRANSFER_MATERIAL_NOT_FOUND", "调拨明细里有物料不存在、已停用或不是原料", { material_ids: missing });

      // 锁物料行：同一物料的并发调拨串行化，后到者重新计算同安仓余量。
      for (const materialId of [...new Set(materialIds)].sort()) {
        await tx.$queryRawUnsafe(`SELECT id FROM materials WHERE id = $1::uuid FOR UPDATE`, materialId);
      }

      const lines: WarehouseTransferLineSnapshot[] = [];
      for (const rawLine of rawLines) {
        const material = materialMap.get(rawLine.material_id.trim())!;
        const quantity = parseQuantity(rawLine.quantity, "INVALID_TRANSFER_QUANTITY", "调拨数量必须是大于零、最多 4 位小数的十进制数");
        const available = await this.warehouseBalance(tx, material.id, material.defaultUnitId, WAREHOUSE_TRANSFER_SOURCE);
        if (available.lt(quantity)) {
          throw this.invalid("TRANSFER_SOURCE_STOCK_INSUFFICIENT", `同安仓「${material.materialCode} ${material.name}」可用 ${available.toString()}${material.defaultUnit?.name ?? ""}，不足以调拨 ${quantity.toString()}${material.defaultUnit?.name ?? ""}`, {
            material_id: material.id,
            available: available.toString(),
            requested: quantity.toString(),
          });
        }
        lines.push({
          material_id: material.id,
          material_code: material.materialCode,
          material_name: material.name,
          specification_model: material.specificationModel ?? null,
          unit_id: material.defaultUnitId,
          unit_name: material.defaultUnit?.name ?? "",
          quantity: quantity.toString(),
        });
      }

      const dayStart = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
      const todayRows = await tx.auditEvent.findMany({
        where: { entityType: WAREHOUSE_TRANSFER_ENTITY, action: WAREHOUSE_TRANSFER_POSTED_ACTION, createdAt: { gte: dayStart } },
        select: { details: true },
      });
      const transferNo = nextSequenceCode(prefix, todayRows.map((row) => (row.details as WarehouseTransferDetails | null)?.transfer_no ?? null));
      const transferId = randomUUID();
      const route = transferRoute(WAREHOUSE_TRANSFER_SOURCE, target);
      const details: WarehouseTransferDetails = {
        transfer_no: transferNo,
        source_warehouse: WAREHOUSE_TRANSFER_SOURCE,
        source_warehouse_name: warehouseNameOf(WAREHOUSE_TRANSFER_SOURCE),
        target_warehouse: target,
        target_warehouse_name: warehouseNameOf(target),
        purpose: WAREHOUSE_TRANSFER_PURPOSE,
        purpose_label: WAREHOUSE_TRANSFER_PURPOSE_LABEL,
        status: POSTED,
        remark: (input.remark ?? "").trim() || null,
        lines,
        idempotency_key: idempotencyKey,
      };

      // 单头：不可变审计事件。与两条库存事实同事务，不存在「有单没库存 / 有库存没单」。
      await tx.auditEvent.create({
        data: {
          action: WAREHOUSE_TRANSFER_POSTED_ACTION,
          entityType: WAREHOUSE_TRANSFER_ENTITY,
          entityId: transferId,
          actorId: user.id,
          details: details as unknown as Prisma.InputJsonValue,
        },
      });
      for (const line of lines) {
        const quantity = new Prisma.Decimal(line.quantity);
        await tx.inventoryFact.create({
          data: {
            materialId: line.material_id,
            unitId: line.unit_id,
            inventoryCategory: "raw_material",
            quantityDelta: quantity.negated(),
            sourceType: WAREHOUSE_TRANSFER_OUT,
            sourceId: transferId,
            sourceVersion: route,
            createdBy: user.id,
          },
        });
        await tx.inventoryFact.create({
          data: {
            materialId: line.material_id,
            unitId: line.unit_id,
            inventoryCategory: "raw_material",
            quantityDelta: quantity,
            sourceType: WAREHOUSE_TRANSFER_IN,
            sourceId: transferId,
            sourceVersion: route,
            createdBy: user.id,
          },
        });
      }
      return {
        id: transferId,
        transfer_no: transferNo,
        source_warehouse: WAREHOUSE_TRANSFER_SOURCE,
        source_warehouse_name: warehouseNameOf(WAREHOUSE_TRANSFER_SOURCE),
        target_warehouse: target,
        target_warehouse_name: warehouseNameOf(target),
        purpose: WAREHOUSE_TRANSFER_PURPOSE,
        purpose_label: WAREHOUSE_TRANSFER_PURPOSE_LABEL,
        status: POSTED,
        remark: details.remark,
        lines,
        line_count: lines.length,
        created_by_name: null,
        updated_by_name: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });

    // 与创建同事务的那条事件本身就是单头；这里不再重复写一条「创建成功」审计，
    // 否则列表要把同一张单算两遍。
    return result;
  }

  /** 取某物料/单位在某仓库的当前数量。调用方负责先锁物料行。 */
  private async warehouseBalance(client: TransferClient, materialId: string, unitId: string, warehouseCode: string) {
    const facts = await client.inventoryFact.findMany({
      where: { materialId, unitId, inventoryCategory: { in: ["raw_material", "scrap"] } },
      select: {
        quantityDelta: true,
        sourceType: true,
        sourceVersion: true,
        rawMaterialInbound: { select: { purchaseReceipt: { select: { extensionData: true } } } },
      },
    });
    return facts.reduce((sum, fact) => (
      warehouseCodeOfFact({
        sourceType: fact.sourceType,
        sourceVersion: fact.sourceVersion,
        inboundExtensionData: fact.rawMaterialInbound?.purchaseReceipt?.extensionData,
      }) === warehouseCode ? sum.plus(fact.quantityDelta) : sum
    ), new Prisma.Decimal(0));
  }

  private async attachActorNames(rows: TransferAuditRow[]) {
    const actorIds = [...new Set(rows.map((row) => row.actorId).filter((id): id is string => Boolean(id)))];
    const users = actorIds.length ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } }) : [];
    const names = new Map(users.map((user) => [user.id, user.displayName]));
    return rows.map((row) => this.serialize(row, names));
  }

  private serialize(row: TransferAuditRow, names: Map<string, string>) {
    const details = (row.details ?? {}) as Partial<WarehouseTransferDetails>;
    const actorName = row.actorId ? names.get(row.actorId) ?? null : null;
    return {
      id: row.entityId ?? row.id,
      transfer_no: details.transfer_no ?? "",
      source_warehouse: details.source_warehouse ?? WAREHOUSE_TRANSFER_SOURCE,
      source_warehouse_name: details.source_warehouse_name ?? warehouseNameOf(WAREHOUSE_TRANSFER_SOURCE),
      target_warehouse: details.target_warehouse ?? "",
      target_warehouse_name: details.target_warehouse_name ?? warehouseNameOf(details.target_warehouse),
      purpose: details.purpose ?? WAREHOUSE_TRANSFER_PURPOSE,
      purpose_label: details.purpose_label ?? WAREHOUSE_TRANSFER_PURPOSE_LABEL,
      status: details.status ?? POSTED,
      remark: details.remark ?? null,
      lines: Array.isArray(details.lines) ? details.lines : [],
      line_count: Array.isArray(details.lines) ? details.lines.length : 0,
      created_by_name: actorName,
      updated_by_name: actorName,
      createdAt: row.createdAt?.toISOString?.() ?? null,
      updatedAt: row.createdAt?.toISOString?.() ?? null,
    };
  }

  private invalid(code: string, message: string, details: unknown = []) {
    return new UnprocessableEntityException({ code, message, details });
  }
}

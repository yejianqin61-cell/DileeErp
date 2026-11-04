import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../platform/database/prisma.service";
import {
  buildProcurementWarehouseRows,
  EFFECTIVE_PURCHASE_ORDER_STATUSES,
  PROCUREMENT_WAREHOUSE_ROW_LIMIT,
  PRODUCTION_ISSUE_SOURCE_TYPES,
  RAW_MATERIAL_STOCK_CATEGORIES,
  type AggregatedQuantity,
  type ProcurementWarehouseFilter,
  type ProcurementWarehouseRow,
  type StockQuantity
} from "./procurement-warehouse-report.domain";

/**
 * 采购与仓储报表的取数与 JSON 塑形（设计文档 `docs/design/procurement-warehouse-report-2026-11-04.md`）。
 *
 * 五个列的口径全部落在「同一个订单 × 同一个物料 × 同一个单位」上，数据来源只有三张事实表：
 *   采购数量   ← purchase_order_items.quantity（采购单已下单，草稿/已取消不计）
 *   采购入库量 ← raw_material_inbounds.quantity（status = posted，草稿/已冲销不计）
 *   生产领用   ← inventory_facts.quantity_delta（领料/补料/退料/冲销/撤销过账，取负号）
 *   库存量     ← inventory_facts.quantity_delta（原料仓 + 报废仓，与 /inventory/raw-material-balances 同口径）
 * 明细见 domain 文件与设计文档 §1。
 */
export type ProcurementWarehouseReportMeta = {
  generated_at: string;
  row_count: number;
  row_limit: number;
  filters: { order_no: string | null; material: string | null };
};

/** 取数结果（屏幕 JSON 塑形与 xlsx 导出共用这一份）。 */
export type ProcurementWarehouseReportData = {
  rows: ProcurementWarehouseRow[];
  generatedAt: Date;
  filters: { order_no: string | null; material: string | null };
};

/** 展示/口径过滤用的物料主数据最小集（名字给展示列，类型与删除标记给库存量口径）。 */
type MaterialMasterRow = { id: string; name: string; color: string | null; materialType: string; deletedAt: Date | null };
/** 展示/口径过滤用的单位主数据最小集（名字给展示列，删除标记给库存量口径）。 */
type UnitMasterRow = { id: string; name: string; deletedAt: Date | null };

const MATERIAL_SELECT = { id: true, name: true, color: true, materialType: true, deletedAt: true } as const;
const UNIT_SELECT = { id: true, name: true, deletedAt: true } as const;

/** 筛选值规范化：空白串等于没给（既有报表接口同样把空串当「未筛选」）。 */
const trimmedOrUndefined = (value: string | undefined | null): string | undefined => {
  const text = value?.trim();
  return text ? text : undefined;
};

/** 大小写不敏感的「包含」——PostgreSQL 侧 `ILIKE`，不前导模糊在内存里做。 */
const containsInsensitive = (value: string): Prisma.StringFilter => ({ contains: value, mode: Prisma.QueryMode.insensitive });

/**
 * 物料模糊筛选：**名称 或 编码**包含匹配（大小写不敏感）。
 *
 * 这是**物料表自己的 where**（纯标量/普通条件），不是把 `material` 关联过滤塞进别的模型的 groupBy
 * —— 原因见 {@link fetchRows} 的查询清单注释。
 */
const materialContains = (material: string): Prisma.MaterialWhereInput => ({
  OR: [
    { name: containsInsensitive(material) },
    { materialCode: containsInsensitive(material) }
  ]
});

@Injectable()
export class ProcurementWarehouseReportService {
  constructor(private readonly prisma: PrismaService) {}

  /** JSON 塑形（§3.1）：`{ data, meta }`。导出服务不调它，而是调 {@link build} 拿同一份取数结果。 */
  async report(filter: ProcurementWarehouseFilter = {}): Promise<{ data: ProcurementWarehouseRow[]; meta: ProcurementWarehouseReportMeta }> {
    const result = await this.build(filter);
    return {
      data: result.rows,
      meta: {
        generated_at: result.generatedAt.toISOString(),
        row_count: result.rows.length,
        // 行数上限也回给前端：提示文案里要能说清「上限 5000 行」，用户才知道往哪个方向缩小范围。
        row_limit: PROCUREMENT_WAREHOUSE_ROW_LIMIT,
        filters: result.filters
      }
    };
  }

  /** 取数（屏幕与导出共用）。行数超上限时抛 422，**不截断**。 */
  async build(filter: ProcurementWarehouseFilter = {}): Promise<ProcurementWarehouseReportData> {
    // 生成时间在取数前落定：xlsx 里的「生成时间」与文件名的时间戳必须是同一刻，
    // 否则用户会拿到一个「文件名比内容晚几秒」的文件（导出在取数之后才写盘）。
    const generatedAt = new Date();
    const orderNo = trimmedOrUndefined(filter.order_no);
    const material = trimmedOrUndefined(filter.material);
    const rows = await this.fetchRows(orderNo, material);
    if (rows.length > PROCUREMENT_WAREHOUSE_ROW_LIMIT) {
      throw new UnprocessableEntityException({
        code: "REPORT_ROW_LIMIT_EXCEEDED",
        message: `报表行数超过 ${PROCUREMENT_WAREHOUSE_ROW_LIMIT} 行，请按订单号或物料缩小范围`,
        details: [{ row_count: rows.length, row_limit: PROCUREMENT_WAREHOUSE_ROW_LIMIT }]
      });
    }
    return { rows, generatedAt, filters: { order_no: orderNo ?? null, material: material ?? null } };
  }

  /**
   * 取数。**固定 7 条查询**（不随行数增长，禁止按行循环查库），最多四轮往返：
   *   第一轮 ① purchaseOrder.findMany（已下单的采购单 id + 单号）与 ② material.findMany（仅在给了
   *          material 筛选时；解析出物料 id 集合，同时就是第二轮的展示列，省一条查询）
   *   第二轮 ③ purchaseOrderItem.groupBy（采购数量）④ rawMaterialInbound.groupBy（采购入库量）
   *          ⑤ inventoryFact.groupBy（生产领用）—— 三条并行
   *   第三轮 ⑥ material.findMany / unit.findMany（展示列；物料若第一轮已查过则复用）
   *   第四轮 ⑦ inventoryFact.groupBy（库存量，要等第三轮把「未删的原料物料 + 未删的单位」id 筛出来）
   *
   * ## 为什么 groupBy 的 where 只写**标量字段**，不用关联过滤
   *
   * 1. 本仓库既有的 20 处 `groupBy` 全是纯标量 where，没有任何一处用关联过滤 —— 那条路径在本项目
   *    里没有运行先例；
   * 2. 本机没有 PostgreSQL（docker 未起），单元测试用的是假 Prisma，**证明不了**引擎支持它。
   *    一旦引擎不支持，整页报表 500，而我们在本地无法提前发现。
   * 所以「订单/物料的筛选」全部先解析成 id 集合再 `in: [...]`：每条查询的 where 都能被假 Prisma
   * 逐字钉住（见测试里的「groupBy where 只含标量字段」守卫用例）。别顺手优化回关联过滤。
   *
   * 每条 groupBy 的返回行数上界 = 该事实表里满足筛选的「订单号 × 物料 × 单位」组合数：
   * 正常用法（一张或几张订单）是几十到几百行；没有筛选时会随单据规模增长，但聚合在库侧完成，
   * 回到应用层的只是组合行（每行 3~4 个字段），不是明细。组合数一旦超过 5000，
   * 组装出来的行数必然超过上限 → 直接 422，正是设计文档说的「保护闸」。
   */
  private async fetchRows(orderNo: string | undefined, material: string | undefined): Promise<ProcurementWarehouseRow[]> {
    // ---------------------------------------------------------------- 第一轮：筛选条件 → id 集合
    // ① 已下单（ordered / partially_arrived / arrived_complete）的采购单：草稿与已取消不是下单承诺。
    //    这条查询无论有没有 order_no 筛选都要跑：采购明细的 where 里要 `purchaseOrderId in [...]`
    //    才能表达「采购单已下单且未删」这个条件（groupBy 不能写关联过滤）。
    const ordersQuery = this.prisma.purchaseOrder.findMany({
      where: {
        deletedAt: null,
        status: { in: [...EFFECTIVE_PURCHASE_ORDER_STATUSES] },
        ...(orderNo ? { orderNo: containsInsensitive(orderNo) } : {})
      },
      select: { id: true, orderNo: true }
    });
    // ② 物料模糊筛选：名称或编码包含。查出来既当筛选 id 集合、也当展示列（名称/颜色）。
    const filterMaterialsQuery: Promise<MaterialMasterRow[]> = material
      ? this.prisma.material.findMany({ where: materialContains(material), select: MATERIAL_SELECT })
      : Promise.resolve([]);
    const [effectiveOrders, filterMaterials] = await Promise.all([ordersQuery, filterMaterialsQuery]);
    // 物料筛选一个都没匹配上 → 三类来源都会被 materialId in [] 清空，直接返回，不白跑后面几条聚合。
    if (material && !filterMaterials.length) return [];

    const orderIds = effectiveOrders.map((order) => order.id);
    const filterMaterialIds = filterMaterials.map((row) => row.id);

    // ---------------------------------------------------------------- 第二轮：三个事实来源
    const [purchaseGroups, inboundGroups, issueGroups] = await Promise.all([
      // ③ 采购数量：明细行逐行求和。订单筛选通过 `purchaseOrderId in` 落地（第一轮已按单号 + 状态筛过）。
      //    `in: []` 在 Prisma 里等价于「永远不匹配」，但这里显式跳过、不把空数组发给数据库。
      orderIds.length
        ? this.prisma.purchaseOrderItem.groupBy({
          by: ["purchaseOrderId", "materialId", "unitId"],
          where: {
            deletedAt: null,
            purchaseOrderId: { in: orderIds },
            ...(filterMaterialIds.length ? { materialId: { in: filterMaterialIds } } : {})
          },
          _sum: { quantity: true }
        })
        : Promise.resolve([]),
      // ④ 采购入库量：草稿（还没过账）与已冲销（reversed）都不算。order_no 在入库单上是标量列。
      this.prisma.rawMaterialInbound.groupBy({
        by: ["orderNo", "materialId", "unitId"],
        where: {
          deletedAt: null,
          status: "posted",
          ...(orderNo ? { orderNo: containsInsensitive(orderNo) } : {}),
          ...(filterMaterialIds.length ? { materialId: { in: filterMaterialIds } } : {})
        },
        _sum: { quantity: true }
      }),
      // ⑤ 生产领用：按单据自己的订单号归集；`rawMaterialMovementLineId` 非空保证只算原料移动单据，
      //    盘点调整/成品进出库那些没有这个外键的事实不会混进来。
      this.prisma.inventoryFact.groupBy({
        by: ["orderNo", "materialId", "unitId"],
        where: {
          sourceType: { in: [...PRODUCTION_ISSUE_SOURCE_TYPES] },
          rawMaterialMovementLineId: { not: null },
          orderNo: { not: null, ...(orderNo ? { contains: orderNo, mode: Prisma.QueryMode.insensitive } : {}) },
          ...(filterMaterialIds.length ? { materialId: { in: filterMaterialIds } } : {})
        },
        _sum: { quantityDelta: true }
      })
    ]);

    if (!purchaseGroups.length && !inboundGroups.length && !issueGroups.length) return [];

    const materialIds = [...new Set([
      ...purchaseGroups.map((group) => group.materialId),
      ...inboundGroups.map((group) => group.materialId),
      // 领用来源的 materialId 在 schema 里可空（盘点类事实没有物料），但本报表的筛选条件
      // 保证了 movementLine 明细必带物料；这里仍然按可空类型收窄，避免把 null 塞进 Map 键。
      ...issueGroups.map((group) => group.materialId).filter((id): id is string => id !== null)
    ])];
    const unitIds = [...new Set([
      ...purchaseGroups.map((group) => group.unitId),
      ...inboundGroups.map((group) => group.unitId),
      ...issueGroups.map((group) => group.unitId)
    ])];

    // ---------------------------------------------------------------- 第三轮：展示列字典
    // 展示列**不过滤 deletedAt**：物料/单位被软删后，历史单据上的行仍要显示得出名字
    // （显示成空名字等于把一行账变成一排空白）。库存量口径再用同一份结果的 materialType /
    // deletedAt 筛出「原料且未删」的物料 id（第四轮），两个用途从一次查询里拆。
    const materialsQuery: Promise<MaterialMasterRow[]> = material
      ? Promise.resolve(filterMaterials)
      : materialIds.length
        ? this.prisma.material.findMany({ where: { id: { in: materialIds } }, select: MATERIAL_SELECT })
        : Promise.resolve([]);
    const unitsQuery: Promise<UnitMasterRow[]> = unitIds.length
      ? this.prisma.unit.findMany({ where: { id: { in: unitIds } }, select: UNIT_SELECT })
      : Promise.resolve([]);
    const [displayMaterials, displayUnits] = await Promise.all([materialsQuery, unitsQuery]);

    // ---------------------------------------------------------------- 第四轮：库存量
    // 库存量**不按订单拆账**，所以这里没有 orderNo 条件，只有「物料 id in 未删的原料物料」
    // +「单位 id in 未删的单位」+ 原料仓/报废仓两个类别 —— 与 /inventory/raw-material-balances
    // 的 where 语义完全一致（只是先在本表行集合范围内收窄 id，同一个（物料, 单位）的求和集合不变，
    // 因此每行上的库存量与余额接口逐位相同）。筛完为空就跳过，不发 `in: []`。
    const rowMaterialIds = new Set(materialIds);
    const stockMaterialIds = displayMaterials
      .filter((row) => rowMaterialIds.has(row.id) && row.materialType === "raw_material" && row.deletedAt === null)
      .map((row) => row.id);
    const stockUnitIds = displayUnits.filter((row) => row.deletedAt === null).map((row) => row.id);
    const stockGroups = stockMaterialIds.length && stockUnitIds.length
      ? await this.prisma.inventoryFact.groupBy({
        by: ["materialId", "unitId"],
        where: {
          materialId: { in: stockMaterialIds },
          unitId: { in: stockUnitIds },
          inventoryCategory: { in: [...RAW_MATERIAL_STOCK_CATEGORIES] }
        },
        _sum: { quantityDelta: true }
      })
      : [];

    // ---------------------------------------------------------------- 组装（纯函数）
    const orderNoById = new Map(effectiveOrders.map((order) => [order.id, order.orderNo]));
    const purchase: AggregatedQuantity[] = [];
    for (const group of purchaseGroups) {
      const rowOrderNo = orderNoById.get(group.purchaseOrderId);
      // 采购单在两次查询之间被硬删（正常走软删，不会发生）时没有订单号可归行；
      // 丢掉这一组而不是编一个空订单号：空订单号会把不同单据的物料串成一行。
      if (!rowOrderNo) continue;
      purchase.push({ orderNo: rowOrderNo, materialId: group.materialId, unitId: group.unitId, quantity: group._sum.quantity ?? new Prisma.Decimal(0) });
    }
    const inbound: AggregatedQuantity[] = inboundGroups.map((group) => ({
      orderNo: group.orderNo,
      materialId: group.materialId,
      unitId: group.unitId,
      quantity: group._sum.quantity ?? new Prisma.Decimal(0)
    }));
    // orderNo / materialId 在 groupBy 结果里仍是可空类型（schema 决定），where 的 not-null 条件
    // 已把它们排除；这里再收窄一次类型，保证行键里不会出现 "null" 字符串。
    const issue: AggregatedQuantity[] = [];
    for (const group of issueGroups) {
      if (group.orderNo === null || group.materialId === null) continue;
      issue.push({ orderNo: group.orderNo, materialId: group.materialId, unitId: group.unitId, quantity: group._sum.quantityDelta ?? new Prisma.Decimal(0) });
    }
    const stock: StockQuantity[] = [];
    for (const group of stockGroups) {
      if (group.materialId === null) continue;
      stock.push({ materialId: group.materialId, unitId: group.unitId, quantity: group._sum.quantityDelta ?? new Prisma.Decimal(0) });
    }

    return buildProcurementWarehouseRows({
      purchase,
      inbound,
      issue,
      stock,
      materials: new Map(displayMaterials.map((row) => [row.id, { name: row.name, color: row.color ?? "" }])),
      units: new Map(displayUnits.map((row) => [row.id, row.name]))
    });
  }
}

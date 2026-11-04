import { Prisma } from "@prisma/client";

/**
 * 采购与仓储报表的**纯函数内核**（聚合、格式化、排序）。
 *
 * 为什么单独拆一个文件：取数（Prisma 查询）与版式（ExcelJS）是两件跟环境强耦合的事，
 * 而「五个数量怎么加、行怎么并、怎么排」是本表的业务口径 —— 把它抽成不碰数据库、
 * 不碰 Nest 的纯函数，测试就能直接钉住口径本身，而不是钉住某条 SQL 的形状。
 * 设计见 `docs/design/procurement-warehouse-report-2026-11-04.md` §1/§2。
 */

/**
 * 单次最多返回的行数（设计文档 §2）。
 *
 * 为什么是保护闸而不是分页：屏幕、打印、导出必须是**同一份数据**，一旦分页就会出现
 * 「屏幕 200 行、导出 5000 行」这种对不上账的情况。厂内一次看一张或几张订单是常态，
 * 超过 5000 行说明筛选条件没给对，应当让人先缩小范围（返回 422 + 提示），
 * 而不是悄悄截断 —— 一张少了几行的采购对账表比报错危险得多。
 */
export const PROCUREMENT_WAREHOUSE_ROW_LIMIT = 5000;

/**
 * 「已下单」的采购单状态 —— 与 `purchase-orders.service.ts` 的 `ORDERED_PURCHASE_STATUSES` 同一口径。
 *
 * 为什么草稿与已取消不算：草稿不是下单承诺（还在改数量/价格），已取消的单更不是；
 * 把它们加进「采购数量」会让「采购未入库数」凭空变大，看起来像供应商欠货。
 * 这三点是设计文档 §8 里用户明确要确认的第一条，当前口径：不计。
 */
export const EFFECTIVE_PURCHASE_ORDER_STATUSES = ["ordered", "partially_arrived", "arrived_complete"] as const;

/** 原料仓 + 报废仓 —— 与 `GET /inventory/raw-material-balances` 完全同一组库存类别。 */
export const RAW_MATERIAL_STOCK_CATEGORIES = ["raw_material", "scrap"] as const;

/**
 * 算「生产领用数量」的库存事实来源类型（设计文档 §1 第 4 列）。
 *
 * 为什么是这五个、而不是「原料仓里所有为负的事实」：
 *   1. `material_issue`（领料）与 `material_replenishment`（补料）是负数量，算领用；
 *   2. `material_return`（退料）是正数量，抵减领用；
 *   3. `material_movement_reversal`（冲销）写的是被冲销事实的等额反向数，
 *      `material_movement_reopen`（撤销过账/重新打开）再反向一次 —— 两者都算进来，
 *      领用数才是「过账后的净额」；
 *   4. **`material_scrap`（报废）刻意不在这个清单里**：报废不是生产用掉了，它在库存量那一列
 *      体现为减少（报废仓也是库存类别之一）。把它算进领用会让「损耗率」与「领用」两件事
 *      混成一个数（设计文档 §8「报废是否算领用：不算」）。
 *
 * 另一个必须同时成立的条件是 `raw_material_movement_line_id is not null`：只有原料移动单据
 * 明细产生的事实才归这个报表；盘点调整、成品出/入库等事实没有这个外键，不该混进来。
 */
export const PRODUCTION_ISSUE_SOURCE_TYPES = [
  "material_issue",
  "material_replenishment",
  "material_return",
  "material_movement_reversal",
  "material_movement_reopen"
] as const;

/** 报表的两个模糊筛选（都是可选；空/空白串按「未筛选」处理）。 */
export type ProcurementWarehouseFilter = { order_no?: string; material?: string };

/**
 * 报表的一行：**一张订单上的一个物料 + 单位**。
 *
 * 数量列一律是「去掉无意义尾零的十进制字符串」：既有报表接口也把 Decimal 转字符串输出，
 * 前端不碰浮点；xlsx 导出内部再把字符串转成数值写单元格（见导出服务）。
 * `color` 为空时给空串（屏幕/打印上显示 `-` 是前端的展示规则，不往接口里塞展示符）。
 */
export type ProcurementWarehouseRow = {
  order_no: string;
  material_name: string;
  color: string;
  unit: string;
  purchase_quantity: string;
  inbound_quantity: string;
  pending_inbound_quantity: string;
  production_issue_quantity: string;
  stock_quantity: string;
};

/** 行键：订单号 × 物料 × 单位（单位不换算，同一物料两个单位就是两行，见设计文档 §1 规则 1）。 */
export type ReportRowKey = { orderNo: string; materialId: string; unitId: string };

/** 已经按行键在数据库侧聚合好的一笔数量（`groupBy` 的 `_sum` 结果 + 行键）。 */
export type AggregatedQuantity = ReportRowKey & { quantity: Prisma.Decimal };

/** 库存量：**物料 + 单位**级的当前结存，不带订单号（库存是物料级静态结存，不按订单拆账）。 */
export type StockQuantity = { materialId: string; unitId: string; quantity: Prisma.Decimal };

/** 组装报表行需要的全部来源（由取数服务提供，本模块不做任何查询）。 */
export type ReportSources = {
  /** 已下单采购明细的 `quantity` 合计。 */
  purchase: readonly AggregatedQuantity[];
  /** 已过账原料入库单的 `quantity` 合计。 */
  inbound: readonly AggregatedQuantity[];
  /**
   * 生产领用相关事实的 `quantity_delta` **原样合计**（领料/补料为负、退料/冲销为正）。
   * 本模块取负号输出 —— 让「原样求和」这件事只发生在数据库的 SUM 里，不在 JS 里逐笔判方向。
   */
  issue: readonly AggregatedQuantity[];
  /** 库存量（原料仓 + 报废仓的当前结存）。 */
  stock: readonly StockQuantity[];
  /** 物料主数据（名称 + 颜色），只用于展示列，不参与聚合。 */
  materials: ReadonlyMap<string, { name: string; color: string }>;
  /** 单位主数据（单位名），只用于展示列。 */
  units: ReadonlyMap<string, string>;
};

/** 行键分隔符：UUID / 订单号里不可能出现 NUL，用它拼键不会被值里的字符碰巧串行。 */
const KEY_SEPARATOR = "\u0000";
const rowKey = (orderNo: string, materialId: string, unitId: string): string => `${orderNo}${KEY_SEPARATOR}${materialId}${KEY_SEPARATOR}${unitId}`;
const stockKey = (materialId: string, unitId: string): string => `${materialId}${KEY_SEPARATOR}${unitId}`;

/**
 * 数量 → 去掉无意义尾零的十进制字符串。
 *
 * 为什么不能直接把 Decimal 的 `toString()` 丢出去：库里是 `DECIMAL(18,4)`，Prisma 读出来是
 * 「4700.0000」这种带四位小数的值，直接输出屏幕上是 `4700.0000`、xlsx 里是 4700.00 —— 
 * 工厂单据上没人这么写数量。而前端若自己 `Number()` 再格式化，又会在跨单位/大数量时
 * 引入浮点误差（本表刻意不换算单位）。
 *
 * 为什么 `-0` 要归一成 `0`：`采购未入库数 = 采购 − 入库`，两边相等时 Decimal 可能给出负零，
 * 输出成 `-0` 会让用户以为「欠了 0 个」；任何负数标红的界面规则也会把 `-0` 误判成异常。
 */
export function formatQuantity(value: Prisma.Decimal | string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "0";
  let decimal: Prisma.Decimal;
  try {
    decimal = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  } catch {
    // 非数字输入（脏数据）按 0 处理：报表宁可口径保守，也不该整张表 500。
    return "0";
  }
  if (!decimal.isFinite() || decimal.isZero()) return "0";
  // 列是 DECIMAL(18,4)，toFixed(4) 不丢精度也永远不会退化成指数记法（大数用 toString 会变 1e+21）。
  const fixed = decimal.toFixed(4);
  const trimmed = fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  return trimmed === "-0" ? "0" : trimmed;
}

const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const stripLeadingZeros = (digits: string): string => digits.replace(/^0+(?=\d)/, "");

/** 把字符串切成「数字段 / 非数字段」交替的序列：`PO-260119` → `["PO-", "260119"]`。 */
const tokenize = (value: string): string[] => value.match(/(\d+|\D+)/g) ?? [];

/**
 * 自然（数字感知）比较：数字段按**数值**比，其余按码位比。
 *
 * 为什么不能用字符串比较：`260119` 与 `26012` 在字典序里是 `26012` 大（第 5 位 `'1' < '2'`），
 * 但订单号是流水编号，260119 明显晚于 26012 —— 报表按字符串倒序会把老单排在最前面，
 * 用户看到的「最新一张」是错的（设计文档 §2「排序：订单号倒序（数字感知）」）。
 *
 * 数字段先去掉前导零、再按「长度 → 逐位」比，不用 `Number()`：订单号可能长到超过 2^53，
 * 转浮点会丢精度、甚至把两个不同的单号判成相等。
 */
function naturalCompare(left: string, right: string): number {
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  const shared = Math.min(leftTokens.length, rightTokens.length);
  for (let index = 0; index < shared; index += 1) {
    const leftToken = leftTokens[index];
    const rightToken = rightTokens[index];
    const leftIsNumber = /^\d+$/.test(leftToken);
    const rightIsNumber = /^\d+$/.test(rightToken);
    if (leftIsNumber && rightIsNumber) {
      const leftDigits = stripLeadingZeros(leftToken);
      const rightDigits = stripLeadingZeros(rightToken);
      if (leftDigits.length !== rightDigits.length) return leftDigits.length - rightDigits.length;
      if (leftDigits !== rightDigits) return leftDigits < rightDigits ? -1 : 1;
      continue;
    }
    const compared = byCodeUnit(leftToken, rightToken);
    if (compared) return compared;
  }
  return leftTokens.length - rightTokens.length;
}

/** 订单号**倒序**（数字感知）。导出给单测钉排序规则。 */
export function compareOrderNoDesc(left: string, right: string): number {
  return naturalCompare(right, left);
}

/** 组装过程中的一行（数量还保留 Decimal，方便精确相加与判零）。 */
type RowCell = {
  orderNo: string;
  materialId: string;
  unitId: string;
  materialName: string;
  color: string;
  unitName: string;
  purchase: Prisma.Decimal;
  inbound: Prisma.Decimal;
  /** 生产领用来源事实的 `quantity_delta` 合计（原样，负数为领用）。 */
  issueDelta: Prisma.Decimal;
};

/**
 * 行集合 = 三类来源（已下单采购明细 / 已过账原料入库 / 生产领用事实）的并集，
 * 再过掉「五个数量全为 0」的行，最后按设计文档 §2 排序。
 *
 * 为什么行集合不从 BOM 需求出发：本表要回答「买了多少、回来多少、用了多少、还有多少」，
 * 只有采购计划/BOM 需求、还没下采购单的物料不出行 —— 那是另一张表（采购计划）的事实，
 * 混进来会让「采购数量」这一列同时表达「已下单」和「想要」，两个含义互相污染。
 *
 * 库存量**不参与建行**：它是物料级静态结存，只给已有的行填数；否则库里所有有库存的物料
 * 都会长出一行，报表就不再是「订单 × 物料」的对照表了。
 */
export function buildProcurementWarehouseRows(sources: ReportSources): ProcurementWarehouseRow[] {
  const cells = new Map<string, RowCell>();
  const cellOf = (orderNo: string, materialId: string, unitId: string): RowCell => {
    const key = rowKey(orderNo, materialId, unitId);
    const current = cells.get(key);
    if (current) return current;
    const material = sources.materials.get(materialId);
    const cell: RowCell = {
      orderNo,
      materialId,
      unitId,
      // 主数据查不到（理论上 FK 保证存在）时留空串而不是丢行：丢行等于**悄悄少一行账**。
      materialName: material?.name ?? "",
      color: material?.color ?? "",
      unitName: sources.units.get(unitId) ?? "",
      purchase: new Prisma.Decimal(0),
      inbound: new Prisma.Decimal(0),
      issueDelta: new Prisma.Decimal(0)
    };
    cells.set(key, cell);
    return cell;
  };

  for (const row of sources.purchase) {
    const cell = cellOf(row.orderNo, row.materialId, row.unitId);
    cell.purchase = cell.purchase.plus(row.quantity);
  }
  for (const row of sources.inbound) {
    const cell = cellOf(row.orderNo, row.materialId, row.unitId);
    cell.inbound = cell.inbound.plus(row.quantity);
  }
  for (const row of sources.issue) {
    const cell = cellOf(row.orderNo, row.materialId, row.unitId);
    cell.issueDelta = cell.issueDelta.plus(row.quantity);
  }

  const stockByKey = new Map<string, Prisma.Decimal>();
  for (const row of sources.stock) {
    const key = stockKey(row.materialId, row.unitId);
    const current = stockByKey.get(key);
    stockByKey.set(key, current ? current.plus(row.quantity) : row.quantity);
  }

  const rows = [...cells.values()]
    .map((cell) => {
      // 采购未入库数 = 采购数量 − 采购入库量；**允许为负**（2026-11-04 起允许超收，
      // 多送的按实收入库，负数就是超收量，界面会标红）。
      const pending = cell.purchase.minus(cell.inbound);
      // 领用数 = −（领料 + 补料 − 退料 ± 冲销/撤销过账的净额）。
      const productionIssue = cell.issueDelta.negated();
      // 库存量按「物料 + 单位」取当前结存：同一物料出现在多张订单时每行都是同一个数
      // （仓库模块 §2/§5：库存是物料级静态结存，不按订单拆账）。
      const stock = stockByKey.get(stockKey(cell.materialId, cell.unitId)) ?? new Prisma.Decimal(0);
      return { cell, pending, productionIssue, stock };
    })
    .filter(({ cell, pending, productionIssue, stock }) => {
      // 五个数量全为 0 的行不出：它通常来自「领料后又冲销干净」这类净额为 0 的历史，
      // 留在表里只会让人以为这张订单还有物料在流转。
      return !(cell.purchase.isZero() && cell.inbound.isZero() && pending.isZero() && productionIssue.isZero() && stock.isZero());
    })
    .sort((left, right) => (
      // 订单号倒序（数字感知）→ 同订单内物料名称升序 → 单位升序。
      // 一级之外的比较按**码位**比、不用 localeCompare：localeCompare 受运行环境 ICU 影响，
      // 同一份数据换台机器导出顺序会变（本仓库先例见 `reorder.domain.ts` 的 byCodeUnit）。
      compareOrderNoDesc(left.cell.orderNo, right.cell.orderNo)
      || byCodeUnit(left.cell.materialName, right.cell.materialName)
      || byCodeUnit(left.cell.unitName, right.cell.unitName)
      // 末两级只是让顺序稳定（名称+颜色+单位可能相同而物料不同），不改变业务含义。
      || byCodeUnit(left.cell.color, right.cell.color)
      || byCodeUnit(left.cell.materialId, right.cell.materialId)
    ))
    .map(({ cell, pending, productionIssue, stock }): ProcurementWarehouseRow => ({
      order_no: cell.orderNo,
      material_name: cell.materialName,
      color: cell.color,
      unit: cell.unitName,
      purchase_quantity: formatQuantity(cell.purchase),
      inbound_quantity: formatQuantity(cell.inbound),
      pending_inbound_quantity: formatQuantity(pending),
      production_issue_quantity: formatQuantity(productionIssue),
      stock_quantity: formatQuantity(stock)
    }));

  return rows;
}

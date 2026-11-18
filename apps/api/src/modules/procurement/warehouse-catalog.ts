/**
 * 原料收货仓库档案（2026-11-18，工单 T-0018）。
 *
 * 背景：公司采购回来的原料会送到同安仓、晋江仓、大田仓三个地点；原系统只有同安仓，
 * 晋江仓、大田仓在系统里没有可选值。本次先补齐三份收货地点档案，供采购「登记到货」时选择。
 *
 * 为什么先放在代码里，而不是新建 `warehouses` 表：
 *   本工单明确禁止新增/修改 `prisma/migrations`，而新增表必须配套迁移；仓库档案目前只是
 *   「到货批次上的一个固定分类」，到货事实存在 `purchase_receipts.extension_data` 里（JSON），
 *   不新增列也能保证历史数据、并发与幂等键逻辑不变。等需要管理员增删仓库时，再单独建主数据表
 *   与迁移（属于需要人工处理的后续项）。
 *
 * 编码一旦写进历史到货单就不再改变：`tongan` / `jinjiang` / `daitan` 是给机器与搜索用的稳定键，
 * 中文名只用于展示。新增仓库时**追加**，不要修改已有编码或名称。
 */
export type Warehouse = { code: string; name: string };

export const WAREHOUSE_CATALOG: ReadonlyArray<Warehouse> = [
  { code: "tongan", name: "同安仓" },
  { code: "jinjiang", name: "晋江仓" },
  { code: "daitan", name: "大田仓" },
];

/**
 * 历史到货单没有入库地点。系统此前实际只维护同安仓，因此缺省值取同安仓：
 * 老单展示、老客户端不传 `warehouse_code` 时都不会变成「未知地点」，也不会因为新增必填而失败。
 */
export const DEFAULT_WAREHOUSE_CODE = "tongan";

export function warehouseByCode(code: string | null | undefined): Warehouse | undefined {
  const key = (code ?? "").trim();
  return key ? WAREHOUSE_CATALOG.find((warehouse) => warehouse.code === key) : undefined;
}

/**
 * 把 `purchase_receipts.extension_data` 解析成展示用仓库。
 *
 * - 有合法 `warehouse_code`：以目录里的名称为准（目录改名后老单跟着新名称走，编码不变）；
 * - 只有旧客户端写的 `warehouse_name` 或未知编码：原样展示，不丢事实、不冒充同安仓；
 * - 完全没有：按历史口径回落同安仓。
 */
export function warehouseOf(extensionData: unknown): Warehouse {
  const data = extensionData && typeof extensionData === "object" ? (extensionData as Record<string, unknown>) : {};
  const rawCode = typeof data.warehouse_code === "string" ? data.warehouse_code.trim() : "";
  if (!rawCode) return { code: DEFAULT_WAREHOUSE_CODE, name: warehouseByCode(DEFAULT_WAREHOUSE_CODE)!.name };
  const known = warehouseByCode(rawCode);
  if (known) return known;
  const rawName = typeof data.warehouse_name === "string" ? data.warehouse_name.trim() : "";
  return { code: rawCode, name: rawName || rawCode };
}

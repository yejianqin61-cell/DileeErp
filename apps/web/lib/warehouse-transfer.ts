// 跨仓库调拨（T-0028）的前端口径。
//
// 源仓库固定同安仓；目标仓只能是大田仓 / 晋江仓；调拨目的固定「供目标仓库生产使用」。
// 这些值必须与后端 `apps/api/src/modules/warehouse/warehouse-transfer.domain.ts` 一致：
// 后端是最终门禁，本文件只负责把同样的选项/文案给页面，避免两处各写一份中文名。
//
// 本文件刻意不 import `warehouse-catalogue.ts`：这里要能被 `node --test` 直接 import 做纯函数
// 单测，而 Node 的类型擦除不做无扩展名解析。三仓名称是稳定文案，重复三行比让测试依赖打包器更划算。

export const WAREHOUSE_TRANSFER_SOURCE = "tongan";
export const WAREHOUSE_TRANSFER_SOURCE_LABEL = "同安仓";
export const WAREHOUSE_TRANSFER_TARGET_CODES = ["daitan", "jinjiang"] as const;
export const WAREHOUSE_TRANSFER_PURPOSE = "target_production";
export const WAREHOUSE_TRANSFER_PURPOSE_LABEL = "供目标仓库生产使用";
/** 与后端 WAREHOUSE_TRANSFER_MAX_LINES 一致。 */
export const WAREHOUSE_TRANSFER_MAX_LINES = 100;

const WAREHOUSE_NAMES: Readonly<Record<string, string>> = { tongan: "同安仓", daitan: "大田仓", jinjiang: "晋江仓" };
const nameOf = (code: string) => WAREHOUSE_NAMES[code] ?? code;

export type WarehouseTransferTargetOption = { value: string; label: string };

/** 目标仓下拉：只给大田/晋江，顺序固定。 */
export const WAREHOUSE_TRANSFER_TARGET_OPTIONS: ReadonlyArray<WarehouseTransferTargetOption> = WAREHOUSE_TRANSFER_TARGET_CODES.map((code) => ({ value: code, label: nameOf(code) }));

export function warehouseTransferTargetLabel(code: string | null | undefined): string {
  const key = (code ?? "").trim();
  return key ? nameOf(key) : "";
}

/** 与 parseQuantity 同一条边界：大于零、最多 4 位小数的十进制字符串。 */
export function isPositiveTransferQuantity(value: string | null | undefined): boolean {
  const text = (value ?? "").trim();
  return /^\d+(?:\.\d{1,4})?$/.test(text) && Number(text) > 0;
}

/** 明细摘要：`物料名 × 数量单位`，多条用「、」连接；与全站物料明细列同一写法的简化版。 */
export function transferLineSummary(lines: ReadonlyArray<{ material_name?: string | null; material_code?: string | null; quantity: string; unit_name?: string | null }>): string {
  return lines
    .map((line) => `${line.material_name ?? line.material_code ?? "物料"} × ${line.quantity}${line.unit_name ?? ""}`)
    .join("、") || "-";
}

// 领料单（issue，MI-）与补料单（replenishment，MC-）共用同一套原料出库接口，
// 只有「创建」和「过账」两条路径按单据类型分叉。集中在这里，避免某个页面漏判类型：
// 服务端 postIssue() 对补料单会直接 422（该单据不是领料单），漏判就是「点过账就报错」。
import type { SessionProfile } from "./session";

export type MaterialMovementDocumentType = "issue" | "replenishment";

/** 跨订单库存检索的一行（后端 `GET /production/material-movements/cross-order-stock`）。 */
export type CrossOrderStockItem = {
  material_id: string;
  material_code: string;
  material_name: string;
  specification_model?: string | null;
  color?: string | null;
  unit_id: string;
  unit_name: string;
  supplier_id?: string | null;
  supplier_name?: string | null;
  source_production_order_id: string;
  source_production_order_no: string;
  source_order_no: string;
  source_available_quantity: string;
  inventory_quantity: string;
};

/**
 * 跨订单调料权限：除生产外必须有仓库模块。
 *
 * 与后端 `role_permissions` 同口径：这里只决定「显不显示入口」，真正的拒绝在服务端。
 * 档案未加载（null）时按无权限处理，避免权限快照缺失时把入口闪给所有人。
 */
export function canCrossOrderIssue(profile: Pick<SessionProfile, "module_keys"> | null | undefined): boolean {
  return Boolean(profile?.module_keys?.includes("warehouse"));
}

export function crossOrderStockPath(productionOrderId: string, keyword: string): string {
  const params = new URLSearchParams();
  if (productionOrderId) params.set("production_order_id", productionOrderId);
  if (keyword.trim()) params.set("keyword", keyword.trim());
  const query = params.toString();
  return `/production/material-movements/cross-order-stock${query ? `?${query}` : ""}`;
}

/** 下拉文案：物料名 / 规格 / 来源生产单 / 来源可用量。 */
export function crossOrderStockLabel(item: CrossOrderStockItem): string {
  const spec = item.specification_model ? ` / ${item.specification_model}` : "";
  const supplier = item.supplier_name ? ` / ${item.supplier_name}` : "";
  return `${item.material_name}${spec} / 来源 ${item.source_production_order_no}（${item.source_order_no}）/ 可用 ${item.source_available_quantity}${item.unit_name}${supplier}`;
}

export const materialMovementDocumentTypes: MaterialMovementDocumentType[] = ["issue", "replenishment"];

export function isMaterialMovementDocumentType(value: string | null | undefined): value is MaterialMovementDocumentType {
  return typeof value === "string" && (materialMovementDocumentTypes as string[]).includes(value);
}

/** 创建：领料单 POST /production/material-movements；补料单 POST /production/material-movements/replenishments。 */
export function createMovementPath(documentType: string | null | undefined): string {
  return documentType === "replenishment" ? "/production/material-movements/replenishments" : "/production/material-movements";
}

/** 过账：领料单 .../post；补料单 .../post-replenishment（类型走错服务端返回 422）。 */
export function postMovementPath(documentType: string | null | undefined, id: string): string {
  return `/production/material-movements/${id}/${documentType === "replenishment" ? "post-replenishment" : "post"}`;
}

/** 全屏编辑页链接：默认新建领料单；带 movementId 表示继续编辑草稿，带 productionOrderId 表示续开。 */
export function movementEditorHref(
  documentType: string | null | undefined,
  options: { movementId?: string; productionOrderId?: string } = {},
): string {
  const params = new URLSearchParams();
  if (documentType === "replenishment") params.set("type", "replenishment");
  if (options.movementId) params.set("movement_id", options.movementId);
  if (options.productionOrderId) params.set("production_order_id", options.productionOrderId);
  const query = params.toString();
  return `/production/material-issues/new${query ? `?${query}` : ""}`;
}

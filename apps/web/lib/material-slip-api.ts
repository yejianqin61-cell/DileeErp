// 领料单（issue，MI-）与补料单（replenishment，MC-）共用同一套原料出库接口，
// 只有「创建」和「过账」两条路径按单据类型分叉。集中在这里，避免某个页面漏判类型：
// 服务端 postIssue() 对补料单会直接 422（该单据不是领料单），漏判就是「点过账就报错」。
export type MaterialMovementDocumentType = "issue" | "replenishment";

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

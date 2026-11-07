/**
 * 领料单 / 补料单「打印」的口径（纯函数，无 React / 无网络依赖，`node --test` 覆盖）。
 *
 * 用户 2026-11-02：「系统中的出库单要支持导出 excel，支持打印」—— 原料侧的出库单据就是领料单 / 补料单，
 * 它们**已经有导出**（`production/reports/material-issue.xlsx`），这一轮补的是**打印**。
 *
 * 打印件的版式必须与 `docs/samples/领料单-样例.xlsx`（以及服务端导出的 xlsx）逐行一致：
 * 标题、三行表头、明细列、小计、备注。仓库拿纸跟车间对料，纸与 Excel 对不上就白做了。
 */
import type { SlipDocumentLine } from "../components/production/material-slip-lines-table";

/** 打印件用的完整单据（比列表里那份多表头字段：`GET /production/material-movements/:id/slip-document` 会给全）。 */
export type MaterialSlipPrintDocument = {
  movementNo: string;
  status: string;
  productionOrderNo: string;
  orderNo: string;
  productName: string;
  productCode: string;
  productSpecification: string;
  productColor: string;
  operationName: string;
  issueUnit: string;
  plannedQuantity: number;
  unitName: string;
  operatorName: string;
  operatedAt: string;
  remark: string;
  reason?: string;
  lines: SlipDocumentLine[];
};

export type MaterialSlipPrint = { document_type: "issue" | "replenishment"; document: MaterialSlipPrintDocument };

const STATUS_SUFFIX: Record<string, string> = { draft: "（草稿）", pending_outbound: "（待仓库出库）", reversed: "（已冲销）" };

/**
 * 纸头标题：**草稿 / 待仓库出库 / 已冲销写进标题**（与导出的 xlsx 同一条口径）。
 *
 * 一张草稿领料单被车间当成已经领到料，会直接去下料 —— 而库存还没扣。所以状态必须印在纸头上。
 */
export function materialSlipPrintHeading(slip: Pick<MaterialSlipPrint, "document_type" | "document">): string {
  const base = slip.document_type === "replenishment" ? "【补料单】" : "【领料单】";
  return `${base}${STATUS_SUFFIX[slip.document.status] ?? ""}`;
}

/** 明细列（与样例 xlsx / 导出件同一组名字；领料单多四个数量列，补料单只有一个补领数量 + 一个图片列）。 */
export type MaterialSlipPrintColumn = { key: string; label: string; numeric?: boolean };

export function materialSlipPrintColumns(kind: "issue" | "replenishment"): MaterialSlipPrintColumn[] {
  const base: MaterialSlipPrintColumn[] = [
    { key: "sequence", label: "序号" },
    { key: "materialName", label: "产品名称" },
    { key: "materialCode", label: "产品代码" },
    { key: "specificationModel", label: "规格型号" },
    { key: "color", label: "颜色" },
    { key: "unit", label: "单位" },
  ];
  if (kind === "replenishment") {
    // 补料单纸样第 2 列是「图片」：系统里没有补料单图片数据源，留空格供手贴（与导出件一致）。
    return [base[0], { key: "image", label: "图片" }, ...base.slice(1), { key: "replenishQuantity", label: "补领数量", numeric: true }];
  }
  return [...base,
    { key: "bomQuantity", label: "配料数量", numeric: true },
    { key: "issuedQuantity", label: "已领数量", numeric: true },
    { key: "currentQuantity", label: "本次领料量", numeric: true },
    { key: "remainingQuantity", label: "余下数量", numeric: true }];
}

/** 小计：领料单合计「本次领料量」，补料单合计「补领数量」（与导出件的小计行同口径）。 */
export function materialSlipPrintSubtotal(kind: "issue" | "replenishment", lines: SlipDocumentLine[]): number {
  return lines.reduce((sum, line) => sum + Number((kind === "replenishment" ? line.replenishQuantity : line.currentQuantity) ?? 0), 0);
}

/**
 * 表头三行 ×（标签 / 值）：顺序照样例 xlsx（补料单第 2 行是「领料单位」在前、「领料工序」在后）。
 *
 * 2026-11-07：纸头第 3 行补「订单号」（用户：「采购板块，领料单的导出件也要有订单号」）。
 * 位置与导出 xlsx 严格一致（模板第 3 行第 4 组本来就是预留空格）：
 *   - 领料单：生产数量 / 操作人 / 操作时间 / **订单号**；
 *   - 补料单：操作人 / 操作时间 / **订单号** / 补料原因（补料原因不挪位置）。
 * 打印件与导出件是同一份单据，两边格子对不上，仓库与车间对料时就会各说各话。
 */
export function materialSlipHeadRows(slip: MaterialSlipPrint): Array<Array<[string, string]>> {
  const doc = slip.document;
  const first: Array<[string, string]> = [["生产单号：", doc.productionOrderNo], ["成品名称：", doc.productName], ["成品代码：", doc.productCode], ["规格型号：", doc.productSpecification]];
  if (slip.document_type === "replenishment") {
    return [
      first,
      [["颜色：", doc.productColor], ["领料单号：", doc.movementNo], ["领料单位：", doc.issueUnit], ["领料工序：", doc.operationName]],
      [["操作人：", doc.operatorName], ["操作时间：", doc.operatedAt], ["订单号：", doc.orderNo], ["补料原因：", doc.reason ?? ""]],
    ];
  }
  return [
    first,
    [["颜色：", doc.productColor], ["领料单号：", doc.movementNo], ["领料工序：", doc.operationName], ["领料单位：", doc.issueUnit]],
    [["生产数量：", `${doc.plannedQuantity}${doc.unitName ? ` ${doc.unitName}` : ""}`], ["操作人：", doc.operatorName], ["操作时间：", doc.operatedAt], ["订单号：", doc.orderNo]],
  ];
}

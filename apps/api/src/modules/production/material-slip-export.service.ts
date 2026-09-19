import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as ExcelJS from "exceljs";
import { PrismaService } from "../../platform/database/prisma.service";
import { AuditActorService } from "../../platform/audit/audit-actor.service";
import { beijingDateTime } from "../../platform/time/beijing-time";

/** 领料单（打印表）明细行。 */
export type MaterialIssueDocumentLine = {
  sequence: number;
  materialName: string;
  materialCode: string;
  specificationModel: string;
  color: string;
  unit: string;
  /** 配料数量 = BOM 核定用量（无则退回需求量）；非 BOM 物料退回领料时的快照值，仍为空则留空。 */
  bomQuantity: number | null;
  /** 已领数量 = 本单之前该生产单+物料已过账的净领料（不含本单）。 */
  issuedQuantity: number;
  /** 本次领料量。 */
  currentQuantity: number;
  /** 余下数量 = 配料数量 − 已领数量 − 本次领料量（可为负，表示超领）。 */
  remainingQuantity: number | null;
};

/** 一张领料单的打印数据；字段与用户提供的 Excel 模板一一对应。 */
export type MaterialIssueDocument = {
  movementNo: string;
  status: string;
  productionOrderNo: string;
  orderNo: string;
  productName: string;
  /** 系统当前没有成品编码，按确认口径留空。 */
  productCode: string;
  productSpecification: string;
  /** 系统当前没有成品颜色，按确认口径留空。 */
  productColor: string;
  operationName: string;
  /** 领料单位 = 生产单执行地点（车间）。 */
  issueUnit: string;
  plannedQuantity: number;
  unitName: string;
  operatorName: string;
  operatedAt: string;
  remark: string;
  lines: MaterialIssueDocumentLine[];
};

export type MaterialIssueFilter = { orderNo?: string; productionOrderId?: string; productionOrderOperationId?: string; from?: string; to?: string; status?: string; documentType?: string };

/** 补料单（打印表）明细行：只有补领数量，并预留图片列。 */
export type MaterialReplenishmentDocumentLine = {
  sequence: number;
  /** 图片列当前无数据源（系统未维护物料图片），保留空列供打印后手贴/手写。 */
  imageUrl: string;
  materialName: string;
  materialCode: string;
  specificationModel: string;
  color: string;
  unit: string;
  /** 补领数量。 */
  replenishQuantity: number;
};

/** 一张补料单的打印数据；字段与用户提供的补料单模板一一对应。 */
export type MaterialReplenishmentDocument = {
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
  operatorName: string;
  operatedAt: string;
  /** 补料原因（坏片/生产失误等），模板第 3 行第 4 格。 */
  reason: string;
  remark: string;
  lines: MaterialReplenishmentDocumentLine[];
};

const EMPTY_REPLENISHMENT: MaterialReplenishmentDocument = { movementNo: "", status: "draft", productionOrderNo: "", orderNo: "", productName: "", productCode: "", productSpecification: "", productColor: "", operationName: "", issueUnit: "", operatorName: "", operatedAt: "", reason: "", remark: "", lines: [] };

const EMPTY: MaterialIssueDocument = { movementNo: "", status: "draft", productionOrderNo: "", orderNo: "", productName: "", productCode: "", productSpecification: "", productColor: "", operationName: "", issueUnit: "", plannedQuantity: 0, unitName: "", operatorName: "", operatedAt: "", remark: "", lines: [] };

const COLUMN_WIDTHS = [6, 24, 16, 18, 10, 8, 12, 12, 12, 12];
const BODY_FONT = { name: "宋体", size: 11 } as const;
const HEADER_FONT = { name: "宋体", size: 11, bold: true } as const;
const THIN_BORDER: Partial<ExcelJS.Borders> = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };

const toNumber = (value: Prisma.Decimal | string | number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === "") return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

type ExportLine = {
  materialId: string;
  unitId: string;
  quantity: Prisma.Decimal;
  bomReferenceQuantity: Prisma.Decimal | null;
  material: { name: string; materialCode: string; specificationModel: string | null; color: string | null };
  unit: { name: string };
};

type ExportMovement = {
  movementNo: string;
  status: string;
  productionOrderId: string;
  createdBy: string;
  createdAt: Date;
  reason: string | null;
  remark: string | null;
  productionOrder: {
    productionOrderNo: string;
    orderNo: string;
    plannedQuantity: Prisma.Decimal;
    productSpecification: string | null;
    unit: { name: string };
    executionLocation: { name: string } | null;
    salesOrder: { productName: string; productSpec: string | null };
    bom: { items: Array<{ materialId: string; approvedUsage: Prisma.Decimal | null; requiredQuantity: Prisma.Decimal; specificationModel: string | null; model: string | null; color: string | null }> } | null;
  };
  productionOrderOperation: { operationNameSnapshot: string } | null;
  lines: ExportLine[];
};

@Injectable()
export class MaterialSlipExportService {
  constructor(private readonly prisma: PrismaService, private readonly actors: AuditActorService) {}

  /** 组装单张领料单的打印数据（导出与页面共用同一口径）。 */
  async buildDocument(movementId: string): Promise<MaterialIssueDocument> {
    const movement = await this.prisma.rawMaterialMovement.findFirst({ where: { id: movementId, deletedAt: null, documentType: "issue" }, include: this.include() });
    if (!movement) throw new NotFoundException({ code: "MATERIAL_ISSUE_NOT_FOUND", message: "领料单不存在", details: [] });
    return this.assemble(movement as unknown as ExportMovement, await this.actors.namesOf([movement.createdBy]));
  }

  /** 组装单张补料单的打印数据。 */
  async buildReplenishmentDocument(movementId: string): Promise<MaterialReplenishmentDocument> {
    const movement = await this.prisma.rawMaterialMovement.findFirst({ where: { id: movementId, deletedAt: null, documentType: "replenishment" }, include: this.include() });
    if (!movement) throw new NotFoundException({ code: "MATERIAL_REPLENISHMENT_NOT_FOUND", message: "补料单不存在", details: [] });
    return this.assembleReplenishment(movement as unknown as ExportMovement, await this.actors.namesOf([movement.createdBy]));
  }

  /** 按筛选条件批量组装物料单据（领料单/补料单，各自的版式）。 */
  async buildSlips(filter: MaterialIssueFilter): Promise<Array<{ documentType: "issue"; document: MaterialIssueDocument } | { documentType: "replenishment"; document: MaterialReplenishmentDocument }>> {
    const movements = await this.prisma.rawMaterialMovement.findMany({
      where: {
        deletedAt: null,
        documentType: filter.documentType ? filter.documentType : { in: ["issue", "replenishment"] },
        ...(filter.orderNo ? { orderNo: filter.orderNo } : {}),
        ...(filter.productionOrderId ? { productionOrderId: filter.productionOrderId } : {}),
        ...(filter.productionOrderOperationId ? { productionOrderOperationId: filter.productionOrderOperationId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.from || filter.to ? { businessDate: { ...(filter.from ? { gte: new Date(filter.from) } : {}), ...(filter.to ? { lte: new Date(filter.to) } : {}) } } : {})
      },
      include: this.include(),
      orderBy: [{ orderNo: "asc" }, { productionOrderId: "asc" }, { createdAt: "asc" }]
    });
    const slips: Array<{ documentType: "issue"; document: MaterialIssueDocument } | { documentType: "replenishment"; document: MaterialReplenishmentDocument }> = [];
    // 姓名**一次取完**：下面每张单据都要「操作人」，逐张查用户表会在导出上百张时打出上百次查询。
    const names = await this.actors.namesOf(movements.map((movement) => movement.createdBy));
    for (const movement of movements) {
      const typed = movement as unknown as ExportMovement;
      if (movement.documentType === "replenishment") slips.push({ documentType: "replenishment", document: await this.assembleReplenishment(typed, names) });
      else slips.push({ documentType: "issue", document: await this.assemble(typed, names) });
    }
    return slips;
  }

  /** 单张导出：一个工作表（按单据类型选择版式）。 */
  async exportSlip(movementId: string): Promise<Buffer> {
    const movement = await this.prisma.rawMaterialMovement.findFirst({ where: { id: movementId, deletedAt: null }, select: { documentType: true } });
    if (!movement) throw new NotFoundException({ code: "MATERIAL_SLIP_NOT_FOUND", message: "单据不存在", details: [] });
    const workbook = new ExcelJS.Workbook();
    if (movement.documentType === "replenishment") this.addReplenishmentSheet(workbook, await this.buildReplenishmentDocument(movementId));
    else this.addSheet(workbook, await this.buildDocument(movementId));
    return this.toBuffer(workbook);
  }

  /** 批量导出：每张单据一个工作表（表名=单号），领料/补料用各自的模板版式。 */
  async exportSlips(filter: MaterialIssueFilter): Promise<{ buffer: Buffer; count: number }> {
    const slips = await this.buildSlips(filter);
    const workbook = new ExcelJS.Workbook();
    for (const slip of slips) {
      if (slip.documentType === "replenishment") this.addReplenishmentSheet(workbook, slip.document);
      else this.addSheet(workbook, slip.document);
    }
    return { buffer: await this.toBuffer(workbook), count: slips.length };
  }

  private include() {
    return {
      productionOrder: { include: { executionLocation: true, unit: true, salesOrder: true, bom: { include: { items: { where: { deletedAt: null } } } } } },
      productionOrderOperation: { select: { operationNameSnapshot: true } },
      lines: { where: { deletedAt: null }, include: { material: true, unit: true }, orderBy: { createdAt: "asc" } }
    } as const;
  }

  private async assemble(movement: ExportMovement, names: Map<string, string>): Promise<MaterialIssueDocument> {
    const order = movement.productionOrder;
    const bomItems = new Map((order.bom?.items ?? []).map((item) => [item.materialId, item]));
    const lines: MaterialIssueDocumentLine[] = [];
    for (const [index, line] of movement.lines.entries()) {
      const bomItem = bomItems.get(line.materialId);
      const bomQuantity = toNumber(bomItem ? (bomItem.approvedUsage ?? bomItem.requiredQuantity) : line.bomReferenceQuantity);
      const current = toNumber(line.quantity) ?? 0;
      // 已领数量：净领料（领料−退料，原始物料类别）扣除本单自身 —— 只有已过账本单才会进入库存事实。
      const facts = await this.prisma.inventoryFact.aggregate({ where: { productionOrderId: movement.productionOrderId, materialId: line.materialId, unitId: line.unitId, inventoryCategory: "raw_material" }, _sum: { quantityDelta: true } });
      const netIssued = new Prisma.Decimal(facts._sum.quantityDelta ?? 0).negated();
      const issuedBefore = netIssued.minus(movement.status === "posted" ? line.quantity : new Prisma.Decimal(0));
      const issued = toNumber(issuedBefore) ?? 0;
      lines.push({
        sequence: index + 1,
        materialName: line.material.name,
        materialCode: line.material.materialCode,
        specificationModel: bomItem?.specificationModel ?? bomItem?.model ?? line.material.specificationModel ?? "",
        color: bomItem?.color ?? line.material.color ?? "",
        unit: line.unit.name,
        bomQuantity,
        issuedQuantity: issued,
        currentQuantity: current,
        remainingQuantity: bomQuantity === null ? null : Number((bomQuantity - issued - current).toFixed(4))
      });
    }
    return {
      ...EMPTY,
      movementNo: movement.movementNo,
      status: movement.status,
      productionOrderNo: order.productionOrderNo,
      orderNo: order.orderNo,
      productName: order.salesOrder?.productName ?? "",
      productSpecification: order.productSpecification ?? order.salesOrder?.productSpec ?? "",
      operationName: movement.productionOrderOperation?.operationNameSnapshot ?? "",
      issueUnit: order.executionLocation?.name ?? "",
      plannedQuantity: toNumber(order.plannedQuantity) ?? 0,
      unitName: order.unit?.name ?? "",
      operatorName: movement.createdBy ? names.get(movement.createdBy) ?? "" : "",
      operatedAt: beijingDateTime(movement.createdAt),
      remark: movement.remark ?? "",
      lines
    };
  }

  private async assembleReplenishment(movement: ExportMovement, names: Map<string, string>): Promise<MaterialReplenishmentDocument> {
    const order = movement.productionOrder;
    const bomItems = new Map((order.bom?.items ?? []).map((item) => [item.materialId, item]));
    const lines: MaterialReplenishmentDocumentLine[] = movement.lines.map((line, index) => {
      const bomItem = bomItems.get(line.materialId);
      return {
        sequence: index + 1,
        imageUrl: "",
        materialName: line.material.name,
        materialCode: line.material.materialCode,
        specificationModel: bomItem?.specificationModel ?? bomItem?.model ?? line.material.specificationModel ?? "",
        color: bomItem?.color ?? line.material.color ?? "",
        unit: line.unit.name,
        replenishQuantity: toNumber(line.quantity) ?? 0
      };
    });
    return {
      ...EMPTY_REPLENISHMENT,
      movementNo: movement.movementNo,
      status: movement.status,
      productionOrderNo: order.productionOrderNo,
      orderNo: order.orderNo,
      productName: order.salesOrder?.productName ?? "",
      productSpecification: order.productSpecification ?? order.salesOrder?.productSpec ?? "",
      operationName: movement.productionOrderOperation?.operationNameSnapshot ?? "",
      issueUnit: order.executionLocation?.name ?? "",
      operatorName: movement.createdBy ? names.get(movement.createdBy) ?? "" : "",
      operatedAt: beijingDateTime(movement.createdAt),
      reason: movement.reason ?? "",
      remark: movement.remark ?? "",
      lines
    };
  }

  /** 补料单版式：8 列（含预留「图片」列），表头第 2 行顺序为 颜色/领料单号/领料单位/领料工序，第 3 行第 4 格放补料原因。 */
  private addReplenishmentSheet(workbook: ExcelJS.Workbook, document: MaterialReplenishmentDocument) {
    const base = (document.movementNo || "补料单").slice(0, 28);
    let name = base;
    let suffix = 1;
    while (workbook.getWorksheet(name)) name = `${base}-${suffix++}`.slice(0, 31);
    const sheet = workbook.addWorksheet(name, {
      pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } }
    });
    // 8 列：序号、图片、产品名称、产品代码、规格型号、颜色、单位、补领数量
    sheet.columns = [6, 14, 24, 16, 18, 10, 8, 12].map((width) => ({ width }));
    sheet.headerFooter = { oddFooter: "&C第 &P 页 / 共 &N 页" };

    sheet.mergeCells("A2:H2");
    const titleCell = sheet.getCell("A2");
    titleCell.value = document.status === "posted" ? "【补料单】" : "【补料单】（草稿）";
    titleCell.font = { name: "宋体", size: 16, bold: true };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    sheet.getRow(2).height = 30;

    const headerRows: Array<Array<[string, string] | null>> = [
      [["生产单号：", document.productionOrderNo], ["成品名称：", document.productName], ["成品代码：", document.productCode], ["规格型号：", document.productSpecification]],
      // 注意：补料单模板第 2 行是「单位」在前、「工序」在后，与领料单相反，按模板原样保留。
      [["颜色：", document.productColor], ["领料单号：", document.movementNo], ["领料单位：", document.issueUnit], ["领料工序：", document.operationName]],
      [["操作人：", document.operatorName], ["操作时间：", document.operatedAt], null, ["补料原因：", document.reason]]
    ];
    const labelColumns = ["A", "C", "E", "G"] as const;
    headerRows.forEach((fields, rowIndex) => {
      const rowNumber = 5 + rowIndex;
      const row = sheet.getRow(rowNumber);
      fields.forEach((field, fieldIndex) => {
        if (!field) return;
        const labelCell = row.getCell(labelColumns[fieldIndex]);
        labelCell.value = field[0];
        labelCell.font = BODY_FONT;
        labelCell.alignment = { horizontal: "right", vertical: "middle" };
        const valueColumn = String.fromCharCode(labelColumns[fieldIndex].charCodeAt(0) + 1);
        const lastValueColumn = fieldIndex === 3 ? "H" : valueColumn;
        if (valueColumn !== lastValueColumn) sheet.mergeCells(`${valueColumn}${rowNumber}:${lastValueColumn}${rowNumber}`);
        const valueCell = sheet.getCell(`${valueColumn}${rowNumber}`);
        valueCell.value = field[1];
        valueCell.font = BODY_FONT;
        valueCell.alignment = { horizontal: "left", vertical: "middle" };
        valueCell.border = { bottom: { style: "thin" } };
      });
      row.height = 20;
    });

    const tableHeaderRow = 8;
    const headers = ["序号", "图片", "产品名称", "产品代码", "规格型号", "颜色", "单位", "补领数量"];
    const headerRow = sheet.getRow(tableHeaderRow);
    headers.forEach((label, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = label;
      cell.font = HEADER_FONT;
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = THIN_BORDER;
    });
    headerRow.height = 22;

    document.lines.forEach((line, index) => {
      const row = sheet.getRow(tableHeaderRow + 1 + index);
      const values: Array<string | number> = [line.sequence, line.imageUrl, line.materialName, line.materialCode, line.specificationModel, line.color, line.unit, line.replenishQuantity];
      values.forEach((value, columnIndex) => {
        const cell = row.getCell(columnIndex + 1);
        cell.value = value;
        cell.font = BODY_FONT;
        cell.alignment = { horizontal: columnIndex === 2 || columnIndex === 4 ? "left" : "center", vertical: "middle" };
        cell.border = THIN_BORDER;
        if (columnIndex === 7) cell.numFmt = "0.####";
      });
      // 图片列需要行高才能贴图/手写。
      row.height = 28;
    });

    const firstDataRow = tableHeaderRow + 1;
    const lastDataRow = tableHeaderRow + document.lines.length;
    const subtotalRow = sheet.getRow(lastDataRow + 1);
    const subtotalCell = subtotalRow.getCell(1);
    subtotalCell.value = "小计";
    subtotalCell.font = HEADER_FONT;
    subtotalCell.alignment = { horizontal: "center", vertical: "middle" };
    subtotalCell.border = THIN_BORDER;
    for (let column = 2; column <= 8; column += 1) {
      const cell = subtotalRow.getCell(column);
      cell.border = THIN_BORDER;
      cell.font = BODY_FONT;
      cell.alignment = { horizontal: "center", vertical: "middle" };
      if (column === 8) {
        cell.value = { formula: `SUM(H${firstDataRow}:H${lastDataRow})` };
        cell.numFmt = "0.####";
      }
    }
    subtotalRow.height = 20;
    if (document.remark) {
      const remarkRowNumber = lastDataRow + 2;
      sheet.mergeCells(`A${remarkRowNumber}:H${remarkRowNumber}`);
      const remarkCell = sheet.getCell(`A${remarkRowNumber}`);
      remarkCell.value = `备注：${document.remark}`;
      remarkCell.font = BODY_FONT;
      remarkCell.alignment = { horizontal: "left", vertical: "middle" };
    }
    return sheet;
  }

  private addSheet(workbook: ExcelJS.Workbook, document: MaterialIssueDocument) {
    const base = (document.movementNo || "领料单").slice(0, 28);
    let name = base;
    let suffix = 1;
    while (workbook.getWorksheet(name)) name = `${base}-${suffix++}`.slice(0, 31);
    const sheet = workbook.addWorksheet(name, {
      pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } }
    });
    sheet.columns = COLUMN_WIDTHS.map((width) => ({ width }));
    sheet.headerFooter = { oddFooter: "&C第 &P 页 / 共 &N 页" };

    // 标题：草稿单据直接在标题标注，避免把未过账数量当成正式领料。
    sheet.mergeCells("A1:J1");
    const titleCell = sheet.getCell("A1");
    titleCell.value = document.status === "posted" ? "【领料单】" : "【领料单】（草稿）";
    titleCell.font = { name: "宋体", size: 16, bold: true };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    sheet.getRow(1).height = 30;

    // 表头区：3 行 × 4 组「标签 + 填写格」，第 3 行第 4 组按模板留空。
    const headerRows: Array<Array<[string, string] | null>> = [
      [["生产单号：", document.productionOrderNo], ["成品名称：", document.productName], ["成品代码：", document.productCode], ["规格型号：", document.productSpecification]],
      [["颜色：", document.productColor], ["领料单号：", document.movementNo], ["领料工序：", document.operationName], ["领料单位：", document.issueUnit]],
      [["生产数量：", `${document.plannedQuantity}${document.unitName ? ` ${document.unitName}` : ""}`], ["操作人：", document.operatorName], ["操作时间：", document.operatedAt], null]
    ];
    const labelColumns = ["A", "C", "E", "G"] as const;
    headerRows.forEach((fields, rowIndex) => {
      const rowNumber = 3 + rowIndex;
      const row = sheet.getRow(rowNumber);
      fields.forEach((field, fieldIndex) => {
        if (!field) return;
        const labelCell = row.getCell(labelColumns[fieldIndex]);
        labelCell.value = field[0];
        labelCell.font = BODY_FONT;
        labelCell.alignment = { horizontal: "right", vertical: "middle" };
        const valueColumn = String.fromCharCode(labelColumns[fieldIndex].charCodeAt(0) + 1);
        const lastValueColumn = fieldIndex === 3 ? "J" : valueColumn;
        if (valueColumn !== lastValueColumn) sheet.mergeCells(`${valueColumn}${rowNumber}:${lastValueColumn}${rowNumber}`);
        const valueCell = sheet.getCell(`${valueColumn}${rowNumber}`);
        valueCell.value = field[1];
        valueCell.font = BODY_FONT;
        valueCell.alignment = { horizontal: "left", vertical: "middle" };
        valueCell.border = { bottom: { style: "thin" } };
      });
      row.height = 20;
    });

    const tableHeaderRow = 6;
    const headers = ["序号", "产品名称", "产品代码", "规格型号", "颜色", "单位", "配料数量", "已领数量", "本次领料量", "余下数量"];
    const headerRow = sheet.getRow(tableHeaderRow);
    headers.forEach((label, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = label;
      cell.font = HEADER_FONT;
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = THIN_BORDER;
    });
    headerRow.height = 22;

    document.lines.forEach((line, index) => {
      const row = sheet.getRow(tableHeaderRow + 1 + index);
      const values: Array<string | number | null> = [line.sequence, line.materialName, line.materialCode, line.specificationModel, line.color, line.unit, line.bomQuantity, line.issuedQuantity, line.currentQuantity, line.remainingQuantity];
      values.forEach((value, columnIndex) => {
        const cell = row.getCell(columnIndex + 1);
        cell.value = value;
        cell.font = BODY_FONT;
        cell.alignment = { horizontal: columnIndex === 1 || columnIndex === 3 ? "left" : "center", vertical: "middle" };
        cell.border = THIN_BORDER;
        if (columnIndex >= 6) cell.numFmt = "0.####";
      });
    });

    const firstDataRow = tableHeaderRow + 1;
    const lastDataRow = tableHeaderRow + document.lines.length;
    const subtotalRow = sheet.getRow(lastDataRow + 1);
    const subtotalCell = subtotalRow.getCell(1);
    subtotalCell.value = "小计";
    subtotalCell.font = HEADER_FONT;
    subtotalCell.alignment = { horizontal: "center", vertical: "middle" };
    subtotalCell.border = THIN_BORDER;
    for (let column = 2; column <= 10; column += 1) {
      const cell = subtotalRow.getCell(column);
      cell.border = THIN_BORDER;
      cell.font = BODY_FONT;
      cell.alignment = { horizontal: "center", vertical: "middle" };
      if (column >= 7) {
        cell.value = { formula: `SUM(${String.fromCharCode(64 + column)}${firstDataRow}:${String.fromCharCode(64 + column)}${lastDataRow})` };
        cell.numFmt = "0.####";
      }
    }
    subtotalRow.height = 20;
    if (document.remark) {
      const remarkRowNumber = lastDataRow + 2;
      sheet.mergeCells(`A${remarkRowNumber}:J${remarkRowNumber}`);
      const remarkCell = sheet.getCell(`A${remarkRowNumber}`);
      remarkCell.value = `备注：${document.remark}`;
      remarkCell.font = BODY_FONT;
      remarkCell.alignment = { horizontal: "left", vertical: "middle" };
    }
    return sheet;
  }

  private async toBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
    const data = await workbook.xlsx.writeBuffer();
    return Buffer.from(data);
  }
}

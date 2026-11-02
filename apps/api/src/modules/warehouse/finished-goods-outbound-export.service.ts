import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as ExcelJS from "exceljs";
import { AuditActorService } from "../../platform/audit/audit-actor.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { beijingDate, beijingDateTime } from "../../platform/time/beijing-time";

/**
 * 成品出库单的**打印件数据**（用户 2026-11-02：「针对系统中的出库单，要支持导出 excel，支持打印」）。
 *
 * 一条原则：**导出件与打印件是同一份数据**。所以这里只做一次组装（`toDocument`），
 * xlsx 渲染与页面打印视图都吃它 —— 两份各拼一次，迟早出现「纸上有、屏幕上少一行」，
 * 而仓库是拿着这张纸跟司机/客户点货的。
 *
 * 单子上的内容按"交货凭证"取舍：单号/日期/客户/订单/生产单/产品规格/本批数量/发货信息/签收/签字栏。
 * **不印单价与金额**：这张纸会先到司机和客户手上，价格属于财务口径（应收在过账时单独生成）。
 * 财务要看金额请看【应收 → 成品出库条目】，不靠这张纸。
 */
export type FinishedGoodsOutboundDocument = {
  outboundNo: string;
  /** 原始状态键（draft/posted/shipped/signed/reversed/cancelled）。 */
  status: string;
  statusLabel: string;
  orderNo: string;
  customerName: string;
  productName: string;
  productSpecification: string;
  implementationOrderNo: string;
  outboundNoticeNo: string;
  /** 单据日期（建单日，北京时间）。 */
  outboundDate: string;
  /** 本批数量（十进制文本，去尾零）。 */
  quantity: string;
  unitName: string;
  shipmentDate: string;
  carrier: string;
  trackingNo: string;
  packingListNo: string;
  invoiceNo: string;
  signedDate: string;
  signatureReference: string;
  remark: string;
  riskReason: string;
  /** 制单人姓名（解析不到就空，绝不印 UUID）。 */
  makerName: string;
  /** 打印时间（北京时间，带秒）：同一张单先后打两版时能一眼看出哪份是新的。 */
  printedAt: string;
};

export const OUTBOUND_STATUS_LABELS: Record<string, string> = {
  draft: "待出库",
  posted: "已出库",
  shipped: "已发出",
  signed: "已签收",
  reversed: "已冲销",
  cancelled: "已取消",
};

const COMPANY_NAME = "厦门迪礼伞业有限公司";

/** 数量去尾零：`120.0000` → `120`（仓库只认「120 把」，不认四位小数）。 */
function trimQuantity(value: Prisma.Decimal | string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (!text) return "";
  const number = Number(text);
  if (!Number.isFinite(number)) return text;
  return String(Number(number.toFixed(4)));
}

const day = (value: Date | string | null | undefined): string => (value ? beijingDate(value instanceof Date ? value : new Date(value)) : "");

type ExportOutbound = {
  outboundNo: string;
  status: string;
  orderNo: string;
  productNameSnapshot: string | null;
  productSpecificationSnapshot: string | null;
  quantity: Prisma.Decimal;
  createdAt: Date;
  shipmentDate: Date | null;
  carrier: string | null;
  trackingNo: string | null;
  packingListNo: string | null;
  invoiceNo: string | null;
  signedAt: Date | null;
  signatureReference: string | null;
  remark: string | null;
  riskReason: string | null;
  createdBy: string;
  unit: { name: string } | null;
  salesOrder: { customer: { name: string } | null } | null;
  productionOrder: { productionOrderNo: string } | null;
  outboundNotice: { noticeNo: string } | null;
};

/**
 * 组装出库单打印件（**纯函数**：单测不用起数据库）。
 *
 * 空值一律落空串（不落 "-"）：纸上的空格子要留给手写/盖章，印一个 "-" 反而像"已确认没有"。
 */
export function finishedGoodsOutboundDocument(row: ExportOutbound, makerName: string, printedAt: Date = new Date()): FinishedGoodsOutboundDocument {
  return {
    outboundNo: row.outboundNo,
    status: row.status,
    statusLabel: OUTBOUND_STATUS_LABELS[row.status] ?? row.status,
    orderNo: row.orderNo,
    customerName: row.salesOrder?.customer?.name ?? "",
    productName: row.productNameSnapshot ?? "",
    productSpecification: row.productSpecificationSnapshot ?? "",
    implementationOrderNo: row.productionOrder?.productionOrderNo ?? "",
    outboundNoticeNo: row.outboundNotice?.noticeNo ?? "",
    outboundDate: day(row.createdAt),
    quantity: trimQuantity(row.quantity),
    unitName: row.unit?.name ?? "",
    shipmentDate: day(row.shipmentDate),
    carrier: row.carrier ?? "",
    trackingNo: row.trackingNo ?? "",
    packingListNo: row.packingListNo ?? "",
    invoiceNo: row.invoiceNo ?? "",
    signedDate: day(row.signedAt),
    signatureReference: row.signatureReference ?? "",
    remark: row.remark ?? "",
    riskReason: row.riskReason ?? "",
    makerName,
    printedAt: beijingDateTime(printedAt, { seconds: true }),
  };
}

/**
 * 一张出库单的表格明细（打印件与导出件共用）。
 *
 * 出库单**只有一行**（一次出库 = 一个产品的一批数量），但仍然按"明细表"排版：
 * 纸上的样子与领料单/补料单一致，仓库与客户对货时会去看同一块位置。
 */
export type FinishedGoodsOutboundLine = { sequence: number; productName: string; specification: string; unit: string; quantity: string; remark: string };

export function outboundLines(document: FinishedGoodsOutboundDocument): FinishedGoodsOutboundLine[] {
  const remark = [document.remark, document.riskReason ? `风险原因：${document.riskReason}` : ""].filter(Boolean).join("；");
  return [{ sequence: 1, productName: document.productName, specification: document.productSpecification, unit: document.unitName, quantity: document.quantity, remark }];
}

/**
 * 8 列的宽度（字符数）。为什么是 8：表头是「标签 | 值」四组并排，标签列要放得下「出库单号：」这类 5 个汉字
 * 加冒号（≈6 个字宽），所以标签列统一 12；序号列复用同一列也够。明细表在这 8 列上合并：
 * 序号 A / 产品名称 B / 规格型号 C:D / 单位 E / 数量 F / 备注 G:H —— 与纸面打印件同一块版式。
 */
const COLUMN_WIDTHS = [12, 20, 12, 18, 12, 22, 12, 22];
const LAST_COLUMN = 8;
const BODY_FONT = { name: "宋体", size: 11 } as const;
const HEADER_FONT = { name: "宋体", size: 11, bold: true } as const;
const LABEL_FONT = { name: "宋体", size: 11, bold: true } as const;
const THIN_BORDER: Partial<ExcelJS.Borders> = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };

@Injectable()
export class FinishedGoodsOutboundExportService {
  constructor(private readonly prisma: PrismaService, private readonly actors: AuditActorService) {}

  /** 单张出库单的打印件数据（页面打印视图直接用这一份）。 */
  async buildDocument(id: string): Promise<FinishedGoodsOutboundDocument> {
    const row = await this.prisma.finishedGoodsOutbound.findFirst({ where: { id, deletedAt: null }, include: this.include() });
    if (!row) throw new NotFoundException({ code: "FINISHED_GOODS_OUTBOUND_NOT_FOUND", message: "成品出库单不存在", details: [] });
    const names = await this.actors.namesOf([row.createdBy]);
    return finishedGoodsOutboundDocument(row as unknown as ExportOutbound, names.get(row.createdBy) ?? "");
  }

  /** 单张导出：一个工作表，A4 竖版（与打印件同一版式）。 */
  async exportDocument(id: string): Promise<{ buffer: Buffer; outboundNo: string }> {
    const document = await this.buildDocument(id);
    const workbook = new ExcelJS.Workbook();
    this.addSheet(workbook, document);
    const data = await workbook.xlsx.writeBuffer();
    return { buffer: Buffer.from(data), outboundNo: document.outboundNo };
  }

  private include() {
    return {
      unit: { select: { name: true } },
      salesOrder: { select: { customer: { select: { name: true } } } },
      productionOrder: { select: { productionOrderNo: true } },
      outboundNotice: { select: { noticeNo: true } },
    } as const;
  }

  private addSheet(workbook: ExcelJS.Workbook, document: FinishedGoodsOutboundDocument) {
    const sheet = workbook.addWorksheet((document.outboundNo || "成品出库单").slice(0, 28), {
      pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } }
    });
    sheet.columns = COLUMN_WIDTHS.map((width) => ({ width }));
    sheet.headerFooter = { oddFooter: "&C第 &P 页 / 共 &N 页" };

    // 标题：草稿/已取消/已冲销要在纸上写清楚 —— 一张"待出库"的单子被当成已发货的凭据，比没有单子更糟。
    sheet.mergeCells(`A1:${columnLetter(LAST_COLUMN)}1`);
    const titleCell = sheet.getCell("A1");
    const suffix = ["draft", "cancelled", "reversed"].includes(document.status) ? `（${document.statusLabel}）` : "";
    titleCell.value = `${COMPANY_NAME}　【成品出库单】${suffix}`;
    titleCell.font = { name: "宋体", size: 16, bold: true };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    sheet.getRow(1).height = 30;

    // 表头：3 行 × 4 组「标签 | 值」，正好占满 8 列（标签列宽 12 能把「出库单号：」放全）。
    const headerRows: Array<Array<[string, string]>> = [
      [["出库单号：", document.outboundNo], ["单据日期：", document.outboundDate], ["状态：", document.statusLabel], ["客户名称：", document.customerName]],
      [["订单号：", document.orderNo], ["生产单号：", document.implementationOrderNo], ["产品名称：", document.productName], ["规格型号：", document.productSpecification]],
      [["本批数量：", `${document.quantity}${document.unitName ? ` ${document.unitName}` : ""}`], ["发货日期：", document.shipmentDate], ["承运商：", document.carrier], ["出库通知：", document.outboundNoticeNo]],
    ];
    headerRows.forEach((fields, rowIndex) => {
      const rowNumber = 3 + rowIndex;
      const row = sheet.getRow(rowNumber);
      fields.forEach((field, fieldIndex) => {
        const labelColumn = fieldIndex * 2 + 1;
        const labelCell = row.getCell(labelColumn);
        labelCell.value = field[0];
        labelCell.font = LABEL_FONT;
        labelCell.alignment = { horizontal: "right", vertical: "middle" };
        const valueCell = row.getCell(labelColumn + 1);
        valueCell.value = field[1];
        valueCell.font = BODY_FONT;
        valueCell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
        valueCell.border = { bottom: { style: "thin" } };
      });
      // 产品名称/规格型号那一行可能两行才放得下（长规格不要挤掉行高）。
      row.height = rowIndex === 1 ? 26 : 20;
    });

    // 明细表：8 列上按「序号 | 产品名称 | 规格型号(C:D) | 单位 | 数量 | 备注(G:H)」合并。
    const tableHeaderRow = 7;
    const headerLine = sheet.getRow(tableHeaderRow);
    const detailHeaders: Array<[number, number, string]> = [[1, 1, "序号"], [2, 2, "产品名称"], [3, 4, "规格型号"], [5, 5, "单位"], [6, 6, "数量"], [7, 8, "备注"]];
    for (const [from, to, label] of detailHeaders) {
      if (to > from) sheet.mergeCells(tableHeaderRow, from, tableHeaderRow, to);
      for (let column = from; column <= to; column += 1) {
        const cell = headerLine.getCell(column);
        cell.border = THIN_BORDER;
        cell.font = HEADER_FONT;
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }
      headerLine.getCell(from).value = label;
    }
    headerLine.height = 22;

    const lines = outboundLines(document);
    lines.forEach((line, index) => {
      const rowNumber = tableHeaderRow + 1 + index;
      const row = sheet.getRow(rowNumber);
      const cells: Array<[number, number, string | number]> = [[1, 1, line.sequence], [2, 2, line.productName], [3, 4, line.specification], [5, 5, line.unit], [6, 6, line.quantity], [7, 8, line.remark]];
      for (const [from, to, value] of cells) {
        if (to > from) sheet.mergeCells(rowNumber, from, rowNumber, to);
        for (let column = from; column <= to; column += 1) {
          const cell = row.getCell(column);
          cell.border = THIN_BORDER;
          cell.font = BODY_FONT;
          cell.alignment = { horizontal: from === 1 || from === 5 || from === 6 ? "center" : "left", vertical: "middle", wrapText: true };
        }
        row.getCell(from).value = value;
      }
      row.height = 30;
    });

    // 合计行
    const totalRowNumber = tableHeaderRow + lines.length + 1;
    const totalRow = sheet.getRow(totalRowNumber);
    for (const [from, to, value] of [[1, 1, "合计"] as [number, number, string | number], [6, 6, Number(document.quantity) || 0] as [number, number, number]] as Array<[number, number, string | number]>) {
      if (to > from) sheet.mergeCells(totalRowNumber, from, totalRowNumber, to);
      for (let column = from; column <= to; column += 1) {
        const cell = totalRow.getCell(column);
        cell.border = THIN_BORDER;
        cell.font = from === 6 ? BODY_FONT : HEADER_FONT;
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }
      totalRow.getCell(from).value = value;
    }
    for (let column = 2; column <= LAST_COLUMN; column += 1) {
      const cell = totalRow.getCell(column);
      cell.border = THIN_BORDER;
      cell.font = BODY_FONT;
      cell.alignment = { horizontal: "center", vertical: "middle" };
    }
    totalRow.height = 20;

    // 发货与签收：这两块是"货是怎么走的、谁收了"的唯一纸质凭据，空值也留格子（手写补）。
    let rowNumber = totalRowNumber + 2;
    const logisticsRows: Array<Array<[string, string, number]>> = [
      [["运单号：", document.trackingNo, 1], ["装箱单号：", document.packingListNo, 1], ["发票号：", document.invoiceNo, 1], ["签收日期：", document.signedDate, 1]],
      [["签收凭证：", document.signatureReference, 1], ["备注：", document.remark, 5]],
    ];
    for (const fields of logisticsRows) {
      const row = sheet.getRow(rowNumber);
      let column = 1;
      for (const [label, value, span] of fields) {
        const labelCell = row.getCell(column);
        labelCell.value = label;
        labelCell.font = LABEL_FONT;
        labelCell.alignment = { horizontal: "right", vertical: "middle" };
        column += 1;
        if (span > 1) sheet.mergeCells(rowNumber, column, rowNumber, column + span - 1);
        const valueCell = row.getCell(column);
        valueCell.value = value;
        valueCell.font = BODY_FONT;
        valueCell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
        valueCell.border = { bottom: { style: "thin" } };
        column += span;
      }
      row.height = 20;
      rowNumber += 1;
    }

    // 签字栏：空白供手签（仓库经办 / 承运人 / 客户签收）。
    rowNumber += 1;
    sheet.mergeCells(`A${rowNumber}:${columnLetter(LAST_COLUMN)}${rowNumber}`);
    const signCell = sheet.getCell(`A${rowNumber}`);
    signCell.value = "仓库经办：　　　　　　　承运人：　　　　　　　客户签收：　　　　　　　日期：";
    signCell.font = BODY_FONT;
    signCell.alignment = { horizontal: "left", vertical: "middle" };
    sheet.getRow(rowNumber).height = 34;

    // 页脚：制单人与打印时间（同一张单先后打两版时能一眼看出哪份是新的）。
    rowNumber += 1;
    sheet.mergeCells(`A${rowNumber}:${columnLetter(LAST_COLUMN)}${rowNumber}`);
    const footerCell = sheet.getCell(`A${rowNumber}`);
    footerCell.value = `制单：${document.makerName}　　打印时间：${document.printedAt}（北京时间）`;
    footerCell.font = { name: "宋体", size: 9 };
    footerCell.alignment = { horizontal: "left", vertical: "middle" };
    return sheet;
  }
}

/** 列号 → 列字母（1 → A）。只用于本文件里 8 列以内的合并地址。 */
function columnLetter(index: number): string {
  return String.fromCharCode(64 + index);
}

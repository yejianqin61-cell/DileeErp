import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as ExcelJS from "exceljs";
import { PrismaService } from "../../platform/database/prisma.service";
import { beijingDateTime } from "../../platform/time/beijing-time";

/** 采购订单（打印表）明细行。 */
export type PurchaseOrderDocumentLine = {
  sequence: number;
  productName: string;
  specificationModel: string;
  /** 单位：模板原本没有该列，业务确认新增，否则数量对供应商不明确。 */
  unit: string;
  /** 供应商：一张采购单的明细可能属于不同供应商，业务确认新增该列。 */
  supplierName: string;
  /** 含税单价 = 采购明细单价（系统单价即含税价）。 */
  unitPrice: number;
  quantity: number;
  /** 含税总价 = 数量 × 含税单价 + 附加费（与财务应付金额同口径）。 */
  amount: number;
  deliveryDate: string;
};

export type PurchaseOrderDocument = {
  purchaseOrderNo: string;
  /** 模板的「订单单号」显示销售订单号；采购单号另占一格。 */
  salesOrderNo: string;
  supplierName: string;
  /** 供应商联系人（用户 2026-09-16 的表头清单用语，此前印成「联系人」）。 */
  contactName: string;
  phone: string;
  buyerName: string;
  enteredAt: string;
  operatorName: string;
  operatedAt: string;
  /** 整单含税总价（= 明细金额之和，与列表页「金额」同口径）。 */
  totalAmount: number;
  /** 整单交货日期（= 单头预计到货日，可空；明细行另有逐行交货日期）。 */
  deliveryDate: string;
  /** 付款方式：月结30天 / 月结60天 / 当月付款（文本，可空）。 */
  paymentTerms: string;
  /** 交期条款：本次采购约定的交货安排（可空）。 */
  deliveryTerms: string;
  /** 交货地址（2026-09-16 起系统里有字段；此前这一格只能留空手填）。 */
  deliveryAddress: string;
  remark: string;
  status: string;
  lines: PurchaseOrderDocumentLine[];
};

export type PurchaseOrderFilter = { orderNo?: string; supplierId?: string; status?: string; from?: string; to?: string };

/**
 * 交易条款（业务确认按修正后的文字打印）。相对原件修正了 4 处：
 * 1) 「厂商就赔偿」→「厂商应赔偿」；
 * 2) 「样品或明细。标准及协议要求」→「样品或明细、标准及协议要求」；
 * 3) 第 4 条条目符号半角「.」→ 全角「：」，与前三条一致；
 * 4) 「要有千分之二备品」→「要有千分之二的备品」。
 */
export const PURCHASE_TRADE_TERMS = [
  "1：厂商交货、其商品质量必须符合需方提供的样品或明细、标准及协议要求，否则本公司拒绝收货，如在使用过程中发现质量问题，厂商应赔偿因此而造成的经济损失。",
  "2：厂商接到需方订单后，应于一天内做好交货日期的回复，逾期将以需方确认的交货日期及单价为准。",
  "3：厂商应按时交货，逾期一天，按当天的货款1%扣款。",
  "4：要有千分之二的备品和维修配件。"
] as const;

/**
 * 签署栏三格（留空供手写）。
 *
 * 用户 2026-09-16 选择的口径是「系统里存文本、**导出仍留空手写**」：
 * 回签内容存在 `purchase_orders.supplier_reply / supplier_signed / supervisor_signature`
 * （采购单页面的「打印信息」里可填，用于我们自己的记录与追溯），但纸面这三格保持空白，
 * 现场手写用。所以这里刻意**不读**那三列 —— 不是漏了，是口径如此。若要改成回填打印，
 * 把对应 document 字段接上、填进这三个格子即可（一行的事）。
 */
const SIGNATURE_LABELS = ["厂家回签意见", "厂家回签", "主管签字"] as const;
/** 表尾三个大格子的高度（行数）：用户点名要「大格子」，两行太窄写不下意见。 */
const SIGNATURE_ROWS = 4;

// 列序：模板 7 列的相对顺序不变，仅在「规格型号」后插入「单位」、「含税单价」前插入「供应商」。
const COLUMNS: Array<{ header: string; width: number }> = [
  { header: "序号", width: 6 },
  { header: "产品名称", width: 22 },
  { header: "规格型号", width: 16 },
  { header: "单位", width: 8 },
  { header: "供应商", width: 20 },
  { header: "含税单价", width: 12 },
  { header: "数量", width: 10 },
  { header: "含税总价", width: 12 },
  { header: "交货日期", width: 14 }
];
const LAST_COLUMN = "I";

/**
 * 版式行号。表头字段的多少会改变明细表的位置，所以全部由常量推出来，
 * 不再到处写字面行号 —— 上一版把「明细表头在第 6 行」写死在测试里，加两行表头就全线错位。
 */
const ADDRESS_ROW = 2;
/** 表头字段网格首行（4 行 × 3 组 = 12 格，正好放下用户点名的 12 项里的 10 项 + 电话 + 采购单号）。 */
const HEADER_GRID_START = 3;
/** 交期条款整行（跨 A:I）：条款是长句，塞进两列宽的格子会被挤成一条线。 */
const TERMS_ROW = HEADER_GRID_START + 4;
const SPACER_ROW = TERMS_ROW + 1;
const TABLE_HEADER_ROW = SPACER_ROW + 1;

const BODY_FONT = { name: "宋体", size: 11 } as const;
const HEADER_FONT = { name: "宋体", size: 11, bold: true } as const;
const THIN_BORDER: Partial<ExcelJS.Borders> = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };

const toNumber = (value: Prisma.Decimal | string | number | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : 0;
};
const toDateText = (value: Date | null | undefined): string => (value ? new Date(value).toISOString().slice(0, 10) : "");
// 时间口径固定北京时间（不再用 toLocaleString：它按运行宿主时区走，导出在容器里跑、界面在浏览器里跑，两边会不一致）。
const toTimeText = (value: Date | null | undefined): string => beijingDateTime(value);

type ExportItem = {
  materialSnapshot: unknown;
  model: string | null;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  amount: Prisma.Decimal;
  expectedDate: Date | null;
  material: { name: string; specificationModel: string | null };
  unit: { name: string };
  supplier: { name: string };
};

type ExportOrder = {
  purchaseOrderNo: string;
  orderNo: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
  remark: string | null;
  expectedDate: Date | null;
  totalAmount: Prisma.Decimal;
  paymentTerms: string | null;
  deliveryTerms: string | null;
  deliveryAddress: string | null;
  supplier: { name: string; contactName: string | null; phone: string | null };
  items: ExportItem[];
};

@Injectable()
export class PurchaseOrderExportService {
  constructor(private readonly prisma: PrismaService) {}

  /** 组装单张采购订单的打印数据。 */
  async buildDocument(purchaseOrderId: string): Promise<PurchaseOrderDocument> {
    const order = await this.prisma.purchaseOrder.findFirst({ where: { id: purchaseOrderId, deletedAt: null }, include: this.include() });
    if (!order) throw new NotFoundException({ code: "PURCHASE_ORDER_NOT_FOUND", message: "采购单不存在", details: [] });
    return this.assemble(order as unknown as ExportOrder);
  }

  /** 按筛选条件批量组装（批量导出用）。 */
  async buildDocuments(filter: PurchaseOrderFilter): Promise<PurchaseOrderDocument[]> {
    const orders = await this.prisma.purchaseOrder.findMany({
      where: {
        deletedAt: null,
        ...(filter.orderNo ? { orderNo: filter.orderNo } : {}),
        ...(filter.supplierId ? { supplierId: filter.supplierId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.from || filter.to ? { purchaseDate: { ...(filter.from ? { gte: new Date(filter.from) } : {}), ...(filter.to ? { lte: new Date(filter.to) } : {}) } } : {})
      },
      include: this.include(),
      orderBy: [{ orderNo: "asc" }, { purchaseOrderNo: "asc" }]
    });
    const documents: PurchaseOrderDocument[] = [];
    for (const order of orders) documents.push(await this.assemble(order as unknown as ExportOrder));
    return documents;
  }

  /** 单张导出：一个工作表。 */
  async exportOrder(purchaseOrderId: string): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    this.addSheet(workbook, await this.buildDocument(purchaseOrderId));
    return this.toBuffer(workbook);
  }

  /** 批量导出：每张采购单一个工作表（表名=采购单号），便于按单打印。 */
  async exportOrders(filter: PurchaseOrderFilter): Promise<{ buffer: Buffer; count: number }> {
    const documents = await this.buildDocuments(filter);
    const workbook = new ExcelJS.Workbook();
    for (const document of documents) this.addSheet(workbook, document);
    return { buffer: await this.toBuffer(workbook), count: documents.length };
  }

  private include() {
    return {
      supplier: true,
      items: { where: { deletedAt: null }, include: { material: true, unit: true, supplier: true }, orderBy: { createdAt: "asc" } }
    } as const;
  }

  private async assemble(order: ExportOrder): Promise<PurchaseOrderDocument> {
    const userIds = [...new Set([order.createdBy, order.updatedBy].filter(Boolean))];
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } }) : [];
    const nameOf = (id: string) => users.find((user) => user.id === id)?.displayName ?? "";
    const lines: PurchaseOrderDocumentLine[] = order.items.map((item, index) => {
      const snapshot = (item.materialSnapshot ?? {}) as { name?: string; specificationModel?: string | null };
      return {
        sequence: index + 1,
        productName: snapshot.name ?? item.material?.name ?? "",
        // 业务确认：规格型号取采购明细的「型号」，为空时退回物料规格型号。
        specificationModel: item.model ?? item.material?.specificationModel ?? snapshot.specificationModel ?? "",
        unit: item.unit?.name ?? "",
        supplierName: item.supplier?.name ?? "",
        unitPrice: toNumber(item.unitPrice),
        quantity: toNumber(item.quantity),
        amount: toNumber(item.amount),
        deliveryDate: toDateText(item.expectedDate ?? order.expectedDate)
      };
    });
    return {
      purchaseOrderNo: order.purchaseOrderNo,
      salesOrderNo: order.orderNo,
      supplierName: order.supplier?.name ?? "",
      contactName: order.supplier?.contactName ?? "",
      phone: order.supplier?.phone ?? "",
      buyerName: nameOf(order.createdBy),
      enteredAt: toTimeText(order.createdAt),
      operatorName: nameOf(order.updatedBy),
      operatedAt: toTimeText(order.updatedAt),
      totalAmount: toNumber(order.totalAmount),
      deliveryDate: toDateText(order.expectedDate),
      paymentTerms: order.paymentTerms ?? "",
      deliveryTerms: order.deliveryTerms ?? "",
      deliveryAddress: order.deliveryAddress ?? "",
      remark: order.remark ?? "",
      status: order.status,
      lines
    };
  }

  private addSheet(workbook: ExcelJS.Workbook, document: PurchaseOrderDocument) {
    const base = (document.purchaseOrderNo || "采购订单").slice(0, 28);
    let name = base;
    let suffix = 1;
    while (workbook.getWorksheet(name)) name = `${base}-${suffix++}`.slice(0, 31);
    const sheet = workbook.addWorksheet(name, {
      pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } }
    });
    sheet.columns = COLUMNS.map((column) => ({ width: column.width }));
    sheet.headerFooter = { oddFooter: "&C第 &P 页 / 共 &N 页" };

    // 标题（草稿标注，避免把未生效的采购单当正式订单发给厂商）
    sheet.mergeCells(`A1:${LAST_COLUMN}1`);
    const titleCell = sheet.getCell("A1");
    titleCell.value = document.status === "draft" ? "【采购订单】（草稿）" : "【采购订单】";
    titleCell.font = { name: "宋体", size: 16, bold: true };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    sheet.getRow(1).height = 30;

    // 交货地址：2026-09-16 起系统里有字段（采购单 →「打印信息」里填），不再只能手写
    const addressLabel = sheet.getCell(`A${ADDRESS_ROW}`);
    addressLabel.value = "交货地址：";
    addressLabel.font = BODY_FONT;
    addressLabel.alignment = { horizontal: "right", vertical: "middle" };
    sheet.mergeCells(`B${ADDRESS_ROW}:${LAST_COLUMN}${ADDRESS_ROW}`);
    const addressCell = sheet.getCell(`B${ADDRESS_ROW}`);
    addressCell.value = document.deliveryAddress;
    addressCell.font = BODY_FONT;
    addressCell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
    addressCell.border = { bottom: { style: "thin" } };
    sheet.getRow(ADDRESS_ROW).height = 20;

    // 表头字段：每行 3 组「标签 + 跨两列的值」，共 4 行 12 格。
    // 列序照用户 2026-09-16 给的表头清单：订单号 / 供应商名称 / 供应商联系人 / 采购人 / 操作人 /
    // 下单录入时间 / 操作时间 / 总价 / 交货日期 / 付款方式，最后一行补上原模板就有的 电话 / 采购单号
    // （采购单号是厂商对账的唯一抓手，不能因为清单里没写就不印）。
    const headerRows: Array<Array<[string, string | number]>> = [
      [["订单号：", document.salesOrderNo], ["供应商名称：", document.supplierName], ["供应商联系人：", document.contactName]],
      [["采购人：", document.buyerName], ["操作人：", document.operatorName], ["下单录入时间：", document.enteredAt]],
      [["操作时间：", document.operatedAt], ["总价：", document.totalAmount], ["交货日期：", document.deliveryDate]],
      [["付款方式：", document.paymentTerms], ["电话：", document.phone], ["采购单号：", document.purchaseOrderNo]]
    ];
    const labelColumns = ["A", "D", "G"] as const;
    headerRows.forEach((fields, rowIndex) => {
      const rowNumber = HEADER_GRID_START + rowIndex;
      const row = sheet.getRow(rowNumber);
      fields.forEach((field, fieldIndex) => {
        const labelCell = row.getCell(labelColumns[fieldIndex]);
        labelCell.value = field[0];
        labelCell.font = BODY_FONT;
        labelCell.alignment = { horizontal: "right", vertical: "middle" };
        const valueStart = String.fromCharCode(labelColumns[fieldIndex].charCodeAt(0) + 1);
        const valueEnd = String.fromCharCode(labelColumns[fieldIndex].charCodeAt(0) + 2);
        sheet.mergeCells(`${valueStart}${rowNumber}:${valueEnd}${rowNumber}`);
        const valueCell = sheet.getCell(`${valueStart}${rowNumber}`);
        valueCell.value = field[1];
        valueCell.font = BODY_FONT;
        valueCell.alignment = { horizontal: "left", vertical: "middle" };
        valueCell.border = { bottom: { style: "thin" } };
        // 总价是真正的数字格（能直接参与计算），其余是文字
        if (typeof field[1] === "number") valueCell.numFmt = "0.00##";
      });
      row.height = 20;
    });

    // 交期条款整行（跨 A:I）：条款是长句，塞进两列宽的格子会被挤成一条线
    const termsLabel = sheet.getCell(`A${TERMS_ROW}`);
    termsLabel.value = "交期条款：";
    termsLabel.font = BODY_FONT;
    termsLabel.alignment = { horizontal: "right", vertical: "middle" };
    sheet.mergeCells(`B${TERMS_ROW}:${LAST_COLUMN}${TERMS_ROW}`);
    const termsCell = sheet.getCell(`B${TERMS_ROW}`);
    termsCell.value = document.deliveryTerms;
    termsCell.font = BODY_FONT;
    termsCell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
    termsCell.border = { bottom: { style: "thin" } };
    sheet.getRow(TERMS_ROW).height = 20;
    sheet.getRow(SPACER_ROW).height = 6;

    // 明细表
    const tableHeaderRow = TABLE_HEADER_ROW;
    const headerRow = sheet.getRow(tableHeaderRow);
    COLUMNS.forEach((column, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = column.header;
      cell.font = HEADER_FONT;
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = THIN_BORDER;
    });
    headerRow.height = 22;

    document.lines.forEach((line, index) => {
      const row = sheet.getRow(tableHeaderRow + 1 + index);
      const values: Array<string | number> = [line.sequence, line.productName, line.specificationModel, line.unit, line.supplierName, line.unitPrice, line.quantity, line.amount, line.deliveryDate];
      values.forEach((value, columnIndex) => {
        const cell = row.getCell(columnIndex + 1);
        cell.value = value;
        cell.font = BODY_FONT;
        const isText = [1, 2, 3, 4].includes(columnIndex);
        cell.alignment = { horizontal: isText ? "left" : "center", vertical: "middle", wrapText: isText };
        cell.border = THIN_BORDER;
        if ([5, 6, 7].includes(columnIndex)) cell.numFmt = "0.00##";
      });
      row.height = 20;
    });

    // 小计：只对含税总价求和（数量跨单位相加没有意义）
    const firstDataRow = tableHeaderRow + 1;
    const lastDataRow = tableHeaderRow + document.lines.length;
    const subtotalRow = sheet.getRow(lastDataRow + 1);
    const subtotalCell = subtotalRow.getCell(1);
    subtotalCell.value = "小计";
    subtotalCell.font = HEADER_FONT;
    subtotalCell.alignment = { horizontal: "center", vertical: "middle" };
    subtotalCell.border = THIN_BORDER;
    for (let column = 2; column <= COLUMNS.length; column += 1) {
      const cell = subtotalRow.getCell(column);
      cell.border = THIN_BORDER;
      cell.font = BODY_FONT;
      cell.alignment = { horizontal: "center", vertical: "middle" };
      if (column === 8) {
        cell.value = { formula: `SUM(H${firstDataRow}:H${lastDataRow})` };
        cell.numFmt = "0.00##";
      }
    }
    subtotalRow.height = 20;

    // 备注区
    let cursor = lastDataRow + 2;
    const remarkLabel = sheet.getCell(`A${cursor}`);
    remarkLabel.value = "备注：";
    remarkLabel.font = HEADER_FONT;
    for (let offset = 0; offset < 3; offset += 1) {
      const rowNumber = cursor + offset;
      sheet.mergeCells(`A${rowNumber}:${LAST_COLUMN}${rowNumber}`);
      sheet.getRow(rowNumber).getCell(1).border = THIN_BORDER;
      sheet.getRow(rowNumber).height = 18;
    }
    sheet.getRow(cursor).getCell(1).value = `备注：${document.remark}`;
    sheet.getRow(cursor).getCell(1).font = BODY_FONT;
    sheet.getRow(cursor).getCell(1).alignment = { horizontal: "left", vertical: "top", wrapText: true };
    cursor += 3;

    // 交易条款
    const termsTitle = sheet.getCell(`A${cursor}`);
    termsTitle.value = "交易条款：";
    termsTitle.font = HEADER_FONT;
    cursor += 1;
    for (const term of PURCHASE_TRADE_TERMS) {
      sheet.mergeCells(`A${cursor}:${LAST_COLUMN}${cursor}`);
      const cell = sheet.getCell(`A${cursor}`);
      cell.value = term;
      cell.font = BODY_FONT;
      cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
      sheet.getRow(cursor).height = 18;
      cursor += 1;
    }
    cursor += 1;

    // 签署栏：三格留空供手写（回签内容存在系统里，但按用户口径不回填打印，见 SIGNATURE_LABELS 注释）
    const signatureRow = cursor;
    for (let offset = 0; offset < SIGNATURE_ROWS; offset += 1) sheet.getRow(signatureRow + offset).height = 24;
    const signatureSpans: Array<[string, string]> = [["A", "C"], ["D", "F"], ["G", LAST_COLUMN]];
    SIGNATURE_LABELS.forEach((label, index) => {
      const [start, end] = signatureSpans[index];
      sheet.mergeCells(`${start}${signatureRow}:${end}${signatureRow + SIGNATURE_ROWS - 1}`);
      const cell = sheet.getCell(`${start}${signatureRow}`);
      cell.value = label;
      cell.font = HEADER_FONT;
      cell.alignment = { horizontal: "left", vertical: "top" };
      cell.border = THIN_BORDER;
    });
    return sheet;
  }

  private async toBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
    const data = await workbook.xlsx.writeBuffer();
    return Buffer.from(data);
  }
}

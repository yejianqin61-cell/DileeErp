import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as ExcelJS from "exceljs";
import { PrismaService } from "../../platform/database/prisma.service";
import { columnSpanWidth, rowHeightFor, type RowHeightBlock } from "../../platform/excel/row-height";
import { beijingDateTime } from "../../platform/time/beijing-time";

/**
 * 采购订单（打印表）明细行。
 *
 * 2026-10-13（用户）：「采购订单导出时，那个 excel 表单里面，可以不用有供应商这一个 column。
 * 采购单号这个字段也不需要导出。交货日期也不需要这个 column」
 * —— 明细表从 9 列收到 **7 列**（序号 / 产品名称 / 规格型号 / 单位 / 含税单价 / 数量 / 含税总价）。
 * 两个被删的字段**整条链路都删掉了**（类型、组装、单元格），不是"印的时候跳过"：
 * 留着没人读的字段，下一个人会以为那一列还在。
 */
export type PurchaseOrderDocumentLine = {
  sequence: number;
  productName: string;
  specificationModel: string;
  /** 单位：模板原本没有该列，业务确认新增，否则数量对供应商不明确。 */
  unit: string;
  /** 含税单价 = 采购明细单价（系统单价即含税价）。 */
  unitPrice: number;
  quantity: number;
  /** 含税总价 = 数量 × 含税单价 + 附加费（与财务应付金额同口径）。 */
  amount: number;
};

export type PurchaseOrderDocument = {
  /**
   * 采购单号。**2026-10-13 起不再印在纸面上**（用户：「采购单号这个字段也不需要导出」），
   * 但它仍在这里：批量导出时**工作表名 = 采购单号**（一簿多单要认得出哪张是哪个）。
   * 工作表名是文件里的导航信息、不会打印，所以"不印给厂商看"与"导出时仍分得清"两件事不冲突。
   */
  purchaseOrderNo: string;
  /** 模板的「订单单号」显示销售订单号（纸面上这才是对账用的那一号）。 */
  salesOrderNo: string;
  /**
   * 货号（销售单上的货号，2026-09-26）。历史单没有货号 → 空串，此时打印件与改造前**逐字相同**。
   */
  itemNo: string;
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
  /**
   * 整单交货日期（= 单头预计到货日，可空）。**仍留在表头格里**
   * （2026-10-13 用户确认：只删明细表那一列，抬头这句「交货日期：」保留 —— 厂商要知道整单哪天要）。
   */
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

// 明细表列序：模板 7 列的相对顺序不变，仅在「规格型号」后插入「单位」。
// 2026-10-13（用户）：删掉后来的「供应商」列与模板原有的「交货日期」列 → 回到 7 列。
// 2026-10-19（用户）：「单位这个 column 可以窄一点。然后产品名称和规格型号这两列一定要宽大一点」
// —— 单位 8 → 6，产品名称 22 → 30，规格型号 16 → 26，腾出/吃进的宽度从「含税单价/数量」里调，
// 版心总宽 86 → 102（仍然落在 A4 纵向一页宽以内，见 {@link SHEET_LAST_COLUMN} 的打印比例）。
const COLUMNS: Array<{ header: string; width: number }> = [
  { header: "序号", width: 6 },
  { header: "产品名称", width: 30 },
  { header: "规格型号", width: 26 },
  { header: "单位", width: 6 },
  { header: "含税单价", width: 11 },
  { header: "数量", width: 10 },
  { header: "含税总价", width: 13 }
];
/** 各列宽度（与 `COLUMNS` 同序）：算折行/行高时按它取跨度。 */
const SHEET_WIDTHS: readonly number[] = COLUMNS.map((column) => column.width);
/** 版心总宽度（列宽单位）：整行合并格、「备注」这类整行文字的可用宽度。 */
const SHEET_WIDTH = SHEET_WIDTHS.reduce((total, width) => total + width, 0);
/**
 * 版心右边界 = 明细表最后一列（G）。
 *
 * 2026-10-13 起版心曾是 A:I：H、I 两列是给表头字段网格第三组「值格」用的尾巴列，
 * 它们不在明细表里 —— 纸面上就是右边多出 26 个列宽单位的空白，而且把整张表撑到 A4 装不下
 * （Excel `fitToPage` 会把整页缩到 86%，字反而变小）。
 * 2026-10-19 表头改成「标签：值」写在同一格里（见 {@link HEADER_FIELD_SPANS}），尾巴列不再需要，
 * 版心回到明细表的右边界：总宽 102，打印比例 ≈ 95%，纸上的字比改版前更大（改版前 112）。
 *
 * ⚠️ 列宽别写 9：ExcelJS 把它当"默认宽度"，不会写进 `xl/worksheets/*.xml` 的 `<cols>`，
 * Excel 打开时按默认列宽（8.43）渲染 —— 差一点点，但会让人以为设的宽度没生效。
 */
const SHEET_LAST_COLUMN = "G";
/**
 * 表头字段网格（4 行 × 3 组 = 11 个字段）的列分组，每组一个合并格、格内写「标签：值」。
 *
 * ## 为什么标签和值写在同一格（2026-10-19）
 *
 * 2026-09-16 起是「标签占一格、值占两格」（标签在 A / D / G，值在 B:C / E:F / H:I）。
 * 但 xlsx **只有一套列宽**：标签列在明细表里就是「序号」(6) 与「单位」(5/6)，
 * 而「供应商联系人：」有 14 个列宽单位 —— 实测（用 Excel 把这件导出成 PDF 再放大看）：
 * 13 个标签里有 7 个被截成「单号：」「购人：」「时间：」「方式：」这种半截字，
 * 表格顶部看起来像一串没有名字的值。要修只能让标签列变宽，但那会把「序号 / 单位」两列
 * 一起撑宽 —— 正是用户 2026-10-19 要往反方向调的两列。
 * 把标签并进值格是唯一同时满足「标签完整」与「明细列宽按业务定」的写法。
 */
const HEADER_FIELD_SPANS: ReadonlyArray<{ start: number; end: number }> = [
  { start: 1, end: 2 }, // A:B —— 序号 + 产品名称，36 个单位（「订单号：DL260001（货号 27621）」26 个单位）
  { start: 3, end: 4 }, // C:D —— 规格型号 + 单位，32 个单位
  { start: 5, end: 7 } // E:G —— 含税单价 + 数量 + 含税总价，34 个单位（「下单录入时间：2026-09-10 09:20」30 个）
];
/** 第 `column` 列（1 起）的列字母。 */
const columnLetter = (column: number): string => String.fromCharCode("A".charCodeAt(0) + column - 1);

/**
 * 版式行号。表头字段的多少会改变明细表的位置，所以全部由常量推出来，
 * 不再到处写字面行号 —— 上一版把「明细表头在第 6 行」写死在测试里，加两行表头就全线错位。
 */
const ADDRESS_ROW = 2;
/**
 * 表头字段网格首行（4 行 × 3 组 = 12 格）。
 *
 * 2026-10-13 起实际只填 **11 格**：用户要求「采购单号这个字段也不需要导出」，
 * 而它是第 4 行第 3 组那个格 —— 于是第 4 行只剩「付款方式 / 电话」两格，右端空着一格。
 * 为什么**不把剩下的格子重排成新的 12 格**：这 12 格的位置是用户 2026-09-16 逐项点名的顺序
 * （订单号 → 供应商名称 → … → 付款方式），重排会让那张已经确认过的单子换个样子；
 * 空着的那个位置在纸面上看不出来（既没有标签也没有下划线），代价最小。
 */
const HEADER_GRID_START = 3;
/** 交期条款整行（跨 A:G）：条款是长句，塞进两列宽的格子会被挤成一条线。 */
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
  material: { name: string; specificationModel: string | null };
  unit: { name: string };
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
  /** 销售单上的货号（2026-09-26）。**不落采购单自己的列**：货号只有销售单一处真源，这里 join 出来印。 */
  salesOrder: { itemNo: string | null } | null;
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
      // 货号只有销售单一处真源（采购单**不存**货号列），打印时 join 出来 —— 见设计文档 §二。
      salesOrder: { select: { itemNo: true } },
      // 明细行不再印「供应商」（2026-10-13 用户），所以这里也不 join 每行的供应商：
      // 整单的供应商在抬头「供应商名称：」那一格，取的是 `order.supplier`。
      items: { where: { deletedAt: null }, include: { material: true, unit: true }, orderBy: { createdAt: "asc" } }
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
        unitPrice: toNumber(item.unitPrice),
        quantity: toNumber(item.quantity),
        amount: toNumber(item.amount)
      };
    });
    return {
      purchaseOrderNo: order.purchaseOrderNo,
      salesOrderNo: order.orderNo,
      itemNo: order.salesOrder?.itemNo ?? "",
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
    sheet.mergeCells(`A1:${SHEET_LAST_COLUMN}1`);
    const titleCell = sheet.getCell("A1");
    titleCell.value = document.status === "draft" ? "【采购订单】（草稿）" : "【采购订单】";
    titleCell.font = { name: "宋体", size: 16, bold: true };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    sheet.getRow(1).height = 30;

    // 交货地址：2026-09-16 起系统里有字段（采购单 →「打印信息」里填），不再只能手写。
    // 2026-10-19 起「标签：值」写在同一格 —— 原来标签单独占 A 列（6 个单位宽），
    // 「交货地址：」有 10 个单位，实测印出来只剩「地址：」。
    this.fullWidthLine(sheet, ADDRESS_ROW, `交货地址：${document.deliveryAddress}`);

    // 表头字段：每行 3 组，每组一个合并格、格内「标签：值」（见 HEADER_FIELD_SPANS）。
    // 列序照用户 2026-09-16 给的表头清单：订单号 / 供应商名称 / 供应商联系人 / 采购人 / 操作人 /
    // 下单录入时间 / 操作时间 / 总价 / 交货日期 / 付款方式，最后一行是原模板就有的 电话。
    // ⚠️ 2026-10-13（用户）：「采购单号这个字段也不需要导出」—— 原来最后一格印的采购单号已删。
    // 供货商对账改用「订单号」（销售单号，含货号）。采购单号仍用于**工作表名**（见文件头注释）。
    //
    // 货号（2026-09-26）：**跟着「订单号」那一格印**（`DL260001（货号 27621）`），不新开一格。
    // 为什么不新开：这 11 个字段是用户逐项点名的，明细表的列数又牵着列宽/小计公式/边框循环，
    // 而「这一单是哪个货号」本来就与订单号读在一起；为一个字段去动列数或加第 5 行，
    // 代价是整张打印件的行列号全面位移，收益只是一个更松的排版。
    // **没有货号时这一格与改造前逐字相同**（历史单打印件不受影响）。
    const salesOrderCell = document.itemNo ? `${document.salesOrderNo}（货号 ${document.itemNo}）` : document.salesOrderNo;
    const headerFields: Array<Array<[string, string]>> = [
      [["订单号：", salesOrderCell], ["供应商名称：", document.supplierName], ["供应商联系人：", document.contactName]],
      [["采购人：", document.buyerName], ["操作人：", document.operatorName], ["下单录入时间：", document.enteredAt]],
      [["操作时间：", document.operatedAt], ["总价：", document.totalAmount.toFixed(2)], ["交货日期：", document.deliveryDate]],
      [["付款方式：", document.paymentTerms], ["电话：", document.phone]]
    ];
    headerFields.forEach((fields, rowIndex) => {
      const rowNumber = HEADER_GRID_START + rowIndex;
      const blocks: RowHeightBlock[] = [];
      fields.forEach(([label, value], fieldIndex) => {
        const span = HEADER_FIELD_SPANS[fieldIndex];
        if (span.end > span.start) sheet.mergeCells(`${columnLetter(span.start)}${rowNumber}:${columnLetter(span.end)}${rowNumber}`);
        const cell = sheet.getCell(`${columnLetter(span.start)}${rowNumber}`);
        const text = `${label}${value}`;
        cell.value = text;
        cell.font = BODY_FONT;
        // 合并格放不下的长值（很长的供应商名称）折行而不是被截断 —— 行高随后按折行数算。
        cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
        cell.border = { bottom: { style: "thin" } };
        blocks.push({ text, width: columnSpanWidth(SHEET_WIDTHS, span.start, span.end) });
      });
      sheet.getRow(rowNumber).height = rowHeightFor(blocks);
    });

    // 交期条款整行（跨 A:G）：条款是长句，塞进两列宽的格子会被挤成一条线
    this.fullWidthLine(sheet, TERMS_ROW, `交期条款：${document.deliveryTerms}`);
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
      const values: Array<string | number> = [line.sequence, line.productName, line.specificationModel, line.unit, line.unitPrice, line.quantity, line.amount];
      values.forEach((value, columnIndex) => {
        const cell = row.getCell(columnIndex + 1);
        cell.value = value;
        cell.font = BODY_FONT;
        // 0-based：产品名称 / 规格型号 / 单位 是文字（左对齐 + 自动换行）
        const isText = [1, 2, 3].includes(columnIndex);
        cell.alignment = { horizontal: isText ? "left" : "center", vertical: "middle", wrapText: isText };
        cell.border = THIN_BORDER;
        // 0-based：含税单价 / 数量 / 含税总价 是数字格
        if ([4, 5, 6].includes(columnIndex)) cell.numFmt = "0.00##";
      });
      // 行高按文字折行数算（产品名称 30 / 规格型号 26 / 单位 6）：写死 20 时，
      // 「手柄（加长款银色电镀带绳孔）」这种名字的第二行会被压在行线上（=「太扁」那个病，
      // 见 platform/excel/row-height.ts 的文件头注释）。
      row.height = rowHeightFor([
        { text: line.productName, width: SHEET_WIDTHS[1] },
        { text: line.specificationModel, width: SHEET_WIDTHS[2] },
        { text: line.unit, width: SHEET_WIDTHS[3] }
      ]);
    });

    // 小计：只对含税总价求和（数量跨单位相加没有意义）
    // 含税总价的位置**由 `COLUMNS` 推出来**（删列后它是第 7 列 = G）：
    // 写死 "H" 正是删列时最容易漏掉的一处（公式会指向一个空列，纸面上小计变成 0）。
    const amountColumn = COLUMNS.findIndex((column) => column.header === "含税总价") + 1;
    const amountColumnLetter = String.fromCharCode("A".charCodeAt(0) + amountColumn - 1);
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
      if (column === amountColumn) {
        cell.value = { formula: `SUM(${amountColumnLetter}${firstDataRow}:${amountColumnLetter}${lastDataRow})` };
        cell.numFmt = "0.00##";
      }
    }
    subtotalRow.height = 20;

    // 备注区：第一行写备注（行高按折行数算 —— 写死 18 时第二行字会被压在表格线上），后两行留空给手写。
    // 只画**下边框**：合并格里每个成员格都会继承主格样式，四边框会让预览里多出一排竖线
    // （Excel 会把合并区内部的边框藏掉，但有的渲染器不藏；下边框两种情况都干净）。
    let cursor = lastDataRow + 2;
    const remarkText = `备注：${document.remark}`;
    for (let offset = 0; offset < 3; offset += 1) {
      const rowNumber = cursor + offset;
      sheet.mergeCells(`A${rowNumber}:${SHEET_LAST_COLUMN}${rowNumber}`);
      sheet.getRow(rowNumber).getCell(1).border = { bottom: { style: "thin" } };
      sheet.getRow(rowNumber).height = offset === 0 ? rowHeightFor([{ text: remarkText, width: SHEET_WIDTH }]) : 18;
    }
    const remarkCell = sheet.getRow(cursor).getCell(1);
    remarkCell.value = remarkText;
    remarkCell.font = BODY_FONT;
    remarkCell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
    cursor += 3;

    // 交易条款
    const termsTitle = sheet.getCell(`A${cursor}`);
    termsTitle.value = "交易条款：";
    termsTitle.font = HEADER_FONT;
    cursor += 1;
    for (const term of PURCHASE_TRADE_TERMS) {
      // 每一条都是一段长句（第一条 60 多个字，在 102 个列宽单位的版心里要折成 2 行）：
      // 行高必须按折行数算 —— 写死 18 会让第二行字直接压在下一句上面（2026-10-19 实测的渲染就是这样）。
      this.fullWidthLine(sheet, cursor, term);
      cursor += 1;
    }
    cursor += 1;

    // 签署栏：三格留空供手写（回签内容存在系统里，但按用户口径不回填打印，见 SIGNATURE_LABELS 注释）
    const signatureRow = cursor;
    for (let offset = 0; offset < SIGNATURE_ROWS; offset += 1) sheet.getRow(signatureRow + offset).height = 24;
    // 三格按版心 102 拆成 36 / 32 / 34 个单位（A:B / C:D / E:G）：宽度接近三等分才好写字。
    const signatureSpans: Array<[string, string]> = [["A", "B"], ["C", "D"], ["E", SHEET_LAST_COLUMN]];
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

  /**
   * 整行合并的一行文字（交货地址 / 交期条款 / 交易条款）：跨满版心，`wrapText` + 按折行数算行高。
   *
   * 「标签：值」写在同一格（2026-10-19）：原来标签单独占 A 列 —— 6 个列宽单位，而「交货地址：」
   * 有 10 个单位、交易条款更是整句，实测印出来是「地址：」这种半截字。写在同一格里，
   * 标签就不可能被列宽截断。
   */
  private fullWidthLine(sheet: ExcelJS.Worksheet, rowNumber: number, text: string) {
    sheet.mergeCells(`A${rowNumber}:${SHEET_LAST_COLUMN}${rowNumber}`);
    const cell = sheet.getCell(`A${rowNumber}`);
    cell.value = text;
    cell.font = BODY_FONT;
    cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "thin" } };
    sheet.getRow(rowNumber).height = rowHeightFor([{ text, width: SHEET_WIDTH }]);
  }

  private async toBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
    const data = await workbook.xlsx.writeBuffer();
    return Buffer.from(data);
  }
}

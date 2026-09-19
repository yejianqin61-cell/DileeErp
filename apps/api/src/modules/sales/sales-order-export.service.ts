import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as ExcelJS from "exceljs";
import { AuditActorService } from "../../platform/audit/audit-actor.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { beijingDate, beijingDateTime } from "../../platform/time/beijing-time";
import { SPEC_SCALAR_FIELDS } from "./sales-orders.service";

/**
 * 销售单「工艺单」导出（2026-09-16）。
 *
 * 版式依据：`example/销售单/DL260134 JBN生产单(1).xls`（A–J）与
 * `example/销售单/DL260001-1 花色生产单-IS(FLOWER1 PO#32366-1).xlsx`（A–K）两张样本；
 * 设计见 `docs/design/sales-order-spec-refinement-and-production-sheet-export-2026-09-16.md`。
 * 用户拍板「两张合一：一套版式，空盘位自动省略」。
 *
 * 三条约定（都有测试钉住）：
 *   1. **空盘位自动省略**：材料行/工艺条目/布量只有有值的才印；整块为空（样本2 没有布量区）
 *      就整块不印，不留一片空白；
 *   2. **工艺要求重新编号**：跳过的条目不能留出「1、2、5、7」这种断号；
 *   3. **图片格留空**：花色明细里的「图片」列照模板留出列位，单元格一律空（用户明确不导出图片）。
 */
@Injectable()
export class SalesOrderExportService {
  constructor(private readonly prisma: PrismaService, private readonly actors: AuditActorService) {}

  /** 材料明细的印刷顺序与中文名（模板两张样本的并集，顺序照模板）。 */
  static readonly MATERIAL_LABELS: ReadonlyArray<readonly [SpecKey, string]> = [
    ["rib_spec", "伞骨（孔对孔）"],
    ["canopy_spec", "伞布规格"],
    ["handle_spec", "伞头"],
    ["handle_strap_spec", "伞头带"],
    ["tail_spec", "伞尾、笠"],
    ["runner_spec", "伞束、珠"],
    ["strap_spec", "伞带"],
    ["strap_fastener_spec", "伞带粘扣"],
    ["inner_label_spec", "内标"],
    ["woven_label_spec", "织标"],
    ["hang_tag_spec", "吊牌"],
    ["opp_spec", "OPP"],
    ["bag_spec", "布套"],
    ["packaging_spec", "包装明细"],
    ["top_fabric_spec", "天布"],
    ["wood_ear_spec", "木耳"],
    ["keychain_spec", "钥匙扣"],
    ["printing_spec", "印刷"],
  ];

  /** 工艺要求的印刷顺序与分组名（并集；导出时按有值的条目重新编号）。 */
  static readonly PROCESS_LABELS: ReadonlyArray<readonly [SpecKey, string]> = [
    ["sample_requirement", "样品要求"],
    ["cutting_requirement", "裁布要求"],
    ["edge_requirement", "拉边要求"],
    ["joining_requirement", "合片要求"],
    ["top_stitch_requirement", "打顶要求"],
    ["sewing_requirement", "缝伞要求"],
    ["strap_requirement", "伞带要求"],
    ["hang_tag_note", "吊牌位置"],
    ["qc_requirement", "质检报告"],
  ];

  /** 布量五格（模板「伞面/伞带/木耳/天布/布套（Y/DZ)」）。 */
  static readonly FABRIC_LABELS: ReadonlyArray<readonly [SpecKey, string]> = [
    ["fabric_usage_canopy", "伞面"],
    ["fabric_usage_strap", "伞带"],
    ["fabric_usage_wood_ear", "木耳"],
    ["fabric_usage_top", "天布"],
    ["fabric_usage_bag", "布套"],
  ];

  /** 单张工艺单的可测试文档形状（与 Excel 落格分开：断言内容不必依赖坐标）。 */
  document(order: ExportOrder, makerName: string, now: Date = new Date()): ProductionSheetDocument {
    const text = (key: SpecKey): string => {
      const value = (order as unknown as Record<string, unknown>)[key];
      return value === null || value === undefined ? "" : String(value).trim();
    };
    return {
      company: "厦 门 迪 礼 伞 业 有 限 公 司",
      factory: text("factory"),
      orderNo: order.orderNo,
      customerName: order.customer?.name ?? "",
      orderDate: dotDate(order.orderDate),
      quantityText: `${trimDecimal(order.quantity.toString())}${order.unit}`,
      productSpecText: [order.productName, order.productSpec ?? ""].map((part) => part.trim()).filter(Boolean).join(" "),
      region: order.customer?.countryRegion ?? "",
      completionText: `${dotDate(order.deliveryDate)}${text("completion_remark")}`,
      attentionNote: text("attention_note"),
      // 只印有值的行；工艺要求按留下的条目重新编号（不能出现断号）。
      materialLines: SalesOrderExportService.MATERIAL_LABELS.map(([key, label]) => ({ label, value: text(key) })).filter((line) => line.value),
      processLines: SalesOrderExportService.PROCESS_LABELS.map(([key]) => text(key)).filter(Boolean).map((value, index) => `${index + 1}.${value}`),
      detailGroups: groupDetails(order.specDetails),
      fabricUsage: SalesOrderExportService.FABRIC_LABELS.map(([key, label]) => ({ label, value: text(key) })).filter((line) => line.value),
      shippingMarkFront: text("shipping_mark_front"),
      shippingMarkSide: text("shipping_mark_side"),
      makerName,
      madeAt: beijingDateTime(now, { seconds: true }),
      quantityNotice: quantityNotice(order)
    };
  }

  /** 单张导出：返回二进制与订单号（文件名用订单号，不用 UUID）。 */
  async exportOrder(id: string): Promise<{ buffer: Buffer; orderNo: string }> {
    const order = await this.loadOrder(id);
    const names = await this.actors.namesOf([order.createdBy]);
    const workbook = new ExcelJS.Workbook();
    this.addSheet(workbook, this.document(order, names.get(order.createdBy) ?? ""));
    return { buffer: await this.toBuffer(workbook), orderNo: order.orderNo };
  }

  private async loadOrder(id: string): Promise<ExportOrder> {
    const order = await this.prisma.salesOrder.findFirst({
      where: { id, deletedAt: null },
      include: { customer: true, specDetails: { where: { deletedAt: null }, orderBy: { sortOrder: "asc" } } }
    });
    if (!order) throw new NotFoundException({ code: "SALES_ORDER_NOT_FOUND", message: "销售单不存在", details: [] });
    return order as unknown as ExportOrder;
  }

  private addSheet(workbook: ExcelJS.Workbook, doc: ProductionSheetDocument) {
    const sheet = workbook.addWorksheet((doc.orderNo || "工艺单").slice(0, 28), {
      pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } }
    });
    sheet.columns = COLUMN_WIDTHS.map((width) => ({ width }));
    sheet.headerFooter = { oddFooter: "&C第 &P 页 / 共 &N 页" };

    let row = 1;
    sheet.mergeCells(`A${row}:J${row}`);
    const titleCell = sheet.getCell(`A${row}`);
    titleCell.value = doc.company;
    titleCell.font = TITLE_FONT;
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    sheet.getRow(row).height = 26;
    row += 1;

    // 表头：每行恰好占满 A–J 十列（行内 标签+值 的跨列数加起来必须是 10，否则会串到 K 列）
    this.pairs(sheet, row, [[["工　厂", doc.factory], 1], [["客户单号", doc.orderNo], 2], [["客户代码", doc.customerName], 2], [["下单日期", doc.orderDate], 0]]);
    row += 1;
    this.pairs(sheet, row, [[["数　量", doc.quantityText], 2], [["品名规格", doc.productSpecText], 4], [["地区", doc.region], 0]]);
    row += 1;
    this.pairs(sheet, row, [[["完工日期", doc.completionText], 2]]);
    row += 1;

    // 注意事项：整块为空则不印（不占位）
    if (doc.attentionNote) {
      this.block(sheet, row, "A", "J", `注意：${doc.attentionNote}`);
      row += 1;
    }

    // 正文两栏：左「材料 / 明细」，右「工艺要求」（模板的结构；两边按行号并排）
    sheet.getCell(`A${row}`).value = "材料";
    this.block(sheet, row, "B", "F", "明　细");
    this.block(sheet, row, "G", "J", "工艺要求");
    for (const column of ["A", "B", "G"]) sheet.getCell(`${column}${row}`).font = HEADER_FONT;
    row += 1;
    for (let index = 0; index < Math.max(doc.materialLines.length, doc.processLines.length); index += 1) {
      const material = doc.materialLines[index];
      if (material) {
        sheet.getCell(`A${row}`).value = material.label;
        sheet.getCell(`A${row}`).font = HEADER_FONT;
        this.block(sheet, row, "B", "F", material.value);
      }
      const process = doc.processLines[index];
      if (process) this.block(sheet, row, "G", "J", process);
      row += 1;
    }

    // 细分明细：每个分组一块；「图片」列照模板留出列位但**一律留空**
    for (const group of doc.detailGroups) {
      this.block(sheet, row, "A", "J", `${doc.orderNo} ${group.groupName}（图片见客户原稿，本表不导出图片）`);
      sheet.getCell(`A${row}`).font = HEADER_FONT;
      row += 1;
      const headers: Array<[string, string]> = [["A", "品番/品名"], ["C", "图片"], ["D", "颜色"], ["E", "条码"], ["F", "数量"], ["G", "单位"]];
      sheet.mergeCells(`A${row}:B${row}`);
      for (const [column, label] of headers) {
        sheet.getCell(`${column}${row}`).value = label;
        sheet.getCell(`${column}${row}`).font = HEADER_FONT;
      }
      row += 1;
      for (const line of group.lines) {
        sheet.mergeCells(`A${row}:B${row}`);
        sheet.getCell(`A${row}`).value = line.name;
        // C 列（图片）刻意不写值：用户要求图片不导出，只保留列位。
        sheet.getCell(`D${row}`).value = line.color;
        sheet.getCell(`E${row}`).value = line.barcode;
        sheet.getCell(`F${row}`).value = line.quantity === "" ? null : Number(line.quantity);
        sheet.getCell(`G${row}`).value = line.unit;
        row += 1;
      }
    }

    // 正唛 / 侧唛 / 布量：各自为空则整块不印
    if (doc.shippingMarkFront || doc.shippingMarkSide) {
      sheet.getCell(`A${row}`).value = "正　唛";
      sheet.getCell(`A${row}`).font = HEADER_FONT;
      this.block(sheet, row, "B", "E", doc.shippingMarkFront);
      sheet.getCell(`F${row}`).value = "侧　唛";
      sheet.getCell(`F${row}`).font = HEADER_FONT;
      this.block(sheet, row, "G", "J", doc.shippingMarkSide);
      row += 1;
    }
    for (const usage of doc.fabricUsage) {
      sheet.getCell(`A${row}`).value = usage.label;
      this.block(sheet, row, "B", "E", `${usage.value}（Y/DZ)`);
      row += 1;
    }

    // 表尾：制单人写**姓名**（不是 UUID）；「审核」留白供手签，与模板一致
    this.block(sheet, row, "A", "J", `制单：${doc.makerName}　　审核：　　制表时间：${doc.madeAt}（北京时间）`);
    row += 1;
    if (doc.quantityNotice) {
      this.block(sheet, row, "A", "J", `核对提示：${doc.quantityNotice}`);
      sheet.getCell(`A${row}`).font = WARNING_FONT;
    }
  }

  /**
   * 一行里放若干「标签 + 值」：`[[标签, 值], 值的跨列数]`。
   * 跨列数 0 表示「吃掉剩下的列」——最后一段总是用它，这样每行必然正好占满 10 列。
   */
  private pairs(sheet: ExcelJS.Worksheet, row: number, entries: Array<[[string, string], number]>) {
    let column = 1;
    for (const [[label, value], span] of entries) {
      sheet.getCell(row, column).value = label;
      sheet.getCell(row, column).font = HEADER_FONT;
      column += 1;
      const width = span === 0 ? LAST_COLUMN - column + 1 : span;
      if (width > 1) sheet.mergeCells(row, column, row, column + width - 1);
      sheet.getCell(row, column).value = value;
      column += width;
    }
  }

  private block(sheet: ExcelJS.Worksheet, row: number, from: string, to: string, value: string) {
    sheet.mergeCells(`${from}${row}:${to}${row}`);
    const cell = sheet.getCell(`${from}${row}`);
    cell.value = value;
    cell.alignment = { vertical: "middle", wrapText: true };
  }

  private async toBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
    const data = await workbook.xlsx.writeBuffer();
    return Buffer.from(data);
  }
}

const LAST_COLUMN = 10;
const COLUMN_WIDTHS = [16, 14, 10, 12, 14, 10, 8, 10, 10, 10];
const TITLE_FONT = { name: "宋体", size: 16, bold: true } as const;
const HEADER_FONT = { name: "宋体", size: 11, bold: true } as const;
const WARNING_FONT = { name: "宋体", size: 11, color: { argb: "FFB00020" } } as const;

/** `2026.6.18`（模板两张样本都是这种不补零的写法）。 */
export function dotDate(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const [year, month, day] = beijingDate(date).split("-");
  return `${year}.${Number(month)}.${Number(day)}`;
}

/** 数量去掉多余的小数零（模板写 `1960支`，不是 `1960.0000支`）。 */
export function trimDecimal(value: string): string {
  const text = value.trim();
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

/** 明细按分组归拢；组内保持查询给出的 sortOrder 顺序。 */
function groupDetails(lines: ExportOrder["specDetails"]): ProductionSheetDocument["detailGroups"] {
  const groups: ProductionSheetDocument["detailGroups"] = [];
  for (const line of lines) {
    let group = groups.find((item) => item.groupName === line.groupName);
    if (!group) {
      group = { groupName: line.groupName, lines: [] };
      groups.push(group);
    }
    group.lines.push({
      name: line.name,
      color: line.color ?? "",
      barcode: line.barcode ?? "",
      quantity: line.quantity === null ? "" : trimDecimal(line.quantity.toString()),
      unit: line.unit ?? ""
    });
  }
  return groups;
}

/**
 * 明细合计 vs 单头数量的核对提示（导出也印，与页面同一口径）。
 *
 * 这里**不复用** service 里那份：单位归一那段逻辑要按同一张同义词表来（`pcs` 与 `支` 是同一个单位，
 * 样本1 就是表头写「支」、明细写「pcs」），两边各写一遍迟早分叉，所以导出只做「完全相等才不提示」
 * 的保守判断，有疑问就提示人去核对——导出件是给工厂看的，多提示一句比少提示一句安全。
 */
function quantityNotice(order: ExportOrder): string | null {
  const lines = order.specDetails.filter((line) => line.quantity !== null);
  if (!lines.length) return null;
  const total = lines.reduce((sum, line) => sum.plus(line.quantity ?? 0), new Prisma.Decimal(0));
  return total.eq(order.quantity) ? null : `明细数量合计 ${trimDecimal(total.toString())} 与单头数量 ${trimDecimal(order.quantity.toString())} ${order.unit} 不一致，请核对`;
}

type SpecKey = (typeof SPEC_SCALAR_FIELDS)[number][0];

export type ExportOrder = {
  orderNo: string;
  orderDate: Date;
  deliveryDate: Date | null;
  productName: string;
  productSpec: string | null;
  quantity: Prisma.Decimal;
  unit: string;
  createdBy: string;
  customer: { name: string; countryRegion: string | null } | null;
  specDetails: Array<{ groupName: string; name: string; color: string | null; barcode: string | null; quantity: Prisma.Decimal | null; unit: string | null }>;
  /** 37 个细化标量按请求键读取（见 SPEC_SCALAR_FIELDS）。 */
  [specKey: string]: unknown;
};

export type ProductionSheetDocument = {
  company: string;
  factory: string;
  orderNo: string;
  customerName: string;
  orderDate: string;
  quantityText: string;
  productSpecText: string;
  region: string;
  completionText: string;
  attentionNote: string;
  materialLines: Array<{ label: string; value: string }>;
  processLines: string[];
  detailGroups: Array<{ groupName: string; lines: Array<{ name: string; color: string; barcode: string; quantity: string; unit: string }> }>;
  fabricUsage: Array<{ label: string; value: string }>;
  shippingMarkFront: string;
  shippingMarkSide: string;
  makerName: string;
  madeAt: string;
  quantityNotice: string | null;
};

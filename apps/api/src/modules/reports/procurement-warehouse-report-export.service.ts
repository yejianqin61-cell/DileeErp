import { Injectable } from "@nestjs/common";
import * as ExcelJS from "exceljs";
import { rowHeightFor, type RowHeightBlock } from "../../platform/excel/row-height";
import { beijingDateTime, beijingStamp } from "../../platform/time/beijing-time";
import type { ProcurementWarehouseFilter, ProcurementWarehouseRow } from "./procurement-warehouse-report.domain";
import { PROCUREMENT_WAREHOUSE_ROW_LIMIT } from "./procurement-warehouse-report.domain";
import { ProcurementWarehouseReportService } from "./procurement-warehouse-report.service";

/**
 * 采购与仓储报表的 xlsx 导出（设计文档 §3.2）。
 *
 * 关键约束：**取数只取一次**（调 {@link ProcurementWarehouseReportService.build}，
 * 与屏幕接口是同一份数据）。导出自己再算一遍是报表类需求最经典的翻车点 ——
 * 用户在屏幕上看到 11 行、导出文件 10 行，之后没人再信任这张表。
 */

/** 工作表名（设计文档 §3.2 点名的名字；导入/打印时按它找表）。 */
const SHEET_NAME = "采购与仓储报表";

/**
 * 九列：与屏幕表头同序同名（设计文档 §3.1/§4），数量列在 xlsx 里写**数值**而不是文本。
 *
 * 宽度按 `platform/excel/row-height.ts` 的 CJK 口径（一个汉字 ≈ 2 个列宽单位）估：
 * 「物料名称」给 34 个单位才能容下「58cm*8k自动直骨伞」这类名字，数量列给 12~14 个单位
 * 是为了让「采购未入库数」的表头不折行、数值不变成 `####`。
 */
const COLUMNS: ReadonlyArray<{
  header: string;
  width: number;
  /** 数值列：写 number + `0.####` 格式，用户在 Excel 里能直接求和/排序。 */
  numeric?: boolean;
  align: "left" | "center" | "right";
  /** 文字列折行；数值列不折行（折行的数字看起来像两个数）。 */
  wrap?: boolean;
}> = [
  { header: "订单号", width: 12, align: "left" },
  { header: "物料名称", width: 34, align: "left", wrap: true },
  { header: "颜色", width: 10, align: "left" },
  { header: "单位", width: 8, align: "center" },
  { header: "采购数量", width: 12, align: "right", numeric: true },
  { header: "采购入库量", width: 12, align: "right", numeric: true },
  { header: "采购未入库数", width: 14, align: "right", numeric: true },
  { header: "生产领用数量", width: 14, align: "right", numeric: true },
  { header: "库存量", width: 12, align: "right", numeric: true }
];

const SHEET_WIDTHS: readonly number[] = COLUMNS.map((column) => column.width);
const SHEET_WIDTH = SHEET_WIDTHS.reduce((total, width) => total + width, 0);
const LAST_COLUMN_LETTER = String.fromCharCode("A".charCodeAt(0) + COLUMNS.length - 1);

/** 版式行号：标题 / 筛选条件 / 表头 / 数据首行（全由常量推出来，测试与版式不会错位）。 */
const TITLE_ROW = 1;
const INFO_ROW = 2;
const TABLE_HEADER_ROW = 3;
const FIRST_DATA_ROW = TABLE_HEADER_ROW + 1;

const TITLE_FONT = { name: "宋体", size: 16, bold: true } as const;
const HEADER_FONT = { name: "宋体", size: 11, bold: true } as const;
const BODY_FONT = { name: "宋体", size: 11 } as const;
const THIN_BORDER: Partial<ExcelJS.Borders> = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };

/**
 * 表尾口径说明（设计文档 §1 三条规则 + 每列来源一句话）。
 *
 * 为什么必须印在文件里：这张表会被单独转发给采购/仓库/老板看，脱离页面后
 * 「库存量为什么同一物料每行都一样」「为什么没有合计行」没人解释就会变成误解。
 * 文案只写业务口径，不写表名/字段名（设计文档 §4 末条）。
 */
const CALIBER_NOTE = [
  "口径说明：",
  "① 不跨单位相加：同一物料若历史上出现过两个单位，会分成两行（单位不换算，米和卷相加没有意义）。",
  "② 库存量不按订单拆账：库存是物料级的当前结存，同一物料出现在多张订单时，每行的库存量是同一个数，不是「这张订单还剩多少料」。",
  "③ 本表不设合计行：行由不同单位组成，跨单位合计没有意义。",
  "各列来源：采购数量＝已下单采购明细的订购数量合计（草稿、已取消不计）；采购入库量＝已过账原料入库单合计（草稿、已冲销不计）；采购未入库数＝采购数量−采购入库量（负数为超收）；生产领用数量＝已过账领料＋补料−退料（含冲销/撤销过账后的净额，报废不计入领用）；库存量＝该物料＋单位在原料仓与报废仓的当前结存。"
].join("\n");

/** 数量字符串 → 数值单元格的值。字符串已经去掉尾零，Number() 对 18,4 的范围不丢精度。 */
const toCellNumber = (text: string): number => {
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** 筛选条件 + 生成时间 + 行数的说明行（与打印件上的那一行同为「这份数据是什么范围」）。 */
const infoText = (rowCount: number, filters: { order_no: string | null; material: string | null }, generatedAt: Date): string => {
  const orderNoText = filters.order_no ? `订单号包含「${filters.order_no}」` : "全部订单";
  const materialText = filters.material ? `物料包含「${filters.material}」` : "全部物料";
  return `筛选条件：${orderNoText}；${materialText}　生成时间：${beijingDateTime(generatedAt, { seconds: true })}　共 ${rowCount} 行（上限 ${PROCUREMENT_WAREHOUSE_ROW_LIMIT} 行）`;
};

@Injectable()
export class ProcurementWarehouseReportExportService {
  constructor(private readonly report: ProcurementWarehouseReportService) {}

  /** 生成 xlsx。行数超上限时由取数层抛 422（导出不另做一套判断）。 */
  async exportWorkbook(filter: ProcurementWarehouseFilter = {}): Promise<{ buffer: Buffer; fileName: string; rowCount: number }> {
    const result = await this.report.build(filter);
    const workbook = new ExcelJS.Workbook();
    this.addSheet(workbook, result.rows, result.filters, result.generatedAt);
    const data = await workbook.xlsx.writeBuffer();
    return {
      buffer: Buffer.from(data),
      // 文件名用**北京时间**戳：文件里的「生成时间」也是北京时间，两者差 8 小时会被当成导错了批次。
      fileName: `迪礼ERP-采购与仓储报表-${beijingStamp(result.generatedAt)}.xlsx`,
      rowCount: result.rows.length
    };
  }

  private addSheet(workbook: ExcelJS.Workbook, rows: ProcurementWarehouseRow[], filters: { order_no: string | null; material: string | null }, generatedAt: Date): ExcelJS.Worksheet {
    const sheet = workbook.addWorksheet(SHEET_NAME, {
      // A4 横向（设计文档 §3.2）：九列在纵向 A4 上会被压成半页宽，横向 + fitToWidth 才是一页宽。
      pageSetup: {
        paperSize: 9,
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        horizontalCentered: true,
        margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }
      }
    });
    sheet.columns = COLUMNS.map((column) => ({ width: column.width }));

    // 第 1 行：标题（整行合并居中）。
    sheet.mergeCells(`A${TITLE_ROW}:${LAST_COLUMN_LETTER}${TITLE_ROW}`);
    const titleCell = sheet.getCell(`A${TITLE_ROW}`);
    titleCell.value = `迪礼ERP　采购与仓储报表`;
    titleCell.font = TITLE_FONT;
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    sheet.getRow(TITLE_ROW).height = 30;

    // 第 2 行：筛选条件 + 生成时间 + 行数。
    const infoRowText = infoText(rows.length, filters, generatedAt);
    this.fullWidthLine(sheet, INFO_ROW, infoRowText);

    // 第 3 行：表头（与屏幕同序同名）。
    const headerRow = sheet.getRow(TABLE_HEADER_ROW);
    COLUMNS.forEach((column, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = column.header;
      cell.font = HEADER_FONT;
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = THIN_BORDER;
    });
    headerRow.height = 22;

    // 第 4 行起：数据。数量写数值（用户在 Excel 里要能直接求和/排序），不是文本。
    rows.forEach((row, index) => {
      const rowNumber = FIRST_DATA_ROW + index;
      const excelRow = sheet.getRow(rowNumber);
      const cells: Array<string | number> = [
        row.order_no,
        row.material_name,
        row.color,
        row.unit,
        toCellNumber(row.purchase_quantity),
        toCellNumber(row.inbound_quantity),
        toCellNumber(row.pending_inbound_quantity),
        toCellNumber(row.production_issue_quantity),
        toCellNumber(row.stock_quantity)
      ];
      cells.forEach((value, columnIndex) => {
        const column = COLUMNS[columnIndex];
        const cell = excelRow.getCell(columnIndex + 1);
        cell.value = value;
        cell.font = BODY_FONT;
        cell.alignment = { horizontal: column.align, vertical: "middle", wrapText: Boolean(column.wrap) };
        cell.border = THIN_BORDER;
        if (column.numeric) cell.numFmt = "0.####";
      });
      // 行高按**文字列**的折行数算：物料名称给 34 个单位，长名字是折行显示而不是被截掉
      // （截掉的行在纸面上看起来是另一个物料）。数值列不参与折行计算。
      const blocks: RowHeightBlock[] = [0, 1, 2, 3].map((columnIndex) => ({
        text: String(cells[columnIndex] ?? ""),
        width: SHEET_WIDTHS[columnIndex]
      }));
      excelRow.height = rowHeightFor(blocks);
    });

    // 末尾一行：口径说明（整行合并、自动换行）。空数据时它就是第 4 行 —— 0 行也要说清「确实没有数据」。
    const noteRowNumber = FIRST_DATA_ROW + rows.length;
    this.fullWidthLine(sheet, noteRowNumber, CALIBER_NOTE);
    return sheet;
  }

  /** 整行合并的一行文字：跨满版心，`wrapText` + 按折行数算行高（与采购单导出同一做法）。 */
  private fullWidthLine(sheet: ExcelJS.Worksheet, rowNumber: number, text: string) {
    sheet.mergeCells(`A${rowNumber}:${LAST_COLUMN_LETTER}${rowNumber}`);
    const cell = sheet.getCell(`A${rowNumber}`);
    cell.value = text;
    cell.font = BODY_FONT;
    cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "thin" } };
    sheet.getRow(rowNumber).height = rowHeightFor([{ text, width: SHEET_WIDTH }]);
  }
}

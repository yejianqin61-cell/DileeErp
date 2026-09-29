import { Injectable } from "@nestjs/common";
import * as ExcelJS from "exceljs";
import { ReorderService } from "./reorder.service";

/**
 * 货号总结表导出（T14）。
 *
 * 口径与页面**完全一致**：直接复用 `ReorderService.articleDetail` 的结果，不在这里重新取数 ——
 * 导出与页面算出两个不同的毛利，是这类表最经典的翻车方式。
 *
 * 数值格用**数值**（金额/数量），日期用文本（ISO 的日期部分）：沿用仓库既有的
 * 「导出数值单元格」口径（见 docs/design/export-numeric-cells-and-progress-sheet-2026-09-14.md）。
 */
const MONEY_FORMAT = "0.00##";

@Injectable()
export class ReorderExportService {
  constructor(private readonly reorder: ReorderService) {}

  /** 文件名里的货号要洗一遍：`/`、`\`、`:` 之类会让落盘直接失败。 */
  static fileName(itemNo: string): string {
    return `迪礼ERP-货号总结-${itemNo.replace(/[\\/:*?"<>|]/g, "_")}.xlsx`;
  }

  async articleSummary(itemNo: string): Promise<{ buffer: Buffer; fileName: string }> {
    const detail = await this.reorder.articleDetail(itemNo);
    return { buffer: await this.toBuffer(this.workbook(detail, itemNo)), fileName: ReorderExportService.fileName(detail.item_no || itemNo) };
  }

  /** 文档形状（可单测）：一张表 + 表尾口径说明。 */
  workbook(detail: Awaited<ReturnType<ReorderService["articleDetail"]>>, fallbackItemNo: string) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet((detail.item_no || fallbackItemNo).slice(0, 28));
    sheet.columns = [{ width: 18 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 12 }, { width: 10 }];

    const title = sheet.getRow(1);
    title.getCell(1).value = `货号总结：${detail.item_no || fallbackItemNo}`;
    title.getCell(1).font = { bold: true, size: 13 };

    const headers = ["订单号", "下单日", "数量", "单位", "承诺交期", "实际出货", "交期结论", "销售金额", "成本金额", "毛利", "QC 合格率"];
    const headerRow = sheet.getRow(3);
    headers.forEach((header, index) => {
      const cell = headerRow.getCell(index + 1);
      cell.value = header;
      cell.font = { bold: true };
      cell.border = { bottom: { style: "thin" } };
    });

    const grossByOrder = new Map((detail.gross_margin?.batches ?? []).map((batch) => [batch.order_no, batch]));
    detail.orders.forEach((order, index) => {
      const row = sheet.getRow(4 + index);
      const gross = grossByOrder.get(order.order_no);
      const values: Array<string | number | null> = [
        order.order_no,
        order.order_date.slice(0, 10),
        Number(order.quantity),
        order.unit,
        order.delivery.promised_date ? order.delivery.promised_date.slice(0, 10) : null,
        order.delivery.actual_date ? order.delivery.actual_date.slice(0, 10) : null,
        order.delivery.verdict_label,
        gross?.sales_amount === null || gross?.sales_amount === undefined ? null : Number(gross.sales_amount),
        gross?.cost_amount === null || gross?.cost_amount === undefined ? null : Number(gross.cost_amount),
        gross?.gross_profit === null || gross?.gross_profit === undefined ? null : Number(gross.gross_profit),
        order.qc_inspected_quantity === "0" ? null : Number(order.qc_qualified_quantity) / Number(order.qc_inspected_quantity),
      ];
      values.forEach((value, column) => {
        const cell = row.getCell(column + 1);
        cell.value = value;
        if ([7, 8, 9].includes(column) && typeof value === "number") cell.numFmt = MONEY_FORMAT;
        if (column === 10 && typeof value === "number") cell.numFmt = "0.00%";
      });
    });

    // 汇总 + 口径说明：缺采购价/缺 BOM 会让毛利偏高，必须在文件里说清（与利润报表同一句话）。
    let cursor = 4 + detail.orders.length + 1;
    const totalsTitle = sheet.getRow(cursor);
    totalsTitle.getCell(1).value = "合计（按币种）";
    totalsTitle.getCell(1).font = { bold: true };
    cursor += 1;
    for (const total of detail.gross_margin?.totals ?? []) {
      const row = sheet.getRow(cursor);
      row.getCell(1).value = total.currency;
      row.getCell(3).value = total.order_count;
      row.getCell(8).value = Number(total.sales_amount);
      row.getCell(9).value = Number(total.cost_amount);
      row.getCell(10).value = Number(total.gross_profit);
      for (const column of [8, 9, 10]) row.getCell(column).numFmt = MONEY_FORMAT;
      cursor += 1;
    }
    const summary = detail.delivery_summary;
    const notes = [
      `交期结论：提前 ${summary.early} / 准时 ${summary.on_time} / 逾期 ${summary.late} / 未出货 ${summary.not_shipped} / 无交期 ${summary.no_promise}（未出货与无交期都不算准时）。`,
      "毛利 = 销售金额 − BOM 原料成本（只算材料，不含人工/外加工/制造费用，因此是毛利的上界）；口径与财务的「销售利润报表(毛利)」一致。",
      ...(detail.gross_margin ? (detail.gross_margin.footnotes.length ? detail.gross_margin.footnotes : ["没有缺采购价或缺 BOM 的批次。"]) : ["未能取到财务口径的成本：本表不含毛利。"]),
      `QC 合格率为空表示该批没有质检事实（分母为 0）—— 与「全部不合格」是两件事。`,
    ];
    for (const note of notes) {
      sheet.getRow(cursor).getCell(1).value = note;
      cursor += 1;
    }
    return workbook;
  }

  private async toBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
    const data = await workbook.xlsx.writeBuffer();
    return Buffer.from(data);
  }
}

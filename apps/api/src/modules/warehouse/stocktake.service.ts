import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as XLSX from "xlsx";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { dailyCodePrefix, nextSequenceCode } from "../../platform/database/daily-sequence-code";
import { PrismaService } from "../../platform/database/prisma.service";
import { parseQuantity } from "../../platform/database/quantity";
import { InventoryService } from "../../platform/inventory/inventory.service";
import {
  STOCKTAKE_MAX_ROWS,
  parseStocktakeRows,
  stocktakeCodeKey,
  stocktakeTemplateWorkbook,
  type StocktakeImportError,
  type StocktakeImportRow,
} from "./stocktake-import";

type UploadedWorkbook = { buffer?: Buffer; originalname?: string };

/** 盘点单允许的两种状态迁移之外的第三态：已冲销。 */
const DRAFT = "draft";
const CONFIRMED = "confirmed";
const REVERSED = "reversed";

export type StocktakeImportResult = {
  status: "ok" | "partial" | "failed";
  total: number;
  imported: number;
  errorCount: number;
  headerRow: number;
  errors: StocktakeImportError[];
  missingColumns: string[];
  ignoredColumns: string[];
  ignoredTrailingRows: number;
  hints: string[];
  /** 整批失败（找不到表头 / 没有可入单的行）时为 null。 */
  stocktakeId: string | null;
  stocktakeNo: string | null;
};

/**
 * 库存盘点：导入盘点表 → 草稿校核 → 确认时生成库存调整事实。
 *
 * 用户 2026-09-16：「仓库模块增加一个盘点管理，可以将每月一次的盘点数据导入系统，
 * 调整库存物料数量。物料的产品代码作为唯一性」。
 *
 * 三条口径来自用户已确认的选项与既有设计（docs/design/warehouse-module-design.md §6）：
 *   1. **不直接改余额**：确认时按行写 `inventory_facts`（source_type = stocktake_adjustment），
 *      库存余额始终是事实的聚合；已确认的单子只能冲销，不能改；
 *   2. **差异按「确认当时的账面数」重算**：导入与确认之间仓库可能又发生了领料/入库，
 *      若按导入时冻结的差额调账，那笔真实收发会被盘点单悄悄冲掉。每行同时留下
 *      导入时账面数（操作员当时看到的）与确认时账面数（真正参与计算的），事后可解释；
 *   3. **单位不做换算、不跨单位合计**：单位取物料默认单位（单位唯一，已确认口径 4）。
 */
@Injectable()
export class StocktakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
  ) {}

  template() {
    return stocktakeTemplateWorkbook();
  }

  /** 盘点单列表。数量按行统计，不做跨单位金额/数量合计（不同单位的数量相加没有业务含义）。 */
  async list(periodMonth?: string) {
    const [headers, counts, differing] = await Promise.all([
      this.prisma.stocktake.findMany({
        where: { deletedAt: null, ...(periodMonth ? { periodMonth } : {}) },
        orderBy: [{ periodMonth: "desc" }, { createdAt: "desc" }],
      }),
      this.prisma.stocktakeLine.groupBy({ by: ["stocktakeId"], _count: { _all: true } }),
      this.prisma.stocktakeLine.groupBy({ by: ["stocktakeId"], where: { differenceSnapshot: { not: 0 } }, _count: { _all: true } }),
    ]);
    const lineCounts = new Map(counts.map((row) => [row.stocktakeId, row._count._all]));
    const differingCounts = new Map(differing.map((row) => [row.stocktakeId, row._count._all]));
    return headers.map((row) => this.headerOut(row, lineCounts.get(row.id) ?? 0, differingCounts.get(row.id) ?? 0));
  }

  /** 盘点单详情：表头 + 逐行明细 + 汇总（按单位分开，不合并不同单位）。 */
  async get(id: string) {
    const stocktake = await this.prisma.stocktake.findFirst({
      where: { id, deletedAt: null },
      include: {
        lines: {
          orderBy: { lineNo: "asc" },
          include: {
            material: { select: { materialCode: true, name: true, specificationModel: true } },
            unit: { select: { name: true } },
          },
        },
      },
    });
    if (!stocktake) throw this.notFound("STOCKTAKE_NOT_FOUND", "盘点单不存在");

    const lines = stocktake.lines.map((line) => ({
      id: line.id,
      line_no: line.lineNo,
      material_id: line.materialId,
      material_code: line.material.materialCode,
      material_name: line.material.name,
      product_code: line.productCodeSnapshot,
      product_name: line.productNameSnapshot,
      specification: line.specificationSnapshot,
      warehouse_zone: line.warehouseZone,
      bin_location: line.binLocation,
      unit_id: line.unitId,
      unit_name: line.unit.name,
      actual_quantity: line.actualQuantity.toString(),
      book_quantity_snapshot: line.bookQuantitySnapshot.toString(),
      difference_snapshot: line.differenceSnapshot.toString(),
      book_quantity_at_confirm: line.bookQuantityAtConfirm?.toString() ?? null,
      applied_quantity: line.appliedQuantity?.toString() ?? null,
      difference_reason: line.differenceReason,
    }));

    return {
      ...this.headerOut(stocktake, lines.length, lines.filter((line) => line.difference_snapshot !== "0").length),
      lines,
      summary: this.summarize(lines),
    };
  }

  /**
   * 导入盘点表（用户口径：每月一次，一次一张单）。
   *
   * 三段式，与「其他应付批量导入」同一套纪律：
   *   1. **解析**（纯函数 parseStocktakeRows）：表头按名字认列、逐行校验；找不到表头 /
   *      缺必需列 / 没有数据行 → 一行都不写，只回一条整体错误；
   *   2. **匹配物料**：产品代码 = 物料编码（忽略大小写与空格）。找不到的行**逐行报错**，
   *      不自动建档 —— 模板里没有单位，建不出物料；列出来正好让操作员去【采购 → 物料清单】补；
   *   3. **写库**：通过校验的行在**一个事务**里建一张盘点草稿单（表头 + 明细），要么全进要么全不进。
   *
   * 账面数取导入当时的原料库存（与「原料仓储情况」页同一个口径：raw_material + scrap 两个分类的净额）。
   */
  async import(file: UploadedWorkbook | undefined, input: { period_month: string; remark?: string }, user: CurrentUser): Promise<StocktakeImportResult> {
    if (!file?.buffer?.length) throw this.invalid("STOCKTAKE_IMPORT_FILE_REQUIRED", "请上传Excel文件（仅支持 .xlsx/.xls）");
    // 控制器层的 Multer 白名单已经挡过一道；这里再按扩展名挡一次 —— 「上传了一个 CSV/PDF」
    // 应当回一句「只支持 .xlsx/.xls」，而不是让解析器把它读成空表再报「找不到表头」。
    if (file.originalname && !/\.(xlsx|xls)$/i.test(file.originalname)) throw this.invalid("STOCKTAKE_IMPORT_INVALID_FILE", "只支持 .xlsx / .xls 文件，请使用「下载模板」得到的模板填写");
    const parsed = parseStocktakeRows(this.readImportSheet(file));
    const empty = { imported: 0, stocktakeId: null, stocktakeNo: null } as const;
    if (parsed.status === "failed" && !parsed.rows.length) {
      return { ...empty, status: "failed", total: parsed.total, errorCount: parsed.errors.length, headerRow: parsed.headerRow, errors: parsed.errors, missingColumns: parsed.missingColumns, ignoredColumns: parsed.ignoredColumns, ignoredTrailingRows: parsed.ignoredTrailingRows, hints: parsed.hints };
    }

    // 物料池一次性读完做匹配表：一个厂的物料是几百到几千条量级，比逐行查库更省也更一致。
    const materials = await this.prisma.material.findMany({
      where: { deletedAt: null, materialType: "raw_material" },
      select: { id: true, materialCode: true, name: true, specificationModel: true, defaultUnitId: true },
    });
    const byCode = new Map(materials.map((row) => [stocktakeCodeKey(row.materialCode), row]));

    const errors: StocktakeImportError[] = [...parsed.errors];
    const matched: Array<{ row: StocktakeImportRow; material: (typeof materials)[number] }> = [];
    for (const row of parsed.rows) {
      const material = byCode.get(stocktakeCodeKey(row.productCode));
      if (!material) {
        errors.push({ row: row.row, field: "产品代码", reason: `产品代码 ${row.productCode} 在物料清单里找不到：请先到【采购 → 物料清单】新建这个物料（物料编码默认自动生成），再重新导入` });
        continue;
      }
      matched.push({ row, material });
    }

    if (!matched.length) {
      return {
        ...empty, status: "failed", total: parsed.total, errorCount: errors.length, headerRow: parsed.headerRow,
        errors, missingColumns: [], ignoredColumns: parsed.ignoredColumns, ignoredTrailingRows: parsed.ignoredTrailingRows,
        hints: [...parsed.hints, `本文件 ${parsed.rows.length} 行产品代码全部没匹配到物料，没有生成盘点单`],
      };
    }

    // 账面数：与「原料仓储情况」页同一个口径（InventoryService.rawMaterialBalances）。
    const balances = await this.inventory.rawMaterialBalances([...new Set(matched.map((item) => item.material.id))]);
    const bookByKey = new Map(balances.map((row) => [`${row.material_id}|${row.unit_id}`, new Prisma.Decimal(row.quantity)]));

    const stocktakeNo = await this.nextStocktakeNo();
    const now = new Date();
    const stocktakeId = await this.prisma.$transaction(async (tx) => {
      const stocktake = await tx.stocktake.create({
        data: {
          stocktakeNo,
          periodMonth: input.period_month,
          status: DRAFT,
          sourceFileName: file.originalname ?? null,
          importedAt: now,
          remark: input.remark || null,
          ...this.audit.create(user),
        },
      });
      for (const [index, item] of matched.entries()) {
        const book = bookByKey.get(`${item.material.id}|${item.material.defaultUnitId}`) ?? new Prisma.Decimal(0);
        const actual = new Prisma.Decimal(item.row.actualQuantity);
        await tx.stocktakeLine.create({
          data: {
            stocktakeId: stocktake.id,
            lineNo: index + 1,
            materialId: item.material.id,
            // 产品代码 = 物料编码：以物料主数据为准落快照（表里填的写法可能大小写/空格不同）。
            productCodeSnapshot: item.material.materialCode,
            productNameSnapshot: item.row.productName || item.material.name,
            specificationSnapshot: item.row.specification || item.material.specificationModel || null,
            warehouseZone: item.row.warehouseZone || null,
            binLocation: item.row.binLocation || null,
            unitId: item.material.defaultUnitId,
            actualQuantity: actual,
            bookQuantitySnapshot: book,
            differenceSnapshot: actual.minus(book),
            differenceReason: item.row.differenceReason || null,
            ...this.audit.create(user),
          },
        });
      }
      return stocktake.id;
    });

    const hints = [...parsed.hints];
    const samePeriod = await this.prisma.stocktake.findMany({
      where: { deletedAt: null, periodMonth: input.period_month, id: { not: stocktakeId } },
      select: { stocktakeNo: true, status: true },
    });
    if (samePeriod.length) hints.push(`${input.period_month} 已有 ${samePeriod.length} 张盘点单（${samePeriod.map((item) => `${item.stocktakeNo} ${item.status === CONFIRMED ? "已确认" : item.status === REVERSED ? "已冲销" : "草稿"}`).join("、")}）：差异都按各自确认当时的账面数计算`);
    if (errors.length) hints.push(`${errors.length} 行未导入（见下方逐行原因），其余 ${matched.length} 行已进盘点单`);
    hints.push("导入只生成盘点草稿：数量与差异原因都可以再改，确认后才写库存调整");

    await this.audit.record("stocktake.import", "stocktake", user.id, stocktakeId, {
      stocktake_no: stocktakeNo, period_month: input.period_month, imported: matched.length,
      total: parsed.total, error_count: errors.length, source_file_name: file.originalname ?? null,
    });

    return {
      status: errors.length ? "partial" : "ok",
      total: parsed.total,
      imported: matched.length,
      errorCount: errors.length,
      headerRow: parsed.headerRow,
      errors,
      missingColumns: [],
      ignoredColumns: parsed.ignoredColumns,
      ignoredTrailingRows: parsed.ignoredTrailingRows,
      hints,
      stocktakeId,
      stocktakeNo,
    };
  }

  /** 改一行的实盘数与差异原因（只有草稿能改：已确认的单子只能冲销）。 */
  async updateLine(lineId: string, input: { actual_quantity?: string; difference_reason?: string | null }, user: CurrentUser) {
    const line = await this.prisma.stocktakeLine.findFirst({ where: { id: lineId }, include: { stocktake: { select: { id: true, status: true, stocktakeNo: true } } } });
    if (!line) throw this.notFound("STOCKTAKE_LINE_NOT_FOUND", "盘点明细行不存在");
    this.requireDraft(line.stocktake.status, line.stocktake.stocktakeNo, "修改明细");

    const data: Prisma.StocktakeLineUpdateInput = { ...this.audit.update(user) };
    if (input.actual_quantity !== undefined) {
      // 实盘数允许 0（盘没了就是 0），不允许负数：与导入解析同一口径，走平台统一的数量守卫。
      const actual = parseQuantity(input.actual_quantity, "INVALID_STOCKTAKE_ACTUAL_QUANTITY", "实际数量必须是不小于 0 的十进制数（最多 4 位小数）", { allowZero: true });
      data.actualQuantity = actual;
      data.differenceSnapshot = actual.minus(line.bookQuantitySnapshot);
    }
    if (input.difference_reason !== undefined) data.differenceReason = input.difference_reason || null;
    const updated = await this.prisma.stocktakeLine.update({ where: { id: lineId }, data });
    await this.audit.record("stocktake.line_update", "stocktake_line", user.id, lineId, {
      stocktake_no: line.stocktake.stocktakeNo, line_no: line.lineNo,
      actual_quantity: updated.actualQuantity.toString(), difference_quantity: updated.differenceSnapshot.toString(),
    });
    return { id: updated.id, actual_quantity: updated.actualQuantity.toString(), difference_snapshot: updated.differenceSnapshot.toString(), difference_reason: updated.differenceReason };
  }

  /**
   * 删掉一行（只有草稿能删）。
   *
   * 草稿行还不是业务事实（没有库存影响、没有下游单据），所以这里是**物理删除**：
   * 留着软删除的草稿行只会让下一版模板对不上行号。已确认的单子走冲销，不走这里。
   */
  async removeLine(lineId: string, user: CurrentUser) {
    const line = await this.prisma.stocktakeLine.findFirst({ where: { id: lineId }, include: { stocktake: { select: { status: true, stocktakeNo: true } } } });
    if (!line) throw this.notFound("STOCKTAKE_LINE_NOT_FOUND", "盘点明细行不存在");
    this.requireDraft(line.stocktake.status, line.stocktake.stocktakeNo, "删除明细");
    await this.prisma.stocktakeLine.delete({ where: { id: lineId } });
    await this.audit.record("stocktake.line_delete", "stocktake_line", user.id, lineId, {
      stocktake_no: line.stocktake.stocktakeNo, line_no: line.lineNo,
      product_code: line.productCodeSnapshot, actual_quantity: line.actualQuantity.toString(),
    });
    return { id: lineId };
  }

  /**
   * 确认盘点：按「确认当时的账面数」逐行重算差额，写库存调整事实。
   *
   * 为什么不在导入时就把差额定死（用户 2026-09-16 已确认这一条）：
   * 导入与确认之间仓库可能又发生了领料/入库。若按导入时的差额调账，那笔真实收发会被
   * 盘点单的调整悄悄冲掉 —— 账面上「对上了」，但那笔料其实发出去过。按确认时账面重算，
   * 等价于「把账面改成实盘数」，重复确认也不会重复调整（第二次差额已经是 0）。
   *
   * 事务内逐行加锁读账面（SELECT ... FOR UPDATE 只锁盘点单头）之外，库存事实的写入与状态
   * 变更在同一个事务里，避免出现「写了一半事实、单子还是草稿」的中间态。
   */
  async confirm(id: string, user: CurrentUser) {
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT id FROM stocktakes WHERE id = $1::uuid FOR UPDATE`, id);
      const stocktake = await tx.stocktake.findFirst({ where: { id, deletedAt: null }, include: { lines: { orderBy: { lineNo: "asc" }, include: { material: { select: { name: true, materialCode: true, deletedAt: true } } } } } });
      if (!stocktake) throw this.notFound("STOCKTAKE_NOT_FOUND", "盘点单不存在");
      this.requireDraft(stocktake.status, stocktake.stocktakeNo, "确认");
      if (!stocktake.lines.length) throw this.invalid("STOCKTAKE_EMPTY", "这张盘点单没有明细行：先导入盘点数据再确认");

      const changedAfterImport: Array<Record<string, unknown>> = [];
      const differingWithoutReason: Array<Record<string, unknown>> = [];
      let adjusted = 0;
      let unchanged = 0;
      for (const line of stocktake.lines) {
        // 物料在导入之后被删除会让账面读成 0，差额就等于实盘数 —— 那等于给一个已删除的物料平白加库存。
        // 与其静默加错，不如让操作员决定：恢复物料，或删掉这一行。
        if (line.material.deletedAt) throw this.invalid("STOCKTAKE_MATERIAL_UNAVAILABLE", `第 ${line.lineNo} 行的物料「${line.material.materialCode} ${line.material.name}」已被删除，无法调账：请恢复该物料，或删掉这一行再确认`);
        const actual = new Prisma.Decimal(line.actualQuantity);
        const live = await this.inventory.rawMaterialBalance(tx, line.materialId, line.unitId);
        const delta = actual.minus(live);
        if (!live.equals(line.bookQuantitySnapshot)) {
          changedAfterImport.push({
            line_no: line.lineNo, product_code: line.productCodeSnapshot,
            book_quantity_snapshot: line.bookQuantitySnapshot.toString(), book_quantity_at_confirm: live.toString(),
          });
        }
        if (!delta.isZero() && !line.differenceReason) {
          differingWithoutReason.push({ line_no: line.lineNo, product_code: line.productCodeSnapshot, difference_quantity: delta.toString() });
        }
        if (delta.isZero()) unchanged += 1;
        else {
          await tx.inventoryFact.create({
            data: {
              materialId: line.materialId,
              unitId: line.unitId,
              inventoryCategory: "raw_material",
              quantityDelta: delta,
              sourceType: "stocktake_adjustment",
              sourceId: line.id,
              stocktakeLineId: line.id,
              createdBy: user.id,
            },
          });
          adjusted += 1;
        }
        await tx.stocktakeLine.update({ where: { id: line.id }, data: { bookQuantityAtConfirm: live, appliedQuantity: delta, ...this.audit.update(user) } });
      }

      await tx.stocktake.update({ where: { id }, data: { status: CONFIRMED, confirmedAt: new Date(), confirmedBy: user.id, ...this.audit.update(user) } });
      return { stocktakeNo: stocktake.stocktakeNo, adjusted, unchanged, changedAfterImport, differingWithoutReason };
    });

    await this.audit.record("stocktake.confirm", "stocktake", user.id, id, {
      stocktake_no: outcome.stocktakeNo, adjusted_lines: outcome.adjusted, unchanged_lines: outcome.unchanged,
      changed_after_import: outcome.changedAfterImport.length, differing_without_reason: outcome.differingWithoutReason.length,
    });
    return { id, ...outcome };
  }

  /**
   * 冲销盘点单：把已确认的调整按行等额反向写回（与领料冲销同一做法，不删除历史事实）。
   *
   * 冲销后余额回到「确认前 + 期间真实收发」，而不是回到确认前 —— 期间发生的领料/入库不是盘点
   * 造成的，不能被冲销带走。
   */
  async reverse(id: string, reason: string, user: CurrentUser) {
    // 原因先校验、再查单子：与成品出库冲销同一顺序（也是仓库侧的一贯做法）。
    // 好处是「冲销原因没填」永远是可解释的 422，而不是先撞一个「单子不存在」的 404 把人引偏。
    const trimmed = (reason ?? "").trim();
    if (!trimmed) throw this.invalid("STOCKTAKE_REVERSAL_REASON_REQUIRED", "请填写冲销原因");
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT id FROM stocktakes WHERE id = $1::uuid FOR UPDATE`, id);
      const stocktake = await tx.stocktake.findFirst({ where: { id, deletedAt: null }, include: { lines: { orderBy: { lineNo: "asc" } } } });
      if (!stocktake) throw this.notFound("STOCKTAKE_NOT_FOUND", "盘点单不存在");
      if (stocktake.status !== CONFIRMED) {
        throw new ConflictException({ code: "STOCKTAKE_NOT_CONFIRMED", message: `盘点单 ${stocktake.stocktakeNo} 当前状态是「${this.statusLabel(stocktake.status)}」，只有已确认的盘点单可以冲销`, details: [] });
      }
      let reverted = 0;
      for (const line of stocktake.lines) {
        const applied = line.appliedQuantity ?? new Prisma.Decimal(0);
        if (applied.isZero()) continue;
        await tx.inventoryFact.create({
          data: {
            materialId: line.materialId,
            unitId: line.unitId,
            inventoryCategory: "raw_material",
            quantityDelta: applied.negated(),
            sourceType: "stocktake_reversal",
            sourceId: line.id,
            stocktakeLineId: line.id,
            createdBy: user.id,
          },
        });
        reverted += 1;
      }
      await tx.stocktake.update({ where: { id }, data: { status: REVERSED, reversedAt: new Date(), reversedBy: user.id, reversalReason: trimmed, ...this.audit.update(user) } });
      return { stocktakeNo: stocktake.stocktakeNo, reverted };
    });

    await this.audit.record("stocktake.reverse", "stocktake", user.id, id, { stocktake_no: outcome.stocktakeNo, reverted_lines: outcome.reverted, reason: trimmed });
    return { id, ...outcome, reason: trimmed };
  }

  /** 删除草稿盘点单（已确认/已冲销的单子保留，只能冲销，不能删）。 */
  async remove(id: string, user: CurrentUser) {
    const stocktake = await this.prisma.stocktake.findFirst({ where: { id, deletedAt: null } });
    if (!stocktake) throw this.notFound("STOCKTAKE_NOT_FOUND", "盘点单不存在");
    this.requireDraft(stocktake.status, stocktake.stocktakeNo, "删除");
    await this.prisma.stocktake.update({ where: { id }, data: this.audit.softDelete(user) });
    await this.audit.record("stocktake.delete", "stocktake", user.id, id, { stocktake_no: stocktake.stocktakeNo, period_month: stocktake.periodMonth });
    return { id };
  }

  /** 读工作簿第一张表：固定 `cellDates: false`（与其它导入一致），并挡住超大文件。 */
  private readImportSheet(file: UploadedWorkbook): unknown[][] {
    try {
      const book = XLSX.read(file.buffer, { type: "buffer", cellDates: false });
      const sheet = book.Sheets[book.SheetNames[0]];
      if (!sheet) throw new Error("sheet-missing");
      const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]!) : null;
      if (range) {
        const rowCount = range.e.r - range.s.r + 1;
        if (rowCount > STOCKTAKE_MAX_ROWS + 20) throw this.invalid("STOCKTAKE_IMPORT_ROWS_EXCEEDED", `单次最多导入${STOCKTAKE_MAX_ROWS}行`);
      }
      return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" }) as unknown[][];
    } catch (error) {
      if (error instanceof UnprocessableEntityException) throw error;
      throw this.invalid("STOCKTAKE_IMPORT_INVALID_FILE", "Excel文件无法解析，请使用「下载模板」得到的模板填写");
    }
  }

  /** 盘点单号：PD-当天日期-序号，与物料/供应商/客户共用同一套自动编码规则。 */
  private async nextStocktakeNo() {
    const prefix = dailyCodePrefix("PD");
    const codes = await this.prisma.stocktake.findMany({ where: { stocktakeNo: { startsWith: prefix } }, select: { stocktakeNo: true } });
    return nextSequenceCode(prefix, codes.map((row) => row.stocktakeNo));
  }

  private requireDraft(status: string, stocktakeNo: string, action: string) {
    if (status === DRAFT) return;
    throw new ConflictException({
      code: "STOCKTAKE_NOT_DRAFT",
      message: `盘点单 ${stocktakeNo} 当前状态是「${this.statusLabel(status)}」，不能${action}：已确认的盘点单只能冲销`,
      details: [],
    });
  }

  private statusLabel(status: string) {
    return status === CONFIRMED ? "已确认" : status === REVERSED ? "已冲销" : "草稿";
  }

  private headerOut(row: { id: string; stocktakeNo: string; periodMonth: string; status: string; sourceFileName: string | null; importedAt: Date | null; confirmedAt: Date | null; reversedAt: Date | null; reversalReason: string | null; remark: string | null; createdAt: Date; updatedAt: Date; createdBy: string; updatedBy: string }, lineCount: number, differingCount: number) {
    return {
      id: row.id,
      stocktake_no: row.stocktakeNo,
      period_month: row.periodMonth,
      status: row.status,
      status_label: this.statusLabel(row.status),
      source_file_name: row.sourceFileName,
      imported_at: row.importedAt,
      confirmed_at: row.confirmedAt,
      reversed_at: row.reversedAt,
      reversal_reason: row.reversalReason,
      remark: row.remark,
      created_at: row.createdAt,
      // 审计身份字段必须在**手工投影**里显式带出去：查询本身是整行透传（findMany 无 select），
      // 但这里重投影后 createdBy/updatedBy/updatedAt 会被丢掉，响应出口的
      // AuditActorInterceptor 就补不出「创建人 / 最后修改人」姓名（界面只能显示「—」）。
      // 2026-09-16 全站治理：凡是手工投影的列表/详情都要带上这三个键。
      // 只给驼峰：拦截器认的是 createdBy/updatedBy；多带一份蛇形键会让「按响应键生成列」
      // 的页面（报表页那种）把 UUID 渲染成一列。
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      updated_at: row.updatedAt,
      line_count: lineCount,
      differing_line_count: differingCount,
    };
  }

  /**
   * 汇总：计数 + **按单位**的调增/调减。
   *
   * 刻意不给一个跨单位的总计：件、kg、米 相加是没有业务含义的数，还会让人以为「一共差这么多」。
   */
  private summarize(lines: Array<{ unit_id: string; unit_name: string; difference_snapshot: string; book_quantity_at_confirm: string | null; book_quantity_snapshot: string; applied_quantity: string | null; difference_reason: string | null }>) {
    const units = new Map<string, { unit_id: string; unit_name: string; increase: Prisma.Decimal; decrease: Prisma.Decimal }>();
    let differing = 0;
    let increased = 0;
    let decreased = 0;
    let applied = 0;
    let changedAfterImport = 0;
    let differingWithoutReason = 0;
    for (const line of lines) {
      const difference = new Prisma.Decimal(line.difference_snapshot);
      const bucket = units.get(line.unit_id) ?? { unit_id: line.unit_id, unit_name: line.unit_name, increase: new Prisma.Decimal(0), decrease: new Prisma.Decimal(0) };
      if (!difference.isZero()) {
        differing += 1;
        if (difference.isPositive()) { increased += 1; bucket.increase = bucket.increase.plus(difference); }
        else { decreased += 1; bucket.decrease = bucket.decrease.plus(difference.abs()); }
        if (!line.difference_reason) differingWithoutReason += 1;
      }
      if (line.applied_quantity !== null && !new Prisma.Decimal(line.applied_quantity).isZero()) applied += 1;
      if (line.book_quantity_at_confirm !== null && !new Prisma.Decimal(line.book_quantity_at_confirm).equals(line.book_quantity_snapshot)) changedAfterImport += 1;
      units.set(line.unit_id, bucket);
    }
    return {
      line_count: lines.length,
      differing_line_count: differing,
      increased_line_count: increased,
      decreased_line_count: decreased,
      applied_line_count: applied,
      changed_after_import_count: changedAfterImport,
      differing_without_reason_count: differingWithoutReason,
      units: [...units.values()].map((bucket) => ({ unit_id: bucket.unit_id, unit_name: bucket.unit_name, increase_quantity: bucket.increase.toString(), decrease_quantity: bucket.decrease.toString() })),
    };
  }

  private notFound(code: string, message: string) { return new NotFoundException({ code, message, details: [] }); }
  private invalid(code: string, message: string) { return new UnprocessableEntityException({ code, message, details: [] }); }
}

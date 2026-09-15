import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as XLSX from "xlsx";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { orderProgressColumns, parseOperationOrder } from "./production-progress-columns.domain";

type Filters = { operation_id?: string; month?: string; order_no?: string };
const LIMIT = 10000;

type ReportRow = Prisma.EmployeeDailyReportGetPayload<{ include: { employee: { include: { department: true } }; productionOrderOperation: true } }>;

@Injectable()
export class ProductionPayrollExportService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** 工序盘点表：按月份（生产日期）统计该工序在当月所有订单下的明细，并附各订单汇总。 */
  async exportOperation(filters: { operation_id: string; month: string }, user: CurrentUser) {
    if (!filters.operation_id || !/^\d{4}-\d{2}$/.test(filters.month)) throw this.invalid("工序和月份不能为空，月份格式为YYYY-MM");
    const { from, to } = this.monthRange(filters.month);
    const rows = await this.fetchRows({ operation_id: filters.operation_id, from, to });
    const operation = await this.prisma.operationCatalog.findFirst({ where: { id: filters.operation_id }, select: { operationName: true } });
    const detailHeader = ["订单号", "生产单号", "工序", "工序日期", "工号", "员工姓名", "部门", "员工类型", "计薪方式", "计件数量", "时长（小时）", "单价", "合计", "备注"];
    const summaryHeader = ["当月各订单该工序汇总（按生产日期划分）", "订单号", "生产单号", "件数合计", "其中计件", "其中计时", "时长（小时）合计", "合计"];
    const summary = this.summarizeByOrder(rows);
    const summaryRows = summary.map((row) => [null, row.orderNo, row.productionOrderNo, this.num(row.quantity), this.num(row.pieceQuantity), this.num(row.timeQuantity), this.hours(row.duration), this.num(row.amount)]);
    const sheetRows: Array<Array<string | number | null>> = [
      ["工序盘点表"],
      ["统计月份", filters.month],
      ["工序", operation?.operationName ?? filters.operation_id],
      ["数据范围", "当月（按工序生产日期划分）所有订单的该工序有效员工日报明细；件数合计包含计时工人的计件数量，另给计件/计时拆分与时长（小时）；合计为日报保存时的金额快照（新单按 时长（小时）× 单价 计算）"],
      ["生成时间", new Date().toISOString()],
      ["操作人", user.username],
      [],
      detailHeader,
      ...rows.map((row) => this.detailRow(row)),
      [],
      summaryHeader,
      ...summaryRows,
    ];
    return this.buildSheet(sheetRows, "工序盘点表", { report_type: "工序盘点表", filters, row_count: rows.length }, user);
  }

  /** 当月工序明细总表：当月（按生产日期）所有订单、所有工序的员工日报明细，附各工序汇总。 */
  async exportMonthlyOperations(filters: { month: string }, user: CurrentUser) {
    if (!/^\d{4}-\d{2}$/.test(filters.month)) throw this.invalid("月份格式为YYYY-MM");
    const { from, to } = this.monthRange(filters.month);
    const rows = await this.fetchRows({ from, to });
    const detailHeader = ["订单号", "生产单号", "工序", "工序日期", "工号", "员工姓名", "部门", "员工类型", "计薪方式", "计件数量", "时长（小时）", "单价", "合计", "备注"];
    const summaryHeader = ["当月各工序汇总（按生产日期划分）", "工序", "件数合计", "其中计件", "其中计时", "时长（小时）合计", "合计"];
    const summary = this.summarizeByOperation(rows);
    const summaryRows = summary.map((row) => [null, row.operationName, this.num(row.quantity), this.num(row.pieceQuantity), this.num(row.timeQuantity), this.hours(row.duration), this.num(row.amount)]);
    const sheetRows: Array<Array<string | number | null>> = [
      ["当月工序明细总表"],
      ["统计月份", filters.month],
      ["数据范围", "当月（按工序生产日期划分）所有订单、所有工序的有效员工日报明细；件数合计包含计时工人的计件数量，另给计件/计时拆分与时长（小时）"],
      ["生成时间", new Date().toISOString()],
      ["操作人", user.username],
      [],
      detailHeader,
      ...rows.map((row) => this.detailRow(row)),
      [],
      summaryHeader,
      ...summaryRows,
    ];
    return this.buildSheet(sheetRows, "当月工序明细总表", { report_type: "当月工序明细总表", filters, row_count: rows.length }, user);
  }

  /** 订单号盘点表：单订单明细（时长小时、合计），表头附每道工序的生产日期数组、计划数量与汇总数量；可选按生产日期月份过滤。 */
  async exportOrder(filters: { order_no: string; operation_id?: string; month?: string }, user: CurrentUser) {
    if (!filters.order_no?.trim()) throw this.invalid("订单号不能为空");
    const monthValid = /^\d{4}-\d{2}$/.test(filters.month ?? "");
    const range = monthValid ? this.monthRange(filters.month!) : undefined;
    const rows = await this.fetchRows({ order_no: filters.order_no.trim(), operation_id: filters.operation_id, ...(range ?? {}) });
    const operation = filters.operation_id ? await this.prisma.operationCatalog.findFirst({ where: { id: filters.operation_id }, select: { operationName: true } }) : null;
    const detailHeader = ["订单号", "生产单号", "工序", "工序日期", "工号", "员工姓名", "部门", "员工类型", "计薪方式", "计件数量", "时长（小时）", "单价", "合计", "备注"];
    const operationHeader = rows.length ? this.operationHeaderRows(rows) : [];
    const sheetRows: Array<Array<string | number | null>> = [
      ["订单号盘点表"],
      ["订单号", filters.order_no],
      ...(monthValid ? [["统计月份（按生产日期过滤）", filters.month!]] : []),
      ["工序", operation?.operationName ?? "全部工序"],
      ["数据范围", "该订单号下全部有效工序员工日报；计件数量对计时/计件工人都展示（计时工人同样填报完成件数），计时另给时长（小时）"],
      ["生成时间", new Date().toISOString()],
      ["操作人", user.username],
      [],
      ...operationHeader,
      [],
      detailHeader,
      ...rows.map((row) => this.detailRow(row)),
    ];
    return this.buildSheet(sheetRows, "订单号盘点表", { report_type: "订单号盘点表", filters, row_count: rows.length }, user);
  }

  /** 原料对应表：该订单号的采购明细（原「材料与车间生产对应表」的上表，现已拆成独立导出表）。 */
  async exportMaterialReference(filters: { order_no: string }, user: CurrentUser) {
    const { orderNo, sales, purchaseOrders } = await this.materialProductionContext(filters);
    const orderQuantity = sales?.quantity?.toString() ?? "";
    const materialRows: Array<Array<string | number | null>> = purchaseOrders.flatMap((po) => this.materialRowsOf(po, orderNo, orderQuantity));
    if (!materialRows.length) materialRows.push([orderNo, this.num(orderQuantity), "（无采购记录）", null, null, "", "", "", "", ""]);
    const sheetRows: Array<Array<string | number | null>> = [
      ["原料对应表"],
      ["订单号", orderNo],
      ["产品", sales?.productName ?? ""],
      ["生成时间", new Date().toISOString()],
      ["操作人", user.username],
      [],
      ["订单号", "订单数量", "规格", "单价", "数量", "采购日期", "到货日期", "供货日期", "供应商", "备注"],
      ...materialRows,
    ];
    return this.buildSheet(sheetRows, "原料对应表", { report_type: "原料对应表", filters, material_rows: materialRows.length }, user);
  }

  /** 生产进度表：工序 × 生产日期的二维矩阵（原「材料与车间生产对应表」的下表，现已拆成独立导出表）。 */
  async exportProductionProgress(filters: { order_no: string; operation_order?: string }, user: CurrentUser) {
    const { orderNo, sales, productionOrders } = await this.materialProductionContext(filters);
    // 用户在导出面板里拖拽过的工序列顺序（逗号分隔 id）：只排列表头，不改任何数量口径。
    const operationOrder = parseOperationOrder(filters.operation_order);
    const { progressHeader, progressRows, shippedQuantity } = await this.progressSheet(orderNo, productionOrders, operationOrder);
    const sheetRows: Array<Array<string | number | null>> = [
      ["生产进度表"],
      ["订单号", orderNo],
      ["产品", sales?.productName ?? ""],
      ["生成时间", new Date().toISOString()],
      ["操作人", user.username],
      ["出货数量", shippedQuantity],
      [],
      ["每列为一个工序，行为生产日期，单元格为当日该工序的完成数量"],
      progressHeader,
      ...progressRows,
    ];
    // 把用到的顺序写进导出元信息：拿到文件的人能看出列序是人工调整过的。
    return this.buildSheet(sheetRows, "生产进度表", { report_type: "生产进度表", filters, progress_rows: progressRows.length, ...(operationOrder.length ? { operation_order: operationOrder } : {}) }, user);
  }

  /** 两张导出表共用的取数（销售单 + 采购明细 + 生产单工序）。 */
  private async materialProductionContext(filters: { order_no: string }) {
    if (!filters.order_no?.trim()) throw this.invalid("订单号不能为空");
    const orderNo = filters.order_no.trim();
    const [sales, purchaseOrders, productionOrders] = await Promise.all([
      this.prisma.salesOrder.findFirst({ where: { orderNo, deletedAt: null }, select: { quantity: true, productName: true } }),
      this.prisma.purchaseOrder.findMany({ where: { orderNo, deletedAt: null }, orderBy: { purchaseDate: "asc" }, include: { items: { where: { deletedAt: null }, include: { material: true, receipts: { where: { deletedAt: null }, orderBy: { receivedDate: "asc" } } } }, supplier: true } }),
      this.prisma.productionOrder.findMany({ where: { orderNo, deletedAt: null, NOT: { status: "cancelled" } }, include: { executionLocation: true, operations: { where: { deletedAt: null, NOT: { status: "cancelled" } }, orderBy: { sequenceNo: "asc" } } } }),
    ]);
    return { orderNo, sales, purchaseOrders, productionOrders };
  }

  private materialRowsOf(po: Awaited<ReturnType<ProductionPayrollExportService["materialProductionContext"]>>["purchaseOrders"][number], orderNo: string, orderQuantity: string): Array<Array<string | number | null>> {
    return po.items.map((item) => {
      const arrival = (item.receipts ?? []).map((receipt) => receipt.receivedDate.toISOString().slice(0, 10)).join("、");
      const supply = item.expectedDate ? item.expectedDate.toISOString().slice(0, 10) : po.expectedDate ? po.expectedDate.toISOString().slice(0, 10) : "";
      const supplierName = (item.supplierSnapshot as { name?: string } | null)?.name ?? po.supplier?.name ?? "";
      return [orderNo, this.num(orderQuantity), item.material?.name ?? "", this.num(item.unitPrice), this.num(item.quantity), po.purchaseDate ? po.purchaseDate.toISOString().slice(0, 10) : "", arrival, supply, supplierName, po.remark ?? ""];
    });
  }

  /**
   * 生产进度表：**列 = 工序，行 = 日期**。
   *
   * 表头方向是客户按 A4 打印反馈后调整的：原来「行 = 工序、列 = 日期」，
   * 一个月就有 30+ 列，横向必然超出 A4；换成工序做列之后列数等于工序数（本厂约 14 个），
   * 行数随日期增长（纸面纵向增长，可翻页），整张表更容易落进一张 A4（横向或纵向皆可）。
   *
   * 表体结构（信息不丢）：
   *   日期 | 工序A | 工序B | …
   *   目标数量 | …每个工序的计划数量…
   *   加工地点 | …每个工序的执行地点…
   *   2026-09-01 | …当日完成数量…
   *   …
   *   合计 | …每个工序的累计数量…
   * 出货数量作为单一数值放在表头上方的元信息里（它不属于任何单个工序）。
   *
   * 「当日合计」列已按业务要求去掉：横排各工序相加没有业务含义（同一产品的不同工序会重复计数），
   * 而且它会让 A4 版面多占一列；表尾仍按工序给出累计量，读者需要横向汇总时可用 Excel 自行求和。
   *
   * `operationOrder`（用户 2026-09-15 要求）：导出面板里拖拽调整过的工序顺序，按它排列表头。
   * 只影响列的先后，不改任何数量口径；没提到的工序按原相对顺序排在后面（新增工序不会丢列）。
   */
  private async progressSheet(orderNo: string, productionOrders: Awaited<ReturnType<ProductionPayrollExportService["materialProductionContext"]>>["productionOrders"], operationOrder: string[] = []) {
    const productionIds = productionOrders.map((po) => po.id);
    const daily = productionIds.length ? await this.prisma.employeeDailyReport.groupBy({ by: ["productionOrderOperationId", "reportDate"], where: { productionOrderId: { in: productionIds }, deletedAt: null }, _sum: { quantity: true } }) : [];
    const dates = [...new Set(daily.map((row) => row.reportDate.toISOString().slice(0, 10)))].sort();
    const quantityByOperationDate = new Map<string, Prisma.Decimal>();
    for (const row of daily) {
      const key = `${row.productionOrderOperationId}|${row.reportDate.toISOString().slice(0, 10)}`;
      quantityByOperationDate.set(key, (quantityByOperationDate.get(key) ?? new Prisma.Decimal(0)).plus(row._sum.quantity ?? 0));
    }
    const shipped = await this.prisma.finishedGoodsOutbound.aggregate({ where: { orderNo, deletedAt: null, status: { in: ["posted", "shipped", "signed"] } }, _sum: { quantity: true } });
    const shippedQuantity = this.num(shipped._sum.quantity);

    // 工序列：把「生产单 × 工序」摊平成列。同一工序名出现多次时补生产单号，避免列名重复无法区分。
    // 最后按用户拖拽的顺序重排（`operation_order`）：它是导出显示偏好，不是生产顺序。
    const columns = orderProgressColumns(productionOrders.flatMap((po) => po.operations.map((operation) => ({
      id: operation.id,
      name: operation.operationNameSnapshot,
      target: this.num(operation.targetQuantity),
      location: po.executionLocation?.name ?? "",
    }))), operationOrder);
    const nameCounts = columns.reduce<Record<string, number>>((acc, column) => ({ ...acc, [column.name]: (acc[column.name] ?? 0) + 1 }), {});
    const columnLabels = columns.map((column) => (nameCounts[column.name] > 1 ? `${column.name}（${column.name === "" ? "未命名" : ""}${productionOrders.find((po) => po.operations.some((operation) => operation.id === column.id))?.productionOrderNo ?? ""}）` : column.name));

    const progressHeader: Array<string | number | null> = ["日期", ...columnLabels];
    const targetRow: Array<string | number | null> = ["目标数量", ...columns.map((column) => column.target)];
    const locationRow: Array<string | number | null> = ["加工地点", ...columns.map((column) => column.location)];
    const progressRows: Array<Array<string | number | null>> = [targetRow, locationRow];
    const columnTotals = columns.map(() => new Prisma.Decimal(0));
    for (const date of dates) {
      const cells = columns.map((column, index) => {
        const quantity = quantityByOperationDate.get(`${column.id}|${date}`);
        if (!quantity) return null;
        columnTotals[index] = columnTotals[index].plus(quantity);
        return this.num(quantity);
      });
      progressRows.push([date, ...cells]);
    }
    // 表尾合计：每个工序的累计量；没有日报时也保留这一行，读者能确定「确实是 0」而不是漏了行。
    progressRows.push(["合计", ...columnTotals.map((total) => this.num(total))]);
    return { progressHeader, progressRows, shippedQuantity };
  }

  /**
   * 兼容旧入口：仍把上表/下表放在同一个工作簿里（历史链接与旧调用方）。
   * 导出面板已拆成「原料对应表」「生产进度表」两个独立导出。
   */
  async exportMaterialProduction(filters: { order_no: string }, user: CurrentUser) {
    const { orderNo, sales, purchaseOrders, productionOrders } = await this.materialProductionContext(filters);
    const orderQuantity = sales?.quantity?.toString() ?? "";
    const materialRows: Array<Array<string | number | null>> = purchaseOrders.flatMap((po) => this.materialRowsOf(po, orderNo, orderQuantity));
    if (!materialRows.length) materialRows.push([orderNo, this.num(orderQuantity), "（无采购记录）", null, null, "", "", "", "", ""]);
    const { progressHeader, progressRows, shippedQuantity } = await this.progressSheet(orderNo, productionOrders);
    const sheetRows: Array<Array<string | number | null>> = [
      ["材料与车间生产对应表"],
      ["订单号", orderNo],
      ["产品", sales?.productName ?? ""],
      ["生成时间", new Date().toISOString()],
      ["操作人", user.username],
      [],
      ["上表：原料对应表"],
      ["订单号", "订单数量", "规格", "单价", "数量", "采购日期", "到货日期", "供货日期", "供应商", "备注"],
      ...materialRows,
      [],
      ["下表：生产进度表（每列为一个工序，行为生产日期，单元格为当日该工序的完成数量）"],
      ["出货数量", shippedQuantity],
      progressHeader,
      ...progressRows,
    ];
    return this.buildSheet(sheetRows, "材料与车间生产对应表", { report_type: "材料与车间生产对应表", filters, material_rows: materialRows.length, progress_rows: progressRows.length }, user);
  }

  private async fetchRows(filters: Filters & { from?: Date; to?: Date }) {
    const rows = await this.prisma.employeeDailyReport.findMany({
      where: { deletedAt: null, ...(filters.order_no ? { orderNo: filters.order_no } : {}), ...(filters.from || filters.to ? { reportDate: { gte: filters.from, lt: filters.to } } : {}), ...(filters.operation_id ? { productionOrderOperation: { OR: [{ id: filters.operation_id }, { operationCatalogId: filters.operation_id }] } } : {}) },
      include: { employee: { include: { department: true } }, productionOrderOperation: true },
      orderBy: [{ reportDate: "asc" }, { orderNo: "asc" }, { operationNameSnapshot: "asc" }, { employeeNameSnapshot: "asc" }],
      take: LIMIT + 1,
    });
    if (rows.length > LIMIT) throw new UnprocessableEntityException({ code: "EXPORT_LIMIT_EXCEEDED", message: "导出结果过多，请缩小筛选范围", details: [{ limit: LIMIT }] });
    return rows;
  }

  /**
   * 明细行。计时单位统一为小时：计时行展示 时长（小时）＝ 落库分钟 ÷ 60。
   * 计件数量对**所有计薪方式**都要展示：客户反馈「计时工人的计件数量也要在里面」——
   * 计时工人同样会填报完成件数，只把它藏起来会让盘点表对不上工序产量。
   */
  private detailRow(row: ReportRow) {
    const duration = row.wageMode === "time_rate" ? this.hours(row.durationMinutes) : null;
    return [row.orderNo, row.productionOrderNoSnapshot, row.operationNameSnapshot, row.reportDate.toISOString().slice(0, 10), row.employee.employeeNo, row.employeeNameSnapshot, row.employee.department.name, row.employee.employeeType === "workshop" ? "车间" : "非车间", row.wageMode === "piece_rate" ? "计件" : "计时", this.num(row.quantity), duration, this.num(row.unitPrice), this.num(row.calculatedAmount), row.remark ?? ""];
  }

  /** 订单号盘点表表头：每道工序的生产日期数组、计划数量、汇总数量。 */
  private operationHeaderRows(rows: ReportRow[]) {
    const byOperation = new Map<string, { name: string; target: Prisma.Decimal | null; dates: Set<string>; quantity: Prisma.Decimal }>();
    for (const row of rows) {
      const group = byOperation.get(row.productionOrderOperationId) ?? { name: row.operationNameSnapshot, target: row.productionOrderOperation?.targetQuantity ?? null, dates: new Set<string>(), quantity: new Prisma.Decimal(0) };
      group.dates.add(row.reportDate.toISOString().slice(0, 10));
      group.quantity = group.quantity.plus(row.quantity);
      byOperation.set(row.productionOrderOperationId, group);
    }
    const header: Array<Array<string | number | null>> = [["各工序生产概况"]];
    for (const group of byOperation.values()) {
      header.push(["工序", group.name, "生产日期", [...group.dates].sort().join("、"), "计划数量", this.num(group.target), "汇总数量", this.num(group.quantity)]);
    }
    return header;
  }

  private summarizeByOrder(rows: ReportRow[]) {
    const groups = new Map<string, { orderNo: string; productionOrderNo: string; quantity: Prisma.Decimal; pieceQuantity: Prisma.Decimal; timeQuantity: Prisma.Decimal; duration: Prisma.Decimal; amount: Prisma.Decimal }>();
    for (const row of rows) {
      const group = groups.get(row.productionOrderNoSnapshot) ?? { orderNo: row.orderNo, productionOrderNo: row.productionOrderNoSnapshot, quantity: new Prisma.Decimal(0), pieceQuantity: new Prisma.Decimal(0), timeQuantity: new Prisma.Decimal(0), duration: new Prisma.Decimal(0), amount: new Prisma.Decimal(0) };
      // 件数合计包含所有计薪方式（计时工人的计件数量也要算），并额外给出计件/计时两个拆分列。
      group.quantity = group.quantity.plus(row.quantity);
      if (row.wageMode === "piece_rate") group.pieceQuantity = group.pieceQuantity.plus(row.quantity);
      if (row.wageMode === "time_rate") { group.timeQuantity = group.timeQuantity.plus(row.quantity); group.duration = group.duration.plus(row.durationMinutes ?? 0); }
      group.amount = group.amount.plus(row.calculatedAmount);
      groups.set(row.productionOrderNoSnapshot, group);
    }
    return [...groups.values()];
  }

  private summarizeByOperation(rows: ReportRow[]) {
    const groups = new Map<string, { operationName: string; quantity: Prisma.Decimal; pieceQuantity: Prisma.Decimal; timeQuantity: Prisma.Decimal; duration: Prisma.Decimal; amount: Prisma.Decimal }>();
    for (const row of rows) {
      const group = groups.get(row.operationNameSnapshot) ?? { operationName: row.operationNameSnapshot, quantity: new Prisma.Decimal(0), pieceQuantity: new Prisma.Decimal(0), timeQuantity: new Prisma.Decimal(0), duration: new Prisma.Decimal(0), amount: new Prisma.Decimal(0) };
      group.quantity = group.quantity.plus(row.quantity);
      if (row.wageMode === "piece_rate") group.pieceQuantity = group.pieceQuantity.plus(row.quantity);
      if (row.wageMode === "time_rate") { group.timeQuantity = group.timeQuantity.plus(row.quantity); group.duration = group.duration.plus(row.durationMinutes ?? 0); }
      group.amount = group.amount.plus(row.calculatedAmount);
      groups.set(row.operationNameSnapshot, group);
    }
    return [...groups.values()];
  }

  /**
   * 分钟 -> 小时展示（最多 8 位小数、去掉尾随零）。
   * 落库单位始终是分钟，小时仅用于录入/展示，因此所有导出与接口的“小时”都必须走这里换算，
   * 避免出现“表头写小时、单元格还是分钟”的口径错位。
   */
  private hours(durationMinutes: Prisma.Decimal | null) {
    if (durationMinutes === null || durationMinutes === undefined) return null;
    return Number(this.trimZeros(new Prisma.Decimal(durationMinutes).div(60).toFixed(8)));
  }

  /**
   * 数值单元格：必须落成 Excel 的**数字类型**，不能写成字符串。
   *
   * 文本型数字在 Excel 里会被当成文字：求和得 0、筛选分不出区间、排序按字典序（"100" < "20"）。
   * 因此所有数量、单价、金额、时长都必须经过这里转成 number；空值返回 null（空单元格），
   * 而不是 ""（那同样是一格文本）。
   */
  private num(value: Prisma.Decimal | string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!text) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private trimZeros(value: string) { return value.replace(/0+$/, "").replace(/\.$/, ""); }

  private monthRange(month: string) {
    const from = new Date(`${month}-01T00:00:00.000Z`);
    return { from, to: new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)) };
  }

  private async buildSheet(sheetRows: Array<Array<string | number | null>>, title: string, auditDetails: Record<string, unknown>, user: CurrentUser) {
    const width = Math.max(...sheetRows.map((row) => row.length), 14);
    const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
    sheet["!cols"] = Array.from({ length: width }, () => ({ wch: 18 }));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, title);
    await this.audit.record("production_payroll_export", "employee_daily_report", user.id, undefined, { ...auditDetails });
    return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  }

  private invalid(message: string) { return new UnprocessableEntityException({ code: "INVALID_EXPORT_FILTER", message, details: [] }); }
}

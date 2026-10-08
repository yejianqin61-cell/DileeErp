import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as XLSX from "xlsx";
import { AuditService } from "../../platform/audit/audit.service";
import { AuditActorService, withActorNames, type AuditActorNames } from "../../platform/audit/audit-actor.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { beijingDateTime } from "../../platform/time/beijing-time";
import { orderProgressColumns, parseOperationOrder } from "./production-progress-columns.domain";

/** 明细三张表（工序盘点 / 订单号盘点 / 当月工序明细）末尾的审计四列（2026-09-16 全站治理）。 */
const DETAIL_AUDIT_HEADER = ["创建人", "创建时间", "最后修改人", "最后修改时间"] as const;

/**
 * 生产月报表（总表）的工序列顺序 —— 照抄用户手工台账 `example/财务/2026.6月同安.xlsx` 的 Sheet1。
 *
 * 这里只决定**列序**，不决定列集合：工序字典 `operation_catalogs` 运行时可改
 * （apps/web/app/production/operations/page.tsx），写死列集合会在用户新增/停用工序时静默丢掉数量。
 * `aliases` 是客户叫法与字典名的对应（验伞面＝验片、品验＝品检）；字典里自己就有这个名字时不再当别名，
 * 免得把两道真工序并成一列。
 *
 * 模板里**没有数据源、刻意不做**的东西（不发明）：
 *   · 通用工序「大裁」下的 布 / 伞带 / 布套 三小列 —— 日报只有工序+数量，没有料件维度；
 *   · 「计时」列 —— 计时是计薪方式（employee_daily_reports.wageMode）不是工序，
 *     把它当列会把同一批数量与它自己的工序列重复计一次；
 *   · 末尾的「房补」「总合计」行 —— 全库没有任何住房补贴字段；
 *   · 外包对账单 sheet（刘伟群 / 傅振锋）与 布套 / 拉伞带 —— 前者没有逐工序数据，后者没有工序列。
 */
const MONTHLY_TEMPLATE_COLUMNS: Array<{ label: string; aliases?: string[]; splitByExecutionMode?: boolean }> = [
  { label: "大裁" },
  { label: "拉边", splitByExecutionMode: true },
  { label: "小裁" },
  { label: "合片" },
  { label: "验片", aliases: ["验伞面"] },
  { label: "打顶打带" },
  { label: "打珠尾" },
  { label: "缝伞" },
  { label: "品检", aliases: ["品验"] },
  { label: "包装" },
];

/** 总表 sheet 名（与导出文件名、导出面板按钮同名，用户能互相对照）。 */
const MONTHLY_REPORT_SHEET = "生产月报表";
/** 多单位无法相加时写进格子的文字。留空会被当成漏算，给 0 更糟（0 是「真的没做」）。 */
const UNIT_MIXED_MARKER = "单位不一致，不合计";
/**
 * 总表末列的列名。
 *
 * 刻意**不叫**「合计」：同一件产品要经过多道工序，横向相加会把同一批货数好几遍
 * （缝伞 218 打 + 包装 218 打 = 436 打，而订单只有 218 打）。生产进度表因此干脆不做横向合计
 * （`production-progress.service.ts:188-190`）。这里保留这一列只当**量级核对**，
 * 所以把口径写进列名本身 —— 备注栏里的说明没人会读，列名是唯一一定会被看到的地方。
 */
export const ROW_TOTAL_LABEL = "各工序合计（非完工量）";

type Filters = { operation_id?: string; month?: string; order_no?: string };
const LIMIT = 10000;

type ReportRow = Prisma.EmployeeDailyReportGetPayload<{ include: { employee: { include: { department: true } }; productionOrderOperation: true } }>;

@Injectable()
export class ProductionPayrollExportService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly actors: AuditActorService) {}

  /** 工序盘点表：按月份（生产日期）统计该工序在当月所有订单下的明细，并附各订单汇总。 */
  async exportOperation(filters: { operation_id: string; month: string }, user: CurrentUser) {
    if (!filters.operation_id || !/^\d{4}-\d{2}$/.test(filters.month)) throw this.invalid("工序和月份不能为空，月份格式为YYYY-MM");
    const { from, to } = this.monthRange(filters.month);
    const rows = await this.fetchRows({ operation_id: filters.operation_id, from, to });
    const operation = await this.prisma.operationCatalog.findFirst({ where: { id: filters.operation_id }, select: { operationName: true } });
    const detailHeader = ["订单号", "生产单号", "工序", "工序日期", "工号", "员工姓名", "部门", "员工类型", "计薪方式", "计件数量", "时长（小时）", "单价", "合计", "备注", ...DETAIL_AUDIT_HEADER];
    const summaryHeader = ["当月各订单该工序汇总（按生产日期划分）", "订单号", "生产单号", "件数合计", "其中计件", "其中计时", "时长（小时）合计", "合计"];
    const summary = this.summarizeByOrder(rows);
    const summaryRows = summary.map((row) => [null, row.orderNo, row.productionOrderNo, this.num(row.quantity), this.num(row.pieceQuantity), this.num(row.timeQuantity), this.hours(row.duration), this.num(row.amount)]);
    const sheetRows: Array<Array<string | number | null>> = [
      ["工序盘点表"],
      ["统计月份", filters.month],
      ["工序", operation?.operationName ?? filters.operation_id],
      ["数据范围", "当月（按工序生产日期划分）所有订单的该工序有效员工日报明细；件数合计包含计时工人的计件数量，另给计件/计时拆分与时长（小时）；合计为日报保存时的金额快照（新单按 时长（小时）× 单价 计算）"],
      ["生成时间", beijingDateTime(new Date(), { seconds: true })],
      // 这里原先写「操作人」，但它取的是 user.username —— **点导出的人**，不是这条记录的操作人。
      // 两者混用会让审计误判（见 docs/design/operator-and-timestamp-governance-2026-09-16.md 验收标准 4）。
      ["导出人", user.username],
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
    const detailHeader = ["订单号", "生产单号", "工序", "工序日期", "工号", "员工姓名", "部门", "员工类型", "计薪方式", "计件数量", "时长（小时）", "单价", "合计", "备注", ...DETAIL_AUDIT_HEADER];
    const summaryHeader = ["当月各工序汇总（按生产日期划分）", "工序", "件数合计", "其中计件", "其中计时", "时长（小时）合计", "合计"];
    const summary = this.summarizeByOperation(rows);
    const summaryRows = summary.map((row) => [null, row.operationName, this.num(row.quantity), this.num(row.pieceQuantity), this.num(row.timeQuantity), this.hours(row.duration), this.num(row.amount)]);
    const sheetRows: Array<Array<string | number | null>> = [
      ["当月工序明细总表"],
      ["统计月份", filters.month],
      ["数据范围", "当月（按工序生产日期划分）所有订单、所有工序的有效员工日报明细；件数合计包含计时工人的计件数量，另给计件/计时拆分与时长（小时）"],
      ["生成时间", beijingDateTime(new Date(), { seconds: true })],
      // 这里原先写「操作人」，但它取的是 user.username —— **点导出的人**，不是这条记录的操作人。
      // 两者混用会让审计误判（见 docs/design/operator-and-timestamp-governance-2026-09-16.md 验收标准 4）。
      ["导出人", user.username],
      [],
      detailHeader,
      ...rows.map((row) => this.detailRow(row)),
      [],
      summaryHeader,
      ...summaryRows,
    ];
    return this.buildSheet(sheetRows, "当月工序明细总表", { report_type: "当月工序明细总表", filters, row_count: rows.length }, user);
  }

  /**
   * 生产月报表（用户要打印给车间的月度产量表）：**总表 + 每道工序一张明细 sheet**，
   * 形状照抄手工台账 `example/财务/2026.6月同安.xlsx`（Sheet1 是总表，其余 sheet 一道工序一张）。
   *
   * 数量口径（用户明确要求「与生产进度页现有口径一致：两者取大」）：
   *   · 工序日报与员工日报是**同一事实的两个人工登记面**（production-progress.service.ts:121-123：
   *     相加会双重计数，只取一个会低估，所以生产进度页取 max）。这里沿用同一条规则。
   *   · 月报把它细化到 **(订单号, 工序, 单位, 生产单执行方式, 日期)** 逐日取大后再累加：
   *     一个月里两个面常常落在不同日子，整月取大 `max(月合计, 月合计)` 会把「3 号只录了工序日报、
   *     7 号只录了员工日报」中的一段整块丢掉 —— 逐日取大既不会重复计数也不会漏。
   *   · 单位与执行方式进键是两条硬约束：全站纪律「数量不跨单位合计」（reorder.domain.ts:11），
   *     以及本厂/外发是两批不同的活（同一道工序名不等于同一批货，production-progress.service.ts:138-141
   *     也只让 in_house 生产单展开工序计量行）。
   *
   * 明细 sheet 的**工人列只能来自 employee_daily_reports**（只有它有员工维度），
   * 汇总列则与总表取同一份计算结果 —— 当工序日报大于员工日报时，工人列之和会小于汇总列，sheet 表头已写明。
   */
  async exportMonthlyProduction(filters: { month: string }, user: CurrentUser) {
    if (!/^\d{4}-\d{2}$/.test(filters.month)) throw this.invalid("月份格式为YYYY-MM");
    const { from, to } = this.monthRange(filters.month);
    // 员工日报仍走 fetchRows：复用 LIMIT=10000 的护栏与「一次解析审计姓名」的既有做法，不另开一条取数路径。
    const employeeRows = await this.fetchRows({ from, to });
    const [operationDaily, catalog] = await Promise.all([
      // 工序日报按 (订单号, 工序, 生产单工序, 日期) 分组：分组后行数上界是「订单数 × 工序数 × 天数」，
      // 与日报明细条数无关，所以这里不再套一层 LIMIT —— 护栏挡的是逐行明细（见 fetchRows 的 EXPORT_LIMIT_EXCEEDED）。
      this.prisma.operationDailyReport.groupBy({ by: ["orderNo", "operationNameSnapshot", "productionOrderOperationId", "reportDate"], where: { deletedAt: null, reportDate: { gte: from, lt: to } }, _sum: { completedQuantity: true } }),
      // 列集合读字典，绝不写死（工序字典运行时可改）。顺序取与工序下拉一致的 operationName 升序。
      this.prisma.operationCatalog.findMany({ where: { deletedAt: null }, select: { operationName: true }, orderBy: { operationName: "asc" } }),
    ]);
    // 生产单工序的元数据（单位 + 生产单执行方式）**一次**取回，逐行查会变成 N+1。
    // 不过滤 deletedAt：日报是历史事实，工序后来被停用/删除也必须能取到它当时的单位。
    const operationIds = [...new Set([...employeeRows.map((row) => row.productionOrderOperationId), ...operationDaily.map((row) => row.productionOrderOperationId)])];
    const operationMeta = new Map<string, { unit: string; executionMode: "in_house" | "outsourced" }>();
    if (operationIds.length) {
      const operations = await this.prisma.productionOrderOperation.findMany({ where: { id: { in: operationIds } }, select: { id: true, unit: { select: { name: true } }, productionOrder: { select: { executionMode: true } } } });
      for (const operation of operations) operationMeta.set(operation.id, { unit: operation.unit.name, executionMode: operation.productionOrder.executionMode === "outsourced" ? "outsourced" : "in_house" });
    }
    // 元数据取不到时**不丢数量**：单位记空、执行方式按本厂 —— 数字出现在表里等人核对，
    // 好过静默消失（静默丢失正是这类导出最贵的故障）。
    const metaOf = (operationId: string) => operationMeta.get(operationId) ?? { unit: "", executionMode: "in_house" as const };

    type Cell = { orderNo: string; operationName: string; unit: string; executionMode: "in_house" | "outsourced"; quantity: Prisma.Decimal; mismatch: boolean };
    const keyOf = (parts: string[]) => parts.join("\u0000");
    const cellKeyOf = (orderNo: string, operationName: string, unit: string, executionMode: string) => keyOf([orderNo, operationName, unit, executionMode]);

    // 第一步：把两个登记面各自的**日合计**摊到同一张日表上，第二步才逐日取大。
    // 「不跨单位合计」在数据结构上就落地了：不同单位/不同执行方式的日合计根本不在同一个桶里。
    const dayTotals = new Map<string, { operation: Prisma.Decimal; employee: Prisma.Decimal }>();
    const addDayTotal = (key: string, surface: "operation" | "employee", quantity: Prisma.Decimal) => {
      const current = dayTotals.get(key) ?? { operation: new Prisma.Decimal(0), employee: new Prisma.Decimal(0) };
      current[surface] = current[surface].plus(quantity);
      dayTotals.set(key, current);
    };
    for (const row of employeeRows) {
      const meta = metaOf(row.productionOrderOperationId);
      addDayTotal(keyOf([row.orderNo, row.operationNameSnapshot, meta.unit, meta.executionMode, row.reportDate.toISOString().slice(0, 10)]), "employee", new Prisma.Decimal(row.quantity));
    }
    for (const row of operationDaily) {
      const meta = metaOf(row.productionOrderOperationId);
      addDayTotal(keyOf([row.orderNo, row.operationNameSnapshot, meta.unit, meta.executionMode, row.reportDate.toISOString().slice(0, 10)]), "operation", new Prisma.Decimal(row._sum.completedQuantity ?? 0));
    }
    const cells = new Map<string, Cell>();
    for (const [dayKey, totals] of dayTotals) {
      // 前四段还原成单元格键；第五段是日期，累加时不关心（split 出的第五项直接被忽略）。
      const [orderNo, operationName, unit, executionMode] = dayKey.split("\u0000");
      const dayQuantity = totals.operation.gte(totals.employee) ? totals.operation : totals.employee;
      const cellKey = cellKeyOf(orderNo, operationName, unit, executionMode);
      const cell = cells.get(cellKey) ?? { orderNo, operationName, unit, executionMode: executionMode as "in_house" | "outsourced", quantity: new Prisma.Decimal(0), mismatch: false };
      cell.quantity = cell.quantity.plus(dayQuantity);
      // 「两源不一致」只在**同一天两个面都报了数、且数不同**时标：只有一个面报数是常态（另一面还没录），标出来全是噪音。
      if (totals.operation.gt(0) && totals.employee.gt(0) && !totals.operation.eq(totals.employee)) cell.mismatch = true;
      cells.set(cellKey, cell);
    }

    // 列：模板顺序在前（只在字典里还有这道工序时出现），再按字典顺序追加「当月有数据」的其余工序，
    // 最后补上「有数据但已不在字典里」的工序名（历史快照可能改名/停用）。三层兜底，没有数量被静默丢掉。
    const catalogNames = catalog.map((row) => row.operationName);
    const catalogNameSet = new Set(catalogNames);
    const dataNames = [...new Set([...cells.values()].map((cell) => cell.operationName))];
    type Column = { label: string; names: string[]; executionMode?: "in_house" | "outsourced" };
    const columns: Column[] = [];
    const consumed = new Set<string>();
    for (const slot of MONTHLY_TEMPLATE_COLUMNS) {
      const resolved = [slot.label, ...(slot.aliases ?? [])].find((name) => catalogNameSet.has(name));
      if (!resolved) continue; // 字典里已经没有这道工序（停用/删除）——不出一列空列
      const names = [resolved, ...(slot.aliases ?? []).filter((alias) => !catalogNameSet.has(alias) && dataNames.includes(alias))];
      names.forEach((name) => consumed.add(name));
      if (slot.splitByExecutionMode) columns.push({ label: `${resolved}-本厂`, names, executionMode: "in_house" }, { label: `${resolved}-外发`, names, executionMode: "outsourced" });
      else columns.push({ label: resolved, names });
    }
    for (const name of catalogNames) if (!consumed.has(name) && dataNames.includes(name)) { consumed.add(name); columns.push({ label: name, names: [name] }); }
    for (const name of dataNames) if (!consumed.has(name)) { consumed.add(name); columns.push({ label: name, names: [name] }); }

    // 一格 = 一个 (订单号, 工序) 在该列范围内的全部单位分组；同单位多个执行方式可以相加（那是两批不同的活，不是同一批的两次登记）。
    const cellsOf = (column: Column, orderNo: string) =>
      [...cells.values()]
        .filter((cell) => cell.orderNo === orderNo && column.names.includes(cell.operationName) && (!column.executionMode || cell.executionMode === column.executionMode))
        // 单位名与执行方式一起定序，同一份数据每次导出长得一样（按码位比，不用 localeCompare，见 reorder.domain.ts:60-67）。
        .sort((left, right) => this.byCodeUnit(left.unit, right.unit) || this.byCodeUnit(left.executionMode, right.executionMode));

    /**
     * 单元格取值：**单单位给数值**（Excel 里必须能求和/筛选/排序，见 num()）；
     * 多单位时按单位分行拼成文字，绝不相加 —— 「数量不跨单位合计」是全站纪律（reorder.domain.ts:11）。
     */
    const cellValue = (column: Column, orderNo: string): string | number | null => {
      const matched = cellsOf(column, orderNo);
      if (!matched.length) return null;
      const units = [...new Set(matched.map((cell) => cell.unit))];
      if (units.length === 1) return this.num(matched.reduce((sum, cell) => sum.plus(cell.quantity), new Prisma.Decimal(0)));
      return matched.map((cell) => `${this.num(cell.quantity) ?? 0} ${cell.unit || "无单位"}`).join(" + ");
    };
    /**
     * 行末「各工序合计（非完工量）」列＝本行各工序横向相加。
     * 生产进度表刻意**不做**这个横向合计（production-progress.service.ts:188-190：同一产品经多道工序会重复计数），
     * 客户台账却有这么一列；这里保留它，但把口径写进**列名**（见 `ROW_TOTAL_LABEL`），且**跨单位时直接不给数**（给数就等于跨单位合计）。
     */
    const rowTotalValue = (orderNo: string): string | number | null => {
      const matched = columns.flatMap((column) => cellsOf(column, orderNo));
      if (!matched.length) return null;
      if (new Set(matched.map((cell) => cell.unit)).size > 1) return UNIT_MIXED_MARKER;
      return this.num(matched.reduce((sum, cell) => sum.plus(cell.quantity), new Prisma.Decimal(0)));
    };

    const orderNos = [...new Set([...cells.values()].map((cell) => cell.orderNo))].sort((left, right) => this.byCodeUnit(left, right));
    const salesOrders = orderNos.length ? await this.prisma.salesOrder.findMany({ where: { orderNo: { in: orderNos }, deletedAt: null }, select: { orderNo: true, quantity: true, productSpec: true } }) : [];
    const salesByOrderNo = new Map(salesOrders.map((order) => [order.orderNo, order]));

    const summaryHeader: Array<string | number | null> = ["月份", "订单号", "订单数量", "规格", ...columns.map((column) => column.label), ROW_TOTAL_LABEL];
    const summaryRows: Array<Array<string | number | null>> = orderNos.map((orderNo) => {
      const sales = salesByOrderNo.get(orderNo);
      return [filters.month, orderNo, this.num(sales?.quantity), sales?.productSpec ?? "", ...columns.map((column) => cellValue(column, orderNo)), rowTotalValue(orderNo)];
    });
    // 空月份保留一行说明（与「原料对应表」的「（无采购记录）」同一做法）：空白表格分不清「没数据」和「导错了」。
    if (!summaryRows.length) summaryRows.push([filters.month, "（本月无生产日报数据）", null, "", ...columns.map(() => null), null]);
    const summarySheetRows: Array<Array<string | number | null>> = [
      ["生产月报表"],
      ["统计月份", filters.month],
      ["数据范围", "当月所有订单的工序产量，一个订单一行。列＝工序字典 operation_catalogs 中当前有效的工序：模板的工序列在前（客户叫法 验伞面/品验 按字典名 验片/品检 列出；拉边按生产单执行方式分 本厂/外发），其余「当月有数据」的工序按字典顺序追加，最后补上已不在字典里的历史工序名（保证没有数量被丢掉）。模板里的大裁 布/伞带/布套、计时 列与 房补 行在系统里**没有数据源**，故不出现。"],
      ["口径说明", "数量＝max(工序日报日合计, 员工日报日合计) 逐日取大后累加（与生产进度页同一口径：两个面是同一事实的两次人工登记，相加会双重计数、只取一面会低估）；取大的键为 (订单号, 工序, 单位, 生产单执行方式, 日期)。同一(订单, 工序)当月出现多个单位时该格**不合计**，按单位分行列出（全站纪律：数量不跨单位合计），此时末列写「单位不一致，不合计」。末列「各工序合计（非完工量）」＝本行各工序横向相加，同一件产品经过多道工序会被**重复计入**（缝伞 218 打 + 包装 218 打 = 436 打，而订单只有 218 打），**不是订单完成量**，只为量级核对；要看完工量请读「包装」列。总表的各工序列与对应工序明细 sheet 的「汇总数量」同源，两处永远相等。"],
      ["生成时间", beijingDateTime(new Date(), { seconds: true })],
      // 这里原先写「操作人」，但它取的是 user.username —— **点导出的人**，不是这条记录的操作人。
      // 两者混用会让审计误判（见 docs/design/operator-and-timestamp-governance-2026-09-16.md 验收标准 4）。
      ["导出人", user.username],
      [],
      summaryHeader,
      ...summaryRows,
    ];

    const detailSheets = columns.flatMap((column) => {
      const matched = [...cells.values()].filter((cell) => column.names.includes(cell.operationName) && (!column.executionMode || cell.executionMode === column.executionMode));
      if (!matched.length) return []; // 当月没做过的工序不必给一张空 sheet（空表反而让人以为导出坏了）
      // 工人列顺序 = 员工日报里**首次出现**的先后（fetchRows 已按 生产日期 → 订单号 → 工序 → 姓名 排好），
      // 即「这个月谁先上工谁在前」；按码位定序而不按 localeCompare，换台机器列序不会变。
      const workers: string[] = [];
      // 工人数量按**单位分开累计**：同一个工人同一天在同一道工序上录了「支」和「打」时也不能相加（全站纪律）。
      type WorkerTotals = { byUnit: Map<string, Prisma.Decimal>; amount: Prisma.Decimal; piecePrices: Set<string>; timePrices: Set<string> };
      const perOrder = new Map<string, Map<string, WorkerTotals>>();
      for (const row of employeeRows) {
        if (!column.names.includes(row.operationNameSnapshot)) continue;
        const meta = metaOf(row.productionOrderOperationId);
        if (column.executionMode && meta.executionMode !== column.executionMode) continue;
        if (!workers.includes(row.employeeNameSnapshot)) workers.push(row.employeeNameSnapshot);
        const byWorker = perOrder.get(row.orderNo) ?? new Map<string, WorkerTotals>();
        const totals = byWorker.get(row.employeeNameSnapshot) ?? { byUnit: new Map<string, Prisma.Decimal>(), amount: new Prisma.Decimal(0), piecePrices: new Set<string>(), timePrices: new Set<string>() };
        totals.byUnit.set(meta.unit, (totals.byUnit.get(meta.unit) ?? new Prisma.Decimal(0)).plus(row.quantity));
        totals.amount = totals.amount.plus(row.calculatedAmount);
        // 单价去重按 Decimal 归一后的字符串：0.35 与 0.3500 是同一个价，不能在同一格里列两遍。
        (row.wageMode === "time_rate" ? totals.timePrices : totals.piecePrices).add(new Prisma.Decimal(row.unitPrice).toString());
        byWorker.set(row.employeeNameSnapshot, totals);
        perOrder.set(row.orderNo, byWorker);
      }
      const orderList = [...new Set(matched.map((cell) => cell.orderNo))].sort((left, right) => this.byCodeUnit(left, right));
      /**
       * 数量单元格：单单位给数值、多单位按单位分行列出，**永不相加**（全站纪律：数量不跨单位合计）。
       * 与总表 cellValue 同一套写法，所以同一个 (订单, 工序) 在两处长得一模一样。
       */
      const quantityCell = (byUnit: Map<string, Prisma.Decimal>): string | number | null => {
        if (!byUnit.size) return null;
        const entries = [...byUnit.entries()].sort((left, right) => this.byCodeUnit(left[0], right[0]));
        if (entries.length === 1) return this.num(entries[0][1]);
        return entries.map(([unit, value]) => `${this.num(value) ?? 0} ${unit || "无单位"}`).join(" + ");
      };
      /** 金额永远是元，不受「不跨单位」约束（那条纪律针对数量）：多单位也只是相加。 */
      const amountCell = (value: Prisma.Decimal) => this.num(value);
      /**
       * 单价列取**计件单价原值**：唯一时给数值、多值时全部列出（不取平均/加权 —— 平均价在计薪争议时最容易被误读）；
       * 全是计时行时给出「元/小时」单价并带单位，避免与元/件混在一列里看不出量纲。
       */
      const priceCell = (piecePrices: string[], timePrices: string[]) => {
        if (piecePrices.length === 1) return this.num(piecePrices[0]);
        if (piecePrices.length > 1) return piecePrices.join("、");
        if (!timePrices.length) return "";
        return `${timePrices.join("、")} 元/小时`;
      };
      const totalsPerWorker = new Map<string, { byUnit: Map<string, Prisma.Decimal>; amount: Prisma.Decimal }>();
      const body: Array<Array<string | number | null>> = orderList.map((orderNo) => {
        const byWorker = perOrder.get(orderNo) ?? new Map<string, WorkerTotals>();
        const entries = [...byWorker.values()];
        const sales = salesByOrderNo.get(orderNo);
        const cells4Order = matched.filter((cell) => cell.orderNo === orderNo);
        return [
          orderNo,
          this.num(sales?.quantity),
          sales?.productSpec ?? "",
          priceCell([...new Set(entries.flatMap((entry) => [...entry.piecePrices]))].sort((left, right) => this.byCodeUnit(left, right)), [...new Set(entries.flatMap((entry) => [...entry.timePrices]))].sort((left, right) => this.byCodeUnit(left, right))),
          ...workers.flatMap((worker) => { const totals = byWorker.get(worker); return [totals ? quantityCell(totals.byUnit) : null, totals ? amountCell(totals.amount) : null]; }),
          // 汇总数量必须与总表同一格同一个数：这里直接调用总表用的 cellValue，而不是另算一遍。
          cellValue(column, orderNo),
          this.num(entries.reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0))),
          cells4Order.some((cell) => cell.mismatch) ? "工序日报与员工日报同日不一致（已按逐日取大汇总）" : "",
        ];
      });
      for (const byWorker of perOrder.values()) for (const [worker, totals] of byWorker) {
        const current = totalsPerWorker.get(worker) ?? { byUnit: new Map<string, Prisma.Decimal>(), amount: new Prisma.Decimal(0) };
        for (const [unit, value] of totals.byUnit) current.byUnit.set(unit, (current.byUnit.get(unit) ?? new Prisma.Decimal(0)).plus(value));
        current.amount = current.amount.plus(totals.amount);
        totalsPerWorker.set(worker, current);
      }
      const sheetByUnit = new Map<string, Prisma.Decimal>();
      for (const cell of matched) sheetByUnit.set(cell.unit, (sheetByUnit.get(cell.unit) ?? new Prisma.Decimal(0)).plus(cell.quantity));
      const totalRow: Array<string | number | null> = [
        "合计",
        // 订单数量是各订单主单位下的数，跨订单相加会跨单位；模板的合计行也没有这一格，留空不猜。
        null, null, null,
        ...workers.flatMap((worker) => { const totals = totalsPerWorker.get(worker); return [totals ? quantityCell(totals.byUnit) : null, totals ? amountCell(totals.amount) : null]; }),
        quantityCell(sheetByUnit),
        this.num([...perOrder.values()].flatMap((byWorker) => [...byWorker.values()]).reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0))),
        // 模板末尾的「房补」「总合计」两行不出现：房补在全库没有字段（见总表说明），没有房补时「总合计」与「合计」必然同值，重复一行只会让人以为漏看了一行。
        "房补/总合计：系统无住房补贴字段，模板这两行不生成",
      ];
      const sheetRows: Array<Array<string | number | null>> = [
        [`${column.label} 生产月报明细`],
        ["统计月份", filters.month],
        ["工序", column.label],
        ["数据范围", `当月（按工序生产日期划分）该工序的有效员工日报明细，一个订单一行；工人列（姓名 数量 / 姓名 金额）只来自员工日报 —— 只有它有员工维度。汇总数量与总表 sheet「${MONTHLY_REPORT_SHEET}」的「${column.label}」列**同一个数**。`],
        ["口径说明", "汇总数量＝max(工序日报日合计, 员工日报日合计) 逐日取大后累加（与生产进度页一致）。某天只有工序日报报了数时，这天进「汇总数量」但不进任何工人列，因此**工人列之和可能小于汇总数量**——这不是漏算，是两个登记面的差。汇总金额是员工日报的金额快照合计，与汇总数量不同源。单价取计件单价原值：唯一时给数值、多值时全部列出（不取平均）；全是计时行时给「元/小时」单价。同一(订单, 工序, 工人)出现多个单位时数量**不合计**，按单位分行列出（全站纪律：数量不跨单位合计）；金额是元，不受这条约束。"],
        ["生成时间", beijingDateTime(new Date(), { seconds: true })],
        // 这里原先写「操作人」，但它取的是 user.username —— **点导出的人**，不是这条记录的操作人。
        // 两者混用会让审计误判（见 docs/design/operator-and-timestamp-governance-2026-09-16.md 验收标准 4）。
        ["导出人", user.username],
        [],
        ["订单号", "订单数量", "规格", "单价", ...workers.flatMap((worker) => [`${worker} 数量`, `${worker} 金额`]), "汇总数量", "汇总金额", "备注"],
        ...body,
        totalRow,
      ];
      return [{ name: column.label, rows: sheetRows }];
    });

    const sheets = [{ name: MONTHLY_REPORT_SHEET, rows: summarySheetRows }, ...detailSheets];
    return this.buildBook(sheets, { report_type: MONTHLY_REPORT_SHEET, filters, row_count: summaryRows.length, operation_count: columns.length, sheet_count: sheets.length }, user);
  }

  /** 订单号盘点表：单订单明细（时长小时、合计），表头附每道工序的生产日期数组、计划数量与汇总数量；可选按生产日期月份过滤。 */
  async exportOrder(filters: { order_no: string; operation_id?: string; month?: string }, user: CurrentUser) {
    if (!filters.order_no?.trim()) throw this.invalid("订单号不能为空");
    const monthValid = /^\d{4}-\d{2}$/.test(filters.month ?? "");
    const range = monthValid ? this.monthRange(filters.month!) : undefined;
    const rows = await this.fetchRows({ order_no: filters.order_no.trim(), operation_id: filters.operation_id, ...(range ?? {}) });
    const operation = filters.operation_id ? await this.prisma.operationCatalog.findFirst({ where: { id: filters.operation_id }, select: { operationName: true } }) : null;
    const detailHeader = ["订单号", "生产单号", "工序", "工序日期", "工号", "员工姓名", "部门", "员工类型", "计薪方式", "计件数量", "时长（小时）", "单价", "合计", "备注", ...DETAIL_AUDIT_HEADER];
    const operationHeader = rows.length ? this.operationHeaderRows(rows) : [];
    const sheetRows: Array<Array<string | number | null>> = [
      ["订单号盘点表"],
      ["订单号", filters.order_no],
      ...(monthValid ? [["统计月份（按生产日期过滤）", filters.month!]] : []),
      ["工序", operation?.operationName ?? "全部工序"],
      ["数据范围", "该订单号下全部有效工序员工日报；计件数量对计时/计件工人都展示（计时工人同样填报完成件数），计时另给时长（小时）"],
      ["生成时间", beijingDateTime(new Date(), { seconds: true })],
      // 这里原先写「操作人」，但它取的是 user.username —— **点导出的人**，不是这条记录的操作人。
      // 两者混用会让审计误判（见 docs/design/operator-and-timestamp-governance-2026-09-16.md 验收标准 4）。
      ["导出人", user.username],
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
      ["生成时间", beijingDateTime(new Date(), { seconds: true })],
      // 这里原先写「操作人」，但它取的是 user.username —— **点导出的人**，不是这条记录的操作人。
      // 两者混用会让审计误判（见 docs/design/operator-and-timestamp-governance-2026-09-16.md 验收标准 4）。
      ["导出人", user.username],
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
      ["生成时间", beijingDateTime(new Date(), { seconds: true })],
      // 这里原先写「操作人」，但它取的是 user.username —— **点导出的人**，不是这条记录的操作人。
      // 两者混用会让审计误判（见 docs/design/operator-and-timestamp-governance-2026-09-16.md 验收标准 4）。
      ["导出人", user.username],
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
      ["生成时间", beijingDateTime(new Date(), { seconds: true })],
      // 这里原先写「操作人」，但它取的是 user.username —— **点导出的人**，不是这条记录的操作人。
      // 两者混用会让审计误判（见 docs/design/operator-and-timestamp-governance-2026-09-16.md 验收标准 4）。
      ["导出人", user.username],
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
    // 姓名在这里**一次**解析好贴到行上（2026-09-16 全站治理）：三张明细表共用 detailRow，
    // 逐个调用方各自解析会变成三份重复代码，逐行解析又是 N+1。
    const names = await this.actors.namesOf(rows.flatMap((row) => [row.createdBy, row.updatedBy]));
    return rows.map((row) => withActorNames(row, names));
  }

  /**
   * 明细行。计时单位统一为小时：计时行展示 时长（小时）＝ 落库分钟 ÷ 60。
   * 计件数量对**所有计薪方式**都要展示：客户反馈「计时工人的计件数量也要在里面」——
   * 计时工人同样会填报完成件数，只把它藏起来会让盘点表对不上工序产量。
   */
  private detailRow(row: ReportRow & Partial<AuditActorNames>) {
    const duration = row.wageMode === "time_rate" ? this.hours(row.durationMinutes) : null;
    return [row.orderNo, row.productionOrderNoSnapshot, row.operationNameSnapshot, row.reportDate.toISOString().slice(0, 10), row.employee.employeeNo, row.employeeNameSnapshot, row.employee.department.name, row.employee.employeeType === "workshop" ? "车间" : "非车间", row.wageMode === "piece_rate" ? "计件" : "计时", this.num(row.quantity), duration, this.num(row.unitPrice), this.num(row.calculatedAmount), row.remark ?? "",
      // 审计四列（表头见 DETAIL_AUDIT_HEADER）：姓名取不到就留空，绝不写 UUID。
      row.created_by_name ?? "", beijingDateTime(row.createdAt), row.updated_by_name ?? "", beijingDateTime(row.updatedAt)];
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

  /**
   * 排序比较器：按**码位**比，不用 `localeCompare`。
   *
   * localeCompare 受运行环境 ICU 与 locale 影响（同一组中文在不同 Node/系统上可能给出不同顺序），
   * 而这种顺序会直接变成导出文件里的行序/列序 —— "同一份数据换台机器导出长得不一样"。
   * 与 `reorder.domain.ts:60-67` 同一个理由，那边也刻意不用 localeCompare。
   */
  private byCodeUnit(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }

  private monthRange(month: string) {
    const from = new Date(`${month}-01T00:00:00.000Z`);
    return { from, to: new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1)) };
  }

  /**
   * 多 sheet 工作簿（生产月报表＝总表 + 每道工序一张明细）。
   * 既有 6 个单表导出仍走 `buildSheet`，它只是这里的单 sheet 特例，因此输出与行为一字未改。
   */
  private async buildBook(sheets: Array<{ name: string; rows: Array<Array<string | number | null>> }>, auditDetails: Record<string, unknown>, user: CurrentUser) {
    const book = XLSX.utils.book_new();
    const used = new Set<string>();
    for (const definition of sheets) {
      const sheet = XLSX.utils.aoa_to_sheet(definition.rows);
      const width = Math.max(...definition.rows.map((row) => row.length), 14);
      sheet["!cols"] = Array.from({ length: width }, () => ({ wch: 18 }));
      XLSX.utils.book_append_sheet(book, sheet, this.uniqueSheetName(definition.name, used));
    }
    await this.audit.record("production_payroll_export", "employee_daily_report", user.id, undefined, { ...auditDetails });
    return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  }

  private async buildSheet(sheetRows: Array<Array<string | number | null>>, title: string, auditDetails: Record<string, unknown>, user: CurrentUser) {
    return this.buildBook([{ name: title, rows: sheetRows }], auditDetails, user);
  }

  /**
   * Excel 工作表名规则：≤31 字符、不得含 `[ ] : * ? / \`、同一簿内不得重名
   * （`book_append_sheet` 碰到非法名/重名会改名甚至抛错）。
   * 工序名来自**用户可改**的工序字典，所以这里必须兜住，不能假定它合法。
   * 截断按码点切（`[...text]`），否则可能把一个代理对切成半个字符。
   */
  private uniqueSheetName(name: string, used: Set<string>) {
    const forbidden = "[]:*?/\\";
    const cleaned = [...name].map((char) => (forbidden.includes(char) ? " " : char)).join("").trim();
    const base = ([...cleaned].slice(0, 31).join("") || "明细");
    let candidate = base;
    for (let index = 2; used.has(candidate); index += 1) candidate = `${[...base].slice(0, 28).join("")}(${index})`;
    used.add(candidate);
    return candidate;
  }

  private invalid(message: string) { return new UnprocessableEntityException({ code: "INVALID_EXPORT_FILTER", message, details: [] }); }
}

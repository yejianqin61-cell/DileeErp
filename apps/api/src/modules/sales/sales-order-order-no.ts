import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * 销售单**订单号更正**（改号）的全链联动。
 *
 * 为什么要有这个文件：`sales_orders.order_no` 不只属于销售单 —— 全库 **38 张业务表**都冗余了它
 * （`@map("order_no")`，另见 §一），而读路径大量**按订单号 join**（采购单按它找销售单与 BOM、
 * 领料预览按它聚合已下单/已入库、财务报表按它反查客户、对账单按它取范围、工作台按它取单）。
 * 只改销售单那一格，等于让同一张单在系统里同时存在两个订单号：那些 join 会**静默查不到另一半
 * 数据**（不报错、只少行），最后只在财务对账时以差额的形式暴露出来。
 *
 * 因此这里的核心不是"改一格"，而是**一张不许漏项的登记表**：`ORDER_NO_RENAME_TARGETS`。
 * 配套的 `apps/api/test/unit/sales-order-order-no-rename.test.cjs` 会扫 `schema.prisma` 里所有
 * `@map("order_no")` 列，逐条要求「要么在登记表里，要么在 `ORDER_NO_RENAME_EXEMPT` 里」——
 * 以后谁新增一张带 `order_no` 的表却忘了登记，测试直接红，而不是等到某天对账差了一笔。
 *
 * 语义口径（用户 2026-09-30 拍板）：任何时候都能改（含已确认、已有下游事实的单）、版本快照跟着改、
 * 审计保留旧号、不加"曾用单号"列。设计文档：`docs/design/sales-order-no-rename-2026-09-30.md`。
 */

/**
 * 扫码用的最小客户端形状。
 *
 * 只用 `updateMany` / `count` 两个方法，是为了让登记表**不需要**逐一处理 Prisma 各模型的
 * 泛型参数（38 个模型各写一遍 `updateMany<...>` 是纯粹的手工劳动，且抄错一个只会表现为漏改）。
 * `Prisma.TransactionClient` 与 `PrismaService` 都满足这个形状（后者多出来的成员不影响结构比较）。
 */
export type OrderNoRenameClient = Prisma.TransactionClient;

type OrderNoDelegate = {
  updateMany: (args: { where: { orderNo: string }; data: { orderNo: string } }) => Promise<{ count: number }>;
  count: (args: { where: { orderNo: string } }) => Promise<number>;
};

export type OrderNoRenameTarget = {
  /** **Prisma 模型名**（`Bom` / `PurchaseOrder`…）。取模型名而不是表名，是为了让覆盖守卫能拿它跟
   * `schema.prisma` 里的模型名做**集合相等**比较 —— 表名要靠 `@@map` 再转一层，多一层就多一处出错的地方。
   * 它也进审计 details，界面文案改动不会影响它。 */
  key: string;
  /** 影响面确认框里显示的中文名（用户看到的"哪一类单据"）。 */
  label: string;
  /** 把 `order_no = 旧号` 的行全改成新号，返回改动行数。 */
  sweep: (tx: OrderNoRenameClient, from: string, to: string) => Promise<number>;
  /** 残留校验：改完之后还有没有 `order_no = 旧号` 的行。 */
  count: (tx: OrderNoRenameClient, value: string) => Promise<number>;
};

/**
 * 一条登记项。`column` 是「取哪个模型的 order_no 列」——写成 `(tx) => tx.bom` 而不是字段名，
 * 是为了让 Prisma 生成的客户端**在编译期**校验模型名：写错一个名字是编译错误，不是静默漏改。
 */
function target(key: string, label: string, column: (tx: OrderNoRenameClient) => OrderNoDelegate): OrderNoRenameTarget {
  return {
    key,
    label,
    sweep: async (tx, from, to) => (await column(tx).updateMany({ where: { orderNo: from }, data: { orderNo: to } })).count,
    count: (tx, value) => column(tx).count({ where: { orderNo: value } }),
  };
}

/**
 * 全链联动登记表：**38 项**，一项一张表。
 *
 * 为什么可以"按值改"而不必逐表证明这列到底指谁：`sales_orders.order_no` 上有一条唯一索引，
 * 所以"值 = 旧订单号"与"指向这张销售单"是**同一件事** —— 任何一行只要该列等于旧号，
 * 它引用的就只可能是这张单。这条性质正是本表能保持简单的依据。
 *
 * ⚠️ 2026-10-08 起唯一性是**未删除行上唯一**（部分唯一索引 `sales_orders_order_no_active_key`，
 * 见迁移 `20261008100000_sales_order_no_active_unique`）：软删一张单会**释放**它的订单号，
 * 于是历史上可能有两张单（一张已删、一张存活）用过同一个号。上面的"按值改"依然成立，理由是
 * **删除守卫**（`sales-orders.service.ts` 的 `countDownstreamFacts`）：只有**没有任何下游事实**的草稿才能删，
 * 所以被删的那张单不会在这 38 张表里留下带它号码的行 —— 带这个号的下游行只可能属于存活的那张。
 * 已知的**窄例外**是两张手工单据：`cashFlowEntry`（收支流水的「订单号」是手输的）与
 * `supplierPayableEntry`（其他应付可手填订单号）。若有人把号手输成一张**草稿**的号、随后又删掉那张草稿、
 * 再用同一个号建单，那么这张草稿的号码就会被后续改号一起带走（只动那一格的引用文本，金额与账务不受影响）。
 * 要彻底消除这个窗口，就把这两张表也加进删除守卫的盘点清单（代价是这类草稿不能再删）。
 *
 * 顺序 = 从销售单往后的链路顺序（BOM → 采购 → 到货/质检/入库 → 应付/付款 → 外加工 → 生产 →
 * 成品入库/QC/出库 → 应收/收款 → 对账/现金流 → 计件工资），方便人工核对"哪一段漏了"。
 * 每项**不带 `deletedAt` 过滤**：软删行仍会出现在搜索与对账范围里，改名必须包括它们。
 */
export const ORDER_NO_RENAME_TARGETS: readonly OrderNoRenameTarget[] = [
  target("Bom", "BOM 表", (tx) => tx.bom),
  target("PurchaseOrder", "采购单", (tx) => tx.purchaseOrder),
  target("PurchasePlan", "采购计划", (tx) => tx.purchasePlan),
  target("PurchaseReceipt", "到货记录", (tx) => tx.purchaseReceipt),
  target("IncomingInspection", "进料质检", (tx) => tx.incomingInspection),
  target("RawMaterialInboundNotice", "原料入库通知", (tx) => tx.rawMaterialInboundNotice),
  target("RawMaterialInbound", "原料入库", (tx) => tx.rawMaterialInbound),
  target("InventoryFact", "库存事实", (tx) => tx.inventoryFact),
  target("PayableSource", "应付来源", (tx) => tx.payableSource),
  target("SupplierPayableEntry", "应付台账", (tx) => tx.supplierPayableEntry),
  target("SupplierPayment", "付款单", (tx) => tx.supplierPayment),
  target("SupplierPaymentAllocation", "付款核销明细", (tx) => tx.supplierPaymentAllocation),
  target("SupplierPayableReconciliation", "应付对账单", (tx) => tx.supplierPayableReconciliation),
  target("OutsourceLogisticsBatch", "外加工批次", (tx) => tx.outsourceLogisticsBatch),
  target("OutsourceReceipt", "外加工签收", (tx) => tx.outsourceReceipt),
  target("OutsourcePayableSource", "外加工应付来源", (tx) => tx.outsourcePayableSource),
  target("OutsourceReturnTransfer", "外加工退货调拨", (tx) => tx.outsourceReturnTransfer),
  target("OutsourceDirectShipment", "外加工直发", (tx) => tx.outsourceDirectShipment),
  target("ProductionOrder", "生产单", (tx) => tx.productionOrder),
  target("RawMaterialMovement", "领料/退料/报废单", (tx) => tx.rawMaterialMovement),
  target("OperationDailyReport", "工序日报", (tx) => tx.operationDailyReport),
  target("EmployeeDailyReport", "员工计件日报", (tx) => tx.employeeDailyReport),
  target("ProductionDailyAlert", "生产异常告警", (tx) => tx.productionDailyAlert),
  target("ProductionPayrollSource", "生产薪资来源", (tx) => tx.productionPayrollSource),
  target("PayrollPayableEntry", "工资应付台账", (tx) => tx.payrollPayableEntry),
  target("FinishedGoodsInspectionSubmission", "成品送检单", (tx) => tx.finishedGoodsInspectionSubmission),
  target("FinishedGoodsQcRecord", "成品 QC 记录", (tx) => tx.finishedGoodsQcRecord),
  target("FinishedGoodsInboundNotice", "成品入库通知", (tx) => tx.finishedGoodsInboundNotice),
  target("FinishedGoodsInbound", "成品入库", (tx) => tx.finishedGoodsInbound),
  target("FinishedGoodsDefective", "成品次品", (tx) => tx.finishedGoodsDefective),
  target("FinishedGoodsOutbound", "成品出库", (tx) => tx.finishedGoodsOutbound),
  target("FinishedGoodsOutboundNotice", "成品出库通知", (tx) => tx.finishedGoodsOutboundNotice),
  target("CustomerReturn", "客户退货", (tx) => tx.customerReturn),
  target("ReceivableSource", "应收来源", (tx) => tx.receivableSource),
  target("CustomerPayment", "收款单", (tx) => tx.customerPayment),
  target("ReceivableAdjustment", "应收调整", (tx) => tx.receivableAdjustment),
  target("ReceivableReconciliation", "应收对账单", (tx) => tx.receivableReconciliation),
  target("CashFlowEntry", "现金流分录", (tx) => tx.cashFlowEntry),
];

/**
 * 故意**不在**联动范围内的 `order_no` 列（守卫测试按这张清单放行，逐条带理由）。
 *
 * 判据是：这一列记的是"现在指向谁"（要跟着改），还是"当时发生了什么"（必须留在原处）。
 * 守卫测试把「`schema.prisma` 里带 `order_no` 列的模型集合」与
 * 「登记表 ∪ 本清单」做**集合相等**比较 —— 少一个就是漏改，多一个就是清单过期。
 */
export const ORDER_NO_RENAME_EXEMPT: ReadonlyArray<{ model: string; reason: string }> = [
  { model: "SalesOrder", reason: "源头本身 —— 改名就是改它" },
  {
    model: "AuditEvent",
    reason:
      "审计事件流：旧号必须留在事件里（回写会让「这张单曾经叫过 XX」彻底消失）。改号这件事本身另记一条 sales_order.rename_order_no 事件，details 里带 from→to，按旧号反查走它。",
  },
];

/** 订单号的归一：只去首尾空白，不改大小写、不猜格式（单号是业务自己编的）。 */
export function normalizeOrderNo(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export type OrderNoImpactRow = { key: string; label: string; count: number };

export type OrderNoRenameReport = {
  from: string;
  to: string;
  /** 只列**非零**项，按改动行数降序 —— 用户在确认框里看的就是这张表。 */
  targets: OrderNoImpactRow[];
  total: number;
  /** 本单被同改的历史版本快照数（第 §四.2 步 ④）。 */
  version_snapshots: number;
  /** 别的销售单上指向本单的返单来源引用数（步 ③）。 */
  reorder_references: number;
};

/** 影响面：只读，用来在保存前把"会改哪些表、各多少行"摆给用户。 */
export async function orderNoRenameImpact(client: OrderNoRenameClient, value: string): Promise<{ targets: OrderNoImpactRow[]; total: number }> {
  const rows = await Promise.all(ORDER_NO_RENAME_TARGETS.map(async (item) => ({ key: item.key, label: item.label, count: await item.count(client, value) })));
  const targets = rows.filter((row) => row.count > 0).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-Hans-CN"));
  return { targets, total: targets.reduce((sum, row) => sum + row.count, 0) };
}

/**
 * 本单各版本快照里还写着旧号的条数（步 ④ 的预览版）。
 *
 * 版本快照是"这一单"的历史（回看时不该看到一个已作废的号），所以口径是**跟着改**；
 * 这与"审计里的旧号一个字都不回写"（见 `ORDER_NO_RENAME_EXEMPT`）是两件事，别混。
 */
export async function countVersionSnapshotsWithOrderNo(tx: OrderNoRenameClient, salesOrderId: string, from: string): Promise<number> {
  const versions = await tx.salesOrderVersion.findMany({ where: { salesOrderId }, select: { id: true, snapshot: true } });
  return versions.filter((version) => snapshotOrderNo(version.snapshot) === from).length;
}

function snapshotOrderNo(snapshot: Prisma.JsonValue | null): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, unknown>).order_no;
  return typeof value === "string" ? value : null;
}

/**
 * 执行全链改名。**必须在本单所在事务里调用**（先 `SELECT ... FOR UPDATE` 锁住销售单行，
 * 与生产单/采购单建单同一把锁），任何一步失败整体回滚 —— 不允许出现"改了一半"的可见状态。
 *
 * 步骤与理由见 `docs/design/sales-order-no-rename-2026-09-30.md` §四.2：
 * 扫全链 → 改返单来源引用 → 重写版本快照 → **残留校验** → 交由调用方改源头那一格。
 */
export async function renameSalesOrderNo(tx: OrderNoRenameClient, params: { salesOrderId: string; from: string; to: string }): Promise<OrderNoRenameReport> {
  const { salesOrderId, from, to } = params;
  const changed: OrderNoImpactRow[] = [];
  for (const item of ORDER_NO_RENAME_TARGETS) {
    const count = await item.sweep(tx, from, to);
    if (count > 0) changed.push({ key: item.key, label: item.label, count });
  }
  changed.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-Hans-CN"));

  // 别的销售单上指向本单的返单来源（`reorder_from_order_no` 存的是**文本**而非外键，见 schema 注释）。
  // 它是"现在指向谁"，所以跟着改：不改的话返单链会指向一个不存在的单号。
  const reorderReferences = (await tx.salesOrder.updateMany({ where: { reorderFromOrderNo: from }, data: { reorderFromOrderNo: to } })).count;

  const versions = await tx.salesOrderVersion.findMany({ where: { salesOrderId }, select: { id: true, snapshot: true } });
  let versionSnapshots = 0;
  for (const version of versions) {
    const snapshot = version.snapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) continue;
    const row = snapshot as Record<string, unknown>;
    if (row.order_no !== from) continue;
    // 只动 `order_no` 那一格：版本快照的其它内容（工艺口径、客户快照、金额）一个字都不碰。
    await tx.salesOrderVersion.update({ where: { id: version.id }, data: { snapshot: { ...row, order_no: to } as Prisma.InputJsonValue } });
    versionSnapshots += 1;
  }

  // 残留校验：改号与下游建单并发时，可能有一行带着旧号刚落库。宁可整事务回滚让用户重试，
  // 也不要提交一个"半个改名"——那正是本设计要消灭的状态。
  const leftovers = (await Promise.all(ORDER_NO_RENAME_TARGETS.map(async (item) => ({ label: item.label, count: await item.count(tx, from) })))).filter((row) => row.count > 0);
  const danglingReorder = await tx.salesOrder.count({ where: { reorderFromOrderNo: from } });
  if (leftovers.length || danglingReorder) {
    throw new ConflictException({
      code: "ORDER_NO_RENAME_CONFLICT",
      message: `改号期间有下游单据正在生成（${[...leftovers.map((row) => `${row.label} ${row.count} 条`), ...(danglingReorder ? [`返单来源引用 ${danglingReorder} 条`] : [])].join("、")}），本次改号已取消，请稍后重试`,
      details: [{ order_no: from, leftover_tables: leftovers }],
    });
  }

  return { from, to, targets: changed, total: changed.reduce((sum, row) => sum + row.count, 0), version_snapshots: versionSnapshots, reorder_references: reorderReferences };
}

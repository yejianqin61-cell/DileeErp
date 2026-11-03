import { ConflictException, Injectable, NotFoundException, Optional, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";

/** 采购明细入参（导出给「采购计划下单」用：它要把计划行映射成同一形状，两条路径共用一套校验）。 */
export type PurchaseOrderItemInput = { material_id: string; unit_id: string; bom_item_id?: string; supplier_id?: string; expected_date?: string; model?: string; quantity: string; unit_price: string; tax_rate?: string; extra_fee?: string; extension_data?: Record<string, unknown> };
type Item = PurchaseOrderItemInput;
type Input = { order_no: string; bom_id?: string; bom_version?: number; supplier_id?: string; purchase_date?: string; expected_date?: string; currency?: string; remark?: string; reason?: string; extension_data?: Record<string, unknown>; items?: Item[] };
/** 按供应商收束：一组 = 一张采购单。`supplier_id` 可空 = 这一组是「还没选供应商」的行。 */
export type SplitGroup = { supplier_id?: string; currency?: string; expected_date?: string; remark?: string; items?: Item[] };
export type SplitInput = { order_no: string; bom_id?: string; purchase_date?: string; currency?: string; remark?: string; reason?: string; place_order?: boolean; extension_data?: Record<string, unknown>; groups?: SplitGroup[] };
/** 收束后的分组（参照物已解析、下单前校验已过），可以直接落库。 */
export type MergedGroup = { input: Input; prepared: Prepared };
/**
 * 「同一供应商的后续下单」要**并入**的那张采购单（2026-10-13）。
 *
 * 与 `splitExisting()` 的差别：那个是"把一张单的内容重新收束一次"（人主动发起、要写原因），
 * 这个是"往后追加一行"，单号不变、已有的行与到货事实一根不动。
 */
export type MergeTarget = { id: string; purchaseOrderNo: string };
type OrderableItem = { materialId: string; unitId: string; supplierId: string; quantity: string; unitPrice: string };
/**
 * BOM 明细行上的下单情况（采购计划里给采购员看的「这一行是不是已经买过了」）。
 *
 * ⚠️ `draft` 这个值 2026-09-27 起的语义是**计划中**（数据源从草稿采购单换成了计划行），
 * 名字按设计文档 §4.2 刻意保留，界面文案是「计划中」。
 */
type BomItemOrderState = "none" | "draft" | "partial" | "ordered";
/** 已下单的采购单状态（草稿不算，已取消已被查询排除）。 */
const ORDERED_PURCHASE_STATUSES = ["ordered", "partially_arrived", "arrived_complete"];
/**
 * 采购单**列表**的范围（口径 11）：采购单模块就是"所有已经过供应商收束下单的采购单"。
 *
 * 草稿已经不存在（采购计划接管了它），已取消的单不进列表（它不再对外，留在审计里可查）。
 */
const LISTED_PURCHASE_STATUSES = ORDERED_PURCHASE_STATUSES;
/** 可整体编辑的采购单状态：草稿自由改；已下单未到货的也能改，但要留下原因与前后值。 */
const EDITABLE_PURCHASE_STATUSES = ["draft", "ordered"];
/**
 * `PATCH /purchase-orders/:id` 里**容忍但一律拒绝**的字段。
 *
 * 为什么不是直接删掉这个端点：老客户端（含已发布的打印页）还在发这些键，
 * 让它们拿到一句"明细只能在采购计划里改"，比一个 404 有用得多。
 * 而 `ValidationPipe` 开了 `forbidNonWhitelisted`，所以这些键必须先 declared 出来才收得到。
 *
 * ⚠️ **`expected_date` 与 `remark` 不在这里**：它们同时是"打印信息"的字段
 * （交货日期 / 备注，见 `PrintFieldsDto`）—— 同一列两个用途，列进来会把打印路径打死。
 */
const PURCHASE_ORDER_DETAIL_KEYS = ["order_no", "bom_id", "bom_version", "supplier_id", "purchase_date", "currency", "items", "reason"] as const;
/**
 * 采购单「打印信息」的入参：只含采购订单打印表上那些与明细/金额无关的字。
 * `expected_date`（交货日期）与 `remark`（备注）用 `null` 表示「清掉这一格」。
 */
type PrintFieldsInput = {
  payment_terms?: string | null;
  delivery_terms?: string | null;
  delivery_address?: string | null;
  expected_date?: string | null;
  remark?: string | null;
  supplier_reply?: string | null;
  supplier_signed?: string | null;
  supervisor_signature?: string | null;
};
/**
 * `refs()` 的返回结构（只保留下单/建单真正用到的字段，避免耦合 Prisma 生成类型）。
 *
 * ⚠️ 供应商这三格（`supplier` / `supplierMap`）**刻意写全**：它们会被原样写进
 * `supplier_snapshot`（`orderData` / `itemData`），也就是"下单那一刻这家长什么样"的冻结件。
 * 口径 4（设计文档 `purchase-plan-and-supplier-collapse-2026-09-27.md`）要的就是
 * **地址与联系人在下单时冻结**——供应商以后改了地址，去年的采购单上仍要看得见当时那句。
 *
 * 所以：**不要**给 `refs()` 里那句 `supplier.findMany` 加 `select: { id, name }`。
 * 加了不会报错，只会让快照悄悄少掉地址/联系人（`purchase-orders.test.cjs` 里有一条
 * 钉住这三格的回归用例）。类型写窄了同样是陷阱——原来这里只声明 `{id, name}`，
 * 而实际写入的是整行，读代码的人会以为快照里没有地址。
 */
type SupplierSnapshotSource = { id: string; supplierCode: string; name: string; contactName: string | null; phone: string | null; address: string | null };
type Refs = {
  order: { id: string; orderNo: string };
  bom: { id: string; version: number } | null;
  supplier: SupplierSnapshotSource | undefined;
  supplierMap: Map<string, SupplierSnapshotSource>;
  materials: Map<string, { id: string; materialCode: string; name: string }>;
  units: Map<string, { id: string; name: string }>;
  items: Item[];
};
type Prepared = { refs: Refs; items: Item[]; total: string };

@Injectable()
export class PurchaseOrdersService {
  // currencies 用 @Optional()：单元测试直接 new 服务时只传 prisma/audit，
  // 此时跳过字典校验而在真实运行时（CurrencyModule 全局提供）始终校验。
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Optional() private readonly currencies?: CurrencyService) {}
  async list(orderNo?: string) {
    // `salesOrder.deletedAt` 只用来算 `orphaned`：销售单被软删后，这张采购单不删也不解绑，
    // 只是从此变成「孤立单据」（用户 2026-11-03）。不把整个 salesOrder 对象下发给前端。
    const rows = await this.prisma.purchaseOrder.findMany({ where: { deletedAt: null, status: { in: LISTED_PURCHASE_STATUSES }, ...(orderNo ? { orderNo } : {}) }, include: { items: { where: { deletedAt: null }, include: { receipts: { where: { deletedAt: null } }, material: true, unit: true, supplier: true } }, supplier: true, salesOrder: { select: { deletedAt: true } } }, orderBy: { updatedAt: "desc" } });
    return rows.map(({ salesOrder, ...row }) => {
      const shaped = row.status === "arrived_complete" && !this.arrivalClosed(row.extensionData) ? { ...row, status: "partially_arrived" } : row;
      return { ...shaped, orphaned: Boolean(salesOrder?.deletedAt) };
    });
  }
  async get(id: string) { const po = await this.prisma.purchaseOrder.findFirst({ where: { id, deletedAt: null }, include: { items: { where: { deletedAt: null }, include: { receipts: { where: { deletedAt: null }, orderBy: { receivedDate: "asc" }, include: { inspections: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } }, rawMaterialInbounds: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } }, payableSources: { where: { status: { not: "voided" } }, orderBy: { createdAt: "asc" }, include: { supplierPayableEntry: { include: { allocations: true } } } } } }, material: true, unit: true, supplier: true } }, supplier: true, bom: true, salesOrder: { select: { deletedAt: true } } } }); if (!po) throw new NotFoundException({ code: "PURCHASE_ORDER_NOT_FOUND", message: "采购单不存在", details: [] }); // `orphaned` 与列表同一口径：销售单被软删 = 孤立的采购单（2026-11-03）。
    const { salesOrder, ...rest } = po;
    return { ...rest, orphaned: Boolean(salesOrder?.deletedAt), items: po.items.map((item) => ({ ...item, receipts: item.receipts.map((receipt, index) => ({ ...receipt, batchSequence: this.batchSequence(receipt.extensionData, index + 1) })), batchWorkflows: item.receipts.map((receipt, index) => ({ receiptId: receipt.id, receiptNo: receipt.receiptNo, batchSequence: this.batchSequence(receipt.extensionData, index + 1), receivedQuantity: receipt.quantity, inspections: receipt.inspections, inbounds: receipt.rawMaterialInbounds.map((inbound) => ({ ...inbound, settlementUnitPrice: inbound.settlementUnitPrice, settlementTotalAmount: inbound.settlementTotalAmount })), payableSources: receipt.payableSources })) })) }; }
  async create(input: Input, user: CurrentUser) {
    await this.currencies?.assertSupported(input.currency, "采购单币种");
    const prepared = await this.prepare(input);
    const created = await this.prisma.$transaction(async (tx) => tx.purchaseOrder.create({ data: this.orderData(prepared, input, user, "draft") }));
    await this.audit.record("purchase_order.create", "purchase_order", user.id, created.id, { order_no: created.orderNo, purchase_order_no: created.purchaseOrderNo, draft: !prepared.refs.bom || !prepared.items.length });
    return this.get(created.id);
  }
  /**
   * 一张销售订单 → 多张采购单（按供应商拆分）。
   *
   * 业务动因：同供应商的物料应放在同一张采购单上，不同供应商必须拆单；
   * 否则采购单头部的供应商、币种、金额以及后续到货、应付、对账都失去单一含义。
   * 所有分组在同一个事务里写入：要么全部生成，要么一张都不生成。
   */
  async createSplit(input: SplitInput, user: CurrentUser) {
    const placeOrder = input.place_order === true;
    const merged = await this.collectGroups(input, placeOrder);
    const targetStatus = placeOrder ? "ordered" : "draft";
    const created = await this.prisma.$transaction((tx) => this.createOrdersFromGroups(tx, merged, targetStatus, user));
    for (const row of created) {
      await this.audit.record("purchase_order.create", "purchase_order", user.id, row.id, { order_no: row.orderNo, purchase_order_no: row.purchaseOrderNo, split_by_supplier: true, group_count: created.length });
      if (placeOrder) await this.audit.record("purchase_order.order", "purchase_order", user.id, row.id, { order_no: row.orderNo, split_by_supplier: true });
    }
    return Promise.all(created.map((row) => this.get(row.id)));
  }
  /**
   * 把已收束好的分组落成采购单 —— **在调用方给的事务里**写。
   *
   * 为什么单独开放这一步（2026-09-27 采购计划下单）：计划下单要在**同一个事务**里回写
   * `purchase_plan_items.purchase_order_item_id`。分成两次事务的话，中途失败会留下
   * 「采购单已经建好、计划还显示未下单」的中间态 —— 而那正是重复采购的入口。
   *
   * 收束与校验仍然共用 `collectGroups()`，本方法只负责写，两条路径不会漂移。
   */
  async createOrdersFromGroups(tx: Prisma.TransactionClient, merged: MergedGroup[], status: "draft" | "ordered", user: CurrentUser) {
    const rows = [];
    for (const entry of merged) rows.push(await tx.purchaseOrder.create({ data: this.orderData(entry.prepared, entry.input, user, status) }));
    return rows;
  }
  /**
   * **同一供应商的后续下单自动收束进同一张采购单**（2026-10-13，设计文档
   * `purchase-plan-split-order-and-flat-list-2026-10-13.md` 口径 1）。
   *
   * 为什么需要它：2026-10-11 定了「没确定单价的先不下单」，于是同一家的物料**必然**分波下单
   * （辅料等客户资料才有价）；而 2026-09-17 又定了「一个采购单内，一个供应商下一个单」。
   * 两条同时成立，只有系统能办到：一波一波下，落点还是同一张单。
   *
   * 判据四条，缺一不可（这一条是本功能最容易被改坏的地方，改之前先读设计文档 §2）：
   *   ① **这张单是这份计划自己下出来的**：用 `linkedOrderItemIds`（计划行回写的链接）认，
   *      **不按供应商猜** —— 按供应商猜会把别人手工建的同供应商单吞进来；
   *   ② 供应商与**币种**都对得上：一张单一个供应商、一个币种，"一个币种"是这张单的属性
   *      （金额不跨币种合计），并错了财务会收到一张"单价是美元、单头写着人民币"的单；
   *   ③ 状态还是 `ordered`；
   *   ④ **任一未删明细都没有到货记录**：到货是既成事实，后面挂着质检、入库与应付来源，
   *      往这样一张单上追新物料，会让"这批到货是哪张单的"多出一个答案。
   *      ⚠️ 第 ④ 条按**明细的到货记录**判，**不看状态**：`receipt()`（V1）登记到货时不刷单头状态，
   *      只看 `status === "ordered"` 会把这种单当成可并的。
   *
   * 多条候选时取 `createdAt` 倒序的第一张 —— 也就是"上一波下的那张单"。
   *
   * 为什么必须在**事务里**调：两个窗口同时给同一家下单时，事务外判定会让两边都看到
   * "没有可并入的单"从而各建一张，那正是这个功能要消灭的场景。
   */
  async findMergeTarget(tx: Prisma.TransactionClient, input: { orderNo: string; bomId: string; supplierId: string; currency: string; linkedOrderItemIds: string[] }): Promise<MergeTarget | null> {
    if (!input.linkedOrderItemIds.length) return null;
    const candidates = await this.queryLinkedOpenOrders(tx, input);
    const open = candidates.find((order) => order.supplierId === input.supplierId && order.currency === input.currency);
    return open ? { id: open.id, purchaseOrderNo: open.purchaseOrderNo } : null;
  }
  /**
   * 计划详情用：这份计划下**还能并入**的采购单（同供应商 + 同币种 + 已下单 + 无到货）。
   *
   * 前端按它把"这一组会并到哪张单 / 会新建一张"写在收束预览里（口径 6）——
   * 静默地"有时候并、有时候不并"是最难查的一类坏。
   */
  async openOrdersForPlan(input: { orderNo: string; bomId: string; linkedOrderItemIds: string[] }): Promise<Array<{ id: string; purchaseOrderNo: string; supplierId: string | null; currency: string; itemCount: number; totalAmount: string }>> {
    if (!input.linkedOrderItemIds.length) return [];
    const rows = await this.queryLinkedOpenOrders(this.prisma, input);
    return rows.map((order) => ({ id: order.id, purchaseOrderNo: order.purchaseOrderNo, supplierId: order.supplierId, currency: order.currency, itemCount: order.itemCount, totalAmount: order.totalAmount }));
  }
  /**
   * 「这份计划下、还能往里追明细的采购单」的**唯一**查询（`findMergeTarget` 与
   * `openOrdersForPlan` 共用）—— 什么算可并入只有一处实现，否则预览与下单一定会漂移成
   * 「预览说能并、下单却被拒」。
   */
  private async queryLinkedOpenOrders(client: Prisma.TransactionClient, input: { orderNo: string; bomId: string; linkedOrderItemIds: string[] }) {
    const orders = await client.purchaseOrder.findMany({
      where: {
        deletedAt: null,
        status: "ordered",
        orderNo: input.orderNo,
        bomId: input.bomId,
        // ① 明细里有计划行回写的链接：这张单是**这份计划**下出来的。
        items: { some: { deletedAt: null, id: { in: input.linkedOrderItemIds } } },
      },
      select: {
        id: true, purchaseOrderNo: true, supplierId: true, currency: true, totalAmount: true, createdAt: true,
        items: { where: { deletedAt: null }, select: { id: true, receipts: { where: { deletedAt: null }, select: { id: true } } } },
      },
      orderBy: { createdAt: "desc" },
    });
    return orders
      // ④ 没有任何到货事实（含"状态没刷新的已到货单"）。
      .filter((order) => order.items.every((item) => item.receipts.length === 0))
      .map((order) => ({ id: order.id, purchaseOrderNo: order.purchaseOrderNo, supplierId: order.supplierId, currency: order.currency, itemCount: order.items.length, totalAmount: order.totalAmount.toFixed(4) }));
  }
  /**
   * 把**一波新明细追加**到一张已经存在的采购单上（口径 3：只追加、不改已有的行）。
   *
   * 与 `replaceOrder()` 的区别正是这个功能的意义：后者"老行软删 + 新行重建"，
   * 用在一张已经发给供应商的单上等于重开一张单；这里只往后加。
   *
   * 头部只动两处：`total_amount` **累加**（口径 3）与留痕（口径 4）。
   * 采购日期 / 交货日期 / 备注 / 供应商 / 币种 / 打印字段**一概不动** —— 那是发出去那份凭证上的字。
   *
   * 在**调用方的事务里**写：追加明细与计划行的链接回写必须同生共死，否则会留下
   * 「采购单上多了几行、计划里还显示未下单」的中间态 —— 而那正是重复采购的入口。
   */
  async appendItems(tx: Prisma.TransactionClient, orderId: string, merged: MergedGroup, user: CurrentUser) {
    const { refs, items, total } = merged.prepared;
    const order = await tx.purchaseOrder.findFirst({
      where: { id: orderId, deletedAt: null },
      select: { id: true, purchaseOrderNo: true, currency: true, status: true, totalAmount: true, extensionData: true, items: { where: { deletedAt: null }, select: { receipts: { where: { deletedAt: null }, select: { id: true } } } } },
    });
    if (!order) throw new NotFoundException({ code: "PURCHASE_ORDER_NOT_FOUND", message: "采购单不存在", details: [] });
    const currency = merged.input.currency ?? "CNY";
    // 判据在**写之前**再过一次：`findMergeTarget()` 是事务里查的，但中间可能有别的写改掉了这张单
    // （同一事务里不会，可这道门是"不变式本身"——直接调本方法的调用方也必须过）。
    if (order.status !== "ordered" || order.items.some((item) => item.receipts.length)) {
      throw new UnprocessableEntityException({ code: "PURCHASE_ORDER_NOT_APPENDABLE", message: "这张采购单已有到货事实或状态已变，不能再追加明细；请重新下单（会新建一张单）", details: [{ purchase_order_id: orderId, status: order.status }] });
    }
    if (currency !== order.currency) {
      throw new UnprocessableEntityException({ code: "PURCHASE_ORDER_CURRENCY_MISMATCH", message: "要追加的明细与这张采购单的币种不一致（一张单只能有一个币种），请改币种或新建一张单", details: [{ purchase_order_currency: order.currency, item_currency: currency }] });
    }
    // 逐条 `create`（不用 `createMany`）：计划行要按新明细的 id 回写链接，而 `createMany` 不返回 id。
    const created = [];
    for (const item of items) {
      created.push(await tx.purchaseOrderItem.create({
        data: { purchaseOrderId: orderId, ...this.itemData(item, refs, user) },
        select: { id: true, extensionData: true, materialId: true, quantity: true, unitPrice: true },
      }));
    }
    const previous = (order.extensionData ?? {}) as Record<string, unknown>;
    const plan = (merged.input.extension_data?.purchase_plan ?? {}) as { plan_id?: string; plan_no?: string };
    const history = Array.isArray(previous.purchase_plan_merges) ? (previous.purchase_plan_merges as unknown[]) : [];
    // 只留最近 20 条：采购单是长期存在的，单头 JSON 不设上限会被它养成一个越来越大的字段（口径 4）。
    const merges = [...history, { at: new Date().toISOString(), plan_id: plan.plan_id ?? null, plan_no: plan.plan_no ?? null, line_count: items.length, amount: total }].slice(-20);
    const updated = await tx.purchaseOrder.update({
      where: { id: orderId },
      data: { totalAmount: new Prisma.Decimal(order.totalAmount).plus(total).toFixed(4), extensionData: { ...previous, purchase_plan_merges: merges } as Prisma.InputJsonValue, ...this.audit.update(user) },
      select: { id: true, purchaseOrderNo: true, currency: true, totalAmount: true, status: true },
    });
    return { order: updated, items: created };
  }
  /**
   * 按供应商收束一张**已经存在**的采购单（草稿，或已下单但没有任何到货）。
   *
   * 与 createSplit 的差别只有落点：第一组沿用这张单（采购单号不变），其余组新建。
   * 为什么不「新建 N 张再把原单取消」：草稿从来没有发给供应商，把它的内容重新组织一次
   * 不是一次「取消」业务；把原单标成已取消会让列表里凭空多一条作废记录，还白烧一个采购单号。
   *
   * 已下过的单收束后仍是已下单 —— 不能靠「保存草稿」把一张已经发给供应商的单悄悄退回草稿。
   */
  async splitExisting(id: string, input: SplitInput, user: CurrentUser) {
    const current = await this.get(id);
    this.assertEditable(current, "按供应商收束");
    const wasOrdered = current.status === "ordered";
    const reason = input.reason?.trim();
    if (wasOrdered && !reason) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "收束已下单采购单必须填写原因", details: [] });
    const targetOrdered = wasOrdered || input.place_order === true;
    const merged = await this.collectGroups(input, targetOrdered);
    const targetStatus = targetOrdered ? "ordered" : "draft";
    // 第一组沿用原单：扩展数据里同样记下这次收束的来源，与新建的其余组保持一样的可追溯性。
    const firstSplit = (merged[0].input.extension_data?.purchase_split ?? {}) as Record<string, unknown>;
    merged[0].input.extension_data = { ...(merged[0].input.extension_data ?? {}), purchase_split: { ...firstSplit, reused_purchase_order_no: current.purchaseOrderNo, resplit_from: current.purchaseOrderNo } };
    const created = await this.prisma.$transaction(async (tx) => {
      // 草稿 → 已下单时补上采购日期；已经是已下单的单保持原采购日期不动。
      const extra: Prisma.PurchaseOrderUncheckedUpdateInput = { status: targetStatus, ...(targetOrdered && !wasOrdered ? { purchaseDate: input.purchase_date ? new Date(input.purchase_date) : new Date() } : {}) };
      await this.replaceOrder(tx, id, merged[0].prepared, merged[0].input, user, extra);
      const rows = [];
      for (const entry of merged.slice(1)) rows.push(await tx.purchaseOrder.create({ data: this.orderData(entry.prepared, entry.input, user, targetStatus) }));
      return rows;
    });
    await this.audit.record("purchase_order.split", "purchase_order", user.id, id, {
      order_no: current.orderNo, purchase_order_no: current.purchaseOrderNo, group_count: merged.length,
      reused_purchase_order_no: current.purchaseOrderNo, created_purchase_order_nos: created.map((row) => row.purchaseOrderNo),
      status_before: current.status, status_after: targetStatus, reason: reason || undefined,
      before: wasOrdered ? this.orderSnapshot(current) : undefined,
      after: wasOrdered ? this.orderSnapshot(this.snapshotSource(merged[0].prepared, merged[0].input)) : undefined,
    });
    for (const row of created) await this.audit.record("purchase_order.create", "purchase_order", user.id, row.id, { order_no: row.orderNo, purchase_order_no: row.purchaseOrderNo, split_by_supplier: true, group_count: merged.length, split_from: current.purchaseOrderNo });
    return Promise.all([id, ...created.map((row) => row.id)].map((rowId) => this.get(rowId)));
  }
  /**
   * 收束请求的结构校验 + 参照物解析 + 下单前校验。
   *
   * 抽出来给 createSplit 与 splitExisting 共用：两条路径的校验必须**完全一致**，
   * 否则会出现「新建时不允许的写法，编辑时却放过去了」。
   *
   * 供应商只在**下单**时才是必需的：草稿要能存下刚导入、还没定供应商的 BOM 明细
   * （用户 2026-09-17：「导入 BOM 明细，也视为对采购单的编辑，允许保存」）。
   * 未选供应商的组最多一个 —— 它们同属一张「还没定供应商」的草稿。
   */
  async collectGroups(input: SplitInput, placeOrder: boolean): Promise<MergedGroup[]> {
    const groups = input.groups ?? [];
    if (!groups.length) throw new UnprocessableEntityException({ code: "PURCHASE_SPLIT_GROUPS_REQUIRED", message: "按供应商收束至少需要一个供应商分组", details: [] });
    if (placeOrder) {
      const missingSupplier = groups.findIndex((group) => !group.supplier_id);
      if (missingSupplier >= 0) throw new UnprocessableEntityException({ code: "PURCHASE_SPLIT_SUPPLIER_REQUIRED", message: `第 ${missingSupplier + 1} 组缺少供应商，不能下单`, details: [] });
    }
    const unassignedGroups = groups.filter((group) => !group.supplier_id).length;
    if (unassignedGroups > 1) throw new UnprocessableEntityException({ code: "PURCHASE_SPLIT_UNASSIGNED_DUPLICATE", message: "未选供应商的明细只能合成一组（它们同属一张还没有供应商的草稿）", details: [] });
    const emptyGroup = groups.findIndex((group) => !(group.items ?? []).length);
    if (emptyGroup >= 0) throw new UnprocessableEntityException({ code: "PURCHASE_SPLIT_ITEMS_REQUIRED", message: `第 ${emptyGroup + 1} 组没有采购明细`, details: [] });
    const merged: MergedGroup[] = [];
    for (const [index, group] of groups.entries()) {
      const currency = group.currency ?? input.currency ?? "CNY";
      await this.currencies?.assertSupported(currency, "采购单币种");
      // 组内明细的供应商一律取组供应商（未选供应商的组就是「都没有」）：收束的语义就是「一组一个供应商」。
      const groupInput: Input = { order_no: input.order_no, bom_id: input.bom_id, supplier_id: group.supplier_id, purchase_date: input.purchase_date, expected_date: group.expected_date, currency, remark: group.remark ?? input.remark, extension_data: { ...(input.extension_data ?? {}), purchase_split: { by: "supplier", supplier_id: group.supplier_id, group_index: index, group_count: groups.length } }, items: (group.items ?? []).map((item) => ({ ...item, supplier_id: group.supplier_id })) };
      const prepared = await this.prepare(groupInput);
      if (placeOrder) this.assertOrderableItems(groupInput.bom_id, prepared.items.map((item) => ({ materialId: item.material_id, unitId: item.unit_id, supplierId: item.supplier_id ?? "", quantity: item.quantity, unitPrice: item.unit_price })));
      merged.push({ input: groupInput, prepared });
    }
    return merged;
  }
  /** 可编辑判定：草稿随便改；已下单未到货的也允许，但要留原因（到货事实之后一律只能改打印信息）。 */
  private assertEditable(current: Awaited<ReturnType<PurchaseOrdersService["get"]>>, action: string) {
    const receipted = current.items.some((item) => item.receipts.length);
    if (receipted || !EDITABLE_PURCHASE_STATUSES.includes(current.status)) {
      throw new UnprocessableEntityException({ code: "PURCHASE_ORDER_NOT_EDITABLE", message: `已有到货事实或该状态的采购单不可${action}`, details: [] });
    }
  }
  /** 把 prepared 折成 orderSnapshot 需要的形状（新增的组与已有的行字段名不同，这里统一）。 */
  private snapshotSource(prepared: Prepared, input: Input) {
    return { supplierId: prepared.refs.supplier?.id ?? null, currency: input.currency ?? "CNY", totalAmount: prepared.total, items: prepared.items.map((item) => ({ materialId: item.material_id, supplierId: item.supplier_id, quantity: item.quantity, unitPrice: item.unit_price, expectedDate: item.expected_date })) };
  }
  /**
   * 采购单内容的紧凑快照，用于「已下单后改动」的前后值留痕。
   * 只记业务看得懂的字段：供应商、币种、金额、以及每行的物料/供应商/数量/单价/到货日期。
   */
  private orderSnapshot(values: { supplierId?: string | null; currency?: string | null; totalAmount?: unknown; items: Array<{ materialId: string; supplierId?: string | null; quantity: unknown; unitPrice: unknown; expectedDate?: Date | string | null }> }) {
    return {
      supplier_id: values.supplierId ?? null,
      currency: values.currency ?? null,
      total_amount: String(values.totalAmount ?? "0"),
      items: values.items.map((item) => ({
        material_id: item.materialId,
        supplier_id: item.supplierId,
        quantity: String(item.quantity),
        unit_price: String(item.unitPrice),
        expected_date: item.expectedDate ? new Date(item.expectedDate).toISOString().slice(0, 10) : null,
      })),
    };
  }
  /**
   * 某张 BOM 上每一行的下单情况 —— 用来避免同一行被重复采购（新建计划时就看得见）。
   *
   * 归集口径：**按采购单挂的那张 BOM**（`purchase_orders.bom_id`）取它的明细行，只算未删除的
   * 采购明细、排除已取消的采购单。四态：
   *
   * | 档 | 数据源 |
   * | --- | --- |
   * | `ordered` 已下单足量 / `partial` 部分下单 | **采购明细**（已下单及之后的单） |
   * | `draft` **计划中** | **采购计划行**（还没下单的那些，`purchase_order_item_id IS NULL`） |
   * | `none` 未下单 | 以上都没有 |
   *
   * ⚠️ 2026-09-27：第二档的数据源从"草稿采购单"换成了"计划行"，草稿已经不存在（采购计划接管了它）。
   * **字段名与枚举值刻意没改**（`draft_quantity` / `draft_purchase_order_nos` / `state: "draft"`）：
   * 设计文档 §4.2 明确保留，避免同时改动前端契约。所以这里要记住：**这一档里的单号是计划编号
   * （`PP-…`），不是采购单号（`PO-…`）**，界面上的文案是「计划中」。
   *
   * 由此带来一个**给后来人的提醒**：全仓库 `grep draft` 会同时命中"真正的草稿"（销售单/工资台账/
   * 领料单那边一堆）与"计划中"这一档。按 `status === "draft"` 过滤采购单时尤其要当心 ——
   * 这里说的是 `BomItemOrderState` 的一个枚举值，与 `purchase_orders.status` 毫无关系。
   * 想彻底消除这个歧义就是一次 4 文件的小改动（服务 + 类型 + 前端类型 + 用例），等确认。
   *
   * ⚠️ 为什么不能按「BOM 当前行的 ID」去归集（2026-09-20 现场问题：「有些物料已经下单了，
   * 但新建采购单里下单状态还是未下单」）：`PUT /boms/:id/items`（界面上的「保存 BOM 表」，
   * 采购单页里就有「编辑BOM表」入口，生产模块也能改）走的是 `BomsService.replaceItems` =
   * **软删全部旧行 + 整批建新行** —— 存一次 BOM，**所有行的 ID 都会换掉**；而采购明细里存的
   * `bom_item_id` 是**下单当时那一版**的 ID。按当前行 ID 去 `in` 一下，那些量会整块消失，
   * 界面显示「未下单」→ 采购员再下一张 = 重复采购（正是这一列要防的事）。
   *
   * 所以：按 BOM 取单，再按行 ID **精确**归集；行 ID 已被换掉的历史量按**物料**摊回该物料在
   * 当前 BOM 的第一行（同一物料在 BOM 里出现多行时只会摊到第一行，不重复计数）。
   * **计划行同样要摊回** —— 它存的也是"建计划当时那一版"的行 ID。
   */
  async bomItemOrderStatus(bomId: string) {
    const bom = await this.prisma.bom.findFirst({ where: { id: bomId, deletedAt: null }, select: { id: true } });
    if (!bom) throw new NotFoundException({ code: "BOM_NOT_FOUND", message: "BOM 不存在", details: [] });
    const items = await this.prisma.bomItem.findMany({ where: { bomId, deletedAt: null }, select: { id: true, requiredQuantity: true, materialId: true } });
    if (!items.length) return [] as Array<{ bom_item_id: string; required_quantity: string; ordered_quantity: string; draft_quantity: string; state: BomItemOrderState; ordered_purchase_order_nos: string[]; draft_purchase_order_nos: string[] }>;
    const rows = await this.prisma.purchaseOrderItem.findMany({
      where: { deletedAt: null, bomItemId: { not: null }, purchaseOrder: { deletedAt: null, bomId, status: { not: "cancelled" } } },
      select: { bomItemId: true, materialId: true, quantity: true, purchaseOrder: { select: { purchaseOrderNo: true, status: true } } },
    });
    // 第二档（计划中）：这张 BOM 的计划里**还没下单**的行。已下单的行不算在这里 ——
    // 它们的量已经通过上面的采购明细进了 `ordered` 档，重复计一次会让"还差多少"算少。
    const plannedRows = await this.prisma.purchasePlanItem.findMany({
      where: { deletedAt: null, purchaseOrderItemId: null, plan: { bomId, deletedAt: null } },
      select: { bomItemId: true, materialId: true, quantity: true, plan: { select: { planNo: true } } },
    });
    const currentIds = new Set(items.map((item) => item.id));
    // 摊回目标：该物料在当前 BOM 里的第一行。行 ID 还在的走精确归集，不会用到这张表。
    const firstRowOfMaterial = new Map<string, string>();
    for (const item of items) if (item.materialId && !firstRowOfMaterial.has(item.materialId)) firstRowOfMaterial.set(item.materialId, item.id);
    const accumulator = new Map<string, { ordered: Prisma.Decimal; draft: Prisma.Decimal; orderedNos: Set<string>; draftNos: Set<string> }>();
    /** `bom_item_id` 为空的是 BOM 外的新增行（补料/替代料）：它不占任何 BOM 行的需求量。 */
    const keyOf = (row: { bomItemId: string | null; materialId: string | null }) => {
      if (!row.bomItemId) return undefined;
      return currentIds.has(row.bomItemId) ? row.bomItemId : (row.materialId ? firstRowOfMaterial.get(row.materialId) : undefined);
    };
    for (const row of rows) {
      const key = keyOf(row);
      // 物料已经从 BOM 里删掉了：这条历史下单不摊到别的行上（宁可少显示，也不能张冠李戴）。
      if (!key) continue;
      const entry = accumulator.get(key) ?? { ordered: new Prisma.Decimal(0), draft: new Prisma.Decimal(0), orderedNos: new Set<string>(), draftNos: new Set<string>() };
      const quantity = new Prisma.Decimal(row.quantity ?? 0);
      if (ORDERED_PURCHASE_STATUSES.includes(row.purchaseOrder?.status ?? "")) {
        entry.ordered = entry.ordered.plus(quantity);
        if (row.purchaseOrder?.purchaseOrderNo) entry.orderedNos.add(row.purchaseOrder.purchaseOrderNo);
      }
      accumulator.set(key, entry);
    }
    for (const row of plannedRows) {
      const key = keyOf(row);
      if (!key) continue;
      const entry = accumulator.get(key) ?? { ordered: new Prisma.Decimal(0), draft: new Prisma.Decimal(0), orderedNos: new Set<string>(), draftNos: new Set<string>() };
      entry.draft = entry.draft.plus(new Prisma.Decimal(row.quantity ?? 0));
      // 这里塞进去的是**计划编号**（`PP-…`）。字段名叫 `draft_purchase_order_nos` 是历史原因，见方法注释。
      if (row.plan?.planNo) entry.draftNos.add(row.plan.planNo);
      accumulator.set(key, entry);
    }
    return items.map((item) => {
      const entry = accumulator.get(item.id);
      const required = new Prisma.Decimal(item.requiredQuantity ?? 0);
      const ordered = entry?.ordered ?? new Prisma.Decimal(0);
      const draft = entry?.draft ?? new Prisma.Decimal(0);
      // 「已下单足量」按需求量比；需求量为 0 的行不因为「0 已下单」而被判成足量。
      // 计划中的量**不**计入 ordered：计划不等于下单，这正是这一档存在的意义。
      const state: BomItemOrderState = required.gt(0) && ordered.gte(required) ? "ordered" : ordered.gt(0) ? "partial" : draft.gt(0) ? "draft" : "none";
      return { bom_item_id: item.id, required_quantity: required.toFixed(4), ordered_quantity: ordered.toFixed(4), draft_quantity: draft.toFixed(4), state, ordered_purchase_order_nos: [...(entry?.orderedNos ?? [])], draft_purchase_order_nos: [...(entry?.draftNos ?? [])] };
    });
  }
  private async prepare(input: Input): Promise<Prepared> {
    const refs = await this.refs(input);
    const items = refs.items;
    const total = items.reduce((sum, item) => sum.plus(this.amount(item)), new Prisma.Decimal(0)).toFixed(4);
    return { refs, items, total };
  }
  private orderData(prepared: Prepared, input: Input, user: CurrentUser, status: "draft" | "ordered") {
    const { refs, items, total } = prepared;
    return {
      purchaseOrderNo: `PO-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`,
      orderNo: refs.order.orderNo,
      salesOrderId: refs.order.id,
      bomId: refs.bom?.id ?? null,
      bomVersion: refs.bom?.version ?? null,
      bomSnapshot: (refs.bom ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
      supplierId: refs.supplier?.id ?? null,
      supplierSnapshot: (refs.supplier ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
      purchaseDate: input.purchase_date ? new Date(input.purchase_date) : new Date(),
      expectedDate: this.orderExpectedDate(input),
      currency: input.currency ?? "CNY",
      status,
      totalAmount: total,
      remark: input.remark,
      extensionData: (input.extension_data ?? {}) as Prisma.InputJsonValue,
      ...this.audit.create(user),
      items: { create: items.map((item) => this.itemData(item, refs, user)) },
    };
  }
  private itemData(item: Item, refs: Refs, user: CurrentUser) {
    const material = refs.materials.get(item.material_id)!;
    const unit = refs.units.get(item.unit_id)!;
    // 供应商可空：草稿允许「还没定供应商」的行（见 schema 里 PurchaseOrderItem.supplierId 的注释）。
    const itemSupplier = item.supplier_id ? refs.supplierMap.get(item.supplier_id) : undefined;
    return { supplierId: itemSupplier?.id ?? null, supplierSnapshot: (itemSupplier ?? undefined) as unknown as Prisma.InputJsonValue | undefined, expectedDate: this.itemExpectedDate(item), materialId: material.id, materialSnapshot: material as unknown as Prisma.InputJsonValue, unitId: unit.id, unitSnapshot: unit as unknown as Prisma.InputJsonValue, bomItemId: item.bom_item_id, model: item.model, quantity: item.quantity, unitPrice: item.unit_price, taxRate: item.tax_rate, extraFee: item.extra_fee ?? "0", amount: this.amount(item).toFixed(4), extensionData: (item.extension_data ?? {}) as Prisma.InputJsonValue, ...this.audit.create(user) };
  }
  /**
   * `PATCH /purchase-orders/:id`：**只收打印信息**，明细变更一律拒绝（口径 7）。
   *
   * 2026-09-27 之前这里是「整体替换头部 + 明细」，已下单未到货的单也能改（要填原因）。
   * 现在数量/单价/供应商的**唯一编辑点是采购计划**：两个模块都能改数量，
   * 就会出现同一批货两份数字，而「这张 BOM 还差什么没买」会失真 ——
   * 现有草稿工作区就出现过「已经下单了，但下单状态没及时更新」这条真实缺陷。
   *
   * 老客户端还在发 `items`/`supplier_id` 这些键，所以**给一句话**而不是 404：
   * 422 `PURCHASE_ORDER_DETAIL_READONLY`，提示去采购计划里改。
   * 要改一张已下单的单，正确动作是「**退回采购计划**」（见 `PurchasePlansService.revertPurchaseOrder`）。
   */
  async update(id: string, input: Input & PrintFieldsInput, user: CurrentUser) {
    const sent = PURCHASE_ORDER_DETAIL_KEYS.filter((key) => (input as Record<string, unknown>)[key] !== undefined);
    if (sent.length) {
      throw new UnprocessableEntityException({
        code: "PURCHASE_ORDER_DETAIL_READONLY",
        message: "采购单的数量/单价/供应商/明细（以及单号、币种、采购日期）只能在采购计划里改——采购单是对外凭证；这里只能填打印信息（付款方式/交期条款/交货地址/交货日期/备注/回签），要改内容请先「退回采购计划」",
        details: [{ fields: sent }],
      });
    }
    return this.updatePrintFields(id, input, user);
  }
  /**
   * 把一张采购单的内容整体换成 prepared：老明细软删 + 新明细批量建 + 头部字段更新。
   *
   * 抽出来是为了让「整体编辑」与「按供应商收束（第一组沿用原单）」走**同一段写入逻辑** ——
   * 两份拷贝迟早会漂移，而漂移的后果是头部供应商/金额与明细对不上。
   */
  private async replaceOrder(tx: Prisma.TransactionClient, id: string, prepared: Prepared, input: Input, user: CurrentUser, extra: Prisma.PurchaseOrderUncheckedUpdateInput = {}) {
    const { refs, items, total } = prepared;
    await tx.purchaseOrderItem.updateMany({ where: { purchaseOrderId: id, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id } });
    await tx.purchaseOrder.update({ where: { id }, data: { orderNo: refs.order.orderNo, salesOrderId: refs.order.id, bomId: refs.bom?.id ?? null, bomVersion: refs.bom?.version ?? null, bomSnapshot: (refs.bom ?? undefined) as unknown as Prisma.InputJsonValue | undefined, supplierId: refs.supplier?.id ?? null, supplierSnapshot: (refs.supplier ?? undefined) as unknown as Prisma.InputJsonValue | undefined, expectedDate: this.orderExpectedDate(input) ?? null, currency: input.currency ?? "CNY", totalAmount: total, remark: input.remark, extensionData: (input.extension_data ?? {}) as Prisma.InputJsonValue, ...extra, ...this.audit.update(user) } });
    await tx.purchaseOrderItem.createMany({ data: items.map((item) => { const material = refs.materials.get(item.material_id)!; const unit = refs.units.get(item.unit_id)!; const itemSupplier = item.supplier_id ? refs.supplierMap.get(item.supplier_id) : undefined; return { purchaseOrderId: id, supplierId: itemSupplier?.id ?? null, supplierSnapshot: (itemSupplier ?? undefined) as unknown as Prisma.InputJsonValue | undefined, expectedDate: this.itemExpectedDate(item), materialId: material.id, materialSnapshot: material as unknown as Prisma.InputJsonValue, unitId: unit.id, unitSnapshot: unit as unknown as Prisma.InputJsonValue, bomItemId: item.bom_item_id, model: item.model, quantity: item.quantity, unitPrice: item.unit_price, taxRate: item.tax_rate, extraFee: item.extra_fee ?? "0", amount: this.amount(item).toFixed(4), extensionData: (item.extension_data ?? {}) as Prisma.InputJsonValue, ...this.audit.create(user) }; }) });
  }
  /** 草稿可以不完整，但下单必须齐全：BOM、至少一行明细，且每行物料/单位/供应商/数量/单价完整。 */
  private assertOrderable(po: Awaited<ReturnType<PurchaseOrdersService["get"]>>) {
    this.assertOrderableItems(po.bomId, po.items.map((item) => ({ materialId: item.materialId, unitId: item.unitId, supplierId: item.supplierId ?? "", quantity: item.quantity?.toString() ?? "", unitPrice: item.unitPrice?.toString() ?? "" })));
  }
  /** 建单前的同一套下单前校验：拆分下单时明细还只是请求体，没有采购单号可查。 */
  private assertOrderableItems(bomId: string | null | undefined, items: OrderableItem[]) {
    const missing: Array<{ code: string; message: string }> = [];
    if (!bomId) missing.push({ code: "BOM_REQUIRED", message: "请先选择 BOM 表" });
    if (!items.length) missing.push({ code: "ITEMS_REQUIRED", message: "请至少添加一行采购明细" });
    items.forEach((item, index) => {
      const reasons: string[] = [];
      if (!item.materialId) reasons.push("物料");
      if (!item.unitId) reasons.push("单位");
      if (!item.supplierId) reasons.push("供应商");
      if (!this.isPositive(item.quantity)) reasons.push("数量");
      // 单价必须**大于 0**，不是"不为负"（2026-09-30）：应付金额 = 入库数量 × 采购明细单价，
      // 所以 0 单价的下单会变成一条 0 元应付 —— 财务收到一张没法付的单，而全链路不报错。
      // 收束下单那条路上计划侧还会先给一句更具体的提示（`PURCHASE_PLAN_PRICE_REQUIRED`），
      // 这一层是**不变式本身**：`POST /purchase-orders` 与 `/split` 两个原始接口也必须过同一道门。
      //
      // 这里曾经有一个 `allowPendingPrice` 例外（2026-10-09 的「价格待定」下单）。**已删除**：
      // 2026-10-11 用户改了口径「确定单价的能下单，没确定单价的先不下单」，所以 0 价一律不下单，
      // 没有任何调用方能放行 —— 少一个开关就少一条通往 0 元应付的后门。
      if (!this.isPositive(item.unitPrice)) reasons.push("单价");
      if (reasons.length) missing.push({ code: "ITEM_INCOMPLETE", message: `第 ${index + 1} 行明细缺少：${reasons.join("、")}` });
    });
    if (missing.length) throw new UnprocessableEntityException({ code: "PURCHASE_ORDER_INCOMPLETE", message: "草稿尚未填写完整，不能下单", details: missing });
  }
  /**
   * 采购单「打印信息」：付款方式 / 交期条款 / 交货地址 / 交货日期 / 备注 / 厂家回签意见 / 厂家回签 / 主管签字。
   *
   * 用户 2026-09-16：「对应的，系统中采购单，也要支持对这些字段进行填写和设置」。
   *
   * 为什么单独一个端点、而不并进 `PATCH :id`：后者按「已有下游事实或非草稿不可编辑」锁死整张单，
   * 而**厂家回签本来就是下单之后才发生的事**（先把单发给厂商、厂商签回来、我们再登记）。
   * 这里只碰这些与明细、金额、供应商都无关的字，不动 items / totalAmount / status，
   * 因此草稿、已下单、部分到货、到货完成的单子都可以填；已取消的拒绝（它不再对外）。
   * 空串按「清除」处理：把一格删空的意思就是这一格不印字。
   */
  async updatePrintFields(id: string, input: PrintFieldsInput, user: CurrentUser) {
    const po = await this.prisma.purchaseOrder.findFirst({ where: { id, deletedAt: null }, select: { id: true, purchaseOrderNo: true, status: true } });
    if (!po) throw new NotFoundException({ code: "PURCHASE_ORDER_NOT_FOUND", message: "采购单不存在", details: [] });
    if (po.status === "cancelled") throw new UnprocessableEntityException({ code: "PURCHASE_ORDER_NOT_EDITABLE", message: "已取消的采购单不能修改打印信息", details: [] });

    const data: Prisma.PurchaseOrderUpdateInput = {};
    if (input.payment_terms !== undefined) data.paymentTerms = this.optionalText(input.payment_terms);
    if (input.delivery_terms !== undefined) data.deliveryTerms = this.optionalText(input.delivery_terms);
    if (input.delivery_address !== undefined) data.deliveryAddress = this.optionalText(input.delivery_address);
    if (input.remark !== undefined) data.remark = this.optionalText(input.remark);
    if (input.supplier_reply !== undefined) data.supplierReply = this.optionalText(input.supplier_reply);
    if (input.supplier_signed !== undefined) data.supplierSigned = this.optionalText(input.supplier_signed);
    if (input.supervisor_signature !== undefined) data.supervisorSignature = this.optionalText(input.supervisor_signature);
    // 交货日期是真正的日期列：显式传 null 表示清空（由明细行的到货日期兜底打印）
    if (input.expected_date !== undefined) data.expectedDate = input.expected_date ? new Date(input.expected_date) : null;

    const updated = await this.prisma.purchaseOrder.update({ where: { id }, data: { ...data, ...this.audit.update(user) } });
    await this.audit.record("purchase_order.print_fields", "purchase_order", user.id, id, { purchase_order_no: po.purchaseOrderNo, status: po.status, fields: Object.keys(data) });
    return updated;
  }

  /** 空串 → null（表单里删空一格 = 这一格不印字），并去掉首尾空白。 */
  private optionalText(value: string | null | undefined): string | null {
    const trimmed = String(value ?? "").trim();
    return trimmed ? trimmed : null;
  }

  async order(id: string, user: CurrentUser) { const po = await this.get(id); if (po.status !== "draft") throw new UnprocessableEntityException({ code: "INVALID_PURCHASE_STATE", message: "只有草稿采购单可以下单", details: [] }); this.assertOrderable(po); const headSupplierId = po.supplierId ?? po.items[0]?.supplierId ?? null; const result = await this.prisma.purchaseOrder.update({ where: { id }, data: { status: "ordered", supplierId: headSupplierId, purchaseDate: po.purchaseDate ?? new Date(), currency: po.currency ?? "CNY", ...this.audit.update(user) } }); await this.audit.record("purchase_order.order", "purchase_order", user.id, id, { order_no: po.orderNo }); return result; }
  // `revertToDraft` 与 `cancel` 已在 2026-09-27 删除：
  //   · 前者把已下单的单退回 `draft`，而草稿这个概念已经被采购计划接管（迁移会把历史草稿归并成计划），
  //     退回草稿等于回到一个不存在的状态。改单的正确动作是「退回采购计划」，
  //     它由 `PurchasePlansService.revertPurchaseOrder` 实现 —— 放在计划那一侧是因为
  //     **退回的落点是计划行**（断开 1:1 链接），而且这样两条服务的依赖是单向的
  //     （计划 → 采购单），不会绕成循环依赖。
  //   · 后者只允许取消 `draft`（草稿消失后它是死代码）；"供应商说做不了"的出口也是退回计划。
  async receipt(id: string, itemId: string, input: { quantity: string; received_date: string; reference_no?: string; remark?: string; idempotency_key?: string; over_receipt_reason?: string }, user: CurrentUser) { const quantity = this.positive(input.quantity, "到货数量必须是大于零的十进制数"); const receipt = await this.prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id}::uuid FOR UPDATE`; const po = await tx.purchaseOrder.findFirst({ where: { id, deletedAt: null }, include: { items: { where: { deletedAt: null }, include: { receipts: { where: { deletedAt: null }, orderBy: { receivedDate: "asc" } }, material: true } } } }); if (!po || !["ordered", "partially_arrived"].includes(po.status)) throw new UnprocessableEntityException({ code: "INVALID_PURCHASE_STATE", message: "当前采购单不可登记到货", details: [] }); const item = po.items.find((candidate) => candidate.id === itemId); if (!item) throw new UnprocessableEntityException({ code: "INVALID_RECEIPT", message: "到货明细或数量不合法", details: [] }); if (item.material.materialType !== "raw_material") throw new UnprocessableEntityException({ code: "PURCHASE_FINISHED_PRODUCT_FORBIDDEN", message: "采购单只能登记原料到货", details: [] }); const existing = input.idempotency_key ? item.receipts.find((row) => (row.extensionData as { idempotency_key?: string } | null)?.idempotency_key === input.idempotency_key) : undefined; if (existing) return { created: existing, po, batchSequence: item.receipts.indexOf(existing) + 1, payableAmount: new Prisma.Decimal(((existing.extensionData as { payable_amount?: string } | null)?.payable_amount) ?? existing.quantity.mul(item.unitPrice).toFixed(4)) }; if (!item.unitPrice.gt(0)) throw new UnprocessableEntityException({ code: "PURCHASE_ITEM_PRICE_PENDING", message: "这一行的单价还是 0（价格待定）：请先在采购计划里补填单价，再登记到货 —— 应付金额就是按「入库数量 × 单价」算出来的", details: [{ purchase_order_item_id: itemId }] }); const currentReceived = item.receipts.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0)); const totalReceived = currentReceived.plus(quantity); if (totalReceived.gt(item.quantity) && !input.over_receipt_reason?.trim()) throw new UnprocessableEntityException({ code: "PURCHASE_OVER_RECEIPT_REASON_REQUIRED", message: "到货数量超过采购数量，必须填写超收原因", details: [{ ordered_quantity: item.quantity.toString(), received_quantity: currentReceived.toString(), requested_quantity: quantity.toString() }] }); const batchSequence = item.receipts.length + 1; const extensionData = { idempotency_key: input.idempotency_key ?? null, batch_sequence: batchSequence, payable_status: "not_applicable_until_inbound_posted", payable_amount: "0.0000", over_receipt_reason: input.over_receipt_reason ?? null }; const created = await tx.purchaseReceipt.create({ data: { purchaseOrderId: po.id, purchaseOrderItemId: item.id, orderNo: po.orderNo, receiptNo: `GR-${randomUUID().slice(0, 12).toUpperCase()}`, referenceNo: input.reference_no, receivedDate: new Date(input.received_date), quantity, extensionData, remark: input.remark, ...this.audit.create(user) } }); await tx.incomingInspection.create({ data: { purchaseReceiptId: created.id, orderNo: po.orderNo, inspectedQuantity: 0, acceptedQuantity: 0, conditionalQuantity: 0, rejectedQuantity: 0, status: "pending", extensionData: { batch_sequence: batchSequence }, ...this.audit.create(user) } }); const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: po.id, deletedAt: null }, include: { receipts: { where: { deletedAt: null } } } }); const complete = items.length > 0 && items.every((candidate) => candidate.receipts.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0)).gte(candidate.quantity)); await tx.purchaseOrder.update({ where: { id }, data: { status: complete ? "arrived_complete" : "partially_arrived", ...this.audit.update(user) } }); return { created, po, batchSequence }; }); await this.audit.record("purchase_receipt.create", "purchase_receipt", user.id, receipt.created.id, { order_no: receipt.po.orderNo, purchase_order_id: id, batch_sequence: receipt.batchSequence }); return { ...receipt.created, batchSequence: receipt.batchSequence, payableStatus: "not_applicable_until_inbound_posted", payableAmount: "0.0000" }; }
  async updateReceipt(id: string, input: { quantity: string; reference_no?: string; remark?: string; over_receipt_reason?: string; reason: string }, user: CurrentUser) { const quantity = this.positive(input.quantity, "到货数量必须是大于零的十进制数"); if (!input.reason?.trim()) throw new UnprocessableEntityException({ code: "INVALID_RECEIPT_UPDATE", message: "到货数量和修改原因必须填写", details: [] }); const updated = await this.prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT purchase_order_id FROM purchase_receipts WHERE id = ${id}::uuid FOR UPDATE`; const receipt = await tx.purchaseReceipt.findFirst({ where: { id, deletedAt: null }, include: { purchaseOrder: true, purchaseOrderItem: true, inspections: { where: { deletedAt: null } }, rawMaterialInbounds: { where: { deletedAt: null } }, payableSources: { where: { status: { not: "voided" } } } } }); if (!receipt) throw new NotFoundException({ code: "RECEIPT_NOT_FOUND", message: "到货记录不存在", details: [] }); await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${receipt.purchaseOrderId}::uuid FOR UPDATE`; const lockedOrder = await tx.purchaseOrder.findFirst({ where: { id: receipt.purchaseOrderId, deletedAt: null }, select: { extensionData: true } }); if (lockedOrder && this.arrivalClosed(lockedOrder.extensionData)) throw new UnprocessableEntityException({ code: "PURCHASE_ARRIVALS_CLOSED", message: "采购单到货已关闭，不可修改批次", details: [] }); if (receipt.inspections.some((row) => row.inspectedQuantity.gt(0)) || receipt.rawMaterialInbounds.length || receipt.payableSources.some((row) => row.status === "posted")) throw new UnprocessableEntityException({ code: "RECEIPT_DOWNSTREAM_EXISTS", message: "已有质检、入库或财务过账事实的到货批次不可直接修改", details: [] }); const sibling = await tx.purchaseReceipt.aggregate({ where: { purchaseOrderItemId: receipt.purchaseOrderItemId, id: { not: id }, deletedAt: null }, _sum: { quantity: true } }); const total = new Prisma.Decimal(sibling._sum.quantity ?? 0).plus(quantity); if (total.gt(receipt.purchaseOrderItem.quantity) && !input.over_receipt_reason?.trim()) throw new UnprocessableEntityException({ code: "PURCHASE_OVER_RECEIPT_REASON_REQUIRED", message: "到货数量超过采购数量，必须填写超收原因", details: [{ ordered_quantity: receipt.purchaseOrderItem.quantity.toString(), received_quantity: sibling._sum.quantity?.toString() ?? "0", requested_quantity: quantity.toString() }] }); const currentData = (receipt.extensionData ?? {}) as Record<string, unknown>; const extensionData = { ...currentData, over_receipt_reason: input.over_receipt_reason ?? (currentData.over_receipt_reason as string | null) ?? null } as Prisma.InputJsonValue; const row = await tx.purchaseReceipt.update({ where: { id }, data: { quantity, referenceNo: input.reference_no, remark: input.remark, extensionData, ...this.audit.update(user) } }); return { row, orderNo: receipt.orderNo }; }); await this.audit.record("purchase_receipt.update", "purchase_receipt", user.id, id, { order_no: updated.orderNo, reason: input.reason }); return updated.row; }
  async cancelReceipt(id: string, reason: string, user: CurrentUser) { if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "撤销到货必须填写原因", details: [] }); const result = await this.prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT purchase_order_id FROM purchase_receipts WHERE id = ${id}::uuid FOR UPDATE`; const receipt = await tx.purchaseReceipt.findFirst({ where: { id, deletedAt: null }, include: { purchaseOrder: true, inspections: { where: { deletedAt: null } }, rawMaterialInbounds: { where: { deletedAt: null } }, payableSources: { where: { status: { not: "voided" } } } } }); if (!receipt) throw new NotFoundException({ code: "RECEIPT_NOT_FOUND", message: "到货记录不存在", details: [] }); await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${receipt.purchaseOrderId}::uuid FOR UPDATE`; const lockedOrder = await tx.purchaseOrder.findFirst({ where: { id: receipt.purchaseOrderId, deletedAt: null }, select: { extensionData: true } }); if (lockedOrder && this.arrivalClosed(lockedOrder.extensionData)) throw new UnprocessableEntityException({ code: "PURCHASE_ARRIVALS_CLOSED", message: "采购单到货已关闭，不可撤销批次", details: [] }); if (receipt.inspections.some((row) => row.inspectedQuantity.gt(0)) || receipt.rawMaterialInbounds.length || receipt.payableSources.some((row) => row.status === "posted")) throw new UnprocessableEntityException({ code: "RECEIPT_DOWNSTREAM_EXISTS", message: "已有质检、入库或财务过账事实的到货批次不可直接撤销", details: [] }); const row = await tx.purchaseReceipt.update({ where: { id }, data: { ...this.audit.softDelete(user) } }); await tx.incomingInspection.updateMany({ where: { purchaseReceiptId: id, deletedAt: null }, data: { ...this.audit.softDelete(user) } }); await tx.payableSource.updateMany({ where: { purchaseReceiptId: id, status: { not: "voided" } }, data: { status: "voided", ...this.audit.update(user) } }); const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: receipt.purchaseOrderId, deletedAt: null }, include: { receipts: { where: { deletedAt: null } } } }); const complete = items.length > 0 && items.every((item) => item.receipts.reduce((sum, current) => sum.plus(current.quantity), new Prisma.Decimal(0)).gte(item.quantity)); const hasReceipt = items.some((item) => item.receipts.length > 0); await tx.purchaseOrder.update({ where: { id: receipt.purchaseOrderId }, data: { status: complete ? "arrived_complete" : hasReceipt ? "partially_arrived" : "ordered", ...this.audit.update(user) } }); return { row, orderNo: receipt.orderNo }; }); await this.audit.record("purchase_receipt.cancel", "purchase_receipt", user.id, id, { order_no: result.orderNo, reason }); return result.row; }
  async closeArrivals(id: string, user: CurrentUser) { const result = await this.prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id}::uuid FOR UPDATE`; const po = await tx.purchaseOrder.findFirst({ where: { id, deletedAt: null }, include: { items: { where: { deletedAt: null }, include: { receipts: { where: { deletedAt: null } } } } } }); if (!po) throw new NotFoundException({ code: "PURCHASE_ORDER_NOT_FOUND", message: "采购单不存在", details: [] }); if (!["ordered", "partially_arrived"].includes(po.status)) throw new UnprocessableEntityException({ code: "INVALID_PURCHASE_STATE", message: "当前采购单不可关闭到货", details: [] }); const planned = po.items.reduce((sum, item) => sum.plus(item.quantity), new Prisma.Decimal(0)); const received = po.items.reduce((sum, item) => sum.plus(item.receipts.reduce((subtotal, row) => subtotal.plus(row.quantity), new Prisma.Decimal(0))), new Prisma.Decimal(0)); const complete = po.items.length > 0 && po.items.every((item) => item.receipts.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0)).gte(item.quantity)); if (!complete) throw new UnprocessableEntityException({ code: "PURCHASE_RECEIPT_NOT_COMPLETE", message: "所有采购明细到货数量达到计划后才能关闭到货", details: [{ planned_quantity: planned.toString(), received_quantity: received.toString() }] }); return tx.purchaseOrder.update({ where: { id }, data: { status: "arrived_complete", extensionData: { ...((po.extensionData ?? {}) as Record<string, unknown>), arrival_closed: true, over_order: received.gt(planned), planned_quantity: planned.toString(), received_quantity: received.toString() }, ...this.audit.update(user) } }); }); await this.audit.record("purchase_order.arrival_close", "purchase_order", user.id, id, { order_no: result.orderNo, over_order: Boolean((result.extensionData as Record<string, unknown>).over_order) }); return result; }

  async closeArrivalsV2(id: string, user: CurrentUser) {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id}::uuid FOR UPDATE`;
      const po = await tx.purchaseOrder.findFirst({ where: { id, deletedAt: null }, include: { items: { where: { deletedAt: null }, include: { receipts: { where: { deletedAt: null } } } } } });
      if (!po) throw new NotFoundException({ code: "PURCHASE_ORDER_NOT_FOUND", message: "采购单不存在", details: [] });
      const extensionData = (po.extensionData ?? {}) as Record<string, unknown>;
      if (!["ordered", "partially_arrived", "arrived_complete"].includes(po.status) || extensionData.arrival_closed === true) throw new UnprocessableEntityException({ code: "INVALID_PURCHASE_STATE", message: "当前采购单不可关闭到货", details: [] });
      const planned = po.items.reduce((sum, item) => sum.plus(item.quantity), new Prisma.Decimal(0));
      const received = po.items.reduce((sum, item) => sum.plus(item.receipts.reduce((subtotal, row) => subtotal.plus(row.quantity), new Prisma.Decimal(0))), new Prisma.Decimal(0));
      const complete = po.items.length > 0 && po.items.every((item) => item.receipts.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0)).gte(item.quantity));
      if (!complete) throw new UnprocessableEntityException({ code: "PURCHASE_RECEIPT_NOT_COMPLETE", message: "所有采购明细到货数量达到计划后才能关闭到货", details: [{ planned_quantity: planned.toString(), received_quantity: received.toString() }] });
      return tx.purchaseOrder.update({ where: { id }, data: { status: "arrived_complete", extensionData: { ...extensionData, arrival_closed: true, over_order: received.gt(planned), planned_quantity: planned.toString(), received_quantity: received.toString() }, ...this.audit.update(user) } });
    });
    await this.audit.record("purchase_order.arrival_close", "purchase_order", user.id, id, { order_no: result.orderNo, over_order: Boolean((result.extensionData as Record<string, unknown>).over_order) });
    return result;
  }

  async updateReceiptV2(id: string, input: { quantity: string; reference_no?: string; remark?: string; over_receipt_reason?: string; reason: string }, user: CurrentUser) {
    const receipt = await this.prisma.purchaseReceipt.findFirst({ where: { id, deletedAt: null }, include: { purchaseOrder: { select: { extensionData: true } } } });
    if (receipt && this.arrivalClosed(receipt.purchaseOrder.extensionData)) throw new UnprocessableEntityException({ code: "PURCHASE_ARRIVALS_CLOSED", message: "采购单到货已关闭，不可修改批次", details: [] });
    const result = await this.updateReceipt(id, input, user);
    if (receipt) await this.refreshOrderStatus(receipt.purchaseOrderId, user);
    return result;
  }

  private async refreshOrderStatus(orderId: string, user: CurrentUser) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: orderId, deletedAt: null }, include: { receipts: { where: { deletedAt: null } } } });
      const complete = items.length > 0 && items.every((item) => item.receipts.reduce((sum, current) => sum.plus(current.quantity), new Prisma.Decimal(0)).gte(item.quantity));
      const hasReceipt = items.some((item) => item.receipts.length > 0);
      await tx.purchaseOrder.update({ where: { id: orderId }, data: { status: complete ? "arrived_complete" : hasReceipt ? "partially_arrived" : "ordered", ...this.audit.update(user) } });
    });
  }

  async cancelReceiptV2(id: string, reason: string, user: CurrentUser) {
    const receipt = await this.prisma.purchaseReceipt.findFirst({ where: { id, deletedAt: null }, include: { purchaseOrder: { select: { extensionData: true } } } });
    if (receipt && this.arrivalClosed(receipt.purchaseOrder.extensionData)) throw new UnprocessableEntityException({ code: "PURCHASE_ARRIVALS_CLOSED", message: "采购单到货已关闭，不可撤销批次", details: [] });
    return this.cancelReceipt(id, reason, user);
  }

  async receiptV2(id: string, itemId: string, input: { quantity: string; received_date: string; reference_no?: string; remark?: string; idempotency_key?: string; over_receipt_reason?: string }, user: CurrentUser) {
    const quantity = this.positive(input.quantity, "到货数量必须是大于零的十进制数");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id}::uuid FOR UPDATE`;
      const po = await tx.purchaseOrder.findFirst({ where: { id, deletedAt: null }, include: { items: { where: { deletedAt: null }, include: { receipts: { where: { deletedAt: null }, orderBy: { receivedDate: "asc" } }, material: true } } } });
      if (!po || !["ordered", "partially_arrived", "arrived_complete"].includes(po.status) || this.arrivalClosed(po.extensionData)) throw new UnprocessableEntityException({ code: "INVALID_PURCHASE_STATE", message: "当前采购单不可登记到货", details: [] });
      const item = po.items.find((candidate) => candidate.id === itemId);
      if (!item || item.material.materialType !== "raw_material") throw new UnprocessableEntityException({ code: "INVALID_RECEIPT", message: "到货明细或物料类型不合法", details: [] });
      const existing = input.idempotency_key ? item.receipts.find((row) => (row.extensionData as { idempotency_key?: string } | null)?.idempotency_key === input.idempotency_key) : undefined;
      if (existing) return { created: existing, po, batchSequence: this.batchSequence(existing.extensionData, item.receipts.indexOf(existing) + 1), payableAmount: new Prisma.Decimal(((existing.extensionData as { payable_amount?: string } | null)?.payable_amount) ?? existing.quantity.mul(item.unitPrice).toFixed(4)) };
      const currentReceived = item.receipts.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0));
      if (currentReceived.plus(quantity).gt(item.quantity) && !input.over_receipt_reason?.trim()) throw new UnprocessableEntityException({ code: "PURCHASE_OVER_RECEIPT_REASON_REQUIRED", message: "到货数量超过采购数量，必须填写超收原因", details: [{ ordered_quantity: item.quantity.toString(), received_quantity: currentReceived.toString(), requested_quantity: quantity.toString() }] });
      const batchSequence = this.nextBatchSequence(item.receipts);
      const payableAmount = quantity.mul(item.unitPrice).toFixed(4);
      const extensionData = { idempotency_key: input.idempotency_key ?? null, batch_sequence: batchSequence, payable_status: "pending_finance", payable_amount: payableAmount, over_receipt_reason: input.over_receipt_reason ?? null };
      const created = await tx.purchaseReceipt.create({ data: { purchaseOrderId: po.id, purchaseOrderItemId: item.id, orderNo: po.orderNo, receiptNo: `GR-${randomUUID().slice(0, 12).toUpperCase()}`, referenceNo: input.reference_no, receivedDate: new Date(input.received_date), quantity, extensionData, remark: input.remark, ...this.audit.create(user) } });
      await tx.incomingInspection.create({ data: { purchaseReceiptId: created.id, orderNo: po.orderNo, inspectedQuantity: 0, acceptedQuantity: 0, conditionalQuantity: 0, rejectedQuantity: 0, status: "pending", extensionData: { batch_sequence: batchSequence }, ...this.audit.create(user) } });
      // 到货只记录收货；原料入库过账时才创建唯一应付来源。
      const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: po.id, deletedAt: null }, include: { receipts: { where: { deletedAt: null } } } });
      const complete = items.length > 0 && items.every((candidate) => candidate.receipts.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0)).gte(candidate.quantity));
      await tx.purchaseOrder.update({ where: { id }, data: { status: complete ? "arrived_complete" : "partially_arrived", ...this.audit.update(user) } });
      return { created, po, batchSequence, payableAmount };
    });
    await this.audit.record("purchase_receipt.create", "purchase_receipt", user.id, result.created.id, { order_no: result.po.orderNo, purchase_order_id: id, batch_sequence: result.batchSequence });
    return { ...result.created, batchSequence: result.batchSequence, payableStatus: "pending_finance", payableAmount: result.payableAmount };
  }
  async revertArrivals(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "PURCHASE_ARRIVAL_REVERSAL_REASON_REQUIRED", message: "到货状态回退必须填写原因", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${id}::uuid FOR UPDATE`;
      const po = await tx.purchaseOrder.findFirst({ where: { id, deletedAt: null }, include: { items: { where: { deletedAt: null }, include: { receipts: { where: { deletedAt: null }, include: { inspections: { where: { deletedAt: null } }, rawMaterialInbounds: { where: { deletedAt: null } }, payableSources: { where: { status: { not: "voided" } } } } } } } } });
      if (!po) throw new NotFoundException({ code: "PURCHASE_ORDER_NOT_FOUND", message: "采购单不存在", details: [] });
      if (!["partially_arrived", "arrived_complete"].includes(po.status)) throw new UnprocessableEntityException({ code: "PURCHASE_ARRIVAL_NOT_REVERTIBLE", message: "当前采购单不是到货状态，不能回退", details: [{ status: po.status }] });
      const downstream = po.items.flatMap((item) => item.receipts).some((receipt) => receipt.inspections.some((inspection) => new Prisma.Decimal(inspection.inspectedQuantity).gt(0)) || receipt.rawMaterialInbounds.length > 0 || receipt.payableSources.some((source) => source.status === "posted"));
      if (downstream) throw new UnprocessableEntityException({ code: "PURCHASE_ARRIVAL_DOWNSTREAM_EXISTS", message: "到货已有质检、入库或财务过账事实，不能回退", details: [] });
      const extensionData = (po.extensionData ?? {}) as Record<string, unknown>;
      const hasReceipt = po.items.some((item) => item.receipts.length > 0);
      const updated = await tx.purchaseOrder.update({ where: { id }, data: { status: hasReceipt ? "partially_arrived" : "ordered", extensionData: { ...extensionData, arrival_closed: false, arrival_reverted_reason: reason.trim() }, ...this.audit.update(user) } });
      return updated;
    });
    await this.audit.record("purchase_order.arrival_revert", "purchase_order", user.id, id, { order_no: result.orderNo, reason: reason.trim() });
    return result;
  }

  async impactPreview(id: string) { const po = await this.get(id); const planned = po.items.reduce((sum, item) => sum.plus(item.quantity), new Prisma.Decimal(0)); const received = po.items.reduce((sum, item) => sum.plus(item.receipts.reduce((subtotal, row) => subtotal.plus(row.quantity), new Prisma.Decimal(0))), new Prisma.Decimal(0)); return { order_no: po.orderNo, bom_version: po.bomVersion, status: po.status, purchase_order_no: po.purchaseOrderNo, planned_quantity: planned.toFixed(4), received_quantity: received.toFixed(4), over_order: received.gte(planned), items: po.items.map((item) => ({ id: item.id, quantity: item.quantity, received_quantity: item.receipts.reduce((sum, row) => sum.plus(row.quantity), new Prisma.Decimal(0)).toFixed(4) })), warning: po.items.some((item) => item.receipts.length) ? "已存在到货事实，变更需要后续回退流程" : null }; }
  private async refs(input: Input): Promise<Refs> {
    const items = input.items ?? [];
    if (items.some((item) => !this.isPositive(item.quantity) || !this.isNonNegative(item.unit_price) || (item.extra_fee !== undefined && !this.isNonNegative(item.extra_fee)))) throw new UnprocessableEntityException({ code: "INVALID_PURCHASE_ITEM", message: "采购明细数量/单价/费用必须有效", details: [] });
    const order = await this.prisma.salesOrder.findFirst({ where: { orderNo: input.order_no, status: "confirmed", deletedAt: null } });
    if (!order) throw new NotFoundException({ code: "SALES_ORDER_NOT_CONFIRMED", message: "销售单不存在或未确认", details: [] });
    // 明细行的供应商允许为空（草稿还没定供应商，见 schema 注释），但**一张单上不能有两个不同供应商**：
    // 头部供应商/币种/金额会失去单一含义，而到货、应付、对账都挂在采购单上。
    // 用户 2026-09-17：「一个采购单内，一个供应商下一个单」——按供应商收束（/split）天然满足这条。
    const supplierIds = [...new Set([input.supplier_id, ...items.map((item) => item.supplier_id)].filter((id): id is string => Boolean(id)))];
    if (supplierIds.length > 1) throw new UnprocessableEntityException({ code: "PURCHASE_ORDER_MULTIPLE_SUPPLIERS", message: "一张采购单只能有一个供应商，请按供应商收束后再保存", details: [] });
    const [bom, suppliers, materials, units] = await Promise.all([
      input.bom_id ? this.prisma.bom.findFirst({ where: { id: input.bom_id, salesOrderId: order.id, orderNo: input.order_no, deletedAt: null } }) : Promise.resolve(null),
      // ⚠️ 供应商**不写 select**：这一行整行都会被写进 `supplier_snapshot`（地址/联系人要冻在单上），
      // 加了 `select: { id, name }` 不会报错，只会让快照悄悄少掉那几格。见 `Refs` 的注释。
      supplierIds.length ? this.prisma.supplier.findMany({ where: { id: { in: supplierIds }, isActive: true, deletedAt: null } }) : Promise.resolve([]),
      items.length ? this.prisma.material.findMany({ where: { id: { in: items.map((item) => item.material_id) }, materialType: "raw_material", isActive: true, deletedAt: null } }) : Promise.resolve([]),
      items.length ? this.prisma.unit.findMany({ where: { id: { in: items.map((item) => item.unit_id) }, isActive: true, deletedAt: null } }) : Promise.resolve([]),
    ]);
    if (input.bom_id && !bom) throw new NotFoundException({ code: "BOM_NOT_FOUND", message: "BOM 不存在或不属于该销售单", details: [] });
    const supplierMap = new Map(suppliers.map((row) => [row.id, row]));
    if (supplierIds.some((id) => !supplierMap.has(id))) throw new NotFoundException({ code: "SUPPLIER_NOT_FOUND", message: "供应商不存在或已停用", details: [] });
    const headSupplierId = input.supplier_id ?? items[0]?.supplier_id;
    const supplier = headSupplierId ? supplierMap.get(headSupplierId) : undefined;
    const bomItemIds = items.flatMap((item) => item.bom_item_id ? [item.bom_item_id] : []);
    const bomItems = bom && bomItemIds.length && this.prisma.bomItem?.findMany
      ? await this.prisma.bomItem.findMany({ where: { id: { in: bomItemIds }, bomId: bom.id, deletedAt: null }, select: { id: true, materialId: true } })
      : [];
    const bomItemMap = new Map(bomItems.map((row) => [row.id, row]));
    const outsideBom = items.filter((item) => !item.bom_item_id);
    if (bom && outsideBom.some((item) => typeof item.extension_data?.outside_bom_reason !== "string" || !(item.extension_data.outside_bom_reason as string).trim())) throw new UnprocessableEntityException({ code: "PURCHASE_OUTSIDE_BOM_REASON_REQUIRED", message: "采购单明细不在 BOM 表中，必须填写新增原因", details: [] });
    if (items.some((item) => item.bom_item_id && (!bomItemMap.has(item.bom_item_id) || bomItemMap.get(item.bom_item_id)?.materialId !== item.material_id))) throw new UnprocessableEntityException({ code: "PURCHASE_BOM_ITEM_MISMATCH", message: "采购明细必须引用当前 BOM 表中的对应物料", details: [] });
    const materialMap = new Map(materials.map((row) => [row.id, row]));
    const unitMap = new Map(units.map((row) => [row.id, row]));
    if (items.some((item) => !materialMap.has(item.material_id) || !unitMap.has(item.unit_id))) throw new NotFoundException({ code: "PURCHASE_REFERENCE_NOT_FOUND", message: "物料或单位不存在或已停用", details: [] });
    return { order, bom, supplier, supplierMap, materials: materialMap, units: unitMap, items };
  }
  private itemExpectedDate(item: Item) { return item.expected_date ? this.parseDate(item.expected_date) : undefined; }
  private orderExpectedDate(input: Input) {
    if (input.expected_date) { const parsed = this.parseDate(input.expected_date); if (parsed) return parsed; }
    const dates = (input.items ?? []).map((item) => this.itemExpectedDate(item)).filter((date): date is Date => Boolean(date));
    return dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))) : undefined;
  }
  private parseDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? undefined : date; }
  private amount(item: Item) { return new Prisma.Decimal(item.quantity).mul(item.unit_price).plus(item.extra_fee ?? 0); }
  private positive(value: string, message: string) { try { const result = new Prisma.Decimal(value); if (!result.gt(0)) throw new Error(); return result; } catch { throw new UnprocessableEntityException({ code: "INVALID_RECEIPT", message, details: [] }); } }
  private isPositive(value: string) { try { return new Prisma.Decimal(value).gt(0); } catch { return false; } }
  private isNonNegative(value: string) { try { return new Prisma.Decimal(value).gte(0); } catch { return false; } }
  private batchSequence(extensionData: unknown, fallback: number) {
    if (extensionData && typeof extensionData === "object") {
      const value = Number((extensionData as { batch_sequence?: unknown }).batch_sequence);
      if (Number.isInteger(value) && value > 0) return value;
    }
    return fallback;
  }
  private nextBatchSequence(receipts: Array<{ extensionData: unknown }>) {
    return receipts.reduce((max, receipt, index) => Math.max(max, this.batchSequence(receipt.extensionData, index + 1)), 0) + 1;
  }
  private arrivalClosed(extensionData: unknown) { return Boolean(extensionData && typeof extensionData === "object" && (extensionData as { arrival_closed?: unknown }).arrival_closed === true); }
}

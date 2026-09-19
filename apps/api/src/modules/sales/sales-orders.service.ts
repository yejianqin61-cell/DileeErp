import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { CurrencyService } from "../../platform/currency/currency.service";
import { PrismaService } from "../../platform/database/prisma.service";

/**
 * 下单口径细化的固定字段映射：请求键（snake_case）→ Prisma 列（camelCase）。
 *
 * 用**一张表驱动**（创建 / 更新 / 版本快照三处都从它推），而不是把 37 个字段各抄三遍——
 * 抄三遍必然漏一处，而漏掉的那一处只会在导出的 Excel 上变成一个空格子，很难被发现。
 * 前端 `apps/web/components/sales/sales-order-spec.ts` 有同一份清单（两个 workspace 之间没有
 * 共享包），两边用同一组测试向量钉住字段名与顺序。
 *
 * 字段顺序 = 模板上「材料明细」与「工艺要求」的印刷顺序，导出直接按它落格。
 */
export const SPEC_SCALAR_FIELDS = [
  // 表头补充
  ["factory", "factory"],
  ["completion_remark", "completionRemark"],
  ["attention_note", "attentionNote"],
  ["shipping_mark_front", "shippingMarkFront"],
  ["shipping_mark_side", "shippingMarkSide"],
  // 布量（伞面 / 伞带 / 木耳 / 天布 / 布套，单位 Y/DZ）
  ["fabric_usage_canopy", "fabricUsageCanopy"],
  ["fabric_usage_strap", "fabricUsageStrap"],
  ["fabric_usage_wood_ear", "fabricUsageWoodEar"],
  ["fabric_usage_top", "fabricUsageTop"],
  ["fabric_usage_bag", "fabricUsageBag"],
  // 材料明细（两样本并集）
  ["rib_spec", "ribSpec"],
  ["canopy_spec", "canopySpec"],
  ["handle_spec", "handleSpec"],
  ["handle_strap_spec", "handleStrapSpec"],
  ["tail_spec", "tailSpec"],
  ["runner_spec", "runnerSpec"],
  ["strap_spec", "strapSpec"],
  ["strap_fastener_spec", "strapFastenerSpec"],
  ["inner_label_spec", "innerLabelSpec"],
  ["woven_label_spec", "wovenLabelSpec"],
  ["hang_tag_spec", "hangTagSpec"],
  ["opp_spec", "oppSpec"],
  ["bag_spec", "bagSpec"],
  ["packaging_spec", "packagingSpec"],
  ["top_fabric_spec", "topFabricSpec"],
  ["wood_ear_spec", "woodEarSpec"],
  ["keychain_spec", "keychainSpec"],
  ["printing_spec", "printingSpec"],
  // 工艺要求（两样本并集）
  ["sample_requirement", "sampleRequirement"],
  ["cutting_requirement", "cuttingRequirement"],
  ["edge_requirement", "edgeRequirement"],
  ["joining_requirement", "joiningRequirement"],
  ["top_stitch_requirement", "topStitchRequirement"],
  ["sewing_requirement", "sewingRequirement"],
  ["strap_requirement", "strapRequirement"],
  ["hang_tag_note", "hangTagNote"],
  ["qc_requirement", "qcRequirement"],
] as const;

export type SpecScalarKey = (typeof SPEC_SCALAR_FIELDS)[number][0];
/** 细化标量字段（全部可选：历史销售单没有这些字）。 */
export type SpecScalarFields = Partial<Record<SpecScalarKey, string>>;
/** 细分明细行（一张通用表 + 分组名）。 */
export type SpecDetailInput = { group_name: string; name: string; color?: string; barcode?: string; quantity?: string; unit?: string; sort_order?: number };

/**
 * 单位归一：把「同一个单位的几种写法」认成一种。
 *
 * 为什么必须有这一步：模板样本1 的表头是 `1960支`、伞布明细里写的是 `100pcs` —— 是同一个单位；
 * 不做归一，「明细数量合计 = 单头数量」这条真规则会被误判成「跨单位无法核对」，功能等于废掉。
 * 样本2 的表头与明细都是 `打`，本来就一致。
 *
 * 只归一并集明确的同义写法，**不做单位换算**（打 → 支 这种换算需要每款伞的装箱数，系统里没有，
 * 猜一个数去比只会给出一个看起来合理但错的提示）。
 */
const PIECE_UNITS = new Set(["pcs", "pc", "piece", "pieces", "支", "只", "个", "把"]);
const DOZEN_UNITS = new Set(["dz", "doz", "dozen", "打"]);

export function normalizeSpecUnit(unit: string | null | undefined): string | null {
  if (!unit) return null;
  const key = unit.trim().toLowerCase().replace(/[.。]$/, "");
  if (!key) return null;
  if (PIECE_UNITS.has(key)) return "piece";
  if (DOZEN_UNITS.has(key)) return "dozen";
  return key;
}

type SalesOrderBaseInput = { order_no: string; customer_id: string; contact_id?: string; customer_po_no?: string; external_contract_no?: string; order_date: string; product_name: string; product_spec?: string; quantity: string; unit: string; delivery_date?: string; currency: string; unit_price?: string; total_amount?: string; tax_rate?: string; settlement_unit_price?: string; receivable_amount?: string; settlement_method?: string; local_currency_amount?: string; extension_data?: Record<string, unknown> };
type SalesOrderInput = SalesOrderBaseInput & SpecScalarFields & { spec_details?: SpecDetailInput[] };
type SalesOrderUpdate = Partial<Omit<SalesOrderInput, "order_no" | "customer_id">> & { reason?: string };

@Injectable()
export class SalesOrdersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Optional() private readonly currencies?: CurrencyService) {}

  async list(page = 1, pageSize = 20, search?: string, status?: string) {
    const where = { deletedAt: null, ...(status ? { status } : {}), ...(search ? { OR: [{ orderNo: { contains: search, mode: "insensitive" as const } }, { productName: { contains: search, mode: "insensitive" as const } }] } : {}) };
    const [data, total] = await this.prisma.$transaction([this.prisma.salesOrder.findMany({ where, orderBy: { updatedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize, include: { customer: true, contact: true, boms: { where: { deletedAt: null }, select: { id: true, version: true, status: true } } } }), this.prisma.salesOrder.count({ where })]);
    return { data, total };
  }

  async get(id: string) {
    const order = await this.prisma.salesOrder.findFirst({ where: { id, deletedAt: null }, include: { customer: true, contact: true, versions: { orderBy: { version: "desc" } }, boms: { where: { deletedAt: null }, orderBy: { version: "desc" } }, specDetails: { where: { deletedAt: null }, orderBy: { sortOrder: "asc" } } } });
    if (!order) throw new NotFoundException({ code: "SALES_ORDER_NOT_FOUND", message: "销售单不存在", details: [] });
    return { ...order, spec_quantity_notice: this.specQuantityNotice(order) };
  }

  /**
   * 明细数量合计 vs 单头数量。
   *
   * 模板两张样本都成立（样本1：12 款花色合计 1960 = 表头 1960支；样本2：15 款伞头 × 167打 = 2505打），
   * 所以它是一条**真规则**，值得在下单时提示。但**不做硬校验**：数量单位在明细里可能是支/pcs、
   * 表头可能是打，跨单位相加没有意义（与全站「不跨单位合计」一致）。单位对不上时返回「无法核对」。
   */
  private specQuantityNotice(order: { quantity: Prisma.Decimal; unit: string; specDetails: { quantity: Prisma.Decimal | null; unit: string | null }[] }): string | null {
    const lines = order.specDetails.filter((line) => line.quantity !== null);
    if (!lines.length) return null;
    // 明细没写单位时按表头单位算（模板里明细的单位列常常留空，与表头同单位）。
    const headUnit = normalizeSpecUnit(order.unit);
    const comparable = lines.every((line) => { const unit = normalizeSpecUnit(line.unit); return unit === null || unit === headUnit; });
    if (!comparable) return `明细数量与单头数量无法核对：明细单位与单头单位（${order.unit}）不一致，跨单位不做合计。`;
    const total = lines.reduce((sum, line) => sum.plus(line.quantity ?? 0), new Prisma.Decimal(0));
    if (total.eq(order.quantity)) return null;
    return `明细数量合计 ${total.toString()} 与单头数量 ${order.quantity.toString()} ${order.unit} 不一致，请核对。`;
  }

  async create(input: SalesOrderInput, user: CurrentUser) {
    await this.currencies?.assertSupported(input.currency, "销售单币种");
    const refs = await this.resolveReferences(input, user);
    // 快照要能回答「v1 时下给工厂的是什么」：所以细化标量**每个键都进快照**（没填的记 null），
    // 而不是只记这次请求里出现的键。
    const snapshot = this.snapshot({ ...input, ...this.specSnapshotSource({}, input) }, refs.customer, refs.contact);
    try {
      const order = await this.prisma.$transaction(async (tx) => {
        const created = await tx.salesOrder.create({ data: { orderNo: input.order_no, customerId: input.customer_id, contactId: input.contact_id, customerSnapshot: refs.customer as Prisma.InputJsonValue, contactSnapshot: refs.contact as Prisma.InputJsonValue, customerPoNo: input.customer_po_no, externalContractNo: input.external_contract_no, orderDate: new Date(input.order_date), productName: input.product_name, productSpec: input.product_spec, quantity: input.quantity, unit: input.unit, deliveryDate: input.delivery_date ? new Date(input.delivery_date) : undefined, currency: input.currency, unitPrice: input.unit_price, totalAmount: input.total_amount, taxRate: input.tax_rate, settlementUnitPrice: input.settlement_unit_price, receivableAmount: input.receivable_amount, settlementMethod: input.settlement_method, localCurrencyAmount: input.local_currency_amount, extensionData: (input.extension_data ?? {}) as Prisma.InputJsonValue, ...this.specScalars(input), ...this.audit.create(user) } });
        await tx.salesOrderVersion.create({ data: { salesOrderId: created.id, version: 1, snapshot, ...this.audit.create(user) } });
        await this.replaceSpecDetails(tx, created.id, input.spec_details, user);
        return created;
      });
      await this.audit.record("sales_order.create", "sales_order", user.id, order.id, { order_no: order.orderNo });
      return this.get(order.id);
    } catch (error) { this.handleUnique(error); throw error; }
  }

  async update(id: string, input: SalesOrderUpdate, user: CurrentUser) {
    await this.currencies?.assertSupported(input.currency, "销售单币种");
    const current = await this.get(id);
    if (current.status === "closed") throw new UnprocessableEntityException({ code: "SALES_ORDER_CLOSED", message: "已关闭销售单不可编辑", details: [] });
    if (current.status === "confirmed" && !input.reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "已确认销售单修改必须填写原因", details: [] });
    // 结算金额类字段同样属于「动了就要重算下游」的核心字段；结算方式只是说明信息，允许后补。
    const coreFields = ["product_name", "product_spec", "quantity", "unit", "currency", "unit_price", "total_amount", "tax_rate", "settlement_unit_price", "receivable_amount", "local_currency_amount"] as const;
    if (current.status === "confirmed" && coreFields.some((field) => input[field] !== undefined)) {
      const [purchaseCount, productionCount] = await Promise.all([
        this.prisma.purchaseOrder.count({ where: { salesOrderId: id, deletedAt: null } }),
        this.prisma.productionOrder.count({ where: { salesOrderId: id, deletedAt: null } }),
      ]);
      if (current.boms.length || purchaseCount || productionCount) throw new UnprocessableEntityException({ code: "SALES_ORDER_CORE_FIELDS_LOCKED", message: "销售单已有 BOM、采购或生产下游事实，核心字段需先回退下游", details: [{ bom_count: current.boms.length, purchase_order_count: purchaseCount, production_order_count: productionCount }] });
    }
    const refs = await this.resolveReferences({ customer_id: current.customerId, contact_id: input.contact_id ?? current.contactId ?? undefined }, user);
    const nextInput = { ...input, customer_id: current.customerId, contact_id: input.contact_id ?? current.contactId ?? undefined, order_no: current.orderNo, order_date: input.order_date ?? current.orderDate.toISOString(), product_name: input.product_name ?? current.productName, quantity: input.quantity ?? current.quantity.toString(), unit: input.unit ?? current.unit, currency: input.currency ?? current.currency, extension_data: input.extension_data ?? (current.extensionData as Record<string, unknown>), ...this.specSnapshotSource(current as unknown as Record<string, unknown>, input) };
    const nextVersion = current.currentVersion + 1;
    const snapshot = this.snapshot(nextInput, refs.customer, refs.contact);
    const updated = await this.prisma.$transaction(async (tx) => {
      const data: Prisma.SalesOrderUncheckedUpdateInput = { ...(input.contact_id === undefined ? {} : { contactId: input.contact_id }), ...(input.customer_po_no === undefined ? {} : { customerPoNo: input.customer_po_no }), ...(input.external_contract_no === undefined ? {} : { externalContractNo: input.external_contract_no }), ...(input.order_date === undefined ? {} : { orderDate: new Date(input.order_date) }), ...(input.product_name === undefined ? {} : { productName: input.product_name }), ...(input.product_spec === undefined ? {} : { productSpec: input.product_spec }), ...(input.quantity === undefined ? {} : { quantity: input.quantity }), ...(input.unit === undefined ? {} : { unit: input.unit }), ...(input.delivery_date === undefined ? {} : { deliveryDate: input.delivery_date ? new Date(input.delivery_date) : null }), ...(input.currency === undefined ? {} : { currency: input.currency }), ...(input.unit_price === undefined ? {} : { unitPrice: input.unit_price }), ...(input.total_amount === undefined ? {} : { totalAmount: input.total_amount }), ...(input.tax_rate === undefined ? {} : { taxRate: input.tax_rate }), ...(input.settlement_unit_price === undefined ? {} : { settlementUnitPrice: input.settlement_unit_price }), ...(input.receivable_amount === undefined ? {} : { receivableAmount: input.receivable_amount }), ...(input.settlement_method === undefined ? {} : { settlementMethod: input.settlement_method }), ...(input.local_currency_amount === undefined ? {} : { localCurrencyAmount: input.local_currency_amount }), ...(input.extension_data === undefined ? {} : { extensionData: input.extension_data as Prisma.InputJsonValue }), ...this.specScalars(input), customerSnapshot: refs.customer as Prisma.InputJsonValue, contactSnapshot: refs.contact as Prisma.InputJsonValue, currentVersion: nextVersion, ...this.audit.update(user) };
      const result = await tx.salesOrder.update({ where: { id }, data });
      await tx.salesOrderVersion.create({ data: { salesOrderId: id, version: nextVersion, snapshot, ...this.audit.create(user) } });
      await this.replaceSpecDetails(tx, id, input.spec_details, user);
      return result;
    });
    await this.audit.record("sales_order.update", "sales_order", user.id, id, { order_no: current.orderNo, version: nextVersion, reason: input.reason, fields: Object.keys(input).filter((field) => field !== "reason") });
    return { ...(await this.get(updated.id)), impact_warning: current.status === "confirmed" && current.boms.length > 0 ? "销售单已有关联 BOM，请物控复核来源版本" : null };
  }

  async impactPreview(id: string) {
    const order = await this.get(id);
    return { sales_order_id: order.id, order_no: order.orderNo, current_version: order.currentVersion, status: order.status, bom_count: order.boms.length, warning: order.boms.length > 0 ? "已存在 BOM，销售单变更不会自动改写下游事实" : null };
  }

  async confirm(id: string, user: CurrentUser) {
    const order = await this.get(id);
    if (order.status !== "draft") throw new UnprocessableEntityException({ code: "INVALID_STATE_TRANSITION", message: "只有草稿销售单可以确认", details: [{ from: order.status, to: "confirmed" }] });
    const updated = await this.prisma.salesOrder.update({ where: { id }, data: { status: "confirmed", ...this.audit.update(user) } });
    await this.audit.record("sales_order.confirm", "sales_order", user.id, id, { order_no: order.orderNo, from: "draft", to: "confirmed" });
    return updated;
  }

  async revertToDraft(id: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CORRECTION_REASON_REQUIRED", message: "销售单回退草稿必须填写原因", details: [] });
    const current = await this.get(id);
    if (current.status !== "confirmed") throw new UnprocessableEntityException({ code: "SALES_ORDER_NOT_REVERTIBLE", message: "仅已确认销售单可以回退草稿", details: [] });
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.salesOrder.findFirst({ where: { id, deletedAt: null }, select: { status: true } });
      if (!locked || locked.status !== "confirmed") throw new UnprocessableEntityException({ code: "SALES_ORDER_NOT_REVERTIBLE", message: "销售单状态已变化，请刷新后重试", details: [] });
      const [bomCount, purchaseCount, productionCount] = await Promise.all([
        tx.bom.count({ where: { salesOrderId: id, deletedAt: null } }),
        tx.purchaseOrder.count({ where: { salesOrderId: id, deletedAt: null } }),
        tx.productionOrder.count({ where: { salesOrderId: id, deletedAt: null } }),
      ]);
      if (bomCount || purchaseCount || productionCount) throw new UnprocessableEntityException({ code: "SALES_ORDER_DOWNSTREAM_EXISTS", message: "销售单已有 BOM、采购或生产下游事实，不能直接回退", details: [{ bom_count: bomCount, purchase_order_count: purchaseCount, production_order_count: productionCount }] });
      return tx.salesOrder.update({ where: { id }, data: { status: "draft", ...this.audit.update(user) } });
    });
    await this.audit.record("sales_order.revert_to_draft", "sales_order", user.id, id, { order_no: current.orderNo, reason: reason.trim(), from: "confirmed", to: "draft" });
    return updated;
  }

  async close(id: string, user: CurrentUser) {
    const order = await this.get(id);
    if (order.status !== "confirmed") throw new UnprocessableEntityException({ code: "INVALID_STATE_TRANSITION", message: "只有已确认销售单可以关闭", details: [{ from: order.status, to: "closed" }] });
    const updated = await this.prisma.salesOrder.update({ where: { id }, data: { status: "closed", ...this.audit.update(user) } });
    await this.audit.record("sales_order.close", "sales_order", user.id, id, { order_no: order.orderNo, from: "confirmed", to: "closed" });
    return updated;
  }

  /**
   * 版本快照里的细化字段：**当前值打底、请求值覆盖**，所以每个版本都能看到当时的完整工艺口径
   * （只记「这次改了哪几个」的快照，回看时会以为别的字段是空的）。
   * 明细只在这次请求带了 `spec_details` 时才进快照（明细是整体替换语义）。
   */
  private specSnapshotSource(current: Record<string, unknown>, input: Record<string, unknown>): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const [key, column] of SPEC_SCALAR_FIELDS) {
      const fromInput = input[key];
      merged[key] = fromInput !== undefined ? fromInput : current[column] ?? null;
    }
    if (input.spec_details !== undefined) merged.spec_details = input.spec_details;
    return merged;
  }

  /**
   * 细化标量：只取请求里**传了的**键（没传的列不动，传 null 才是清空），与既有 `update` 的
   * 「undefined = 不动」语义一致。
   */
  private specScalars(input: Record<string, unknown>): Record<string, string | null> {
    const data: Record<string, string | null> = {};
    for (const [key, column] of SPEC_SCALAR_FIELDS) {
      const value = input[key];
      if (value === undefined) continue;
      // 空串 = 「清除这一格」（表单里把一格删空就该清掉，而不是当成没填）；没传的键才是不动。
      data[column] = value === "" ? null : (value as string | null);
    }
    return data;
  }

  /**
   * 细分明细的替换语义：与采购单明细一致——老的软删 + 新的批量建，同一个事务。
   * `details === undefined` 表示这次请求没提到明细（整块不动）；传空数组才是「清空全部」。
   */
  private async replaceSpecDetails(tx: Prisma.TransactionClient, salesOrderId: string, details: SpecDetailInput[] | undefined, user: CurrentUser) {
    if (details === undefined) return;
    await tx.salesOrderSpecDetail.updateMany({ where: { salesOrderId, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: user.id, updatedBy: user.id } });
    if (!details.length) return;
    await tx.salesOrderSpecDetail.createMany({ data: details.map((detail, index) => ({ salesOrderId, groupName: detail.group_name, name: detail.name, color: detail.color, barcode: detail.barcode, quantity: detail.quantity, unit: detail.unit, sortOrder: detail.sort_order ?? index, ...this.audit.create(user) })) });
  }

  private async resolveReferences(input: { customer_id: string; contact_id?: string }, _user: CurrentUser) {
    const customer = await this.prisma.customer.findFirst({ where: { id: input.customer_id, deletedAt: null, isActive: true } });
    if (!customer) throw new NotFoundException({ code: "CUSTOMER_NOT_FOUND", message: "客户不存在或已停用", details: [] });
    let contact: object | null = null;
    if (input.contact_id) {
      contact = await this.prisma.customerContact.findFirst({ where: { id: input.contact_id, customerId: input.customer_id, deletedAt: null, isActive: true } });
      if (!contact) throw new NotFoundException({ code: "CUSTOMER_CONTACT_NOT_FOUND", message: "客户联系人不存在或不属于该客户", details: [] });
    }
    return { customer: this.compact(customer), contact: contact ? this.compact(contact) : null };
  }

  private snapshot(input: Record<string, unknown>, customer: object, contact: object | null) { return this.compact({ order_no: input.order_no, customer, contact, customer_po_no: input.customer_po_no, external_contract_no: input.external_contract_no, order_date: input.order_date, product_name: input.product_name, product_spec: input.product_spec, quantity: input.quantity, unit: input.unit, delivery_date: input.delivery_date, currency: input.currency, unit_price: input.unit_price, total_amount: input.total_amount, tax_rate: input.tax_rate, settlement_unit_price: input.settlement_unit_price, receivable_amount: input.receivable_amount, settlement_method: input.settlement_method, local_currency_amount: input.local_currency_amount, extension_data: input.extension_data ?? {}, ...this.specSnapshotFields(input) }); }

  /**
   * 快照里的细化字段：**每个键都写**（没填记 null），而不是只写这次请求里出现的键——
   * 否则回看某个版本时会以为当时别的工艺栏位是空的。`snapshot()` 只拷固定键清单，
   * 所以这里必须显式把它并进去（这一条是被单测抓出来的：第一版漏了，快照里根本没有细化字段）。
   */
  private specSnapshotFields(input: Record<string, unknown>): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const [key] of SPEC_SCALAR_FIELDS) fields[key] = input[key] ?? null;
    if (input.spec_details !== undefined) fields.spec_details = input.spec_details;
    return fields;
  }
  private compact(value: object) { return JSON.parse(JSON.stringify(value, (_key, item) => item === undefined ? undefined : item)); }
  private handleUnique(error: unknown) { if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "ORDER_NO_CONFLICT", message: "订单号已存在", details: [] }); }
}

import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { ProductionProgressService } from "./production-progress.service";

type Input = { order_no: string; bom_id: string; bom_version: number; production_order_type?: string; parent_production_order_id?: string; execution_mode: string; execution_location_id: string; planned_quantity: string; unit_id: string; product_specification?: string; production_process_note?: string; planned_started_on?: string; delivery_due_on?: string; remark?: string };
type OperationPatch = { sequence_no?: number; target_quantity?: string; unit_id?: string };
const TYPES = new Set(["standard", "supplement", "rework", "split"]);
const ALLOWED_TRANSITIONS: Record<string, string[]> = { draft: ["in_progress"], in_progress: ["paused", "completed"], paused: ["in_progress"], completed: ["closed", "in_progress"] };
type OperationRow = { id: string; status: string; operationNameSnapshot: string; targetQuantity: Prisma.Decimal };
type CompletionOrder = { id: string; executionMode: string; plannedQuantity: Prisma.Decimal; operations: OperationRow[] };
@Injectable()
export class ProductionOrdersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly progress?: ProductionProgressService) {}
  async list(orderNo?: string) { return this.prisma.productionOrder.findMany({ where: { deletedAt: null, ...(orderNo ? { orderNo } : {}) }, include: { executionLocation: true, unit: true, bom: true, operations: { where: { deletedAt: null }, orderBy: { sequenceNo: "asc" } } }, orderBy: { updatedAt: "desc" } }); }
  async get(id: string) { const item = await this.prisma.productionOrder.findFirst({ where: { id, deletedAt: null }, include: { executionLocation: true, unit: true, bom: true, parent: true, children: true, operations: { where: { deletedAt: null }, include: { operationCatalog: true, unit: true }, orderBy: { sequenceNo: "asc" } } } }); if (!item) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] }); return item; }
  async create(input: Input, user: CurrentUser) {
    const refs = await this.refs(input);
    const type = input.production_order_type ?? "standard";
    if (!TYPES.has(type)) throw new UnprocessableEntityException({ code: "INVALID_PRODUCTION_ORDER_TYPE", message: "生产单类型无效", details: [] });
    this.parseDecimal(input.planned_quantity, "INVALID_PLANNED_QUANTITY", "计划数量必须大于零", "计划数量");
    if (type !== "standard") { if (!input.parent_production_order_id) throw new UnprocessableEntityException({ code: "PARENT_PRODUCTION_ORDER_REQUIRED", message: "补单、返工单和拆分单必须关联父生产单", details: [] }); const parent = await this.get(input.parent_production_order_id); if (parent.orderNo !== refs.order.orderNo) throw new UnprocessableEntityException({ code: "PARENT_ORDER_MISMATCH", message: "父生产单必须属于同一订单", details: [] }); }
    const number = `MO-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sales_orders WHERE id = ${refs.order.id}::uuid FOR UPDATE`;
      const locked = await tx.salesOrder.findFirst({ where: { id: refs.order.id, status: "confirmed", deletedAt: null }, select: { id: true } });
      if (!locked) throw new NotFoundException({ code: "SALES_ORDER_NOT_CONFIRMED", message: "销售单不存在或未确认", details: [] });
      const existing = type === "standard" && !input.parent_production_order_id ? await tx.productionOrder.findFirst({ where: { salesOrderId: locked.id, productionOrderType: "standard", parentProductionOrderId: null, deletedAt: null }, select: { id: true, productionOrderNo: true, status: true } }) : null;
      if (existing) throw new ConflictException({ code: "PRODUCTION_ORDER_ALREADY_EXISTS", message: "该销售订单已存在未删除的主生产单，一个销售订单只允许一张主生产单", details: [{ production_order_id: existing.id, production_order_no: existing.productionOrderNo, status: existing.status }] });
      try {
        return await tx.productionOrder.create({ data: { productionOrderNo: number, orderNo: refs.order.orderNo, salesOrderId: refs.order.id, bomId: refs.bom.id, bomVersion: refs.bom.version, bomSnapshot: this.snapshotBom(refs.bom) as Prisma.InputJsonValue, productionOrderType: type, parentProductionOrderId: input.parent_production_order_id, executionMode: input.execution_mode, executionLocationId: input.execution_location_id, plannedQuantity: input.planned_quantity, unitId: input.unit_id, productSpecification: input.product_specification, productionProcessNote: input.production_process_note, plannedStartedOn: input.planned_started_on ? new Date(input.planned_started_on) : undefined, deliveryDueOn: input.delivery_due_on ? new Date(input.delivery_due_on) : undefined, remark: input.remark, ...this.audit.create(user) } });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "P2002") throw new ConflictException({ code: "PRODUCTION_ORDER_ALREADY_EXISTS", message: "该销售订单已存在未删除的主生产单，一个销售订单只允许一张主生产单", details: [] });
        throw error;
      }
    });
    await this.audit.record("production_order.create", "production_order", user.id, created.id, { order_no: created.orderNo, production_order_no: number, bom_version: refs.bom.version, planned_quantity: input.planned_quantity }); return this.get(created.id);
  }
  async update(id: string, input: Partial<Input>, user: CurrentUser) {
    const current = await this.get(id);
    if (current.status !== "draft") throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_NOT_EDITABLE", message: "只有草稿生产单可编辑", details: [] });
    if (input.execution_mode || input.execution_location_id) await this.validateLocation(input.execution_mode ?? current.executionMode, input.execution_location_id ?? current.executionLocationId);
    if (input.planned_quantity !== undefined) this.parseDecimal(input.planned_quantity, "INVALID_PLANNED_QUANTITY", "计划数量必须大于零", "计划数量");
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.productionOrder.findFirst({ where: { id, deletedAt: null } });
      if (!locked) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
      if (locked.status !== "draft") throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_NOT_EDITABLE", message: "只有草稿生产单可编辑", details: [{ production_order_status: locked.status }] });
      return tx.productionOrder.update({ where: { id }, data: { ...(input.execution_mode === undefined ? {} : { executionMode: input.execution_mode }), ...(input.execution_location_id === undefined ? {} : { executionLocationId: input.execution_location_id }), ...(input.planned_quantity === undefined ? {} : { plannedQuantity: input.planned_quantity }), ...(input.product_specification === undefined ? {} : { productSpecification: input.product_specification }), ...(input.production_process_note === undefined ? {} : { productionProcessNote: input.production_process_note }), ...(input.planned_started_on === undefined ? {} : { plannedStartedOn: new Date(input.planned_started_on) }), ...(input.delivery_due_on === undefined ? {} : { deliveryDueOn: new Date(input.delivery_due_on) }), ...(input.remark === undefined ? {} : { remark: input.remark }), ...this.audit.update(user) } });
    });
    await this.audit.record("production_order.update", "production_order", user.id, id, { order_no: current.orderNo, before: { status: current.status, planned_quantity: current.plannedQuantity.toString() }, after: { status: result.status, planned_quantity: result.plannedQuantity.toString() }, changed: Object.keys(input).filter((key) => input[key as keyof Input] !== undefined) }); return result;
  }
  async delete(id: string, user: CurrentUser) {
    const item = await this.get(id);
    if (item.status !== "draft") throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_NOT_DELETABLE", message: "只有草稿生产单可删除", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.productionOrder.findFirst({ where: { id, deletedAt: null }, include: { children: true } });
      if (!locked) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
      if (locked.status !== "draft") throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_NOT_DELETABLE", message: "只有草稿生产单可删除", details: [{ production_order_status: locked.status }] });
      const children = locked.children.filter((child) => !child.deletedAt);
      if (children.length) throw new UnprocessableEntityException({ code: "PRODUCTION_ORDER_HAS_CHILDREN", message: "该生产单存在未删除的子生产单，请先处理子生产单后再删除", details: [{ count: children.length, children: children.map((child) => ({ id: child.id, production_order_no: child.productionOrderNo, production_order_type: child.productionOrderType })) }] });
      return tx.productionOrder.update({ where: { id }, data: this.audit.softDelete(user) });
    });
    await this.audit.record("production_order.delete", "production_order", user.id, id, { order_no: item.orderNo }); return result;
  }
  async addOperation(id: string, input: { operation_id: string; sequence_no: number; target_quantity: string; unit_id?: string }, user: CurrentUser) {
    this.parseDecimal(input.target_quantity, "INVALID_OPERATION_TARGET", "目标数量必须大于零", "目标数量");
    if (!Number.isInteger(input.sequence_no) || input.sequence_no <= 0) throw new UnprocessableEntityException({ code: "INVALID_OPERATION_TARGET", message: "工序顺序必须为正整数", details: [{ reason: `工序顺序必须是正整数，收到：${input.sequence_no}` }] });
    const operation = await this.prisma.operationCatalog.findFirst({ where: { id: input.operation_id, isActive: true, deletedAt: null } });
    if (!operation) throw new NotFoundException({ code: "OPERATION_NOT_FOUND", message: "工序不存在或已停用", details: [] });
    const orderBefore = await this.get(id);
    const unitId = input.unit_id ?? operation.defaultUnitId ?? orderBefore.unitId;
    const unit = await this.prisma.unit.findFirst({ where: { id: unitId, isActive: true, deletedAt: null } });
    if (!unit) throw new NotFoundException({ code: "UNIT_NOT_FOUND", message: "工序单位不存在或已停用", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${id}::uuid FOR UPDATE`;
      const order = await tx.productionOrder.findFirst({ where: { id, deletedAt: null }, include: { operations: { where: { deletedAt: null } } } });
      if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
      if (!["draft", "in_progress"].includes(order.status)) throw new UnprocessableEntityException({ code: "PRODUCTION_OPERATION_NOT_EDITABLE", message: "只有草稿或进行中的生产单可以添加工序", details: [] });
      if (order.operations.some((item) => item.operationCatalogId === operation.id && item.status !== "cancelled")) throw new ConflictException({ code: "PRODUCTION_OPERATION_DUPLICATE", message: "同一生产单不能重复添加相同工序", details: [] });
      const occupier = order.operations.find((item) => item.sequenceNo === input.sequence_no);
      if (occupier) throw new ConflictException({ code: "PRODUCTION_OPERATION_SEQUENCE_DUPLICATE", message: "生产单工序顺序不能重复（序号已被其他工序占用，含已取消工序）", details: [{ sequence_no: input.sequence_no, occupied_by_operation_id: occupier.id, occupied_by_status: occupier.status }] });
      return tx.productionOrderOperation.create({ data: { productionOrderId: id, operationCatalogId: operation.id, operationNameSnapshot: operation.operationName, unitId: unit.id, sequenceNo: input.sequence_no, targetQuantity: input.target_quantity, ...this.audit.create(user) } });
    });
    const order = await this.get(id);
    await this.audit.record("production_order_operation.create", "production_order_operation", user.id, result.id, { order_no: order.orderNo, production_order_id: id, production_order_status: order.status, before: {}, after: { status: "active", sequence_no: result.sequenceNo, target_quantity: result.targetQuantity.toString(), unit_id: result.unitId, operation_catalog_id: operation.id, operation_name: operation.operationName } });
    return result;
  }
  /**
   * Batch add operations picked from the operation catalog. The caller submits
   * catalog ids without any sequence: sequence numbers are assigned inside the
   * transaction as max(existing, including cancelled)+1…, so ordering carries no
   * user intent and can never collide with the (productionOrderId, sequenceNo)
   * unique constraint. The whole batch is atomic — any failure rolls back every row.
   */
  async addOperations(id: string, inputs: Array<{ operation_id: string; target_quantity: string; unit_id?: string }>, user: CurrentUser) {
    if (!inputs.length) throw new UnprocessableEntityException({ code: "PRODUCTION_OPERATION_BATCH_EMPTY", message: "请至少选择一道工序", details: [] });
    inputs.forEach((input, index) => this.parseDecimal(input.target_quantity, "INVALID_OPERATION_TARGET", "目标数量必须大于零", `第 ${index + 1} 道工序目标数量`));
    const duplicatedInBatch = inputs.find((input, index) => inputs.some((other, otherIndex) => otherIndex !== index && other.operation_id === input.operation_id));
    if (duplicatedInBatch) throw new UnprocessableEntityException({ code: "PRODUCTION_OPERATION_BATCH_DUPLICATE", message: "一次提交中不能包含重复工序", details: [{ operation_id: duplicatedInBatch.operation_id }] });
    const operationIds = inputs.map((input) => input.operation_id);
    const catalogRows = await this.prisma.operationCatalog.findMany({ where: { id: { in: operationIds }, deletedAt: null } });
    const missing = operationIds.filter((operationId) => !catalogRows.some((row) => row.id === operationId && row.isActive));
    if (missing.length) throw new NotFoundException({ code: "OPERATION_NOT_FOUND", message: "部分工序不存在或已停用，请刷新工序池后重试", details: missing.map((operation_id) => ({ operation_id })) });
    const orderBefore = await this.get(id);
    const unitIds = inputs.map((input) => input.unit_id ?? catalogRows.find((row) => row.id === input.operation_id)?.defaultUnitId ?? orderBefore.unitId);
    const units = await this.prisma.unit.findMany({ where: { id: { in: unitIds }, isActive: true, deletedAt: null } });
    const missingUnitId = unitIds.find((unitId) => !units.some((unit) => unit.id === unitId));
    if (missingUnitId) throw new NotFoundException({ code: "UNIT_NOT_FOUND", message: "工序单位不存在或已停用", details: [{ unit_id: missingUnitId }] });
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${id}::uuid FOR UPDATE`;
      const order = await tx.productionOrder.findFirst({ where: { id, deletedAt: null }, include: { operations: { where: { deletedAt: null } } } });
      if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
      if (!["draft", "in_progress"].includes(order.status)) throw new UnprocessableEntityException({ code: "PRODUCTION_OPERATION_NOT_EDITABLE", message: "只有草稿或进行中的生产单可以添加工序", details: [] });
      const duplicate = order.operations.find((item) => item.status !== "cancelled" && operationIds.includes(item.operationCatalogId));
      if (duplicate) throw new ConflictException({ code: "PRODUCTION_OPERATION_DUPLICATE", message: "同一生产单不能重复添加相同工序", details: [{ operation_id: duplicate.operationCatalogId, operation_name: duplicate.operationNameSnapshot, status: duplicate.status }] });
      // Cancelled rows keep their sequence number, so resume after the highest
      // sequence ever used on this order (including cancelled rows).
      let nextSequence = order.operations.reduce((max, item) => Math.max(max, item.sequenceNo), 0);
      const rows: Array<{ id: string; sequenceNo: number; targetQuantity: Prisma.Decimal; unitId: string; operationCatalogId: string; operationNameSnapshot: string }> = [];
      for (const input of inputs) {
        nextSequence += 1;
        const catalog = catalogRows.find((row) => row.id === input.operation_id)!;
        rows.push(await tx.productionOrderOperation.create({ data: { productionOrderId: id, operationCatalogId: catalog.id, operationNameSnapshot: catalog.operationName, unitId: input.unit_id ?? catalog.defaultUnitId ?? orderBefore.unitId, sequenceNo: nextSequence, targetQuantity: input.target_quantity, ...this.audit.create(user) } }));
      }
      return rows;
    });
    const order = await this.get(id);
    await this.audit.record("production_order_operation.batch_create", "production_order_operation", user.id, id, { order_no: order.orderNo, production_order_status: order.status, count: created.length, operations: created.map((row) => ({ production_order_operation_id: row.id, operation_catalog_id: row.operationCatalogId, operation_name: row.operationNameSnapshot, sequence_no: row.sequenceNo, target_quantity: row.targetQuantity.toString(), unit_id: row.unitId })) });
    return created;
  }
  async updateOperation(id: string, operationId: string, input: OperationPatch, reason: string | undefined, user: CurrentUser) {
    if (input.target_quantity !== undefined) this.parseDecimal(input.target_quantity, "INVALID_OPERATION_TARGET", "目标数量必须大于零", "目标数量");
    if (input.sequence_no !== undefined && (!Number.isInteger(input.sequence_no) || input.sequence_no <= 0)) throw new UnprocessableEntityException({ code: "INVALID_OPERATION_TARGET", message: "工序顺序必须为正整数", details: [{ reason: `工序顺序必须是正整数，收到：${input.sequence_no}` }] });
    if (input.unit_id !== undefined) { const unit = await this.prisma.unit.findFirst({ where: { id: input.unit_id, isActive: true, deletedAt: null } }); if (!unit) throw new NotFoundException({ code: "UNIT_NOT_FOUND", message: "工序单位不存在或已停用", details: [] }); }
    const changed = Object.keys(input).filter((key) => input[key as keyof OperationPatch] !== undefined);
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${id}::uuid FOR UPDATE`;
      const order = await tx.productionOrder.findFirst({ where: { id, deletedAt: null }, include: { operations: { where: { deletedAt: null } } } });
      if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
      const operation = order.operations.find((candidate) => candidate.id === operationId);
      if (!operation) throw new NotFoundException({ code: "PRODUCTION_OPERATION_NOT_FOUND", message: "生产单工序不存在", details: [] });
      if (!["draft", "in_progress"].includes(order.status)) throw new UnprocessableEntityException({ code: "PRODUCTION_OPERATION_NOT_EDITABLE", message: "已完工或关闭的生产单不能修改工序", details: [{ production_order_status: order.status }] });
      if (order.status === "in_progress" && changed.length && !reason?.trim()) throw new UnprocessableEntityException({ code: "OPERATION_UPDATE_REASON_REQUIRED", message: "进行中的生产单修改工序目标、顺序或单位必须填写原因", details: [] });
      if (input.sequence_no !== undefined) { const occupier = order.operations.find((candidate) => candidate.id !== operationId && candidate.sequenceNo === input.sequence_no); if (occupier) throw new ConflictException({ code: "PRODUCTION_OPERATION_SEQUENCE_DUPLICATE", message: "生产单工序顺序不能重复（序号已被其他工序占用，含已取消工序）", details: [{ sequence_no: input.sequence_no, occupied_by_operation_id: occupier.id, occupied_by_status: occupier.status }] }); }
      const before = { status: operation.status, sequence_no: operation.sequenceNo, target_quantity: operation.targetQuantity.toString(), unit_id: operation.unitId };
      const row = await tx.productionOrderOperation.update({ where: { id: operationId }, data: { ...(input.sequence_no === undefined ? {} : { sequenceNo: input.sequence_no }), ...(input.target_quantity === undefined ? {} : { targetQuantity: input.target_quantity }), ...(input.unit_id === undefined ? {} : { unitId: input.unit_id }), ...this.audit.update(user) } });
      if (this.progress && changed.some((key) => key !== "sequence_no")) await this.progress.recalculateInTransaction(tx, id, "production_order_operation", operationId, user);
      return { row, orderNo: order.orderNo, before };
    });
    await this.audit.record("production_order_operation.update", "production_order_operation", user.id, operationId, { order_no: outcome.orderNo, reason: reason?.trim() ?? null, changed, before: outcome.before, after: { status: outcome.row.status, sequence_no: outcome.row.sequenceNo, target_quantity: outcome.row.targetQuantity.toString(), unit_id: outcome.row.unitId } }); return outcome.row;
  }
  async cancelOperation(id: string, operationId: string, reason: string, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "CANCELLATION_REASON_REQUIRED", message: "取消工序必须填写原因", details: [] });
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${id}::uuid FOR UPDATE`;
      const order = await tx.productionOrder.findFirst({ where: { id, deletedAt: null }, include: { operations: { where: { deletedAt: null } } } });
      if (!order) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
      const operation = order.operations.find((candidate) => candidate.id === operationId);
      if (!operation) throw new NotFoundException({ code: "PRODUCTION_OPERATION_NOT_FOUND", message: "生产单工序不存在", details: [] });
      if (!["draft", "in_progress"].includes(order.status)) throw new UnprocessableEntityException({ code: "PRODUCTION_OPERATION_NOT_EDITABLE", message: "已完工或关闭的生产单不能取消工序", details: [{ production_order_status: order.status }] });
      const before = { status: operation.status, sequence_no: operation.sequenceNo, target_quantity: operation.targetQuantity.toString(), unit_id: operation.unitId };
      const row = await tx.productionOrderOperation.update({ where: { id: operationId }, data: { status: "cancelled", cancellationReason: reason.trim(), ...this.audit.update(user) } });
      return { row, orderNo: order.orderNo, before };
    });
    await this.audit.record("production_order_operation.cancel", "production_order_operation", user.id, operationId, { order_no: outcome.orderNo, reason: reason.trim(), before: outcome.before, after: { status: outcome.row.status, sequence_no: outcome.row.sequenceNo, target_quantity: outcome.row.targetQuantity.toString(), unit_id: outcome.row.unitId } }); return outcome.row;
  }
  private async assertCompletionReady(client: PrismaService | Prisma.TransactionClient, order: CompletionOrder): Promise<Prisma.Decimal> {
    const pendingAlerts = await client.productionDailyAlert.count({ where: { productionOrderId: order.id, deletedAt: null, status: "pending", productionOrderOperation: { status: { not: "cancelled" } } } });
    if (pendingAlerts) throw new UnprocessableEntityException({ code: "PRODUCTION_ALERTS_UNCONFIRMED", message: "存在未处理的生产告警，确认后才能完工", details: [{ count: pendingAlerts }] });
    if (order.executionMode === "in_house") {
      const [reports, employeeReports] = await Promise.all([
        client.operationDailyReport.groupBy({ by: ["productionOrderOperationId"], where: { productionOrderId: order.id, deletedAt: null }, _sum: { completedQuantity: true } }),
        client.employeeDailyReport.groupBy({ by: ["productionOrderOperationId"], where: { productionOrderId: order.id, deletedAt: null }, _sum: { quantity: true } }),
      ]);
      // 完工口径与进度计量一致：工序实际完成量 = max(工序日报累计, 员工日报累计)，避免双源同填双重计数。
      const operationActual = new Map(reports.map((report) => [report.productionOrderOperationId, new Prisma.Decimal(report._sum.completedQuantity ?? 0)]));
      const employeeActual = new Map(employeeReports.map((report) => [report.productionOrderOperationId, new Prisma.Decimal(report._sum.quantity ?? 0)]));
      const actual = new Map<string, Prisma.Decimal>();
      for (const operation of order.operations) { const operationTotal = operationActual.get(operation.id) ?? new Prisma.Decimal(0); const employeeTotal = employeeActual.get(operation.id) ?? new Prisma.Decimal(0); actual.set(operation.id, employeeTotal.gt(operationTotal) ? employeeTotal : operationTotal); }
      const valid = order.operations.filter((operation) => operation.status !== "cancelled");
      const incomplete = valid.filter((operation) => !(actual.get(operation.id) ?? new Prisma.Decimal(0)).gte(operation.targetQuantity));
      if (incomplete.length) throw new UnprocessableEntityException({ code: "PRODUCTION_OPERATIONS_INCOMPLETE", message: "所有有效工序达到计划数量后才能完工", details: incomplete.map((operation) => ({ operation_id: operation.id, operation_name: operation.operationNameSnapshot, planned_quantity: operation.targetQuantity.toString(), completed_quantity: (actual.get(operation.id) ?? new Prisma.Decimal(0)).toString() })) });
      let completedQuantity: Prisma.Decimal | null = null;
      for (const operation of valid) { const quantity = actual.get(operation.id) ?? new Prisma.Decimal(0); if (completedQuantity === null || quantity.lt(completedQuantity)) completedQuantity = quantity; }
      return completedQuantity ?? new Prisma.Decimal(0);
    }
    const [returned, shipped] = await Promise.all([
      client.outsourceReturnTransfer.aggregate({ where: { productionOrderId: order.id, transferType: "finished_goods_return", deletedAt: null, status: { notIn: ["draft", "cancelled", "reversed"] } }, _sum: { quantity: true } }),
      client.outsourceDirectShipment.aggregate({ where: { productionOrderId: order.id, deletedAt: null, status: "dispatched" }, _sum: { quantity: true } }),
    ]);
    const returnedQuantity = new Prisma.Decimal(returned._sum.quantity ?? 0);
    const shippedQuantity = new Prisma.Decimal(shipped._sum.quantity ?? 0);
    if (returnedQuantity.plus(shippedQuantity).lt(order.plannedQuantity)) throw new UnprocessableEntityException({ code: "OUTSOURCE_RETURN_INCOMPLETE", message: "外加工回厂交接与直发（未冲销）累计量达到计划数量后才能完工", details: [{ planned_quantity: order.plannedQuantity.toString(), returned_quantity: returnedQuantity.toString(), shipped_quantity: shippedQuantity.toString() }] });
    return returnedQuantity.plus(shippedQuantity);
  }
  async transition(id: string, target: string, reason: string | undefined, user: CurrentUser) {
    if (!reason?.trim()) throw new UnprocessableEntityException({ code: "TRANSITION_REASON_REQUIRED", message: "状态转换必须填写原因", details: [] });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM production_orders WHERE id = ${id}::uuid FOR UPDATE`;
      const locked = await tx.productionOrder.findFirst({ where: { id, deletedAt: null }, include: { operations: { where: { deletedAt: null } } } });
      if (!locked) throw new NotFoundException({ code: "PRODUCTION_ORDER_NOT_FOUND", message: "生产单不存在", details: [] });
      if (!ALLOWED_TRANSITIONS[locked.status]?.includes(target)) throw new UnprocessableEntityException({ code: "INVALID_STATE_TRANSITION", message: "生产单状态转换不允许", details: [{ current_status: locked.status, target }] });
      if (target === "in_progress" && locked.status === "draft" && locked.executionMode === "in_house" && !locked.operations.some((operation) => operation.status === "active")) throw new UnprocessableEntityException({ code: "PRODUCTION_OPERATIONS_REQUIRED", message: "厂内生产单启动前至少需要一道有效工序", details: [] });
      const dates = target === "in_progress" && locked.status === "draft" ? { startedOn: new Date() } : target === "completed" ? { completedOn: new Date() } : target === "in_progress" && locked.status === "completed" ? { completedOn: null, actualCompletedQuantity: null } : {};
      let completedQuantity: Prisma.Decimal | null = null;
      if (target === "completed") completedQuantity = await this.assertCompletionReady(tx, locked);
      const row = await tx.productionOrder.update({ where: { id }, data: { status: target, ...dates, ...(completedQuantity !== null ? { actualCompletedQuantity: completedQuantity } : {}), ...this.audit.update(user) } });
      return { row, from: locked.status };
    });
    await this.audit.record("production_order.transition", "production_order", user.id, id, { order_no: result.row.orderNo, from: result.from, to: target, reason: reason?.trim(), before: { status: result.from, planned_quantity: result.row.plannedQuantity.toString() }, after: { status: result.row.status, planned_quantity: result.row.plannedQuantity.toString(), ...(result.row.actualCompletedQuantity !== null ? { actual_completed_quantity: result.row.actualCompletedQuantity.toString() } : {}) } }); return result.row;
  }
  async impactPreview(id: string) { const order = await this.get(id); const [purchaseOrders, auditEvents] = await Promise.all([this.prisma.purchaseOrder.findMany({ where: { orderNo: order.orderNo, deletedAt: null }, select: { id: true, purchaseOrderNo: true, status: true } }), this.prisma.auditEvent.count({ where: { entityType: "production_order", entityId: id } })]); return { order_no: order.orderNo, production_order_no: order.productionOrderNo, status: order.status, bom_id: order.bomId, bom_version: order.bomVersion, operations: order.operations.map((operation) => ({ id: operation.id, name: operation.operationNameSnapshot, status: operation.status, target_quantity: operation.targetQuantity })), downstream: { purchase_orders: purchaseOrders, purchase_order_count: purchaseOrders.length, inventory_facts: "本批尚未建立", payroll: "本批尚未建立" }, audit_event_count: auditEvents, warning: purchaseOrders.length ? "该订单已有采购事实，生产单变更需人工复核" : null }; }
  async auditEvents(id: string) { await this.get(id); return this.prisma.auditEvent.findMany({ where: { entityType: "production_order", entityId: id }, orderBy: { createdAt: "desc" } }); }
  private async refs(input: Input) {
    const [order, location, unit] = await Promise.all([this.prisma.salesOrder.findFirst({ where: { orderNo: input.order_no, status: "confirmed", deletedAt: null } }), this.prisma.productionLocation.findFirst({ where: { id: input.execution_location_id, isActive: true, deletedAt: null } }), this.prisma.unit.findFirst({ where: { id: input.unit_id, isActive: true, deletedAt: null } })]);
    if (!order) throw new NotFoundException({ code: "SALES_ORDER_NOT_CONFIRMED", message: "销售单不存在或未确认", details: [] });
    const bom = await this.prisma.bom.findFirst({ where: { id: input.bom_id, salesOrderId: order.id, orderNo: input.order_no, deletedAt: null }, include: { items: { where: { deletedAt: null } } } });
    if (!bom) throw new NotFoundException({ code: "BOM_NOT_FOUND", message: "BOM表不存在或不属于该销售单", details: [] });
    if (bom.version !== input.bom_version) throw new UnprocessableEntityException({ code: "BOM_VERSION_CHANGED", message: "BOM 版本已变更，请刷新后选择最新版本", details: [{ client_bom_version: input.bom_version, current_bom_version: bom.version }] });
    if (!location) throw new NotFoundException({ code: "PRODUCTION_LOCATION_NOT_FOUND", message: "生产地点不存在或已停用", details: [] });
    if (!unit) throw new NotFoundException({ code: "UNIT_NOT_FOUND", message: "单位不存在或已停用", details: [] });
    await this.validateLocation(input.execution_mode, location.id, location.locationType);
    return { order, bom, location, unit };
  }
  private async validateLocation(mode: string, locationId: string, knownType?: string) { if (mode !== "in_house" && mode !== "outsourced") throw new UnprocessableEntityException({ code: "INVALID_EXECUTION_MODE", message: "执行方式无效", details: [] }); const type = knownType ?? (await this.prisma.productionLocation.findFirst({ where: { id: locationId, deletedAt: null } }))?.locationType; if ((mode === "in_house" && type !== "workshop") || (mode === "outsourced" && type !== "outsource_site")) throw new UnprocessableEntityException({ code: "EXECUTION_LOCATION_MISMATCH", message: "执行方式与生产地点类型不匹配", details: [] }); }
  private parseDecimal(value: string, code: string, message: string, label: string): Prisma.Decimal {
    const text = String(value ?? "").trim();
    const reject = (reason: string) => { throw new UnprocessableEntityException({ code, message, details: [{ field: label, reason }] }); };
    if (!/^\d+(\.\d+)?$/.test(text)) return reject(`${label}必须是大于零的十进制数（不接受负数、科学计数法、NaN 或其他字符）`);
    const [integerPart, fractionPart = ""] = text.split(".");
    if (fractionPart.length > 4) return reject(`${label}小数位不能超过 4 位`);
    const integerDigits = integerPart.replace(/^0+(?=\d)/, "").length;
    if (integerDigits > 14) return reject(`${label}整数位不能超过 14 位（超出 Decimal(18,4) 范围）`);
    const decimal = new Prisma.Decimal(text);
    if (decimal.isZero()) return reject(`${label}必须大于零`);
    return decimal;
  }
  private snapshotBom(bom: { id: string; orderNo: string; salesOrderId: string; version: number; status: string; items: Array<{ id: string; materialId: string; materialName: string; model: string | null; specificationModel: string | null; color: string | null; unitId: string | null; unit: string; requiredQuantity: Prisma.Decimal; productionBatchBase: Prisma.Decimal | null; baseUsage: Prisma.Decimal | null; approvedUsage: Prisma.Decimal | null; lossQuantity: Prisma.Decimal | null; lossRate: Prisma.Decimal | null }> }) {
    return { id: bom.id, order_no: bom.orderNo, sales_order_id: bom.salesOrderId, version: bom.version, status: bom.status, snapshot_taken_at: new Date().toISOString(), items: bom.items.map((item) => ({ id: item.id, material_id: item.materialId, material_name: item.materialName, model: item.model ?? null, specification_model: item.specificationModel ?? null, color: item.color ?? null, unit_id: item.unitId ?? null, unit: item.unit, required_quantity: item.requiredQuantity.toString(), production_batch_base: item.productionBatchBase?.toString() ?? null, base_usage: item.baseUsage?.toString() ?? null, approved_usage: item.approvedUsage?.toString() ?? null, loss_quantity: item.lossQuantity?.toString() ?? null, loss_rate: item.lossRate?.toString() ?? null })) };
  }
}

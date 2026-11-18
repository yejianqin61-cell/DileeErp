import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import { AuditService } from "../../platform/audit/audit.service";
import type { CurrentUser } from "../../platform/auth/auth.service";
import { PrismaService } from "../../platform/database/prisma.service";
import {
  buildTaskReminder,
  compareTaskReminders,
  countTaskReminders,
  countTaskRemindersByModule,
  isTaskSourcePair,
  type TaskDraft,
  type TaskReminder,
} from "./task-reminders.domain";

/**
 * 首页任务提醒的读模型。
 *
 * 这里**不新建任务表**：待办是现有业务单据的状态投影，真正的「完成」也由源单据推进
 * （入库通知接收、质检录入、领料单出库……），面板只做汇总和跳转。这样不会出现
 * 「任务表说已办、源单据还在待处理」的第二份事实。
 *
 * 「标记完成」只解决「这条提醒我看过了、别再挡视线」：复用 `alert_handlings`
 * （`source_type = task_reminder` + 源单据 UUID + task_type 唯一），因此不需要新增迁移，
 * 也不会和生产库里的业务事实混在一起。源单据后来真的处理掉时，任务会自然消失。
 */

const TASK_SOURCE_TYPE = "task_reminder";
const TASK_ROW_LIMIT = 200;
const PLAN_ITEM_LIMIT = 500;
const DAY_MS = 86_400_000;

export type CompleteTaskInput = { source_type: string; source_id: string; task_type: string };

function addDays(value: Date | null | undefined, days: number): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + days * DAY_MS);
}

function quantityText(value: { toString(): string } | null | undefined): string {
  return value ? value.toString() : "0";
}

@Injectable()
export class TaskRemindersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(now: Date = new Date()) {
    const tasks = await this.collect(now);
    return { data: tasks, meta: { ...this.countsOf(tasks), limit: TASK_ROW_LIMIT } };
  }

  /** 收起状态只拿计数：首页默认不加载完整列表，避免一进页面就拉几百行。 */
  async summary(now: Date = new Date()) {
    const tasks = await this.collect(now);
    return { data: this.countsOf(tasks), meta: { limit: TASK_ROW_LIMIT } };
  }

  private countsOf(tasks: readonly TaskReminder[]) {
    return { ...countTaskReminders(tasks), by_module: countTaskRemindersByModule(tasks) };
  }

  async complete(input: CompleteTaskInput, user: CurrentUser) {
    if (!isTaskSourcePair(input.source_type, input.task_type)) {
      throw new UnprocessableEntityException({ code: "TASK_REMINDER_UNKNOWN_TYPE", message: "未知的任务类型，无法标记完成", details: [] });
    }
    const row = await this.prisma.alertHandling.upsert({
      where: {
        sourceType_sourceId_alertType: {
          sourceType: TASK_SOURCE_TYPE,
          sourceId: input.source_id,
          alertType: input.task_type,
        },
      },
      create: {
        sourceType: TASK_SOURCE_TYPE,
        sourceId: input.source_id,
        alertType: input.task_type,
        status: "resolved",
        remark: "首页任务提醒标记完成",
        ...this.audit.create(user),
      },
      update: {
        status: "resolved",
        remark: "首页任务提醒标记完成",
        ...this.audit.update(user),
      },
    });
    await this.audit.record("task_reminder.complete", "task_reminder", user.id, input.source_id, {
      source_type: input.source_type,
      task_type: input.task_type,
      handling_id: row.id,
    });
    return { ...input, completed: true };
  }

  private async collect(now: Date): Promise<TaskReminder[]> {
    const [planItems, purchaseOrders, inspections, inboundNotices, movements, submissions, completed] = await Promise.all([
      this.collectPlanItems(),
      this.prisma.purchaseOrder.findMany({
        where: { deletedAt: null, status: { in: ["ordered", "partially_arrived"] } },
        select: {
          id: true,
          purchaseOrderNo: true,
          orderNo: true,
          expectedDate: true,
          purchaseDate: true,
          createdAt: true,
          supplier: { select: { name: true } },
        },
        orderBy: [{ expectedDate: "asc" }, { createdAt: "asc" }],
        take: TASK_ROW_LIMIT,
      }),
      this.prisma.incomingInspection.findMany({
        where: { deletedAt: null, status: { in: ["pending", "inspecting"] } },
        select: {
          id: true,
          orderNo: true,
          status: true,
          createdAt: true,
          purchaseReceipt: {
            select: {
              id: true,
              receiptNo: true,
              receivedDate: true,
              purchaseOrderItem: {
                select: {
                  quantity: true,
                  material: { select: { name: true } },
                  unit: { select: { name: true } },
                },
              },
            },
          },
        },
        orderBy: { createdAt: "asc" },
        take: TASK_ROW_LIMIT,
      }),
      this.prisma.rawMaterialInboundNotice.findMany({
        where: { deletedAt: null, status: "pending" },
        select: {
          id: true,
          noticeNo: true,
          orderNo: true,
          notifiedAt: true,
          notifiedQuantity: true,
          createdAt: true,
          material: { select: { name: true } },
          unit: { select: { name: true } },
        },
        orderBy: { notifiedAt: "asc" },
        take: TASK_ROW_LIMIT,
      }),
      this.prisma.rawMaterialMovement.findMany({
        where: { deletedAt: null, status: "pending_outbound", documentType: { in: ["issue", "replenishment"] } },
        select: {
          id: true,
          movementNo: true,
          documentType: true,
          orderNo: true,
          submittedAt: true,
          createdAt: true,
          productionOrder: { select: { productionOrderNo: true } },
          lines: { where: { deletedAt: null }, select: { id: true } },
        },
        orderBy: [{ submittedAt: "asc" }, { createdAt: "asc" }],
        take: TASK_ROW_LIMIT,
      }),
      this.prisma.finishedGoodsInspectionSubmission.findMany({
        where: { deletedAt: null, status: { in: ["submitted", "inspecting"] } },
        select: {
          id: true,
          submissionNo: true,
          orderNo: true,
          productionOrderNoSnapshot: true,
          submittedQuantity: true,
          unitNameSnapshot: true,
          submissionDate: true,
          createdAt: true,
        },
        orderBy: { submissionDate: "asc" },
        take: TASK_ROW_LIMIT,
      }),
      this.prisma.alertHandling.findMany({
        where: { sourceType: TASK_SOURCE_TYPE, status: "resolved" },
        select: { sourceId: true, alertType: true },
      }),
    ]);

    const drafts: TaskDraft[] = [];

    for (const plan of this.groupPlanItems(planItems)) {
      drafts.push({
        source_type: "purchase_plan",
        source_id: plan.plan_id,
        task_type: "unordered",
        title: "采购计划待下单",
        module: "procurement",
        document_no: plan.plan_no,
        order_no: plan.order_no,
        detail: `${plan.item_count} 行未下单 · ${plan.material_summary}`,
        href: `/procurement/plans?plan_id=${encodeURIComponent(plan.plan_id)}`,
        due_at: plan.due_at,
        created_at: plan.created_at,
      });
    }

    for (const row of purchaseOrders) {
      drafts.push({
        source_type: "purchase_order",
        source_id: row.id,
        task_type: "arrival",
        title: "采购到货待登记",
        module: "procurement",
        document_no: row.purchaseOrderNo,
        order_no: row.orderNo,
        detail: `${row.orderNo} · ${row.supplier?.name ?? "未指定供应商"}`,
        href: `/procurement/orders?order_no=${encodeURIComponent(row.orderNo)}`,
        due_at: row.expectedDate,
        created_at: row.purchaseDate ?? row.createdAt,
      });
    }

    for (const row of inspections) {
      const receipt = row.purchaseReceipt;
      const item = receipt?.purchaseOrderItem;
      drafts.push({
        source_type: "incoming_inspection",
        source_id: row.id,
        task_type: "inspection",
        title: row.status === "inspecting" ? "来料质检进行中" : "来料质检待处理",
        module: "qc",
        document_no: receipt?.receiptNo ?? row.id,
        order_no: row.orderNo,
        detail: `${row.orderNo} · ${item?.material?.name ?? "未知物料"} × ${quantityText(item?.quantity)}${item?.unit?.name ?? ""}`,
        href: `/qc/incoming?receipt_id=${encodeURIComponent(receipt?.id ?? "")}`,
        // 来料质检没有单独的截止字段：按「到货后 1 天内完成」作为作业口径，逾期会在列表里标红。
        due_at: addDays(receipt?.receivedDate, 1),
        created_at: row.createdAt,
      });
    }

    for (const row of inboundNotices) {
      drafts.push({
        source_type: "raw_material_inbound_notice",
        source_id: row.id,
        task_type: "inbound_notice",
        title: "原料入库通知待接收",
        module: "warehouse",
        document_no: row.noticeNo,
        order_no: row.orderNo,
        detail: `${row.orderNo} · ${row.material?.name ?? "未知物料"} × ${quantityText(row.notifiedQuantity)}${row.unit?.name ?? ""}`,
        href: `/warehouse?notice_id=${encodeURIComponent(row.id)}`,
        // 仓库接收通知没有承诺日期：按通知后 1 天内接收作为作业口径。
        due_at: addDays(row.notifiedAt, 1),
        created_at: row.createdAt,
      });
    }

    for (const row of movements) {
      const label = row.documentType === "replenishment" ? "补料单" : "领料单";
      drafts.push({
        source_type: "raw_material_movement",
        source_id: row.id,
        task_type: "outbound",
        title: `${label}待仓库出库`,
        module: "warehouse",
        document_no: row.movementNo,
        order_no: row.orderNo,
        detail: `${row.orderNo} · ${row.productionOrder?.productionOrderNo ?? "未知生产单"} · ${row.lines.length} 项物料`,
        href: `/production/material-issues?movement_id=${encodeURIComponent(row.id)}`,
        // 生产提交后仓库应在 1 天内出库；`submittedAt` 为空时用创建时间兜底（历史单据）。
        due_at: addDays(row.submittedAt ?? row.createdAt, 1),
        created_at: row.createdAt,
      });
    }

    for (const row of submissions) {
      drafts.push({
        source_type: "finished_goods_inspection_submission",
        source_id: row.id,
        task_type: "finished_goods_qc",
        title: "成品送检待质检",
        module: "qc",
        document_no: row.submissionNo,
        order_no: row.orderNo,
        detail: `${row.orderNo} · ${row.productionOrderNoSnapshot} · ${quantityText(row.submittedQuantity)}${row.unitNameSnapshot}`,
        href: `/qc/finished-goods?order_no=${encodeURIComponent(row.orderNo)}`,
        // 成品送检没有单独的截止字段：按送检后 1 天内完成质检作为作业口径。
        due_at: addDays(row.submissionDate, 1),
        created_at: row.createdAt,
      });
    }

    const done = new Set(completed.map((row) => `${row.sourceId}:${row.alertType}`));
    return drafts
      .map((draft) => buildTaskReminder(draft, now))
      .filter((task) => !done.has(`${task.source_id}:${task.task_type}`))
      .sort(compareTaskReminders)
      .slice(0, TASK_ROW_LIMIT);
  }

  private collectPlanItems() {
    return this.prisma.purchasePlanItem.findMany({
      where: { deletedAt: null, purchaseOrderItemId: null, plan: { deletedAt: null } },
      select: {
        expectedDate: true,
        createdAt: true,
        plan: { select: { id: true, planNo: true, orderNo: true, createdAt: true } },
        material: { select: { name: true } },
      },
      orderBy: [{ expectedDate: "asc" }, { createdAt: "asc" }],
      take: PLAN_ITEM_LIMIT,
    });
  }

  private groupPlanItems(
    rows: Awaited<ReturnType<TaskRemindersService["collectPlanItems"]>>,
  ): Array<{ plan_id: string; plan_no: string; order_no: string; item_count: number; material_summary: string; due_at: Date | null; created_at: Date }> {
    const groups = new Map<string, { plan_id: string; plan_no: string; order_no: string; item_count: number; materials: string[]; due_at: Date | null; created_at: Date }>();
    for (const row of rows) {
      const plan = row.plan;
      const group = groups.get(plan.id) ?? {
        plan_id: plan.id,
        plan_no: plan.planNo,
        order_no: plan.orderNo,
        item_count: 0,
        materials: [],
        due_at: null,
        created_at: plan.createdAt,
      };
      group.item_count += 1;
      if (row.material?.name && !group.materials.includes(row.material.name)) group.materials.push(row.material.name);
      if (row.expectedDate && (!group.due_at || row.expectedDate < group.due_at)) group.due_at = row.expectedDate;
      groups.set(plan.id, group);
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        material_summary: group.materials.length > 3 ? `${group.materials.slice(0, 3).join("、")} 等 ${group.materials.length} 种物料` : group.materials.join("、") || "未填写物料",
      }))
      .sort((left, right) => (left.due_at?.valueOf() ?? Number.MAX_SAFE_INTEGER) - (right.due_at?.valueOf() ?? Number.MAX_SAFE_INTEGER));
  }
}

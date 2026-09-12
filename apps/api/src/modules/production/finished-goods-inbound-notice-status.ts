import { Prisma } from "@prisma/client";
import type { CurrentUser } from "../../platform/auth/auth.service";

/**
 * 成品入库通知状态推导（与 daily-report-alerts.ts 同一模式：抽成纯事务函数，
 * 让送检/QC/入库各处都能在**自己的事务内**刷新状态，不需要服务间互相注入）。
 *
 * 口径：
 * - pending：尚未送检；
 * - partially_inbound：已部分送检，或存在在途（草稿）入库；
 * - completed：通知量已全部送检且没有在途入库（差额通常是不合格数量，不会再有入库）；
 * - cancelled：取消态不参与推导。
 *
 * 调用方必须已锁住通知行（或至少已锁住相应业务行），保证与并发送检/入库串行。
 */
export async function syncFinishedGoodsInboundNoticeStatus(tx: Prisma.TransactionClient, noticeId: string | null | undefined, user: CurrentUser): Promise<string | null> {
  if (!noticeId) return null;
  const notice = await tx.finishedGoodsInboundNotice.findFirst({ where: { id: noticeId, deletedAt: null }, select: { id: true, status: true, noticeQuantity: true } });
  if (!notice || notice.status === "cancelled") return null;
  const submissions = await tx.finishedGoodsInspectionSubmission.findMany({ where: { sourceType: "finished_goods_inbound_notice", sourceId: noticeId, deletedAt: null, status: { notIn: ["cancelled", "corrected"] } }, select: { id: true, submittedQuantity: true, status: true } });
  // 只有真正提交过的送检才算「已送检」：草稿送检占额度但还没进入质检流程，
  // 若把它算作完成，仓库那边一建草稿通知就变「已完成」并从未入库列表里消失。
  const submitted = submissions.filter((row) => row.status !== "draft").reduce((sum, row) => sum.plus(row.submittedQuantity), new Prisma.Decimal(0));
  const submissionIds = submissions.map((row) => row.id);
  const draft = submissionIds.length ? await tx.finishedGoodsInbound.aggregate({ where: { submissionId: { in: submissionIds }, deletedAt: null, status: "draft" }, _sum: { quantity: true } }) : { _sum: { quantity: null } };
  const draftQuantity = new Prisma.Decimal(draft._sum.quantity ?? 0);
  const status = submissions.length === 0 ? "pending" : submitted.gte(notice.noticeQuantity) && draftQuantity.lte(0) ? "completed" : "partially_inbound";
  if (status === notice.status) return status;
  await tx.finishedGoodsInboundNotice.update({ where: { id: noticeId }, data: { status, version: { increment: 1 }, updatedBy: user.id } });
  return status;
}

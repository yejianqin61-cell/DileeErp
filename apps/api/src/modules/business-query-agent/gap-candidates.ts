import { Logger } from "@nestjs/common";
import type { AgentGapReport, PrismaClient } from "@prisma/client";
import type { AcceptedGap } from "./tools/gap-check";

export const GAP_PROMOTION_THRESHOLD = 3;

export type GapCandidateStore = Pick<PrismaClient, "agentGapCandidate" | "agentGapReport">;

export type GapReportInput = { sessionId: string; runId: string; gap: AcceptedGap };

export type GapTicket = {
  candidate_id: string;
  nearest_operation: string;
  missing: string;
  missing_details: string[];
  missing_params: string[];
  needed_fields: string[];
  unverified_fields: string[];
  session_count: number;
};

export interface GapTicketBuilder {
  build(ticket: GapTicket): Promise<{ dispatched: boolean }>;
}

export class LoggingGapTicketBuilder implements GapTicketBuilder {
  private readonly logger = new Logger("business-query-agent");

  async build(ticket: GapTicket): Promise<{ dispatched: boolean }> {
    this.logger.log(`缺口候选达到门槛 candidate=${ticket.candidate_id} operation=${ticket.nearest_operation} missing=${ticket.missing}`);
    return { dispatched: false };
  }
}

const unique = (values: unknown[]): string[] => [...new Set(values.filter((value): value is string => typeof value === "string"))];
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export class GapCandidateService {
  private readonly logger = new Logger("business-query-agent");

  constructor(private readonly client: GapCandidateStore, private readonly builder: GapTicketBuilder) {}

  async record({ sessionId, runId, gap }: GapReportInput): Promise<{ candidateId: string; sessionCount: number }> {
    const key = { nearestOperation: gap.nearest_operation, missing: gap.missing };
    await this.client.agentGapCandidate.createMany({ data: [{ ...key, updatedAt: new Date() }], skipDuplicates: true });
    const candidate = await this.client.agentGapCandidate.findFirst({ where: key });
    if (!candidate) throw new Error("缺口候选写入后读不到");
    await this.client.agentGapReport.createMany({
      data: [{
        candidateId: candidate.id,
        sessionId,
        runId,
        missingDetail: gap.missing_detail,
        missingParam: gap.missing_param ?? null,
        neededFields: gap.needed_fields,
        unverifiedFields: gap.unverified_fields,
      }],
      skipDuplicates: true,
    });
    const reports = await this.client.agentGapReport.findMany({ where: { candidateId: candidate.id }, orderBy: { createdAt: "asc" } });
    const sessionCount = new Set(reports.map((report) => report.sessionId)).size;
    if (sessionCount >= GAP_PROMOTION_THRESHOLD) await this.promote(candidate.id, key, reports, sessionCount);
    return { candidateId: candidate.id, sessionCount };
  }

  private async promote(id: string, key: { nearestOperation: string; missing: string }, reports: AgentGapReport[], sessionCount: number): Promise<void> {
    const promoted = await this.client.agentGapCandidate.updateMany({ where: { id, status: "accumulating" }, data: { status: "ready" } });
    if (promoted.count !== 1) return;
    try {
      const outcome = await this.builder.build({
        candidate_id: id,
        nearest_operation: key.nearestOperation,
        missing: key.missing,
        missing_details: unique(reports.map((report) => report.missingDetail)),
        missing_params: unique(reports.map((report) => report.missingParam)),
        needed_fields: unique(reports.flatMap((report) => listOf(report.neededFields))),
        unverified_fields: unique(reports.flatMap((report) => listOf(report.unverifiedFields))),
        session_count: sessionCount,
      });
      if (outcome.dispatched) await this.client.agentGapCandidate.updateMany({ where: { id }, data: { dispatchedAt: new Date() } });
    } catch (error) {
      this.logger.warn(`缺口候选建单失败 candidate=${id}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

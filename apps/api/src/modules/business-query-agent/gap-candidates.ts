import type { PrismaClient } from "@prisma/client";
import type { AcceptedGap } from "./tools/gap-check";

export type GapCandidateStore = Pick<PrismaClient, "agentGapCandidate" | "agentGapReport">;

export type GapReportInput = { sessionId: string; runId: string; gap: AcceptedGap };

export class GapCandidateService {
  constructor(private readonly client: GapCandidateStore) {}

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
    return { candidateId: candidate.id, sessionCount: new Set(reports.map((report) => report.sessionId)).size };
  }
}

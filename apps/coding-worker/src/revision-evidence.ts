export interface CandidateRevisionEvidence {
  readonly capabilityId: string
  readonly codeHash: string
  readonly builderRunId: string
  readonly builderSessionId: string
}

export interface ValidationEvidence {
  readonly capabilityId: string
  readonly codeHash: string
  readonly decision: 'approved' | 'rejected'
  readonly validatorRunId: string
  readonly validatorSessionId: string
}

export type RevisionEvidenceDecision =
  | { readonly accepted: true }
  | {
    readonly accepted: false
    readonly reason:
      | 'validation-missing'
      | 'capability-mismatch'
      | 'revision-mismatch'
      | 'validation-rejected'
  }

export function evaluateRevisionEvidence(
  revision: CandidateRevisionEvidence,
  validation?: ValidationEvidence,
): RevisionEvidenceDecision {
  if (validation === undefined) return { accepted: false, reason: 'validation-missing' }
  if (validation.capabilityId !== revision.capabilityId) {
    return { accepted: false, reason: 'capability-mismatch' }
  }
  if (validation.codeHash !== revision.codeHash) {
    return { accepted: false, reason: 'revision-mismatch' }
  }
  if (validation.decision === 'rejected') {
    return { accepted: false, reason: 'validation-rejected' }
  }
  return { accepted: true }
}

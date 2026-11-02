import { freezeCandidateRevision, type FrozenCandidateRevision } from './candidate-revision.ts'
import { evaluateRevisionEvidence, type ValidationEvidence } from './revision-evidence.ts'

export interface IndependentGateInput {
  readonly sourceRevision: string
  readonly revision: FrozenCandidateRevision
  readonly validation: ValidationEvidence
}

export function freezeIndependentGateInput(input: {
  capabilityId: string
  candidateRoot: string
  frozenRoot: string
  sourceRevision: string
  builderRunId: string
  builderSessionId: string
  validation: ValidationEvidence
}): IndependentGateInput {
  if (!/^[a-f0-9]{40,64}$/u.test(input.sourceRevision)) throw new Error('INDEPENDENT_GATE_BASELINE_DENIED')
  const revision = freezeCandidateRevision(input)
  const decision = evaluateRevisionEvidence({
    capabilityId: input.capabilityId,
    codeHash: revision.codeHash,
    builderRunId: input.builderRunId,
    builderSessionId: input.builderSessionId,
  }, input.validation)
  if (!decision.accepted) throw new Error(`INDEPENDENT_GATE_EVIDENCE_DENIED: ${decision.reason}`)
  return { sourceRevision: input.sourceRevision, revision, validation: input.validation }
}

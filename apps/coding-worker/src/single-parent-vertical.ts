import { validateSingleParentCandidateBatch } from './single-parent-candidate-batch.ts'
import { timedActivationsFromTrace, verifySingleParentActivations } from './single-parent-activation.ts'
import type { CandidateBatchInput, CandidateGateEvidence } from './candidate-batch.ts'

export async function validateSingleParentVertical<T>(input: {
  readonly batchId: string
  readonly parentSessionId: string
  readonly trace: readonly { event: string; runId: string; at?: number; capabilityId?: string; role?: string }[]
  readonly candidates: readonly CandidateBatchInput<T>[]
}, validate: (candidate: CandidateBatchInput<T>) => Promise<CandidateGateEvidence>) {
  verifySingleParentActivations(timedActivationsFromTrace(input.trace))
  return validateSingleParentCandidateBatch(input, validate)
}

import { validateCandidateBatch, type CandidateBatchInput, type CandidateGateEvidence } from './candidate-batch.ts'

export async function validateSingleParentCandidateBatch<T>(input: {
  readonly batchId: string
  readonly parentSessionId: string
  readonly candidates: readonly CandidateBatchInput<T>[]
}, validate: (candidate: CandidateBatchInput<T>) => Promise<CandidateGateEvidence>): Promise<{
  readonly batchId: string
  readonly parentSessionId: string
  readonly candidates: CandidateBatchInput<T>[]
  readonly evidence: CandidateGateEvidence[]
}> {
  if (!input.batchId || !input.parentSessionId || input.candidates.length !== 2) {
    throw new TypeError('single parent batch requires identity and exactly two candidates')
  }
  const validated = await validateCandidateBatch(input.candidates, validate)
  return { batchId: input.batchId, parentSessionId: input.parentSessionId, ...validated }
}

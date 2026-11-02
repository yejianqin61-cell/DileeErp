export interface CandidateBatchInput<TCandidate> {
  readonly capabilityId: string
  readonly candidate: TCandidate
  readonly manifestHash: string
}

export interface CandidateGateEvidence {
  readonly accepted: boolean
  readonly capabilityId: string
  readonly manifestHash: string
}

export interface CandidateBatchFailure {
  readonly capabilityId: string
  readonly reason: unknown
}

export class CandidateBatchError extends Error {
  readonly failures: CandidateBatchFailure[]

  constructor(failures: CandidateBatchFailure[]) {
    super(`candidate batch rejected: ${failures.map(item => item.capabilityId).join(', ')}`)
    this.name = 'CandidateBatchError'
    this.failures = failures
  }
}

export interface ValidatedCandidateBatch<TCandidate> {
  readonly candidates: CandidateBatchInput<TCandidate>[]
  readonly evidence: CandidateGateEvidence[]
}

export async function validateCandidateBatch<TCandidate>(
  candidates: readonly CandidateBatchInput<TCandidate>[],
  validate: (candidate: CandidateBatchInput<TCandidate>) => Promise<CandidateGateEvidence>,
): Promise<ValidatedCandidateBatch<TCandidate>> {
  if (candidates.length === 0) throw new TypeError('candidate batch must contain at least one item')
  const ids = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate.capabilityId || ids.has(candidate.capabilityId)) {
      throw new TypeError(`duplicate capabilityId: ${candidate.capabilityId}`)
    }
    ids.add(candidate.capabilityId)
    if (!candidate.manifestHash) throw new TypeError(`manifest hash is required for ${candidate.capabilityId}`)
  }

  const settled = await Promise.allSettled(candidates.map(candidate =>
    Promise.resolve().then(() => validate(candidate))))
  const evidence: CandidateGateEvidence[] = []
  const failures: CandidateBatchFailure[] = []
  settled.forEach((result, index) => {
    const candidate = candidates[index]!
    if (result.status === 'rejected') {
      failures.push({ capabilityId: candidate.capabilityId, reason: result.reason })
    } else if (!result.value.accepted) {
      failures.push({ capabilityId: candidate.capabilityId, reason: 'independent gate rejected candidate' })
    } else if (result.value.capabilityId !== candidate.capabilityId) {
      failures.push({ capabilityId: candidate.capabilityId, reason: 'gate capability ID mismatch' })
    } else if (result.value.manifestHash !== candidate.manifestHash) {
      failures.push({ capabilityId: candidate.capabilityId, reason: 'gate manifest hash mismatch' })
    } else {
      evidence.push(result.value)
    }
  })
  if (failures.length > 0) throw new CandidateBatchError(failures)
  return { candidates: [...candidates], evidence }
}

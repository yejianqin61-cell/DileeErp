export type JobPolicyErrorCode =
  | 'activation-failed'
  | 'activation-in-progress'
  | 'builder-not-complete'
  | 'builder-session-mismatch'
  | 'capabilities-already-declared'
  | 'capabilities-not-declared'
  | 'capability-not-approved'
  | 'invalid-capability-id'
  | 'invalid-code-hash'
  | 'invalid-rework-budget'
  | 'job-already-submitted'
  | 'rework-budget-exhausted'
  | 'rework-not-allowed'
  | 'revision-mismatch'
  | 'revision-not-advanced'
  | 'unknown-capability'
  | 'validation-not-complete'

export class JobPolicyError extends Error {
  constructor(readonly code: JobPolicyErrorCode) {
    super(code)
    this.name = 'JobPolicyError'
  }
}

export type ActivationStopReason = 'completed' | 'error' | 'aborted'
export type ValidationDecision = 'approved' | 'rejected'

type CapabilityStage =
  | 'declared'
  | 'building'
  | 'built'
  | 'validating'
  | 'validation-complete'
  | 'validated'
  | 'failed'

interface CapabilityState {
  readonly capabilityId: string
  stage: CapabilityStage
  reworks: number
  builderSessionId?: string
  validatorSessionId?: string
  currentHash?: string
  lastRejectedHash?: string
  validationDecision?: ValidationDecision
}

export interface CodingJobPolicyOptions {
  readonly maxReworks: number
}

export interface CandidateSubmission {
  readonly capabilities: ReadonlyArray<{
    readonly capabilityId: string
    readonly codeHash: string
  }>
}

const capabilityIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const sha256Pattern = /^[a-f0-9]{64}$/

export class CodingJobPolicy {
  private readonly capabilities = new Map<string, CapabilityState>()
  private submitted = false

  constructor(private readonly options: CodingJobPolicyOptions) {
    if (!Number.isSafeInteger(options.maxReworks) || options.maxReworks < 0) {
      throw new JobPolicyError('invalid-rework-budget')
    }
  }

  declareCapabilities(capabilityIds: readonly string[]): void {
    if (this.capabilities.size > 0) throw new JobPolicyError('capabilities-already-declared')
    if (capabilityIds.length === 0 || new Set(capabilityIds).size !== capabilityIds.length
      || capabilityIds.some(capabilityId => !capabilityIdPattern.test(capabilityId))) {
      throw new JobPolicyError('invalid-capability-id')
    }
    for (const capabilityId of capabilityIds) {
      this.capabilities.set(capabilityId, { capabilityId, stage: 'declared', reworks: 0 })
    }
  }

  beginBuild(capabilityId: string): void {
    const state = this.capability(capabilityId)
    if (state.stage !== 'declared') throw new JobPolicyError('activation-in-progress')
    state.stage = 'building'
  }

  finishBuild(
    capabilityId: string,
    builderSessionId: string,
    stopReason: ActivationStopReason,
  ): void {
    const state = this.capability(capabilityId)
    if (state.stage !== 'building') throw new JobPolicyError('builder-not-complete')
    if (state.builderSessionId !== undefined && state.builderSessionId !== builderSessionId) {
      throw new JobPolicyError('builder-session-mismatch')
    }
    state.builderSessionId ??= builderSessionId
    state.stage = stopReason === 'completed' ? 'built' : 'failed'
  }

  beginValidation(capabilityId: string, codeHash: string): void {
    const state = this.capability(capabilityId)
    if (state.stage !== 'built') throw new JobPolicyError('builder-not-complete')
    if (!sha256Pattern.test(codeHash)) throw new JobPolicyError('invalid-code-hash')
    if (state.lastRejectedHash === codeHash) throw new JobPolicyError('revision-not-advanced')
    state.currentHash = codeHash
    state.validationDecision = undefined
    state.validatorSessionId = undefined
    state.stage = 'validating'
  }

  finishValidation(
    capabilityId: string,
    validatorSessionId: string,
    stopReason: ActivationStopReason,
  ): void {
    const state = this.capability(capabilityId)
    if (state.stage !== 'validating') throw new JobPolicyError('validation-not-complete')
    state.validatorSessionId = validatorSessionId
    state.stage = stopReason === 'completed' ? 'validation-complete' : 'failed'
  }

  recordValidation(
    capabilityId: string,
    codeHash: string,
    decision: ValidationDecision,
  ): void {
    const state = this.capability(capabilityId)
    if (state.stage !== 'validation-complete') throw new JobPolicyError('validation-not-complete')
    if (state.currentHash !== codeHash) throw new JobPolicyError('revision-mismatch')
    state.validationDecision = decision
    if (decision === 'rejected') state.lastRejectedHash = codeHash
    state.stage = 'validated'
  }

  beginRework(capabilityId: string): string {
    const state = this.capability(capabilityId)
    if (state.stage !== 'validated' || state.validationDecision !== 'rejected'
      || state.builderSessionId === undefined) {
      throw new JobPolicyError('rework-not-allowed')
    }
    if (state.reworks >= this.options.maxReworks) {
      throw new JobPolicyError('rework-budget-exhausted')
    }
    state.reworks++
    state.stage = 'building'
    return state.builderSessionId
  }

  submitCandidate(): CandidateSubmission {
    this.assertDeclared()
    if (this.submitted) throw new JobPolicyError('job-already-submitted')
    const capabilities = [...this.capabilities.values()].map((state) => {
      if (state.stage !== 'validated' || state.validationDecision !== 'approved'
        || state.currentHash === undefined) {
        throw new JobPolicyError('capability-not-approved')
      }
      return { capabilityId: state.capabilityId, codeHash: state.currentHash }
    })
    this.submitted = true
    return { capabilities }
  }

  private assertDeclared(): void {
    if (this.capabilities.size === 0) throw new JobPolicyError('capabilities-not-declared')
  }

  private capability(capabilityId: string): CapabilityState {
    this.assertDeclared()
    const state = this.capabilities.get(capabilityId)
    if (state === undefined) throw new JobPolicyError('unknown-capability')
    return state
  }
}

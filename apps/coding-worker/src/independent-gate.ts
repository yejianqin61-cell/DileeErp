import { freezeCandidateRevision, type FrozenCandidateRevision } from './candidate-revision.ts'
import { evaluateRevisionEvidence, type ValidationEvidence } from './revision-evidence.ts'
import { runOrderACandidateInLinux } from './order-a-candidate-slice.ts'
import { createHash } from 'node:crypto'

export interface IndependentGateInput {
  readonly sourceRevision: string
  readonly revision: FrozenCandidateRevision
  readonly validation: ValidationEvidence
  readonly validatorReportHash: string
}

export function freezeIndependentGateInput(input: {
  capabilityId: string
  candidateRoot: string
  frozenRoot: string
  sourceRevision: string
  builderRunId: string
  builderSessionId: string
  validation: ValidationEvidence
  validatorReport: string
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
  const validatorReportHash = createHash('sha256').update(input.validatorReport).digest('hex')
  if (input.validation.reportHash !== validatorReportHash) throw new Error('INDEPENDENT_GATE_REPORT_DENIED')
  return { sourceRevision: input.sourceRevision, revision, validation: input.validation, validatorReportHash }
}

export function verifyFrozenOrderACandidate(input: IndependentGateInput, options: {
  repositoryRoot: string
  dockerExecutable?: string
}): { readonly codeHash: string; readonly testsPassed: true; readonly permissionsPassed: true } {
  const result = runOrderACandidateInLinux({
    repositoryRoot: options.repositoryRoot,
    candidateRoot: input.revision.root,
    sourceRevision: input.sourceRevision,
    dockerExecutable: options.dockerExecutable,
  })
  const totals = result.fact.data.employee_totals
  if (totals.length !== 2 || totals[0]?.quantity !== '20.0000' || totals[1]?.quantity !== '5.0000') {
    throw new Error('INDEPENDENT_GATE_TEST_FAILED')
  }
  if (!result.sourceReadable || !result.sourceWriteDenied || !result.candidateWriteDenied
    || !result.networkDenied || !result.databaseCredentialAbsent || !result.generatedTestPassed) {
    throw new Error('INDEPENDENT_GATE_PERMISSION_FAILED')
  }
  return { codeHash: input.revision.codeHash, testsPassed: true, permissionsPassed: true }
}

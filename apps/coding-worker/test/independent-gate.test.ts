import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { freezeIndependentGateInput, verifyFrozenOrderACandidate } from '../src/independent-gate.ts'
import { freezeCandidateRevision } from '../src/candidate-revision.ts'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const linux = spawnSync('docker', ['info', '--format', '{{.OSType}}'], { encoding: 'utf8', windowsHide: true }).stdout.trim() === 'linux'
const validatorReport = '{"decision":"approved","tests":"adversarial"}'
const validatorReportHash = createHash('sha256').update(validatorReport).digest('hex')

test('freezes the approved revision before an independent gate reads it', () => {
  const root = mkdtempSync(join(tmpdir(), 'dilee-independent-gate-'))
  const candidate = join(root, 'candidate')
  const frozen = join(root, 'frozen')
  try {
    mkdirSync(candidate)
    writeFileSync(join(candidate, 'tool.ts'), 'export const tool = 1\n')
    writeFileSync(join(candidate, 'tool.test.ts'), 'export {}\n')
    const preview = freezeCandidateRevision({ capabilityId: 'employee-output', candidateRoot: candidate, frozenRoot: join(root, 'preview') })
    const input = freezeIndependentGateInput({
      capabilityId: 'employee-output', candidateRoot: candidate, frozenRoot: frozen,
      sourceRevision: 'a'.repeat(40), builderRunId: 'builder-run', builderSessionId: 'builder-session',
      validation: { capabilityId: 'employee-output', codeHash: preview.codeHash, decision: 'approved', validatorRunId: 'validator-run', validatorSessionId: 'validator-session', reviewedBuilderRunId: 'builder-run', reviewedBuilderSessionId: 'builder-session', reportHash: validatorReportHash }, validatorReport,
    })
    writeFileSync(join(candidate, 'tool.ts'), 'export const tool = 2\n')
    assert.match(input.revision.codeHash, /^[a-f0-9]{64}$/)
    assert.equal(input.validation.codeHash, input.revision.codeHash)
    assert.match(readFileSync(join(frozen, 'tool.ts'), 'utf8'), /tool = 1/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('independently reruns the frozen order A candidate in an offline Linux container', { skip: linux ? false : 'Docker Linux engine is not available', timeout: 180_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dilee-independent-gate-order-a-'))
  const candidate = join(root, 'candidate')
  try {
    mkdirSync(candidate)
    copyFileSync(join(repositoryRoot, 'apps/coding-worker/candidate/order-a-output/tool.ts'), join(candidate, 'tool.ts'))
    copyFileSync(join(repositoryRoot, 'apps/coding-worker/candidate/order-a-output/tool.test.ts'), join(candidate, 'tool.test.ts'))
    const preview = freezeCandidateRevision({ capabilityId: 'employee-output', candidateRoot: candidate, frozenRoot: join(root, 'preview') })
    const input = freezeIndependentGateInput({
      capabilityId: 'employee-output', candidateRoot: candidate, frozenRoot: join(root, 'frozen'),
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(), builderRunId: 'builder', builderSessionId: 'builder-session',
      validation: { capabilityId: 'employee-output', codeHash: preview.codeHash, decision: 'approved', validatorRunId: 'validator', validatorSessionId: 'validator-session', reviewedBuilderRunId: 'builder', reviewedBuilderSessionId: 'builder-session', reportHash: validatorReportHash }, validatorReport,
    })
    assert.deepEqual(verifyFrozenOrderACandidate(input, { repositoryRoot }), { codeHash: input.revision.codeHash, testsPassed: true, permissionsPassed: true })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('rejects evidence that is not bound to the frozen revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'dilee-independent-gate-'))
  const candidate = join(root, 'candidate')
  try {
    mkdirSync(candidate); writeFileSync(join(candidate, 'tool.ts'), 'export {}\n'); writeFileSync(join(candidate, 'tool.test.ts'), 'export {}\n')
    assert.throws(() => freezeIndependentGateInput({
      capabilityId: 'employee-output', candidateRoot: candidate, frozenRoot: join(root, 'frozen'),
      sourceRevision: 'a'.repeat(40), builderRunId: 'builder-run', builderSessionId: 'builder-session',
      validation: { capabilityId: 'other', codeHash: 'x', decision: 'approved', validatorRunId: 'v', validatorSessionId: 'v', reviewedBuilderRunId: 'builder-run', reviewedBuilderSessionId: 'builder-session', reportHash: validatorReportHash }, validatorReport,
    }), /INDEPENDENT_GATE_EVIDENCE_DENIED/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('rejects a Validator report whose bytes differ from its recorded hash', () => {
  const root = mkdtempSync(join(tmpdir(), 'dilee-independent-gate-'))
  const candidate = join(root, 'candidate')
  try {
    mkdirSync(candidate); writeFileSync(join(candidate, 'tool.ts'), 'export {}\n'); writeFileSync(join(candidate, 'tool.test.ts'), 'export {}\n')
    const preview = freezeCandidateRevision({ capabilityId: 'employee-output', candidateRoot: candidate, frozenRoot: join(root, 'preview') })
    assert.throws(() => freezeIndependentGateInput({
      capabilityId: 'employee-output', candidateRoot: candidate, frozenRoot: join(root, 'frozen'), sourceRevision: 'a'.repeat(40), builderRunId: 'builder', builderSessionId: 'session', validatorReport: `${validatorReport} altered`,
      validation: { capabilityId: 'employee-output', codeHash: preview.codeHash, decision: 'approved', validatorRunId: 'validator', validatorSessionId: 'validator-session', reviewedBuilderRunId: 'builder', reviewedBuilderSessionId: 'session', reportHash: validatorReportHash },
    }), /INDEPENDENT_GATE_REPORT_DENIED/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('does not accept a candidate whose generated test fails in the independent container', { skip: linux ? false : 'Docker Linux engine is not available', timeout: 180_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dilee-independent-gate-failing-test-'))
  const candidate = join(root, 'candidate')
  try {
    mkdirSync(candidate)
    copyFileSync(join(repositoryRoot, 'apps/coding-worker/candidate/order-a-output/tool.ts'), join(candidate, 'tool.ts'))
    writeFileSync(join(candidate, 'tool.test.ts'), 'throw new Error("generated test failed")\n')
    const preview = freezeCandidateRevision({ capabilityId: 'employee-output', candidateRoot: candidate, frozenRoot: join(root, 'preview') })
    const input = freezeIndependentGateInput({
      capabilityId: 'employee-output', candidateRoot: candidate, frozenRoot: join(root, 'frozen'),
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(), builderRunId: 'builder', builderSessionId: 'builder-session', validatorReport,
      validation: { capabilityId: 'employee-output', codeHash: preview.codeHash, decision: 'approved', validatorRunId: 'validator', validatorSessionId: 'validator-session', reviewedBuilderRunId: 'builder', reviewedBuilderSessionId: 'builder-session', reportHash: validatorReportHash },
    })
    assert.throws(() => verifyFrozenOrderACandidate(input, { repositoryRoot }), /ORDER_A_CANDIDATE_LINUX_RUN_FAILED/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

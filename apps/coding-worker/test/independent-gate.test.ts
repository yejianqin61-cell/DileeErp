import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { freezeIndependentGateInput } from '../src/independent-gate.ts'
import { freezeCandidateRevision } from '../src/candidate-revision.ts'

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
      validation: { capabilityId: 'employee-output', codeHash: preview.codeHash, decision: 'approved', validatorRunId: 'validator-run', validatorSessionId: 'validator-session', reviewedBuilderRunId: 'builder-run', reviewedBuilderSessionId: 'builder-session' },
    })
    writeFileSync(join(candidate, 'tool.ts'), 'export const tool = 2\n')
    assert.match(input.revision.codeHash, /^[a-f0-9]{64}$/)
    assert.equal(input.validation.codeHash, input.revision.codeHash)
    assert.match(readFileSync(join(frozen, 'tool.ts'), 'utf8'), /tool = 1/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('rejects evidence that is not bound to the frozen revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'dilee-independent-gate-'))
  const candidate = join(root, 'candidate')
  try {
    mkdirSync(candidate); writeFileSync(join(candidate, 'tool.ts'), 'export {}\n')
    assert.throws(() => freezeIndependentGateInput({
      capabilityId: 'employee-output', candidateRoot: candidate, frozenRoot: join(root, 'frozen'),
      sourceRevision: 'a'.repeat(40), builderRunId: 'builder-run', builderSessionId: 'builder-session',
      validation: { capabilityId: 'other', codeHash: 'x', decision: 'approved', validatorRunId: 'v', validatorSessionId: 'v', reviewedBuilderRunId: 'builder-run', reviewedBuilderSessionId: 'builder-session' },
    }), /INDEPENDENT_GATE_EVIDENCE_DENIED/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

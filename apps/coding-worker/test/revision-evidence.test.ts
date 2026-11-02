import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateRevisionEvidence } from '../src/revision-evidence.ts'

const h1 = '1'.repeat(64)
const h2 = '2'.repeat(64)

const revision = (capabilityId: string, codeHash: string) => ({
  capabilityId,
  codeHash,
  builderRunId: 'builder-run',
  builderSessionId: 'builder-session',
})

const validation = (
  capabilityId: string,
  codeHash: string,
  decision: 'approved' | 'rejected',
) => ({
  capabilityId,
  codeHash,
  decision,
  validatorRunId: 'validator-run',
  validatorSessionId: 'validator-session',
  reviewedBuilderRunId: 'builder-run',
  reviewedBuilderSessionId: 'builder-session',
})

test('rejects evidence that reviewed another Builder session', () => {
  assert.deepEqual(
    evaluateRevisionEvidence(revision('packaging-output', h2), {
      ...validation('packaging-output', h2, 'approved'),
      reviewedBuilderSessionId: 'older-builder-session',
    }),
    { accepted: false, reason: 'builder-session-mismatch' },
  )
})

test('rejects a validation rejection for the current revision', () => {
  assert.deepEqual(
    evaluateRevisionEvidence(revision('packaging-output', h1), validation('packaging-output', h1, 'rejected')),
    { accepted: false, reason: 'validation-rejected' },
  )
})

test('rejects approval evidence from an older revision', () => {
  assert.deepEqual(
    evaluateRevisionEvidence(revision('packaging-output', h2), validation('packaging-output', h1, 'approved')),
    { accepted: false, reason: 'revision-mismatch' },
  )
})

test('rejects approval evidence from another capability', () => {
  assert.deepEqual(
    evaluateRevisionEvidence(revision('employee-output', h2), validation('packaging-output', h2, 'approved')),
    { accepted: false, reason: 'capability-mismatch' },
  )
})

test('accepts approval evidence for the current capability and revision', () => {
  assert.deepEqual(
    evaluateRevisionEvidence(revision('packaging-output', h2), validation('packaging-output', h2, 'approved')),
    { accepted: true },
  )
})

test('rejects a revision without validation evidence', () => {
  assert.deepEqual(
    evaluateRevisionEvidence(revision('packaging-output', h2)),
    { accepted: false, reason: 'validation-missing' },
  )
})

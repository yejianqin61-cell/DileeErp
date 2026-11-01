import assert from 'node:assert/strict'
import test from 'node:test'

import { CodingJobPolicy, JobPolicyError } from '../src/job-policy.ts'

const capabilityId = 'packaging-output'
const h1 = '1'.repeat(64)
const h2 = '2'.repeat(64)

function assertPolicyError(action: () => unknown, code: string): void {
  assert.throws(action, error => error instanceof JobPolicyError && error.code === code)
}

function completeBuild(policy: CodingJobPolicy, builderSessionId = 'builder-1'): void {
  policy.finishBuild(capabilityId, builderSessionId, 'completed')
}

function completeValidation(
  policy: CodingJobPolicy,
  codeHash: string,
  decision: 'approved' | 'rejected',
): void {
  policy.finishValidation(capabilityId, 'validator-1', 'completed')
  policy.recordValidation(capabilityId, codeHash, decision)
}

test('rejects validation before capabilities are declared', () => {
  const policy = new CodingJobPolicy({ maxReworks: 1 })

  assertPolicyError(() => policy.beginValidation(capabilityId, h1), 'capabilities-not-declared')
})

test('rejects validation before Builder completes', () => {
  const policy = new CodingJobPolicy({ maxReworks: 1 })
  policy.declareCapabilities([capabilityId])

  assertPolicyError(() => policy.beginValidation(capabilityId, h1), 'builder-not-complete')
})

test('requires a new revision after Validator rejects h1', () => {
  const policy = new CodingJobPolicy({ maxReworks: 1 })
  policy.declareCapabilities([capabilityId])
  policy.beginBuild(capabilityId)
  completeBuild(policy)
  policy.beginValidation(capabilityId, h1)
  completeValidation(policy, h1, 'rejected')
  policy.beginRework(capabilityId)
  completeBuild(policy)

  assertPolicyError(() => policy.beginValidation(capabilityId, h1), 'revision-not-advanced')
})

test('rejects rework beyond the configured budget', () => {
  const policy = new CodingJobPolicy({ maxReworks: 1 })
  policy.declareCapabilities([capabilityId])
  policy.beginBuild(capabilityId)
  completeBuild(policy)
  policy.beginValidation(capabilityId, h1)
  completeValidation(policy, h1, 'rejected')
  policy.beginRework(capabilityId)
  completeBuild(policy)
  policy.beginValidation(capabilityId, h2)
  completeValidation(policy, h2, 'rejected')

  assertPolicyError(() => policy.beginRework(capabilityId), 'rework-budget-exhausted')
})

test('submits only the latest approved revision', () => {
  const policy = new CodingJobPolicy({ maxReworks: 1 })
  policy.declareCapabilities([capabilityId])
  policy.beginBuild(capabilityId)
  completeBuild(policy)
  policy.beginValidation(capabilityId, h1)
  completeValidation(policy, h1, 'rejected')
  policy.beginRework(capabilityId)
  completeBuild(policy)
  policy.beginValidation(capabilityId, h2)
  completeValidation(policy, h2, 'approved')

  assert.deepEqual(policy.submitCandidate(), {
    capabilities: [{ capabilityId, codeHash: h2 }],
  })
})

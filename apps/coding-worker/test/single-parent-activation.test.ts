import assert from 'node:assert/strict'
import test from 'node:test'
import { verifySingleParentActivations } from '../src/single-parent-activation.ts'

const valid = [
  { capabilityId: 'output', role: 'builder' as const, runId: 'b1', startedAt: 10, endedAt: 30 },
  { capabilityId: 'inventory', role: 'builder' as const, runId: 'b2', startedAt: 20, endedAt: 40 },
  { capabilityId: 'output', role: 'validator' as const, runId: 'v1', startedAt: 31, endedAt: 35 },
  { capabilityId: 'inventory', role: 'validator' as const, runId: 'v2', startedAt: 41, endedAt: 45 },
]

test('accepts two overlapping Builders and validators after their own builders', () => assert.doesNotThrow(() => verifySingleParentActivations(valid)))
test('rejects non-overlapping Builders and early validators', () => {
  assert.throws(() => verifySingleParentActivations([{ ...valid[0]!, endedAt: 20 }, ...valid.slice(1)]), /NOT_OVERLAPPED/)
  assert.throws(() => verifySingleParentActivations([{ ...valid[0]! }, { ...valid[1]! }, { ...valid[2]!, startedAt: 29 }, valid[3]!]), /VALIDATOR_ORDER/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { timedActivationsFromTrace, verifySingleParentActivations } from '../src/single-parent-activation.ts'

const valid = [
  { capabilityId: 'output', role: 'builder' as const, runId: 'b1', startedAt: 10, endedAt: 30 },
  { capabilityId: 'inventory', role: 'builder' as const, runId: 'b2', startedAt: 20, endedAt: 40 },
  { capabilityId: 'output', role: 'validator' as const, runId: 'v1', startedAt: 31, endedAt: 35 },
  { capabilityId: 'inventory', role: 'validator' as const, runId: 'v2', startedAt: 41, endedAt: 45 },
]

test('accepts two overlapping Builders and validators after their own builders', () => assert.doesNotThrow(() => verifySingleParentActivations(valid)))
test('accepts a bounded Builder rework and its follow-up Validator', () => assert.doesNotThrow(() => verifySingleParentActivations([
  ...valid,
  { capabilityId: 'inventory', role: 'builder', runId: 'b3', startedAt: 50, endedAt: 60 },
  { capabilityId: 'inventory', role: 'validator', runId: 'v3', startedAt: 61, endedAt: 65 },
])))
test('rejects non-overlapping Builders and early validators', () => {
  assert.throws(() => verifySingleParentActivations([{ ...valid[0]!, endedAt: 20 }, ...valid.slice(1)]), /NOT_OVERLAPPED/)
  assert.throws(() => verifySingleParentActivations([{ ...valid[0]! }, { ...valid[1]! }, { ...valid[2]!, startedAt: 29 }, valid[3]!]), /VALIDATOR_ORDER/)
})
test('joins trace metadata to the actual Activation intervals', () => {
  const records = valid.flatMap((item, index) => [
    { event: 'start', runId: item.runId, at: item.startedAt },
    { event: 'meta', runId: item.runId, capabilityId: item.capabilityId, role: item.role },
    { event: 'end', runId: item.runId, at: item.endedAt },
  ])
  assert.deepEqual(timedActivationsFromTrace(records), valid)
  assert.throws(() => timedActivationsFromTrace(records.filter(record => record.runId !== 'b1' || record.event !== 'meta')), /TRACE_INCOMPLETE/)
})

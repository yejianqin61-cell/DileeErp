import assert from 'node:assert/strict'
import test from 'node:test'
import { validateSingleParentVertical } from '../src/single-parent-vertical.ts'

const trace = [
  ['b1', 'start', 10], ['b1', 'meta', 11, 'output', 'builder'], ['b2', 'start', 20], ['b2', 'meta', 21, 'inventory', 'builder'], ['b1', 'end', 30], ['v1', 'start', 31], ['v1', 'meta', 32, 'output', 'validator'], ['v1', 'end', 35], ['b2', 'end', 40], ['v2', 'start', 41], ['v2', 'meta', 42, 'inventory', 'validator'], ['v2', 'end', 45],
].map(([runId, event, at, capabilityId, role]) => ({ runId: runId as string, event: event as string, at: at as number, capabilityId: capabilityId as string | undefined, role: role as string | undefined }))
const candidates = [{ capabilityId: 'output', candidate: 'a', manifestHash: 'ha' }, { capabilityId: 'inventory', candidate: 'b', manifestHash: 'hb' }]
test('returns a whole batch only after real-shaped trace and both gates pass', async () => {
  const result = await validateSingleParentVertical({ batchId: 'batch', parentSessionId: 'parent', trace, candidates }, async item => ({ accepted: true, capabilityId: item.capabilityId, manifestHash: item.manifestHash }))
  assert.equal(result.candidates.length, 2)
})
test('refuses candidate validation when trace cannot prove overlapping builders', async () => {
  await assert.rejects(validateSingleParentVertical({ batchId: 'batch', parentSessionId: 'parent', trace: trace.map(item => item.runId === 'b1' && item.event === 'end' ? { ...item, at: 20 } : item), candidates }, async item => ({ accepted: true, capabilityId: item.capabilityId, manifestHash: item.manifestHash })), /NOT_OVERLAPPED/)
})

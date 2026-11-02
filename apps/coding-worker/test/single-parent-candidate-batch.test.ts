import assert from 'node:assert/strict'
import test from 'node:test'
import { validateSingleParentCandidateBatch } from '../src/single-parent-candidate-batch.ts'

const candidates = [{ capabilityId: 'output', candidate: 'a', manifestHash: 'ha' }, { capabilityId: 'inventory', candidate: 'b', manifestHash: 'hb' }]
test('returns both candidates only with the shared parent batch identity', async () => {
  const result = await validateSingleParentCandidateBatch({ batchId: 'batch', parentSessionId: 'parent', candidates }, async item => ({ accepted: true, capabilityId: item.capabilityId, manifestHash: item.manifestHash }))
  assert.equal(result.batchId, 'batch'); assert.equal(result.parentSessionId, 'parent'); assert.equal(result.candidates.length, 2)
})
test('does not return a partial set when one candidate fails', async () => {
  await assert.rejects(validateSingleParentCandidateBatch({ batchId: 'batch', parentSessionId: 'parent', candidates }, async item => {
    if (item.capabilityId === 'inventory') throw new Error('denied')
    return { accepted: true, capabilityId: item.capabilityId, manifestHash: item.manifestHash }
  }), /candidate batch rejected/)
  await assert.rejects(validateSingleParentCandidateBatch({ batchId: 'batch', parentSessionId: 'parent', candidates: [candidates[0]!] }, async item => ({ accepted: true, capabilityId: item.capabilityId, manifestHash: item.manifestHash })), /exactly two/)
})

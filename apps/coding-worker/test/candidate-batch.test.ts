import assert from 'node:assert/strict'
import test from 'node:test'

import {
  validateCandidateBatch,
  type CandidateBatchInput,
} from '../src/candidate-batch.ts'

const items: CandidateBatchInput<string>[] = [
  { capabilityId: 'output', candidate: 'output-candidate', manifestHash: 'hash-output' },
  { capabilityId: 'inventory', candidate: 'inventory-candidate', manifestHash: 'hash-inventory' },
]

test('returns all candidates only when each independent gate accepts its bound hash', async () => {
  const result = await validateCandidateBatch(items, async item => ({
    accepted: true,
    capabilityId: item.capabilityId,
    manifestHash: item.manifestHash,
  }))

  assert.deepEqual(result.candidates, items)
  assert.equal(result.evidence.length, 2)
})

test('withholds every candidate when any capability gate fails', async () => {
  await assert.rejects(validateCandidateBatch(items, async item => {
    if (item.capabilityId === 'inventory') throw new Error('permission test failed')
    return { accepted: true, capabilityId: item.capabilityId, manifestHash: item.manifestHash }
  }), error => {
    assert.equal((error as Error).name, 'CandidateBatchError')
    assert.match((error as Error).message, /inventory/)
    assert.equal('candidates' in (error as object), false)
    return true
  })
})

test('rejects gate evidence bound to a different capability or manifest hash', async () => {
  await assert.rejects(validateCandidateBatch(items, async item => ({
    accepted: true,
    capabilityId: item.capabilityId,
    manifestHash: 'stale-hash',
  })), error => {
    assert.equal((error as Error).name, 'CandidateBatchError')
    assert.ok('failures' in (error as object))
    assert.match(JSON.stringify((error as { failures: unknown }).failures), /gate manifest hash mismatch/)
    return true
  })
})

test('rejects empty batches and duplicate capability IDs', async () => {
  const gate = async (item: CandidateBatchInput<string>) => ({
    accepted: true as const,
    capabilityId: item.capabilityId,
    manifestHash: item.manifestHash,
  })
  await assert.rejects(validateCandidateBatch([], gate), /at least one/)
  await assert.rejects(validateCandidateBatch([items[0]!, items[0]!], gate), /duplicate capabilityId/)
})

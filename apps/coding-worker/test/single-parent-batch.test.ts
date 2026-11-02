import assert from 'node:assert/strict'
import test from 'node:test'
import type { CodingRuntimeFactory } from '../src/runtime-lifecycle.ts'
import { runSingleParentBatch } from '../src/single-parent-batch.ts'

test('uses one runtime and one parent session for two distinct capabilities', async () => {
  let runtimes = 0; let sessionId = ''
  const factory: CodingRuntimeFactory = () => {
    runtimes++
    return { start: async () => undefined, run: async (_prompt, options) => { sessionId = options?.sessionId ?? ''; return { sessionId, finalResponse: 'done', events: [], notifications: [] } }, client: { request: async () => ({}) }, close: async () => undefined }
  }
  const result = await runSingleParentBatch({ workspace: 'C:\\candidate', dshHome: 'C:\\home', patches: [], environment: {} }, { batchId: 'batch', parentSessionId: 'parent', capabilities: [{ capabilityId: 'output', prompt: 'build output' }, { capabilityId: 'inventory', prompt: 'build inventory' }] }, factory)
  assert.equal(runtimes, 1); assert.equal(sessionId, 'parent'); assert.equal(result.parentSessionId, 'parent')
})

test('rejects missing or duplicate capabilities before starting a runtime', async () => {
  const config = { workspace: 'C:\\candidate', dshHome: 'C:\\home', patches: [], environment: {} }
  await assert.rejects(runSingleParentBatch(config, { batchId: 'batch', parentSessionId: 'parent', capabilities: [] }), /exactly two/)
  await assert.rejects(runSingleParentBatch(config, { batchId: 'batch', parentSessionId: 'parent', capabilities: [{ capabilityId: 'same', prompt: 'a' }, { capabilityId: 'same', prompt: 'b' }] }), /distinct/)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeBatchProgressEvents } from '../src/batch-progress-events.ts'

const context = {
  batchId: 'batch-7',
  capabilityId: 'employee-output',
  attemptId: 'attempt-2',
  round: 3,
}

test('normalizes SDK and Activation records with batch identity and source', () => {
  const events = normalizeBatchProgressEvents(context, {
    sdkEvents: [{ type: 'assistant.message', text: 'building' }],
    notifications: [{ method: 'session/updated', params: { status: 'running' } }],
    activations: [{
      seq: 1,
      event: 'start',
      runId: 'run-1',
      childSessionId: 'child-1',
      provider: 'test',
      local: true,
    }],
  })

  assert.deepEqual(events.map(event => [
    event.batchId,
    event.capabilityId,
    event.attemptId,
    event.round,
    event.seq,
    event.source,
  ]), [
    ['batch-7', 'employee-output', 'attempt-2', 3, 1, 'sdk-event'],
    ['batch-7', 'employee-output', 'attempt-2', 3, 2, 'sdk-notification'],
    ['batch-7', 'employee-output', 'attempt-2', 3, 3, 'activation'],
  ])
  assert.deepEqual(events[1]?.payload, { method: 'session/updated', params: { status: 'running' } })
})

test('keeps identical notifications as separate sequenced observations', () => {
  const notification = { method: 'session/updated', params: { status: 'running' } }
  const events = normalizeBatchProgressEvents(context, {
    sdkEvents: [],
    notifications: [notification, notification],
    activations: [],
  })

  assert.deepEqual(events.map(event => event.seq), [1, 2])
})

test('rejects invalid context and malformed Activation records', () => {
  assert.throws(() => normalizeBatchProgressEvents({ ...context, round: 0 }, {
    sdkEvents: [], notifications: [], activations: [],
  }), /round/)
  assert.throws(() => normalizeBatchProgressEvents(context, {
    sdkEvents: [], notifications: [], activations: [{ seq: 2 }],
  }), /Activation/)
})

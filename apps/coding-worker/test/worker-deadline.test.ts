import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import type { RunResult } from '@deepseek-ai/dsh-sdk-client'

import {
  CodingBatchTimeoutError,
  runCodingBatch,
  type CodingRuntime,
} from '../src/runtime-lifecycle.ts'

const request = {
  workspace: 'C:\\workspace',
  dshHome: 'C:\\dsh-home',
  patches: ['C:\\profile.patch.yml'],
  environment: { PATH: 'C:\\bin' },
  batchId: 'deadline-batch',
  parentSessionId: 'deadline-parent',
  prompt: 'build',
  deadlineMs: 10,
}

const runResult: RunResult = {
  sessionId: request.parentSessionId,
  finalResponse: '',
  events: [],
  notifications: [],
}

function runtime(overrides: Partial<CodingRuntime> = {}): CodingRuntime {
  return {
    start: async () => undefined,
    run: async () => runResult,
    client: { request: async () => ({}) },
    close: async () => undefined,
    ...overrides,
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof CodingBatchTimeoutError
    && error.code === 'CODING_BATCH_TIMEOUT'
    && error.batchId === request.batchId
}

test('times out a run that never reaches idle', async () => {
  const subject = runtime({ run: () => new Promise<RunResult>(() => {}) })

  await assert.rejects(runCodingBatch(request, () => subject), isTimeout)
})

test('uses the same deadline while waiting for the Session tree', async () => {
  const subject = runtime({
    client: { request: () => new Promise(() => {}) },
  })

  await assert.rejects(runCodingBatch(request, () => subject), isTimeout)
})

test('waits for runtime close before returning the timeout', async () => {
  let closed = false
  const subject = runtime({
    run: () => new Promise<RunResult>(() => {}),
    close: async () => {
      await delay(10)
      closed = true
    },
  })

  await assert.rejects(runCodingBatch(request, () => subject), isTimeout)
  assert.equal(closed, true)
})

test('preserves timeout and cleanup failures in order', async () => {
  const cleanupFailure = new Error('cleanup failed')
  const subject = runtime({
    run: () => new Promise<RunResult>(() => {}),
    close: async () => { throw cleanupFailure },
  })

  await assert.rejects(
    runCodingBatch(request, () => subject),
    error => error instanceof AggregateError
      && isTimeout(error.errors[0])
      && error.errors[1] === cleanupFailure,
  )
})

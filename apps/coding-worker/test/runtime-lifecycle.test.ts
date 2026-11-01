import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { DeepSeekHarnessOptions, RunResult } from '@deepseek-ai/dsh-sdk-client'

import {
  runCodingBatch,
  runWithCodingRuntime,
  type CodingRuntime,
} from '../src/runtime-lifecycle.ts'

const config = {
  workspace: 'C:\\workspace',
  dshHome: 'C:\\dsh-home',
  patches: ['C:\\profile.patch.yml'],
  environment: { PATH: 'C:\\bin', DILEE_TEST: '1' },
}

const runResult: RunResult = {
  sessionId: 'parent-batch-1',
  finalResponse: 'done',
  events: [],
  notifications: [],
}

function fakeRuntime(overrides: Partial<CodingRuntime> = {}): CodingRuntime {
  return {
    start: async () => undefined,
    run: async () => runResult,
    close: async () => undefined,
    ...overrides,
  }
}

test('runs one request on the fixed parent session and closes once', async () => {
  let receivedOptions: DeepSeekHarnessOptions | undefined
  let receivedSessionId: string | undefined
  let closeCount = 0
  const runtime = fakeRuntime({
    run: async (_prompt, options) => {
      receivedSessionId = options?.sessionId
      return runResult
    },
    close: async () => { closeCount++ },
  })

  const result = await runCodingBatch(
    { ...config, batchId: 'batch-1', parentSessionId: 'parent-batch-1', prompt: 'build a tool' },
    options => {
      receivedOptions = options
      return runtime
    },
  )

  assert.equal(result.run, runResult)
  assert.equal(result.parentSessionId, 'parent-batch-1')
  assert.equal(receivedSessionId, 'parent-batch-1')
  assert.equal(closeCount, 1)
  assert.deepEqual(receivedOptions, {
    profile: 'sdk',
    cwd: config.workspace,
    processCwd: config.workspace,
    dshHome: config.dshHome,
    patches: config.patches,
    env: config.environment,
  })
})

test('propagates a request error after closing once', async () => {
  const failure = new Error('request failed')
  let closeCount = 0
  const runtime = fakeRuntime({
    run: async () => { throw failure },
    close: async () => { closeCount++ },
  })

  await assert.rejects(
    runCodingBatch(
      { ...config, batchId: 'batch-1', parentSessionId: 'parent-batch-1', prompt: 'build' },
      () => runtime,
    ),
    error => error === failure,
  )
  assert.equal(closeCount, 1)
})

test('closes an initialized runtime when start fails without sending a request', async () => {
  const failure = new Error('initialize failed')
  let runCount = 0
  let closeCount = 0
  const runtime = fakeRuntime({
    start: async () => { throw failure },
    run: async () => {
      runCount++
      return runResult
    },
    close: async () => { closeCount++ },
  })

  await assert.rejects(
    runCodingBatch(
      { ...config, batchId: 'batch-1', parentSessionId: 'parent-batch-1', prompt: 'build' },
      () => runtime,
    ),
    error => error === failure,
  )
  assert.equal(runCount, 0)
  assert.equal(closeCount, 1)
})

test('starts and closes the real sdk profile without a model request', async (context) => {
  const dshHome = await mkdtemp(join(tmpdir(), 'dilee-dsh-smoke-'))
  context.after(() => rm(dshHome, { recursive: true, force: true }))

  const result = await runWithCodingRuntime(
    {
      workspace: process.cwd(),
      dshHome,
      patches: [],
      environment: { ...process.env },
    },
    async () => 'initialized',
  )

  assert.equal(result, 'initialized')
})

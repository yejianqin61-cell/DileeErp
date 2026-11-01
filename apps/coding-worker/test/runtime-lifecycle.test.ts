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

type WaitableRuntime = CodingRuntime & {
  client: { request(method: string, params?: object): Promise<unknown> }
}

function fakeRuntime(overrides: Partial<WaitableRuntime> = {}): WaitableRuntime {
  return {
    start: async () => undefined,
    run: async () => runResult,
    client: { request: async () => ({}) },
    close: async () => undefined,
    ...overrides,
  }
}

test('runs, waits for the fixed parent Session tree, then closes once', async () => {
  let receivedOptions: DeepSeekHarnessOptions | undefined
  let receivedSessionId: string | undefined
  const calls: string[] = []
  const runtime = fakeRuntime({
    run: async (_prompt, options) => {
      calls.push('run')
      receivedSessionId = options?.sessionId
      return runResult
    },
    client: {
      request: async (method, params) => {
        calls.push('wait')
        assert.equal(method, 'session/wait')
        assert.deepEqual(params, { sessionId: 'parent-batch-1' })
        return {}
      },
    },
    close: async () => { calls.push('close') },
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
  assert.deepEqual(calls, ['run', 'wait', 'close'])
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
  let waitCount = 0
  const runtime = fakeRuntime({
    run: async () => { throw failure },
    client: { request: async () => { waitCount++; return {} } },
    close: async () => { closeCount++ },
  })

  await assert.rejects(
    runCodingBatch(
      { ...config, batchId: 'batch-1', parentSessionId: 'parent-batch-1', prompt: 'build' },
      () => runtime,
    ),
    error => error === failure,
  )
  assert.equal(waitCount, 0)
  assert.equal(closeCount, 1)
})

test('propagates a Session tree wait error after closing once', async () => {
  const failure = new Error('tree wait failed')
  let closeCount = 0
  const runtime = fakeRuntime({
    client: { request: async () => { throw failure } },
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
      initializeTimeoutMs: 30_000,
    },
    async () => 'initialized',
  )

  assert.equal(result, 'initialized')
})

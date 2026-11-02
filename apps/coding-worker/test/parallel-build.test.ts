import assert from 'node:assert/strict'
import test from 'node:test'
import type { RunResult } from '@deepseek-ai/dsh-sdk-client'

import {
  runParallelCodingBuilds,
  type ParallelCapabilityRequest,
} from '../src/parallel-build.ts'
import type { CodingRuntimeFactory } from '../src/runtime-lifecycle.ts'

const common = {
  workspace: 'C:\\worker',
  dshHome: 'C:\\dsh',
  patches: [],
  environment: { PATH: 'C:\\bin' },
}

function capability(id: string, workspace = `C:\\candidate\\${id}`): ParallelCapabilityRequest {
  return { capabilityId: id, attemptId: 'attempt-1', workspace, prompt: `build ${id}` }
}

function result(sessionId: string): RunResult {
  return { sessionId, finalResponse: sessionId, events: [], notifications: [] }
}

function factoryFor(run: (options: Parameters<CodingRuntimeFactory>[0]) => Promise<RunResult>): CodingRuntimeFactory {
  return options => ({
    start: async () => undefined,
    run: async () => run(options),
    client: { request: async () => ({}) },
    close: async () => undefined,
  })
}

test('runs isolated capabilities concurrently and returns request order', async () => {
  let active = 0
  let maxActive = 0
  const requests = [capability('slow'), capability('fast')]
  const results = await runParallelCodingBuilds(common, requests, factoryFor(async options => {
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, options.cwd?.endsWith('slow') ? 20 : 1))
    active--
    return result(options.cwd ?? '')
  }))

  assert.equal(maxActive, 2)
  assert.deepEqual(results.map(item => item.capabilityId), ['slow', 'fast'])
  assert.deepEqual(results.map(item => item.run.finalResponse), requests.map(item => item.workspace))
})

test('rejects empty, duplicate capability IDs, and shared workspaces', async () => {
  await assert.rejects(runParallelCodingBuilds(common, [], factoryFor(async () => result('x'))), /at least one/)
  await assert.rejects(runParallelCodingBuilds(common, [capability('same'), capability('same', 'C:\\candidate\\other')], factoryFor(async () => result('x'))), /duplicate capabilityId/)
  await assert.rejects(runParallelCodingBuilds(common, [capability('one', 'C:\\candidate\\same'), capability('two', 'C:\\candidate\\same')], factoryFor(async () => result('x'))), /workspace/)
})

test('closes every started runtime when one capability fails', async () => {
  let closeCount = 0
  const failure = new Error('builder failed')
  const factory: CodingRuntimeFactory = options => ({
    start: async () => undefined,
    run: async () => {
      if (options.cwd?.endsWith('bad')) throw failure
      return new Promise<RunResult>(() => {})
    },
    client: { request: async () => ({}) },
    close: async () => { closeCount++ },
  })

  await assert.rejects(runParallelCodingBuilds(common, [capability('bad'), capability('good')], factory), failure)
  assert.equal(closeCount, 2)
})

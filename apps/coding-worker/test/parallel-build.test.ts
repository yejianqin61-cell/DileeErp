import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  return {
    sessionId,
    finalResponse: sessionId,
    events: [],
    notifications: [{ method: 'test/progress', params: { sessionId } }],
  }
}

function factoryFor(run: (options: Parameters<CodingRuntimeFactory>[0]) => Promise<RunResult>): CodingRuntimeFactory {
  return options => ({
    start: async () => {
      const tracePath = options.env?.DILEE_ACTIVATION_LOG_PATH
      if (tracePath) {
        await writeFile(tracePath, [
          JSON.stringify({ seq: 1, event: 'start', runId: 'run-1', childSessionId: 'child-1', provider: 'test', local: true }),
          JSON.stringify({ seq: 2, event: 'end', runId: 'run-1', childSessionId: 'child-1', provider: 'test', local: true, stopReason: 'completed' }),
          '',
        ].join('\n'), 'utf8')
      }
    },
    run: async () => run(options),
    client: { request: async () => ({}) },
    close: async () => undefined,
  })
}

test('runs isolated capabilities concurrently and returns request order', async () => {
  const dshHome = await mkdtemp(join(tmpdir(), 'dilee-parallel-homes-'))
  try {
  let active = 0
  let maxActive = 0
  const requests = [capability('slow'), capability('fast')]
  const harnessHomes: string[] = []
  const results = await runParallelCodingBuilds({ ...common, dshHome }, requests, factoryFor(async options => {
    active++
    maxActive = Math.max(maxActive, active)
    harnessHomes.push(options.dshHome ?? '')
    await new Promise(resolve => setTimeout(resolve, options.cwd?.endsWith('slow') ? 20 : 1))
    active--
    return result(options.cwd ?? '')
  }))

  assert.equal(maxActive, 2)
  assert.equal(new Set(harnessHomes).size, 2)
  assert.deepEqual(results.map(item => item.capabilityId), ['slow', 'fast'])
  assert.deepEqual(results.map(item => item.run.finalResponse), requests.map(item => item.workspace))
  assert.ok(results.every(item => item.progressEvents.some(event => event.source === 'sdk-notification')))
  assert.ok(results.every(item => item.progressEvents.filter(event => event.source === 'activation').length === 2))
  } finally {
    await rm(dshHome, { recursive: true, force: true })
  }
})

test('rejects empty, duplicate capability IDs, and shared workspaces', async () => {
  await assert.rejects(runParallelCodingBuilds(common, [], factoryFor(async () => result('x'))), /at least one/)
  await assert.rejects(runParallelCodingBuilds(common, [capability('same'), capability('same', 'C:\\candidate\\other')], factoryFor(async () => result('x'))), /duplicate capabilityId/)
  await assert.rejects(runParallelCodingBuilds(common, [capability('../escape')], factoryFor(async () => result('x'))), /safe path segment/)
  await assert.rejects(runParallelCodingBuilds(common, [capability('one', 'C:\\candidate\\same'), capability('two', 'C:\\candidate\\same')], factoryFor(async () => result('x'))), /workspace/)
})

test('closes every started runtime when one capability fails', async () => {
  const dshHome = await mkdtemp(join(tmpdir(), 'dilee-parallel-failure-'))
  try {
  let closeCount = 0
  const failure = new Error('builder failed')
  const factory: CodingRuntimeFactory = options => ({
    start: async () => {
      const tracePath = options.env?.DILEE_ACTIVATION_LOG_PATH
      if (tracePath) await writeFile(tracePath, '', 'utf8')
    },
    run: async () => {
      if (options.cwd?.endsWith('bad')) throw failure
      return new Promise<RunResult>(() => {})
    },
    client: { request: async () => ({}) },
    close: async () => { closeCount++ },
  })

  await assert.rejects(runParallelCodingBuilds({ ...common, dshHome }, [capability('bad'), capability('good')], factory), failure)
  assert.equal(closeCount, 2)
  } finally {
    await rm(dshHome, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { readActivationTrace } from '../src/activation-trace.ts'
import { runCodingBatch } from '../src/runtime-lifecycle.ts'

const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

function patches(): string[] {
  return [
    join(packageRoot, 'config', 'coding-agents.cordis.patch.yml'),
    join(packageRoot, 'test', 'scripted-llm.cordis.patch.yml'),
    join(packageRoot, 'config', 'activation-trace.cordis.patch.yml'),
    join(packageRoot, 'test', 'scripted-llm-activation-trace.cordis.patch.yml'),
  ]
}

test('records paired Activation start and end events', { timeout: 30_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'dilee-activation-trace-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const tracePath = join(root, 'activations.jsonl')
  const parentSessionId = 'coding-parent-r3-activation-trace'

  await runCodingBatch({
    batchId: 'r3-activation-trace',
    parentSessionId,
    prompt: '构建并验证包装产量工具。',
    workspace: packageRoot,
    dshHome: join(root, 'dsh-home'),
    patches: patches(),
    environment: {
      ...process.env,
      DILEE_PARENT_SESSION_ID: parentSessionId,
      DILEE_ACTIVATION_LOG_PATH: tracePath,
    },
    initializeTimeoutMs: 30_000,
    provider: 'dilee-scripted',
    model: 'r3-trace-script',
  })

  const records = await readActivationTrace(tracePath)
  const starts = records.filter(record => record.event === 'start')
  const ends = records.filter(record => record.event === 'end')
  const metadata = records.filter(record => record.event === 'meta')
  assert.equal(starts.length, 2)
  assert.equal(ends.length, 2)
  assert.deepEqual(ends.map(record => record.runId).sort(), starts.map(record => record.runId).sort())
  assert.equal(new Set(starts.map(record => record.runId)).size, 2)
  assert.equal(metadata.length, 2)
  assert.deepEqual(metadata.map(record => record.role).sort(), ['builder', 'validator'])
  assert.deepEqual(records.map(record => record.seq), [1, 2, 3, 4, 5, 6])
})

test('rejects a truncated Activation trace line', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'dilee-bad-activation-trace-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const tracePath = join(root, 'activations.jsonl')
  await writeFile(tracePath, '{"seq":1,"event":"start"\n', 'utf8')

  await assert.rejects(readActivationTrace(tracePath), /invalid Activation trace JSON at line 1/)
})

test('fails the trace patch when the Worker supplies no log path', { timeout: 30_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'dilee-missing-activation-trace-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const parentSessionId = 'coding-parent-r3-missing-trace'
  const environment = { ...process.env }
  delete environment.DILEE_ACTIVATION_LOG_PATH

  await assert.rejects(runCodingBatch({
    batchId: 'r3-missing-activation-trace',
    parentSessionId,
    prompt: '构建并验证包装产量工具。',
    workspace: packageRoot,
    dshHome: join(root, 'dsh-home'),
    patches: patches(),
    environment: {
      ...environment,
      DILEE_PARENT_SESSION_ID: parentSessionId,
    },
    initializeTimeoutMs: 30_000,
    provider: 'dilee-scripted',
    model: 'r3-trace-script',
  }), /DILEE_ACTIVATION_LOG_PATH/)
})

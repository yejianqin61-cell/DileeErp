import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { readActivationTrace } from '../src/activation-trace.ts'
import { timedActivationsFromTrace } from '../src/single-parent-activation.ts'
import { runCodingBatch } from '../src/runtime-lifecycle.ts'

const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

test('records capability metadata when a rejected Builder resumes for rework', { timeout: 60_000 }, async context => {
  const root = await mkdtemp(join(tmpdir(), 'dilee-rework-trace-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const parentSessionId = 'coding-parent-r3-rework-trace'
  const tracePath = join(root, 'activations.jsonl')
  await runCodingBatch({
    batchId: 'r3-rework-trace', parentSessionId, prompt: 'Build and rework the packaging tool.',
    workspace: packageRoot, dshHome: join(root, 'dsh-home'),
    patches: [
      join(packageRoot, 'config', 'coding-agents.cordis.patch.yml'),
      join(packageRoot, 'test', 'rework-scripted-llm.cordis.patch.yml'),
      join(packageRoot, 'config', 'activation-trace.cordis.patch.yml'),
      join(packageRoot, 'test', 'scripted-llm-activation-trace.cordis.patch.yml'),
    ],
    environment: { ...process.env, DILEE_PARENT_SESSION_ID: parentSessionId, DILEE_ACTIVATION_LOG_PATH: tracePath },
    initializeTimeoutMs: 30_000, provider: 'dilee-rework-scripted', model: 'r3-rework-trace',
  })
  const activations = timedActivationsFromTrace(await readActivationTrace(tracePath))
  assert.equal(activations.filter(item => item.role === 'builder').length, 2)
  assert.equal(activations.filter(item => item.role === 'validator').length, 2)
  assert.equal(activations.filter(item => item.role === 'builder').every(item => item.capabilityId === 'packaging-output'), true)
})

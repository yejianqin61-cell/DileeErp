import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { readActivationTrace } from '../src/activation-trace.ts'
import { runSingleParentBatch } from '../src/single-parent-batch.ts'
import { timedActivationsFromTrace, verifySingleParentActivations } from '../src/single-parent-activation.ts'

const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

test('one parent Harness actually overlaps two Builders and validates each after it ends', { timeout: 60_000 }, async context => {
  const root = await mkdtemp(join(tmpdir(), 'dilee-single-parent-dual-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const parentSessionId = 'coding-parent-r6-dual'
  const tracePath = join(root, 'activations.jsonl')
  const result = await runSingleParentBatch({
    workspace: packageRoot,
    dshHome: join(root, 'dsh-home'),
    patches: [
      join(packageRoot, 'config', 'coding-agents.cordis.patch.yml'),
      join(packageRoot, 'test', 'dual-scripted-llm.cordis.patch.yml'),
      join(packageRoot, 'config', 'activation-trace.cordis.patch.yml'),
    ],
    environment: { ...process.env, DILEE_PARENT_SESSION_ID: parentSessionId, DILEE_ACTIVATION_LOG_PATH: tracePath },
    initializeTimeoutMs: 30_000,
    provider: 'dilee-dual-scripted',
    model: 'r6-dual-script',
  }, {
    batchId: 'r6-dual-parent-batch',
    parentSessionId,
    capabilities: [
      { capabilityId: 'employee-output', prompt: 'Produce daily employee output.' },
      { capabilityId: 'employee-inventory', prompt: 'Produce cumulative employee inventory.' },
    ],
    deadlineMs: 30_000,
  })
  assert.equal(result.parentSessionId, parentSessionId)
  const records = await readActivationTrace(tracePath)
  const activations = timedActivationsFromTrace(records)
  verifySingleParentActivations(activations)
  assert.deepEqual(activations.filter(item => item.role === 'builder').map(item => item.capabilityId).sort(), ['employee-inventory', 'employee-output'])
})

import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runRealModelDual } from '../src/real-model-dual.ts'
import { verifySingleParentActivations, timedActivationsFromTrace } from '../src/single-parent-activation.ts'

const workspace = await mkdtemp(join(tmpdir(), 'dilee-real-model-dual-'))
try {
  const result = await runRealModelDual({
    workspace,
    workerRoot: resolve(import.meta.dirname, '..'),
    dshHome: join(workspace, 'dsh-home'),
    tracePath: join(workspace, 'activations.jsonl'),
    parentSessionId: 'phase1-real-model-dual',
    envFile: process.env.DILEE_PHASE1_ENV_FILE ?? resolve(import.meta.dirname, '..', '..', '..', '.env'),
    capabilities: [
      { capabilityId: 'employee-output', prompt: 'Create only employee-output/tool.ts and employee-output/tool.test.ts. Implement a pure formatter for daily employee output. Run the focused test.' },
      { capabilityId: 'employee-inventory', prompt: 'Create only employee-inventory/tool.ts and employee-inventory/tool.test.ts. Implement a pure formatter for cumulative employee inventory. Run the focused test.' },
    ],
    deadlineMs: 20 * 60_000,
  })
  verifySingleParentActivations(timedActivationsFromTrace(result.trace))
  const submission = result.trace.find(record => record.event === 'submission')
  assert.deepEqual(submission?.capabilities.map(capability => capability.capabilityId).sort(), [
    'employee-inventory', 'employee-output',
  ])
  await Promise.all([
    access(join(workspace, 'employee-output', 'tool.ts')),
    access(join(workspace, 'employee-output', 'tool.test.ts')),
    access(join(workspace, 'employee-inventory', 'tool.ts')),
    access(join(workspace, 'employee-inventory', 'tool.test.ts')),
  ])
  assert.equal(result.batch.parentSessionId, 'phase1-real-model-dual')
  console.log(JSON.stringify({
    result: 'passed',
    activations: timedActivationsFromTrace(result.trace).map(item => ({ capabilityId: item.capabilityId, role: item.role })),
    submittedCapabilities: submission.capabilities.map(capability => capability.capabilityId).sort(),
    files: ['employee-output/tool.ts', 'employee-output/tool.test.ts', 'employee-inventory/tool.ts', 'employee-inventory/tool.test.ts'],
  }))
} finally {
  await rm(workspace, { recursive: true, force: true })
}

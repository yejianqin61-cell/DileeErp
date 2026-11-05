import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runRealModelDual } from '../src/real-model-dual.ts'
import { freezeIndependentGateInput, verifyFrozenGeneratedCandidate } from '../src/independent-gate.ts'
import { verifySingleParentActivations, timedActivationsFromTrace } from '../src/single-parent-activation.ts'
import { validateCandidateBatch } from '../src/candidate-batch.ts'

const workspace = await mkdtemp(join(tmpdir(), 'dilee-real-model-dual-'))
let completed: Awaited<ReturnType<typeof runRealModelDual>> | undefined
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
  completed = result
  verifySingleParentActivations(timedActivationsFromTrace(result.trace))
  const submission = result.trace.find(record => record.event === 'submission')
  assert.deepEqual(submission?.capabilities.map(capability => capability.capabilityId).sort(), [
    'employee-inventory', 'employee-output',
  ])
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dirname, '..', '..', '..'), encoding: 'utf8' }).trim()
  const activations = timedActivationsFromTrace(result.trace)
  const candidates = submission.capabilities.map(submitted => {
    const builder = activations.find(item => item.capabilityId === submitted.capabilityId && item.role === 'builder')
    const validator = activations.find(item => item.capabilityId === submitted.capabilityId && item.role === 'validator')
    const builderStart = result.trace.find(item => item.event === 'start' && item.runId === builder?.runId)
    const validatorStart = result.trace.find(item => item.event === 'start' && item.runId === validator?.runId)
    const validation = result.trace.find(item => item.event === 'validation' && item.capabilityId === submitted.capabilityId && item.codeHash === submitted.codeHash && item.decision === 'approved')
    assert.ok(builder && validator && builderStart && validatorStart && validation, `R5 evidence missing for ${submitted.capabilityId}`)
    const reportHash = createHash('sha256').update(validation.report).digest('hex')
    const gate = freezeIndependentGateInput({
      capabilityId: submitted.capabilityId, candidateRoot: join(workspace, submitted.capabilityId), frozenRoot: join(workspace, 'frozen', submitted.capabilityId), sourceRevision,
      builderRunId: builder.runId, builderSessionId: builderStart.childSessionId,
      validatorReport: validation.report,
      validation: { capabilityId: submitted.capabilityId, codeHash: submitted.codeHash, decision: 'approved', validatorRunId: validator.runId, validatorSessionId: validatorStart.childSessionId, reviewedBuilderRunId: builder.runId, reviewedBuilderSessionId: builderStart.childSessionId, reportHash },
    })
    assert.equal(gate.revision.codeHash, submitted.codeHash, `submission hash mismatch for ${submitted.capabilityId}`)
    return { capabilityId: submitted.capabilityId, candidate: gate, manifestHash: gate.revision.codeHash }
  })
  await validateCandidateBatch(candidates, async candidate => {
    verifyFrozenGeneratedCandidate(candidate.candidate, { repositoryRoot: resolve(import.meta.dirname, '..', '..', '..') })
    return { accepted: true, capabilityId: candidate.capabilityId, manifestHash: candidate.manifestHash }
  })
  await Promise.all([
    access(join(workspace, 'employee-output', 'tool.ts')),
    access(join(workspace, 'employee-output', 'tool.test.ts')),
    access(join(workspace, 'employee-inventory', 'tool.ts')),
    access(join(workspace, 'employee-inventory', 'tool.test.ts')),
  ])
  assert.equal(result.batch.parentSessionId, 'phase1-real-model-dual')
  console.log(JSON.stringify({
    result: 'passed',
    activations: activations.map(item => ({ capabilityId: item.capabilityId, role: item.role })),
    submittedCapabilities: submission.capabilities.map(capability => capability.capabilityId).sort(),
    files: ['employee-output/tool.ts', 'employee-output/tool.test.ts', 'employee-inventory/tool.ts', 'employee-inventory/tool.test.ts'],
  }))
} catch (error) {
  const tracePath = join(workspace, 'activations.jsonl')
  const trace = await readFile(tracePath, 'utf8').catch(() => '')
  const records = trace.split(/\r?\n/u).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line) as { event?: unknown; capabilityId?: unknown; role?: unknown; stopReason?: unknown }] }
    catch { return [] }
  })
  console.error(JSON.stringify({
    result: 'failed',
    trace: records.map(record => ({ event: record.event, capabilityId: record.capabilityId, role: record.role, stopReason: record.stopReason })),
    finalResponse: completed?.batch.run.finalResponse.slice(0, 1000),
    rootEventTypes: completed?.batch.run.events.map(event => event.type),
  }))
  throw error
} finally {
  await rm(workspace, { recursive: true, force: true })
}

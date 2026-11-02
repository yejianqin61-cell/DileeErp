import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { readActivationTrace } from '../src/activation-trace.ts'
import { evaluateRevisionEvidence } from '../src/revision-evidence.ts'
import { runCodingBatch } from '../src/runtime-lifecycle.ts'

const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const h1 = '1'.repeat(64)
const h2 = '2'.repeat(64)

test('continues the original Builder and accepts only the revalidated revision', { timeout: 30_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'dilee-r3-rework-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const tracePath = join(root, 'activations.jsonl')
  const parentSessionId = 'coding-parent-r3-rework'

  const result = await runCodingBatch({
    batchId: 'r3-rework',
    parentSessionId,
    prompt: '构建包装产量工具；Validator 必须拒绝缺少跨订单隔离测试的首版，并让原 Builder 返工。',
    workspace: packageRoot,
    dshHome: join(root, 'dsh-home'),
    patches: [
      join(packageRoot, 'config', 'coding-agents.cordis.patch.yml'),
      join(packageRoot, 'test', 'rework-scripted-llm.cordis.patch.yml'),
      join(packageRoot, 'config', 'activation-trace.cordis.patch.yml'),
      join(packageRoot, 'test', 'scripted-llm-activation-trace.cordis.patch.yml'),
    ],
    environment: {
      ...process.env,
      DILEE_PARENT_SESSION_ID: parentSessionId,
      DILEE_ACTIVATION_LOG_PATH: tracePath,
    },
    initializeTimeoutMs: 30_000,
    provider: 'dilee-rework-scripted',
    model: 'r3-rework-script',
  })

  assert.equal(result.run.finalResponse, 'ORCHESTRATOR_COMPLETE_H2')
  const started = result.run.notifications.filter(item => item.method === 'subagent.started')
  const finished = result.run.notifications.filter(item => item.method === 'subagent.finished')
  assert.equal(started.length, 4)
  assert.equal(finished.length, 4)

  const builderFinishes = finished.filter(item =>
    JSON.stringify(item.params.lastAssistantMessage).includes('BUILDER_REVISION_H'))
  assert.equal(builderFinishes.length, 2)
  const builderSessionId = builderFinishes[0]?.params.childSessionId
  if (typeof builderSessionId !== 'string') assert.fail('Builder completion carried no Session ID')
  assert.ok(builderFinishes.every(item => item.params.childSessionId === builderSessionId))
  assert.equal(started.filter(item => item.params.childSessionId === builderSessionId).length, 2)

  const completionEvidence = JSON.stringify(finished.map(item => item.params.lastAssistantMessage))
  assert.match(completionEvidence, /BUILDER_REVISION_H1/)
  assert.match(completionEvidence, /VALIDATOR_REJECTED_H1/)
  assert.match(completionEvidence, /BUILDER_REVISION_H2/)
  assert.match(completionEvidence, /VALIDATOR_APPROVED_H2/)
  assert.match(JSON.stringify(result.run.events), /"name":"revise_tool"/)

  const trace = await readActivationTrace(tracePath)
  const starts = trace.filter(record => record.event === 'start')
  const ends = trace.filter(record => record.event === 'end')
  assert.equal(starts.length, 4)
  assert.equal(ends.length, 4)
  assert.equal(new Set(starts.map(record => record.runId)).size, 4)
  assert.deepEqual(ends.map(record => record.runId).sort(), starts.map(record => record.runId).sort())

  const builderRuns = starts.filter(record => record.childSessionId === builderSessionId)
  assert.equal(builderRuns.length, 2)
  assert.notEqual(builderRuns[0]?.runId, builderRuns[1]?.runId)

  const validatorFinishes = finished.filter(item =>
    JSON.stringify(item.params.lastAssistantMessage).includes('VALIDATOR_'))
  const validatorH1Id = validatorFinishes.find(item =>
    JSON.stringify(item.params.lastAssistantMessage).includes('H1'))?.params.childSessionId
  const validatorH2Id = validatorFinishes.find(item =>
    JSON.stringify(item.params.lastAssistantMessage).includes('H2'))?.params.childSessionId
  if (typeof validatorH1Id !== 'string') assert.fail('h1 Validator carried no Session ID')
  if (typeof validatorH2Id !== 'string') assert.fail('h2 Validator carried no Session ID')
  const validatorH1Run = starts.find(record => record.childSessionId === validatorH1Id)
  const validatorH2Run = starts.find(record => record.childSessionId === validatorH2Id)
  assert.ok(validatorH1Run)
  assert.ok(validatorH2Run)

  const currentRevision = {
    capabilityId: 'packaging-output',
    codeHash: h2,
    builderRunId: builderRuns[1]!.runId,
    builderSessionId,
  }
  assert.deepEqual(evaluateRevisionEvidence(currentRevision, {
    capabilityId: 'packaging-output',
    codeHash: h1,
    decision: 'approved',
    validatorRunId: validatorH1Run.runId,
    validatorSessionId: validatorH1Id,
    reviewedBuilderRunId: builderRuns[0]!.runId,
    reviewedBuilderSessionId: builderSessionId,
  }), { accepted: false, reason: 'revision-mismatch' })
  assert.deepEqual(evaluateRevisionEvidence(currentRevision, {
    capabilityId: 'packaging-output',
    codeHash: h2,
    decision: 'approved',
    validatorRunId: validatorH2Run.runId,
    validatorSessionId: validatorH2Id,
    reviewedBuilderRunId: builderRuns[1]!.runId,
    reviewedBuilderSessionId: builderSessionId,
  }), { accepted: true })
})

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodingBatchTimeoutError, runCodingBatch } from '../src/runtime-lifecycle.ts'

const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const codingPatch = join(packageRoot, 'config', 'coding-agents.cordis.patch.yml')

function toolResultTexts(events: Awaited<ReturnType<typeof runCodingBatch>>['run']['events']): string[] {
  return events.flatMap((event) => {
    if (event.type !== 'tool/result') return []
    return event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
  })
}

test('submits the latest approved revision through the controlled actions', { timeout: 40_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'dilee-policy-valid-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const parentSessionId = 'coding-parent-r4-policy-valid'

  const result = await runCodingBatch({
    batchId: 'r4-policy-valid',
    parentSessionId,
    prompt: '构建并验证包装产量工具。',
    workspace: packageRoot,
    dshHome: join(root, 'dsh-home'),
    patches: [codingPatch, join(packageRoot, 'test', 'scripted-llm.cordis.patch.yml')],
    environment: { ...process.env, DILEE_PARENT_SESSION_ID: parentSessionId },
    initializeTimeoutMs: 30_000,
    provider: 'dilee-scripted',
    model: 'r4-policy-valid-script',
  })

  assert.equal(result.run.finalResponse, 'ORCHESTRATOR_COMPLETE')
  assert.ok(toolResultTexts(result.run.events).includes(JSON.stringify({
    capabilities: [{ capabilityId: 'packaging-output', codeHash: '1'.repeat(64) }],
  })))
})

test('rejects out-of-order, stale-revision, early-submit, and over-budget actions', { timeout: 40_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'dilee-policy-denials-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const parentSessionId = 'coding-parent-r4-policy-denials'

  const result = await runCodingBatch({
    batchId: 'r4-policy-denials',
    parentSessionId,
    prompt: '尝试越序动作，再完成受控返工。',
    workspace: packageRoot,
    dshHome: join(root, 'dsh-home'),
    patches: [codingPatch, join(packageRoot, 'test', 'policy-adversarial-llm.cordis.patch.yml')],
    environment: { ...process.env, DILEE_PARENT_SESSION_ID: parentSessionId },
    initializeTimeoutMs: 30_000,
    provider: 'dilee-policy-adversarial',
    model: 'r4-policy-denials-script',
  })

  assert.equal(result.run.finalResponse, 'POLICY_DENIALS_CONFIRMED')
  const events = JSON.stringify(result.run.events)
  for (const code of [
    'capabilities-not-declared',
    'capability-not-approved',
    'revision-not-advanced',
    'rework-budget-exhausted',
  ]) assert.match(events, new RegExp(code))

  const started = result.run.notifications.filter(item => item.method === 'subagent.started')
  assert.equal(started.length, 4)
  assert.equal(started[0]?.params.childSessionId, started[2]?.params.childSessionId)
})

test('closes the real Harness process after the Worker deadline', { timeout: 30_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'dilee-policy-timeout-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const parentSessionId = 'coding-parent-r4-policy-timeout'
  const pidPath = join(root, 'runtime.pid')

  await assert.rejects(runCodingBatch({
    batchId: 'r4-policy-timeout',
    parentSessionId,
    prompt: '保持运行直到 Worker 截止时间。',
    workspace: packageRoot,
    dshHome: join(root, 'dsh-home'),
    patches: [codingPatch, join(packageRoot, 'test', 'policy-timeout-llm.cordis.patch.yml')],
    environment: {
      ...process.env,
      DILEE_PARENT_SESSION_ID: parentSessionId,
      DILEE_RUNTIME_PID_PATH: pidPath,
    },
    initializeTimeoutMs: 30_000,
    deadlineMs: 100,
    provider: 'dilee-policy-timeout',
    model: 'r4-policy-timeout-script',
  }), error => error instanceof CodingBatchTimeoutError)

  const runtimePid = Number.parseInt(await readFile(pidPath, 'utf8'), 10)
  assert.throws(
    () => process.kill(runtimePid, 0),
    error => (error as NodeJS.ErrnoException).code === 'ESRCH',
  )
})

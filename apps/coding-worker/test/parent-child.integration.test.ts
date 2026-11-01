import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { runCodingBatch } from '../src/runtime-lifecycle.ts'

const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const parentSessionId = 'coding-parent-r2-integration'

test('runs Builder and Validator under one fixed parent Session', { timeout: 30_000 }, async (context) => {
  const dshHome = await mkdtemp(join(tmpdir(), 'dilee-parent-child-'))
  context.after(() => rm(dshHome, { recursive: true, force: true }))

  const result = await runCodingBatch({
    batchId: 'r2-integration',
    parentSessionId,
    prompt: '查询订单 A 的包装工序、每位员工的每日产量和累计完成数量。缺少工具，请构建并验证。',
    workspace: packageRoot,
    dshHome,
    patches: [
      join(packageRoot, 'config', 'coding-agents.cordis.patch.yml'),
      join(packageRoot, 'test', 'scripted-llm.cordis.patch.yml'),
    ],
    environment: {
      ...process.env,
      DILEE_SCRIPTED_LLM_PLUGIN: join(packageRoot, 'test', 'scripted-llm-plugin.mjs'),
      DILEE_PARENT_SESSION_ID: parentSessionId,
    },
    provider: 'dilee-scripted',
    model: 'r2-script',
  })

  assert.equal(result.parentSessionId, parentSessionId)
  assert.equal(result.run.sessionId, parentSessionId)
  assert.equal(result.run.finalResponse, 'ORCHESTRATOR_COMPLETE')

  const started = result.run.notifications.filter(item => item.method === 'subagent.started')
  const finished = result.run.notifications.filter(item => item.method === 'subagent.finished')
  assert.equal(started.length, 2)
  assert.equal(finished.length, 2)
  assert.ok(started.every(item => item.params.parentSessionId === parentSessionId))
  assert.ok(finished.every(item => item.params.parentSessionId === parentSessionId))

  const childIds = started.map(item => item.params.childSessionId)
  assert.equal(new Set(childIds).size, 2)
  assert.deepEqual(finished.map(item => item.params.childSessionId).sort(), [...childIds].sort())
  assert.ok(finished.every(item => item.params.status === 'ok'))

  const evidence = JSON.stringify(finished.map(item => item.params.lastAssistantMessage))
  assert.match(evidence, /BUILDER_COMPLETE/)
  assert.match(evidence, /VALIDATOR_APPROVED/)

  const parentEvents = JSON.stringify(result.run.events)
  assert.match(parentEvents, /"name":"build_tool"/)
  assert.match(parentEvents, /"name":"validate_tool"/)
})

import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runRealModelRework } from '../src/real-model-rework.ts'

const workspace = await mkdtemp(join(tmpdir(), 'dilee-real-model-'))
try {
  const result = await runRealModelRework({
    workspace,
    workerRoot: resolve(import.meta.dirname, '..'),
    dshHome: join(workspace, 'dsh-home'),
    parentSessionId: 'phase1-real-model',
    envFile: process.env.DILEE_PHASE1_ENV_FILE ?? resolve(import.meta.dirname, '..', '..', '..', '.env'),
    deadlineMs: 5 * 60_000,
  })
  const files = await readdir(workspace)
  assert.ok(files.includes('tool.ts'), 'real model did not create tool.ts')
  assert.ok(files.includes('tool.test.ts'), 'real model did not create tool.test.ts')
  const eventTypes = result.run.events.map(event => event.type)
  assert.ok(eventTypes.includes('tool'), 'real model did not issue a tool call')
  console.log(JSON.stringify({
    result: 'passed',
    eventCount: eventTypes.length,
    toolEvents: eventTypes.filter(type => type === 'tool').length,
    files: ['tool.ts', 'tool.test.ts'],
  }))
} finally {
  await rm(workspace, { recursive: true, force: true })
}

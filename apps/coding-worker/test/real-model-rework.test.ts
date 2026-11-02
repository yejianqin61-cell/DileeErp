import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runRealModelRework } from '../src/real-model-rework.ts'

test('fails before starting a real model when the env file has no upstream key', async context => {
  const root = await mkdtemp(join(tmpdir(), 'dilee-real-model-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const envFile = join(root, '.env')
  await writeFile(envFile, 'OTHER=value\n')
  await assert.rejects(
    runRealModelRework({ workspace: root, workerRoot: root, dshHome: join(root, 'home'), parentSessionId: 'parent', envFile }),
    /MODEL_RELAY_UPSTREAM_KEY_REQUIRED/,
  )
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createCapabilityAttemptWorkspace } from '../src/attempt-workspace.ts'

test('creates a separate directory per attempt and refuses to reuse one', async context => {
  const root = await mkdtemp(join(tmpdir(), 'dilee-attempts-'))
  context.after(() => rm(root, { recursive: true, force: true }))

  const first = await createCapabilityAttemptWorkspace(root, 'output', 'attempt-1')
  const second = await createCapabilityAttemptWorkspace(root, 'output', 'attempt-2')
  assert.notEqual(first, second)
  await assert.rejects(createCapabilityAttemptWorkspace(root, 'output', 'attempt-1'), /already exists|EEXIST/u)
})

test('rejects path traversal in capability and attempt IDs', async context => {
  const root = await mkdtemp(join(tmpdir(), 'dilee-attempt-path-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(createCapabilityAttemptWorkspace(root, '../escape', 'attempt-1'), /safe path segment/u)
  await assert.rejects(createCapabilityAttemptWorkspace(root, 'output', '..'), /safe path segment/u)
})

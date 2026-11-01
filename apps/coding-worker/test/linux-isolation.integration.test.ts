import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { runLinuxIsolationProbe } from '../src/linux-isolation-probe.ts'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))

test('enforces the source, candidate, credential and network boundary in Linux', {
  timeout: 180_000,
}, () => {
  const result = runLinuxIsolationProbe({
    repositoryRoot,
    revision: 'HEAD',
  })

  assert.equal(result.engine, 'linux')
  assert.equal(result.sourceReadable, true)
  assert.equal(result.candidateWritable, true)
  assert.equal(result.stateWritable, true)
  assert.equal(result.sourceWriteDenied, true)
  assert.equal(result.rootWriteDenied, true)
  assert.equal(result.envFileAbsent, true)
  assert.equal(result.databaseCredentialAbsent, true)
  assert.equal(result.userTokenAbsent, true)
  assert.equal(result.networkDenied, true)
})

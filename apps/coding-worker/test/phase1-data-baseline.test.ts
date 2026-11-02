import assert from 'node:assert/strict'
import test from 'node:test'

import { createPhase1DataBaseline } from '../src/phase1-data-baseline.ts'

test('rejects source and non-test databases before issuing SQL', () => {
  const calls: string[][] = []
  const command = (args: readonly string[]) => { calls.push([...args]); return '' }

  assert.throws(() => createPhase1DataBaseline('dilee_erp', command), /PHASE1_TEST_DATABASE_REQUIRED/)
  assert.throws(() => createPhase1DataBaseline('dilee_snapshot', command), /PHASE1_TEST_DATABASE_REQUIRED/)
  assert.deepEqual(calls, [])
})

test('rebuilds only the explicit test database and emits a stable aggregate fingerprint', () => {
  const calls: string[][] = []
  const command = (args: readonly string[]) => {
    calls.push([...args])
    return args.includes('-X') ? '748|60\n' : ''
  }

  const first = createPhase1DataBaseline('dilee_phase1_test', command)
  const second = createPhase1DataBaseline('dilee_phase1_test', command)

  assert.deepEqual(first, second)
  assert.equal(first.reportCount, 748)
  assert.equal(first.scopeCount, 60)
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/)
  assert.match(calls[0]!.at(-1)!, /DROP DATABASE IF EXISTS dilee_phase1_test/)
  assert.match(calls[1]!.at(-1)!, /CREATE DATABASE dilee_phase1_test TEMPLATE dilee_snapshot/)
})

test('rejects malformed aggregate output', () => {
  assert.throws(
    () => createPhase1DataBaseline('dilee_phase1_test', () => 'not-counts'),
    /PHASE1_BASELINE_QUERY_INVALID/,
  )
})

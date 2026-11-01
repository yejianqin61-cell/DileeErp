import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  assertRuntimeContract,
  DSH_VERSION,
  MINIMUM_NODE_VERSION,
} from '../src/runtime-contract.ts'

const packageManifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  engines: { node: string }
  dependencies: Record<string, string>
}

test('rejects Node below 24.9.0', () => {
  assert.throws(
    () => assertRuntimeContract('24.8.0', DSH_VERSION, DSH_VERSION),
    /Node 24\.9\.0 or newer is required/,
  )
})

test('accepts Node 24.9.0', () => {
  assert.deepEqual(
    assertRuntimeContract('24.9.0', DSH_VERSION, DSH_VERSION),
    { nodeVersion: '24.9.0', dshVersion: '0.2.2-alpha.2' },
  )
})

test('rejects mismatched SDK and CLI versions', () => {
  assert.throws(
    () => assertRuntimeContract('24.9.0', DSH_VERSION, '0.2.2-alpha.1'),
    /SDK and CLI must both be 0\.2\.2-alpha\.2/,
  )
})

test('keeps the package manifest on the fixed runtime contract', () => {
  assert.equal(MINIMUM_NODE_VERSION, '24.9.0')
  assert.equal(packageManifest.engines.node, '>=24.9.0')
  assert.equal(packageManifest.dependencies['@deepseek-ai/dsh-sdk-client'], DSH_VERSION)
  assert.equal(packageManifest.dependencies['@deepseek-ai/dsh'], DSH_VERSION)
})

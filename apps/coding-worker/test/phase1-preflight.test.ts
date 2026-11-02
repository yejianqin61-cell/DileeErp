import assert from 'node:assert/strict'
import test from 'node:test'

import { runPhase1Preflight } from '../src/phase1-preflight.ts'

const input = {
  dockerEngine: 'linux',
  baseline: {
    sourceDatabase: 'dilee_snapshot', targetDatabase: 'dilee_phase1_test',
    reportCount: 748, scopeCount: 60, fingerprint: 'a'.repeat(64),
  },
  modelRelayNetwork: 'dilee-model-relay',
  modelRelayTokenPresent: true,
  revision: 'c4de0c52201ad32aea501a6c3b8a3b586a9358cb',
  runtime: { nodeVersion: '24.15.0', dshVersion: '0.2.2-alpha.2' },
} as const

test('fails closed when Linux, baseline, or model relay configuration is missing', () => {
  assert.throws(() => runPhase1Preflight({ ...input, dockerEngine: 'windows' }), /LINUX_DOCKER_ENGINE_REQUIRED/)
  assert.throws(() => runPhase1Preflight({ ...input, baseline: undefined }), /PHASE1_BASELINE_REQUIRED/)
  assert.throws(() => runPhase1Preflight({ ...input, modelRelayTokenPresent: false }), /MODEL_RELAY_CONFIGURATION_REQUIRED/)
})

test('returns only non-secret evidence for a valid preflight', () => {
  const result = runPhase1Preflight(input)
  assert.deepEqual(result, {
    revision: input.revision,
    image: 'node:24.9.0-alpine',
    baselineFingerprint: 'a'.repeat(64),
    modelRelayNetwork: 'dilee-model-relay',
    runtime: input.runtime,
  })
  assert.ok(!JSON.stringify(result).includes('TOKEN'))
})

import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { freezeIndependentGateInput, verifyFrozenGeneratedCandidate } from '../src/independent-gate.ts'
import { freezeCandidateRevision } from '../src/candidate-revision.ts'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const linux = spawnSync('docker', ['info', '--format', '{{.OSType}}'], { encoding: 'utf8', windowsHide: true }).stdout.trim() === 'linux'
const report = '{"decision":"approved"}'
const reportHash = (await import('node:crypto')).createHash('sha256').update(report).digest('hex')

test('reruns an arbitrary frozen Builder test with fixed Linux isolation probes', { skip: linux ? false : 'Docker Linux engine is not available', timeout: 180_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'dilee-generated-candidate-slice-'))
  const candidate = join(root, 'candidate')
  try {
    mkdirSync(candidate)
    for (const file of ['tool.ts', 'tool.test.ts']) copyFileSync(join(repositoryRoot, 'apps/coding-worker/candidate/order-a-output', file), join(candidate, file))
    const preview = freezeCandidateRevision({ capabilityId: 'employee-output', candidateRoot: candidate, frozenRoot: join(root, 'preview') })
    const input = freezeIndependentGateInput({
      capabilityId: 'employee-output', candidateRoot: candidate, frozenRoot: join(root, 'frozen'), sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(), builderRunId: 'builder', builderSessionId: 'builder-session', validatorReport: report,
      validation: { capabilityId: 'employee-output', codeHash: preview.codeHash, decision: 'approved', validatorRunId: 'validator', validatorSessionId: 'validator-session', reviewedBuilderRunId: 'builder', reviewedBuilderSessionId: 'builder-session', reportHash },
    })
    assert.deepEqual(verifyFrozenGeneratedCandidate(input, { repositoryRoot }), { codeHash: input.revision.codeHash, testsPassed: true, permissionsPassed: true })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

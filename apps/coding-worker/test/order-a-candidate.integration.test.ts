import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { runOrderACandidateInLinux } from '../src/order-a-candidate-slice.ts'
import {
  createCandidateManifest,
  evaluateCandidate,
} from '../src/candidate-gate.ts'
import { RestrictedDataError, RestrictedDataGateway } from '../src/restricted-data-gateway.ts'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const candidateRoot = `${repositoryRoot}/apps/coding-worker/candidate/order-a-output`
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim()
const docker = spawnSync('docker', ['info', '--format', '{{.OSType}}'], {
  encoding: 'utf8',
  windowsHide: true,
})
const linuxEngineAvailable = docker.status === 0 && docker.stdout.trim() === 'linux'

test('runs the approved candidate and independent permission checks in Linux', {
  timeout: 180_000,
  skip: linuxEngineAvailable ? false : 'Docker Linux engine is not available',
}, async () => {
  const manifest = createCandidateManifest({
    candidateRoot,
    sourceRevision,
    capabilities: ['get_employee_output_summary'],
  })
  const report = await evaluateCandidate({
    candidateRoot,
    manifest,
    expectedSourceRevision: sourceRevision,
    runTests: async () => {
      const result = runOrderACandidateInLinux({ repositoryRoot, candidateRoot, sourceRevision })
      assert.deepEqual(result.fact.data.employee_totals, [
        { employee_id: 'e-1', employee_name: '员工甲', quantity: '20.0000' },
        { employee_id: 'e-2', employee_name: '员工乙', quantity: '5.0000' },
      ])
      assert.equal(result.sourceWriteDenied, true)
      assert.equal(result.candidateWriteDenied, true)
      assert.equal(result.networkDenied, true)
      assert.equal(result.databaseCredentialAbsent, true)
      return { passed: true }
    },
    runPermissionChecks: async () => {
      const gateway = new RestrictedDataGateway(async () => [])
      await assert.rejects(
        gateway.read({
          operation: 'production.read_employee_output_summary',
          scope: { orderNo: 'SO-A-001', operationName: '包装' },
          limit: 100,
          accessLevel: 'full',
        }, { accessLevel: 'operational' }),
        (error: unknown) => error instanceof RestrictedDataError && error.code === 'DATA_REQUEST_INVALID',
      )
      return { passed: true }
    },
  })

  assert.equal(report.accepted, true)
  assert.equal(report.testsPassed, true)
  assert.equal(report.permissionsPassed, true)
})

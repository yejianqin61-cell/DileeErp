import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CandidateGateError,
  createCandidateManifest,
  evaluateCandidate,
} from '../src/candidate-gate.ts'

const sourceRevision = 'a'.repeat(40)
const toolSource = 'export const runTool = () => "candidate"\n'

function candidate(content = toolSource): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'dilee-candidate-'))
  writeFileSync(join(root, 'tool.ts'), content)
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function expectCode(code: string): (error: unknown) => boolean {
  return error => error instanceof CandidateGateError && error.code === code
}

test('recomputes candidate hashes and runs independent test and permission checks', async () => {
  const value = candidate()
  const calls: string[] = []
  try {
    const manifest = createCandidateManifest({
      candidateRoot: value.root,
      sourceRevision,
      capabilities: ['get_employee_output_summary'],
    })
    const report = await evaluateCandidate({
      candidateRoot: value.root,
      manifest,
      expectedSourceRevision: sourceRevision,
      runTests: async () => { calls.push('tests'); return { passed: true } },
      runPermissionChecks: async () => { calls.push('permissions'); return { passed: true } },
    })

    assert.equal(report.accepted, true)
    assert.equal(report.sourceRevision, sourceRevision)
    assert.equal(report.capabilities[0], 'get_employee_output_summary')
    assert.equal(report.files[0]?.path, 'tool.ts')
    assert.match(report.files[0]?.sha256 ?? '', /^[a-f0-9]{64}$/)
    assert.match(report.manifestHash, /^[a-f0-9]{64}$/)
    assert.deepEqual(calls, ['tests', 'permissions'])
  } finally {
    value.cleanup()
  }
})

test('rejects a candidate file changed after manifest creation', async () => {
  const value = candidate()
  try {
    const manifest = createCandidateManifest({
      candidateRoot: value.root,
      sourceRevision,
      capabilities: ['get_employee_output_summary'],
    })
    writeFileSync(join(value.root, 'tool.ts'), `${toolSource}// changed\n`)

    await assert.rejects(evaluateCandidate({
      candidateRoot: value.root,
      manifest,
      expectedSourceRevision: sourceRevision,
      runTests: async () => ({ passed: true }),
      runPermissionChecks: async () => ({ passed: true }),
    }), expectCode('CANDIDATE_HASH_MISMATCH'))
  } finally {
    value.cleanup()
  }
})

test('rejects secret files, extra dependencies and symlinks', async () => {
  const cases: Array<(root: string) => void> = [
    root => writeFileSync(join(root, '.env'), 'DATABASE_URL=secret'),
    root => writeFileSync(join(root, 'package.json'), '{"scripts":{"postinstall":"node x"}}'),
    root => symlinkSync(join(root, 'tool.ts'), join(root, 'linked-tool.ts')),
  ]
  for (const addUnsafeFile of cases) {
    const value = candidate()
    try {
      addUnsafeFile(value.root)
      await assert.rejects(Promise.resolve().then(() => createCandidateManifest({
        candidateRoot: value.root,
        sourceRevision,
        capabilities: ['get_employee_output_summary'],
      })), expectCode('CANDIDATE_PATH_DENIED'))
    } finally {
      value.cleanup()
    }
  }
})

test('rejects a source revision that differs from the validated baseline', async () => {
  const value = candidate()
  try {
    const manifest = createCandidateManifest({
      candidateRoot: value.root,
      sourceRevision,
      capabilities: ['get_employee_output_summary'],
    })
    await assert.rejects(evaluateCandidate({
      candidateRoot: value.root,
      manifest,
      expectedSourceRevision: 'b'.repeat(40),
      runTests: async () => ({ passed: true }),
      runPermissionChecks: async () => ({ passed: true }),
    }), expectCode('SOURCE_BASELINE_MISMATCH'))
  } finally {
    value.cleanup()
  }
})

test('rejects when the independent test or permission check fails', async () => {
  const value = candidate()
  try {
    const manifest = createCandidateManifest({
      candidateRoot: value.root,
      sourceRevision,
      capabilities: ['get_employee_output_summary'],
    })
    await assert.rejects(evaluateCandidate({
      candidateRoot: value.root,
      manifest,
      expectedSourceRevision: sourceRevision,
      runTests: async () => ({ passed: false }),
      runPermissionChecks: async () => ({ passed: true }),
    }), expectCode('CANDIDATE_VALIDATION_FAILED'))

    await assert.rejects(evaluateCandidate({
      candidateRoot: value.root,
      manifest,
      expectedSourceRevision: sourceRevision,
      runTests: async () => ({ passed: true }),
      runPermissionChecks: async () => ({ passed: false }),
    }), expectCode('CANDIDATE_VALIDATION_FAILED'))
  } finally {
    value.cleanup()
  }
})

test('rejects candidate code that imports dependencies or opens process/network access', async () => {
  const value = candidate('import fs from "node:fs"; export const runTool = () => fs.readFileSync("x")\n')
  try {
    await assert.rejects(Promise.resolve().then(() => createCandidateManifest({
      candidateRoot: value.root,
      sourceRevision,
      capabilities: ['get_employee_output_summary'],
    })), expectCode('CANDIDATE_CODE_DENIED'))
  } finally {
    value.cleanup()
  }
})

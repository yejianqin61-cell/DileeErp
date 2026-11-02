import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { freezeCandidateRevision } from '../src/candidate-revision.ts'

function directory(): string { return mkdtempSync(join(tmpdir(), 'dilee-revision-')) }

test('freezes stable implementation and Builder test bytes', () => {
  const source = directory(); const frozen = directory()
  try {
    writeFileSync(join(source, 'tool.ts'), 'export const x = 1\n')
    writeFileSync(join(source, 'tool.test.ts'), 'test()\n')
    const revision = freezeCandidateRevision({ capabilityId: 'employee-output', candidateRoot: source, frozenRoot: frozen })
    writeFileSync(join(source, 'tool.ts'), 'export const x = 2\n')
    assert.equal(revision.files.length, 2)
    assert.equal(revision.files[0]!.path, 'tool.test.ts')
    assert.match(revision.codeHash, /^[a-f0-9]{64}$/)
  } finally { rmSync(source, { recursive: true, force: true }); rmSync(frozen, { recursive: true, force: true }) }
})

test('rejects missing implementation and non-file candidate entries', () => {
  const source = directory(); const frozen = directory()
  try {
    assert.throws(() => freezeCandidateRevision({ capabilityId: 'employee-output', candidateRoot: source, frozenRoot: frozen }), /IMPLEMENTATION_REQUIRED/)
    writeFileSync(join(source, 'tool.ts'), 'ok')
    symlinkSync(source, join(source, 'outside.ts'), 'junction')
    assert.throws(() => freezeCandidateRevision({ capabilityId: 'employee-output', candidateRoot: source, frozenRoot: frozen }), /PATH_DENIED/)
  } finally { rmSync(source, { recursive: true, force: true }); rmSync(frozen, { recursive: true, force: true }) }
})

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_SOURCE_VIEW_PATHS,
  materializeSourceView,
} from '../src/source-view.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function fixture(): { repository: string; cleanup(): void } {
  const repository = mkdtempSync(join(tmpdir(), 'dilee-source-view-'))
  git(repository, 'init', '--quiet')
  git(repository, 'config', 'user.email', 'source-view@test.invalid')
  git(repository, 'config', 'user.name', 'Source View Test')

  const files: Record<string, string> = {
    'apps/api/src/modules/business-query-agent/tools/example.ts': 'export const revision = 1\n',
    'apps/api/src/modules/other-module/private.ts': 'export const privateValue = true\n',
    'apps/api/prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("DATABASE_URL") }\n',
    'apps/api/package.json': '{"name":"fixture"}\n',
    'package.json': '{"private":true}\n',
    'tsconfig.base.json': '{}\n',
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(repository, relativePath)
    mkdirSync(join(absolutePath, '..'), { recursive: true })
    writeFileSync(absolutePath, content)
  }
  git(repository, 'add', '.')
  git(repository, 'commit', '--quiet', '-m', 'fixture')

  writeFileSync(join(repository, '.env'), 'DATABASE_URL=postgres://secret\n')
  writeFileSync(
    join(repository, 'apps/api/src/modules/business-query-agent/tools/example.ts'),
    'export const revision = 2\n',
  )

  return {
    repository,
    cleanup: () => rmSync(repository, { recursive: true, force: true }),
  }
}

test('materializes only allowlisted files from the requested Git revision', () => {
  const source = fixture()
  const destination = mkdtempSync(join(tmpdir(), 'dilee-source-output-'))
  try {
    const manifest = materializeSourceView({
      repositoryRoot: source.repository,
      destination,
      revision: 'HEAD',
    })

    assert.equal(
      readFileSync(
        join(destination, 'apps/api/src/modules/business-query-agent/tools/example.ts'),
        'utf8',
      ),
      'export const revision = 1\n',
    )
    assert.equal(manifest.revision, git(source.repository, 'rev-parse', 'HEAD'))
    assert.ok(manifest.files.some(file => file.path.endsWith('tools/example.ts')))
    assert.throws(() => readFileSync(join(destination, '.env')), /ENOENT/)
    assert.throws(
      () => readFileSync(join(destination, 'apps/api/src/modules/other-module/private.ts')),
      /ENOENT/,
    )
  } finally {
    source.cleanup()
    rmSync(destination, { recursive: true, force: true })
  }
})

test('produces the same manifest hash for the same revision', () => {
  const source = fixture()
  const first = mkdtempSync(join(tmpdir(), 'dilee-source-first-'))
  const second = mkdtempSync(join(tmpdir(), 'dilee-source-second-'))
  try {
    const firstManifest = materializeSourceView({
      repositoryRoot: source.repository,
      destination: first,
      revision: 'HEAD',
    })
    const secondManifest = materializeSourceView({
      repositoryRoot: source.repository,
      destination: second,
      revision: 'HEAD',
    })
    assert.equal(firstManifest.hash, secondManifest.hash)
    assert.deepEqual(firstManifest.files, secondManifest.files)
  } finally {
    source.cleanup()
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})

test('rejects a symbolic link in an allowlisted path', () => {
  const source = fixture()
  const destination = mkdtempSync(join(tmpdir(), 'dilee-source-link-'))
  try {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: source.repository,
      encoding: 'utf8',
      input: '../../../../.env',
    }).trim()
    git(
      source.repository,
      'update-index',
      '--add',
      '--cacheinfo',
      `120000,${blob},apps/api/src/modules/business-query-agent/secret-link`,
    )
    git(source.repository, 'commit', '--quiet', '-m', 'add unsafe link')

    assert.throws(
      () => materializeSourceView({
        repositoryRoot: source.repository,
        destination,
        revision: 'HEAD',
      }),
      /SOURCE_VIEW_UNSAFE_ENTRY.*secret-link/,
    )
  } finally {
    source.cleanup()
    rmSync(destination, { recursive: true, force: true })
  }
})

test('keeps the source allowlist narrow', () => {
  assert.deepEqual(DEFAULT_SOURCE_VIEW_PATHS, [
    'apps/api/src/modules/business-query-agent',
    'apps/api/prisma/schema.prisma',
    'apps/api/package.json',
    'package.json',
    'tsconfig.base.json',
  ])
})

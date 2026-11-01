import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export const DEFAULT_SOURCE_VIEW_PATHS = [
  'apps/api/src/modules/business-query-agent',
  'apps/api/prisma/schema.prisma',
  'apps/api/package.json',
  'package.json',
  'tsconfig.base.json',
] as const

export interface SourceViewFile {
  path: string
  mode: '100644' | '100755'
  blob: string
}

export interface SourceViewManifest {
  revision: string
  hash: string
  files: SourceViewFile[]
}

export interface SourceViewOptions {
  repositoryRoot: string
  destination: string
  revision: string
  paths?: readonly string[]
}

const FORBIDDEN_SEGMENTS = new Set([
  '.env',
  'backup',
  'backups',
  'credential',
  'credentials',
  'secret',
  'secrets',
  'upload',
  'uploads',
])
const FORBIDDEN_EXTENSIONS = ['.bak', '.dump', '.key', '.p12', '.pem', '.pfx', '.sql']

function git(
  repositoryRoot: string,
  args: readonly string[],
  encoding?: BufferEncoding,
): string | Buffer {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: encoding ?? null,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
}

function isForbiddenPath(path: string): boolean {
  const segments = path.toLowerCase().split('/')
  const basename = segments.at(-1) ?? ''
  return path.startsWith('/')
    || path.includes('\\')
    || segments.some(segment => segment === '..' || segment === '.' || segment.startsWith('.env.'))
    || segments.some(segment => FORBIDDEN_SEGMENTS.has(segment))
    || FORBIDDEN_EXTENSIONS.some(extension => basename.endsWith(extension))
}

function treeEntries(
  repositoryRoot: string,
  revision: string,
  paths: readonly string[],
): SourceViewFile[] {
  const output = git(
    repositoryRoot,
    ['ls-tree', '-rz', '--full-tree', revision, '--', ...paths],
  ) as Buffer
  return output.toString('utf8').split('\0').filter(Boolean).map(record => {
    const match = /^(\d{6}) blob ([0-9a-f]{40,64})\t(.+)$/.exec(record)
    if (!match || (match[1] !== '100644' && match[1] !== '100755')) {
      const path = record.includes('\t') ? record.slice(record.indexOf('\t') + 1) : record
      throw new Error(`SOURCE_VIEW_UNSAFE_ENTRY: ${path}`)
    }
    const path = match[3]!
    if (isForbiddenPath(path)) throw new Error(`SOURCE_VIEW_FORBIDDEN_PATH: ${path}`)
    return {
      mode: match[1] as SourceViewFile['mode'],
      blob: match[2]!,
      path,
    }
  }).sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

function manifestHash(revision: string, files: readonly SourceViewFile[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ revision, files }))
    .digest('hex')
}

export function materializeSourceView(options: SourceViewOptions): SourceViewManifest {
  mkdirSync(options.destination, { recursive: true })
  if (readdirSync(options.destination).length > 0) {
    throw new Error(`SOURCE_VIEW_DESTINATION_NOT_EMPTY: ${options.destination}`)
  }

  const revision = (git(
    options.repositoryRoot,
    ['rev-parse', '--verify', `${options.revision}^{commit}`],
    'utf8',
  ) as string).trim()
  const files = treeEntries(
    options.repositoryRoot,
    revision,
    options.paths ?? DEFAULT_SOURCE_VIEW_PATHS,
  )
  if (files.length === 0) throw new Error(`SOURCE_VIEW_EMPTY: ${revision}`)

  for (const file of files) {
    const destination = join(options.destination, ...file.path.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(
      destination,
      git(options.repositoryRoot, ['cat-file', 'blob', file.blob]) as Buffer,
      { mode: file.mode === '100755' ? 0o555 : 0o444 },
    )
    chmodSync(destination, file.mode === '100755' ? 0o555 : 0o444)
  }

  const manifest: SourceViewManifest = {
    revision,
    hash: manifestHash(revision, files),
    files,
  }
  const manifestPath = join(options.destination, 'source-view-manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 })
  chmodSync(manifestPath, 0o444)
  return manifest
}

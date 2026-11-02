import { createHash } from 'node:crypto'
import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

export interface FrozenCandidateRevision {
  capabilityId: string
  root: string
  files: Array<{ path: string; sha256: string }>
  codeHash: string
}

const ALLOWED = new Set(['tool.ts', 'tool.test.ts', 'manifest.json'])

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function filesAt(root: string): Array<{ path: string; content: Buffer }> {
  const resolved = resolve(root)
  if (!lstatSync(resolved).isDirectory() || lstatSync(resolved).isSymbolicLink()) {
    throw new Error('CANDIDATE_REVISION_ROOT_DENIED')
  }
  const files = readdirSync(resolved, { withFileTypes: true }).map(entry => {
    const absolute = join(resolved, entry.name)
    const path = relative(resolved, absolute).split(sep).join('/')
    const stats = lstatSync(absolute)
    if (!stats.isFile() || stats.isSymbolicLink() || !ALLOWED.has(path)) {
      throw new Error(`CANDIDATE_REVISION_PATH_DENIED: ${path}`)
    }
    return { path, content: readFileSync(absolute) }
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'))
  if (!files.some(file => file.path === 'tool.ts')) throw new Error('CANDIDATE_REVISION_IMPLEMENTATION_REQUIRED')
  if (!files.some(file => file.path === 'tool.test.ts')) throw new Error('CANDIDATE_REVISION_TEST_REQUIRED')
  return files
}

export function freezeCandidateRevision(input: {
  capabilityId: string
  candidateRoot: string
  frozenRoot: string
}): FrozenCandidateRevision {
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(input.capabilityId)) throw new Error('CANDIDATE_REVISION_CAPABILITY_INVALID')
  const files = filesAt(input.candidateRoot)
  const destination = resolve(input.frozenRoot)
  mkdirSync(destination, { recursive: true })
  cpSync(resolve(input.candidateRoot), destination, { recursive: true, dereference: false, errorOnExist: false, force: true })
  const manifest = files.map(file => ({ path: file.path, sha256: digest(file.content) }))
  return {
    capabilityId: input.capabilityId,
    root: destination,
    files: manifest,
    codeHash: digest(JSON.stringify(manifest)),
  }
}

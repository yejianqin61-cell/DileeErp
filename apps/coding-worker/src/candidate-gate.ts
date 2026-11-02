import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

export type CandidateGateErrorCode =
  | 'CANDIDATE_CODE_DENIED'
  | 'CANDIDATE_HASH_MISMATCH'
  | 'CANDIDATE_PATH_DENIED'
  | 'CANDIDATE_VALIDATION_FAILED'
  | 'SOURCE_BASELINE_MISMATCH'

export class CandidateGateError extends Error {
  constructor(readonly code: CandidateGateErrorCode, message: string = code) {
    super(message)
    this.name = 'CandidateGateError'
  }
}

export interface CandidateManifest {
  candidateId: string
  sourceRevision: string
  capabilities: string[]
  files: Array<{ path: string; sha256: string }>
  manifestHash: string
}

export interface CandidateTestResult {
  passed: boolean
}

export interface CandidateGateReport {
  accepted: true
  candidateId: string
  sourceRevision: string
  capabilities: string[]
  files: Array<{ path: string; sha256: string }>
  manifestHash: string
  testsPassed: true
  permissionsPassed: true
}

export interface CandidateGateOptions {
  repositoryRoot: string
  candidateRoot: string
  manifest: CandidateManifest
  expectedSourceRevision: string
  runTests(): Promise<CandidateTestResult>
  runPermissionChecks(): Promise<CandidateTestResult>
}

const ALLOWED_FILES = new Set(['tool.ts', 'tool.test.ts'])
const ALLOWED_CAPABILITIES = ['get_employee_output_summary']
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const ALLOWED_BUILTINS = new Set(['node:crypto', 'node:util'])
const FORBIDDEN_CODE = /\b(?:require|createRequire|process|fetch|eval|Function|WebSocket|globalThis|child_process)\b|\bnode:(?:fs|net|http|https|tls|child_process|module|vm|worker_threads)\b/

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableManifestHash(manifest: Omit<CandidateManifest, 'manifestHash'>): string {
  return sha256(JSON.stringify({
    candidateId: manifest.candidateId,
    sourceRevision: manifest.sourceRevision,
    capabilities: [...manifest.capabilities].sort(),
    files: [...manifest.files].sort((left, right) => left.path.localeCompare(right.path, 'en')),
  }))
}

function readCandidateFiles(candidateRoot: string): Array<{ path: string; content: Buffer }> {
  const root = resolve(candidateRoot)
  const rootStats = lstatSync(root)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new CandidateGateError('CANDIDATE_PATH_DENIED', 'candidate root must be a real directory')
  }
  const files: Array<{ path: string; content: Buffer }> = []
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name)
      const path = relative(root, absolutePath).split(sep).join('/')
      const stats = lstatSync(absolutePath)
      if (stats.isSymbolicLink() || !ALLOWED_FILES.has(path) || !stats.isFile()) {
        throw new CandidateGateError('CANDIDATE_PATH_DENIED', `candidate path denied: ${path}`)
      }
      files.push({ path, content: readFileSync(absolutePath) })
    }
  }
  visit(root)
  files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  if (files.length !== 2 || !files.some(file => file.path === 'tool.ts') || !files.some(file => file.path === 'tool.test.ts')) {
    throw new CandidateGateError('CANDIDATE_PATH_DENIED', 'candidate must contain tool.ts and tool.test.ts')
  }
  return files
}

function validateCandidateCode(source: string): void {
  if (FORBIDDEN_CODE.test(source)) {
    throw new CandidateGateError('CANDIDATE_CODE_DENIED', 'candidate uses a denied process, filesystem, or network API')
  }
  const moduleReferences = [
    ...source.matchAll(/\b(?:from\s*|import\s*\(\s*)(['"])([^'"]+)\1/g),
  ]
  if (moduleReferences.some(match => !ALLOWED_BUILTINS.has(match[2]!))) {
    throw new CandidateGateError('CANDIDATE_CODE_DENIED', 'candidate imports an unapproved module')
  }
  const staticImports = source.match(/\bimport\s+(?!\()/g)?.length ?? 0
  const matchedStaticImports = source.match(/\bimport\s+(?:[^;\n]*?\s+from\s*)?(['"])[^'"]+\1/g)?.length ?? 0
  const dynamicImports = source.match(/\bimport\s*\(/g)?.length ?? 0
  const matchedDynamicImports = source.match(/\bimport\s*\(\s*(['"])[^'"]+\1\s*\)/g)?.length ?? 0
  if (staticImports !== matchedStaticImports || dynamicImports !== matchedDynamicImports) {
    throw new CandidateGateError('CANDIDATE_CODE_DENIED', 'candidate uses a non-literal module loader')
  }
}

export function createCandidateManifest(input: {
  candidateRoot: string
  sourceRevision: string
  capabilities: readonly string[]
}): CandidateManifest {
  if (!GIT_REVISION.test(input.sourceRevision)) {
    throw new CandidateGateError('SOURCE_BASELINE_MISMATCH', 'source revision must be a full Git object id')
  }
  if (input.capabilities.length !== 1 || input.capabilities[0] !== ALLOWED_CAPABILITIES[0]) {
    throw new CandidateGateError('CANDIDATE_VALIDATION_FAILED', 'candidate capability set is not approved')
  }
  const files = readCandidateFiles(input.candidateRoot).map(({ path, content }) => {
    if (path === 'tool.ts') validateCandidateCode(content.toString('utf8'))
    return { path, sha256: sha256(content) }
  })
  const base = {
    candidateId: 'order-a-employee-output-v1',
    sourceRevision: input.sourceRevision,
    capabilities: [...input.capabilities],
    files,
  }
  return { ...base, manifestHash: stableManifestHash(base) }
}

export async function evaluateCandidate(options: CandidateGateOptions): Promise<CandidateGateReport> {
  if (!GIT_REVISION.test(options.expectedSourceRevision)
    || options.manifest.sourceRevision !== options.expectedSourceRevision) {
    throw new CandidateGateError('SOURCE_BASELINE_MISMATCH')
  }
  let resolvedRevision: string
  try {
    resolvedRevision = execFileSync(
      'git',
      ['rev-parse', '--verify', `${options.expectedSourceRevision}^{commit}`],
      { cwd: options.repositoryRoot, encoding: 'utf8', windowsHide: true },
    ).trim()
  } catch {
    throw new CandidateGateError('SOURCE_BASELINE_MISMATCH', 'source revision is not present in the ERP repository')
  }
  if (resolvedRevision !== options.expectedSourceRevision) {
    throw new CandidateGateError('SOURCE_BASELINE_MISMATCH', 'source revision did not resolve exactly')
  }
  const actual = createCandidateManifest({
    candidateRoot: options.candidateRoot,
    sourceRevision: options.expectedSourceRevision,
    capabilities: options.manifest.capabilities,
  })
  if (actual.candidateId !== options.manifest.candidateId
    || actual.manifestHash !== options.manifest.manifestHash
    || JSON.stringify(actual.files) !== JSON.stringify(options.manifest.files)) {
    throw new CandidateGateError('CANDIDATE_HASH_MISMATCH')
  }
  const testResult = await options.runTests()
  const permissionResult = await options.runPermissionChecks()
  if (!testResult.passed || !permissionResult.passed) {
    throw new CandidateGateError('CANDIDATE_VALIDATION_FAILED')
  }
  return {
    accepted: true,
    candidateId: actual.candidateId,
    sourceRevision: actual.sourceRevision,
    capabilities: actual.capabilities,
    files: actual.files,
    manifestHash: actual.manifestHash,
    testsPassed: true,
    permissionsPassed: true,
  }
}

import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildCodingContainerArgs, selectCodingHostEnvironment } from './container-policy.ts'
import { materializeSourceView } from './source-view.ts'

export interface GeneratedCandidateSliceResult {
  readonly sourceReadable: boolean
  readonly sourceWriteDenied: boolean
  readonly candidateWriteDenied: boolean
  readonly networkDenied: boolean
  readonly databaseCredentialAbsent: boolean
  readonly generatedTestPassed: true
}

function probeScript(): string {
  return `
import('node:fs').then(async fs => {
let sourceWriteDenied = false;
let candidateWriteDenied = false;
let networkDenied = false;
try { fs.writeFileSync('/workspace/source/source-write-probe', 'x'); } catch { sourceWriteDenied = true; }
try { fs.writeFileSync('/workspace/candidate/tool.ts', 'x'); } catch { candidateWriteDenied = true; }
try { await fetch('https://example.com', { signal: AbortSignal.timeout(1000) }); } catch { networkDenied = true; }
process.stdout.write(JSON.stringify({
  sourceReadable: fs.existsSync('/workspace/source/apps/api/src/modules/business-query-agent/access-level.ts'),
  sourceWriteDenied,
  candidateWriteDenied,
  networkDenied,
  databaseCredentialAbsent: process.env.DATABASE_URL === undefined
    && process.env.AGENT_READ_DATABASE_URL === undefined
    && process.env.COOKIE_SECRET === undefined
    && process.env.USER_ACCESS_TOKEN === undefined,
  generatedTestPassed: true,
}));
});
`
}

export function runGeneratedCandidateInLinux(input: {
  repositoryRoot: string
  candidateRoot: string
  sourceRevision: string
  dockerExecutable?: string
}): GeneratedCandidateSliceResult {
  const docker = input.dockerExecutable ?? 'docker'
  const engine = execFileSync(docker, ['info', '--format', '{{.OSType}}'], {
    encoding: 'utf8', env: selectCodingHostEnvironment(process.env), windowsHide: true,
  }).trim()
  if (engine !== 'linux') throw new Error(`LINUX_DOCKER_ENGINE_REQUIRED: ${engine || 'unknown'}`)
  const root = mkdtempSync(join(tmpdir(), 'dilee-generated-candidate-'))
  const paths = { source: join(root, 'source'), candidate: join(root, 'candidate'), state: join(root, 'state') }
  try {
    mkdirSync(paths.candidate); mkdirSync(paths.state)
    for (const file of ['tool.ts', 'tool.test.ts']) {
      const destination = join(paths.candidate, file)
      copyFileSync(join(input.candidateRoot, file), destination)
      chmodSync(destination, 0o444)
    }
    chmodSync(paths.candidate, 0o555); chmodSync(paths.state, 0o777)
    materializeSourceView({ repositoryRoot: input.repositoryRoot, destination: paths.source, revision: input.sourceRevision })
    const encodedProbe = Buffer.from(probeScript(), 'utf8').toString('base64')
    const command = `node --experimental-strip-types --test /workspace/candidate/tool.test.ts >/tmp/generated-test.log 2>&1; node --experimental-strip-types --input-type=module -e "eval(Buffer.from('${encodedProbe}', 'base64').toString())"`
    const stdout = execFileSync(docker, buildCodingContainerArgs(paths, ['sh', '-ec', command], [], { candidateReadOnly: true }), {
      encoding: 'utf8', env: selectCodingHostEnvironment(process.env), windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024,
    })
    return JSON.parse(stdout) as GeneratedCandidateSliceResult
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`GENERATED_CANDIDATE_LINUX_RUN_FAILED: ${message}`, { cause: error })
  } finally {
    chmodSync(paths.candidate, 0o755)
    rmSync(root, { recursive: true, force: true })
  }
}

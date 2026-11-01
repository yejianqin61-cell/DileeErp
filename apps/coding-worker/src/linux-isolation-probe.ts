import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildCodingContainerArgs,
  selectCodingHostEnvironment,
} from './container-policy.ts'
import { materializeSourceView } from './source-view.ts'

export interface LinuxIsolationProbeOptions {
  repositoryRoot: string
  revision: string
  dockerExecutable?: string
}

export interface LinuxIsolationProbeResult {
  engine: string
  sourceReadable: boolean
  candidateWritable: boolean
  stateWritable: boolean
  sourceWriteDenied: boolean
  rootWriteDenied: boolean
  envFileAbsent: boolean
  databaseCredentialAbsent: boolean
  userTokenAbsent: boolean
  networkDenied: boolean
}

const PROBE = String.raw`
const fs = require('node:fs');

function canRead(path) {
  try { fs.readFileSync(path); return true; } catch { return false; }
}

function canWrite(path) {
  try { fs.writeFileSync(path, 'probe'); return true; } catch { return false; }
}

(async () => {
  let networkDenied = false;
  try {
    await fetch('https://example.com', { signal: AbortSignal.timeout(3000) });
  } catch {
    networkDenied = true;
  }
  const sourceWrite = canWrite('/workspace/source/write-probe');
  const rootWrite = canWrite('/root-write-probe');
  const result = {
    sourceReadable: canRead('/workspace/source/source-view-manifest.json'),
    candidateWritable: canWrite('/workspace/candidate/candidate-probe'),
    stateWritable: canWrite('/workspace/state/state-probe'),
    sourceWriteDenied: !sourceWrite,
    rootWriteDenied: !rootWrite,
    envFileAbsent: !canRead('/workspace/source/.env'),
    databaseCredentialAbsent: process.env.DATABASE_URL === undefined
      && process.env.AGENT_READ_DATABASE_URL === undefined,
    userTokenAbsent: process.env.USER_ACCESS_TOKEN === undefined
      && process.env.COOKIE_SECRET === undefined,
    networkDenied,
  };
  process.stdout.write(JSON.stringify(result));
})().catch(error => {
  process.stderr.write(String(error && error.stack || error));
  process.exitCode = 1;
});
`

function runDocker(
  executable: string,
  args: readonly string[],
  timeout: number,
): { stdout: string; stderr: string } {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: selectCodingHostEnvironment(process.env),
    timeout,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`LINUX_ISOLATION_PROBE_FAILED (${result.status}): ${result.stderr || result.stdout}`)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

export function runLinuxIsolationProbe(
  options: LinuxIsolationProbeOptions,
): LinuxIsolationProbeResult {
  const docker = options.dockerExecutable ?? 'docker'
  const engine = runDocker(docker, ['info', '--format', '{{.OSType}}'], 30_000).stdout.trim()
  if (engine !== 'linux') throw new Error(`LINUX_DOCKER_ENGINE_REQUIRED: ${engine || 'unknown'}`)

  const root = mkdtempSync(join(tmpdir(), 'dilee-linux-isolation-'))
  const paths = {
    source: join(root, 'source'),
    candidate: join(root, 'candidate'),
    state: join(root, 'state'),
  }
  try {
    mkdirSync(paths.candidate)
    mkdirSync(paths.state)
    chmodSync(paths.candidate, 0o777)
    chmodSync(paths.state, 0o777)
    materializeSourceView({
      repositoryRoot: options.repositoryRoot,
      destination: paths.source,
      revision: options.revision,
    })

    const output = runDocker(
      docker,
      buildCodingContainerArgs(paths, ['node', '-e', PROBE]),
      180_000,
    ).stdout
    return {
      engine,
      ...JSON.parse(output) as Omit<LinuxIsolationProbeResult, 'engine'>,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

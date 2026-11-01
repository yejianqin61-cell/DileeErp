export const CODING_CONTAINER_IMAGE = 'node:24.9.0-alpine'

export interface CodingContainerPaths {
  source: string
  candidate: string
  state: string
}

const HOST_RUNTIME_ENVIRONMENT = new Set([
  'COMSPEC',
  'ComSpec',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'PATH',
  'PATHEXT',
  'Path',
  'SYSTEMROOT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
])

const MODEL_CREDENTIALS = new Set([
  'DEEPSEEK_API_KEY',
])

function assertCredentialNames(names: readonly string[]): void {
  for (const name of names) {
    if (!MODEL_CREDENTIALS.has(name)) {
      throw new Error(`CODING_CREDENTIAL_NOT_ALLOWED: ${name}`)
    }
  }
}

function mount(source: string, destination: string, readonly = false): string {
  if (!source || /[,\r\n]/.test(source)) {
    throw new Error(`CODING_MOUNT_PATH_INVALID: ${source}`)
  }
  return `type=bind,src=${source},dst=${destination}${readonly ? ',readonly' : ''}`
}

export function selectCodingHostEnvironment(
  source: NodeJS.ProcessEnv,
  modelCredentialNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  assertCredentialNames(modelCredentialNames)
  const allowed = new Set([...HOST_RUNTIME_ENVIRONMENT, ...modelCredentialNames])
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => allowed.has(entry[0]) && entry[1] !== undefined,
    ),
  )
}

export function buildCodingContainerArgs(
  paths: CodingContainerPaths,
  command: readonly string[],
  modelCredentialNames: readonly string[] = [],
): string[] {
  if (command.length === 0) throw new Error('CODING_CONTAINER_COMMAND_REQUIRED')
  assertCredentialNames(modelCredentialNames)
  return [
    'run',
    '--rm',
    '--init',
    '--network', 'none',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--user', '65532:65532',
    '--pids-limit', '128',
    '--memory', '512m',
    '--cpus', '1',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--mount', mount(paths.source, '/workspace/source', true),
    '--mount', mount(paths.candidate, '/workspace/candidate'),
    '--mount', mount(paths.state, '/workspace/state'),
    '--workdir', '/workspace/candidate',
    '--env', 'HOME=/workspace/state',
    '--env', 'TMPDIR=/tmp',
    '--env', 'DILEE_CODING_SANDBOX=1',
    ...modelCredentialNames.flatMap(name => ['--env', name]),
    CODING_CONTAINER_IMAGE,
    ...command,
  ]
}

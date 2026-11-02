import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CODING_CONTAINER_IMAGE,
  buildCodingContainerArgs,
  selectCodingHostEnvironment,
} from '../src/container-policy.ts'

const paths = {
  source: 'C:\\sandbox\\source',
  candidate: 'C:\\sandbox\\candidate',
  state: 'C:\\sandbox\\state',
}

function optionValue(args: readonly string[], option: string): string {
  const index = args.indexOf(option)
  assert.notEqual(index, -1, `${option} is missing`)
  return args[index + 1]!
}

test('mounts source read-only and keeps only candidate and state writable', () => {
  const args = buildCodingContainerArgs(paths, ['node', 'probe.mjs'])
  const mounts = args.filter((arg, index) => args[index - 1] === '--mount')

  assert.deepEqual(mounts, [
    'type=bind,src=C:\\sandbox\\source,dst=/workspace/source,readonly',
    'type=bind,src=C:\\sandbox\\candidate,dst=/workspace/candidate',
    'type=bind,src=C:\\sandbox\\state,dst=/workspace/state',
  ])
  assert.equal(optionValue(args, '--workdir'), '/workspace/candidate')
})

test('mounts a completed candidate read-only during independent validation', () => {
  const args = buildCodingContainerArgs(paths, ['node', 'probe.mjs'], [], {
    candidateReadOnly: true,
  })
  const mounts = args.filter((arg, index) => args[index - 1] === '--mount')

  assert.deepEqual(mounts, [
    'type=bind,src=C:\\sandbox\\source,dst=/workspace/source,readonly',
    'type=bind,src=C:\\sandbox\\candidate,dst=/workspace/candidate,readonly',
    'type=bind,src=C:\\sandbox\\state,dst=/workspace/state',
  ])
})

test('uses a fixed non-root, offline and read-only container policy', () => {
  const args = buildCodingContainerArgs(paths, ['node', 'probe.mjs'])

  assert.equal(CODING_CONTAINER_IMAGE, 'node:24.9.0-alpine')
  assert.ok(args.includes('--read-only'))
  assert.equal(optionValue(args, '--network'), 'none')
  assert.equal(optionValue(args, '--user'), '65532:65532')
  assert.equal(optionValue(args, '--cap-drop'), 'ALL')
  assert.equal(optionValue(args, '--security-opt'), 'no-new-privileges')
  assert.equal(optionValue(args, '--pids-limit'), '128')
  assert.equal(optionValue(args, '--memory'), '512m')
  assert.equal(optionValue(args, '--cpus'), '1')
  assert.match(optionValue(args, '--tmpfs'), /^\/tmp:rw,noexec,nosuid,nodev,size=64m$/)
  assert.deepEqual(args.slice(-3), [CODING_CONTAINER_IMAGE, 'node', 'probe.mjs'])
})

test('permits a build container only on an explicitly named model relay network', () => {
  const args = buildCodingContainerArgs(paths, ['node', 'probe.mjs'], ['DILEE_MODEL_RELAY_TOKEN'], {
    modelRelayNetwork: 'dilee-model-relay',
  })

  assert.equal(optionValue(args, '--network'), 'dilee-model-relay')
  assert.ok(args.includes('DILEE_MODEL_RELAY_TOKEN'))
  assert.throws(
    () => buildCodingContainerArgs(paths, ['node'], [], { modelRelayNetwork: 'bad network' }),
    /CODING_MODEL_RELAY_NETWORK_INVALID/,
  )
})

test('does not pass ERP credentials or user tokens into the container host process', () => {
  const selected = selectCodingHostEnvironment({
    PATH: 'runtime-path',
    SystemRoot: 'C:\\Windows',
    DATABASE_URL: 'postgres://production',
    AGENT_READ_DATABASE_URL: 'postgres://readonly',
    COOKIE_SECRET: 'cookie-secret',
    USER_ACCESS_TOKEN: 'user-token',
    DEPLOY_PRIVATE_KEY: 'private-key',
    DEEPSEEK_API_KEY: 'model-secret',
  }, ['DEEPSEEK_API_KEY'])

  assert.deepEqual(selected, {
    PATH: 'runtime-path',
    SystemRoot: 'C:\\Windows',
    DEEPSEEK_API_KEY: 'model-secret',
  })
})

test('passes only explicitly named model credentials to the container', () => {
  const args = buildCodingContainerArgs(
    paths,
    ['node', 'probe.mjs'],
    ['DEEPSEEK_API_KEY'],
  )
  const environment = args.filter((arg, index) => args[index - 1] === '--env')

  assert.deepEqual(environment, [
    'HOME=/workspace/state',
    'TMPDIR=/tmp',
    'DILEE_CODING_SANDBOX=1',
    'DEEPSEEK_API_KEY',
  ])
  assert.throws(
    () => buildCodingContainerArgs(paths, ['node'], ['DATABASE_URL']),
    /CODING_CREDENTIAL_NOT_ALLOWED/,
  )
})

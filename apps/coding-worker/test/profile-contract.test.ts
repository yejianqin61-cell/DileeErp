import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const dshManifest = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const dshBin = join(dirname(dshManifest), 'lib', 'bin.js')
const patchPath = join(packageRoot, 'config', 'coding-agents.cordis.patch.yml')
const dshHome = mkdtempSync(join(tmpdir(), 'dilee-profile-contract-'))

const dump = spawnSync(
  process.execPath,
  [dshBin, '--profile', 'sdk', '--patch', patchPath, '--dump-config'],
  {
    cwd: packageRoot,
    env: { ...process.env, DSH_HOME: dshHome },
    encoding: 'utf8',
  },
)
rmSync(dshHome, { recursive: true, force: true })

assert.equal(dump.status, 0, dump.stderr)
const config = dump.stdout.replaceAll('\r\n', '\n')

function topLevelEntry(id: string): string {
  const marker = `\n- id: ${id}\n`
  const markerStart = config.indexOf(marker)
  assert.notEqual(markerStart, -1, `missing top-level entry ${id}`)
  const start = markerStart + 1
  const end = config.indexOf('\n- id: ', start + marker.length - 1)
  return config.slice(start, end === -1 ? undefined : end)
}

test('declares the host orchestrator and two child presets', () => {
  assert.match(topLevelEntry('system-prompt'), /ERP Tool Coding Orchestrator/)
  assert.match(topLevelEntry('agent-preset-registry'), /default: tool-builder/)
  assert.match(topLevelEntry('preset-tool-builder'), /id: tool-builder/)
  assert.match(topLevelEntry('preset-tool-validator'), /id: tool-validator/)
})

test('gives the orchestrator only the controlled coding-job actions', () => {
  assert.match(topLevelEntry('build-tool'), /disabled: true/)
  assert.match(topLevelEntry('validate-tool'), /disabled: true/)
  assert.match(
    topLevelEntry('coding-job-policy'),
    /controlled-coding-tools\.mjs[\s\S]*maxReworks: 1/,
  )
})

test('prevents builder and validator presets from delegating', () => {
  for (const id of ['preset-tool-builder', 'preset-tool-validator']) {
    assert.doesNotMatch(topLevelEntry(id), /@deepseek-ai\/dsh-tool-subagent/)
  }
})

test('disables the generic host delegation tools', () => {
  assert.match(topLevelEntry('tool-subagent'), /disabled: true/)
  assert.match(topLevelEntry('tool-subagent-fork'), /disabled: true/)
})

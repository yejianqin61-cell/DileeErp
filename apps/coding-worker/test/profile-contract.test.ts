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
  const marker = `- id: ${id}\n`
  const start = config.indexOf(marker)
  assert.notEqual(start, -1, `missing top-level entry ${id}`)
  const end = config.indexOf('\n- id: ', start + marker.length)
  return config.slice(start, end === -1 ? undefined : end)
}

test('declares the orchestrator, builder, and validator presets', () => {
  assert.match(topLevelEntry('agent-preset-registry'), /default: coding-orchestrator/)
  assert.match(topLevelEntry('preset-coding-orchestrator'), /id: coding-orchestrator/)
  assert.match(topLevelEntry('preset-tool-builder'), /id: tool-builder/)
  assert.match(topLevelEntry('preset-tool-validator'), /id: tool-validator/)
})

test('gives the orchestrator only the two fixed delegation targets', () => {
  const orchestrator = topLevelEntry('preset-coding-orchestrator')
  assert.match(orchestrator, /toolName: build_tool[\s\S]*agentPreset: tool-builder/)
  assert.match(orchestrator, /toolName: validate_tool[\s\S]*agentPreset: tool-validator/)
  assert.deepEqual([...orchestrator.matchAll(/toolName: (\S+)/g)].map(match => match[1]), [
    'build_tool',
    'validate_tool',
  ])
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

import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const filters = process.argv.slice(2)
const tests = readdirSync(new URL('.', import.meta.url))
  .filter(name => name.endsWith('.test.ts'))
  .filter(name => filters.length === 0 || filters.some(filter => name.includes(filter)))
  .map(name => fileURLToPath(new URL(name, import.meta.url)))

if (tests.length === 0) throw new Error(`No tests matched: ${filters.join(', ')}`)

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], {
  stdio: 'inherit',
})

process.exitCode = result.status ?? 1

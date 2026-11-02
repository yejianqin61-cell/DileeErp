import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

export const PHASE1_BASELINE_SOURCE = 'dilee_snapshot'

export interface Phase1DataBaseline {
  sourceDatabase: string
  targetDatabase: string
  reportCount: number
  scopeCount: number
  fingerprint: string
}

export type DatabaseCommand = (args: readonly string[]) => string

function assertTestDatabase(name: string, source: string): void {
  if (!/^dilee_[a-z0-9_]*test[a-z0-9_]*$/.test(name) || name === source) {
    throw new Error(`PHASE1_TEST_DATABASE_REQUIRED: ${name}`)
  }
}

function parseCounts(output: string): { reportCount: number; scopeCount: number } {
  const [reports, scopes] = output.trim().split('|').map(Number)
  if (!Number.isSafeInteger(reports) || reports < 0 || !Number.isSafeInteger(scopes) || scopes < 0) {
    throw new Error('PHASE1_BASELINE_QUERY_INVALID')
  }
  return { reportCount: reports, scopeCount: scopes }
}

const BASELINE_COUNTS_SQL = `SELECT count(*) FILTER (WHERE deleted_at IS NULL), count(DISTINCT (order_no, operation_name_snapshot)) FILTER (WHERE deleted_at IS NULL) FROM employee_daily_reports;`

export function createPhase1DataBaseline(
  targetDatabase: string,
  command: DatabaseCommand,
): Phase1DataBaseline {
  const sourceDatabase = PHASE1_BASELINE_SOURCE
  assertTestDatabase(targetDatabase, sourceDatabase)
  command(['-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${targetDatabase} WITH (FORCE);`])
  command(['-d', 'postgres', '-c', `CREATE DATABASE ${targetDatabase} TEMPLATE ${sourceDatabase};`])
  const counts = parseCounts(command(['-d', targetDatabase, '-X', '-A', '-t', '-c', BASELINE_COUNTS_SQL]))
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ sourceDatabase, ...counts }))
    .digest('hex')
  return { sourceDatabase, targetDatabase, ...counts, fingerprint }
}

export function localPostgresCommand(container: string, user: string): DatabaseCommand {
  return args => execFileSync('docker', ['exec', container, 'psql', '-U', user, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
}

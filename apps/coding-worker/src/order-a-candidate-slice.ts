import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildCodingContainerArgs, selectCodingHostEnvironment } from './container-policy.ts'
import { materializeSourceView } from './source-view.ts'

export interface OrderACandidateSliceOptions {
  repositoryRoot: string
  candidateRoot: string
  sourceRevision: string
  dockerExecutable?: string
}

export interface OrderACandidateSliceResult {
  fact: {
    operation: string
    order_no: string
    as_of: string
    data: {
      operation_name: string
      daily: Array<Record<string, string>>
      employee_totals: Array<Record<string, string>>
    }
    sources: Array<Record<string, string>>
    access_level: 'operational' | 'full'
  }
  sourceReadable: boolean
  sourceWriteDenied: boolean
  candidateWriteDenied: boolean
  networkDenied: boolean
  databaseCredentialAbsent: boolean
}

const AS_OF = '2026-11-02T00:00:00.000Z'
const FIXTURE = {
  operation: 'production.read_employee_output_summary',
  scope: { orderNo: 'SO-A-001', operationName: '包装' },
  accessLevel: 'operational',
  rows: [
    {
      kind: 'daily', reportIds: ['r-1'], productionOrderNo: 'PO-A-001',
      employeeId: 'e-1', employeeName: '员工甲', reportDate: '2026-10-30', quantity: '12.0000',
    },
    {
      kind: 'daily', reportIds: ['r-2'], productionOrderNo: 'PO-A-001',
      employeeId: 'e-1', employeeName: '员工甲', reportDate: '2026-10-31', quantity: '8.0000',
    },
    {
      kind: 'daily', reportIds: ['r-3'], productionOrderNo: 'PO-A-001',
      employeeId: 'e-2', employeeName: '员工乙', reportDate: '2026-10-31', quantity: '5.0000',
    },
    {
      kind: 'employee_total', reportIds: [], productionOrderNo: 'PO-A-001',
      employeeId: 'e-1', employeeName: '员工甲', reportDate: null, quantity: '20.0000',
    },
    {
      kind: 'employee_total', reportIds: [], productionOrderNo: 'PO-A-001',
      employeeId: 'e-2', employeeName: '员工乙', reportDate: null, quantity: '5.0000',
    },
  ],
  sources: [
    { businessType: 'employee_daily_report', businessNo: 'r-1' },
    { businessType: 'employee_daily_report', businessNo: 'r-2' },
    { businessType: 'employee_daily_report', businessNo: 'r-3' },
    { businessType: 'employee_daily_report', businessNo: 'SO-A-001:包装:e-1:total' },
    { businessType: 'employee_daily_report', businessNo: 'SO-A-001:包装:e-2:total' },
  ],
  truncated: false,
}

function probeScript(): string {
  return `
const fs = await import('node:fs');
const { runTool } = await import('/workspace/candidate/tool.ts');
let sourceWriteDenied = false;
let candidateWriteDenied = false;
let networkDenied = false;
try { fs.writeFileSync('/workspace/source/source-write-probe', 'x'); } catch { sourceWriteDenied = true; }
try { fs.writeFileSync('/workspace/candidate/tool.ts', 'x'); } catch { candidateWriteDenied = true; }
try { await fetch('https://example.com', { signal: AbortSignal.timeout(1000) }); } catch { networkDenied = true; }
const fixture = ${JSON.stringify(FIXTURE)};
const fact = await runTool(
  { order_no: 'SO-A-001', operation_name: '包装' },
  { read: async () => fixture },
  { now: () => new Date('${AS_OF}') },
);
process.stdout.write(JSON.stringify({
  fact,
  sourceReadable: fs.existsSync('/workspace/source/apps/api/src/modules/business-query-agent/access-level.ts'),
  sourceWriteDenied,
  candidateWriteDenied,
  networkDenied,
  databaseCredentialAbsent: process.env.DATABASE_URL === undefined
    && process.env.AGENT_READ_DATABASE_URL === undefined
    && process.env.COOKIE_SECRET === undefined
    && process.env.USER_ACCESS_TOKEN === undefined,
}));
`
}

export function runOrderACandidateInLinux(
  options: OrderACandidateSliceOptions,
): OrderACandidateSliceResult {
  const docker = options.dockerExecutable ?? 'docker'
  const engine = execFileSync(docker, ['info', '--format', '{{.OSType}}'], {
    encoding: 'utf8',
    env: selectCodingHostEnvironment(process.env),
    windowsHide: true,
  }).trim()
  if (engine !== 'linux') throw new Error(`LINUX_DOCKER_ENGINE_REQUIRED: ${engine || 'unknown'}`)

  const root = mkdtempSync(join(tmpdir(), 'dilee-order-a-candidate-'))
  const paths = {
    source: join(root, 'source'),
    candidate: join(root, 'candidate'),
    state: join(root, 'state'),
  }
  try {
    mkdirSync(paths.candidate)
    mkdirSync(paths.state)
    copyFileSync(join(options.candidateRoot, 'tool.ts'), join(paths.candidate, 'tool.ts'))
    chmodSync(join(paths.candidate, 'tool.ts'), 0o444)
    chmodSync(paths.candidate, 0o555)
    chmodSync(paths.state, 0o777)
    materializeSourceView({
      repositoryRoot: options.repositoryRoot,
      destination: paths.source,
      revision: options.sourceRevision,
    })
    const args = buildCodingContainerArgs(
      paths,
      ['node', '--experimental-strip-types', '--input-type=module', '-e', probeScript()],
      [],
      { candidateReadOnly: true },
    )
    const stdout = execFileSync(docker, args, {
      encoding: 'utf8',
      env: selectCodingHostEnvironment(process.env),
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
    })
    return JSON.parse(stdout) as OrderACandidateSliceResult
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`ORDER_A_CANDIDATE_LINUX_RUN_FAILED: ${message}`, { cause: error })
  } finally {
    chmodSync(paths.candidate, 0o755)
    rmSync(root, { recursive: true, force: true })
  }
}

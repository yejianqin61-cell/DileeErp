import { execFileSync } from 'node:child_process'

import type { RestrictedDataAdapter, RestrictedDataRequest } from './restricted-data-gateway.ts'

export const PHASE1_TEST_DATABASE = 'dilee_phase1_test'
export const PHASE1_READER_ROLE = 'dilee_phase1_reader'

export type PostgresCommand = (args: readonly string[]) => string

function literal(value: string): string {
  if (value.includes('\0')) throw new Error('POSTGRES_SCOPE_VALUE_INVALID')
  return `'${value.replaceAll("'", "''")}'`
}

function query(request: RestrictedDataRequest): string {
  const filters = `deleted_at IS NULL AND order_no = ${literal(request.scope.orderNo)} AND operation_name_snapshot = ${literal(request.scope.operationName)}`
  const daily = `json_build_object('kind', 'daily', 'reportIds', json_build_array(id::text), 'orderNo', order_no, 'productionOrderNo', production_order_no_snapshot, 'operationName', operation_name_snapshot, 'employeeId', employee_id::text, 'employeeName', employee_name_snapshot, 'reportDate', report_date::text, 'quantity', quantity::text)`
  if (request.operation === 'production.read_employee_output') {
    return `SELECT coalesce(json_agg(json_build_object('reportId', id::text, 'orderNo', order_no, 'productionOrderNo', production_order_no_snapshot, 'operationName', operation_name_snapshot, 'employeeId', employee_id::text, 'employeeName', employee_name_snapshot, 'reportDate', report_date::text, 'quantity', quantity::text) ORDER BY report_date, employee_id, id), '[]'::json)::text FROM (SELECT * FROM employee_daily_reports WHERE ${filters} ORDER BY report_date, employee_id, id LIMIT :limit) reports;`
  }
  return `WITH daily AS (SELECT ${daily} AS row FROM employee_daily_reports WHERE ${filters}), totals AS (SELECT json_build_object('kind', 'employee_total', 'orderNo', order_no, 'productionOrderNo', production_order_no_snapshot, 'operationName', operation_name_snapshot, 'employeeId', employee_id::text, 'employeeName', employee_name_snapshot, 'quantity', sum(quantity)::text) AS row FROM employee_daily_reports WHERE ${filters} GROUP BY order_no, production_order_no_snapshot, operation_name_snapshot, employee_id, employee_name_snapshot) SELECT coalesce(json_agg(row), '[]'::json)::text FROM (SELECT row FROM daily UNION ALL SELECT row FROM totals) rows;`
}

export function createPostgresRestrictedDataAdapter(options: {
  database: string
  command: PostgresCommand
}): RestrictedDataAdapter {
  if (options.database !== PHASE1_TEST_DATABASE) throw new Error('PHASE1_TEST_DATABASE_REQUIRED')
  return async request => JSON.parse(options.command([
    '-d', options.database, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
    '-c', query(request).replace('LIMIT :limit', `LIMIT ${String(request.limit)}`),
  ]).trim() || '[]') as Record<string, unknown>[]
}

export function provisionPhase1ReadOnlyRole(command: PostgresCommand): void {
  const exists = command([
    '-d', 'postgres', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
    '-c', `SELECT 1 FROM pg_roles WHERE rolname = '${PHASE1_READER_ROLE}';`,
  ]).trim() === '1'
  if (!exists) command([
    '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1',
    '-c', `CREATE ROLE ${PHASE1_READER_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;`,
  ])
  command([
    '-d', PHASE1_TEST_DATABASE, '-X', '-v', 'ON_ERROR_STOP=1',
    '-c', [
      `REVOKE CONNECT ON DATABASE ${PHASE1_TEST_DATABASE} FROM PUBLIC;`,
      `GRANT CONNECT ON DATABASE ${PHASE1_TEST_DATABASE} TO ${PHASE1_READER_ROLE};`,
      'REVOKE ALL ON SCHEMA public FROM PUBLIC;',
      `GRANT USAGE ON SCHEMA public TO ${PHASE1_READER_ROLE};`,
      'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;',
      `GRANT SELECT ON TABLE public.employee_daily_reports TO ${PHASE1_READER_ROLE};`,
    ].join(' '),
  ])
}

export function localPostgresRestrictedDataArgs(container: string, args: readonly string[]): string[] {
  return ['exec', container, 'psql', '-U', PHASE1_READER_ROLE, ...args]
}

export function localPostgresRestrictedDataCommand(container: string): PostgresCommand {
  return args => execFileSync('docker', localPostgresRestrictedDataArgs(container, args), {
    encoding: 'utf8', windowsHide: true,
  })
}

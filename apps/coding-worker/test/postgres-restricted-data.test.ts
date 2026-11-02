import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createPostgresRestrictedDataAdapter,
  localPostgresRestrictedDataArgs,
  localPostgresRestrictedDataCommand,
  PHASE1_READER_ROLE,
  provisionPhase1ReadOnlyRole,
} from '../src/postgres-restricted-data.ts'

test('uses fixed test database and safely encodes scope values', async () => {
  let args: readonly string[] = []
  const adapter = createPostgresRestrictedDataAdapter({
    database: 'dilee_phase1_test', command: value => { args = value; return '[]\n' },
  })
  assert.deepEqual(await adapter({
    operation: 'production.read_employee_output', scope: { orderNo: "O'RDER", operationName: '包装' }, accessLevel: 'operational', limit: 7,
  }), [])
  const sql = args.at(-1)!
  assert.match(sql, /order_no = 'O''RDER'/)
  assert.match(sql, /operation_name_snapshot = '包装'/)
  assert.match(sql, /LIMIT 7/)
  assert.ok(!sql.includes('unit_price'))
  assert.ok(!sql.includes('remark'))
})

test('refuses databases other than the dedicated test database', () => {
  assert.throws(
    () => createPostgresRestrictedDataAdapter({ database: 'dilee_erp', command: () => '[]' }),
    /PHASE1_TEST_DATABASE_REQUIRED/,
  )
})

test('returns parsed summary rows from the fixed query result', async () => {
  const adapter = createPostgresRestrictedDataAdapter({
    database: 'dilee_phase1_test',
    command: () => '[{"kind":"employee_total","orderNo":"O","operationName":"包装","productionOrderNo":"P","employeeId":"E","employeeName":"员工","quantity":"1.25"}]',
  })
  const rows = await adapter({
    operation: 'production.read_employee_output_summary', scope: { orderNo: 'O', operationName: '包装' }, accessLevel: 'operational', limit: 100,
  })
  assert.equal(rows[0]?.quantity, '1.25')
})

test('provisions the fixed reader with only database, schema, and report-table access', () => {
  const commands: readonly string[][] = []
  provisionPhase1ReadOnlyRole(args => { (commands as string[][]).push([...args]); return '' })
  const sql = commands.flat().join('\n')
  assert.match(sql, new RegExp(`CREATE ROLE ${PHASE1_READER_ROLE} LOGIN`))
  assert.match(sql, /REVOKE CONNECT ON DATABASE dilee_phase1_test FROM PUBLIC/)
  assert.match(sql, /GRANT SELECT ON TABLE public\.employee_daily_reports/)
  assert.ok(!sql.includes('GRANT INSERT'))
})

test('pins the local restricted adapter command to the fixed reader role', () => {
  assert.deepEqual(
    localPostgresRestrictedDataArgs('test-postgres', ['-c', 'SELECT 1']),
    ['exec', 'test-postgres', 'psql', '-U', PHASE1_READER_ROLE, '-c', 'SELECT 1'],
  )
  assert.equal(typeof localPostgresRestrictedDataCommand('test-postgres'), 'function')
})

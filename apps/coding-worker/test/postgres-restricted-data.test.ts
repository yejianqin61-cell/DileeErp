import assert from 'node:assert/strict'
import test from 'node:test'

import { createPostgresRestrictedDataAdapter } from '../src/postgres-restricted-data.ts'

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

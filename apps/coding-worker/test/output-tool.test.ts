import assert from 'node:assert/strict'
import test from 'node:test'

import { runTool } from '../candidate/order-a-output/tool.ts'
import type {
  RestrictedDataRequest,
  RestrictedEmployeeOutputSummaryResult,
} from '../src/restricted-data-gateway.ts'

const fixture: RestrictedEmployeeOutputSummaryResult = {
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

function readerFor(result: RestrictedEmployeeOutputSummaryResult) {
  const calls: Array<Omit<RestrictedDataRequest, 'accessLevel'>> = []
  return {
    calls,
    async read(request: Omit<RestrictedDataRequest, 'accessLevel'>) {
      calls.push(request)
      return result
    },
  }
}

const EXPECTED_AS_OF = '2026-11-02T00:00:00.000Z'

test('returns employee daily and cumulative production for sanitized order A', async () => {
  const reader = readerFor(fixture)
  const fact = await runTool(
    { order_no: 'SO-A-001', operation_name: '包装' },
    reader,
    { now: () => new Date(EXPECTED_AS_OF) },
  )

  assert.deepEqual(fact, {
    operation: 'get_employee_output_summary',
    order_no: 'SO-A-001',
    as_of: EXPECTED_AS_OF,
    data: {
      operation_name: '包装',
      daily: [
        { employee_id: 'e-1', employee_name: '员工甲', report_date: '2026-10-30', quantity: '12.0000' },
        { employee_id: 'e-1', employee_name: '员工甲', report_date: '2026-10-31', quantity: '8.0000' },
        { employee_id: 'e-2', employee_name: '员工乙', report_date: '2026-10-31', quantity: '5.0000' },
      ],
      employee_totals: [
        { employee_id: 'e-1', employee_name: '员工甲', quantity: '20.0000' },
        { employee_id: 'e-2', employee_name: '员工乙', quantity: '5.0000' },
      ],
    },
    sources: fixture.sources.map(source => ({
      business_type: source.businessType,
      business_no: source.businessNo,
      queried_at: EXPECTED_AS_OF,
    })),
    access_level: 'operational',
  })
  assert.deepEqual(reader.calls[0], {
    operation: 'production.read_employee_output_summary',
    scope: { orderNo: 'SO-A-001', operationName: '包装' },
    limit: 100,
  })
})

test('rejects missing order, unknown fields and overlong inputs before reading data', async () => {
  const reader = readerFor(fixture)

  for (const input of [
    { operation_name: '包装' },
    { order_no: 'SO-A-001', operation_name: '包装', sql: 'select 1' },
    { order_no: 'x'.repeat(101), operation_name: '包装' },
    { order_no: 'SO-A-001', operation_name: '' },
  ]) {
    await assert.rejects(
      runTool(input, reader, { now: () => new Date(EXPECTED_AS_OF) }),
      error => (error as Error & { code?: string }).code === 'DATA_REQUEST_INVALID',
    )
  }
  assert.equal(reader.calls.length, 0)
})

test('rejects a gateway result for another order or a truncated source set', async () => {
  for (const invalid of [
    { ...fixture, scope: { ...fixture.scope, orderNo: 'SO-B-002' } },
    { ...fixture, truncated: true },
  ]) {
    const reader = readerFor(invalid as RestrictedEmployeeOutputSummaryResult)
    await assert.rejects(
      runTool(
        { order_no: 'SO-A-001', operation_name: '包装' },
        reader,
        { now: () => new Date(EXPECTED_AS_OF) },
      ),
      error => (error as Error & { code?: string }).code === 'DATA_SCOPE_VIOLATION',
    )
  }
})

test('rejects malformed adapter result rows and source records', async () => {
  const invalidResults = [
    { ...fixture, rows: [{ ...fixture.rows[0], kind: 'payroll' }] },
    { ...fixture, rows: [{ ...fixture.rows[0], quantity: 'NaN' }] },
    { ...fixture, rows: [{ ...fixture.rows[0], reportDate: '2026-02-30' }] },
    { ...fixture, sources: [{ businessType: '', businessNo: '' }] },
    { ...fixture, sources: null },
  ]
  for (const invalid of invalidResults) {
    const reader = readerFor(invalid as RestrictedEmployeeOutputSummaryResult)
    await assert.rejects(
      runTool(
        { order_no: 'SO-A-001', operation_name: '包装' },
        reader,
        { now: () => new Date(EXPECTED_AS_OF) },
      ),
      error => (error as Error & { code?: string }).code === 'DATA_SCOPE_VIOLATION',
    )
  }
})

test('keeps empty production results empty and source-free', async () => {
  const reader = readerFor({ ...fixture, rows: [], sources: [] })
  const fact = await runTool(
    { order_no: 'SO-A-001', operation_name: '包装' },
    reader,
    { now: () => new Date(EXPECTED_AS_OF) },
  )

  assert.deepEqual(fact.data, { operation_name: '包装', daily: [], employee_totals: [] })
  assert.deepEqual(fact.sources, [])
})

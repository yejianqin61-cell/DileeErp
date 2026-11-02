import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RestrictedDataError,
  RestrictedDataGateway,
  type RestrictedDataAdapter,
} from '../src/restricted-data-gateway.ts'

const validRequest = {
  operation: 'production.read_employee_output',
  scope: { orderNo: 'ORDER-A', operationName: '包装' },
  limit: 2,
} as const

const validRow = {
  reportId: 'report-1',
  orderNo: 'ORDER-A',
  productionOrderNo: 'PO-A',
  operationName: '包装',
  employeeId: 'employee-1',
  employeeName: '员工甲',
  reportDate: '2026-10-30',
  quantity: '12.5',
}

function expectCode(code: string): (error: unknown) => boolean {
  return error => error instanceof RestrictedDataError && error.code === code
}

test('rejects unknown operations before calling the host adapter', async () => {
  let calls = 0
  const gateway = new RestrictedDataGateway(async () => {
    calls += 1
    return []
  })

  await assert.rejects(
    gateway.read({ ...validRequest, operation: 'sql.query' }, { accessLevel: 'operational' }),
    expectCode('DATA_OPERATION_DENIED'),
  )
  assert.equal(calls, 0)
})

test('rejects extra request fields that could carry SQL or Prisma input', async () => {
  const gateway = new RestrictedDataGateway(async () => [])

  await assert.rejects(
    gateway.read({ ...validRequest, sql: 'select * from employee_daily_reports' }, { accessLevel: 'operational' }),
    expectCode('DATA_REQUEST_INVALID'),
  )
  await assert.rejects(
    gateway.read({ ...validRequest, scope: { ...validRequest.scope, prisma: {} } }, { accessLevel: 'operational' }),
    expectCode('DATA_REQUEST_INVALID'),
  )
})

test('fails closed when the adapter returns a row from another order', async () => {
  const gateway = new RestrictedDataGateway(async () => [
    { ...validRow, orderNo: 'ORDER-B' },
  ])

  await assert.rejects(
    gateway.read(validRequest, { accessLevel: 'operational' }),
    expectCode('DATA_SCOPE_VIOLATION'),
  )
})

test('fails closed when the adapter returns a row from another operation', async () => {
  const gateway = new RestrictedDataGateway(async () => [
    { ...validRow, operationName: '车缝' },
  ])

  await assert.rejects(
    gateway.read(validRequest, { accessLevel: 'operational' }),
    expectCode('DATA_SCOPE_VIOLATION'),
  )
})

test('projects, sorts and limits valid rows without leaking extra fields', async () => {
  let adapterInput: unknown
  const adapter: RestrictedDataAdapter = async request => {
    adapterInput = request
    return [
      { ...validRow, reportId: 'report-3', employeeId: 'employee-2', employeeName: '员工乙', quantity: '8', unitPrice: '999' },
      { ...validRow, reportId: 'report-2', reportDate: '2026-10-31', quantity: '7', remark: 'private' },
      validRow,
    ]
  }
  const gateway = new RestrictedDataGateway(adapter)

  const result = await gateway.read(
    { operation: validRequest.operation, scope: validRequest.scope, limit: validRequest.limit },
    { accessLevel: 'operational' },
  )

  assert.deepEqual(adapterInput, { ...validRequest, accessLevel: 'operational' })
  assert.deepEqual(result, {
    operation: 'production.read_employee_output',
    scope: { orderNo: 'ORDER-A', operationName: '包装' },
    accessLevel: 'operational',
    rows: [
      {
        reportId: 'report-1',
        productionOrderNo: 'PO-A',
        employeeId: 'employee-1',
        employeeName: '员工甲',
        reportDate: '2026-10-30',
        quantity: '12.5',
      },
      {
        reportId: 'report-3',
        productionOrderNo: 'PO-A',
        employeeId: 'employee-2',
        employeeName: '员工乙',
        reportDate: '2026-10-30',
        quantity: '8',
      },
    ],
    sources: [
      { businessType: 'employee_daily_report', businessNo: 'report-1' },
      { businessType: 'employee_daily_report', businessNo: 'report-3' },
    ],
    truncated: true,
  })
})

test('rejects a candidate-supplied access level and uses the host-trusted level', async () => {
  const seenLevels: string[] = []
  const gateway = new RestrictedDataGateway(async request => {
    seenLevels.push(request.accessLevel)
    return [validRow]
  })

  await assert.rejects(
    gateway.read({ ...validRequest, accessLevel: 'full' }, { accessLevel: 'operational' }),
    expectCode('DATA_REQUEST_INVALID'),
  )
  assert.deepEqual(seenLevels, [])
})

test('rejects inactive and out-of-scope requests before calling the adapter', async () => {
  let calls = 0
  const gateway = new RestrictedDataGateway(async () => { calls += 1; return [] })
  await assert.rejects(
    gateway.read(validRequest, { accessLevel: 'operational', active: false }),
    expectCode('DATA_AUTHORIZATION_DENIED'),
  )
  await assert.rejects(
    gateway.read(validRequest, {
      accessLevel: 'operational',
      authorizedScopes: [{ orderNo: 'ORDER-B', operationName: '包装' }],
    }),
    expectCode('DATA_AUTHORIZATION_DENIED'),
  )
  assert.equal(calls, 0)
})

test('accepts the exact host-authorized order and operation', async () => {
  const gateway = new RestrictedDataGateway(async () => [validRow])
  const result = await gateway.read(validRequest, {
    accessLevel: 'operational', active: true,
    authorizedScopes: [{ orderNo: 'ORDER-A', operationName: '包装' }],
  })
  assert.equal(result.rows.length, 1)
})

test('returns host-aggregated daily and employee totals without truncating totals', async () => {
  const gateway = new RestrictedDataGateway(async () => [
    {
      kind: 'daily', reportIds: ['r1'], orderNo: 'ORDER-A', productionOrderNo: 'PO-A',
      operationName: '包装', employeeId: 'e1', employeeName: '员工甲',
      reportDate: '2026-10-30', quantity: '12', unitPrice: '9.9',
    },
    {
      kind: 'daily', reportIds: ['r2'], orderNo: 'ORDER-A', productionOrderNo: 'PO-A',
      operationName: '包装', employeeId: 'e1', employeeName: '员工甲',
      reportDate: '2026-10-31', quantity: '8', remark: 'private',
    },
    {
      kind: 'daily', reportIds: ['r3'], orderNo: 'ORDER-A', productionOrderNo: 'PO-A',
      operationName: '包装', employeeId: 'e2', employeeName: '员工乙',
      reportDate: '2026-10-31', quantity: '5', calculatedAmount: '200',
    },
    {
      kind: 'employee_total', orderNo: 'ORDER-A', productionOrderNo: 'PO-A',
      operationName: '包装', employeeId: 'e1', employeeName: '员工甲', quantity: '20',
    },
    {
      kind: 'employee_total', orderNo: 'ORDER-A', productionOrderNo: 'PO-A',
      operationName: '包装', employeeId: 'e2', employeeName: '员工乙', quantity: '5',
    },
  ])

  const result = await gateway.read({
    operation: 'production.read_employee_output_summary',
    scope: { orderNo: 'ORDER-A', operationName: '包装' },
    limit: 100,
    }, { accessLevel: 'operational' })

  assert.deepEqual(result.rows, [
    {
      kind: 'daily', reportIds: ['r1'], productionOrderNo: 'PO-A',
      employeeId: 'e1', employeeName: '员工甲', reportDate: '2026-10-30', quantity: '12',
    },
    {
      kind: 'daily', reportIds: ['r2'], productionOrderNo: 'PO-A',
      employeeId: 'e1', employeeName: '员工甲', reportDate: '2026-10-31', quantity: '8',
    },
    {
      kind: 'daily', reportIds: ['r3'], productionOrderNo: 'PO-A',
      employeeId: 'e2', employeeName: '员工乙', reportDate: '2026-10-31', quantity: '5',
    },
    {
      kind: 'employee_total', reportIds: [], productionOrderNo: 'PO-A',
      employeeId: 'e1', employeeName: '员工甲', reportDate: null, quantity: '20',
    },
    {
      kind: 'employee_total', reportIds: [], productionOrderNo: 'PO-A',
      employeeId: 'e2', employeeName: '员工乙', reportDate: null, quantity: '5',
    },
  ])
  assert.equal(result.truncated, false)
  assert.ok(!JSON.stringify(result).includes('unitPrice'))
  assert.ok(!JSON.stringify(result).includes('calculatedAmount'))
  assert.ok(!JSON.stringify(result).includes('private'))
})

test('rejects more than 100 aggregate rows instead of returning a false total', async () => {
  const gateway = new RestrictedDataGateway(async () => Array.from({ length: 101 }, (_, index) => ({
    kind: 'employee_total', orderNo: 'ORDER-A', productionOrderNo: 'PO-A',
    operationName: '包装', employeeId: `e${index}`, employeeName: `员工${index}`,
    quantity: '1',
  })))

  await assert.rejects(
    gateway.read({
      operation: 'production.read_employee_output_summary',
      scope: { orderNo: 'ORDER-A', operationName: '包装' },
      limit: 100,
    }, { accessLevel: 'operational' }),
    expectCode('DATA_RESULT_LIMIT_EXCEEDED'),
  )
})

test('rejects aggregate rows from another order or operation', async () => {
  for (const escaped of [
    { orderNo: 'ORDER-B', operationName: '包装' },
    { orderNo: 'ORDER-A', operationName: '车缝' },
  ]) {
    const gateway = new RestrictedDataGateway(async () => [{
      kind: 'employee_total', ...escaped, productionOrderNo: 'PO-X',
      employeeId: 'e1', employeeName: '员工甲', quantity: '1',
    }])
    await assert.rejects(
      gateway.read({
        operation: 'production.read_employee_output_summary',
        scope: { orderNo: 'ORDER-A', operationName: '包装' },
        limit: 100,
      }, { accessLevel: 'operational' }),
      expectCode('DATA_SCOPE_VIOLATION'),
    )
  }
})

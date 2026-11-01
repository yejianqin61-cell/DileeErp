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
  accessLevel: 'operational',
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
    gateway.read({ ...validRequest, operation: 'sql.query' }),
    expectCode('DATA_OPERATION_DENIED'),
  )
  assert.equal(calls, 0)
})

test('rejects extra request fields that could carry SQL or Prisma input', async () => {
  const gateway = new RestrictedDataGateway(async () => [])

  await assert.rejects(
    gateway.read({ ...validRequest, sql: 'select * from employee_daily_reports' }),
    expectCode('DATA_REQUEST_INVALID'),
  )
  await assert.rejects(
    gateway.read({ ...validRequest, scope: { ...validRequest.scope, prisma: {} } }),
    expectCode('DATA_REQUEST_INVALID'),
  )
})

test('fails closed when the adapter returns a row from another order', async () => {
  const gateway = new RestrictedDataGateway(async () => [
    { ...validRow, orderNo: 'ORDER-B' },
  ])

  await assert.rejects(
    gateway.read(validRequest),
    expectCode('DATA_SCOPE_VIOLATION'),
  )
})

test('fails closed when the adapter returns a row from another operation', async () => {
  const gateway = new RestrictedDataGateway(async () => [
    { ...validRow, operationName: '车缝' },
  ])

  await assert.rejects(
    gateway.read(validRequest),
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

  const result = await gateway.read(validRequest)

  assert.deepEqual(adapterInput, validRequest)
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

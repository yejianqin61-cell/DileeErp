import assert from 'node:assert/strict'
import test from 'node:test'

import { handleRestrictedDataLine } from '../src/restricted-data-channel.ts'
import { RestrictedDataGateway } from '../src/restricted-data-gateway.ts'

const context = {
  accessLevel: 'operational' as const, active: true,
  authorizedScopes: [{ orderNo: 'ORDER-A', operationName: '包装' }],
}
const gateway = new RestrictedDataGateway(async () => [{
  reportId: 'r1', orderNo: 'ORDER-A', productionOrderNo: 'P1', operationName: '包装',
  employeeId: 'e1', employeeName: '员工甲', reportDate: '2026-11-01', quantity: '1.25', remark: 'private',
}])

test('returns only the gateway projection for an authorized JSONL request', async () => {
  const response = JSON.parse(await handleRestrictedDataLine(JSON.stringify({
    operation: 'production.read_employee_output', scope: { orderNo: 'ORDER-A', operationName: '包装' }, limit: 1,
  }), gateway, context))
  assert.equal(response.ok, true)
  assert.equal(response.result.rows[0].quantity, '1.25')
  assert.ok(!JSON.stringify(response).includes('private'))
})

test('does not let malformed, oversized, or out-of-scope messages call the adapter', async () => {
  assert.deepEqual(JSON.parse(await handleRestrictedDataLine('{', gateway, context)), { ok: false, code: 'DATA_MESSAGE_INVALID' })
  assert.deepEqual(JSON.parse(await handleRestrictedDataLine('x'.repeat(256 * 1024 + 1), gateway, context)), { ok: false, code: 'DATA_MESSAGE_TOO_LARGE' })
  assert.deepEqual(JSON.parse(await handleRestrictedDataLine(JSON.stringify({
    operation: 'production.read_employee_output', scope: { orderNo: 'ORDER-B', operationName: '包装' }, limit: 1,
  }), gateway, context)), { ok: false, code: 'DATA_AUTHORIZATION_DENIED' })
})

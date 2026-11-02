import assert from 'node:assert/strict'
import { runTool } from './tool.ts'

const fact = await runTool(
  { order_no: 'SO-A-001', operation_name: '包装' },
  { read: async () => ({ operation: 'production.read_employee_output_summary', scope: { orderNo: 'SO-A-001', operationName: '包装' }, accessLevel: 'operational', rows: [
    { kind: 'daily', reportIds: ['r-1'], productionOrderNo: 'PO-A-001', employeeId: 'e-1', employeeName: '员工甲', reportDate: '2026-10-30', quantity: '12.0000' },
    { kind: 'daily', reportIds: ['r-2'], productionOrderNo: 'PO-A-001', employeeId: 'e-1', employeeName: '员工甲', reportDate: '2026-10-31', quantity: '8.0000' },
    { kind: 'daily', reportIds: ['r-3'], productionOrderNo: 'PO-A-001', employeeId: 'e-2', employeeName: '员工乙', reportDate: '2026-10-31', quantity: '5.0000' },
    { kind: 'employee_total', reportIds: [], productionOrderNo: 'PO-A-001', employeeId: 'e-1', employeeName: '员工甲', reportDate: null, quantity: '20.0000' },
    { kind: 'employee_total', reportIds: [], productionOrderNo: 'PO-A-001', employeeId: 'e-2', employeeName: '员工乙', reportDate: null, quantity: '5.0000' },
  ], sources: [
    { businessType: 'employee_daily_report', businessNo: 'r-1' },
    { businessType: 'employee_daily_report', businessNo: 'r-2' },
    { businessType: 'employee_daily_report', businessNo: 'r-3' },
    { businessType: 'employee_daily_report', businessNo: 'SO-A-001:包装:e-1:total' },
    { businessType: 'employee_daily_report', businessNo: 'SO-A-001:包装:e-2:total' },
  ], truncated: false }) },
  { now: () => new Date('2026-11-02T00:00:00.000Z') },
)
assert.deepEqual(fact.data.employee_totals, [
  { employee_id: 'e-1', employee_name: '员工甲', quantity: '20.0000' },
  { employee_id: 'e-2', employee_name: '员工乙', quantity: '5.0000' },
])

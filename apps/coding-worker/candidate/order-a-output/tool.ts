type AccessLevel = 'full' | 'operational'

type DataRequest = {
  operation: 'production.read_employee_output_summary'
  scope: { orderNo: string; operationName: string }
  limit: 100
}

type OutputRow = {
  kind: 'daily' | 'employee_total'
  reportIds: string[]
  productionOrderNo: string
  employeeId: string
  employeeName: string
  reportDate: string | null
  quantity: string
}

type DataResult = {
  operation: 'production.read_employee_output_summary'
  scope: DataRequest['scope']
  accessLevel: AccessLevel
  rows: OutputRow[]
  sources: Array<{ businessType: string; businessNo: string }>
  truncated: false
}

type DataReader = { read(request: DataRequest): Promise<DataResult> }

type QueryFact = {
  operation: 'get_employee_output_summary'
  order_no: string
  as_of: string
  data: {
    operation_name: string
    daily: Array<{
      employee_id: string
      employee_name: string
      report_date: string
      quantity: string
    }>
    employee_totals: Array<{
      employee_id: string
      employee_name: string
      quantity: string
    }>
  }
  sources: Array<{
    business_type: string
    business_no: string
    queried_at: string
  }>
  access_level: AccessLevel
}

export class OutputToolError extends Error {
  readonly code: 'DATA_REQUEST_INVALID' | 'DATA_SCOPE_VIOLATION'

  constructor(code: 'DATA_REQUEST_INVALID' | 'DATA_SCOPE_VIOLATION', message: string) {
    super(message)
    this.name = 'OutputToolError'
    this.code = code
  }
}

function parseInput(input: unknown): { orderNo: string; operationName: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new OutputToolError('DATA_REQUEST_INVALID', 'input must be an object')
  }
  const value = input as Record<string, unknown>
  const keys = Object.keys(value).sort()
  if (keys.length !== 2 || keys[0] !== 'operation_name' || keys[1] !== 'order_no') {
    throw new OutputToolError('DATA_REQUEST_INVALID', 'input contains unknown or missing fields')
  }
  if (typeof value.order_no !== 'string' || value.order_no.trim() === '' || value.order_no.length > 100) {
    throw new OutputToolError('DATA_REQUEST_INVALID', 'order_no must contain 1 to 100 characters')
  }
  if (typeof value.operation_name !== 'string' || value.operation_name.trim() === '' || value.operation_name.length > 150) {
    throw new OutputToolError('DATA_REQUEST_INVALID', 'operation_name must contain 1 to 150 characters')
  }
  return { orderNo: value.order_no.trim(), operationName: value.operation_name.trim() }
}

function isDate(value: string | null): value is string {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
}

function isQuantity(value: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(value)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
}

function validateResult(result: unknown, orderNo: string, operationName: string): asserts result is DataResult {
  if (!record(result) || !record(result.scope)
    || result.operation !== 'production.read_employee_output_summary'
    || result.scope.orderNo !== orderNo
    || result.scope.operationName !== operationName
    || result.accessLevel !== 'operational'
    || result.truncated !== false
    || !Array.isArray(result.rows)
    || !Array.isArray(result.sources)) {
    throw new OutputToolError('DATA_SCOPE_VIOLATION', 'data result does not match the requested scope')
  }
  const sourceKeys = new Set<string>()
  for (const source of result.sources) {
    if (!record(source) || typeof source.businessType !== 'string' || source.businessType === ''
      || typeof source.businessNo !== 'string' || source.businessNo === '') {
      throw new OutputToolError('DATA_SCOPE_VIOLATION', 'data result contains an invalid source')
    }
    sourceKeys.add(`${source.businessType}:${source.businessNo}`)
  }
  if (result.rows.some(row => !record(row)
    || (row.kind !== 'daily' && row.kind !== 'employee_total')
    || typeof row.employeeId !== 'string' || row.employeeId === ''
    || typeof row.employeeName !== 'string' || row.employeeName === ''
    || typeof row.productionOrderNo !== 'string' || row.productionOrderNo === ''
    || !validDecimal(row.quantity)
    || (row.kind === 'daily' && (!validDate(row.reportDate)
      || !Array.isArray(row.reportIds) || row.reportIds.length === 0
      || row.reportIds.some(id => typeof id !== 'string' || !sourceKeys.has(`employee_daily_report:${id}`))))
    || (row.kind === 'employee_total' && (row.reportDate !== null
      || !sourceKeys.has(`employee_daily_report:${orderNo}:${operationName}:${row.employeeId}:total`))))) {
    throw new OutputToolError('DATA_SCOPE_VIOLATION', 'data result contains an invalid row')
  }
}

export async function runTool(
  input: unknown,
  reader: DataReader,
  options: { now?: () => Date } = {},
): Promise<QueryFact> {
  const scope = parseInput(input)
  const result = await reader.read({
    operation: 'production.read_employee_output_summary',
    scope,
    limit: 100,
  })
  validateResult(result, scope.orderNo, scope.operationName)
  const asOf = (options.now ?? (() => new Date()))().toISOString()
  const daily = result.rows.filter(row => row.kind === 'daily').map(row => ({
    employee_id: row.employeeId,
    employee_name: row.employeeName,
    report_date: row.reportDate!,
    quantity: row.quantity,
  }))
  const employeeTotals = result.rows.filter(row => row.kind === 'employee_total').map(row => ({
    employee_id: row.employeeId,
    employee_name: row.employeeName,
    quantity: row.quantity,
  }))
  return {
    operation: 'get_employee_output_summary',
    order_no: scope.orderNo,
    as_of: asOf,
    data: {
      operation_name: scope.operationName,
      daily,
      employee_totals: employeeTotals,
    },
    sources: result.sources.map(source => ({
      business_type: source.businessType,
      business_no: source.businessNo,
      queried_at: asOf,
    })),
    access_level: result.accessLevel,
  }
}

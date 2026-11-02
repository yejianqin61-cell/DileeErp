export type RestrictedDataOperation =
  | 'production.read_employee_output'
  | 'production.read_employee_output_summary'
export type RestrictedAccessLevel = 'full' | 'operational'

export interface RestrictedDataRequest {
  operation: RestrictedDataOperation
  scope: {
    orderNo: string
    operationName: string
  }
  accessLevel: RestrictedAccessLevel
  limit: number
}

export interface RestrictedDataContext {
  accessLevel: RestrictedAccessLevel
  active?: boolean
  authorizedScopes?: readonly { orderNo: string; operationName: string }[]
}

export type RestrictedDataAdapter = (
  request: RestrictedDataRequest,
) => Promise<readonly Record<string, unknown>[]>

export interface RestrictedEmployeeOutput {
  reportId: string
  productionOrderNo: string
  employeeId: string
  employeeName: string
  reportDate: string
  quantity: string
}

export interface RestrictedEmployeeOutputSummary {
  kind: 'daily' | 'employee_total'
  reportIds: string[]
  productionOrderNo: string
  employeeId: string
  employeeName: string
  reportDate: string | null
  quantity: string
}

export interface RestrictedDataResult {
  operation: RestrictedDataOperation
  scope: RestrictedDataRequest['scope']
  accessLevel: RestrictedAccessLevel
  rows: Array<RestrictedEmployeeOutput | RestrictedEmployeeOutputSummary>
  sources: Array<{ businessType: 'employee_daily_report'; businessNo: string }>
  truncated: boolean
}

export interface RestrictedEmployeeOutputSummaryResult {
  operation: 'production.read_employee_output_summary'
  scope: RestrictedDataRequest['scope']
  accessLevel: RestrictedAccessLevel
  rows: RestrictedDataSummaryRow[]
  sources: Array<{ businessType: 'employee_daily_report'; businessNo: string }>
  truncated: false
}

export type RestrictedDataSummaryRow = RestrictedEmployeeOutputSummary | {
  kind: 'employee_total'
  reportIds: []
  productionOrderNo: string
  employeeId: string
  employeeName: string
  reportDate: null
  quantity: string
}

export class RestrictedDataError extends Error {
  constructor(
    readonly code:
      | 'DATA_OPERATION_DENIED'
      | 'DATA_REQUEST_INVALID'
      | 'DATA_RESULT_LIMIT_EXCEEDED'
      | 'DATA_SCOPE_VIOLATION'
      | 'DATA_AUTHORIZATION_DENIED',
    message: string,
  ) {
    super(message)
    this.name = 'RestrictedDataError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index])
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  code: RestrictedDataError['code'],
): string {
  const result = value[key]
  if (typeof result !== 'string' || result.trim() === '') {
    throw new RestrictedDataError(code, `${key} must be a non-empty string`)
  }
  return result
}

function parseRequest(input: unknown, context: RestrictedDataContext): RestrictedDataRequest {
  if (!isObject(input)) {
    throw new RestrictedDataError('DATA_REQUEST_INVALID', 'request must be an object')
  }
  if (input.operation !== 'production.read_employee_output'
    && input.operation !== 'production.read_employee_output_summary') {
    throw new RestrictedDataError('DATA_OPERATION_DENIED', `operation is not allowed: ${String(input.operation)}`)
  }
  if (!hasExactKeys(input, ['operation', 'scope', 'limit']) || !isObject(input.scope)) {
    throw new RestrictedDataError('DATA_REQUEST_INVALID', 'request contains unknown or missing fields')
  }
  if (!hasExactKeys(input.scope, ['orderNo', 'operationName'])) {
    throw new RestrictedDataError('DATA_REQUEST_INVALID', 'scope contains unknown or missing fields')
  }
  if (context.accessLevel !== 'full' && context.accessLevel !== 'operational') {
    throw new RestrictedDataError('DATA_REQUEST_INVALID', 'host accessLevel is invalid')
  }
  if (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100) {
    throw new RestrictedDataError('DATA_REQUEST_INVALID', 'limit must be an integer from 1 to 100')
  }
  const request: RestrictedDataRequest = {
    operation: input.operation,
    scope: {
      orderNo: requiredString(input.scope, 'orderNo', 'DATA_REQUEST_INVALID'),
      operationName: requiredString(input.scope, 'operationName', 'DATA_REQUEST_INVALID'),
    },
    accessLevel: context.accessLevel,
    limit: input.limit as number,
  }
  if (context.active === false || (context.authorizedScopes !== undefined
    && !context.authorizedScopes.some(scope => scope.orderNo === request.scope.orderNo
      && scope.operationName === request.scope.operationName))) {
    throw new RestrictedDataError('DATA_AUTHORIZATION_DENIED', 'host authorization does not allow this scope')
  }
  return request
}

function projectSummaryRow(
  value: Record<string, unknown>,
  scope: RestrictedDataRequest['scope'],
): RestrictedEmployeeOutputSummary {
  const orderNo = requiredString(value, 'orderNo', 'DATA_SCOPE_VIOLATION')
  const operationName = requiredString(value, 'operationName', 'DATA_SCOPE_VIOLATION')
  if (orderNo !== scope.orderNo || operationName !== scope.operationName) {
    throw new RestrictedDataError(
      'DATA_SCOPE_VIOLATION',
      `adapter row escaped ${scope.orderNo}/${scope.operationName}`,
    )
  }
  const kind = value.kind
  if (kind !== 'daily' && kind !== 'employee_total') {
    throw new RestrictedDataError('DATA_SCOPE_VIOLATION', 'adapter row has an invalid summary kind')
  }
  const reportIds = kind === 'daily' ? value.reportIds : []
  if (!Array.isArray(reportIds) || reportIds.some(id => typeof id !== 'string' || id.trim() === '')) {
    throw new RestrictedDataError('DATA_SCOPE_VIOLATION', 'adapter row has invalid report ids')
  }
  const reportDate = kind === 'daily' ? value.reportDate : null
  if (kind === 'daily' && (typeof reportDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate))) {
    throw new RestrictedDataError('DATA_SCOPE_VIOLATION', 'adapter row has an invalid date')
  }
  const quantity = requiredString(value, 'quantity', 'DATA_SCOPE_VIOLATION')
  if (!/^-?\d+(?:\.\d+)?$/.test(quantity)) {
    throw new RestrictedDataError('DATA_SCOPE_VIOLATION', 'adapter row has an invalid quantity')
  }
  return {
    kind,
    reportIds: reportIds as string[],
    productionOrderNo: requiredString(value, 'productionOrderNo', 'DATA_SCOPE_VIOLATION'),
    employeeId: requiredString(value, 'employeeId', 'DATA_SCOPE_VIOLATION'),
    employeeName: requiredString(value, 'employeeName', 'DATA_SCOPE_VIOLATION'),
    reportDate: typeof reportDate === 'string' ? reportDate : null,
    quantity,
  }
}

function projectRow(
  value: Record<string, unknown>,
  scope: RestrictedDataRequest['scope'],
): RestrictedEmployeeOutput {
  const orderNo = requiredString(value, 'orderNo', 'DATA_SCOPE_VIOLATION')
  const operationName = requiredString(value, 'operationName', 'DATA_SCOPE_VIOLATION')
  if (orderNo !== scope.orderNo || operationName !== scope.operationName) {
    throw new RestrictedDataError(
      'DATA_SCOPE_VIOLATION',
      `adapter row escaped ${scope.orderNo}/${scope.operationName}`,
    )
  }
  const reportDate = requiredString(value, 'reportDate', 'DATA_SCOPE_VIOLATION')
  const quantity = requiredString(value, 'quantity', 'DATA_SCOPE_VIOLATION')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || !/^-?\d+(?:\.\d+)?$/.test(quantity)) {
    throw new RestrictedDataError('DATA_SCOPE_VIOLATION', 'adapter row has an invalid date or quantity')
  }
  return {
    reportId: requiredString(value, 'reportId', 'DATA_SCOPE_VIOLATION'),
    productionOrderNo: requiredString(value, 'productionOrderNo', 'DATA_SCOPE_VIOLATION'),
    employeeId: requiredString(value, 'employeeId', 'DATA_SCOPE_VIOLATION'),
    employeeName: requiredString(value, 'employeeName', 'DATA_SCOPE_VIOLATION'),
    reportDate,
    quantity,
  }
}

export class RestrictedDataGateway {
  constructor(private readonly adapter: RestrictedDataAdapter) {}

  async read(input: unknown, context: RestrictedDataContext): Promise<RestrictedDataResult | RestrictedEmployeeOutputSummaryResult> {
    const request = parseRequest(input, context)
    const adapterRows = await this.adapter(request)
    if (request.operation === 'production.read_employee_output_summary') {
      const rows = adapterRows.map(row => projectSummaryRow(row, request.scope))
      const daily = rows.filter(row => row.kind === 'daily')
      const totals = rows.filter(row => row.kind === 'employee_total')
      if (daily.length > 100 || totals.length > 100) {
        throw new RestrictedDataError(
          'DATA_RESULT_LIMIT_EXCEEDED',
          'aggregate result exceeds 100 rows per group',
        )
      }
      rows.sort((left, right) =>
        left.kind.localeCompare(right.kind, 'en')
        || (left.reportDate ?? '').localeCompare(right.reportDate ?? '', 'en')
        || left.employeeId.localeCompare(right.employeeId, 'en'))
      return {
        operation: request.operation,
        scope: request.scope,
        accessLevel: request.accessLevel,
        rows,
        sources: rows.flatMap(row => row.kind === 'daily'
          ? row.reportIds.map(reportId => ({ businessType: 'employee_daily_report' as const, businessNo: reportId }))
          : [{ businessType: 'employee_daily_report' as const, businessNo: `${request.scope.orderNo}:${request.scope.operationName}:${row.employeeId}:total` }]),
        truncated: false,
      }
    }
    const projected = adapterRows.map(row => projectRow(row, request.scope)).sort((left, right) =>
      left.reportDate.localeCompare(right.reportDate, 'en')
      || left.employeeId.localeCompare(right.employeeId, 'en')
      || left.reportId.localeCompare(right.reportId, 'en'))
    const rows = projected.slice(0, request.limit)
    return {
      operation: request.operation,
      scope: request.scope,
      accessLevel: request.accessLevel,
      rows,
      sources: rows.map(row => ({
        businessType: 'employee_daily_report',
        businessNo: row.reportId,
      })),
      truncated: projected.length > rows.length,
    }
  }
}

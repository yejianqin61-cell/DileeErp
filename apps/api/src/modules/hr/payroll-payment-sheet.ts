import { Prisma } from "@prisma/client";
import { NUMBER_FORMAT, toDateText, toDecimal, toExportNumber } from "../finance/finance-report.domain";
import type { ReportCell, ReportColumn, ReportTable } from "../finance/finance-report.types";

/**
 * 工资付款按月导出（纯函数，不碰数据库）。
 *
 * 为什么单独一张表而不是复用「工资台账」页：用户要的是一张**能直接看出这个月谁还没发**的表，
 * 于是把台账的应发/已付/未付与工资付款的核销事实并到一行，并加一列判读用的「是否付款」。
 * 版式沿用财务对账那套 `ReportTable`（列定义是数据、数值列必须落 Excel 数值类型），
 * 由 `sendWorkbook` 渲染下发。
 *
 * 与页面的关系：行必须与「工资付款」页看到的**同一批**（含草稿，草稿在页面上只是给一个不可付款提示），
 * 否则表上的合计会与页面对不上。取数口径见 `SalaryPaymentService.paymentSheetRows`。
 */

/**
 * 列定义：列名与列序按用户要求固定。
 *
 * 三个金额列（应发工资 / 已付 / 未付）用 `numFmt` 声明为**数值列** —— Excel 里文本型数字
 * `SUM` 得 0、筛选分不出区间、排序按字典序；这一点在 `finance-report-workbook.ts` 里是硬约束
 * （数值列收到非数值直接抛错），因此构造行时必须用 `toExportNumber` 而不是 `decimal.toString()`。
 */
export const PAYROLL_PAYMENT_SHEET_COLUMNS: ReportColumn[] = [
  { header: "月份", width: 10 },
  { header: "工号", width: 14 },
  { header: "姓名", width: 12 },
  { header: "部门", width: 18 },
  { header: "岗位", width: 18 },
  { header: "员工类型", width: 10 },
  { header: "币种", width: 8 },
  numeric("应发工资", 14),
  numeric("已付", 14),
  numeric("未付", 14),
  { header: "是否付款", width: 10 },
  { header: "台账状态", width: 10 },
  { header: "付款笔数", width: 10 },
  { header: "末次付款日期", width: 14 },
  { header: "末次付款方式", width: 16 },
  { header: "发放银行", width: 28 },
  { header: "付款单号", width: 34 },
  { header: "备注", width: 24 },
];

function numeric(header: string, width: number): ReportColumn {
  return { header, width, numFmt: NUMBER_FORMAT };
}

/** 三个金额列的下标（0 基）：应发工资 / 已付 / 未付。合计只可能落在这三列上。 */
const MONEY_TOTAL_COLUMNS = [7, 8, 9];

/**
 * 台账状态 → 中文，与 `apps/web/components/finance/salary-workspace.tsx` 的 `statusLabels` 一字不差。
 *
 * 不复用前端那份：一边是浏览器 bundle、一边是服务端；两边各有一份时**标签必须对齐**，
 * 所以这里用注释把对应关系钉住（导出表与页面显示不一致会让操作员以为导错了月份）。
 */
const STATUS_LABELS: Record<string, string> = { draft: "草稿", confirmed: "已确认", expired: "已过期", partially_paid: "部分支付", paid: "已支付", closed: "已关闭" };

/** 付款单号列最多明列几张，超出只给「等 N 张」—— 单号是最宽的一列，列全了会把表撑到翻页。 */
const MAX_PAYMENT_NUMBERS = 3;

/** 判读「是否付款」用的零值：金额列缺失时按 0 参与判断（没有金额就等于没有钱要发），单元格仍留空。 */
const zero = new Prisma.Decimal(0);

/**
 * 一行工资付款的取数结果。
 *
 * `payments` 只放**已过账**的工资付款（草稿与已冲销的核销不进这张表）：这是「已付」与「是否付款」
 * 的共同事实源，调用方按付款日期升序给出，构造层再自己定序一次以保证导出结果稳定。
 */
export type PayrollPaymentSheetSource = {
  /** 月份（台账期间起始月，YYYY-MM） */
  month: string | null;
  employeeNo: string;
  employeeName: string;
  departmentName: string | null;
  positionName: string | null;
  /** 员工类型原值（workshop / non_workshop），中文标签在构造层映射 */
  employeeType: string;
  currency: string;
  payableAmount: Prisma.Decimal | string | number | null;
  paidAmount: Prisma.Decimal | string | number | null;
  outstandingAmount: Prisma.Decimal | string | number | null;
  /** 台账状态原值（draft / confirmed / ...），中文标签在构造层映射 */
  status: string;
  remark: string | null;
  payments: Array<{ paymentNo: string; paymentDate: Date | string | null; paymentMethod: string | null; bankName: string | null; accountNumber: string | null }>;
};

/** 一行的付款单号去重键：同一张付款单对同一台账只会有一条核销（库里有唯一约束），按单号去重最直观。 */
function distinctPayments(row: PayrollPaymentSheetSource) {
  const seen = new Map<string, PayrollPaymentSheetSource["payments"][number]>();
  for (const payment of row.payments) if (payment.paymentNo) seen.set(payment.paymentNo, payment);
  // 「末次」= 付款日期最晚的那一笔；同一天多笔时按单号定序，保证同一批数据每次导出的结果一致。
  return [...seen.values()].sort((left, right) => (toDateText(left.paymentDate) ?? "").localeCompare(toDateText(right.paymentDate) ?? "") || left.paymentNo.localeCompare(right.paymentNo));
}

/** 付款单号列：全部单号顿号相连；超过 3 张只列前 3 张并注明总数（不静默截断成看不见的遗漏）。 */
function paymentNumbers(payments: ReturnType<typeof distinctPayments>): string | null {
  // 一笔都没付就是空单元格（不是空串）：空串在 Excel 里是一格文本，会干扰筛选。
  if (!payments.length) return null;
  const numbers = payments.map((payment) => payment.paymentNo);
  if (numbers.length <= MAX_PAYMENT_NUMBERS) return numbers.join("、");
  return `${numbers.slice(0, MAX_PAYMENT_NUMBERS).join("、")}等${numbers.length}张`;
}

/** 发放银行显示口径与页面一致：`银行名（账号）`；只有名称时给名称，都没有就留空（不编账户）。 */
function bankText(payment: PayrollPaymentSheetSource["payments"][number] | undefined): string | null {
  if (!payment?.bankName) return null;
  return payment.accountNumber ? `${payment.bankName}（${payment.accountNumber}）` : payment.bankName;
}

/** 员工类型中文：与页面「类型」列同一口径（非车间一律记「非车间」）。 */
function employeeTypeText(value: string): string {
  return value === "workshop" ? "车间" : "非车间";
}

/**
 * 「是否付款」判读列。
 *
 * 顺序即优先级：应发 ≤ 0 的台账本来就没有钱要发（记「无需付款」，而不是「未付款」）；
 * 未付 ≤ 0 说明已结清；已付 > 0 说明只发了一部分；其余才是真的一分未付。
 */
function paymentStateText(payable: Prisma.Decimal, paid: Prisma.Decimal, outstanding: Prisma.Decimal): string {
  if (payable.lte(0)) return "无需付款";
  if (outstanding.lte(0)) return "已付清";
  if (paid.gt(0)) return "部分付款";
  return "未付款";
}

export function buildPayrollPaymentSheetTable(rows: PayrollPaymentSheetSource[], options: { footnotes?: string[] } = {}): ReportTable {
  const table: ReportTable = {
    sheetName: "工资付款",
    columns: PAYROLL_PAYMENT_SHEET_COLUMNS,
    rows: rows.map((row): ReportCell[] => {
      // 缺字段保持 null（= 空单元格），**不能**先兜成 0：0 是「确实为零」的事实，两者在财务上完全不同。
      // 判读列需要数值才兜 0（没有金额就没有钱要发），单元格本身照原样留空。
      const payable = toDecimal(row.payableAmount);
      const paid = toDecimal(row.paidAmount);
      const outstanding = toDecimal(row.outstandingAmount);
      const payments = distinctPayments(row);
      const latest = payments[payments.length - 1];
      return [
        row.month, // 月份
        row.employeeNo, // 工号
        row.employeeName, // 姓名
        row.departmentName, // 部门
        row.positionName, // 岗位
        employeeTypeText(row.employeeType), // 员工类型
        row.currency, // 币种
        toExportNumber(payable), // 应发工资
        toExportNumber(paid), // 已付
        toExportNumber(outstanding), // 未付
        paymentStateText(payable ?? zero, paid ?? zero, outstanding ?? zero), // 是否付款
        STATUS_LABELS[row.status] ?? row.status, // 台账状态
        // 付款笔数 = 付款单张数（不是核销行数）。0 是「确实一笔都没付」的事实，写 0 而不是留空。
        payments.length, // 付款笔数
        latest ? toDateText(latest.paymentDate) : null, // 末次付款日期
        latest?.paymentMethod ?? null, // 末次付款方式
        bankText(latest), // 发放银行
        paymentNumbers(payments), // 付款单号
        row.remark, // 备注
      ];
    }),
    footnotes: [],
  };

  const currencies = [...new Set(rows.map((row) => row.currency).filter((currency): currency is string => Boolean(currency)))];
  // 合计**只在整批同一个币种时**才给：跨币种相加会得到一个没有会计意义的数（与收支报表 R7 同一条铁律）。
  // 工资通常只以人民币核算，所以混币种属于异常数据 —— 此时不给合计，并在表尾说明原因，不让读者以为算错了。
  if (currencies.length <= 1) table.totalColumns = MONEY_TOTAL_COLUMNS;

  table.footnotes = [
    "「是否付款」：应发工资 ≤ 0 记「无需付款」；未付 ≤ 0 记「已付清」；已付 > 0 记「部分付款」；其余记「未付款」。",
    "「已付」只统计已过账（posted）的工资付款核销：付款草稿与已冲销的核销都不计入。",
    ...(currencies.length > 1
      ? [`本期台账存在多种币种（${currencies.join("、")}）：工资通常只以人民币（CNY）核算，混币种不可相加，因此本表不提供合计（绝不跨币种求和）。`]
      : []),
    // 这一条永远在：它决定财务是拿它当核对底稿还是当银行对账单用。
    "本表由「工资台账 + 工资付款核销」生成，只反映系统内的付款登记情况，不是银行对账单；实际到账以银行流水为准。",
    ...(options.footnotes ?? []),
  ];
  return table;
}

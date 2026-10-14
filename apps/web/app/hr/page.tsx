"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { PageHeader } from "../../components/layout/app-shell";
import {
  ActionDialog,
  type ActionField,
} from "../../components/ui/action-dialog";
import { Button } from "../../components/ui/button";
import { FileInput } from "../../components/ui/file-input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { DataTable } from "../../components/data/data-table";
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "../../components/feedback/states";
import {
  ApiClientError,
  apiGet,
  apiPatch,
  apiPost,
  apiRequest,
} from "../../lib/api-client";
import { displayStatus } from "../../lib/display-text";
import { auditColumns, type AuditRow } from "../../components/data/audit-columns";
import { deriveEmployeeFieldsFromIdCard } from "../../lib/id-card";
import { currencyOptions, fetchCurrencyOptions, type CurrencyOption } from "../../lib/currency-catalogue";
import { notifyError, notifySuccess } from "../../components/ui/toaster";

// 员工口径 = 《在职员工花名册》：工号、姓名、部门、职务、状态、出生日期、学历、血型、
// 入职/离职日期、员工类型、社保/商业险、劳动合同与劳务合同起止、性别、民族、身份证号码、
// 家庭住址、现住地址、联系方式、紧急联络人与紧急联络人联系电话、备注。
// age/tenureYears/birthdayThisMonth/contractStatus/laborContractStatus 是后端按当天日期实时
// 算出来的派生列（年龄/工龄/当月生日/合同到期提醒），不在表单里填。
type Employee = AuditRow & {
  id: string;
  employeeNo: string;
  name: string;
  employeeType: string;
  employmentStatus: string;
  hiredOn?: string;
  leftOn?: string;
  remark?: string;
  /** 逻辑删除时间：有值 = 已从员工列表移除，可在「已删除」筛选里看到并恢复。 */
  deletedAt?: string | null;
  department?: { id: string; name: string };
  position?: { id: string; name: string };
  birthDate?: string;
  gender?: string;
  ethnicity?: string;
  idCardNo?: string;
  education?: string;
  bloodType?: string;
  socialInsurance?: boolean;
  commercialInsurance?: boolean;
  contractStart?: string;
  contractEnd?: string;
  laborContractStart?: string;
  laborContractEnd?: string;
  homeAddress?: string;
  currentAddress?: string;
  phone?: string;
  emergencyContact?: string;
  emergencyPhone?: string;
  // 后端实时计算的派生列（不落库）
  age?: number | null;
  tenureYears?: number | null;
  birthdayThisMonth?: boolean | null;
  /** 劳动合同 + 劳务合同合并后的档位：正常 / 即将过期（1 个月内）/ 已过期；"" = 两份都没填结束时间 */
  contractSituation?: string;
};
type RecordItem = AuditRow & {
  id: string;
  employeeId: string;
  attendanceDate?: string;
  attendanceType?: string;
  workStartTime?: string;
  workEndTime?: string;
  periodStart?: string;
  periodEnd?: string;
  score?: string;
  grade?: string;
};
type Ledger = {
  id: string;
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  payableAmount: string;
  status: string;
  currency: string;
};
type Payment = {
  id: string;
  paymentNo: string;
  paymentDate: string;
  amount: string;
  currency: string;
  status: string;
};
// 发放银行（财务 → 银行账户）：2026-09-16 起工资支付必须指定，否则这笔支出不进任何银行账户余额。
type BankRef = { id: string; bankName: string; accountNumber: string; isActive: boolean };
type OrganizationItem = {
  id: string;
  code: string;
  name: string;
  departmentId?: string;
  isActive: boolean;
};
type EmployeeTypeItem = {
  id: string;
  key: string;
  label: string;
  isActive: boolean;
};
type DialogState = {
  title: string;
  fields: ActionField[];
  submit: (values: Record<string, string>) => void;
};
const messageOf = (cause: unknown, fallback: string) =>
  cause instanceof ApiClientError ? cause.message : fallback;

/** 「是否」类字段用下拉而不是开关：留空 = 未登记，必须和「否」区分开。 */
const YES_NO_OPTIONS = [
  { value: "true", label: "是" },
  { value: "false", label: "否" },
];
const GENDER_OPTIONS = [
  { value: "男", label: "男" },
  { value: "女", label: "女" },
];
const isoDate = (value?: string) => value?.slice(0, 10) ?? "";

/**
 * 编辑表单里「是否」字段的初值：undefined/null 都回到空选项（未登记），
 * 不能把没登记过的员工显示成「否」。
 */
const flagDefault = (value?: boolean) => (value === true ? "true" : value === false ? "false" : "");

/**
 * 花名册字段定义（新建与编辑共用）：顺序按花名册原表走，方便操作员对照。
 * 工号留空时由后端自动生成（EMP-当天日期-序号）。
 */
function employeeRosterFields(employee: Employee | undefined, departments: OrganizationItem[], positions: OrganizationItem[], employeeTypes: EmployeeTypeItem[]): ActionField[] {
  return [
    { name: "employee_no", label: "工号", placeholder: "留空自动生成", defaultValue: employee?.employeeNo ?? "" },
    { name: "name", label: "姓名", required: true, defaultValue: employee?.name ?? "" },
    {
      name: "department_id", label: "部门", type: "select", required: true, canAddCategory: true,
      defaultValue: employee?.department?.id,
      options: departments.filter((item) => item.isActive).map((item) => ({ value: item.id, label: `${item.code} / ${item.name}` })),
    },
    {
      name: "position_id", label: "职务", type: "select", required: true, canAddCategory: true,
      defaultValue: employee?.position?.id,
      options: positions.filter((item) => item.isActive).map((item) => ({ value: item.id, label: `${item.code} / ${item.name}` })),
    },
    {
      name: "employee_type", label: "员工类型", type: "select", required: true,
      defaultValue: employee?.employeeType ?? "workshop",
      options: employeeTypes.map((item) => ({ value: item.key, label: item.label })),
    },
    { name: "hired_on", label: "入职日期", type: "date", defaultValue: isoDate(employee?.hiredOn) },
    { name: "left_on", label: "离职日期", type: "date", defaultValue: isoDate(employee?.leftOn) },
    { name: "birth_date", label: "出生日期", type: "date", defaultValue: isoDate(employee?.birthDate), placeholder: "留空则按身份证推算" },
    { name: "gender", label: "性别", type: "select", defaultValue: employee?.gender, options: GENDER_OPTIONS },
    { name: "ethnicity", label: "民族", defaultValue: employee?.ethnicity ?? "" },
    { name: "id_card_no", label: "身份证号码", defaultValue: employee?.idCardNo ?? "", placeholder: "填对可自动推算出生日期与性别" },
    { name: "education", label: "学历", defaultValue: employee?.education ?? "" },
    { name: "blood_type", label: "血型", defaultValue: employee?.bloodType ?? "" },
    { name: "social_insurance", label: "是否缴纳社保", type: "select", defaultValue: flagDefault(employee?.socialInsurance), options: YES_NO_OPTIONS },
    { name: "commercial_insurance", label: "是否缴纳商业险", type: "select", defaultValue: flagDefault(employee?.commercialInsurance), options: YES_NO_OPTIONS },
    { name: "contract_start", label: "合同开始时间", type: "date", defaultValue: isoDate(employee?.contractStart) },
    { name: "contract_end", label: "合同结束时间", type: "date", defaultValue: isoDate(employee?.contractEnd) },
    { name: "labor_contract_start", label: "劳务合同开始时间", type: "date", defaultValue: isoDate(employee?.laborContractStart) },
    { name: "labor_contract_end", label: "劳务合同结束时间", type: "date", defaultValue: isoDate(employee?.laborContractEnd) },
    { name: "phone", label: "联系方式", defaultValue: employee?.phone ?? "" },
    { name: "home_address", label: "家庭住址", defaultValue: employee?.homeAddress ?? "" },
    { name: "current_address", label: "现住地址", defaultValue: employee?.currentAddress ?? "" },
    { name: "emergency_contact", label: "紧急联络人", defaultValue: employee?.emergencyContact ?? "" },
    { name: "emergency_phone", label: "紧急联络人联系电话", defaultValue: employee?.emergencyPhone ?? "" },
    // 年龄/工龄/当月生日/合同到期提醒是派生列，不给输入框，只在列表里展示。
    { name: "remark", label: "备注", type: "textarea", defaultValue: employee?.remark ?? "" },
  ];
}

/**
 * 表单值 → 接口请求体。新建时留空的字段直接不发（用默认值），
 * 编辑时留空表示「清空」（发 null）—— 与 PATCH 的语义一致。
 * 入职/离职日期沿用旧行为（留空即不改），因为离职状态另有 /leave 与 /active 两个受控入口。
 */
function employeePayload(values: Record<string, string>, mode: "create" | "edit") {
  const blank = mode === "edit" ? null : undefined;
  const text = (key: string) => (values[key]?.trim() ? values[key].trim() : blank);
  const flag = (key: string) => (values[key] === "true" ? true : values[key] === "false" ? false : blank);
  return {
    employee_no: values.employee_no?.trim() || undefined,
    name: values.name?.trim(),
    department_id: values.department_id,
    position_id: values.position_id,
    employee_type: values.employee_type,
    hired_on: values.hired_on || undefined,
    left_on: values.left_on || undefined,
    remark: text("remark"),
    birth_date: values.birth_date || blank,
    gender: text("gender"),
    ethnicity: text("ethnicity"),
    id_card_no: text("id_card_no"),
    education: text("education"),
    blood_type: text("blood_type"),
    social_insurance: flag("social_insurance"),
    commercial_insurance: flag("commercial_insurance"),
    contract_start: values.contract_start || blank,
    contract_end: values.contract_end || blank,
    labor_contract_start: values.labor_contract_start || blank,
    labor_contract_end: values.labor_contract_end || blank,
    home_address: text("home_address"),
    current_address: text("current_address"),
    phone: text("phone"),
    emergency_contact: text("emergency_contact"),
    emergency_phone: text("emergency_phone"),
  };
}

/** 合同情况：三档 正常 / 即将过期 / 已过期；两份合同都没填结束时间时留空，列表回落 "-"。 */
const contractCell = (status?: string) => status || "-";

/**
 * 三张 `DataTable` 的显式列宽（本页只有这三处渲染表格，另有两个列数组 `ledgerColumns` /
 * `paymentColumns` 定义了但从未被渲染，不动它们）。
 *
 * 为什么必须有这张表：2026-10-09 起 `components/data/data-table.tsx` **一律**给 `<table>` 加
 * `data-table-fixed`（`table-layout: fixed`），没写 `meta.width` 的列由浏览器**均分**容器宽度 ——
 * 均分对「17 列、长短差三倍」的花名册是错的：工号和性别拿到一样宽。这一页按内容需要把宽度写死。
 *
 * 估算基准（与 `app/warehouse/stocktakes/page.tsx`、`components/qc/incoming-inspections-panel.tsx`
 * 同一套）：1366 屏下表格容器约 1034px；`.ui-table-cell` 的 `padding: 12px` 两侧共 24px 不装字；
 * 中文约 13px/字、ASCII 数字约 7px/字，表头 12px。「一列能显示几个字」≈ 百分比 × 1034 − 24。
 *
 * 两条配平铁律：
 *   ① 用了 `auditColumns()` 的表，**声明宽度总和 = 84%**：剩下 16% 留给工厂产出的
 *      「创建人 / 最后修改人」两列（各约 8%，够放「姓名 + 时间」两行）。这两列**不给宽度、
 *      也不改工厂用法** —— `lib/audit-columns-coverage.test.mjs` 盯着「整块铺 `auditColumns()`」
 *      这个写法。没有审计列的「导入错误明细」必须精确凑到 **100%**（否则缺口会被摊回其它列）。
 *   ② 「操作」列按按钮数估：`.action-row` 里每个 `size="sm"` 按钮约 44px + 间距 4px。
 *      员工目录最多 3 个按钮（编辑 / 离职 / 删除）= 3×44 + 2×4 = 140px ≈ 140 ÷ 1034 ≈ 13.5%；
 *      这里取 12%（=124px，去掉内边距剩 100px，正好一行排下 2 个，第 3 个由 `.action-row` 的
 *      `flex-wrap` 折到第二行）—— 与原料仓储页、盘点页同一取舍：宁可按钮折行，也不把文本列
 *      压到一上来就省略。再降到 11%（内容 90px）就只能一行一个按钮，不接受；最小不低于 8%。
 *
 * 逐表数字的来历：
 *   - 「导入错误明细」（3 列，无审计列，声明合计 100%）：照 `app/procurement/materials/page.tsx:279-281`
 *     的同形表 12 / 18 / 70 —— 「原因」是后端拼出来的整句中文（含列名与期望格式，能到上百字），
 *     余量全给它才不用悬停。
 *   - 「员工目录」（17 列 = 14 业务 + 2 审计 + 1 操作；**声明的 15 列合计 84%**）：17 列平分 1034px
 *     是 60px 一列（去掉内边距只剩 36px），所以每个数字都是「谁最需要」的排序：长文本列取规则给的
 *     6%~9% 的**下沿 6%**（姓名 / 部门职务 / 联系方式），短列 4%~5%（性别 / 类型 / 状态 / 合同情况），
 *     三个日期列各 6%，年龄 / 学历 / 工龄各 4% —— 先把 14 个业务列都塞进 72%（84% − 操作列 12%），
 *     宽度才有得谈。
 *     逐列的绝对宽度与「省到什么程度」写在下面每个键上。
 *   - 「考勤与绩效」（6 列 = 4 业务 + 2 审计；**声明的 4 列合计 84%**）：一行就是一条考勤或绩效，
 *     只有「日期/周期」会长（`2026-02-01 至 2026-02-28` ≈ 23 字符 ≈ 165px），所以另外三列按需要给
 *     8 / 16 / 12，剩下的 48% 全给它 —— 这张表只有 6 列，余量没必要摊给定长的短列。
 */
const COLUMN_WIDTH = {
  // 「导入错误明细」（3 列，无审计列，声明合计 100%）
  /** 行号是 Excel 里的行序（四位以内数字）：12%（内容 100px）。 */
  errorRowNo: "12%",
  /** 字段是模板里的列表头（2~6 字）：18%（内容 162px）。 */
  errorField: "18%",
  /** 原因是整句中文（最长的一条能到上百字）：70%（内容 700px）。 */
  errorReason: "70%",

  // 「员工目录」（15 个声明列，合计 84%；另 16% 归「创建人 / 最后修改人」两列）
  /** 工号：自动生成的是 `EMP-当天日期-序号`（≈17 字符 ≈ 120px），任何百分比都装不下 ——
   *  6%（=62px，内容 38px）只够显示前 5 个字符，全号靠 hover。 */
  employeeNo: "6%",
  /** 姓名 2~4 个汉字（26~52px）：6%（内容 38px）装得下 3 字，4 字靠 hover。 */
  employeeName: "6%",
  /** 「部门 / 职务」拼接串（8~12 字符 ≈ 85~150px）：6%（内容 38px）只够显示部门名，职务靠 hover。 */
  employeeOrg: "6%",
  /** 性别 `男` / `女`（13px）：4%（内容 17px）刚好。 */
  employeeGender: "4%",
  /** 出生日期 `1990-05-20`（10 字符 ≈ 70px，本来要 9%）：6%（内容 38px）显示到月份，hover 看全。 */
  employeeBirthDate: "6%",
  /** 年龄 `36`（14px）：4%（内容 17px）刚好。 */
  employeeAge: "4%",
  /** 学历 `初中` / `本科`（26px）：4%（内容 17px）会省略 —— 取舍：学历是花名册里的参考字段，
   *  宽度让给「状态」和「合同情况」这两个一眼要读出结论的列。 */
  employeeEducation: "4%",
  employeeHiredOn: "6%",
  /** 工龄 `0`~`16`（14~28px）：4% 刚好装两位数。 */
  employeeTenure: "4%",
  /** 联系方式 `138 0000 0000`（13 字符 ≈ 91px，本来要 11%）：6%（内容 38px）显示 `138 0…`，
   *  17 列的表给不起手机号的完整宽度，余下的靠 hover。 */
  employeePhone: "6%",
  /** 合同情况三档 `正常`（26px）/ `即将过期`（52px）/ `已过期`（39px）：5%（内容 28px）——
   *  「正常」完整，另两档显示 `即将…` / `已过…`，仍能分辨档位。 */
  employeeContract: "5%",
  /** 类型存的是 `workshop` 这类英文键（7 字符 ≈ 49px，本来要 7%）：4%（内容 17px）只显示前 2 个字符。 */
  employeeType: "4%",
  /** 状态 `在职`（26px）/ `已离职`（39px）：5%（内容 28px）—— 「在职」完整，其余显示前 2 字仍能分辨。 */
  employeeStatus: "5%",
  employeeLeftOn: "6%",
  /** 操作：最多 3 个按钮 = 140px ≈ 13.5%，取 12%（理由见上面的铁律 ②）。 */
  employeeActions: "12%",

  // 「考勤与绩效」（4 个声明列，合计 84%；另 16% 归「创建人 / 最后修改人」两列）
  /** 类型 `考勤` / `绩效`（26px）＋表头 2 字：8%（内容 59px）绰绰有余。 */
  recordType: "8%",
  /** 员工：姓名 2~4 字（52px 以内）；员工已不在目录时回落 `employeeId`：16%（内容 141px）。 */
  recordEmployee: "16%",
  /** 日期/周期是全表唯一的长文本（22~23 字符 ≈ 165px）：余量全给它，1366 屏下也不必省略。 */
  recordPeriod: "48%",
  /** 结果 `出勤` / `A 95` / `- 88`（≈4 字符 ≈ 40px）：12%（内容 100px）。 */
  recordResult: "12%",
} as const;

export default function HrPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<OrganizationItem[]>([]);
  const [positions, setPositions] = useState<OrganizationItem[]>([]);
  const [employeeTypes, setEmployeeTypes] = useState<EmployeeTypeItem[]>([
    {
      id: "employee_type_workshop",
      key: "workshop",
      label: "车间",
      isActive: true,
    },
    {
      id: "employee_type_non_workshop",
      key: "non_workshop",
      label: "非车间",
      isActive: true,
    },
  ]);
  const [attendance, setAttendance] = useState<RecordItem[]>([]);
  const [performance, setPerformance] = useState<RecordItem[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<DialogState | null>(
    null,
  );
  const [employeeQuery, setEmployeeQuery] = useState("");
  const [employeeStatus, setEmployeeStatus] = useState("");
  const [employeeDepartment, setEmployeeDepartment] = useState("");
  const [employeePosition, setEmployeePosition] = useState("");
  const [employeeType, setEmployeeType] = useState("");
  // 本月生日：不放进导入模板（它是按出生日期实时派生的），只作为员工列表的一个小筛选。
  const [employeeBirthday, setEmployeeBirthday] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Employee | null>(null);
  const [currencyCatalogue, setCurrencyCatalogue] = useState<CurrencyOption[]>([]);
  // 字典里没有首选币种时退回第一个可选值，保证 defaultValue 一定落在 options 里。
  const currencyDefault = (preferred: string) => { const options = currencyOptions(currencyCatalogue); return options.some((option) => option.value === preferred) ? preferred : (options[0]?.value ?? preferred); };
  // 币种是静态配置，不是在业务数据：挂在独立 effect 上，页面重新加载不会重复拉取。
  useEffect(() => { let cancelled = false; void fetchCurrencyOptions().then((options) => { if (!cancelled) setCurrencyCatalogue(options); }); return () => { cancelled = true; }; }, []);
  // 发放银行同为主数据，也挂独立 effect：拉不到就留空，弹窗里会明确提示去【财务 → 银行账户】建账户
  // （后端对没有银行的工资支付直接 422，不能靠前端悄悄放过去）。
  const [banks, setBanks] = useState<BankRef[]>([]);
  useEffect(() => { let cancelled = false; void apiGet<BankRef[]>("/finance/banks").then((result) => { if (!cancelled) setBanks(result.data); }).catch(() => { if (!cancelled) setBanks([]); }); return () => { cancelled = true; }; }, []);
  const bankOptions = useMemo(() => banks.filter((bank) => bank.isActive).map((bank) => ({ value: bank.id, label: `${bank.bankName} / ${bank.accountNumber}` })), [banks]);
  // 导入结果：除了成功/错误计数，还把「自动生成的工号」「按部门推断的员工类型」
  // 「忽略的列」「末尾被批注挡掉的行」如实回显 —— 手动花名册直接上传时会命中后两项。
  const [importResult, setImportResult] = useState<{ imported: number; total: number; successCount: number; errorCount: number; autoNumbered?: number; inferredEmployeeTypes?: number; ignoredColumns?: string[]; ignoredTrailingRows?: number; headerRow?: number; missingColumns?: string[]; hints?: string[]; errors: { row: number; field?: string; reason: string }[] } | null>(null);
  async function load() {
    setLoading(true);
    setError("");
    try {
      const [e, d, po, a, p, l, s] = await Promise.all([
        // include_deleted=true：已逻辑删除的员工要能被「已删除」筛选看到并恢复；
        // 默认的全部状态仍然不显示它们（下面 filteredEmployees 里排除）。
        apiGet<Employee[]>("/production/employees?include_deleted=true"),
        apiGet<OrganizationItem[]>("/production/departments"),
        apiGet<OrganizationItem[]>("/production/positions"),
        apiGet<RecordItem[]>("/hr/attendance-records"),
        apiGet<RecordItem[]>("/hr/performance-records"),
        apiGet<Ledger[]>("/hr/payroll-ledgers"),
        apiGet<Payment[]>("/hr/salary-payments"),
      ]);
      // 币种来自可配置字典（失败回落内置清单）：薪资台账和工资支付都要能选币种。
      setEmployees(e.data);
      setDepartments(d.data);
      setPositions(po.data);
      setAttendance(a.data);
      setPerformance(p.data);
      setLedgers(l.data);
      setPayments(s.data);
    } catch (cause) {
      setError(messageOf(cause, "人事数据加载失败"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function action(path: string, body?: unknown, success = "操作已完成") {
    setError("");
    try {
      await apiPost(path, body);
      notifySuccess(success)
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "操作失败"));
    }
  }
  async function runPatch(path: string, body: unknown, success: string) {
    setError("");
    try {
      await apiPatch(path, body);
      notifySuccess(success)
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "操作失败"));
    }
  }
  // 删除员工 = 逻辑删除（DELETE 无请求体）；恢复 = POST /restore。两者都只需管理员权限。
  async function removeEmployee(employee: Employee) {
    setError("");
    try {
      await apiRequest(`/production/employees/${employee.id}`, { method: "DELETE" });
      notifySuccess(`已移除员工「${employee.name}」，可在「已删除」里恢复`);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "删除员工失败"));
    }
  }
  async function restoreEmployee(employee: Employee) {
    setError("");
    try {
      await apiPost(`/production/employees/${employee.id}/restore`);
      notifySuccess(`员工「${employee.name}」已恢复`);
      await load();
    } catch (cause) {
      notifyError(messageOf(cause, "恢复员工失败"));
    }
  }
  async function exportEmployees() {
    setError("");
    try {
      const params = new URLSearchParams();
      if (employeeQuery.trim()) params.set("query", employeeQuery.trim());
      if (employeeStatus) params.set("employment_status", employeeStatus);
      if (employeeDepartment) params.set("department_id", employeeDepartment);
      if (employeePosition) params.set("position_id", employeePosition);
      if (employeeType) params.set("employee_type", employeeType);
      const response = await fetch(
        `/api/v1/production/employees/export.xlsx?${params}`,
        { credentials: "include", cache: "no-store" },
      );
      if (!response.ok) throw new Error(`导出失败（HTTP ${response.status}）`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `迪礼ERP-员工名单-${new Date().toISOString().slice(0, 10)}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage("员工名单已导出");
    } catch (cause) {
      notifyError(messageOf(cause, "员工名单导出失败"));
    }
  }
  async function downloadImportTemplate() { const response = await fetch("/api/v1/production/employees/import-template.xlsx", { credentials: "include", cache: "no-store" }); if (!response.ok) { setError("模板下载失败"); return; } const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "迪礼ERP-员工导入模板.xlsx"; anchor.click(); URL.revokeObjectURL(url); }
  async function importEmployees(file: File | undefined) { if (!file) return; setError(""); setImportResult(null); const form = new FormData(); form.append("file", file); try { const response = await fetch("/api/v1/production/employees/import", { method: "POST", credentials: "include", body: form }); const body = await response.json(); if (!response.ok || body.error) throw new ApiClientError(body.error?.code ?? "IMPORT_FAILED", body.error?.message ?? "导入失败", body.error?.details ?? []); setImportResult(body.data); if (body.data.imported > 0) { setMessage(`成功导入 ${body.data.imported} 行${body.data.errorCount ? `，${body.data.errorCount} 行未导入` : ""}`); await load(); } } catch (cause) { notifyError(messageOf(cause, "员工导入失败")); } }
  const employeeOptions = employees.map((item) => ({
    value: item.id,
    label: `${item.employeeNo} / ${item.name}`,
  }));
  function openDepartment(values?: Record<string, string>) {
    if (values && dialog)
      setDialog({
        ...dialog,
        fields: dialog.fields.map((field) => ({
          ...field,
          defaultValue: values[field.name] ?? field.defaultValue,
        })),
      });
    setCategoryDialog({
      title: "新建部门",
      fields: [
        { name: "code", label: "部门编码", required: true },
        { name: "name", label: "部门名称", required: true },
        { name: "remark", label: "备注", type: "textarea" },
      ],
      submit: async (v) => {
        try {
          const result = await apiPost<OrganizationItem>(
            "/production/departments",
            { ...v, remark: v.remark || undefined },
          );
          setDepartments((items) => [
            ...items.filter((item) => item.id !== result.data.id),
            result.data,
          ]);
          setDialog((current) =>
            current
              ? {
                  ...current,
                  fields: current.fields.map((field) =>
                    field.name === "department_id"
                      ? {
                          ...field,
                          defaultValue: result.data.id,
                          options: [
                            ...(field.options ?? []),
                            {
                              value: result.data.id,
                              label: `${result.data.code} / ${result.data.name}`,
                            },
                          ],
                        }
                      : field,
                  ),
                }
              : current,
          );
          setCategoryDialog(null);
          setMessage("部门已创建");
        } catch (cause) {
          notifyError(messageOf(cause, "部门创建失败"));
        }
      },
    });
  }
  function openPosition(values?: Record<string, string>) {
    if (values && dialog)
      setDialog({
        ...dialog,
        fields: dialog.fields.map((field) => ({
          ...field,
          defaultValue: values[field.name] ?? field.defaultValue,
        })),
      });
    setCategoryDialog({
      title: "新建岗位",
      fields: [
        {
          name: "department_id",
          label: "所属部门",
          type: "select",
          required: true,
          options: departments
            .filter((item) => item.isActive)
            .map((item) => ({
              value: item.id,
              label: `${item.code} / ${item.name}`,
            })),
        },
        { name: "code", label: "岗位编码", required: true },
        { name: "name", label: "岗位名称", required: true },
        { name: "remark", label: "备注", type: "textarea" },
      ],
      submit: async (v) => {
        try {
          const result = await apiPost<OrganizationItem>(
            "/production/positions",
            { ...v, remark: v.remark || undefined },
          );
          setPositions((items) => [
            ...items.filter((item) => item.id !== result.data.id),
            result.data,
          ]);
          setDialog((current) =>
            current
              ? {
                  ...current,
                  fields: current.fields.map((field) =>
                    field.name === "position_id"
                      ? {
                          ...field,
                          defaultValue: result.data.id,
                          options: [
                            ...(field.options ?? []),
                            {
                              value: result.data.id,
                              label: `${result.data.code} / ${result.data.name}`,
                            },
                          ],
                        }
                      : field,
                  ),
                }
              : current,
          );
          setCategoryDialog(null);
          setMessage("岗位已创建");
        } catch (cause) {
          notifyError(messageOf(cause, "岗位创建失败"));
        }
      },
    });
  }
  function openEmployeeType() {
    setError("员工类型已固定为车间和非车间");
  }
  function createEmployee(returnTo?: {
    dialog: DialogState;
    values: Record<string, string>;
  }) {
    setDialog({
      title: "新建员工",
      fields: employeeRosterFields(undefined, departments, positions, employeeTypes),
      submit: async (v) => {
        try {
          const result = await apiPost<Employee>("/production/employees", employeePayload(v, "create"));
          setEmployees((items) => [
            ...items.filter((item) => item.id !== result.data.id),
            result.data,
          ]);
          setMessage("员工已创建");
          const source = returnTo;
          if (source)
            setDialog({
              ...source.dialog,
              fields: source.dialog.fields.map((field) =>
                field.name === "employee_id"
                  ? {
                      ...field,
                      defaultValue: result.data.id,
                      options: [
                        ...(field.options ?? []),
                        {
                          value: result.data.id,
                          label: `${result.data.employeeNo} / ${result.data.name}`,
                        },
                      ],
                    }
                  : field,
              ),
            });
          else setDialog(null);
          await load();
        } catch (cause) {
          notifyError(messageOf(cause, "员工创建失败"));
        }
      },
    });
  }
  function editEmployee(employee: Employee) {
    setDialog({
      title: "编辑员工",
      fields: employeeRosterFields(employee, departments, positions, employeeTypes),
      submit: (v) =>
        void runPatch(
          `/production/employees/${employee.id}`,
          employeePayload(v, "edit"),
          "员工信息已更新",
        ),
    });
  }
  function leaveEmployee(employee: Employee) {
    setDialog({
      title: "办理离职",
      fields: [
        {
          name: "left_on",
          label: "离职日期",
          type: "date",
          required: true,
          defaultValue: new Date().toISOString().slice(0, 10),
        },
      ],
      submit: (v) =>
        void runPatch(
          `/production/employees/${employee.id}/leave`,
          { left_on: v.left_on },
          "员工已办理离职",
        ),
    });
  }
  function createAttendance() {
    setDialog({
      title: "登记考勤",
      fields: [
        {
          name: "employee_id",
          label: "员工",
          type: "select",
          required: true,
          options: employeeOptions,
        },
        {
          name: "attendance_date",
          label: "考勤日期",
          type: "date",
          required: true,
          defaultValue: new Date().toISOString().slice(0, 10),
        },
        {
          name: "work_start_time",
          label: "上班时间",
          type: "time",
          required: true,
          defaultValue: "09:00",
        },
        {
          name: "work_end_time",
          label: "下班时间",
          type: "time",
          required: true,
          defaultValue: "18:00",
        },
        {
          name: "attendance_type",
          label: "考勤类型",
          required: true,
          defaultValue: "出勤",
        },
        { name: "remark", label: "备注", type: "textarea" },
      ],
      submit: (v) =>
        void action(
          "/hr/attendance-records",
          {
            employee_id: v.employee_id,
            attendance_date: v.attendance_date,
            work_start_time: v.work_start_time,
            work_end_time: v.work_end_time,
            attendance_type: v.attendance_type,
            remark: v.remark || undefined,
          },
          "考勤已登记",
        ),
    });
  }
  function createPerformance() {
    setDialog({
      title: "登记绩效",
      fields: [
        {
          name: "employee_id",
          label: "员工",
          type: "select",
          required: true,
          options: employeeOptions,
        },
        {
          name: "period_start",
          label: "周期开始",
          type: "date",
          required: true,
        },
        { name: "period_end", label: "周期结束", type: "date", required: true },
        { name: "score", label: "评分", type: "number", defaultValue: "100" },
        { name: "grade", label: "等级", defaultValue: "A" },
      ],
      submit: (v) =>
        void action(
          "/hr/performance-records",
          {
            employee_id: v.employee_id,
            period_start: v.period_start,
            period_end: v.period_end,
            score: v.score,
            grade: v.grade,
          },
          "绩效已登记",
        ),
    });
  }
  function generateLedger() {
    setDialog({
      title: "生成薪资台账",
      fields: [
        {
          name: "employee_name",
          label: "员工",
          type: "select",
          required: true,
          options: employeeOptions,
        },
        {
          name: "period_start",
          label: "周期开始",
          type: "date",
          required: true,
        },
        { name: "period_end", label: "周期结束", type: "date", required: true },
        { name: "currency", label: "币种", type: "select", required: true, options: currencyOptions(currencyCatalogue), defaultValue: currencyDefault("CNY") },
        {
          name: "base_salary",
          label: "基本工资",
          type: "number",
          required: true,
          defaultValue: "0",
        },
      ],
      submit: (v) =>
        void action(
          "/hr/payroll-ledgers/generate",
          {
            employee_name: v.employee_name,
            period_start: v.period_start,
            period_end: v.period_end,
            currency: v.currency,
            base_salary: v.base_salary,
          },
          "薪资台账已生成",
        ),
    });
  }
  function createPayment() {
    setDialog({
      title: "登记工资支付",
      fields: [
        { name: "amount", label: "支付金额", type: "number", required: true },
        {
          name: "payment_date",
          label: "支付日期",
          type: "date",
          required: true,
          defaultValue: new Date().toISOString().slice(0, 10),
        },
        {
          name: "payment_method",
          label: "支付方式",
          required: true,
          defaultValue: "银行转账",
        },
        { name: "currency", label: "币种", type: "select", required: true, options: currencyOptions(currencyCatalogue), defaultValue: currencyDefault("CNY") },
        // 发放银行必填：发工资都是通过银行账户发放的，缺了它这笔支出不会落到任何账户上。
        { name: "bank_id", label: bankOptions.length ? "发放银行（发工资必须走银行账户）" : "发放银行（请先在【财务 → 银行账户】建一个账户）", type: "select", required: true, options: bankOptions, defaultValue: bankOptions[0]?.value },
      ],
      submit: (v) =>
        void action(
          "/hr/salary-payments",
          {
            payment_date: v.payment_date,
            amount: v.amount,
            currency: v.currency,
            payment_method: v.payment_method,
            bank_id: v.bank_id,
          },
          "工资支付草稿已创建",
        ),
    });
  }
  const employeeName = (id: string) =>
    employees.find((item) => item.id === id)?.name ?? id;
  // 员工的「状态」= 已删除 优先于在职/离职/停用：删除是比在离职更高一层的事实。
  // 「全部状态」刻意**不含**已删除（删除就该从列表里消失），要看得专门筛「已删除」。
  const employeeState = (item: Employee) =>
    item.deletedAt ? "deleted" : item.employmentStatus;
  const filteredEmployees = useMemo(
    () =>
      employees.filter((item) => {
        const query = employeeQuery.trim().toLowerCase();
        const state = employeeState(item);
        return (
          (!query ||
            `${item.employeeNo} ${item.name}`.toLowerCase().includes(query)) &&
          (employeeStatus ? state === employeeStatus : state !== "deleted") &&
          (!employeeDepartment || item.department?.id === employeeDepartment) &&
          (!employeePosition || item.position?.id === employeePosition) &&
          (!employeeType || item.employeeType === employeeType) &&
          (employeeBirthday !== "this_month" || item.birthdayThisMonth === true)
        );
      }),
    [
      employees,
      employeeBirthday,
      employeeDepartment,
      employeePosition,
      employeeQuery,
      employeeStatus,
      employeeType,
    ],
  );
  // 列表列 = 花名册口径（含后端实时算出的年龄/工龄/合同到期提醒）。
  //
  // 每列显式给 `meta.width`（数字的来历见文件顶部 COLUMN_WIDTH），声明合计 84%；没给宽度的只有
  // `auditColumns()` 产出的两列，它们分剩下的 16%。
  //
  // 纯文本列写成 `accessorFn`（返回**屏幕上那串字**）而不是只写 `cell`：`DataTable` 的 hover `title`
  // 与 `cell-ellipsis` 都要求这一列**取得到值**，自定义 `cell` 渲染出来的是 ReactNode，取不到值 ——
  // 那种列既没有省略号也没有 hover 全文（契约见 `test/data-table-ellipsis.test.tsx`）。
  const employeeColumns: ColumnDef<Employee>[] = [
    { accessorKey: "employeeNo", header: "工号", meta: { width: COLUMN_WIDTH.employeeNo } },
    { accessorKey: "name", header: "姓名", meta: { width: COLUMN_WIDTH.employeeName } },
    {
      id: "org",
      header: "部门/职务",
      meta: { width: COLUMN_WIDTH.employeeOrg },
      accessorFn: (row) => `${row.department?.name ?? "-"} / ${row.position?.name ?? "-"}`,
    },
    { id: "gender", header: "性别", meta: { width: COLUMN_WIDTH.employeeGender }, accessorFn: (row) => row.gender ?? "-" },
    {
      id: "birthDate",
      header: "出生日期",
      meta: { width: COLUMN_WIDTH.employeeBirthDate },
      accessorFn: (row) => isoDate(row.birthDate) || "-",
    },
    {
      id: "age",
      header: "年龄",
      meta: { width: COLUMN_WIDTH.employeeAge },
      accessorFn: (row) => (row.age === null || row.age === undefined ? "-" : String(row.age)),
    },
    { id: "education", header: "学历", meta: { width: COLUMN_WIDTH.employeeEducation }, accessorFn: (row) => row.education ?? "-" },
    {
      id: "hiredOn",
      header: "入职日期",
      meta: { width: COLUMN_WIDTH.employeeHiredOn },
      accessorFn: (row) => isoDate(row.hiredOn) || "-",
    },
    {
      id: "tenure",
      header: "工龄",
      meta: { width: COLUMN_WIDTH.employeeTenure },
      accessorFn: (row) => (row.tenureYears === null || row.tenureYears === undefined ? "-" : String(row.tenureYears)),
    },
    { id: "phone", header: "联系方式", meta: { width: COLUMN_WIDTH.employeePhone }, accessorFn: (row) => row.phone ?? "-" },
    {
      // 劳动合同与劳务合同合成一列：取两者中最紧急的档位（已过期 > 即将过期 > 正常）。
      id: "contract",
      header: "合同情况",
      meta: { width: COLUMN_WIDTH.employeeContract },
      accessorFn: (row) => contractCell(row.contractSituation),
    },
    { accessorKey: "employeeType", header: "类型", meta: { width: COLUMN_WIDTH.employeeType } },
    {
      id: "status",
      header: "状态",
      meta: { width: COLUMN_WIDTH.employeeStatus },
      accessorFn: (row) =>
        row.deletedAt
          ? "已删除"
          : displayStatus(row.employmentStatus),
    },
    {
      id: "leftOn",
      header: "离职日期",
      meta: { width: COLUMN_WIDTH.employeeLeftOn },
      accessorFn: (row) => isoDate(row.leftOn) || "-",
    },
    ...auditColumns<Employee>(),
    {
      // 控件列（按钮）：不写 accessor —— 拿不到文本就不加 `cell-ellipsis`，按钮才不会被 nowrap 裁掉。
      id: "actions",
      header: "操作",
      meta: { width: COLUMN_WIDTH.employeeActions },
      cell: ({ row }) => (
        <div className="action-row">
          {row.original.deletedAt ? (
            // 已删除的行只留一个「恢复」：删除是可逆的，不需要为它保留编辑入口。
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void restoreEmployee(row.original)}
            >
              恢复
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => editEmployee(row.original)}
              >
                编辑
              </Button>
              {row.original.employmentStatus === "active" && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => leaveEmployee(row.original)}
                >
                  离职
                </Button>
              )}
              {/* 删除是逻辑删除，会从所有选择器里消失，所以先弹出确认。
                  按钮配色跟随部门池/岗位池的约定：状态变更用 ghost，删除用 destructive。 */}
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setDeleteTarget(row.original)}
              >
                删除
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];
  // 「考勤与绩效」的 4 个业务列：同样是「自己算出屏幕上的字」的文本列，写成 `accessorFn` 才有
  // hover 全文 + 省略号（理由同上面的员工目录）。宽度声明合计 84%，另 16% 归两列审计列。
  const recordColumns: ColumnDef<RecordItem>[] = [
    {
      id: "type",
      header: "类型",
      meta: { width: COLUMN_WIDTH.recordType },
      accessorFn: (row) => (row.attendanceDate ? "考勤" : "绩效"),
    },
    {
      id: "employee",
      header: "员工",
      meta: { width: COLUMN_WIDTH.recordEmployee },
      accessorFn: (row) => employeeName(row.employeeId),
    },
    {
      id: "period",
      header: "日期/周期",
      meta: { width: COLUMN_WIDTH.recordPeriod },
      accessorFn: (row) =>
        row.attendanceDate
          ? `${row.attendanceDate.slice(0, 10)} ${row.workStartTime ?? "-"}-${row.workEndTime ?? "-"}`
          : `${row.periodStart?.slice(0, 10)} 至 ${row.periodEnd?.slice(0, 10)}`,
    },
    {
      id: "result",
      header: "结果",
      meta: { width: COLUMN_WIDTH.recordResult },
      accessorFn: (row) =>
        row.attendanceType ??
        `${row.grade ?? "-"} ${row.score ?? ""}`,
    },
    ...auditColumns<RecordItem>(),
  ];
  const ledgerColumns: ColumnDef<Ledger>[] = [
    {
      id: "employee",
      header: "员工",
      cell: ({ row }) => employeeName(row.original.employeeId),
    },
    {
      id: "period",
      header: "周期",
      cell: ({ row }) =>
        `${row.original.periodStart.slice(0, 10)} 至 ${row.original.periodEnd.slice(0, 10)}`,
    },
    {
      id: "amount",
      header: "应付",
      cell: ({ row }) =>
        `${row.original.payableAmount} ${row.original.currency}`,
    },
    { accessorKey: "status", header: "状态" },
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) => (
        <>
          {row.original.status === "draft" && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void action(
                  `/hr/payroll-ledgers/${row.original.id}/confirm`,
                  undefined,
                  "薪资台账已确认",
                )
              }
            >
              确认
            </Button>
          )}
          {row.original.status === "paid" && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void action(
                  `/hr/payroll-ledgers/${row.original.id}/close`,
                  undefined,
                  "薪资台账已关闭",
                )
              }
            >
              关闭
            </Button>
          )}
        </>
      ),
    },
  ];
  const paymentColumns: ColumnDef<Payment>[] = [
    { accessorKey: "paymentNo", header: "支付单号" },
    {
      id: "date",
      header: "日期",
      cell: ({ row }) => row.original.paymentDate.slice(0, 10),
    },
    {
      id: "amount",
      header: "金额",
      cell: ({ row }) => `${row.original.amount} ${row.original.currency}`,
    },
    { accessorKey: "status", header: "状态" },
  ];
  if (categoryDialog)
    return (
      <ActionDialog
        open
        title={categoryDialog.title}
        fields={categoryDialog.fields}
        onOpenChange={(open) => {
          if (!open) setCategoryDialog(null);
        }}
        onSubmit={(values) => {
          void categoryDialog.submit(values);
        }}
      />
    );
  if (loading)
    return (
      <>
        <PageHeader title="人事" />
        <LoadingState />
      </>
    );
  return (
    <div className="page-root" data-testid="page-hr">
      <PageHeader title="人事">
        <div className="page-actions">
          <Button onClick={() => createEmployee()}>新建员工</Button>
          <Button variant="secondary" onClick={createAttendance}>
            登记考勤
          </Button>
          <Button variant="secondary" onClick={createPerformance}>
            登记绩效
          </Button>
          <Button variant="secondary" onClick={() => void exportEmployees()}>
            导出员工名单
          </Button>
          <Button variant="secondary" onClick={() => void downloadImportTemplate()}>下载导入模板</Button>
          <Button variant="secondary" onClick={() => { setImportResult(null); setImportOpen(true); }}>批量导入员工</Button>
          <Link className="button button-secondary" href="/hr/departments">
            部门池
          </Link>
          <Link className="button button-secondary" href="/hr/positions">
            岗位池
          </Link>
        </div>
      </PageHeader>
      <Dialog open={importOpen} onOpenChange={setImportOpen}><DialogContent className="hr-import-dialog"><DialogHeader><DialogTitle>批量导入员工</DialogTitle></DialogHeader><DialogBody><p>请使用模板填写员工信息。系统按表头名识别列（列顺序可以调整），先逐行校验格式，通过校验的行会直接导入，出错的行在下方逐条列出，不会因为个别错误整批丢弃。工号留空时按 EMP-当天日期-序号 自动生成。手动维护的花名册（首行是标题、末尾有说明批注）也能直接上传。</p><FileInput accept=".xlsx" onChange={(event) => { void importEmployees(event.target.files?.[0]); event.currentTarget.value = ""; }} />{importResult && <div className="panel-body"><p>共 {importResult.total} 行：成功 {importResult.successCount} 行 / 错误 {importResult.errorCount} 行</p>{Boolean(importResult.autoNumbered) && <p>其中 {importResult.autoNumbered} 行工号由系统自动生成</p>}{Boolean(importResult.inferredEmployeeTypes) && <p>其中 {importResult.inferredEmployeeTypes} 行的员工类型按所属部门已有员工推断，请复核</p>}{(importResult.hints ?? []).map((hint) => <p key={hint} className="panel-note">{hint}</p>)}{Boolean(importResult.ignoredColumns?.length) && <p>以下列不属于员工口径，已忽略：{importResult.ignoredColumns?.join("、")}</p>}{importResult.errors.length > 0 && <DataTable columns={[{ accessorKey: "row", header: "行号", meta: { width: COLUMN_WIDTH.errorRowNo } }, { accessorKey: "field", header: "字段", meta: { width: COLUMN_WIDTH.errorField } }, { accessorKey: "reason", header: "原因", meta: { width: COLUMN_WIDTH.errorReason } }]} data={importResult.errors} empty={null} />}</div>}</DialogBody></DialogContent></Dialog>
      {/* 删除确认：用项目里到处在用的 Dialog，而不是 components/ui/alert-dialog.tsx ——
          后者的 Content 包装在当前 Radix 版本下渲染即崩（"Primitive.div failed to slot onto its
          children"），而且全仓库没有任何调用方，属于未验证过的死代码。 */}
      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="hr-delete-dialog">
          <DialogHeader>
            <DialogTitle>删除员工</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <DialogDescription>
              确认把「{deleteTarget?.employeeNo} {deleteTarget?.name}
              」从员工列表移除？这是逻辑删除：他会从员工列表和所有选择器里消失，但历史生产日报、考勤、绩效和工资台账全部保留；在「已删除」筛选里点「恢复」即可还原。
            </DialogDescription>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = deleteTarget;
                setDeleteTarget(null);
                if (target) void removeEmployee(target);
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ActionDialog
        open={Boolean(dialog)}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title={dialog?.title ?? "操作"}
        fields={dialog?.fields ?? []}
        // 身份证号一变就重新解析出生日期、性别和住址的省市县（手填的镇/村/门牌保留）。
        // 只在 id_card_no 变化时触发；旧省市县由 lib/id-card.ts 从地址开头自己认，不依赖编辑顺序。
        deriveValues={(changedField, values) =>
          changedField === "id_card_no"
            ? deriveEmployeeFieldsFromIdCard(values.id_card_no, values)
            : {}
        }
        onAddCategory={(field, values) => {
          if (field.name === "department_id") openDepartment(values);
          else if (field.name === "position_id") openPosition(values);
          else if (field.name === "employee_type")
            setError("员工类型已固定为车间和非车间");
          else if (field.name === "employee_id" && dialog) {
            createEmployee({
              dialog: {
                ...dialog,
                fields: dialog.fields.map((item) => ({
                  ...item,
                  defaultValue: values[item.name] ?? item.defaultValue,
                })),
              },
              values,
            });
          } else setError("请在生产基础资料中维护");
        }}
        onSubmit={(values) => {
          dialog?.submit(values);
          setDialog(null);
        }}
      />
      {message && (
        <section className="panel panel-body status-success" role="status">
          {message}
        </section>
      )}
      {error && (
        <section className="panel">
          <ErrorState message={error} onRetry={() => void load()} />
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>员工目录</h2>
        </div>
        <div className="panel-body">
          <div className="filter-bar">
            <Input
              value={employeeQuery}
              onChange={(event) => setEmployeeQuery(event.target.value)}
              placeholder="搜索工号或姓名"
            />
            <Select
              value={employeeStatus || "all"}
              onValueChange={(value) =>
                setEmployeeStatus(value === "all" ? "" : value)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="员工状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="active">在职</SelectItem>
                <SelectItem value="left">离职</SelectItem>
                <SelectItem value="inactive">停用</SelectItem>
                <SelectItem value="deleted">已删除</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={employeeDepartment || "all"}
              onValueChange={(value) =>
                setEmployeeDepartment(value === "all" ? "" : value)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="部门" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部部门</SelectItem>
                {departments
                  .filter((item) => item.isActive)
                  .map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Select
              value={employeePosition || "all"}
              onValueChange={(value) =>
                setEmployeePosition(value === "all" ? "" : value)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="岗位" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部岗位</SelectItem>
                {positions
                  .filter((item) => item.isActive)
                  .map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Select
              value={employeeType || "all"}
              onValueChange={(value) =>
                setEmployeeType(value === "all" ? "" : value)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="员工类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类型</SelectItem>
                {employeeTypes.map((item) => (
                  <SelectItem key={item.key} value={item.key}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* 本月生日：按出生日期实时判断（生日所在自然月 == 当月），不需要在模板里填。 */}
            <Select
              value={employeeBirthday || "all"}
              onValueChange={(value) =>
                setEmployeeBirthday(value === "all" ? "" : value)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="生日" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部生日</SelectItem>
                <SelectItem value="this_month">本月生日</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DataTable
            columns={employeeColumns}
            data={filteredEmployees}
            empty={<EmptyState title="暂无匹配员工" />}
          />
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>考勤与绩效</h2>
        </div>
        <div className="panel-body">
          <DataTable
            columns={recordColumns}
            data={[...attendance, ...performance]}
            empty={<EmptyState title="暂无考勤或绩效记录" />}
          />
        </div>
      </section>
    </div>
  );
}

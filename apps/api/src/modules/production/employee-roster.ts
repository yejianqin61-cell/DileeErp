/**
 * 员工花名册口径（人事导入模板）。
 *
 * 背景：人事导入模板从旧的 8 列（工号/姓名/部门编码/岗位编码/员工类型/入职日期/离职日期/备注）
 * 换成《在职员工花名册》的口径，员工档案要能承载身份、学历、社保与合同信息。本模块是这套口径的
 * **唯一权威定义**：表头别名、字段解析、派生列计算都收在这里，导入 / 导出 / 模板三处共用，
 * 避免「模板加了一列但解析没跟上」这类错位。
 *
 * 三层结构：
 *   1. 花名册原始列（28 列）——其中 5 列是公式派生（年龄/工龄/当月生日员工/合同即将到期人员/
 *      劳务合同即将到期人员），不落库、不导入，只在导出时按当天日期实时算出。
 *   2. 导入模板列（26 列）——花名册的全部非派生字段 + 系统必需的三列（工号/员工类型/离职日期）。
 *   3. 导出列（37 列）——花名册原始顺序（含派生列）+ 系统列，可直接回灌导入（解析按表头名匹配）。
 *
 * 解析按**表头名**而不是列序号匹配（同时接受若干同义写法），因此：
 *   - 操作员在模板里挪动列顺序、增删无关列都不会错位；
 *   - 旧版 8 列模板仍然可导入（工号/部门编码/岗位编码/员工类型/入职日期/离职日期/备注 都有别名）；
 *   - 花名册原表（标题在首行、合同起止是两行合并表头、末尾有批注块）也能直接导入，见 locateHeaderRow。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Excel 序列日期换算窗口：10000 ≈ 1927-05-18，60000 ≈ 2064-03-06。
 * 只在单元格是裸数字时使用，窗口外的数字（例如把年份写成 2026、或把手机号塞进日期列）
 * 一律当非法日期报错，而不是悄悄换算成一个荒谬的日期。
 */
const EXCEL_SERIAL_MIN = 10000;
const EXCEL_SERIAL_MAX = 60000;

/** 合同到期提醒窗口：到期前一个月开始提示（花名册黄色批注的要求）。 */
const CONTRACT_EXPIRY_WINDOW_DAYS = 31;

// ---------------------------------------------------------------------------
// 字段与表头
// ---------------------------------------------------------------------------

export type EmployeeRosterField =
  | "employee_no"
  | "name"
  | "department"
  | "position"
  | "status"
  | "employee_type"
  | "birth_date"
  | "education"
  | "blood_type"
  | "hired_on"
  | "left_on"
  | "social_insurance"
  | "commercial_insurance"
  | "contract_start"
  | "contract_end"
  | "labor_contract_start"
  | "labor_contract_end"
  | "gender"
  | "ethnicity"
  | "id_card_no"
  | "home_address"
  | "current_address"
  | "phone"
  | "emergency_contact"
  | "emergency_phone"
  | "remark";

/**
 * 表头别名：左边是内部字段，右边是文件里可以出现的列名。
 * 匹配顺序 = 数组顺序 = 优先级（第一个命中的列生效），因此同一字段的「主表头」写在最前。
 */
export const EMPLOYEE_HEADER_ALIASES: Record<EmployeeRosterField, readonly string[]> = {
  employee_no: ["工号", "员工工号", "员工编号", "工号/编号"],
  name: ["姓名", "员工姓名"],
  // 部门：列名可能是名称或编码，取值时统一「先按编码、再按名称」解析，所以两者共用同一个字段。
  department: ["部门", "部门名称", "部门编码", "所属部门"],
  // 职务是花名册的叫法，系统内部叫岗位；岗位/岗位名称/岗位编码同样共用。
  position: ["职务", "岗位", "岗位名称", "岗位编码", "职务/岗位"],
  status: ["状态", "员工状态", "在职状态"],
  employee_type: ["员工类型", "类型"],
  birth_date: ["出生日期", "出生年月", "生日"],
  education: ["学历"],
  blood_type: ["血型"],
  hired_on: ["入职日期", "入职时间", "到岗日期"],
  left_on: ["离职日期", "离职时间", "离岗日期"],
  social_insurance: ["是否缴纳社保", "社保"],
  commercial_insurance: ["是否缴纳商业险", "商业险"],
  contract_start: ["合同开始时间", "合同起止时间-开始时间", "劳动合同开始时间", "合同起始时间", "合同开始日期"],
  contract_end: ["合同结束时间", "合同起止时间-结束时间", "劳动合同结束时间", "合同终止时间", "合同到期时间", "合同结束日期"],
  labor_contract_start: ["劳务合同开始时间", "劳务合同-开始时间", "劳务合同起始时间", "劳务合同开始日期"],
  labor_contract_end: ["劳务合同结束时间", "劳务合同-结束时间", "劳务合同终止时间", "劳务合同到期时间", "劳务合同结束日期"],
  gender: ["性别"],
  ethnicity: ["民族"],
  id_card_no: ["身份证号码", "身份证号", "身份证"],
  home_address: ["家庭住址", "户籍地址", "身份证住址"],
  current_address: ["现住地址", "现居地址", "现住址"],
  phone: ["联系方式", "联系电话", "手机号码", "手机号", "电话"],
  emergency_contact: ["紧急联络人", "紧急联系人"],
  emergency_phone: ["紧急联络人联系电话", "紧急联系人电话", "紧急联络电话", "紧急联系人联系电话"],
  remark: ["备注", "员工备注"],
};

/** 花名册里由公式派生、不导入也不落库的列（导出时实时计算，导入时静默忽略）。 */
export const EMPLOYEE_DERIVED_HEADERS = [
  "年龄",
  "工龄",
  "当月生日员工",
  "合同即将到期人员",
  "劳务合同即将到期人员",
] as const;

/** 花名册里纯排版用的列（序号），导入时忽略。 */
export const EMPLOYEE_IGNORED_HEADERS = ["序号", ...EMPLOYEE_DERIVED_HEADERS] as const;

/**
 * 导入模板的表头（26 列）：花名册的全部非派生字段，加上系统必需的三列。
 * 顺序贴近花名册原表，方便操作员对照填写。
 */
export const EMPLOYEE_IMPORT_HEADERS = [
  "工号",
  "姓名",
  "部门",
  "职务",
  "状态",
  "出生日期",
  "学历",
  "血型",
  "入职日期",
  "离职日期",
  "员工类型",
  "是否缴纳社保",
  "是否缴纳商业险",
  "合同开始时间",
  "合同结束时间",
  "劳务合同开始时间",
  "劳务合同结束时间",
  "性别",
  "民族",
  "身份证号码",
  "家庭住址",
  "现住地址",
  "联系方式",
  "紧急联络人",
  "紧急联络人联系电话",
  "备注",
] as const;

/** 模板里给操作员看的示例行（工号留空表示让系统自动生成；身份证号是校验位自洽的示例）。 */
export const EMPLOYEE_IMPORT_SAMPLE_ROW = [
  "",
  "张三",
  "生产部",
  "合片工",
  "在职",
  "1990-05-20",
  "初中",
  "O",
  "2020-03-30",
  "",
  "车间",
  "是",
  "否",
  "2026-03-30",
  "2027-03-29",
  "",
  "",
  "男",
  "汉",
  "350212199005200456",
  "福建省厦门市同安区…",
  "同安区…",
  "138 0000 0000",
  "李四",
  "139 0000 0000",
  "",
] as const;

/**
 * 导出列（37 列）：先花名册原始顺序（含 5 个派生列），再系统列。
 * 导出文件可以直接当导入文件用 —— 解析按表头名匹配，派生列与「员工状态」会被忽略。
 */
export const EMPLOYEE_EXPORT_HEADERS = [
  "序号",
  "工号",
  "姓名",
  "部门",
  "职务",
  "状态",
  "出生日期",
  "年龄",
  "学历",
  "血型",
  "入职日期",
  "是否缴纳社保",
  "是否缴纳商业险",
  "合同起止时间-开始时间",
  "合同起止时间-结束时间",
  "劳务合同-开始时间",
  "劳务合同-结束时间",
  "性别",
  "民族",
  "身份证号码",
  "家庭住址",
  "现住地址",
  "联系方式",
  "紧急联络人",
  "紧急联络人联系电话",
  "工龄",
  "当月生日员工",
  "合同即将到期人员",
  "劳务合同即将到期人员",
  "员工类型",
  "部门编码",
  "岗位编码",
  "绑定系统用户名",
  "离职日期",
  "员工备注",
  "创建时间",
  "更新时间",
] as const;

// ---------------------------------------------------------------------------
// 表头识别
// ---------------------------------------------------------------------------

/**
 * 用来「认出这是一张员工表」的最小列集合：姓名 + 部门 + 职务。
 * 手工花名册没有员工类型列，但仍要能被认出来，好给出「缺哪一列」的准确提示，
 * 而不是笼统地报「未找到表头」。
 */
const IDENTIFY_HEADER_FIELDS: readonly EmployeeRosterField[] = ["name", "department", "position"];

/**
 * 解析后必须存在的列：缺列说明上传的不是员工表（或模板不完整），直接拒绝整批并指出缺哪几列。
 * 这里刻意**不**包含「员工类型」：手工花名册没有这一列，服务层会尝试从部门里已有员工的
 * 一致类型推断，推断不出来才逐行报错（见 production-master-data.service.ts）。
 */
const REQUIRED_HEADER_FIELDS: readonly EmployeeRosterField[] = IDENTIFY_HEADER_FIELDS;

const REQUIRED_HEADER_LABELS: Record<string, string> = {
  name: "姓名",
  department: "部门",
  position: "职务/岗位",
};

/** 花名册原表最多允许标题/空行占用的前缀行数（超过就认为不是员工表）。 */
const HEADER_SEARCH_LIMIT = 10;

const cellText = (value: unknown) => String(value ?? "").replace(/\s+/g, "").trim();

/**
 * 把可能的两级表头拍平成一维列名：
 * 花名册用「合同起止时间 / 开始时间」这种合并表头，父列只在合并区的第一格有值。
 * 规则：子表头有值且父表头为空时，沿用左侧最近的非空父表头，拼成「父-子」。
 */
export function flattenHeaderRow(parentRow: unknown[], childRow: unknown[] = []): string[] {
  const hasChild = childRow.length > 0;
  const width = Math.max(parentRow.length, childRow.length);
  const labels: string[] = [];
  let lastParent = "";
  for (let column = 0; column < width; column += 1) {
    const parentCell = cellText(parentRow[column]);
    if (parentCell) lastParent = parentCell;
    const child = cellText(childRow[column]);
    // 单级表头：原样取单元格，空格子就是没有列名（不能沿用左邻居，否则会把相邻列张冠李戴）。
    if (!hasChild) { labels.push(parentCell); continue; }
    // 两级表头：合并区的父列只有第一格有值，后面的子列沿用左侧最近的非空父列。
    if (!child) { labels.push(parentCell); continue; }
    labels.push(parentCell ? `${parentCell}-${child}` : `${lastParent}-${child}`);
  }
  return labels;
}

/** 在表头行里找出每个字段落在那几列（同名字段取最左列）。 */
export function resolveHeaderIndexes(labels: readonly string[]): Map<EmployeeRosterField, number> {
  const indexes = new Map<EmployeeRosterField, number>();
  const normalized = labels.map(cellText);
  for (const field of Object.keys(EMPLOYEE_HEADER_ALIASES) as EmployeeRosterField[]) {
    const aliases = EMPLOYEE_HEADER_ALIASES[field].map(cellText);
    for (const alias of aliases) {
      const column = normalized.indexOf(alias);
      if (column >= 0) { indexes.set(field, column); break; }
    }
  }
  return indexes;
}

export type LocatedHeader = {
  /** 表头所在行在 rows 里的下标；-1 表示没找到。 */
  headerRow: number;
  /** 数据行的起始下标（表头下方，跳过两级表头的子表头行）。 */
  dataStartRow: number;
  labels: string[];
  indexes: Map<EmployeeRosterField, number>;
  /** 缺失的必需列中文名；非空即拒绝整批。 */
  missingRequired: string[];
  /** 表头是否不在首行 —— 说明传的是「文档版」花名册而不是系统模板。 */
  documentLayout: boolean;
};

/**
 * 定位表头行并解析列映射。
 *
 * 两种形态都能认：
 *   - 系统模板：首行就是表头（documentLayout = false），整表逐行扫描，中间的空行直接跳过；
 *   - 手工花名册：首行是公司名/表名，中间有空行，末尾还有说明批注（documentLayout = true），
 *     此时表头向下扫描最多 HEADER_SEARCH_LIMIT 行，一旦发现两级表头就再下移一行取数据，
 *     数据块在遇到第一个空行处结束，避免把末尾的「绿色：…/黄色：…/工龄：…」批注当成数据行。
 */
export function locateHeaderRow(rows: readonly unknown[][]): LocatedHeader {
  // 在前 10 行里挑「最像员工表头」的一行：命中姓名/部门/职务最多的那行。
  // 这样即使缺了其中一列（例如漏了「职务」），也能给出「缺少必需列：职务/岗位」这种精确提示，
  // 而不是笼统一句「未找到表头」。
  let best = { index: -1, score: 0, labels: [] as string[], indexes: new Map<EmployeeRosterField, number>() };
  for (let index = 0; index < Math.min(rows.length, HEADER_SEARCH_LIMIT); index += 1) {
    const labels = flattenHeaderRow(rows[index] ?? []);
    const indexes = resolveHeaderIndexes(labels);
    const score = IDENTIFY_HEADER_FIELDS.filter((field) => indexes.has(field)).length;
    if (score > best.score) best = { index, score, labels, indexes };
    if (score === IDENTIFY_HEADER_FIELDS.length) break;
  }
  if (best.score < IDENTIFY_HEADER_FIELDS.length) {
    // 命中 >= 2 列才认为是「员工表但缺列」；否则判定为根本不是员工表（例如误传了花色生产单），
    // 此时把三列都列出来，提示操作员去下载模板。
    const missing = (best.score >= 2 ? IDENTIFY_HEADER_FIELDS.filter((field) => !best.indexes.has(field)) : IDENTIFY_HEADER_FIELDS)
      .map((field) => REQUIRED_HEADER_LABELS[field]);
    return { headerRow: -1, dataStartRow: -1, labels: best.labels, indexes: new Map(), missingRequired: missing, documentLayout: false };
  }
  const headerRow = best.index;
  const parent = flattenHeaderRow(rows[headerRow] ?? []);
  const childCandidate = rows[headerRow + 1];
  // 子表头行：整行没有任何数据感的值，且至少一个格子读起来像「开始时间/结束时间」这类子标签。
  const childLooksLikeSubHeader = Array.isArray(childCandidate)
    && childCandidate.some((value) => cellText(value).length > 0)
    && childCandidate.every((value) => { const text = cellText(value); return !text || text.length <= 8; })
    && childCandidate.some((value) => /^(开始时间|结束时间|开始|结束|起始时间|终止时间)$/.test(cellText(value)));
  const labels = childLooksLikeSubHeader ? flattenHeaderRow(rows[headerRow] ?? [], childCandidate) : parent;
  const indexes = resolveHeaderIndexes(labels);
  const dataStartRow = headerRow + (childLooksLikeSubHeader ? 2 : 1);
  const missingRequired = REQUIRED_HEADER_FIELDS.filter((field) => !indexes.has(field)).map((field) => REQUIRED_HEADER_LABELS[field]);
  return { headerRow, dataStartRow, labels, indexes, missingRequired, documentLayout: headerRow > 0 || childLooksLikeSubHeader };
}

// ---------------------------------------------------------------------------
// 单元格取值与规范化
// ---------------------------------------------------------------------------

export function textCell(row: readonly unknown[], column: number | undefined): string {
  if (column === undefined) return "";
  return String(row[column] ?? "").trim();
}

/**
 * 日期解析：容忍 Date、常见分隔符、Excel 序列号与「带时间的文本」（只取日期部分），
 * 最后归一化成 @db.Date 用的 UTC 零点。
 *
 * ⚠️ 调用方读工作簿时必须用 `cellDates: false`（默认值）。SheetJS 的 `cellDates: true`
 * 把序列号 42877（= 2017-05-22）转成 `2017-05-21T15:59:35Z` —— 比本地零点早 25 秒，
 * 于是日期整整错一天。保持数字形态则能走下面精确的序列号换算，不依赖时区。
 *
 * `value instanceof Date` 分支只作为兜底（其它调用方可能直接传 Date）：那里用本地字段，
 * 因为这类 Date 通常是「本地零点」构造出来的。
 */
export function parseRosterDate(value: unknown): Date | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return null;
  let year = 0; let month = 0; let day = 0;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    year = value.getFullYear(); month = value.getMonth() + 1; day = value.getDate();
  } else if (typeof value === "number") {
    if (!Number.isFinite(value) || value < EXCEL_SERIAL_MIN || value > EXCEL_SERIAL_MAX) return null;
    const serial = Math.floor(value);
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const date = new Date(epoch.getTime() + serial * MS_PER_DAY);
    year = date.getUTCFullYear(); month = date.getUTCMonth() + 1; day = date.getUTCDate();
  } else {
    // 去掉尾部的日期时间部分（"2026-01-05T00:00:00Z"、"2026/1/5 8:30" …）
    const datePart = String(value).trim().split(/[ T]/)[0];
    const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(datePart)
      ?? /^(\d{4})(\d{2})(\d{2})$/.exec(datePart)
      ?? /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/.exec(datePart);
    if (!match) return null;
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
  }
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // 拒绝 2026-02-31 这类会翻滚的输入，而不是悄悄挪到下个月
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

/** 「是/否」类单元格：空 → undefined，认不出 → null（调用方报错）。 */
export function parseRosterFlag(value: unknown): boolean | undefined | null {
  const text = cellText(value).toLowerCase();
  if (!text) return undefined;
  if (["是", "有", "y", "yes", "true", "1", "√", "已缴", "缴纳"].includes(text)) return true;
  if (["否", "无", "n", "no", "false", "0", "×", "x", "未缴", "不缴"].includes(text)) return false;
  return null;
}

/** 是否类的单元格在导出时写回「是/否/空」。 */
export const formatRosterFlag = (value: boolean | null | undefined) => (value === true ? "是" : value === false ? "否" : "");

/** 性别：统一成花名册口径的「男/女」，空 → undefined，认不出 → null。 */
export function parseRosterGender(value: unknown): "男" | "女" | undefined | null {
  const text = cellText(value).toLowerCase();
  if (!text) return undefined;
  if (["男", "男性", "m", "male"].includes(text)) return "男";
  if (["女", "女性", "f", "female"].includes(text)) return "女";
  return null;
}

/** 在职状态：中文/英文都能认；空 → undefined，认不出 → null。 */
export function parseEmploymentStatus(value: unknown): "active" | "left" | "inactive" | undefined | null {
  const text = cellText(value).toLowerCase();
  if (!text) return undefined;
  if (["在职", "active", "在岗", "正常"].includes(text)) return "active";
  if (["离职", "left", "已离职", "辞职"].includes(text)) return "left";
  if (["停用", "inactive", "已停用", "禁用"].includes(text)) return "inactive";
  return null;
}

/** 员工类型：车间/非车间（兼容历史上手写的「车间员工/非车间员工」）。 */
export const EMPLOYEE_TYPE_LABELS: Record<string, "workshop" | "non_workshop"> = {
  "车间": "workshop",
  "车间员工": "workshop",
  "workshop": "workshop",
  "非车间": "non_workshop",
  "非车间员工": "non_workshop",
  "non_workshop": "non_workshop",
};

export const employeeTypeLabel = (value: string) => (value === "workshop" ? "车间" : value === "non_workshop" ? "非车间" : value);

export const employmentStatusLabel = (value: string) =>
  (value === "active" ? "在职" : value === "left" ? "离职" : value === "inactive" ? "停用" : value);

// ---------------------------------------------------------------------------
// 身份证 → 出生日期 / 性别
// ---------------------------------------------------------------------------

const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CARD_CHECK_CODES = "10X98765432";

export type IdCardIdentity = { birthDate: Date; gender: "男" | "女" };
export type IdCardResult = { ok: true; value: IdCardIdentity } | { ok: false; reason: string };

/**
 * 身份证号 → 出生日期 + 性别（花名册绿色批注要求的「自动跳出」）。
 *
 * 支持 18 位（含校验位校验，能挡住手抄错号）和 15 位老号。
 * 省市县地址解析需要 GB/T 2260 行政区划表，本仓库没有该字典，因此**不派生地址**，
 * 「家庭住址」仍按人工填写的值入库。
 */
export function parseIdCard(value: unknown): IdCardResult {
  const text = String(value ?? "").replace(/\s+/g, "").toUpperCase();
  if (!text) return { ok: false, reason: "为空" };
  if (/^\d{17}[\dX]$/.test(text)) {
    const expected = ID_CARD_CHECK_CODES[ID_CARD_WEIGHTS.reduce((sum, weight, index) => sum + weight * Number(text[index]), 0) % 11];
    if (expected !== text[17]) return { ok: false, reason: "校验位不匹配，请核对号码" };
    const birthDate = parseRosterDate(`${text.slice(6, 10)}-${text.slice(10, 12)}-${text.slice(12, 14)}`);
    if (!birthDate) return { ok: false, reason: "出生日期段无法解析" };
    return { ok: true, value: { birthDate, gender: Number(text[16]) % 2 === 1 ? "男" : "女" } };
  }
  if (/^\d{15}$/.test(text)) {
    const birthDate = parseRosterDate(`19${text.slice(6, 8)}-${text.slice(8, 10)}-${text.slice(10, 12)}`);
    if (!birthDate) return { ok: false, reason: "出生日期段无法解析" };
    return { ok: true, value: { birthDate, gender: Number(text[14]) % 2 === 1 ? "男" : "女" } };
  }
  return { ok: false, reason: "必须为 18 位（或 15 位）身份证号" };
}

// ---------------------------------------------------------------------------
// 派生列（不落库，导出时按当天日期实时计算）
// ---------------------------------------------------------------------------

/** 整年数（满年才算 1 年），日期都是 UTC 零点。 */
export function fullYearsBetween(from: Date, to: Date): number {
  let years = to.getUTCFullYear() - from.getUTCFullYear();
  const monthDelta = to.getUTCMonth() - from.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && to.getUTCDate() < from.getUTCDate())) years -= 1;
  return Math.max(0, years);
}

export const deriveAge = (birthDate: Date | null | undefined, today: Date = new Date()) => (birthDate ? String(fullYearsBetween(birthDate, today)) : "");
export const deriveTenure = (hiredOn: Date | null | undefined, today: Date = new Date()) => (hiredOn ? String(fullYearsBetween(hiredOn, today)) : "");
/** 当月生日员工：生日所在自然月命中当前月 → "1"，否则 "0"（与花名册的公式列一致）。 */
export const deriveBirthdayThisMonth = (birthDate: Date | null | undefined, today: Date = new Date()) =>
  (birthDate ? (birthDate.getUTCMonth() === today.getUTCMonth() ? "1" : "0") : "");

export type ContractExpiryStatus = "" | "正常" | "合同即将到期" | "合同已过期";

/**
 * 合同到期提醒（花名册黄色批注）：到期前一个月提示「合同即将到期」，已过期提示「合同已过期」，
 * 其余「正常」，没填结束时间则留空。
 */
export function deriveContractExpiry(end: Date | null | undefined, today: Date = new Date()): ContractExpiryStatus {
  if (!end) return "";
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const todayDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (endDay < todayDay) return "合同已过期";
  if (endDay - todayDay <= CONTRACT_EXPIRY_WINDOW_DAYS * MS_PER_DAY) return "合同即将到期";
  return "正常";
}

/** 导出用的日期文本（UTC 零点 → YYYY-MM-DD）。 */
export const formatRosterDate = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : "");

// ---------------------------------------------------------------------------
// 逐行解析（纯函数：不碰数据库，部门/职务只回传原始文本，由服务层解析成 ID）
// ---------------------------------------------------------------------------

/** 单行解析结果：已通过全部「与数据库无关」的校验。 */
export type EmployeeImportRow = {
  /** Excel 里的物理行号（1 基），用于把错误指回原文件。 */
  line: number;
  /** 留空表示让系统自动生成（EMP-当天日期-序号）。 */
  employeeNo: string;
  name: string;
  departmentText: string;
  positionText: string;
  /** 留空表示没填：服务层会尝试按部门里已有员工的一致类型推断，推断不出来才报错。 */
  employeeType?: "workshop" | "non_workshop";
  employmentStatus?: "active" | "left" | "inactive";
  birthDate?: Date;
  gender?: "男" | "女";
  ethnicity?: string;
  idCardNo?: string;
  education?: string;
  bloodType?: string;
  socialInsurance?: boolean;
  commercialInsurance?: boolean;
  contractStart?: Date;
  contractEnd?: Date;
  laborContractStart?: Date;
  laborContractEnd?: Date;
  homeAddress?: string;
  currentAddress?: string;
  phone?: string;
  emergencyContact?: string;
  emergencyPhone?: string;
  hiredOn?: Date;
  leftOn?: Date;
  remark?: string;
};

export type EmployeeImportError = { row: number; field?: string; reason: string };

export type EmployeeRosterParseResult = {
  /** 表头所在行（1 基）；-1 表示没找到。 */
  headerRow: number;
  documentLayout: boolean;
  missingRequired: string[];
  /** 表里实际存在的字段（列可以缺，例如手工花名册没有「员工类型」列）。 */
  presentFields: EmployeeRosterField[];
  /**
   * true = 整批不可导入（找不到表头 / 缺必需列 / 没有数据行）。
   * 只有行级错误时是 false —— 通过校验的行照样要导进去，出错的行单独列出。
   */
  blocked: boolean;
  /** 表头里有、但不属于花名册口径的列（已忽略，仅提示操作员）。 */
  ignoredColumns: string[];
  /** 文档版花名册末尾被批注块挡掉的行数（0 表示没有丢弃任何行）。 */
  ignoredTrailingRows: number;
  /** 实际参与校验的数据行数。 */
  dataRowCount: number;
  errors: EmployeeImportError[];
  rows: EmployeeImportRow[];
};

export const EMPLOYEE_FIELD_LABELS: Record<EmployeeRosterField, string> = {
  employee_no: "工号",
  name: "姓名",
  department: "部门",
  position: "职务",
  status: "状态",
  employee_type: "员工类型",
  birth_date: "出生日期",
  education: "学历",
  blood_type: "血型",
  hired_on: "入职日期",
  left_on: "离职日期",
  social_insurance: "是否缴纳社保",
  commercial_insurance: "是否缴纳商业险",
  contract_start: "合同开始时间",
  contract_end: "合同结束时间",
  labor_contract_start: "劳务合同开始时间",
  labor_contract_end: "劳务合同结束时间",
  gender: "性别",
  ethnicity: "民族",
  id_card_no: "身份证号码",
  home_address: "家庭住址",
  current_address: "现住地址",
  phone: "联系方式",
  emergency_contact: "紧急联络人",
  emergency_phone: "紧急联络人联系电话",
  remark: "备注",
};

/** 各文本字段的长度上限（与 employees 表的列宽、控制器 DTO 的 @MaxLength 保持一致）。 */
export const EMPLOYEE_FIELD_MAX_LENGTH: Partial<Record<EmployeeRosterField, number>> = {
  employee_no: 80,
  name: 100,
  education: 50,
  blood_type: 10,
  ethnicity: 50,
  id_card_no: 30,
  home_address: 500,
  current_address: 500,
  phone: 50,
  emergency_contact: 100,
  emergency_phone: 50,
  remark: 500,
};

/** 按原样读文本的字段（其余字段要么是日期、要么是是否/枚举，需要单独解析）。 */
const TEXT_FIELDS: readonly EmployeeRosterField[] = [
  "employee_no", "name", "department", "position", "status", "employee_type",
  "education", "blood_type", "gender", "ethnicity", "id_card_no",
  "home_address", "current_address", "phone", "emergency_contact", "emergency_phone", "remark",
];

const RECOGNIZED_HEADERS = new Set<string>(
  Object.values(EMPLOYEE_HEADER_ALIASES).flatMap((aliases) => aliases.map(cellText)),
);

const isBlankRow = (row: readonly unknown[]) => !row.some((cell) => String(cell ?? "").trim());

/**
 * 按花名册口径逐行解析 + 校验。
 *
 * 只做「看一行就能判断」的校验（必填、格式、长度、日期区间、身份证自洽）；部门/职务是否存在、
 * 工号是否已被占用这类需要查库的判断留给服务层。因此本函数是完全可单测的纯函数。
 */
export function parseEmployeeRosterRows(rows: readonly unknown[][]): EmployeeRosterParseResult {
  const header = locateHeaderRow(rows);
  const result: EmployeeRosterParseResult = {
    headerRow: header.headerRow < 0 ? -1 : header.headerRow + 1,
    documentLayout: header.documentLayout,
    missingRequired: header.missingRequired,
    presentFields: [...header.indexes.keys()],
    blocked: header.headerRow < 0 || header.missingRequired.length > 0,
    ignoredColumns: header.headerRow < 0 ? [] : [...new Set(header.labels.map(cellText).filter((label) => label && !RECOGNIZED_HEADERS.has(label) && !(EMPLOYEE_IGNORED_HEADERS as readonly string[]).includes(label)))],
    ignoredTrailingRows: 0,
    dataRowCount: 0,
    errors: [],
    rows: [],
  };
  if (header.headerRow < 0) {
    // 缺 1~2 列 = 是员工表但不完整，直接点名缺哪几列；三列全缺 = 根本不是员工表。
    result.errors.push(header.missingRequired.length < IDENTIFY_HEADER_FIELDS.length
      ? { row: 1, reason: `缺少必需列：${header.missingRequired.join("、")}` }
      : { row: 1, reason: `未找到员工表头：首行需要包含「姓名、部门/部门编码、职务/岗位/岗位编码」，或直接下载系统模板（列：${EMPLOYEE_IMPORT_HEADERS.join("、")}）` });
    return result;
  }
  if (header.missingRequired.length) {
    result.errors.push({ row: result.headerRow, reason: `缺少必需列：${header.missingRequired.join("、")}` });
    return result;
  }

  const indexed = rows.slice(header.dataStartRow).map((row, index) => ({ line: header.dataStartRow + index + 1, row }));
  let data = indexed;
  if (header.documentLayout) {
    // 手工花名册末尾通常是「绿色：…/黄色：…/工龄：…」说明批注，靠第一个空行把数据块切出来。
    const firstBlank = indexed.findIndex((item) => isBlankRow(item.row));
    if (firstBlank >= 0) {
      result.ignoredTrailingRows = indexed.slice(firstBlank).filter((item) => !isBlankRow(item.row)).length;
      data = indexed.slice(0, firstBlank);
    }
  }
  data = data.filter((item) => !isBlankRow(item.row));
  result.dataRowCount = data.length;
  if (!data.length) {
    result.blocked = true;
    result.errors.push({ row: 0, reason: "未检测到数据行" });
  }

  const indexes = header.indexes;
  const raw = (row: readonly unknown[], field: EmployeeRosterField) => { const column = indexes.get(field); return column === undefined ? undefined : row[column]; };
  const text = (row: readonly unknown[], field: EmployeeRosterField) => textCell(row, indexes.get(field));
  const seenNos = new Set<string>();

  for (const { line, row } of data) {
    const errors: EmployeeImportError[] = [];
    const fail = (field: EmployeeRosterField | "列数", reason: string) => errors.push({ row: line, field: field === "列数" ? undefined : EMPLOYEE_FIELD_LABELS[field], reason });

    // —— 文本字段：先原样读出来（带长度校验），后面的必填/枚举/日期判断都基于它 ——
    const texts: Partial<Record<EmployeeRosterField, string>> = {};
    for (const field of TEXT_FIELDS) {
      const value = text(row, field);
      texts[field] = value;
      const limit = EMPLOYEE_FIELD_MAX_LENGTH[field];
      if (limit && value.length > limit) fail(field, `长度不能超过${limit}个字符`);
    }

    // —— 姓名：花名册的数据行必须有姓名 ——
    const name = texts.name ?? "";
    if (!name) fail("name", "不能为空");

    // —— 工号：留空自动生成；填了就查重（库内查重留给服务层）——
    const employeeNo = texts.employee_no ?? "";
    if (employeeNo) {
      if (seenNos.has(employeeNo)) fail("employee_no", "文件内工号重复");
      else seenNos.add(employeeNo);
    }

    // —— 部门 / 职务：只校验非空，存在性由服务层查库 ——
    const departmentText = texts.department ?? "";
    const positionText = texts.position ?? "";
    if (!departmentText) fail("department", "不能为空");
    if (!positionText) fail("position", "不能为空");

    // —— 员工类型（系统列，车间/非车间）：留空留给服务层按部门推断，填错则直接报错 ——
    const employeeTypeText = texts.employee_type ?? "";
    const employeeType = EMPLOYEE_TYPE_LABELS[employeeTypeText];
    if (employeeTypeText && !employeeType) fail("employee_type", "仅允许车间/车间员工/非车间/非车间员工");

    // —— 状态（花名册列；留空则按离职日期推断）——
    const statusRaw = texts.status ?? "";
    const employmentStatus = parseEmploymentStatus(statusRaw);
    if (statusRaw && employmentStatus === null) fail("status", "仅允许在职/离职/停用（或 active/left/inactive）");

    // —— 布尔列 ——
    const flag = (field: EmployeeRosterField) => {
      const value = parseRosterFlag(raw(row, field));
      if (value === null) fail(field, "仅允许是/否（或 1/0、Y/N）");
      return value ?? undefined;
    };
    const socialInsurance = flag("social_insurance");
    const commercialInsurance = flag("commercial_insurance");

    // —— 日期列 ——
    const date = (field: EmployeeRosterField) => {
      const value = raw(row, field);
      if (value === undefined || value === null || !String(value).trim()) return undefined;
      const parsed = parseRosterDate(value);
      if (!parsed) fail(field, "日期格式必须为 YYYY-MM-DD");
      return parsed;
    };
    const hiredOn = date("hired_on");
    const leftOn = date("left_on");
    let birthDate = date("birth_date");
    const contractStart = date("contract_start");
    const contractEnd = date("contract_end");
    const laborContractStart = date("labor_contract_start");
    const laborContractEnd = date("labor_contract_end");

    if (hiredOn && leftOn && leftOn < hiredOn) fail("left_on", "不能早于入职日期");
    if (contractStart && contractEnd && contractEnd < contractStart) fail("contract_end", "不能早于合同开始时间");
    if (laborContractStart && laborContractEnd && laborContractEnd < laborContractStart) fail("labor_contract_end", "不能早于劳务合同开始时间");
    if (employmentStatus === "active" && leftOn) fail("left_on", "状态为在职时不能填离职日期");

    // —— 身份证号：校验 + 自动补齐出生日期/性别（花名册绿色批注的要求）——
    const idCardText = texts.id_card_no ?? "";
    let gender = parseRosterGender(texts.gender);
    if (texts.gender && gender === null) fail("gender", "仅允许男/女");
    let idCardNo: string | undefined;
    if (idCardText) {
      const parsed = parseIdCard(idCardText);
      if (!parsed.ok) fail("id_card_no", parsed.reason);
      else {
        idCardNo = idCardText.toUpperCase();
        if (birthDate && birthDate.getTime() !== parsed.value.birthDate.getTime()) fail("birth_date", "与身份证号推算的出生日期不一致");
        else if (!birthDate) birthDate = parsed.value.birthDate;
        if (gender && gender !== parsed.value.gender) fail("gender", "与身份证号推算的性别不一致");
        else if (!gender) gender = parsed.value.gender;
      }
    }
    if (birthDate && birthDate.getTime() > Date.now()) fail("birth_date", "不能晚于今天");

    if (errors.length) { result.errors.push(...errors); continue; }
    result.rows.push({
      line,
      employeeNo,
      name,
      departmentText,
      positionText,
      employeeType: employeeType ?? undefined,
      employmentStatus: employmentStatus ?? undefined,
      birthDate: birthDate ?? undefined,
      gender: gender ?? undefined,
      ethnicity: texts.ethnicity || undefined,
      idCardNo,
      education: texts.education || undefined,
      bloodType: texts.blood_type || undefined,
      socialInsurance,
      commercialInsurance,
      contractStart: contractStart ?? undefined,
      contractEnd: contractEnd ?? undefined,
      laborContractStart: laborContractStart ?? undefined,
      laborContractEnd: laborContractEnd ?? undefined,
      homeAddress: texts.home_address || undefined,
      currentAddress: texts.current_address || undefined,
      phone: texts.phone || undefined,
      emergencyContact: texts.emergency_contact || undefined,
      emergencyPhone: texts.emergency_phone || undefined,
      hiredOn: hiredOn ?? undefined,
      leftOn: leftOn ?? undefined,
      remark: texts.remark || undefined,
    });
  }
  return result;
}

/** 导出 / 列表读模型里的派生列（年龄、工龄、当月生日、合同到期提醒）。 */
export function rosterDerived(
  row: { birthDate?: Date | null; hiredOn?: Date | null; contractEnd?: Date | null; laborContractEnd?: Date | null },
  today: Date = new Date(),
) {
  return {
    age: row.birthDate ? Number(deriveAge(row.birthDate, today)) : null,
    tenureYears: row.hiredOn ? Number(deriveTenure(row.hiredOn, today)) : null,
    birthdayThisMonth: row.birthDate ? deriveBirthdayThisMonth(row.birthDate, today) === "1" : null,
    contractStatus: deriveContractExpiry(row.contractEnd, today),
    laborContractStatus: deriveContractExpiry(row.laborContractEnd, today),
  };
}

/**
 * 导出一行：按 EMPLOYEE_EXPORT_HEADERS 的顺序拼值。
 * 花名册的派生列在这里实时算，不落库。
 */
export function employeeExportRow(
  row: {
    employeeNo: string; name: string; employeeType: string; employmentStatus: string;
    // department/position 在库上是 NOT NULL 外键，listEmployees 也会 include；
    // 这里仍容忍缺失，避免一条脏数据让整批导出 500。
    department?: { code: string; name: string } | null;
    position?: { code: string; name: string } | null;
    birthDate?: Date | null; gender?: string | null; ethnicity?: string | null; idCardNo?: string | null;
    education?: string | null; bloodType?: string | null;
    hiredOn?: Date | null; leftOn?: Date | null;
    socialInsurance?: boolean | null; commercialInsurance?: boolean | null;
    contractStart?: Date | null; contractEnd?: Date | null; laborContractStart?: Date | null; laborContractEnd?: Date | null;
    homeAddress?: string | null; currentAddress?: string | null; phone?: string | null;
    emergencyContact?: string | null; emergencyPhone?: string | null; remark?: string | null;
    userId?: string | null; createdAt: Date; updatedAt: Date;
  },
  index: number,
  username: string,
  today: Date = new Date(),
) {
  const derived = rosterDerived(row, today);
  return {
    "序号": index + 1,
    "工号": row.employeeNo,
    "姓名": row.name,
    "部门": row.department?.name ?? "",
    "职务": row.position?.name ?? "",
    "状态": employmentStatusLabel(row.employmentStatus),
    "出生日期": formatRosterDate(row.birthDate),
    "年龄": derived.age ?? "",
    "学历": row.education ?? "",
    "血型": row.bloodType ?? "",
    "入职日期": formatRosterDate(row.hiredOn),
    "是否缴纳社保": formatRosterFlag(row.socialInsurance),
    "是否缴纳商业险": formatRosterFlag(row.commercialInsurance),
    "合同起止时间-开始时间": formatRosterDate(row.contractStart),
    "合同起止时间-结束时间": formatRosterDate(row.contractEnd),
    "劳务合同-开始时间": formatRosterDate(row.laborContractStart),
    "劳务合同-结束时间": formatRosterDate(row.laborContractEnd),
    "性别": row.gender ?? "",
    "民族": row.ethnicity ?? "",
    "身份证号码": row.idCardNo ?? "",
    "家庭住址": row.homeAddress ?? "",
    "现住地址": row.currentAddress ?? "",
    "联系方式": row.phone ?? "",
    "紧急联络人": row.emergencyContact ?? "",
    "紧急联络人联系电话": row.emergencyPhone ?? "",
    "工龄": derived.tenureYears ?? "",
    "当月生日员工": row.birthDate ? (derived.birthdayThisMonth ? "1" : "0") : "",
    "合同即将到期人员": derived.contractStatus,
    "劳务合同即将到期人员": derived.laborContractStatus,
    "员工类型": employeeTypeLabel(row.employeeType),
    "部门编码": row.department?.code ?? "",
    "岗位编码": row.position?.code ?? "",
    "绑定系统用户名": row.userId ? username : "",
    "离职日期": formatRosterDate(row.leftOn),
    "员工备注": row.remark ?? "",
    "创建时间": row.createdAt.toISOString().replace("T", " ").slice(0, 19),
    "更新时间": row.updatedAt.toISOString().replace("T", " ").slice(0, 19),
  };
}

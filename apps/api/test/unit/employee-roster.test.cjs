// 员工花名册口径（人事导入模板）的单元测试。
//
// 被测源文件：
//   apps/api/src/modules/production/employee-roster.ts            （纯解析 / 派生 / 导出映射）
//   apps/api/src/modules/production/production-master-data.service.ts（导入编排、自动工号、表单字段）
//
// 为什么单独立一个文件：旧测试只覆盖「旧 8 列模板导入」，而新口径的三条关键性质全在纯函数里：
//   1. 按**表头名**（而不是列序号）匹配，列顺序可换、多余列可忽略、旧模板仍可导入；
//   2. 手工花名册（标题在首行、合同起止是两行合并表头、末尾有说明批注）能直接导入；
//   3. 身份证反推出生日期/性别、Excel 序列日期精确换算、花名册派生列实时计算。
// 这些都不需要数据库，因此全部用真实 Excel 字节 + 内存替身打穿，不 mock 解析过程本身。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const XLSX = require("xlsx");
const { UnprocessableEntityException } = require("@nestjs/common");
const roster = require("../../dist/modules/production/employee-roster.js");
const regions = require("../../dist/modules/production/china-region.js");
const { ProductionMasterDataService } = require("../../dist/modules/production/production-master-data.service.js");

const user = { id: "1f7d261d-0089-4d32-9aa1-19942c41cb1d", username: "hr" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => undefined };
const today = new Date(Date.UTC(2026, 8, 16)); // 2026-09-16

/** 用二维数组造一个真实 xlsx 缓冲区（走完整 Excel 读路径，包括日期是序列号这一点）。 */
function workbook(rows, sheetName = "员工导入") {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

/** 内存 prisma 替身：只实现员工导入/表单路径真正会碰到的查询。 */
function fakePrisma(options = {}) {
  const departments = options.departments ?? [{ id: "dept-1", code: "D001", name: "生产部" }];
  const positions = options.positions ?? [{ id: "pos-1", code: "P001", name: "合片工", departmentId: "dept-1" }];
  const employees = [...(options.employees ?? [])];
  const created = [];
  const prisma = {
    department: { findMany: async () => departments },
    position: {
      findMany: async () => positions,
      // requireOrganization 会顺着 position → department.isActive 判断部门是否启用
      findFirst: async ({ where }) => {
        const found = positions.find((item) => item.id === where.id);
        return found ? { ...found, department: { id: found.departmentId, isActive: true } } : null;
      },
    },
    employee: {
      findMany: async ({ where, include }) => {
        if (where?.employeeNo?.in) return employees.filter((item) => where.employeeNo.in.includes(item.employeeNo)).map((item) => ({ employeeNo: item.employeeNo }));
        if (where?.employeeNo?.startsWith) return employees.filter((item) => item.employeeNo.startsWith(where.employeeNo.startsWith)).map((item) => ({ employeeNo: item.employeeNo }));
        // listEmployees / exportEmployees 走 include: { department, position }，要带上关联与审计时间
        if (include?.department) {
          return employees.map((item) => ({
            ...item,
            createdAt: new Date(Date.UTC(2026, 8, 16, 1, 2, 3)),
            updatedAt: new Date(Date.UTC(2026, 8, 16, 1, 2, 3)),
            department: departments.find((row) => row.id === item.departmentId) ?? null,
            position: positions.find((row) => row.id === item.positionId) ?? null,
          }));
        }
        // 部门 → 已有员工类型（用于「员工类型」留空时的推断）
        return employees.map((item) => ({ departmentId: item.departmentId, employeeType: item.employeeType }));
      },
      create: async ({ data }) => {
        if (options.onCreate) await options.onCreate(data);
        // 按工号去重：真实数据库里整批事务失败会整体回滚，这里用去重模拟「没有真的写两次」。
        if (!created.some((item) => item.employeeNo === data.employeeNo)) created.push(data);
        if (!employees.some((item) => item.employeeNo === data.employeeNo)) employees.push(data);
        return { id: `emp-${created.length}`, ...data };
      },
      findFirst: async ({ where }) => employees.find((item) => item.id === where.id) ?? null,
      update: async ({ data }) => data,
    },
    $transaction: async (operations) => Promise.all(operations),
  };
  return { prisma, created, employees };
}

// ---------------------------------------------------------------------------
// 1. 表头识别：系统模板 / 手工花名册文档版 / 非员工表
// ---------------------------------------------------------------------------

test("花名册：系统模板按表头名匹配，列顺序打乱、混入无关列都不影响取值", () => {
  const rows = [
    ["员工类型", "联系方式", "姓名", "备注", "职务", "部门", "身份证号码", "工号"],
    ["车间", "13800000000", "张三", "", "合片工", "生产部", "350430198405204527", "E001"],
  ];
  const result = roster.parseEmployeeRosterRows(rows);
  assert.equal(result.headerRow, 1);
  assert.equal(result.documentLayout, false);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].name, "张三");
  assert.equal(result.rows[0].departmentText, "生产部");
  assert.equal(result.rows[0].positionText, "合片工");
  assert.equal(result.rows[0].employeeNo, "E001");
  assert.equal(result.rows[0].employeeType, "workshop");
  // 身份证反推
  assert.equal(result.rows[0].birthDate.toISOString().slice(0, 10), "1984-05-20");
});

test("花名册：手工维护的原表（标题行 + 两级合并表头 + 末尾说明批注）能直接解析", () => {
  const rows = [
    ["厦门迪礼伞业有限公司"],
    ["在职员工花名册"],
    ["序号", "姓名", "部门", "职务", "状态", "出生日期", "年龄", "学历", "血型", "入职日期", "是否缴纳社保", "是否缴纳商业险", "合同起止时间", "", "劳务合同", "", "性别", "民族", "身份证号码", "家庭住址", "现住地址", "联系方式", "紧急联络人", "紧急联络人联系电话", "工龄", "当月生日员工", "合同即将到期人员", "劳务合同即将到期人员"],
    ["", "", "", "", "", "", "", "", "", "", "", "", "开始时间", "结束时间", "开始时间", "结束时间", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["1", "刘春娇", "办公室", "总经理", "在职", "1984-05-20", 42, "本科", "", 42877, "是", "", 43972, 45067, "", "", "女", "汉", "350430198405204527", "福建省建宁县…", "", "159 8078 5005", "", "", 9, 0, "已过期", ""],
    [],
    ["", "", "绿色：当输入身份证号时，能自动跳出相应信息（出生日期、年龄、性别）"],
    ["", "", "工龄：根据入职日期，及每日的日期变化，自动计算员工工龄"],
  ];
  const result = roster.parseEmployeeRosterRows(rows);
  assert.equal(result.headerRow, 3, "表头在第 3 行（1 基）");
  assert.equal(result.documentLayout, true);
  assert.deepEqual(result.missingRequired, []);
  assert.equal(result.dataRowCount, 1, "末尾的两行批注不能算成数据行");
  assert.equal(result.ignoredTrailingRows, 2);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  const row = result.rows[0];
  assert.equal(row.name, "刘春娇");
  assert.equal(row.departmentText, "办公室");
  assert.equal(row.positionText, "总经理");
  assert.equal(row.employmentStatus, "active");
  assert.equal(row.education, "本科");
  assert.equal(row.socialInsurance, true);
  assert.equal(row.gender, "女");
  assert.equal(row.phone, "159 8078 5005");
  // 「合同起止时间 / 开始时间」这种两级表头必须拼成合同字段，而不是丢掉
  assert.equal(row.hiredOn.toISOString().slice(0, 10), "2017-05-22");
  assert.equal(row.contractStart.toISOString().slice(0, 10), "2020-05-21");
  assert.equal(row.contractEnd.toISOString().slice(0, 10), "2023-05-21");
  // 「序号/年龄/工龄/当月生日/合同到期」是派生列，导入时不参与
  assert.equal("age" in row, false);
  assert.equal(row.employeeType, undefined, "手工花名册没有员工类型列，留给服务层推断");
});

test("花名册：不是员工表的文件（例如花色生产单）只回一条整体错误，一行都不解析", () => {
  const rows = [
    ["厦门迪礼伞业进出口有限公司"],
    ["工厂", "", "客户单号 DL260001-1"],
    ["材料", "明细"],
    ["伞骨", "21.5\"X8K三折自动伞"],
  ];
  const result = roster.parseEmployeeRosterRows(rows);
  assert.equal(result.headerRow, -1);
  assert.equal(result.rows.length, 0);
  assert.equal(result.dataRowCount, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].reason, /未找到员工表头/);
  assert.deepEqual(result.missingRequired, ["姓名", "部门", "职务/岗位"]);
});

test("花名册：旧版 8 列模板仍然可以导入（列名别名向后兼容）", () => {
  const rows = [
    ["工号", "姓名", "部门编码", "岗位编码", "员工类型", "入职日期", "离职日期", "备注"],
    ["E-100", "李四", "D001", "P001", "非车间员工", "2020-01-01", "", "老模板"],
  ];
  const result = roster.parseEmployeeRosterRows(rows);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].departmentText, "D001");
  assert.equal(result.rows[0].positionText, "P001");
  assert.equal(result.rows[0].employeeType, "non_workshop");
  assert.equal(result.rows[0].hiredOn.toISOString().slice(0, 10), "2020-01-01");
  assert.equal(result.rows[0].remark, "老模板");
});

test("花名册：表头之外的多余列被忽略并如实上报，不影响导入", () => {
  const rows = [
    ["姓名", "部门", "职务", "员工类型", "配偶姓名"],
    ["张三", "生产部", "合片工", "车间", "不该被读到"],
  ];
  const result = roster.parseEmployeeRosterRows(rows);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.deepEqual(result.ignoredColumns, ["配偶姓名"]);
});

// ---------------------------------------------------------------------------
// 2. 行内校验：身份证、日期、是否、区间
// ---------------------------------------------------------------------------

test("花名册：身份证号能反推出生日期与性别，且校验位不匹配时拒绝", () => {
  const good = roster.parseIdCard("350430198405204527");
  assert.equal(good.ok, true);
  assert.equal(good.value.birthDate.toISOString().slice(0, 10), "1984-05-20");
  assert.equal(good.value.gender, "女");
  // 17 位 = 女（偶数），校验位故意改错
  const bad = roster.parseIdCard("350430198405204521");
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /校验位/);
  // 15 位老号也能认
  const legacy = roster.parseIdCard("350430840520452");
  assert.equal(legacy.ok, true);
  assert.equal(legacy.value.birthDate.toISOString().slice(0, 10), "1984-05-20");
  assert.equal(legacy.value.gender, "女");
  assert.equal(roster.parseIdCard("12345").ok, false);
});

test("花名册：身份证前 6 位解析出省市县，已撤销的老代码按当时的名称", () => {
  // 花名册里的真实号码
  const xiamen = roster.parseIdCard("350430198405204527");
  assert.equal(xiamen.ok, true);
  assert.deepEqual(xiamen.value.region, { province: "福建省", city: "三明市", county: "建宁县", label: "福建省三明市建宁县" });
  // 老代码：413028 原信阳地区罗山县（现 411521）、522228 原铜仁地区沿河县（现 520627）
  const henan = roster.parseIdCard("413028196510110959");
  assert.equal(henan.value.region.label, "河南省信阳地区罗山县");
  const guizhou = roster.parseIdCard("522228197804083626");
  assert.equal(guizhou.value.region.label, "贵州省铜仁地区沿河土家族自治县");
  // 河南/贵州这两个老前缀如果只查现行区划表，就只能给出省级
  assert.equal(regions.lookupRegion("413028").county, "罗山县");
  assert.equal(regions.lookupRegion("522228").county, "沿河土家族自治县");
});

test("行政区划取名：伪市级要跳过，逐级降级，查不到就是空串", () => {
  // 直辖市的「市辖区」、重庆的「县」、海南/新疆的「省（自治区）直辖县级行政区划」都是伪市级
  assert.equal(regions.lookupRegion("110101").label, "北京市东城区");
  assert.equal(regions.lookupRegion("500229").label, "重庆市城口县");
  assert.equal(regions.lookupRegion("469001").label, "海南省五指山市");
  assert.equal(regions.lookupRegion("659001").label, "新疆维吾尔自治区石河子市");
  // 东莞 / 中山不设区
  assert.equal(regions.lookupRegion("441900").label, "广东省东莞市");
  assert.equal(regions.lookupRegion("442000").label, "广东省中山市");
  // 逐级降级
  assert.equal(regions.lookupRegion("3504").label, "福建省三明市");
  assert.equal(regions.lookupRegion("35").label, "福建省");
  assert.equal(regions.lookupRegion("999999").label, "");
  assert.equal(regions.lookupRegion(null).label, "");
});

test("地区代码查不到不影响出生日期与性别，也不判定身份证非法", () => {
  // 999999198405204525：校验位自洽，但 999999 不是任何区划代码
  const result = roster.parseIdCard("999999198405204525");
  assert.equal(result.ok, true, "前 6 位只用于取名，不能因此判身份证无效");
  assert.equal(result.value.birthDate.toISOString().slice(0, 10), "1984-05-20");
  assert.deepEqual(result.value.region, { province: "", city: "", county: "", label: "" });
});

test("区域表：API 与 Web 两份副本必须逐字节相同（改数据请重跑生成脚本）", () => {
  const apiCopy = readFileSync(join(__dirname, "..", "..", "src", "modules", "production", "china-region.ts"), "utf8");
  const webCopy = readFileSync(join(__dirname, "..", "..", "..", "web", "lib", "china-region.ts"), "utf8");
  assert.equal(apiCopy, webCopy, "apps/api 与 apps/web 的区域表必须完全一致，否则「导入解析」和「页面解析」会给出不同结果");
  assert.ok(apiCopy.includes("scripts/generate-china-regions.mjs"), "生成物必须标明来源脚本");
  assert.ok(regions.CHINA_REGION_COUNT > 6000, `区域表条数过少（${regions.CHINA_REGION_COUNT}），可能被换成了小样本`);
});

test("花名册：手填的出生日期/性别必须和身份证自洽", () => {
  const rows = [
    ["姓名", "部门", "职务", "员工类型", "身份证号码", "出生日期"],
    ["张三", "生产部", "合片工", "车间", "350430198405204527", "1984-05-21"],
  ];
  const result = roster.parseEmployeeRosterRows(rows);
  assert.equal(result.rows.length, 0);
  assert.ok(result.errors.some((error) => error.field === "出生日期" && /不一致/.test(error.reason)), JSON.stringify(result.errors));
});

test("花名册：Excel 序列日期精确换算，不因时区错一天；异常日期被拒绝", () => {
  // 42877 是 2017-05-22。旧实现用 cellDates 读会得到 2017-05-21T15:59:35Z → 错一天。
  assert.equal(roster.parseRosterDate(42877).toISOString().slice(0, 10), "2017-05-22");
  assert.equal(roster.parseRosterDate("2026/1/5").toISOString().slice(0, 10), "2026-01-05");
  assert.equal(roster.parseRosterDate("20260105").toISOString().slice(0, 10), "2026-01-05");
  assert.equal(roster.parseRosterDate("2026-01-05T08:30:00Z").toISOString().slice(0, 10), "2026-01-05");
  assert.equal(roster.parseRosterDate(""), null);
  assert.equal(roster.parseRosterDate("2026-02-31"), null, "翻滚日期要被拒绝，而不是顺延到 3 月");
  assert.equal(roster.parseRosterDate(2026), null, "裸年份（序列号窗口之外）不能当成 1905 年的日期");
  const rows = [
    ["姓名", "部门", "职务", "员工类型", "入职日期"],
    ["张三", "生产部", "合片工", "车间", "2026-02-31"],
  ];
  const result = roster.parseEmployeeRosterRows(rows);
  assert.ok(result.errors.some((error) => error.field === "入职日期"), JSON.stringify(result.errors));
});

test("花名册：是否类字段认 是/否/1/0/Y/N，认不出来就报错", () => {
  assert.equal(roster.parseRosterFlag("是"), true);
  assert.equal(roster.parseRosterFlag("否"), false);
  assert.equal(roster.parseRosterFlag("Y"), true);
  assert.equal(roster.parseRosterFlag("0"), false);
  assert.equal(roster.parseRosterFlag(""), undefined);
  assert.equal(roster.parseRosterFlag("大概吧"), null);
  const rows = [
    ["姓名", "部门", "职务", "员工类型", "是否缴纳社保"],
    ["张三", "生产部", "合片工", "车间", "大概吧"],
  ];
  const result = roster.parseEmployeeRosterRows(rows);
  assert.ok(result.errors.some((error) => error.field === "是否缴纳社保"), JSON.stringify(result.errors));
});

test("花名册：合同区间倒挂、离职早于入职、在职却填离职日期都要拦住", () => {
  const base = ["姓名", "部门", "职务", "员工类型"];
  const cases = [
    [[...base, "合同开始时间", "合同结束时间"], ["张三", "生产部", "合片工", "车间", "2027-01-01", "2026-01-01"], "合同结束时间"],
    [[...base, "劳务合同开始时间", "劳务合同结束时间"], ["张三", "生产部", "合片工", "车间", "2027-01-01", "2026-01-01"], "劳务合同结束时间"],
    [[...base, "入职日期", "离职日期"], ["张三", "生产部", "合片工", "车间", "2026-06-01", "2026-01-01"], "离职日期"],
    [[...base, "状态", "离职日期"], ["张三", "生产部", "合片工", "车间", "在职", "2026-01-01"], "离职日期"],
  ];
  for (const [header, row] of cases) {
    const result = roster.parseEmployeeRosterRows([header, row]);
    assert.equal(result.rows.length, 0, `${header.join(",")} 不该产生可导入行`);
    assert.ok(result.errors.length > 0, `${header.join(",")} 必须报错`);
  }
});

test("导入：家庭住址留空时用身份证解析出的省市县补前缀，文件里写了地址就一个字都不改", () => {
  const rows = [
    ["姓名", "部门", "职务", "员工类型", "身份证号码", "家庭住址"],
    // 没有家庭住址 → 补省市县前缀（镇/村/门牌留给人工补录）
    ["张三", "生产部", "合片工", "车间", "350430198405204527", ""],
    // 老区划代码同样补（按当时的名称）
    ["李四", "生产部", "合片工", "车间", "413028196510110959", ""],
    // 文件里写了地址 → 原样保留，绝不用解析结果改写操作员填的内容
    ["王五", "生产部", "合片工", "车间", "350430198405204527", "同安区新民镇柑岭村"],
    // 没填身份证 → 没有前缀可补，地址就还是空
    ["赵六", "生产部", "合片工", "车间", "", ""],
  ];
  const result = roster.parseEmployeeRosterRows(rows);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.rows.length, 4);
  assert.deepEqual(result.rows.map((row) => row.homeAddress), [
    "福建省三明市建宁县",
    "河南省信阳地区罗山县",
    "同安区新民镇柑岭村",
    undefined,
  ]);
  assert.equal(result.addressedFromIdCard, 2, "如实回报补了几行");
});

test("导入：家庭住址为空且身份证解析不出地区时，不编造地址", () => {
  const rows = [
    ["姓名", "部门", "职务", "员工类型", "身份证号码", "家庭住址"],
    // 999999198405204525 校验位自洽但区划代码查不到 → 地址仍是空，不硬凑
    ["张三", "生产部", "合片工", "车间", "999999198405204525", ""],
  ];
  const result = roster.parseEmployeeRosterRows(rows);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.rows[0].homeAddress, undefined);
  assert.equal(result.addressedFromIdCard, 0);
});

test("花名册：必填与长度/枚举不合法都会逐行指到具体字段", () => {
  const rows = [
    ["姓名", "部门", "职务", "员工类型", "工号", "出生日期"],
    ["", "生产部", "合片工", "车间", "E1", ""],
    ["张三", "", "合片工", "车间", "E2", ""],
    ["张三", "生产部", "", "车间", "E3", ""],
    ["张三", "生产部", "合片工", "车间", "E4", "2026-02-31"],
    ["张三", "生产部", "合片工", "office", "E5", ""],
    ["张三", "生产部", "合片工", "车间", "E1", ""],
    ["李四", "生产部", "合片工", "车间", "x".repeat(81), ""],
  ];
  const result = roster.parseEmployeeRosterRows(rows);
  assert.equal(result.rows.length, 0);
  const byRow = (line) => result.errors.filter((error) => error.row === line).map((error) => error.field);
  assert.deepEqual(byRow(2), ["姓名"]);
  assert.deepEqual(byRow(3), ["部门"]);
  assert.deepEqual(byRow(4), ["职务"]);
  assert.deepEqual(byRow(5), ["出生日期"]);
  assert.deepEqual(byRow(6), ["员工类型"]);
  assert.deepEqual(byRow(7), ["工号"], "文件内工号重复");
  assert.deepEqual(byRow(8), ["工号"], "工号超长");
});

test("花名册：员工类型留空不算错（留给服务层按部门推断），填错才算错", () => {
  const rows = [
    ["姓名", "部门", "职务", "员工类型"],
    ["张三", "生产部", "合片工", ""],
  ];
  const result = roster.parseEmployeeRosterRows(rows);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].employeeType, undefined);
});

// ---------------------------------------------------------------------------
// 3. 派生列（年龄 / 工龄 / 当月生日 / 合同到期提醒）
// ---------------------------------------------------------------------------

test("派生列：年龄与工龄按满年计算，未到生日那天不算一年", () => {
  assert.equal(roster.deriveAge(new Date(Date.UTC(1990, 4, 20)), today), "36");
  assert.equal(roster.deriveAge(new Date(Date.UTC(1990, 8, 17)), today), "35", "生日还没到");
  assert.equal(roster.deriveAge(new Date(Date.UTC(1990, 8, 16)), today), "36", "生日当天算满年");
  assert.equal(roster.deriveAge(null, today), "");
  assert.equal(roster.deriveTenure(new Date(Date.UTC(2020, 8, 16)), today), "6");
  assert.equal(roster.deriveTenure(undefined, today), "");
});

test("派生列：当月生日员工只在生日所在月为 1", () => {
  assert.equal(roster.deriveBirthdayThisMonth(new Date(Date.UTC(1990, 8, 1)), today), "1");
  assert.equal(roster.deriveBirthdayThisMonth(new Date(Date.UTC(1990, 7, 1)), today), "0");
  assert.equal(roster.deriveBirthdayThisMonth(null, today), "");
});

test("派生列：合同档位按「正常 / 即将过期（1 个月内）/ 已过期 / 未填」四态", () => {
  assert.equal(roster.deriveContractStatus(new Date(Date.UTC(2026, 8, 15)), today), "已过期");
  // 1 个月内的边界：明天到期算即将过期，31 天算即将过期，32 天算正常
  assert.equal(roster.deriveContractStatus(new Date(Date.UTC(2026, 8, 17)), today), "即将过期");
  assert.equal(roster.deriveContractStatus(new Date(Date.UTC(2026, 9, 1)), today), "即将过期");
  assert.equal(roster.deriveContractStatus(new Date(Date.UTC(2026, 9, 17)), today), "即将过期", "今天 + 31 天仍在 1 个月内");
  assert.equal(roster.deriveContractStatus(new Date(Date.UTC(2026, 9, 18)), today), "正常", "今天 + 32 天已经出了 1 个月");
  assert.equal(roster.deriveContractStatus(new Date(Date.UTC(2027, 2, 19)), today), "正常");
  // 到期当天不算过期
  assert.equal(roster.deriveContractStatus(new Date(Date.UTC(2026, 8, 16)), today), "即将过期");
  assert.equal(roster.deriveContractStatus(null, today), "");
  assert.equal(roster.deriveContractStatus(undefined, today), "");
});

test("派生列：合同情况 = 劳动合同与劳务合同里最紧急的一档", () => {
  const over = new Date(Date.UTC(2026, 0, 1));      // 已过期
  const soon = new Date(Date.UTC(2026, 9, 1));      // 即将过期
  const fine = new Date(Date.UTC(2028, 0, 1));      // 正常
  assert.equal(roster.deriveContractSituation(over, soon, today), "已过期", "取最紧急的");
  assert.equal(roster.deriveContractSituation(fine, soon, today), "即将过期");
  assert.equal(roster.deriveContractSituation(soon, over, today), "已过期", "与参数顺序无关");
  assert.equal(roster.deriveContractSituation(fine, fine, today), "正常");
  assert.equal(roster.deriveContractSituation(null, fine, today), "正常", "只有劳务合同时按它算");
  assert.equal(roster.deriveContractSituation(soon, null, today), "即将过期");
  assert.equal(roster.deriveContractSituation(null, null, today), "", "两份都没填结束时间才算「没有合同信息」");
  assert.equal(roster.deriveContractSituation(undefined, undefined, today), "");
});

// ---------------------------------------------------------------------------
// 4. 导出映射：覆盖花名册全部字段
// ---------------------------------------------------------------------------

test("导出：花名册 28 列全部落地（含 5 个派生列），并且能原样回灌导入", () => {
  const row = {
    employeeNo: "E001", name: "刘春娇", employeeType: "workshop", employmentStatus: "active",
    department: { code: "D001", name: "办公室" }, position: { code: "P001", name: "总经理" },
    birthDate: new Date(Date.UTC(1984, 4, 20)), gender: "女", ethnicity: "汉", idCardNo: "350430198405204527",
    education: "本科", bloodType: "O", hiredOn: new Date(Date.UTC(2017, 4, 22)), leftOn: null,
    socialInsurance: true, commercialInsurance: false,
    contractStart: new Date(Date.UTC(2020, 4, 21)), contractEnd: new Date(Date.UTC(2023, 4, 21)),
    laborContractStart: null, laborContractEnd: new Date(Date.UTC(2026, 9, 4)),
    homeAddress: "福建省建宁县", currentAddress: "同安区", phone: "159 8078 5005",
    emergencyContact: "石向阳", emergencyPhone: "13159262575", remark: "备注",
    userId: "user-1", createdAt: new Date(Date.UTC(2026, 0, 1, 2, 3, 4)), updatedAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
  };
  const exported = roster.employeeExportRow(row, 0, "hruser", today);
  for (const header of roster.EMPLOYEE_EXPORT_HEADERS) {
    assert.ok(header in exported, `导出缺少列：${header}`);
  }
  assert.equal(Object.keys(exported).length, roster.EMPLOYEE_EXPORT_HEADERS.length, "导出列数应与表头一致");
  assert.equal(exported["序号"], 1);
  assert.equal(exported["工号"], "E001");
  assert.equal(exported["部门"], "办公室");
  assert.equal(exported["职务"], "总经理");
  assert.equal(exported["状态"], "在职");
  assert.equal(exported["出生日期"], "1984-05-20");
  // 年龄/工龄导出成数字而不是文本，Excel 里可以直接排序和做条件格式
  assert.equal(exported["年龄"], 42);
  assert.equal(exported["工龄"], 9);
  assert.equal(exported["是否缴纳社保"], "是");
  assert.equal(exported["是否缴纳商业险"], "否");
  assert.equal(exported["合同起止时间-开始时间"], "2020-05-21");
  assert.equal(exported["合同起止时间-结束时间"], "2023-05-21");
  assert.equal(exported["劳务合同-结束时间"], "2026-10-04");
  assert.equal(exported["劳务合同即将到期人员"], "即将过期");
  assert.equal(exported["合同即将到期人员"], "已过期");
  assert.equal(exported["当月生日员工"], "0", "9 月不是 5 月");
  assert.equal(exported["绑定系统用户名"], "hruser");
  assert.equal(exported["员工类型"], "车间");
  assert.equal(exported["部门编码"], "D001");
  assert.equal(exported["创建时间"], "2026-01-01 02:03:04");

  // 导出 → 导入闭环：派生列与「序号/员工状态」这类展示列会被解析器忽略，不报错。
  const result = roster.parseEmployeeRosterRows([[...roster.EMPLOYEE_EXPORT_HEADERS], roster.EMPLOYEE_EXPORT_HEADERS.map((header) => exported[header])]);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].name, "刘春娇");
  assert.equal(result.rows[0].contractEnd.toISOString().slice(0, 10), "2023-05-21");
  assert.equal(result.rows[0].laborContractEnd.toISOString().slice(0, 10), "2026-10-04");
});

test("导入模板：包含花名册的全部非派生字段 + 系统必需列，派生列不出现", () => {
  const importHeaders = new Set(roster.EMPLOYEE_IMPORT_HEADERS);
  for (const header of ["工号", "姓名", "部门", "职务", "状态", "出生日期", "学历", "血型", "入职日期", "离职日期", "员工类型", "是否缴纳社保", "是否缴纳商业险", "合同开始时间", "合同结束时间", "劳务合同开始时间", "劳务合同结束时间", "性别", "民族", "身份证号码", "家庭住址", "现住地址", "联系方式", "紧急联络人", "紧急联络人联系电话", "备注"]) {
    assert.ok(importHeaders.has(header), `导入模板缺少：${header}`);
  }
  assert.equal(roster.EMPLOYEE_IMPORT_HEADERS.length, 26);
  for (const derived of roster.EMPLOYEE_DERIVED_HEADERS) {
    assert.equal(importHeaders.has(derived), false, `派生列 ${derived} 不该出现在导入模板里`);
  }
  assert.equal(roster.EMPLOYEE_IMPORT_SAMPLE_ROW.length, roster.EMPLOYEE_IMPORT_HEADERS.length, "示例行必须与表头对齐");
  // 示例行的身份证号必须自洽，否则操作员下载模板直接上传会被校验位挡下来
  assert.equal(roster.parseIdCard(roster.EMPLOYEE_IMPORT_SAMPLE_ROW[19]).ok, true);
});

// ---------------------------------------------------------------------------
// 5. 服务层编排：自动工号、部门/职务解析、员工类型推断、模板闭环
// ---------------------------------------------------------------------------

const IMPORT_HEADER = ["工号", "姓名", "部门", "职务", "状态", "员工类型", "入职日期", "身份证号码", "联系方式"];

test("导入：工号留空时按 EMP-当天日期-序号 自动生成，多行递增且避开已有工号", async () => {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const { prisma, created } = fakePrisma({ employees: [{ employeeNo: `EMP-${day}-0007`, departmentId: "dept-1", employeeType: "workshop" }] });
  const service = new ProductionMasterDataService(prisma, audit);
  const result = await service.importEmployees({ buffer: workbook([IMPORT_HEADER, ["", "张三", "生产部", "合片工", "在职", "车间", "2020-03-30", "", "13800000000"], ["", "李四", "生产部", "合片工", "在职", "车间", "", "", ""]]) }, user);
  assert.equal(result.errorCount, 0, JSON.stringify(result.errors));
  assert.equal(result.imported, 2);
  assert.equal(result.autoNumbered, 2);
  assert.equal(created[0].employeeNo, `EMP-${day}-0008`, "应在当天已有最大序号上 +1");
  assert.equal(created[1].employeeNo, `EMP-${day}-0009`, "同一批内继续递增，不撞号");
});

test("导入：部门与职务按名称或编码都能解析，员工类型留空时按部门已有员工推断", async () => {
  const { prisma, created } = fakePrisma({
    departments: [{ id: "dept-1", code: "D001", name: "生产部" }],
    positions: [{ id: "pos-1", code: "P001", name: "合片工", departmentId: "dept-1" }],
    employees: [{ employeeNo: "E-OLD", departmentId: "dept-1", employeeType: "workshop" }],
  });
  const service = new ProductionMasterDataService(prisma, audit);
  // 第一行用名称，第二行用编码；员工类型整列留空
  const result = await service.importEmployees({ buffer: workbook([IMPORT_HEADER, ["E-1", "张三", "生产部", "合片工", "在职", "", "", "", ""], ["E-2", "李四", "D001", "P001", "在职", "", "", "", ""]]) }, user);
  assert.equal(result.errorCount, 0, JSON.stringify(result.errors));
  assert.equal(result.imported, 2);
  assert.equal(result.inferredEmployeeTypes, 2);
  assert.equal(created[0].departmentId, "dept-1");
  assert.equal(created[0].positionId, "pos-1");
  assert.equal(created[0].employeeType, "workshop", "按部门里唯一的历史类型推断");
  assert.equal(created[0].employmentStatus, "active");
});

test("导入：部门里已有多种员工类型时不猜，逐行报错并说明原因", async () => {
  const { prisma, created } = fakePrisma({
    employees: [
      { employeeNo: "E-A", departmentId: "dept-1", employeeType: "workshop" },
      { employeeNo: "E-B", departmentId: "dept-1", employeeType: "non_workshop" },
    ],
  });
  const service = new ProductionMasterDataService(prisma, audit);
  const result = await service.importEmployees({ buffer: workbook([IMPORT_HEADER, ["E-1", "张三", "生产部", "合片工", "在职", "", "", "", ""]]) }, user);
  assert.equal(result.imported, 0);
  assert.equal(created.length, 0);
  assert.ok(result.errors.some((error) => error.field === "员工类型" && /多种员工类型/.test(error.reason)), JSON.stringify(result.errors));
});

test("导入：工号已存在不覆盖，部门/职务找不到时指出具体原因", async () => {
  const { prisma, created } = fakePrisma({ employees: [{ employeeNo: "E-1", departmentId: "dept-1", employeeType: "workshop" }] });
  const service = new ProductionMasterDataService(prisma, audit);
  const result = await service.importEmployees({ buffer: workbook([
    IMPORT_HEADER,
    ["E-1", "张三", "生产部", "合片工", "在职", "车间", "", "", ""],
    ["E-2", "李四", "不存在的部门", "合片工", "在职", "车间", "", "", ""],
    ["E-3", "王五", "生产部", "不存在的职务", "在职", "车间", "", "", ""],
  ]) }, user);
  assert.equal(result.imported, 0);
  assert.equal(created.length, 0);
  const reasons = result.errors.map((error) => `${error.field}:${error.reason}`).join(" | ");
  assert.match(reasons, /工号:工号已存在，不覆盖/);
  assert.match(reasons, /部门:部门「不存在的部门」不存在或已停用/);
  assert.match(reasons, /职务:职务\/岗位「不存在的职务」不存在或已停用/);
});

test("导入：分批写库遇到唯一约束竞争时退化成逐行重试，坏行不拖垮整批", async () => {
  let seen = 0;
  const { prisma, created } = fakePrisma({
    onCreate: async () => {
      seen += 1;
      // 整批事务里第一行就撞唯一约束 → 触发逐行重试路径（真实库中该批会整体回滚）
      if (seen === 1) { const error = new Error("duplicate"); error.code = "P2002"; throw error; }
    },
  });
  const service = new ProductionMasterDataService(prisma, audit);
  const result = await service.importEmployees({ buffer: workbook([IMPORT_HEADER, ["E-1", "张三", "生产部", "合片工", "在职", "车间", "", "", ""], ["E-2", "李四", "生产部", "合片工", "在职", "车间", "", "", ""]]) }, user);
  assert.equal(result.imported, 2, "逐行重试后两行都要落库");
  assert.equal(result.errorCount, 0, JSON.stringify(result.errors));
  assert.deepEqual(created.map((item) => item.employeeNo).sort(), ["E-1", "E-2"], "两行各落库一次，没有重复写入");
});

test("导入：下载的模板能被自己的解析器读回（表头 → 示例行闭环）", async () => {
  const { prisma } = fakePrisma();
  const service = new ProductionMasterDataService(prisma, audit);
  const template = service.employeeImportTemplate();
  assert.ok(Buffer.isBuffer(template) || template instanceof Uint8Array, "模板应当是 xlsx 二进制");
  // 模板上的示例行（张三）应当能整体通过校验：部门/职务存在、身份证自洽
  const result = await service.importEmployees({ buffer: Buffer.from(template) }, user);
  assert.equal(result.errorCount, 0, JSON.stringify(result.errors));
  assert.equal(result.imported, 1, "模板自带的示例行本身就是一条合法数据");
  assert.equal(result.headerRow, 1);
  // 第二张表是「填写说明」，不能影响导入（导入只读第一张表）
  const book = XLSX.read(template, { type: "buffer" });
  assert.deepEqual(book.SheetNames, ["员工导入", "填写说明"]);
});

test("导入：只有行级错误时不整批丢弃，合法行照样导入（status=partial）", async () => {
  const { prisma, created } = fakePrisma();
  const service = new ProductionMasterDataService(prisma, audit);
  const result = await service.importEmployees({ buffer: workbook([
    IMPORT_HEADER,
    ["E-1", "张三", "生产部", "合片工", "在职", "车间", "", "", ""],          // 合法
    ["E-2", "", "生产部", "合片工", "在职", "车间", "", "", ""],              // 姓名缺失
    ["E-3", "王五", "无此部门", "合片工", "在职", "车间", "", "", ""],         // 部门不存在
    ["E-4", "李四", "生产部", "合片工", "在职", "车间", "2020-03-30", "", ""], // 合法
  ]) }, user);
  assert.equal(result.status, "partial");
  assert.equal(result.imported, 2, "两行合法数据必须落库，不能被别的行的错误连坐");
  assert.equal(result.total, 4);
  assert.equal(result.errorCount, 2, "两处错误：姓名缺失 / 部门不存在");
  assert.deepEqual(created.map((item) => item.employeeNo), ["E-1", "E-4"]);
});

test("导入：缺必需列时整批不导入（blocked），一行都不写，并点名缺的是哪一列", async () => {
  const { prisma, created } = fakePrisma();
  const service = new ProductionMasterDataService(prisma, audit);
  // 缺「职务」列（姓名 + 部门都在，所以能识别成「员工表但缺列」）
  const result = await service.importEmployees({ buffer: workbook([
    ["姓名", "部门", "员工类型"],
    ["张三", "生产部", "车间"],
  ]) }, user);
  assert.equal(result.imported, 0);
  assert.equal(created.length, 0);
  assert.deepEqual(result.missingColumns, ["职务/岗位"]);
  assert.match(result.errors[0].reason, /缺少必需列：职务\/岗位/);
});

test("导入：不是员工表（表头都认不出来）时只回一条整体错误", async () => {
  const { prisma, created } = fakePrisma();
  const service = new ProductionMasterDataService(prisma, audit);
  const result = await service.importEmployees({ buffer: workbook([
    ["厦门迪礼伞业进出口有限公司"],
    ["材料", "明细"],
    ["伞骨", "21.5\"X8K三折自动伞"],
  ]) }, user);
  assert.equal(result.imported, 0);
  assert.equal(created.length, 0);
  assert.equal(result.headerRow, -1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].reason, /未找到员工表头/);
});

test("导入：没文件的请求仍然是 422 EMPLOYEE_IMPORT_FILE_REQUIRED", async () => {
  const { prisma } = fakePrisma();
  const service = new ProductionMasterDataService(prisma, audit);
  await assert.rejects(() => service.importEmployees(undefined, user), (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "EMPLOYEE_IMPORT_FILE_REQUIRED");
});

test("导入：手工花名册缺员工类型列且无从推断时，除了逐行报错还要给出「去补哪一列」的提示", async () => {
  const { prisma, created } = fakePrisma();
  const service = new ProductionMasterDataService(prisma, audit);
  const result = await service.importEmployees({ buffer: workbook([
    ["在职员工花名册"],
    ["姓名", "部门", "职务"],
    ["张三", "生产部", "合片工"],
  ]) }, user);
  assert.equal(result.imported, 0);
  assert.equal(created.length, 0);
  assert.equal(result.documentLayout, true);
  // 逐行错误：员工类型确实没有来源
  assert.ok(result.errors.some((error) => error.field === "员工类型" && /还没有员工/.test(error.reason)), JSON.stringify(result.errors));
  // 顶层提示：直接告诉操作员该做什么
  assert.ok(result.hints.some((hint) => /没有「员工类型」列/.test(hint)), JSON.stringify(result.hints));
  assert.ok(result.hints.some((hint) => /手工花名册版式/.test(hint)), JSON.stringify(result.hints));
  assert.deepEqual(result.presentFields.includes("employee_type"), false);
});

test("导入：文档版花名册也能按部门历史类型推断员工类型", async () => {
  const { prisma, created } = fakePrisma({
    employees: [
      { employeeNo: "E-A", departmentId: "dept-1", employeeType: "workshop" },
      { employeeNo: "E-B", departmentId: "dept-1", employeeType: "workshop" },
    ],
  });
  const service = new ProductionMasterDataService(prisma, audit);
  const result = await service.importEmployees({ buffer: workbook([
    ["迪礼员工花名册"],
    ["序号", "姓名", "部门", "职务", "入职日期"],
    ["1", "张三", "生产部", "合片工", "2020-03-30"],
  ]) }, user);
  assert.equal(result.errorCount, 0, JSON.stringify(result.errors));
  assert.equal(result.imported, 1);
  assert.equal(result.inferredEmployeeTypes, 1);
  assert.equal(created[0].employeeType, "workshop");
  assert.equal(created[0].hiredOn.toISOString().slice(0, 10), "2020-03-30");
});

// ---------------------------------------------------------------------------
// 6. 表单路径：与导入共用同一套规范化规则
// ---------------------------------------------------------------------------

test("表单：新建员工工号留空时自动生成，并按身份证补齐出生日期与性别", async () => {
  const { prisma, created } = fakePrisma();
  const service = new ProductionMasterDataService(prisma, audit);
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const employee = await service.createEmployee({
    name: "张三", department_id: "dept-1", position_id: "pos-1", employee_type: "workshop",
    id_card_no: "350430198405204527",
  }, user);
  assert.equal(employee.employeeNo, `EMP-${day}-0001`);
  assert.equal(created[0].birthDate.toISOString().slice(0, 10), "1984-05-20");
  assert.equal(created[0].gender, "女");
  assert.equal(created[0].idCardNo, "350430198405204527");
});

test("表单：身份证与手填性别冲突时报 422，不静默覆盖用户输入", async () => {
  const { prisma } = fakePrisma();
  const service = new ProductionMasterDataService(prisma, audit);
  await assert.rejects(
    () => service.createEmployee({ name: "张三", department_id: "dept-1", position_id: "pos-1", employee_type: "workshop", id_card_no: "350430198405204527", gender: "男" }, user),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "ID_CARD_MISMATCH",
  );
});

test("表单：合同区间合并校验（PATCH 只改一半也要和库里的另一半对得上）", async () => {
  const { prisma } = fakePrisma({ employees: [{ id: "emp-1", departmentId: "dept-1", positionId: "pos-1", employmentStatus: "active", birthDate: null, gender: null, contractStart: new Date(Date.UTC(2026, 0, 1)), contractEnd: new Date(Date.UTC(2026, 11, 31)), laborContractStart: null, laborContractEnd: null }] });
  const service = new ProductionMasterDataService(prisma, audit);
  await assert.rejects(
    () => service.updateEmployee("emp-1", { contract_start: "2027-01-01" }, user),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "INVALID_CONTRACT_RANGE",
  );
  // 反过来把结束时间往后挪是合法的
  const updated = await service.updateEmployee("emp-1", { contract_end: "2027-12-31" }, user);
  assert.equal(updated.contractEnd.toISOString().slice(0, 10), "2027-12-31");
});

test("表单：编辑时不会用身份证推导结果覆盖档案里已有的出生日期/性别", async () => {
  const { prisma } = fakePrisma({ employees: [{ id: "emp-1", departmentId: "dept-1", positionId: "pos-1", employmentStatus: "active", birthDate: new Date(Date.UTC(1980, 0, 1)), gender: "男", contractStart: null, contractEnd: null, laborContractStart: null, laborContractEnd: null }] });
  const service = new ProductionMasterDataService(prisma, audit);
  const updated = await service.updateEmployee("emp-1", { id_card_no: "350430198405204527" }, user);
  assert.equal(updated.idCardNo, "350430198405204527");
  assert.equal("birthDate" in updated, false, "已有出生日期时不该被身份证推导覆盖");
  assert.equal("gender" in updated, false, "已有性别时不该被身份证推导覆盖");
});

test("列表：员工目录读模型带上年龄/工龄/合同到期等派生列，且不改动原始字段", async () => {
  const { prisma } = fakePrisma();
  const service = new ProductionMasterDataService(prisma, audit);
  const original = prisma.employee.findMany;
  prisma.employee.findMany = async () => [{
    id: "emp-1", employeeNo: "E001", name: "张三", departmentId: "dept-1", positionId: "pos-1",
    employeeType: "workshop", employmentStatus: "active", birthDate: new Date(Date.UTC(1990, 4, 20)),
    hiredOn: new Date(Date.UTC(2020, 4, 20)), contractEnd: new Date(Date.UTC(2026, 9, 1)),
    laborContractEnd: null, department: { code: "D001", name: "生产部" }, position: { code: "P001", name: "合片工" },
  }];
  const rows = await service.listEmployees();
  prisma.employee.findMany = original;
  assert.equal(rows[0].employeeNo, "E001", "原始字段原样保留");
  assert.equal(typeof rows[0].age, "number");
  assert.equal(typeof rows[0].tenureYears, "number");
  // 单份合同的档位与合并后的「合同情况」都给（导出用前者，页面用后者）
  assert.equal(["正常", "即将过期", "已过期"].includes(rows[0].contractStatus), true, rows[0].contractStatus);
  assert.equal(rows[0].laborContractStatus, "");
  assert.equal(rows[0].contractSituation, rows[0].contractStatus, "只有劳动合同有结束时间时，合同情况 = 它的档位");
  assert.equal(rows[0].birthdayThisMonth, new Date().getUTCMonth() === 4);
});

// ---------------------------------------------------------------------------
// 7. 逻辑删除 / 恢复
// ---------------------------------------------------------------------------

/** 带事务与锁的替身：deleteEmployee/restoreEmployee 走 $transaction + SELECT ... FOR UPDATE。 */
function deletionHarness(employee) {
  const auditEvents = [];
  const store = { ...employee };
  const prisma = {
    employee: {
      // 返回快照而不是 store 本身：真实 Prisma 读出来的是新对象，
      // 所以「先读到 deletedAt、再清空、然后写审计」不会因为别名而读到 null。
      findFirst: async ({ where }) => {
        if (where.deletedAt === null && store.deletedAt) return null;
        if (where.deletedAt && !store.deletedAt) return null;
        return store.id === where.id ? { ...store } : null;
      },
      update: async ({ data }) => { Object.assign(store, data); return { ...store }; },
    },
    $transaction: async (fn) => fn({ ...prisma, $queryRaw: async () => [] }),
  };
  const recordingAudit = { ...audit, record: async (...args) => { auditEvents.push(args); } };
  return { prisma, store, auditEvents, service: new ProductionMasterDataService(prisma, recordingAudit) };
}

test("删除员工：逻辑删除写 deletedAt/deletedBy，物理行与历史引用都保留", async () => {
  const { service, store, auditEvents } = deletionHarness({ id: "emp-1", employeeNo: "E001", name: "张三", departmentId: "dept-1", employmentStatus: "active", deletedAt: null, deletedBy: null });
  const deleted = await service.deleteEmployee("emp-1", user);
  assert.equal(deleted.deletedAt instanceof Date, true, "写的是逻辑删除时间而不是真删");
  assert.equal(deleted.deletedBy, user.id);
  assert.equal(deleted.employeeNo, "E001", "行还在，工号/姓名等业务字段不动");
  assert.equal(deleted.employmentStatus, "active", "删除不动在职状态：这是两个独立维度，恢复后状态不变");
  const event = auditEvents.find(([action]) => action === "employee.delete");
  assert.ok(event, "删除必须留审计事件");
  assert.deepEqual(event[4], { employee_no: "E001", name: "张三", department_id: "dept-1", employment_status: "active" });
});

test("删除员工：重复删除返回 404 EMPLOYEE_NOT_FOUND（不静默成功）", async () => {
  const { service } = deletionHarness({ id: "emp-1", employeeNo: "E001", name: "张三", deletedAt: null });
  await service.deleteEmployee("emp-1", user);
  await assert.rejects(
    () => service.deleteEmployee("emp-1", user),
    (error) => error.getResponse().code === "EMPLOYEE_NOT_FOUND",
  );
});

test("恢复员工：清掉 deletedAt，并在审计里保留原来是谁删的、什么时候删的", async () => {
  const { service, store, auditEvents } = deletionHarness({ id: "emp-1", employeeNo: "E001", name: "张三", deletedAt: null, deletedBy: null });
  await service.deleteEmployee("emp-1", user);
  const removedAt = store.deletedAt;
  const restored = await service.restoreEmployee("emp-1", user);
  assert.equal(restored.deletedAt, null);
  const event = auditEvents.find(([action]) => action === "employee.restore");
  assert.equal(event[4].deleted_by, user.id, "原始删除人留在审计里");
  assert.equal(event[4].deleted_at, removedAt);
  assert.equal(event[4].restored_by, user.id);
});

test("恢复员工：没被删过的员工返回 404 EMPLOYEE_NOT_DELETED", async () => {
  const { service } = deletionHarness({ id: "emp-1", employeeNo: "E001", name: "张三", deletedAt: null, deletedBy: null });
  await assert.rejects(
    () => service.restoreEmployee("emp-1", user),
    (error) => error.getResponse().code === "EMPLOYEE_NOT_DELETED",
  );
});

test("员工目录：默认不带已删除员工，include_deleted=true 才带出来（默认从列表消失）", async () => {
  const rows = [
    { id: "emp-1", employeeNo: "E001", name: "张三", departmentId: "dept-1", positionId: "pos-1", employeeType: "workshop", employmentStatus: "active", deletedAt: null },
    { id: "emp-2", employeeNo: "E002", name: "李四", departmentId: "dept-1", positionId: "pos-1", employeeType: "workshop", employmentStatus: "left", deletedAt: new Date(Date.UTC(2026, 8, 16)) },
  ];
  const seen = [];
  const { prisma } = fakePrisma();
  prisma.employee.findMany = async ({ where }) => {
    seen.push(where);
    const includeDeleted = where.deletedAt === undefined;
    return rows
      .filter((row) => (includeDeleted ? true : row.deletedAt === null))
      .map((row) => ({ ...row, createdAt: new Date(), updatedAt: new Date(), department: { code: "D001", name: "生产部" }, position: { code: "P001", name: "合片工" } }));
  };
  const service = new ProductionMasterDataService(prisma, audit);
  const live = await service.listEmployees();
  assert.deepEqual(live.map((row) => row.employeeNo), ["E001"], "默认把已删除的员工挡在列表外");
  const all = await service.listEmployees({ include_deleted: "true" });
  assert.deepEqual(all.map((row) => row.employeeNo), ["E001", "E002"], "带开关时才返回已删除员工，供恢复使用");
  // include_deleted 是字符串开关：其它取值一律当 false（与部门池/岗位池/地点/工序同一套约定）
  await service.listEmployees({ include_deleted: "maybe" });
  assert.deepEqual(seen.at(-1).deletedAt, null);
});

test("员工目录：include_deleted 不放进导出（导出的永远是在册员工名单）", async () => {
  const { prisma } = fakePrisma();
  let lastWhere = null;
  prisma.employee.findMany = async ({ where }) => { lastWhere = where; return []; };
  const service = new ProductionMasterDataService(prisma, audit);
  await service.exportEmployees({});
  assert.deepEqual(lastWhere.deletedAt, null, "导出按钮不传 include_deleted，导出的只有在册员工");
});

// ---------------------------------------------------------------------------
// 8. 真实文件打穿：用仓库里那份《在职员工花名册》跑完整导入链
// ---------------------------------------------------------------------------

/**
 * 合成一行数据只能证明「我以为的版式」能解析；这份测试直接用用户给的原表，
 * 证明「真实的两级合并表头 + 标题行 + 末尾批注 + Excel 日期序列号」这条路径真的通。
 * 文件不存在时跳过（例如精简的 CI 检出）。
 */
const ROSTER_FILE = join(__dirname, "..", "..", "..", "..", "example", "人事", "迪礼员工更新员工花名册(1).xlsx");
const rosterFileExists = existsSync(ROSTER_FILE);

test("真实花名册：整份文件 10 行全部导入，字段逐格对上原表", { skip: rosterFileExists ? false : "缺少 example/人事/迪礼员工更新员工花名册(1).xlsx" }, async () => {
  // 花名册里出现的部门与职务（部门已有类型一致的历史员工，让「员工类型」能被推断）
  const departments = [
    { id: "dept-office", code: "D001", name: "办公室" },
    { id: "dept-prod", code: "D002", name: "生产部" },
    { id: "dept-he", code: "D003", name: "合片部" },
  ];
  const positionNames = { "dept-office": ["总经理", "经理", "财务", "跟单业务", "采购"], "dept-prod": ["拉边工", "合片组长"], "dept-he": ["合片工"] };
  const positions = Object.entries(positionNames).flatMap(([departmentId, names]) => names.map((name, index) => ({ id: `${departmentId}-p${index}`, code: `P-${index}`, name, departmentId })));
  const { prisma, created } = fakePrisma({
    departments,
    positions,
    employees: [
      { employeeNo: "E-O1", name: "老办公室", positionId: "dept-office-p0", departmentId: "dept-office", employeeType: "non_workshop" },
      { employeeNo: "E-P1", name: "老生产", positionId: "dept-prod-p0", departmentId: "dept-prod", employeeType: "workshop" },
      { employeeNo: "E-H1", name: "老合片", positionId: "dept-he-p0", departmentId: "dept-he", employeeType: "workshop" },
    ],
  });
  const service = new ProductionMasterDataService(prisma, audit);
  const result = await service.importEmployees({ buffer: readFileSync(ROSTER_FILE) }, user);

  assert.equal(result.status, "success", JSON.stringify(result.errors));
  assert.equal(result.imported, 10);
  assert.equal(result.errorCount, 0);
  // 文档版版式：表头在第 3 行，末尾 3 行说明批注被跳过
  assert.equal(result.headerRow, 3);
  assert.equal(result.documentLayout, true);
  assert.equal(result.ignoredTrailingRows, 3);
  // 工号整列留空 → 全部自动生成；员工类型整列缺失 → 全部按部门历史推断
  assert.equal(result.autoNumbered, 10);
  assert.equal(result.inferredEmployeeTypes, 10);
  assert.ok(created.every((item) => /^EMP-\d{8}-\d{4}$/.test(item.employeeNo)), created.map((item) => item.employeeNo).join(","));

  const byName = new Map(created.map((item) => [item.name, item]));
  const day = (value) => (value ? value.toISOString().slice(0, 10) : "");
  // 逐格核对原表里的关键值（含 Excel 序列号日期不许错一天）
  const liu = byName.get("刘春娇");
  assert.equal(day(liu.hiredOn), "2017-05-22");
  assert.equal(day(liu.birthDate), "1984-05-20");
  assert.equal(liu.gender, "女");
  assert.equal(day(liu.contractEnd), "2023-05-21");
  assert.equal(liu.education, "本科");
  assert.equal(liu.ethnicity, "汉");
  assert.equal(liu.idCardNo, "350430198405204527");
  assert.equal(liu.socialInsurance, true);
  assert.equal(liu.phone, "159 8078 5005");
  assert.equal(liu.employmentStatus, "active");
  assert.equal(liu.employeeType, "non_workshop");

  const ma = byName.get("马万琴");
  assert.equal(day(ma.laborContractEnd), "2026-10-04", "「劳务合同 / 结束时间」两级表头必须解析到");
  assert.equal(ma.contractEnd ?? null, null, "劳动合同结束时间留空不能串到劳务合同上");
  assert.equal(ma.commercialInsurance, true);
  assert.equal(ma.employeeType, "workshop", "合片部 → 车间");

  const zeng = byName.get("曾叶");
  assert.equal(zeng.emergencyContact, "石向阳");
  assert.equal(zeng.emergencyPhone, "13159262575");
  assert.equal(day(zeng.hiredOn), "2025-09-16", "3 位年份的日期格式 9/16/25 也要认");
  assert.equal(byName.get("刘帝胜").socialInsurance, undefined, "空白认成未登记，不是「否」");

  // 导出 37 列，且导出文件能被自己回灌（全新空库）
  const exportBuffer = await service.exportEmployees({});
  const book = XLSX.read(exportBuffer, { type: "buffer" });
  const exportedRows = XLSX.utils.sheet_to_json(book.Sheets["员工名单"], { header: 1, raw: true, defval: "" });
  assert.equal(exportedRows[0].length, roster.EMPLOYEE_EXPORT_HEADERS.length);
  const fresh = fakePrisma({ departments, positions, employees: [] });
  const round = await new ProductionMasterDataService(fresh.prisma, audit).importEmployees({ buffer: exportBuffer }, user);
  assert.equal(round.errorCount, 0, JSON.stringify(round.errors));
  assert.equal(round.imported, exportedRows.length - 1);
  assert.deepEqual(round.ignoredColumns, ["绑定系统用户名", "创建时间", "更新时间"]);
});

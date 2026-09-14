// 平台层 Prisma 错误码判定（apps/api/src/platform/database/prisma-error.ts）单元测试。
//
// 这两个纯函数是平台里两件事的唯一判据：
//   1) 「自动编码撞号」时能否重算重试 —— 客户编码（customers.service.ts:44）、物料编码（procurement-master-data.service.ts:103）；
//   2) 「P2002 该报哪个字段冲突」—— 编码冲突 vs「名称+规格型号+颜色」组合冲突。
// 判错成 true：把不该重试的冲突重试一遍（多写一次、并把真实冲突提示覆盖掉）；
// 判错成 false：少一次自愈机会，或把编码冲突误报成组合冲突，用户按错误提示改数据也解决不了。
//
// 因此本文件既钉死纯函数的真值表，也用**真实的 CustomersService（dist 编译产物）**验证
// 「不该重试时绝不产生第二次写入」——这才是这两个函数存在的意义。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ConflictException } = require("@nestjs/common");
const { isUniqueConstraintViolation, isUniqueConstraintViolationOn } = require("../../dist/platform/database/prisma-error.js");
const { CustomersService } = require("../../dist/modules/sales/customers.service.js");

/** 造一个与 Prisma 抛出的 P2002 同形状的错误（PrismaClientKnownRequestError）。 */
function p2002(target) {
  const error = new Error("Unique constraint failed on the fields: (`customer_code`)");
  error.code = "P2002";
  error.clientVersion = "6.8.0";
  if (target !== undefined) error.meta = { target };
  return error;
}

const user = { id: "00000000-0000-0000-0000-000000000001" };
/** 自动编码形状（daily-sequence-code.ts:7 用 UTC 日期）：CUS-YYYYMMDD-0001。 */
const AUTO_CODE = /^(CUS-\d{8}-)(0001|0002|0003)$/;
/** 从实际写入的编码里取出前缀，避免测试正好跨 UTC 零点时误判。 */
const prefixOf = (code) => AUTO_CODE.exec(code)[1];

// ─────────────────────────── isUniqueConstraintViolation ───────────────────────────

test("prisma-error.p2002错误对象_判定为唯一约束冲突", () => {
  assert.equal(isUniqueConstraintViolation(p2002(["customer_code"])), true);
  assert.equal(isUniqueConstraintViolation(p2002("customers_customer_code_key")), true);
  assert.equal(isUniqueConstraintViolation({ code: "P2002" }), true);
  // 真实 Prisma 错误带 name/message/meta/clientVersion，多出字段不能影响判定。
  const error = p2002(["material_code"]);
  error.name = "PrismaClientKnownRequestError";
  error.meta = { target: ["material_code"], field_name: "material_code" };
  assert.equal(isUniqueConstraintViolation(error), true);
});

test("prisma-error.其它Prisma错误码_不判定为唯一约束冲突（不得重试）", () => {
  for (const code of ["P2003", "P2025", "P2001", "P2034", "P1001"]) {
    const error = new Error(code);
    error.code = code;
    assert.equal(isUniqueConstraintViolation(error), false, `${code} 不是唯一约束冲突`);
  }
  // 机器码大小写敏感：小写 p2002 不是 Prisma 的码，按原样拒绝而不是「宽容匹配」。
  assert.equal(isUniqueConstraintViolation({ code: "p2002" }), false);
  assert.equal(isUniqueConstraintViolation({ code: " P2002" }), false);
});

test("prisma-error.非对象或空值_安全返回false不抛异常", () => {
  // 调用方在 catch 分支里直接把它当守卫用，任何奇怪值都不能让这里二次抛错掩盖原始错误。
  for (const value of [null, undefined, "", "P2002", 42, 0, true, false, Symbol("P2002"), () => "P2002"]) {
    assert.equal(isUniqueConstraintViolation(value), false, `${String(value)} 不是错误对象`);
  }
  assert.equal(isUniqueConstraintViolation([]), false, "数组没有 code 属性");
  assert.equal(isUniqueConstraintViolation(new Error("boom")), false, "普通 Error 没有 code");
  assert.equal(isUniqueConstraintViolation({}), false);
  // 有 code 字段但不是 P2002 / 类型不对
  assert.equal(isUniqueConstraintViolation({ code: null }), false);
  assert.equal(isUniqueConstraintViolation({ code: undefined }), false);
  assert.equal(isUniqueConstraintViolation({ code: 2002 }), false, "数字 2002 不等于字符串 P2002");
  assert.equal(isUniqueConstraintViolation({ code: Symbol("P2002") }), false);
});

test("prisma-error.code在原型链上_仍能识别（用的是 in 而不是 hasOwnProperty）", () => {
  const error = Object.create({ code: "P2002" });
  error.message = "duplicate key";
  assert.equal(isUniqueConstraintViolation(error), true);
  // 继承来的非 P2002 码同样不该命中
  assert.equal(isUniqueConstraintViolation(Object.create({ code: "P2003" })), false);
});

// ────────────────────────── isUniqueConstraintViolationOn ──────────────────────────

test("prisma-error.target是列名数组_命中指定列返回true", () => {
  assert.equal(isUniqueConstraintViolationOn(p2002(["customer_code"]), "customer_code"), true);
  assert.equal(isUniqueConstraintViolationOn(p2002(["material_code"]), "material_code"), true);
  // 复合唯一索引的 target 是数组，只要求包含目标列
  assert.equal(isUniqueConstraintViolationOn(p2002(["name", "customer_code"]), "customer_code"), true);
});

test("prisma-error.target是约束名字符串_按子串命中列名", () => {
  assert.equal(isUniqueConstraintViolationOn(p2002("customers_customer_code_key"), "customer_code"), true);
  assert.equal(isUniqueConstraintViolationOn(p2002("materials_material_code_key"), "material_code"), true);
});

test("prisma-error.下划线与驼峰命名互通_两种写法都能命中", () => {
  // Prisma 的 meta.target 既可能是 DB 列名（customer_code）也可能是模型字段名（customerCode）。
  assert.equal(isUniqueConstraintViolationOn(p2002(["customerCode"]), "customer_code"), true);
  assert.equal(isUniqueConstraintViolationOn(p2002(["customer_code"]), "customerCode"), true);
  assert.equal(isUniqueConstraintViolationOn(p2002("customers_customer_code_key"), "customerCode"), true);
  assert.equal(isUniqueConstraintViolationOn(p2002(["materialCode"]), "material_code"), true);
});

test("prisma-error.大小写不一致_仍然命中", () => {
  assert.equal(isUniqueConstraintViolationOn(p2002(["CUSTOMER_CODE"]), "customer_code"), true);
  assert.equal(isUniqueConstraintViolationOn(p2002("CUSTOMERS_CUSTOMER_CODE_KEY"), "customer_code"), true);
  assert.equal(isUniqueConstraintViolationOn(p2002(["customer_code"]), "CUSTOMER_CODE"), true);
});

test("prisma-error.target是别的列_返回false（不能误报成目标列冲突）", () => {
  assert.equal(isUniqueConstraintViolationOn(p2002(["name"]), "customer_code"), false);
  assert.equal(isUniqueConstraintViolationOn(p2002("customers_name_key"), "customer_code"), false);
  assert.equal(isUniqueConstraintViolationOn(p2002(["supplier_code"]), "customer_code"), false);
});

test("prisma-error.物料组合唯一索引冲突_不得误判成物料编码冲突", () => {
  // 真实组合索引 target（名称+规格型号+颜色）里没有 material_code，必须回报 false，
  // 否则 procurement 会把「组合重复」的提示换成「换一个物料编码」，用户改编码也解决不了问题。
  assert.equal(isUniqueConstraintViolationOn(p2002(["name", "specification_model", "color"]), "material_code"), false);
  assert.equal(isUniqueConstraintViolationOn(p2002("materials_name_specification_model_color_key"), "material_code"), false);
  // 反过来：组合冲突里查 name 能命中（同一 target 上的不同问法）
  assert.equal(isUniqueConstraintViolationOn(p2002(["name", "specification_model", "color"]), "specification_model"), true);
});

test("prisma-error.meta缺失或target不可用_保守返回false（宁可不重试也不乱重试）", () => {
  // 拿不到 target 时保守 false：不重试也不会写坏数据，只是少一次自愈机会。
  assert.equal(isUniqueConstraintViolationOn(p2002(undefined), "customer_code"), false);
  assert.equal(isUniqueConstraintViolationOn({ code: "P2002" }, "customer_code"), false, "没有 meta");
  assert.equal(isUniqueConstraintViolationOn({ code: "P2002", meta: {} }, "customer_code"), false);
  assert.equal(isUniqueConstraintViolationOn({ code: "P2002", meta: { target: null } }, "customer_code"), false);
  assert.equal(isUniqueConstraintViolationOn({ code: "P2002", meta: { target: undefined } }, "customer_code"), false);
  assert.equal(isUniqueConstraintViolationOn({ code: "P2002", meta: { target: [] } }, "customer_code"), false, "空数组");
  assert.equal(isUniqueConstraintViolationOn({ code: "P2002", meta: { target: 42 } }, "customer_code"), false, "数字 target 不是列名");
  assert.equal(isUniqueConstraintViolationOn({ code: "P2002", meta: { target: {} } }, "customer_code"), false);
  assert.equal(isUniqueConstraintViolationOn({ code: "P2002", meta: { target: ["name"] } }, "customer_code"), false);
});

test("prisma-error.非P2002即使target命中_也返回false", () => {
  // 守卫必须整体委托给 isUniqueConstraintViolation：P2003（外键）即使 target 写着 customer_code 也不能重试。
  for (const code of ["P2003", "P2025", "P2034"]) {
    const error = new Error(code);
    error.code = code;
    error.meta = { target: ["customer_code"] };
    assert.equal(isUniqueConstraintViolationOn(error, "customer_code"), false, `${code} 不该被当成唯一约束冲突`);
  }
  assert.equal(isUniqueConstraintViolationOn(null, "customer_code"), false);
  assert.equal(isUniqueConstraintViolationOn(undefined, "customer_code"), false);
  assert.equal(isUniqueConstraintViolationOn("P2002", "customer_code"), false);
});

test("prisma-error.传多个候选列_任一命中即为true", () => {
  assert.equal(isUniqueConstraintViolationOn(p2002(["specification_model"]), "name", "specification_model"), true);
  assert.equal(isUniqueConstraintViolationOn(p2002(["customer_code"]), "name", "customer_code", "phone"), true);
  assert.equal(isUniqueConstraintViolationOn(p2002(["color"]), "name", "specification_model"), false);
  // 一个候选列都不传 = 不关心任何列 → 永远 false，不会变成「万能匹配」
  assert.equal(isUniqueConstraintViolationOn(p2002(["customer_code"])), false);
});

test("prisma-error.target非字符串元素_先String化再比对", () => {
  // 隐藏分支：targets 用 String(item) 归一化，数字/布尔元素也能比对。
  assert.equal(isUniqueConstraintViolationOn(p2002([12345]), "12345"), true);
  assert.equal(isUniqueConstraintViolationOn(p2002([true]), "true"), true);
  assert.equal(isUniqueConstraintViolationOn(p2002([12345]), "customer_code"), false);
});

// 潜在缺陷（当前调用方不可达，grep 确认生产代码只传字面量列名 "customer_code" / "material_code"）：
// 空列名会让整个列过滤退化成「永远命中」——`value.includes("")` 恒为 true。
// 若将来有人用变量拼列名（例如 isUniqueConstraintViolationOn(error, columnName) 且 columnName 可能是 ""），
// 任何唯一冲突都会被当成该列冲突并触发重试。责任位置：prisma-error.ts:19（`value.includes(column.toLowerCase())`）。
test("prisma-error.空列名_退化成万能匹配_KNOWN_DEFECT", () => {
  assert.equal(isUniqueConstraintViolationOn(p2002(["name"]), ""), true);
  assert.equal(isUniqueConstraintViolationOn(p2002("materials_name_specification_model_color_key"), ""), true);
});

// 潜在缺陷（同上，当前调用方不可达）：列名是 undefined/null 时直接 TypeError，
// 而不是返回 false —— 在 catch 分支里会掩盖原始 Prisma 错误。责任位置：prisma-error.ts:19（`column.toLowerCase()`）。
test("prisma-error.列名是undefined或null_抛TypeError而不是false_KNOWN_DEFECT", () => {
  assert.throws(() => isUniqueConstraintViolationOn(p2002(["customer_code"]), undefined), TypeError);
  assert.throws(() => isUniqueConstraintViolationOn(p2002(["customer_code"]), null), TypeError);
  // 但 target 拿不到时会先 return false，不会走到抛错那一步
  assert.equal(isUniqueConstraintViolationOn(p2002(undefined), undefined), false);
});

// ─────────────── 与真实消费方（CustomersService）的联合行为：不该重试就不写第二次 ───────────────

/** 手写假 Prisma：只实现 CustomersService.create 用到的 customer.findMany / customer.create。 */
function fakePrisma(options = {}) {
  const calls = { findMany: [], create: [] };
  return {
    calls,
    customer: {
      async findMany(args) {
        calls.findMany.push(args);
        // 默认把「已经写失败（撞唯一索引）的编码」当成库里已存在，模拟并发撞号后重算的场景。
        if (options.existingCodes) return options.existingCodes(calls);
        return calls.create.map((call) => ({ customerCode: call.data.customerCode }));
      },
      async create(args) {
        calls.create.push(args);
        const error = options.onCreate ? options.onCreate(calls.create.length, args) : null;
        if (error) throw error;
        return { id: `customer-${calls.create.length}`, ...args.data };
      },
    },
  };
}

function fakeAudit() {
  const records = [];
  return {
    records,
    create: (current) => ({ createdBy: current.id, updatedBy: current.id }),
    update: (current) => ({ updatedBy: current.id }),
    record: async (action) => { records.push(action); },
  };
}

function makeService(options) {
  const prisma = fakePrisma(options);
  const audit = fakeAudit();
  return { service: new CustomersService(prisma, audit), prisma, audit };
}

test("prisma-error.客户编码唯一冲突_自动编码重算新号并重试写入", async () => {
  const { service, prisma, audit } = makeService({ onCreate: (attempt) => (attempt === 1 ? p2002(["customer_code"]) : null) });
  const created = await service.create({ code_mode: "auto", name: "杭州伞业" }, user);
  assert.equal(prisma.calls.create.length, 2, "第一次撞号后必须重试一次");
  const [first, second] = prisma.calls.create.map((call) => call.data.customerCode);
  assert.notEqual(first, second, "重算必须换一个新号，不能拿同一个号再写一遍");
  assert.match(first, AUTO_CODE);
  assert.match(second, AUTO_CODE);
  assert.equal(first.endsWith("-0001"), true, "第一个号从 0001 开始");
  assert.equal(second.endsWith("-0002"), true, "重算在最大值 +1");
  assert.equal(prefixOf(second), prefixOf(first), "重算必须落在同一天的同一前缀里");
  assert.equal(created.customerCode, second);
  assert.deepEqual(prisma.calls.findMany[0], { where: { customerCode: { startsWith: prefixOf(first) } }, select: { customerCode: true } });
  assert.deepEqual(audit.records, ["customer.create"], "只有最终成功的那一次才留审计");
});

test("prisma-error.客户名称冲突_自动编码不重试且不产生第二次写入", async () => {
  // 名称也是唯一的，撞名称重试没有意义：必须只写一次，并给出客户冲突业务码。
  const { service, prisma, audit } = makeService({ onCreate: () => p2002(["name"]) });
  await assert.rejects(
    () => service.create({ code_mode: "auto", name: "杭州伞业" }, user),
    (error) => error instanceof ConflictException && error.getResponse().code === "CUSTOMER_CONFLICT",
  );
  assert.equal(prisma.calls.create.length, 1, "撞名称不得触发重算重写");
  assert.equal(audit.records.length, 0, "失败时不得留审计记录");
});

test("prisma-error.约束名写法且不是编码列_同样不重试（约束名带 customer_code 才算）", async () => {
  const { service, prisma } = makeService({ onCreate: () => p2002("customers_name_key") });
  await assert.rejects(
    () => service.create({ code_mode: "auto", name: "杭州伞业" }, user),
    (error) => error.getResponse().code === "CUSTOMER_CONFLICT",
  );
  assert.equal(prisma.calls.create.length, 1);
});

test("prisma-error.P2002拿不到target_不重试（保守策略不产生额外写入）", async () => {
  const { service, prisma } = makeService({ onCreate: () => p2002(undefined) });
  await assert.rejects(
    () => service.create({ code_mode: "auto", name: "杭州伞业" }, user),
    (error) => error instanceof ConflictException && error.getResponse().code === "CUSTOMER_CONFLICT",
  );
  assert.equal(prisma.calls.create.length, 1, "拿不到 target 时宁可不重试");
});

test("prisma-error.重试次数上限_自动编码最多写三次后抛业务冲突码", async () => {
  // 边界：attempt < 3 才 continue → 最多 3 次写入（1 次原始 + 2 次重算），第 3 次失败后转成 409。
  const { service, prisma, audit } = makeService({ onCreate: () => p2002(["customer_code"]) });
  await assert.rejects(
    () => service.create({ code_mode: "auto", name: "杭州伞业" }, user),
    (error) => error instanceof ConflictException && error.getResponse().code === "CUSTOMER_CONFLICT",
  );
  assert.equal(prisma.calls.create.length, 3, "重试上限 3 次，不能无限循环");
  const codes = prisma.calls.create.map((call) => call.data.customerCode);
  assert.deepEqual(codes.map((code) => AUTO_CODE.exec(code)[2]), ["0001", "0002", "0003"], "每次都重算递增的号");
  assert.equal(new Set(codes.map(prefixOf)).size, 1, "三次重算必须落在同一前缀里");
  assert.equal(audit.records.length, 0);
});

test("prisma-error.非P2002错误_不重试且原样上抛，不包装成业务冲突码", async () => {
  const original = new Error("foreign key constraint failed");
  original.code = "P2003";
  const { service, prisma, audit } = makeService({ onCreate: () => original });
  await assert.rejects(
    () => service.create({ code_mode: "auto", name: "杭州伞业" }, user),
    (error) => error === original && error.code === "P2003" && !(error instanceof ConflictException),
  );
  assert.equal(prisma.calls.create.length, 1, "非唯一冲突不得重试");
  assert.equal(audit.records.length, 0, "失败时不得留审计记录");
});

test("prisma-error.手动编码模式撞编码_不重试（只有自动编码才自愈）", async () => {
  const { service, prisma } = makeService({ onCreate: () => p2002(["customer_code"]) });
  await assert.rejects(
    () => service.create({ code_mode: "manual", customer_code: "CUS-MANUAL-0001", name: "手工客户" }, user),
    (error) => error instanceof ConflictException && error.getResponse().code === "CUSTOMER_CONFLICT",
  );
  assert.equal(prisma.calls.create.length, 1, "手填编码撞号是用户的问题，重试没有意义");
  assert.deepEqual(prisma.calls.findMany, [], "手动模式不该去算自动编码");
});

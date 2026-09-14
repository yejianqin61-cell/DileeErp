const assert = require("node:assert/strict");
const { test } = require("node:test");
const { validateEnvironment } = require("../../dist/platform/config/validate-environment.js");

// 启动期环境校验（app.module.ts:24 以 ConfigModule.forRoot({ validate: validateEnvironment }) 注入）。
//
// 本模块是纯函数，没有 Prisma / DI 依赖。因此本文件里「失败时不产生写入」的等价断言是：
//   (1) 非法输入必须抛错，而不是返回一个被部分填充的结果；
//   (2) 失败路径不得修改传入的 config 对象（无副作用）。
//
// 实现只有 9 行，但隐藏分支不少，全部按外部行为钉住：
//   - config.PORT ?? 3001 用「空值合并」而不是 ||，且后续走 Number() 强转；
//   - NODE_ENV 用严格等号比较，大小写敏感；
//   - DATABASE_URL 只校验「WHATWG URL 能否解析」，不校验 scheme / host 是否存在；
//   - 校验顺序是 PORT → 生产环境 DATABASE_URL 缺失 → DATABASE_URL 格式。
//
// 注意：本模块抛的是**普通 Error**，不是 Nest HttpException，
// 所以无法按仓库惯例断言 error.getResponse().code（见本文件最后一个用例），只能断言 error.message。

const PORT_ERROR = "PORT 必须是 1 到 65535 的整数";
const PRODUCTION_DATABASE_URL_ERROR = "生产环境必须配置 DATABASE_URL";
const DATABASE_URL_FORMAT_ERROR = "DATABASE_URL 格式无效";

/** 用精确 message 匹配抛出的普通 Error。 */
function errorWithMessage(message) {
  return (error) => error instanceof Error && error.message === message;
}

/** 反向用例统一断言：抛指定错误 + 不产生返回值 + 入参 config 未被修改。 */
function expectRejected(config, expectedMessage) {
  const before = structuredClone(config);
  let returned;
  let didReturn = false;
  assert.throws(
    () => {
      returned = validateEnvironment(config);
      didReturn = true;
    },
    errorWithMessage(expectedMessage),
  );
  assert.equal(didReturn, false, "非法输入不应产生返回值");
  assert.equal(returned, undefined, "非法输入不应返回部分结果");
  assert.deepEqual(config, before, "非法输入不应修改入参 config（等价于失败时不产生写入）");
}

// ---------------------------------------------------------------- 正常路径

test("validateEnvironment.port_missing_defaults_to_3001", async () => {
  const result = validateEnvironment({});
  assert.equal(result.PORT, 3001);
  assert.equal(typeof result.PORT, "number");
});

test("validateEnvironment.port_null_is_treated_as_missing_and_defaults_to_3001", async () => {
  // ?? 只对 null / undefined 回退，0 与 "" 不会被回退（见后续反向用例）。
  const result = validateEnvironment({ PORT: null });
  assert.equal(result.PORT, 3001);
});

test("validateEnvironment.port_string_number_is_coerced_to_number", async () => {
  const result = validateEnvironment({ PORT: "3001" });
  assert.equal(result.PORT, 3001);
  assert.equal(typeof result.PORT, "number");
});

test("validateEnvironment.port_range_boundaries_1_and_65535_are_accepted", async () => {
  assert.equal(validateEnvironment({ PORT: 1 }).PORT, 1);
  assert.equal(validateEnvironment({ PORT: 65535 }).PORT, 65535);
  assert.equal(validateEnvironment({ PORT: "1" }).PORT, 1);
  assert.equal(validateEnvironment({ PORT: "65535" }).PORT, 65535);
});

test("validateEnvironment.production_with_valid_database_url_is_accepted", async () => {
  const result = validateEnvironment({
    NODE_ENV: "production",
    PORT: "4000",
    DATABASE_URL: "postgresql://dilee:secret@db.internal:5432/dilee?schema=public",
  });
  assert.equal(result.NODE_ENV, "production");
  assert.equal(result.PORT, 4000);
  assert.equal(result.DATABASE_URL, "postgresql://dilee:secret@db.internal:5432/dilee?schema=public");
});

test("validateEnvironment.non_production_without_database_url_is_accepted", async () => {
  for (const NODE_ENV of [undefined, "development", "test", "staging"]) {
    const result = validateEnvironment(NODE_ENV === undefined ? {} : { NODE_ENV });
    assert.equal(result.PORT, 3001);
    assert.equal(result.NODE_ENV, NODE_ENV);
  }
});

test("validateEnvironment.database_url_accepts_postgres_and_mysql_urls", async () => {
  const urls = [
    "postgresql://user:pass@localhost:5432/dilee",
    "postgres://user@127.0.0.1:5432/dilee",
    "mysql://root@localhost:3306/dilee",
  ];
  for (const url of urls) {
    assert.equal(validateEnvironment({ DATABASE_URL: url }).DATABASE_URL, url);
  }
});

// ---------------------------------------------------------------- PORT 反向

test("validateEnvironment.port_zero_and_negative_are_rejected", async () => {
  expectRejected({ PORT: 0 }, PORT_ERROR);
  expectRejected({ PORT: -1 }, PORT_ERROR);
  expectRejected({ PORT: -3001 }, PORT_ERROR);
  expectRejected({ PORT: "0" }, PORT_ERROR);
  expectRejected({ PORT: "-1" }, PORT_ERROR);
});

test("validateEnvironment.port_above_65535_is_rejected", async () => {
  expectRejected({ PORT: 65536 }, PORT_ERROR);
  expectRejected({ PORT: "65536" }, PORT_ERROR);
  expectRejected({ PORT: 99999 }, PORT_ERROR);
  expectRejected({ PORT: Number.MAX_SAFE_INTEGER }, PORT_ERROR);
});

test("validateEnvironment.port_empty_and_blank_strings_are_rejected", async () => {
  // Number("") === 0、Number("   ") === 0，都落在 < 1 的分支。
  expectRejected({ PORT: "" }, PORT_ERROR);
  expectRejected({ PORT: " " }, PORT_ERROR);
  expectRejected({ PORT: "\t" }, PORT_ERROR);
});

test("validateEnvironment.port_non_numeric_strings_are_rejected", async () => {
  expectRejected({ PORT: "abc" }, PORT_ERROR);
  expectRejected({ PORT: "3001abc" }, PORT_ERROR);
  expectRejected({ PORT: "3,001" }, PORT_ERROR);
  expectRejected({ PORT: "port" }, PORT_ERROR);
});

test("validateEnvironment.port_fractions_are_rejected", async () => {
  expectRejected({ PORT: 3001.5 }, PORT_ERROR);
  expectRejected({ PORT: "3001.5" }, PORT_ERROR);
  expectRejected({ PORT: 0.5 }, PORT_ERROR);
});

test("validateEnvironment.port_nan_and_infinity_are_rejected", async () => {
  expectRejected({ PORT: NaN }, PORT_ERROR);
  expectRejected({ PORT: Infinity }, PORT_ERROR);
  expectRejected({ PORT: -Infinity }, PORT_ERROR);
});

test("validateEnvironment.port_objects_and_empty_arrays_are_rejected", async () => {
  expectRejected({ PORT: {} }, PORT_ERROR);
  expectRejected({ PORT: [] }, PORT_ERROR);
  expectRejected({ PORT: [1, 2] }, PORT_ERROR);
});

test("validateEnvironment.port_boolean_false_is_rejected", async () => {
  // false ?? 3001 → false（不触发默认值），Number(false) === 0。
  expectRejected({ PORT: false }, PORT_ERROR);
});

// ------------------------------------------------- PORT 强转的隐藏分支

test("validateEnvironment.port_boolean_true_coerces_to_1", async () => {
  // 隐藏分支：Number(true) === 1，仍在合法区间内 → 被接受并返回数字 1。
  const result = validateEnvironment({ PORT: true });
  assert.equal(result.PORT, 1);
  assert.equal(typeof result.PORT, "number");
});

test("validateEnvironment.port_hex_and_exponent_strings_are_accepted_as_numbers", async () => {
  // 隐藏分支：Number("0x10") === 16、Number("1e3") === 1000 —— 非十进制写法也会通过校验。
  assert.equal(validateEnvironment({ PORT: "0x10" }).PORT, 16);
  assert.equal(validateEnvironment({ PORT: "1e3" }).PORT, 1000);
  assert.equal(validateEnvironment({ PORT: "3001 " }).PORT, 3001); // 尾部空白被 Number 吞掉
});

test("validateEnvironment.port_single_element_array_and_bigint_coerce_to_numbers", async () => {
  // 隐藏分支：单元素数组与 BigInt 会被 Number() 强转（[3001] → 3001、3001n → 3001）。
  assert.equal(validateEnvironment({ PORT: [3001] }).PORT, 3001);
  const result = validateEnvironment({ PORT: 3001n });
  assert.equal(result.PORT, 3001);
  assert.equal(typeof result.PORT, "number");
});

// ------------------------------------------- 生产环境 DATABASE_URL 前置校验

test("validateEnvironment.production_without_database_url_is_rejected", async () => {
  expectRejected({ NODE_ENV: "production" }, PRODUCTION_DATABASE_URL_ERROR);
  expectRejected({ NODE_ENV: "production", PORT: 3001 }, PRODUCTION_DATABASE_URL_ERROR);
  expectRejected({ NODE_ENV: "production", DATABASE_URL: undefined }, PRODUCTION_DATABASE_URL_ERROR);
});

test("validateEnvironment.production_with_falsy_database_url_is_rejected", async () => {
  // 空串 / 0 / false 都是 falsy，会在「必须配置 DATABASE_URL」这一步就被拒。
  expectRejected({ NODE_ENV: "production", DATABASE_URL: "" }, PRODUCTION_DATABASE_URL_ERROR);
  expectRejected({ NODE_ENV: "production", DATABASE_URL: 0 }, PRODUCTION_DATABASE_URL_ERROR);
  expectRejected({ NODE_ENV: "production", DATABASE_URL: false }, PRODUCTION_DATABASE_URL_ERROR);
});

test("validateEnvironment.node_env_production_check_is_case_sensitive", async () => {
  // 隐藏分支：严格等号比较，"Production" / "PRODUCTION" / "prod" 都不算生产环境，
  // 因此缺少 DATABASE_URL 也不会报错。
  for (const NODE_ENV of ["Production", "PRODUCTION", "prod", "production "]) {
    assert.equal(validateEnvironment({ NODE_ENV }).PORT, 3001);
  }
});

test("validateEnvironment.port_error_precedes_production_database_url_error", async () => {
  // 顺序分支：PORT 校验先执行，两项都非法时抛的是 PORT 错误。
  expectRejected({ NODE_ENV: "production", PORT: 0 }, PORT_ERROR);
  expectRejected({ NODE_ENV: "production", PORT: "abc" }, PORT_ERROR);
});

test("validateEnvironment.malformed_database_url_reports_format_error_not_missing_error", async () => {
  // 顺序分支：DATABASE_URL 非空（truthy）→ 通过「必须配置」检查 → 落在格式错误。
  expectRejected({ NODE_ENV: "production", DATABASE_URL: "not-a-url" }, DATABASE_URL_FORMAT_ERROR);
  expectRejected({ NODE_ENV: "development", DATABASE_URL: "not-a-url" }, DATABASE_URL_FORMAT_ERROR);
});

// ------------------------------------------------------------- URL 格式校验

test("validateEnvironment.database_url_rejects_plain_text_values", async () => {
  const invalid = [
    "not-a-url",
    "postgresql//missing-colon",
    "://missing-scheme",
    "127.0.0.1:5432", // 形似主机端口，但没有 scheme → WHATWG 解析失败
    "http://", // 特殊 scheme 缺 host → 解析失败
    "   ",
  ];
  for (const DATABASE_URL of invalid) {
    expectRejected({ DATABASE_URL }, DATABASE_URL_FORMAT_ERROR);
  }
});

test("validateEnvironment.database_url_rejects_stringified_non_url_values", async () => {
  // 实现里是 String(value) 后交给 new URL()，所以 {}/123/true 都被 stringify 后判为非法。
  expectRejected({ DATABASE_URL: 123 }, DATABASE_URL_FORMAT_ERROR);
  expectRejected({ DATABASE_URL: true }, DATABASE_URL_FORMAT_ERROR);
  expectRejected({ DATABASE_URL: {} }, DATABASE_URL_FORMAT_ERROR);
  expectRejected({ DATABASE_URL: ["not-a-url"] }, DATABASE_URL_FORMAT_ERROR);
});

test("validateEnvironment.database_url_format_error_reports_no_database_misconfiguration_for_falsy_values", async () => {
  // 隐藏分支：falsy 的 DATABASE_URL 直接跳过格式校验（在非生产环境里静默通过）。
  const result = validateEnvironment({ NODE_ENV: "development", DATABASE_URL: "" });
  assert.equal(result.DATABASE_URL, "");
  assert.equal(result.PORT, 3001);
});

test("validateEnvironment.database_url_only_needs_to_be_parseable_by_whatwg_url", async () => {
  // 已知局限（非本文件要修的行为，仅钉住现状）：校验只管「能否被 new URL() 解析」，
  // 不限制 scheme，也不要求 host 存在。于是：
  //   "localhost:5432" 被当成 scheme=localhost 而通过；
  //   "file:///tmp/x" / "mailto:..." 这类非数据库 URL 同样通过；
  //   "postgres://"（空 host）也通过（"http://" 因特殊 scheme 规则反而被拒）。
  const accepted = [
    "localhost:5432",
    "file:///tmp/dilee.sqlite",
    "postgres://",
  ];
  for (const DATABASE_URL of accepted) {
    assert.equal(validateEnvironment({ DATABASE_URL }).DATABASE_URL, DATABASE_URL);
  }
  expectRejected({ DATABASE_URL: "http://" }, DATABASE_URL_FORMAT_ERROR);
  expectRejected({ DATABASE_URL: "abc" }, DATABASE_URL_FORMAT_ERROR);
});

// --------------------------------------------------------------- 返回值契约

test("validateEnvironment.returns_new_object_and_does_not_mutate_input", async () => {
  const input = { NODE_ENV: "development", PORT: "3001", DATABASE_URL: "postgresql://u:p@localhost:5432/d" };
  const result = validateEnvironment(input);
  assert.notEqual(result, input, "必须返回新对象");
  assert.deepEqual(Object.keys(result).sort(), Object.keys(input).sort());
  assert.equal(input.PORT, "3001", "入参 PORT 必须保持原样（未被原地改写）");
  assert.equal(typeof result.PORT, "number");
});

test("validateEnvironment.preserves_unrelated_config_keys", async () => {
  const result = validateEnvironment({
    PORT: 4000,
    NODE_ENV: "test",
    JWT_SECRET: "s",
    REDIS_URL: "redis://localhost:6379",
    EMPTY: "",
    ZERO: 0,
  });
  assert.equal(result.PORT, 4000);
  assert.equal(result.NODE_ENV, "test");
  assert.equal(result.JWT_SECRET, "s");
  assert.equal(result.REDIS_URL, "redis://localhost:6379");
  assert.equal(result.EMPTY, "");
  assert.equal(result.ZERO, 0);
});

test("validateEnvironment.always_returns_numeric_port_including_default", async () => {
  for (const config of [{}, { PORT: "3001" }, { PORT: 1 }, { PORT: "65535" }]) {
    const result = validateEnvironment(config);
    assert.equal(typeof result.PORT, "number");
    assert.ok(Number.isInteger(result.PORT));
    assert.ok(result.PORT >= 1 && result.PORT <= 65535);
  }
});

// ------------------------------------------------------- 契约外输入 / 错误类型

test("validateEnvironment.null_config_throws_type_error", async () => {
  // 契约外输入：类型签名是 Record<string, unknown>，传 null 会得到原生 TypeError
  // （不是友好的中文校验错误），属实现现状。
  assert.throws(() => validateEnvironment(null), TypeError);
  assert.throws(() => validateEnvironment(undefined), TypeError);
});

test("validateEnvironment.errors_are_plain_errors_without_nest_machine_code", async () => {
  // 本模块抛普通 Error，没有 Nest 异常的机器码，所以本文件只能断言 message。
  try {
    validateEnvironment({ PORT: 0 });
    assert.fail("应当抛错");
  } catch (error) {
    assert.equal(error.constructor, Error);
    assert.equal(error.message, PORT_ERROR);
    assert.equal(typeof error.getResponse, "undefined");
  }
});

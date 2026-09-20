// ValidationPipe 的 exceptionFactory（`platform/http/validation-exception.factory.ts`）单元测试。
//
// 由来：recon D10 记录的契约缺陷 —— 原实现只读顶层 `error.constraints`，而 `@ValidateNested()`
// 的错误挂在 `error.children` 上，于是「明细第 2 行数量填了 abc」返回的 `details` 是空数组，
// 前端只剩一句「请求参数校验失败」，四种可能的原因长得一模一样（现场就是这个症状：
// 新建销售单总是报校验失败，却指不出是哪一格）。
//
// 本文件钉住三件事：
//   1. 嵌套路径写得出来、写得对（数组下标用 `[n]`，对象属性用 `.`）；
//   2. 顶层字段的旧行为**一个字都不许变**（details[0].field / rule 是前端与 HTTP 契约测试的依赖）；
//   3. 一个节点同时有 constraint 又有 children 时两边都要报，不许互相吞。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ValidationPipe, BadRequestException } = require("@nestjs/common");
const { validationExceptionFactory, flattenValidationErrors } = require("../../dist/platform/http/validation-exception.factory.js");

/** class-validator 真实产出的形状就是普通对象（ValidationError 在 @nestjs/common 里只是类型）。 */
const node = (property, extra = {}) => ({ property, ...extra });

test("嵌套数组错误给出可定位路径：spec_details[0].quantity，而不是丢掉整条 details", () => {
  // 空格子（既没有 constraint 也没有 children）不产出任何错误。
  assert.deepEqual(flattenValidationErrors([node("spec_details", { children: [] })]), []);

  const tree = [node("spec_details", {
    children: [node("0", {
      children: [node("quantity", { constraints: { isDecimal: "quantity is not a valid decimal number.", matches: "明细数量必须是不小于 0 的十进制数" } })],
    })],
  })];
  assert.deepEqual(flattenValidationErrors(tree), [
    { field: "spec_details[0].quantity", rule: "isDecimal", message: "quantity is not a valid decimal number." },
    { field: "spec_details[0].quantity", rule: "matches", message: "明细数量必须是不小于 0 的十进制数" },
  ]);
});

test("多层嵌套与多个下标都能拼对：a.b[1].c 与 a.b[2].d", () => {
  const tree = [{
    property: "a",
    children: [{
      property: "b",
      children: [
        { property: "1", children: [{ property: "c", constraints: { isString: "c" } }] },
        { property: "2", children: [{ property: "d", constraints: { isInt: "d" } }] },
      ],
    }],
  }];
  assert.deepEqual(flattenValidationErrors(tree).map((item) => item.field), ["a.b[1].c", "a.b[2].d"]);
});

test("顶层字段的错误保持原样（HTTP 契约测试依赖 details[0].field === 'bogus'）", () => {
  const tree = [{ property: "bogus", constraints: { whitelistValidation: "property bogus should not exist" } }];
  assert.deepEqual(flattenValidationErrors(tree), [
    { field: "bogus", rule: "whitelistValidation", message: "property bogus should not exist" },
  ]);
});

test("一个节点同时有 constraint 与 children 时两边都报，不互相吞", () => {
  const tree = [{
    property: "items",
    constraints: { arrayMaxSize: "too many" },
    children: [{ property: "0", constraints: { isObject: "not an object" } }],
  }];
  assert.deepEqual(flattenValidationErrors(tree), [
    { field: "items", rule: "arrayMaxSize", message: "too many" },
    { field: "items[0]", rule: "isObject", message: "not an object" },
  ]);
});

test("exceptionFactory：信封形状固定为 { code, message, details }（ApiExceptionFilter 认这个形状）", () => {
  const exception = validationExceptionFactory([{ property: "page_size", constraints: { max: "page_size must not be greater than 200" } }]);
  assert.ok(exception instanceof BadRequestException);
  assert.equal(exception.getStatus(), 400);
  assert.deepEqual(exception.getResponse(), {
    code: "VALIDATION_ERROR",
    message: "请求参数校验失败",
    details: [{ field: "page_size", rule: "max", message: "page_size must not be greater than 200" }],
  });
});

test("端到端：真实 ValidationPipe + 真实工厂，嵌套明细的失败原因不再丢", async () => {
  // 用最小的本地 DTO 复刻「明细数组 + ValidateNested」的形状，避免依赖某个业务模块。
  const { Type } = require("class-transformer");
  const { IsArray, IsDecimal, IsNotEmpty, IsOptional, IsString, ValidateNested, Matches } = require("class-validator");
  class Line {
    constructor() { this.name = ""; this.quantity = ""; }
  }
  // 装饰器必须在类定义后立刻施加（这里手写元数据，避免依赖实验性语法）。
  IsNotEmpty()(Line.prototype, "name");
  IsOptional()(Line.prototype, "quantity");
  Matches(/^\d+(?:\.\d+)?$/)(Line.prototype, "quantity");
  IsDecimal()(Line.prototype, "quantity");
  class Body {
    constructor() { this.lines = []; }
  }
  IsArray()(Body.prototype, "lines");
  ValidateNested({ each: true })(Body.prototype, "lines");
  Type(() => Line)(Body.prototype, "lines");

  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true, exceptionFactory: validationExceptionFactory });
  await assert.rejects(
    () => pipe.transform({ lines: [{ name: "伞布", quantity: "abc" }] }, { type: "body", metatype: Body }),
    (error) => {
      const response = error.getResponse();
      assert.equal(response.code, "VALIDATION_ERROR");
      assert.ok(response.details.length >= 1, "嵌套字段的错误必须出现在 details 里");
      assert.equal(response.details[0].field, "lines[0].quantity");
      return true;
    },
  );
});

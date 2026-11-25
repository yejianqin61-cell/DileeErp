const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseGapDeclaration } = require("../../dist/modules/business-query-agent/tools/report-gap.js");
const { GAP_TOOL, DECLARE_GAP_OPERATION } = require("../../dist/modules/business-query-agent/tools/tool-registry.js");

const QUESTION = "各仓库库存多少";
const VALID = { nearest_operation: "list_low_stock_materials", missing: "group_by", missing_detail: " 按仓库分组 " };

function rejects(args, ...fragments) {
  assert.throws(
    () => parseGapDeclaration(args, QUESTION),
    (error) => {
      const body = error.getResponse();
      assert.equal(error.getStatus(), 422);
      assert.equal(body.code, "AGENT_GAP_ARGUMENT_INVALID");
      for (const fragment of fragments) assert.ok(body.message.includes(fragment), `${body.message} 应含 ${fragment}`);
      return true;
    },
  );
}

test("合法声明：去空白，needed_fields 默认空，不带 missing_param 键", () => {
  assert.equal(GAP_TOOL, "report_gap");
  assert.equal(DECLARE_GAP_OPERATION, "declare_gap");
  assert.deepEqual(parseGapDeclaration(VALID, QUESTION), { nearest_operation: "list_low_stock_materials", missing: "group_by", missing_detail: "按仓库分组", needed_fields: [] });
});

test("缺任一必填字段：点名字段", () => {
  for (const key of ["nearest_operation", "missing", "missing_detail"]) {
    const args = { ...VALID };
    delete args[key];
    rejects(args, key);
  }
});

test("枚举外的值：列出全部合法值", () => {
  rejects({ ...VALID, missing: "sort" }, "missing", "group_by、filter、metric、time_series、object");
  rejects({ ...VALID, missing_param: "page" }, "missing_param", "q、status、customer_q、product_q、from、to");
});

test("合法的 missing_param 与 needed_fields 原样带出", () => {
  const parsed = parseGapDeclaration({ ...VALID, missing_param: "status", needed_fields: ["A.b"] }, QUESTION);
  assert.equal(parsed.missing_param, "status");
  assert.deepEqual(parsed.needed_fields, ["A.b"]);
});

test("短语不得含整句原话，长度 1–200", () => {
  rejects({ ...VALID, missing_detail: "请问各仓库库存多少呢" }, "missing_detail");
  rejects({ ...VALID, missing_detail: "长".repeat(201) }, "missing_detail");
  rejects({ ...VALID, missing_detail: "   " }, "missing_detail");
  assert.equal(parseGapDeclaration({ ...VALID, missing_detail: "长".repeat(200) }, QUESTION).missing_detail.length, 200);
});

test("needed_fields 至多 20 项，每项 1–100 字", () => {
  rejects({ ...VALID, needed_fields: "A.b" }, "needed_fields");
  rejects({ ...VALID, needed_fields: Array(21).fill("A.b") }, "needed_fields");
  rejects({ ...VALID, needed_fields: [""] }, "needed_fields");
  rejects({ ...VALID, needed_fields: ["x".repeat(101)] }, "needed_fields");
});

test("未知键拒绝，operation 键忽略", () => {
  rejects({ ...VALID, question: "x" }, "question");
  assert.equal("operation" in parseGapDeclaration({ ...VALID, operation: "declare_gap" }, QUESTION), false);
});

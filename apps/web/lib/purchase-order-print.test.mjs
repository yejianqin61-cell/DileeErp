// 采购单「打印信息」口径的单元测试（纯函数，`node --test` + `node:assert`，与其它 lib 测试一致）。
//
// 用户 2026-09-16：「付款方式，有月结30天，月结60天，当月付款」+「系统中采购单也要支持对这些字段
// 进行填写和设置」。这里推演的是**容易被写错、且写错就很难被发现**的三件事：
//   1. 下拉的哨兵值（Radix Select 不接受空串）必须在提交前换回空串 ——
//      空串在服务端表示「清除这一格」，而 undefined 表示「这一格不要动」；
//   2. 已有值不在三项里时（手填、或以后加过项）要照样列出来，否则打开弹窗看到空白下拉，
//      用户会以为自己填的付款方式丢了；
//   3. 交货日期空 → 提交 null（日期列），不是空串（空串对 @IsDateString 是校验失败）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  PAYMENT_TERM_CLEAR,
  PURCHASE_PAYMENT_TERMS,
  paymentTermOptions,
  paymentTermPayload,
  paymentTermValue,
  printFieldsDefaults,
  printFieldsPayload,
} from "./purchase-order-print.ts";

// ---------- 付款方式：三项固定 + 可清空 ----------

test("付款方式：选项是「不填 + 业务给的三项」，一字不差", () => {
  assert.deepEqual([...PURCHASE_PAYMENT_TERMS], ["月结30天", "月结60天", "当月付款"]);
  assert.deepEqual(paymentTermOptions().map((option) => option.value), [PAYMENT_TERM_CLEAR, "月结30天", "月结60天", "当月付款"]);
  assert.equal(paymentTermOptions()[0].label, "（不填）");
});

test("付款方式：已有值不在三项里时照样列出来（标注当前值），不静默丢掉", () => {
  const options = paymentTermOptions("月结90天");
  assert.deepEqual(options.map((option) => option.value), [PAYMENT_TERM_CLEAR, "月结30天", "月结60天", "当月付款", "月结90天"]);
  assert.equal(options[4].label, "月结90天（当前值）");
});

test("付款方式：三项里的值不重复列（不出现多余的「当前值」项）", () => {
  assert.deepEqual(paymentTermOptions("月结60天").map((option) => option.value), [PAYMENT_TERM_CLEAR, "月结30天", "月结60天", "当月付款"]);
});

test("付款方式：值 → 下拉值，空 / 全空白 / null / undefined 都落到哨兵", () => {
  assert.equal(paymentTermValue("月结30天"), "月结30天");
  assert.equal(paymentTermValue(""), PAYMENT_TERM_CLEAR);
  assert.equal(paymentTermValue("   "), PAYMENT_TERM_CLEAR);
  assert.equal(paymentTermValue(null), PAYMENT_TERM_CLEAR);
  assert.equal(paymentTermValue(undefined), PAYMENT_TERM_CLEAR);
});

test("付款方式：下拉值 → 提交值，哨兵还原成空串（= 清除这一格）", () => {
  assert.equal(paymentTermPayload(PAYMENT_TERM_CLEAR), "");
  assert.equal(paymentTermPayload(undefined), "");
  assert.equal(paymentTermPayload(""), "");
  assert.equal(paymentTermPayload("当月付款"), "当月付款");
  assert.equal(paymentTermPayload(" 月结30天 "), "月结30天");
});

// ---------- 请求体 ----------

test("打印信息请求体：8 个键齐全，未填的文本发空串而不是 undefined", () => {
  const payload = printFieldsPayload({ payment_terms: PAYMENT_TERM_CLEAR });
  assert.deepEqual(Object.keys(payload).sort(), [
    "delivery_address",
    "delivery_terms",
    "expected_date",
    "payment_terms",
    "remark",
    "supervisor_signature",
    "supplier_reply",
    "supplier_signed",
  ]);
  // 界面没有的键一律空串：PATCH 是白名单校验，多一个键就 400；少一个键则「这一格没动」
  for (const key of ["delivery_terms", "delivery_address", "supplier_reply", "supplier_signed", "supervisor_signature", "remark"]) {
    assert.equal(payload[key], "", `${key} 未填时应发空串（服务端据此清除）`);
  }
  assert.equal(payload.payment_terms, "");
});

test("打印信息请求体：交货日期空 → null（日期列），有值原样带日期", () => {
  assert.equal(printFieldsPayload({ expected_date: "" }).expected_date, null);
  assert.equal(printFieldsPayload({ expected_date: "   " }).expected_date, null);
  assert.equal(printFieldsPayload({}).expected_date, null);
  assert.equal(printFieldsPayload({ expected_date: "2026-09-25" }).expected_date, "2026-09-25");
});

test("打印信息请求体：填了的值原样提交（文本不做 trim：交期条款里的空格是排版）", () => {
  const payload = printFieldsPayload({
    payment_terms: "月结60天",
    delivery_terms: " 合同签订后 15 天内交货 ",
    delivery_address: "柯桥区迪礼厂区",
    expected_date: "2026-09-25",
    remark: "含税价",
    supplier_reply: "同意",
    supplier_signed: "李经理 2026-09-12",
    supervisor_signature: "钱主管",
  });
  assert.deepEqual(payload, {
    payment_terms: "月结60天",
    delivery_terms: " 合同签订后 15 天内交货 ",
    delivery_address: "柯桥区迪礼厂区",
    expected_date: "2026-09-25",
    remark: "含税价",
    supplier_reply: "同意",
    supplier_signed: "李经理 2026-09-12",
    supervisor_signature: "钱主管",
  });
});

// ---------- 弹窗初值 ----------

test("弹窗初值：有值时原样带出，日期只取到天", () => {
  assert.deepEqual(printFieldsDefaults({
    paymentTerms: "月结30天",
    deliveryTerms: "分批交货",
    deliveryAddress: "厂区 1 号仓",
    expectedDate: "2026-09-25T00:00:00.000Z",
    remark: "含税价",
    supplierReply: "同意",
    supplierSigned: "李经理",
    supervisorSignature: "钱主管",
  }), {
    payment_terms: "月结30天",
    delivery_terms: "分批交货",
    delivery_address: "厂区 1 号仓",
    expected_date: "2026-09-25",
    remark: "含税价",
    supplier_reply: "同意",
    supplier_signed: "李经理",
    supervisor_signature: "钱主管",
  });
});

test("弹窗初值：全空（历史采购单）时文本空串、付款方式落哨兵、日期空串", () => {
  assert.deepEqual(printFieldsDefaults({}), {
    payment_terms: PAYMENT_TERM_CLEAR,
    delivery_terms: "",
    delivery_address: "",
    expected_date: "",
    remark: "",
    supplier_reply: "",
    supplier_signed: "",
    supervisor_signature: "",
  });
});

test("弹窗初值直接提交 = 原样写回（打开就保存不会把已有值清掉）", () => {
  const source = { paymentTerms: "月结60天", deliveryAddress: "厂区", supplierSigned: "李经理", expectedDate: "2026-09-25T00:00:00.000Z" };
  const payload = printFieldsPayload(printFieldsDefaults(source));
  assert.equal(payload.payment_terms, "月结60天");
  assert.equal(payload.delivery_address, "厂区");
  assert.equal(payload.supplier_signed, "李经理");
  assert.equal(payload.expected_date, "2026-09-25");
});

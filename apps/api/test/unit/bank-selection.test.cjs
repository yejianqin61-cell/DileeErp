// 银行账户取用助手的单元测试（不连数据库）。
//
// 为什么值得单独测：所有写 bank_id 的路径（收款/付款/应收对账/应付对账）都经过 requireActiveBank，
// 而它守的是一条**外键拦不住**的规则 —— 停用的账户仍在库里，FK 照样通过。
// 只靠前端下拉过滤也不够：接口可以被直接调用。所以「未停用」必须在这里挡住。
const assert = require("node:assert/strict");
const test = require("node:test");
const { requireActiveBank } = require("../../dist/modules/finance/bank-selection.js");

/** 记账式 reader：记录每次查询条件，便于断言过滤条件本身（而不只是结果）。 */
function reader(bank) {
  const calls = [];
  return {
    calls,
    client: { bank: { findFirst: async (args) => { calls.push(args); return bank; } } },
  };
}

const bankRow = { id: "bank-1", bankName: "中国农业银行", accountNumber: "4039 0001 0400 45706" };

test("不选银行是合法输入：未传 / null / 空串 / 纯空白都返回 null 且不查库", async () => {
  for (const value of [undefined, null, "", "   "]) {
    const { client, calls } = reader(bankRow);
    assert.equal(await requireActiveBank(client, value), null, `${JSON.stringify(value)} 应视为不选银行`);
    assert.equal(calls.length, 0, "不选银行时不应产生查询");
  }
});

test("选中可用账户时返回 id/名称/账号，并把 id 去空格", async () => {
  const { client, calls } = reader(bankRow);
  assert.deepEqual(await requireActiveBank(client, "  bank-1  "), bankRow);
  assert.equal(calls[0].where.id, "bank-1", "id 必须去空格后再查（否则 frontend 尾随空格会查不到）");
});

test("查询条件必须同时带 deletedAt=null 与 isActive=true（停用账户不能仅靠 FK 拦住）", async () => {
  const { client, calls } = reader(bankRow);
  await requireActiveBank(client, "bank-1");
  assert.deepEqual(calls[0].where, { id: "bank-1", deletedAt: null, isActive: true });
  assert.deepEqual(calls[0].select, { id: true, bankName: true, accountNumber: true });
});

test("账户不存在或已停用时抛 404 BANK_NOT_FOUND，绝不返回半个引用", async () => {
  const { client } = reader(null);
  await assert.rejects(
    () => requireActiveBank(client, "bank-missing"),
    (error) => error.getResponse().code === "BANK_NOT_FOUND" && error.getStatus() === 404,
  );
});

test("错误信息可定制：付款侧与对账侧要能给出各自的措辞", async () => {
  const { client } = reader(null);
  await assert.rejects(
    () => requireActiveBank(client, "bank-missing", "到账银行不存在或已停用"),
    (error) => error.getResponse().message === "到账银行不存在或已停用",
  );
});

test("可以在事务客户端上使用（入参只要求有 bank.findFirst）", async () => {
  const seen = [];
  const tx = { bank: { findFirst: async (args) => { seen.push(args); return bankRow; } } };
  assert.deepEqual(await requireActiveBank(tx, "bank-1"), bankRow);
  assert.equal(seen.length, 1);
});

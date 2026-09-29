// 收/付款单**存档**服务的测试（用户 2026-09-26：「付款单要有填写汇率的地方，保存键」）。
//
// 这一层要钉死的是「保存」这件事本身的四条边界：
//   ① **保存不改账**：只动 `finance_slips` / `finance_slip_lines` 两张表，不碰流水、凭证、应付状态
//      （写错了就是「存了一张付款单，应付自己变成已付」这种没人能解释的账）；
//   ② **门槛低一档**：编号、对方单位、借贷平衡都还不要求（财务改到一半要能存下来），
//      但结构坏了（日期、汇率格式、金额格式）连存都存不进去；
//   ③ **第二次保存是覆盖同一张**（带 id 走 update），否则点两次就得到两张一样的单子；
//   ④ 货币与「空」的写法：汇率 / 折合人民币 / 行金额留空存 **NULL**（空 ≠ 0 ≠ ""）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { FinanceSlipStoreService } = require("../../dist/modules/finance/finance-slip-store.service.js");

const USER = { id: "user-1", display_name: "小叶" };

const SLIP = {
  kind: "payment",
  slip_no: "FK-202609-001",
  slip_date: "2026-09-26",
  slip_method: "银行转账",
  counterparty_name: "富雨鑫",
  our_bank_name: "中国银行",
  our_bank_account: "7624",
  counterparty_bank_name: "中国农业银行",
  counterparty_bank_account: "4039 0001 0400 45706",
  currency: "USD",
  exchange_rate: "7.12345678",
  amount_cny: "1064.44",
  attachment_count: 1,
  remark: "月结 30 天",
  maker: "小叶",
  lines: [
    { summary: "支付富雨鑫材料款", general_subject: "原材料", detail_subject: "", debit: "149.50", credit: "", remark: "" },
    { summary: "支付富雨鑫款项合计", general_subject: "银行存款", detail_subject: "中国银行", debit: "", credit: "149.50", remark: "" },
  ],
};

/** 内存替身：够这一层用（findMany / count / findFirst / create / update / deleteMany + $transaction）。 */
function harness({ rows = [] } = {}) {
  const store = [...rows];
  const deletedLines = [];
  const calls = { created: [], updated: [], lineDeletes: 0 };
  const line = (index, data) => ({ id: `line-${index + 1}`, ...data });
  const tx = {
    financeSlip: {
      findFirst: async ({ where }) => store.find((row) => row.id === where.id && (where.deletedAt === null ? row.deletedAt === null : true)) ?? null,
      create: async ({ data }) => {
        calls.created.push(data);
        const row = {
          id: `slip-${store.length + 1}`, createdAt: new Date("2026-09-26T02:00:00.000Z"), updatedAt: new Date("2026-09-26T02:00:00.000Z"),
          deletedAt: null, sourceEntryIds: data.sourceEntryIds ?? null, ...data,
          lines: (data.lines?.create ?? []).map(line),
        };
        store.push(row);
        return row;
      },
      update: async ({ where, data }) => {
        calls.updated.push(data);
        const index = store.findIndex((row) => row.id === where.id);
        // 覆盖保存：新行替换旧行（与 SQL 里的 deleteMany + create 同一语义）。
        const row = { ...store[index], ...data, lines: (data.lines?.create ?? []).map(line), updatedAt: new Date("2026-09-26T03:00:00.000Z") };
        store[index] = row;
        return row;
      },
    },
    financeSlipLine: { deleteMany: async ({ where }) => { calls.lineDeletes += 1; deletedLines.push(where.slipId); return { count: 0 }; } },
  };
  const prisma = {
    financeSlip: {
      findMany: async ({ skip = 0, take = 20 }) => store.filter((row) => row.deletedAt === null).slice(skip, skip + take),
      count: async () => store.filter((row) => row.deletedAt === null).length,
      findFirst: async ({ where }) => store.find((row) => row.id === where.id && row.deletedAt === null) ?? null,
      update: async ({ where, data }) => {
        const index = store.findIndex((row) => row.id === where.id);
        store[index] = { ...store[index], ...data };
        return store[index];
      },
    },
    $transaction: async (run) => run(tx),
  };
  const events = [];
  const audit = { record: async (...args) => events.push(args), create: (user) => ({ createdBy: user.id, updatedBy: user.id }), update: (user) => ({ updatedBy: user.id }), softDelete: (user) => ({ deletedAt: new Date("2026-09-26T04:00:00.000Z"), deletedBy: user.id, updatedBy: user.id }) };
  return { service: new FinanceSlipStoreService(prisma, audit), store, calls, events, deletedLines };
}

test("存档：新建一张单子——表头、分录行序与金额落库，汇率/折合人民币按列存，审计记一条", async () => {
  const { service, calls, events } = harness();
  const saved = await service.save(SLIP, ["entry-1", "entry-2"], USER);

  assert.equal(saved.id, "slip-1");
  assert.equal(saved.slip_no, "FK-202609-001");
  assert.equal(saved.exchange_rate, "7.12345678");
  assert.equal(saved.amount_cny, "1064.44");
  assert.deepEqual(saved.source_entry_ids, ["entry-1", "entry-2"]);
  assert.equal(saved.lines.length, 2);
  // 行号从 1 开始，且**按传入顺序**（行序就是单子印出来的样子）。
  assert.deepEqual(calls.created[0].lines.create.map((row) => row.lineNo), [1, 2]);
  assert.equal(calls.created[0].lines.create[0].debit, "149.50");
  assert.equal(calls.created[0].lines.create[0].credit, null, "贷方没填就是 NULL（空 ≠ 0）");
  assert.equal(calls.created[0].slipDate.toISOString(), "2026-09-26T00:00:00.000Z", "DATE 列存 UTC 零点，读回来才不差一天");
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "payment_slip.save");
  assert.equal(events[0][4].created, true);
  assert.equal(events[0][4].amount, "149.5", "审计里的金额是这张单子的借方合计");
});

test("存档：人民币付款的汇率与折合人民币存 NULL（留空不是 0，也不是空串）", async () => {
  const { service, calls } = harness();
  const saved = await service.save({ ...SLIP, currency: "CNY", exchange_rate: "", amount_cny: "" }, undefined, USER);
  assert.equal(saved.exchange_rate, "", "读回来是空串（界面上的一格空白）");
  assert.equal(saved.amount_cny, "");
  assert.equal(calls.created[0].exchangeRate, null);
  assert.equal(calls.created[0].amountCny, null);
  assert.equal(calls.created[0].sourceEntryIds, undefined, "没传勾选就不写这一列（不是写一个空数组）");
});

test("存档：保存只拦结构——不平、没编号、没对方单位都存得下来", async () => {
  const { service } = harness();
  const half = await service.save({ ...SLIP, slip_no: "", counterparty_name: "", lines: [SLIP.lines[0]] }, undefined, USER);
  assert.equal(half.slip_no, "", "改到一半就该能存（用户要的正是「保存键」）");

  // 结构坏了必须 422，并且一次把问题说完。
  await assert.rejects(
    () => service.save({ ...SLIP, slip_date: "2026/09/26", exchange_rate: "abc" }, undefined, USER),
    (error) => {
      assert.equal(error.getStatus(), 422);
      const body = error.getResponse();
      assert.equal(body.code, "SLIP_DATE_INVALID");
      assert.equal(body.message.includes("汇率"), true);
      return true;
    },
  );
});

test("存档：带 id 保存是**覆盖同一张**（整组分录行重写），并把 created 记为 false", async () => {
  const { service, calls, events, deletedLines } = harness({
    rows: [{ id: "slip-9", slipNo: "FK-1", slipDate: new Date("2026-09-26T00:00:00.000Z"), slipMethod: "", counterpartyName: "富雨鑫", currency: "CNY", exchangeRate: null, amountCny: null, ourBankName: "", ourBankAccount: "", counterpartyBankName: "", counterpartyBankAccount: "", attachmentCount: 1, remark: "", maker: "", sourceEntryIds: null, createdAt: new Date(), updatedAt: new Date(), deletedAt: null, lines: [] }],
  });
  await service.save({ ...SLIP, remark: "改成月结 60 天" }, undefined, USER, "slip-9");
  assert.equal(calls.created.length, 0, "带 id 就不该再新建一张");
  assert.equal(calls.lineDeletes, 1, "分录行整组重写（行号必须与单子上的第 N 行一致，逐行 diff 会错位）");
  assert.deepEqual(deletedLines, ["slip-9"]);
  assert.equal(events[0][4].created, false);

  // 覆盖一张不存在的 / 已作废的单子：404，而不是静默新建。
  await assert.rejects(
    () => service.save(SLIP, undefined, USER, "slip-404"),
    (error) => error.getStatus() === 404 && error.getResponse().code === "FINANCE_SLIP_NOT_FOUND",
  );
});

test("存档：列表只回没作废的，分页元信息带上总数；分页下推到 SQL", async () => {
  const rows = Array.from({ length: 3 }, (_, index) => ({
    id: `slip-${index + 1}`, kind: "payment", slipNo: `FK-${index + 1}`, slipDate: new Date("2026-09-2" + (index + 1) + "T00:00:00.000Z"),
    slipMethod: "银行转账", counterpartyName: "富雨鑫", currency: "CNY", exchangeRate: null, amountCny: null,
    ourBankName: "", ourBankAccount: "", counterpartyBankName: "", counterpartyBankAccount: "",
    attachmentCount: 1, remark: "", maker: "小叶", sourceEntryIds: ["entry-1"], createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    lines: [{ summary: "借", generalSubject: "原材料", detailSubject: "", debit: "100", credit: null, remark: "" }],
  }));
  const { service } = harness({ rows });
  const page = await service.list({ kind: "payment", page: 2, pageSize: 2 });
  assert.equal(page.meta.total, 3);
  assert.equal(page.meta.page, 2);
  assert.equal(page.data.length, 1, "第 2 页只剩 1 条（分页在 SQL 里做，不是全量读回来再切）");
  assert.equal(page.data[0].slip_date, "2026-09-23", "日期读回来只取 YYYY-MM-DD");
  assert.deepEqual(page.data[0].source_entry_ids, ["entry-1"]);
});

test("存档：作废（逻辑删除）要求原因，且不物理删除；已作废的再删是 404", async () => {
  const { service, store, events } = harness({ rows: [{ id: "slip-1", kind: "receipt", slipNo: "SK-1", counterpartyName: "香港迪礼", deletedAt: null }] });
  await assert.rejects(
    () => service.remove("slip-1", "   ", USER),
    (error) => error.getStatus() === 422 && error.getResponse().code === "FINANCE_SLIP_DELETE_REASON_REQUIRED",
  );
  await service.remove("slip-1", "对方单位填错了", USER);
  assert.equal(store[0].deletedAt instanceof Date, true, "逻辑删除：数据库里仍然有这一行");
  assert.equal(events[0][0], "receipt_slip.delete", "审计的动作跟着单据种类走");
  assert.equal(events[0][4].reason, "对方单位填错了");
  await assert.rejects(() => service.remove("slip-1", "再删一次", USER), (error) => error.getStatus() === 404);
});

test("存档：取一张已作废的单子按 404（软删就是「作废了」，不是「还看得到」）", async () => {
  const { service } = harness({ rows: [{ id: "slip-1", deletedAt: new Date() }] });
  await assert.rejects(() => service.get("slip-1"), (error) => error.getStatus() === 404);
});

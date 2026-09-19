// 「响应出口统一补操作人姓名」的单元测试（不连数据库）。
//
// 生产文件：apps/api/src/platform/audit/audit-actor.interceptor.ts（在 main.ts 里全局注册）
//
// 为什么这个拦截器值得单独一组护栏：
//   它是**全站唯一**把 createdBy/updatedBy 变成姓名的位置。它错一点，全站列表的
//   「创建人 / 最后修改人」就一起错；它抛一次异常，本来正常的业务请求就跟着 500。
//   所以本文件除了正向用例，重点在边界：空数据、没有审计字段的行、二进制、
//   已经补过的行（幂等）、子对象（不该动）、以及「解析失败不能连累接口」。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AuditActorInterceptor } = require("../../dist/platform/audit/audit-actor.interceptor.js");
const { AuditActorService } = require("../../dist/platform/audit/audit-actor.service.js");

const USERS = [
  { id: "u-1", displayName: "张三" },
  { id: "u-2", displayName: "李四" }
];

/** 假 Prisma：只实现 user.findMany，并记录调用次数。 */
function makeActors(users = USERS) {
  const calls = [];
  const prisma = { user: { findMany: async (args) => { calls.push(args); const ids = args?.where?.id?.in ?? []; return users.filter((user) => ids.includes(user.id)); } } };
  return { actors: new AuditActorService(prisma), calls };
}

const envelope = (data, meta = {}) => ({ data, meta });

test("信封形态：data 数组里的每一行都补上姓名，meta 原样保留", async () => {
  const { actors, calls } = makeActors();
  const rows = [
    { id: "po-1", purchaseOrderNo: "PO-1", createdBy: "u-1", updatedBy: "u-2" },
    { id: "po-2", purchaseOrderNo: "PO-2", createdBy: "u-2", updatedBy: "u-1" }
  ];
  const result = await new AuditActorInterceptor(actors).enrich(envelope(rows, { page: 1, total: 2 }));
  assert.equal(result.data[0].created_by_name, "张三");
  assert.equal(result.data[0].updated_by_name, "李四");
  assert.equal(result.data[1].created_by_name, "李四");
  assert.deepEqual(result.meta, { page: 1, total: 2 }, "meta 不得被改动");
  assert.equal(calls.length, 1, "整页只查一次用户表");
  // 原来的 UUID 字段保留（导出/审计还要用），只是多了姓名
  assert.equal(result.data[0].createdBy, "u-1");
});

test("裸数组与单个对象（详情）都认", async () => {
  const { actors } = makeActors();
  const list = await new AuditActorInterceptor(actors).enrich([{ id: "x", createdBy: "u-1", updatedBy: null }]);
  assert.equal(list[0].created_by_name, "张三");
  assert.equal(list[0].updated_by_name, null);

  const detail = await new AuditActorInterceptor(actors).enrich({ id: "y", purchaseOrderNo: "PO-9", createdBy: "u-2", updatedBy: "u-2" });
  assert.equal(detail.created_by_name, "李四");
  assert.equal(detail.purchaseOrderNo, "PO-9");
});

test("查无此人补 null，绝不回落到 UUID（凭证纸上的「制单：6f3a…」就是这么来的）", async () => {
  const { actors } = makeActors();
  const result = await new AuditActorInterceptor(actors).enrich([{ id: "x", createdBy: "u-deleted", updatedBy: "u-1" }]);
  assert.equal(result[0].created_by_name, null);
  assert.equal(result[0].updated_by_name, "张三");
  assert.notEqual(result[0].created_by_name, "u-deleted");
});

test("没有操作人字段的行（报表/聚合/纯业务对象）原样返回，且不查库", async () => {
  const { actors, calls } = makeActors();
  const interpreter = new AuditActorInterceptor(actors);
  const rows = [{ id: "r-1", order_no: "SO-1", quantity: "10.0000" }, { id: "r-2", order_no: "SO-2" }];
  const result = await interpreter.enrich(envelope(rows));
  assert.deepEqual(result.data, rows);
  assert.equal(calls.length, 0, "没有任何候选行时不应该白跑一次查询");
});

test("空数据、null、字符串、二进制都不炸（Excel 导出与空列表）", async () => {
  const { actors, calls } = makeActors();
  const interpreter = new AuditActorInterceptor(actors);
  assert.deepEqual(await interpreter.enrich(envelope([])), { data: [], meta: {} });
  assert.deepEqual(await interpreter.enrich(envelope(null)), { data: null, meta: {} });
  assert.equal(await interpreter.enrich("ok"), "ok");
  const buffer = Buffer.from("PK\u0003\u0004xlsx");
  assert.equal(await interpreter.enrich(buffer), buffer, "二进制原样返回");
  assert.deepEqual(await interpreter.enrich(envelope([1, "a", null])), { data: [1, "a", null], meta: {} });
  assert.equal(calls.length, 0);
});

test("只处理顶层行：include 出来的子对象不动（子行与父行同源，展示层不需要）", async () => {
  const { actors } = makeActors();
  const result = await new AuditActorInterceptor(actors).enrich([
    { id: "po-1", createdBy: "u-1", updatedBy: "u-1", items: [{ id: "item-1", createdBy: "u-2", updatedBy: "u-2" }] }
  ]);
  assert.equal(result[0].created_by_name, "张三");
  assert.equal(result[0].items[0].created_by_name, undefined, "子行不补名字");
  assert.equal(result[0].items[0].createdBy, "u-2", "子行原样保留");
});

test("幂等：已经补过姓名的行跳过，不再查库", async () => {
  const { actors, calls } = makeActors();
  const rows = [{ id: "po-1", createdBy: "u-1", updatedBy: "u-2", created_by_name: "张三", updated_by_name: "李四" }];
  const result = await new AuditActorInterceptor(actors).enrich(envelope(rows));
  assert.equal(result.data[0].created_by_name, "张三");
  assert.equal(calls.length, 0);
});

test("混排：只有候补行查库，非候补行原样混在结果里且顺序不变", async () => {
  const { actors, calls } = makeActors();
  const rows = [{ id: "a", total: "1" }, { id: "b", createdBy: "u-1", updatedBy: "u-1" }, { id: "c", total: "3" }];
  const result = await new AuditActorInterceptor(actors).enrich(envelope(rows));
  assert.deepEqual(result.data.map((row) => row.id), ["a", "b", "c"]);
  assert.equal(result.data[0].created_by_name, undefined);
  assert.equal(result.data[1].created_by_name, "张三");
  assert.equal(calls.length, 1);
});

test("解析失败不连累接口：原样返回，不抛异常", async () => {
  const broken = { namesOf: async () => { throw new Error("数据库抖了一下"); } };
  const rows = [{ id: "po-1", createdBy: "u-1", updatedBy: "u-1" }];
  const result = await new AuditActorInterceptor(broken).enrich(envelope(rows));
  assert.deepEqual(result.data, rows, "补名字失败时宁可少两列，也不能让业务请求 500");
});

test("日期与类数组对象不会被误判成业务行", async () => {
  const { actors, calls } = makeActors();
  const interpreter = new AuditActorInterceptor(actors);
  const when = new Date("2026-09-16T00:00:00.000Z");
  assert.equal(await interpreter.enrich(when), when);
  assert.deepEqual(await interpreter.enrich(envelope([when])), { data: [when], meta: {} });
  assert.equal(calls.length, 0);
});

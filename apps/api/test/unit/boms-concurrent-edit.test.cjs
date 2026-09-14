// BOM 表并发编辑的乐观锁（采购与生产两个模块都能改同一张 BOM）。
//
// 生产文件：apps/api/src/modules/sales/boms.service.ts 的 assertNotStale / replaceItems / update
// 令牌：客户端回传打开时的 `updatedAt`（expected_updated_at），服务端在事务里取行锁后比对。
//
// 为什么不是「最后保存者获胜」：宪法「Reversible Business Changes」要求
// 「不得静默覆盖历史」「影响上下游时必须先让操作者看到影响」。
// BOM 直接决定生产单的领料量与采购单的用料快照，静默覆盖等于让一个人的现场修正凭空消失。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { BomsService } = require("../../dist/modules/sales/boms.service.js");

const user = { id: "00000000-0000-0000-0000-000000000001", username: "operator" };
const audit = { create: () => ({}), update: () => ({ updatedBy: user.id }), record: async () => undefined };

const bom = (updatedAt) => ({ id: "bom-1", status: "draft", orderNo: "SO-1", version: 1, salesOrderId: "order-1", items: [], updatedAt });

/**
 * 假 Prisma：boms 表里存一份 updatedAt，事务里的 FOR UPDATE 读取返回它。
 * `lock` 用于模拟「另一个模块在这期间先写成功」：把 updatedAt 改成新值。
 */
function prismaWith(updatedAt, options = {}) {
  const state = { updatedAt };
  const writes = [];
  const tx = {
    async $queryRaw() { if (options.onLock) options.onLock(state); return [{ id: "bom-1" }]; },
    bom: { findFirst: async () => ({ updatedAt: state.updatedAt }), update: async ({ data }) => { writes.push({ kind: "bomUpdate", args: { data } }); return { ...bom(state.updatedAt), ...data }; } },
    bomItem: { updateMany: async (args) => { writes.push({ kind: "softDelete", args }); }, createMany: async (args) => { writes.push({ kind: "createMany", args }); } },
  };
  return {
    state,
    writes,
    prisma: {
      bom: { findFirst: async () => bom(state.updatedAt), update: async ({ data }) => ({ ...bom(state.updatedAt), ...data }) },
      $transaction: async (fn) => fn(tx),
    },
  };
}

const item = { material_id: "material-1", material_name: "面料", material_snapshot: { name: "面料" }, required_quantity: "2", unit: "米" };

test("replaceItems accepts the save when the token still matches the stored updatedAt", async () => {
  const stamp = new Date("2026-09-14T02:00:00.000Z");
  const { prisma, writes } = prismaWith(stamp);
  const service = new BomsService(prisma, audit);
  await service.replaceItems("bom-1", [item], user, stamp.toISOString());
  assert.deepEqual(writes.map((row) => row.kind), ["softDelete", "createMany"], "令牌一致时正常写入");
});

test("replaceItems rejects the save when another module already saved (token is stale)", async () => {
  const opened = new Date("2026-09-14T02:00:00.000Z");
  const { prisma, writes } = prismaWith(opened, { onLock: (state) => { state.updatedAt = new Date("2026-09-14T02:05:00.000Z"); } });
  const service = new BomsService(prisma, audit);
  await assert.rejects(
    () => service.replaceItems("bom-1", [item], user, opened.toISOString()),
    (error) => {
      assert.ok(error instanceof UnprocessableEntityException);
      const response = error.getResponse();
      assert.equal(response.code, "BOM_UPDATE_CONFLICT");
      assert.match(response.message, /已被他人/);
      assert.equal(response.details[0].expected_updated_at, opened.toISOString());
      assert.equal(response.details[0].actual_updated_at, "2026-09-14T02:05:00.000Z", "要把库里真实的更新时间回给前端");
      return true;
    },
  );
  assert.deepEqual(writes, [], "冲突时连软删旧行都不能发生，否则会留下半张残缺的 BOM");
});

test("replaceItems skips the comparison when no token is sent (older callers keep working)", async () => {
  const stamp = new Date("2026-09-14T02:00:00.000Z");
  const { prisma, writes } = prismaWith(stamp, { onLock: () => { throw new Error("没有令牌时不该取行锁"); } });
  const service = new BomsService(prisma, audit);
  await service.replaceItems("bom-1", [item], user);
  assert.deepEqual(writes.map((row) => row.kind), ["softDelete", "createMany"]);
});

test("replaceItems rejects a malformed token instead of writing through it", async () => {
  const { prisma, writes } = prismaWith(new Date("2026-09-14T02:00:00.000Z"));
  const service = new BomsService(prisma, audit);
  await assert.rejects(() => service.replaceItems("bom-1", [item], user, "not-a-date"), (error) => error.getResponse().code === "BOM_UPDATE_CONFLICT");
  assert.deepEqual(writes, []);
});

test("update (PATCH extension data) guards with the same token", async () => {
  const opened = new Date("2026-09-14T02:00:00.000Z");
  const stale = prismaWith(opened, { onLock: (state) => { state.updatedAt = new Date("2026-09-14T02:05:00.000Z"); } });
  const staleService = new BomsService(stale.prisma, audit);
  await assert.rejects(() => staleService.update("bom-1", {}, user, opened.toISOString()), (error) => error.getResponse().code === "BOM_UPDATE_CONFLICT");

  const ok = prismaWith(opened);
  const okService = new BomsService(ok.prisma, audit);
  await okService.update("bom-1", { note: "现场调整" }, user, opened.toISOString());
  assert.deepEqual(ok.writes.map((row) => row.kind), ["bomUpdate"], "仅改扩展数据，不涉及明细行");
});

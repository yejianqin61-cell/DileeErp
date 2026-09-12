const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ConflictException } = require("@nestjs/common");
const { ProcurementMasterDataService } = require("../../dist/modules/procurement/procurement-master-data.service.js");

// 物料组合唯一性（名称 + 规格型号 + 颜色）的服务端行为：
// 1) 缺省规格/颜色必须写空串而不是 NULL —— PostgreSQL 唯一索引里 NULL 互不相等，写 NULL 索引等于失效；
// 2) 组合冲突（P2002）要给出能指导操作的提示，而不是笼统的「名称或编码已存在」；
// 3) 同名不同规格必须能保存（这里用「写入的数据不同 → 库层组合不同」来固化）。
const user = { id: "00000000-0000-0000-0000-000000000001" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => undefined };
const unit = { id: "11111111-1111-1111-1111-111111111111", name: "米" };

function service(created, options = {}) {
  const prisma = {
    unit: { findFirst: async () => unit },
    material: {
      findMany: async () => options.codes ?? [],
      create: async ({ data }) => {
        if (options.conflict || options.conflictTarget) { const error = new Error("duplicate"); error.code = "P2002"; if (options.conflictTarget) error.meta = { target: options.conflictTarget }; throw error; }
        created.push(data);
        return { id: `material-${created.length}`, ...data };
      },
    },
  };
  return new ProcurementMasterDataService(prisma, audit);
}

test("同名不同规格/颜色可以分别保存（写入的组合键不同）", async () => {
  const created = [];
  const material = service(created);
  await material.createMaterial({ code_mode: "manual", material_code: "MAT-A", name: "伞布", specification_model: "190T", color: "红色", default_unit_id: unit.id }, user);
  await material.createMaterial({ code_mode: "manual", material_code: "MAT-B", name: "伞布", specification_model: "210T", color: "红色", default_unit_id: unit.id }, user);
  assert.equal(created.length, 2, "同名的第二款物料必须能保存");
  assert.deepEqual(created.map((row) => [row.name, row.specificationModel, row.color]), [["伞布", "190T", "红色"], ["伞布", "210T", "红色"]]);
});

test("规格/颜色留空写成空串（不能写 NULL：NULL 会让组合唯一索引失效）", async () => {
  const created = [];
  await service(created).createMaterial({ code_mode: "manual", material_code: "MAT-C", name: "伞骨", default_unit_id: unit.id }, user);
  assert.equal(created[0].specificationModel, "");
  assert.equal(created[0].color, "");
  assert.equal(created[0].name, "伞骨");
});

test("名称/规格/颜色会去掉首尾空格，避免「看似相同却因空格并存」", async () => {
  const created = [];
  await service(created).createMaterial({ code_mode: "manual", material_code: "MAT-D", name: " 伞布 ", specification_model: " 190T ", color: " 红 ", default_unit_id: unit.id }, user);
  assert.deepEqual([created[0].name, created[0].specificationModel, created[0].color], ["伞布", "190T", "红"]);
});

test("组合冲突的提示要说清是「名称+规格型号+颜色」重复，并给出可执行建议", async () => {
  const service_ = service([], { conflict: true });
  await assert.rejects(
    () => service_.createMaterial({ code_mode: "manual", material_code: "MAT-E", name: "伞布", specification_model: "190T", color: "红色", default_unit_id: unit.id }, user),
    (error) => {
      assert.ok(error instanceof ConflictException, "组合冲突应是 409");
      const message = error.getResponse().message;
      assert.match(message, /名称 \+ 规格型号 \+ 颜色/);
      assert.match(message, /同名不同规格\/颜色可以并存/);
      return true;
    },
  );
});

test("物料编码重复时提示的是编码冲突，不要把用户引向规格/颜色", async () => {
  const service_ = service([], { conflictTarget: ["material_code"] });
  await assert.rejects(
    () => service_.createMaterial({ code_mode: "manual", material_code: "MAT-DUP", name: "伞布", default_unit_id: unit.id }, user),
    (error) => {
      assert.match(error.getResponse().message, /物料编码已存在/);
      assert.doesNotMatch(error.getResponse().message, /规格型号/);
      return true;
    },
  );
});

test("编辑物料时把规格/颜色清空同样写空串（保持组合键口径一致）", async () => {
  const updates = [];
  const prisma = {
    unit: { findFirst: async () => unit },
    material: {
      findFirst: async () => ({ id: "material-1", name: "伞布", deletedAt: null }),
      update: async ({ data }) => { updates.push(data); return { id: "material-1", ...data }; },
    },
  };
  const material = new ProcurementMasterDataService(prisma, audit);
  await material.updateMaterial("material-1", { specification_model: null, color: " 蓝色 " }, user);
  assert.equal(updates[0].specificationModel, "");
  assert.equal(updates[0].color, "蓝色");
});

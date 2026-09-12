const assert = require("node:assert/strict");
const { test } = require("node:test");
const { UnprocessableEntityException } = require("@nestjs/common");
const { ProcurementMasterDataService } = require("../dist/modules/procurement/procurement-master-data.service.js");
const { CustomersService } = require("../dist/modules/sales/customers.service.js");

const user = { id: "00000000-0000-0000-0000-000000000001" };
const audit = { create: () => ({ createdBy: user.id, updatedBy: user.id }), update: () => ({ updatedBy: user.id }), record: async () => undefined };
const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");

// 客户与供应商编码都要支持“自动生成 / 手动填写”两种模式，由用户选择。

function supplierService(created, latest) {
  const prisma = {
    supplier: {
      findMany: async (args) => (args && args.where && args.where.supplierCode && latest ? [latest] : []),
      create: async ({ data }) => { created.push(data); return { id: "supplier-1", ...data }; }
    }
  };
  return new ProcurementMasterDataService(prisma, audit);
}

function customerService(created, latest) {
  const prisma = {
    customer: {
      findMany: async (args) => (args && args.where && args.where.customerCode && latest ? [latest] : []),
      create: async ({ data }) => { created.push(data); return { id: "customer-1", ...data }; }
    }
  };
  return new CustomersService(prisma, audit);
}

test("供应商：自动模式生成 SUP-日期-序号 编码，忽略手填的编码", async () => {
  const created = [];
  await supplierService(created, { supplierCode: `SUP-${today}-0007` }).createSupplier({ code_mode: "auto", supplier_code: "随便写的", name: "某某五金厂" }, user);
  assert.equal(created.length, 1);
  assert.equal(created[0].supplierCode, `SUP-${today}-0008`, "应在当天最大序号上 +1");
});

test("供应商：自动模式当天第一笔从 0001 开始", async () => {
  const created = [];
  await supplierService(created, null).createSupplier({ code_mode: "auto", name: "第一家" }, user);
  assert.equal(created[0].supplierCode, `SUP-${today}-0001`);
});

test("供应商：手动模式必须填写编码，留空则拒绝", async () => {
  const created = [];
  const service = supplierService(created, null);
  await assert.rejects(
    () => service.createSupplier({ code_mode: "manual", supplier_code: "   ", name: "某某五金厂" }, user),
    (error) => error instanceof UnprocessableEntityException && error.getResponse().code === "SUPPLIER_CODE_REQUIRED"
  );
  assert.equal(created.length, 0, "缺编码时不得写入");
});

test("供应商：手动模式使用用户填写的编码（去空格）", async () => {
  const created = [];
  await supplierService(created, null).createSupplier({ code_mode: "manual", supplier_code: " SUP-A-001 ", name: "某某五金厂" }, user);
  assert.equal(created[0].supplierCode, "SUP-A-001");
});

test("供应商：未传 code_mode 时按手动处理（保持旧接口兼容）", async () => {
  const created = [];
  await supplierService(created, null).createSupplier({ supplier_code: "SUP-LEGACY", name: "老接口" }, user);
  assert.equal(created[0].supplierCode, "SUP-LEGACY");
});

test("客户：自动模式生成 CUS-日期-序号 编码", async () => {
  const created = [];
  await customerService(created, { customerCode: `CUS-${today}-0003` }).create({ code_mode: "auto", customer_code: "手填的", name: "海外客户" }, user);
  assert.equal(created[0].customerCode, `CUS-${today}-0004`, "应在当天最大序号上 +1");

  const first = [];
  await customerService(first, null).create({ code_mode: "auto", name: "第一家客户" }, user);
  assert.equal(first[0].customerCode, `CUS-${today}-0001`);
});

test("客户：手动模式必须填写编码，填写后使用用户编码", async () => {
  const created = [];
  const service = customerService(created, null);
  await assert.rejects(
    () => service.create({ code_mode: "manual", customer_code: "", name: "海外客户" }, user),
    (error) => error.getResponse().code === "CUSTOMER_CODE_REQUIRED"
  );
  await service.create({ code_mode: "manual", customer_code: " CUS-A-001 ", name: "海外客户" }, user);
  assert.equal(created[0].customerCode, "CUS-A-001");
});

test("客户：编码重复时返回可读的冲突提示", async () => {
  const prisma = {
    customer: {
      findMany: async () => [],
      create: async () => { const error = new Error("duplicate"); error.code = "P2002"; throw error; }
    }
  };
  const service = new CustomersService(prisma, audit);
  await assert.rejects(
    () => service.create({ code_mode: "manual", customer_code: "CUS-DUP", name: "重复客户" }, user),
    (error) => error.getResponse().code === "CUSTOMER_CONFLICT"
  );
});

test("客户：自动编码撞号时重算重试，失败提示只在重试耗尽后出现", async () => {
  const created = [];
  let attempt = 0;
  const prisma = {
    customer: {
      // 每次重试都返回更大的当天序号，模拟并发下别人刚写入了同一号。
      findMany: async () => [{ customerCode: `CUS-${today}-000${attempt}` }],
      create: async ({ data }) => {
        attempt += 1;
        if (attempt === 1) { const error = new Error("duplicate"); error.code = "P2002"; error.meta = { target: ["customer_code"] }; throw error; }
        created.push(data);
        return { id: "customer-1", ...data };
      }
    }
  };
  const service = new CustomersService(prisma, audit);
  await service.create({ code_mode: "auto", name: "并发客户" }, user);
  assert.equal(created.length, 1, "第一次撞 P2002 后必须自动重试成功");
  assert.equal(created[0].customerCode, `CUS-${today}-0002`);
});

test("客户：撞的是「名称」唯一索引时不重试（重算编码救不了重名）", async () => {
  let attempts = 0;
  const prisma = {
    customer: {
      findMany: async () => [],
      create: async () => { attempts += 1; const error = new Error("duplicate"); error.code = "P2002"; error.meta = { target: ["name"] }; throw error; }
    }
  };
  const service = new CustomersService(prisma, audit);
  await assert.rejects(
    () => service.create({ code_mode: "auto", name: "重名客户" }, user),
    (error) => error.getResponse().code === "CUSTOMER_CONFLICT"
  );
  assert.equal(attempts, 1, "客户名称也唯一：撞名称不该重试");
});

test("客户：手动编码撞 P2002 不重试，直接返回冲突提示", async () => {
  let attempts = 0;
  const prisma = {
    customer: {
      findMany: async () => [],
      create: async () => { attempts += 1; const error = new Error("duplicate"); error.code = "P2002"; throw error; }
    }
  };
  const service = new CustomersService(prisma, audit);
  await assert.rejects(
    () => service.create({ code_mode: "manual", customer_code: "CUS-DUP", name: "重复客户" }, user),
    (error) => error.getResponse().code === "CUSTOMER_CONFLICT"
  );
  assert.equal(attempts, 1, "手动编码是用户自己填的，重试没有意义");
});

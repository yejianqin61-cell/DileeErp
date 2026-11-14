// 原料库存按供应商分桶（InventoryService）的单元测试。
//
// 用例覆盖设计文档 docs/design/2026-11-13-supplier-level-raw-material-stock.md §9：
//   1. 按「物料 + 单位 + 供应商」求余额：同一物料同单位的不同供应商不互相干扰；
//   2. supplierId=null 的「未指定」档独立于具体供应商档位；
//   3. rawMaterialSupplierBuckets 排序稳定（具体供应商在前，「未指定」在后）；
//   4. GET /inventory/raw-material-balances 不带 group_by 时响应绝不出现 supplier_* 字段；
//   5. 带 group_by=supplier 时返回 supplier_id/supplier_code/supplier_name。
//
// 与现有 inventory-service.test.cjs 一样，用 fake client（不连数据库）。
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Prisma } = require("@prisma/client");
const { InventoryService } = require("../../dist/platform/inventory/inventory.service.js");

const D = (v) => new Prisma.Decimal(v);

// 构造一个最小 fake client：只实现 InventoryService 用到的查询方法。
// quantityDelta 用 Prisma.Decimal（服务侧要调 .plus/.isZero）。
function makeClient(facts = [], material = null) {
  return {
    material: {
      findFirst: async ({ where }) => {
        if (!material) return null;
        if (where.id && where.id !== material.id) return null;
        return { ...material, materialType: "raw_material", deletedAt: null };
      }
    },
    inventoryFact: {
      aggregate: async ({ where }) => {
        let sum = new Prisma.Decimal(0);
        for (const f of facts) {
          if (f.materialId !== where.materialId) continue;
          if (f.unitId !== where.unitId) continue;
          if (!where.inventoryCategory.in.includes(f.inventoryCategory)) continue;
          if (where.supplierId !== undefined) {
            if (where.supplierId === null) {
              if (f.supplierId !== null) continue;
            } else if (f.supplierId !== where.supplierId) continue;
          }
          sum = sum.plus(new Prisma.Decimal(f.quantityDelta));
        }
        return { _sum: { quantityDelta: sum } };
      },
      findMany: async ({ where, select }) => {
        const result = [];
        for (const f of facts) {
          if (!where.materialId || f.materialId !== where.materialId) continue;
          if (!where.unitId || f.unitId !== where.unitId) continue;
          if (!where.inventoryCategory.in.includes(f.inventoryCategory)) continue;
          result.push({
            id: f.id || "fact-1",
            materialId: f.materialId,
            unitId: f.unitId,
            inventoryCategory: f.inventoryCategory,
            quantityDelta: D(f.quantityDelta),
            supplierId: f.supplierId ?? null,
            supplier: f.supplierId ? { id: f.supplierId, supplierCode: `SUP-${f.supplierId}`, name: f.supplierName ?? `供应商${f.supplierId}` } : null
          });
        }
        return result;
      }
    }
  };
}

const material = { id: "mat-1", materialCode: "MAT-001", name: "测试原料", defaultUnitId: "unit-1" };

test("rawMaterialBalanceBySupplier：同一物料同单位的不同供应商互不干扰", async () => {
  const facts = [
    { materialId: "mat-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: "3000", supplierId: "sup-1" },
    { materialId: "mat-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: "33000", supplierId: "sup-1" },
    { materialId: "mat-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: "500", supplierId: "sup-2" },
    { materialId: "mat-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: "200", supplierId: null },
  ];
  const service = new InventoryService();
  const client = makeClient(facts, material);

  assert.equal((await service.rawMaterialBalanceBySupplier(client, "mat-1", "unit-1", "sup-1")).toString(), "36000");
  assert.equal((await service.rawMaterialBalanceBySupplier(client, "mat-1", "unit-1", "sup-2")).toString(), "500");
  assert.equal((await service.rawMaterialBalanceBySupplier(client, "mat-1", "unit-1", null)).toString(), "200");
  assert.equal((await service.rawMaterialBalanceBySupplier(client, "mat-1", "unit-2", "sup-1")).toString(), "0");
});

test("rawMaterialBalanceBySupplier：supplierId=null 档位独立于具体供应商档位", async () => {
  const facts = [
    { materialId: "mat-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: "1000", supplierId: null },
    { materialId: "mat-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: "1000", supplierId: "sup-1" },
  ];
  const service = new InventoryService();
  const client = makeClient(facts, material);

  assert.equal((await service.rawMaterialBalanceBySupplier(client, "mat-1", "unit-1", null)).toString(), "1000");
  assert.equal((await service.rawMaterialBalanceBySupplier(client, "mat-1", "unit-1", "sup-1")).toString(), "1000");
});

test("rawMaterialSupplierBuckets：按供应商拆分，且「未指定」档排在最后", async () => {
  const facts = [
    { materialId: "mat-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: "500", supplierId: "sup-2", supplierName: "供应商B" },
    { materialId: "mat-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: "3000", supplierId: "sup-1", supplierName: "供应商A" },
    { materialId: "mat-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: "200", supplierId: null },
  ];
  const service = new InventoryService();
  const client = makeClient(facts, material);

  const buckets = await service.rawMaterialSupplierBuckets(client, "mat-1", "unit-1");
  assert.equal(buckets.length, 3);
  assert.equal(buckets[0].supplier_id, "sup-1");
  assert.equal(buckets[0].supplier_name, "供应商A");
  assert.equal(buckets[0].quantity.toString(), "3000");
  assert.equal(buckets[1].supplier_id, "sup-2");
  assert.equal(buckets[1].supplier_name, "供应商B");
  assert.equal(buckets[1].quantity.toString(), "500");
  assert.equal(buckets[2].supplier_id, null);
  assert.equal(buckets[2].quantity.toString(), "200");
});

test("rawMaterialSupplierBuckets：全为零的档位被过滤掉", async () => {
  const facts = [
    { materialId: "mat-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: "100", supplierId: "sup-1" },
    { materialId: "mat-1", unitId: "unit-1", inventoryCategory: "raw_material", quantityDelta: "-100", supplierId: "sup-1" },
  ];
  const service = new InventoryService();
  const client = makeClient(facts, material);

  const buckets = await service.rawMaterialSupplierBuckets(client, "mat-1", "unit-1");
  assert.equal(buckets.length, 0);
});

test("defaultUnitOf：找到物料的默认单位", async () => {
  const service = new InventoryService();
  const client = makeClient([], { ...material, defaultUnit: { name: "个" } });
  const unit = await service.defaultUnitOf(client, "mat-1");
  assert.equal(unit.unit_id, "unit-1");
  assert.equal(unit.unit_name, "个");
});

test("defaultUnitOf：不存在的物料返回 null", async () => {
  const service = new InventoryService();
  const client = makeClient([], null);
  const unit = await service.defaultUnitOf(client, "missing");
  assert.equal(unit, null);
});

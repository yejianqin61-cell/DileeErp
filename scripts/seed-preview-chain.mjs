// 本地预览造数：一条完整业务链（直连本地库，符合当前 schema 约束）
// 用法: 先确保本地 .env 有 DATABASE_URL，再 node scripts/seed-preview-chain.mjs
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const prisma = new PrismaClient();
const date = (s) => new Date(`${s}T00:00:00.000Z`);

async function main() {
  const admin = await prisma.user.findFirst({ where: { username: "admin", deletedAt: null } });
  if (!admin) throw new Error("未找到 admin，请先执行 npm run db:seed --workspace=@dilee/api");
  const by = { createdBy: admin.id, updatedBy: admin.id };

  // ---- 清理旧 DEMO 数据（保证可重复执行） ----
  const orderPrefix = "DEMO-";
  await prisma.inventoryFact.deleteMany({ where: { OR: [{ orderNo: { startsWith: orderPrefix } }, { material: { materialCode: { startsWith: "DEMO-M-" } } }] } });
  await prisma.employeeDailyReport.deleteMany({ where: { orderNo: { startsWith: orderPrefix } } });
  await prisma.operationDailyReport.deleteMany({ where: { orderNo: { startsWith: orderPrefix } } });
  const oldMoves = await prisma.rawMaterialMovement.findMany({ where: { orderNo: { startsWith: orderPrefix } }, select: { id: true } });
  await prisma.rawMaterialMovementLine.deleteMany({ where: { movementId: { in: oldMoves.map((m) => m.id) } } });
  await prisma.rawMaterialMovement.deleteMany({ where: { orderNo: { startsWith: orderPrefix } } });
  await prisma.rawMaterialInbound.deleteMany({ where: { orderNo: { startsWith: orderPrefix } } });
  await prisma.incomingInspection.deleteMany({ where: { orderNo: { startsWith: orderPrefix } } });
  await prisma.purchaseReceipt.deleteMany({ where: { orderNo: { startsWith: orderPrefix } } });
  await prisma.productionOrderOperation.deleteMany({ where: { productionOrder: { orderNo: { startsWith: orderPrefix } } } });
  await prisma.productionOrder.deleteMany({ where: { orderNo: { startsWith: orderPrefix } } });
  await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { purchaseOrderNo: { startsWith: orderPrefix } } } });
  await prisma.purchaseOrder.deleteMany({ where: { purchaseOrderNo: { startsWith: orderPrefix } } });
  await prisma.bomItem.deleteMany({ where: { bom: { orderNo: { startsWith: orderPrefix } } } });
  await prisma.bom.deleteMany({ where: { orderNo: { startsWith: orderPrefix } } });
  await prisma.salesOrderVersion.deleteMany({ where: { salesOrder: { orderNo: { startsWith: orderPrefix } } } });
  await prisma.salesOrder.deleteMany({ where: { orderNo: { startsWith: orderPrefix } } });
  await prisma.employee.deleteMany({ where: { employeeNo: { startsWith: "DEMO-E-" } } });
  await prisma.material.deleteMany({ where: { materialCode: { startsWith: "DEMO-M-" } } });
  await prisma.supplier.deleteMany({ where: { supplierCode: { startsWith: "DEMO-S-" } } });
  await prisma.customer.deleteMany({ where: { customerCode: { startsWith: "DEMO-C-" } } });
  await prisma.productionLocation.deleteMany({ where: { name: { startsWith: "演示" } } });
  const oldDept = await prisma.department.findFirst({ where: { code: "DEMO-DEPT" } });
  if (oldDept) { await prisma.position.deleteMany({ where: { departmentId: oldDept.id } }); await prisma.department.deleteMany({ where: { code: "DEMO-DEPT" } }); }
  console.log("cleaned old DEMO rows");

  const unitMa = await prisma.unit.findUniqueOrThrow({ where: { name: "码" } });
  const unitGe = await prisma.unit.findUniqueOrThrow({ where: { name: "个" } });

  // ---------- 基础档案 ----------
  const customer = await prisma.customer.upsert({
    where: { customerCode: "DEMO-C-001" }, update: {}, create: { customerCode: "DEMO-C-001", name: "星雨伞业（演示客户）", countryRegion: "国内", address: "浙江杭州", paymentTerms: "发货后30天", currency: "CNY", remark: "预览链路演示客户", ...by },
  });
  const supplier = await prisma.supplier.upsert({
    where: { supplierCode: "DEMO-S-001" }, update: {}, create: { supplierCode: "DEMO-S-001", name: "苏州面料供应商（演示）", contactName: "钱师傅", phone: "13900000002", settlementInfo: { days: 30 }, remark: "预览链路演示供应商", ...by },
  });
  const mFabric = await prisma.material.upsert({ where: { materialCode: "DEMO-M-R1" }, update: {}, create: { materialCode: "DEMO-M-R1", name: "伞布·防泼水涤纶（演示）", defaultUnitId: unitMa.id, materialType: "raw_material", remark: "主料：伞面", ...by } });
  const mBone = await prisma.material.upsert({ where: { materialCode: "DEMO-M-R2" }, update: {}, create: { materialCode: "DEMO-M-R2", name: "伞骨·碳纤维8骨（演示）", defaultUnitId: unitGe.id, materialType: "raw_material", remark: "辅料：骨架", ...by } });
  const mBag = await prisma.material.upsert({ where: { materialCode: "DEMO-M-R3" }, update: {}, create: { materialCode: "DEMO-M-R3", name: "包装袋·OPP（演示）", defaultUnitId: unitGe.id, materialType: "raw_material", remark: "辅料：成品包装", ...by } });

  const dept = await prisma.department.upsert({ where: { code: "DEMO-DEPT" }, update: {}, create: { code: "DEMO-DEPT", name: "演示生产车间", ...by } });
  const position = await prisma.position.upsert({ where: { departmentId_code: { departmentId: dept.id, code: "DEMO-POS" } }, update: {}, create: { departmentId: dept.id, code: "DEMO-POS", name: "车间员工（演示）", ...by } });
  const e1 = await prisma.employee.upsert({ where: { employeeNo: "DEMO-E-001" }, update: {}, create: { employeeNo: "DEMO-E-001", name: "李雨欣", departmentId: dept.id, positionId: position.id, employeeType: "workshop", employmentStatus: "active", hiredOn: date("2025-03-01"), remark: "演示：计件", ...by } });
  const e2 = await prisma.employee.upsert({ where: { employeeNo: "DEMO-E-002" }, update: {}, create: { employeeNo: "DEMO-E-002", name: "张强", departmentId: dept.id, positionId: position.id, employeeType: "workshop", employmentStatus: "active", hiredOn: date("2025-06-15"), remark: "演示：计件", ...by } });

  const location = await prisma.productionLocation.upsert({ where: { name_locationType: { name: "演示一车间", locationType: "workshop" } }, update: {}, create: { name: "演示一车间", locationType: "workshop", contactName: "李主管", address: "厂内1栋2层", isActive: true, remark: "演示厂内生产点", ...by } });

  const opNames = ["大裁", "缝伞", "包装"];
  const ops = {};
  for (const name of opNames) {
    const op = await prisma.operationCatalog.findFirst({ where: { operationName: name, deletedAt: null } });
    if (!op) throw new Error(`缺默认工序: ${name}`);
    ops[name] = op;
  }

  // ---------- 销售单（已确认） ----------
  const orderNo = "DEMO-ORD-260907";
  const sales = await prisma.salesOrder.upsert({
    where: { orderNo }, update: {}, create: {
      orderNo, customerId: customer.id, customerSnapshot: { id: customer.id, name: customer.name }, customerPoNo: "PO-DEMO-001",
      orderDate: date("2026-09-05"), productName: "晴雨两用自动折叠伞", productSpec: "8骨/一键开收/直径98cm", quantity: "300", unit: "把",
      deliveryDate: date("2026-09-25"), currency: "CNY", unitPrice: "38", totalAmount: "11400", taxRate: "0", status: "confirmed", currentVersion: 1, extensionData: { source: "preview-chain" }, ...by,
    },
  });
  const version = await prisma.salesOrderVersion.create({ data: { salesOrderId: sales.id, version: 1, snapshot: { order_no: orderNo, product_name: sales.productName, quantity: "300" }, ...by } });

  // ---------- BOM（已发布，每把伞：伞布0.9码(+3%损耗)、伞骨1支(+2%)、包装袋1个） ----------
  const bom = await prisma.bom.create({ data: { orderNo, salesOrderId: sales.id, salesOrderVersionId: version.id, version: 1, status: "published", ...by } });
  const bomItems = [];
  const bomDefs = [
    { material: mFabric, name: "伞布·防泼水涤纶（演示）", unit: "码", unitId: unitMa.id, perUnit: "0.9", lossRate: "0.03" },
    { material: mBone, name: "伞骨·碳纤维8骨（演示）", unit: "个", unitId: unitGe.id, perUnit: "1", lossRate: "0.02" },
    { material: mBag, name: "包装袋·OPP（演示）", unit: "个", unitId: unitGe.id, perUnit: "1", lossRate: "0" },
  ];
  for (const def of bomDefs) {
    bomItems.push(await prisma.bomItem.create({ data: {
      bomId: bom.id, materialId: def.material.id, materialName: def.name, unit: def.unit, unitId: def.unitId,
      materialSnapshot: { code: def.material.materialCode, name: def.material.name }, requiredQuantity: def.perUnit, lossRate: def.lossRate,
      extensionData: {}, ...by,
    } }));
  }

  // ---------- 采购单（含到货-质检-原料入库，保证有库存可领） ----------
  const po = await prisma.purchaseOrder.upsert({
    where: { purchaseOrderNo: "DEMO-PO-260907" }, update: {}, create: {
      purchaseOrderNo: "DEMO-PO-260907", orderNo, salesOrderId: sales.id, bomId: bom.id, bomVersion: 1,
      bomSnapshot: { order_no: orderNo, version: 1 }, supplierId: supplier.id, supplierSnapshot: { id: supplier.id, code: supplier.supplierCode, name: supplier.name },
      purchaseDate: date("2026-09-05"), expectedDate: date("2026-09-08"), currency: "CNY", status: "arrived_complete", totalAmount: "1186", remark: "预览链路演示采购", ...by,
    },
  });
  // 采购需求：300把 → 伞布 300*0.9*1.03≈280 码、伞骨 306 支、袋 300 个，按 320/320/320 采购留缓冲
  const poDefs = [
    { material: mFabric, unit: "码", unitId: unitMa.id, qty: "320", price: "2.00", bomItemId: bomItems[0].id },
    { material: mBone, unit: "个", unitId: unitGe.id, qty: "320", price: "1.50", bomItemId: bomItems[1].id },
    { material: mBag, unit: "个", unitId: unitGe.id, qty: "320", price: "0.20", bomItemId: bomItems[2].id },
  ];
  const poItems = [];
  for (const d of poDefs) {
    poItems.push(await prisma.purchaseOrderItem.create({ data: {
      purchaseOrderId: po.id, materialId: d.material.id, materialSnapshot: { code: d.material.materialCode, name: d.material.name },
      unitId: d.unitId, unitSnapshot: { name: d.unit }, bomItemId: d.bomItemId, supplierId: supplier.id, supplierSnapshot: { id: supplier.id, code: supplier.supplierCode, name: supplier.name },
      expectedDate: date("2026-09-08"), quantity: d.qty, unitPrice: d.price, taxRate: "0", extraFee: "0",
      amount: String(Number(d.qty) * Number(d.price)), ...by,
    } }));
  }
  const receipts = [], inspections = [], inbounds = [];
  const qcPlan = [{ accepted: "315", rejected: "5" }, { accepted: "320", rejected: "0" }, { accepted: "320", rejected: "0" }];
  for (let i = 0; i < poItems.length; i++) {
    const item = poItems[i];
    const receipt = await prisma.purchaseReceipt.create({ data: { purchaseOrderId: po.id, purchaseOrderItemId: item.id, orderNo, receiptNo: `DEMO-REC-${i + 1}`, referenceNo: `TRUCK-DEMO-${i + 1}`, receivedDate: date("2026-09-06"), quantity: "320", status: "received", remark: "演示到货", ...by } });
    receipts.push(receipt);
    const inspection = await prisma.incomingInspection.create({ data: { purchaseReceiptId: receipt.id, orderNo, inspectedQuantity: "320", acceptedQuantity: qcPlan[i].accepted, conditionalQuantity: "0", rejectedQuantity: qcPlan[i].rejected, status: "passed", remark: "演示来料质检", ...by } });
    inspections.push(inspection);
    const inbound = await prisma.rawMaterialInbound.create({ data: {
      inboundNo: `DEMO-IN-${i + 1}`, orderNo, purchaseOrderId: po.id, purchaseOrderItemId: item.id, purchaseReceiptId: receipt.id,
      incomingInspectionId: inspection.id, materialId: item.materialId, supplierId: supplier.id, quantity: qcPlan[i].accepted,
      inventoryCategory: "raw_material", status: "posted", idempotencyKey: `DEMO-IDEM-IN-${i + 1}`, unitId: poDefs[i].unitId, remark: "演示合格入库", ...by,
    } });
    inbounds.push(inbound);
    await prisma.inventoryFact.create({ data: { rawMaterialInboundId: inbound.id, materialId: item.materialId, inventoryCategory: "raw_material", quantityDelta: qcPlan[i].accepted, sourceType: "raw_material_inbound", sourceId: inbound.id, orderNo, unitId: poDefs[i].unitId, createdBy: admin.id } });
  }

  // ---------- 生产单（进行中，含3道工序） ----------
  const prodNo = "DEMO-PROD-260907";
  const prod = await prisma.productionOrder.upsert({
    where: { productionOrderNo: prodNo }, update: {}, create: {
      productionOrderNo: prodNo, orderNo, salesOrderId: sales.id, bomId: bom.id, bomVersion: 1, bomSnapshot: { order_no: orderNo, version: 1 },
      productionOrderType: "standard", executionMode: "in_house", executionLocationId: location.id, plannedQuantity: "300", unitId: unitGe.id,
      productSpecification: "8骨/一键开收/直径98cm", productionProcessNote: "演示生产流程", status: "in_progress",
      plannedStartedOn: date("2026-09-06"), deliveryDueOn: date("2026-09-25"), startedOn: date("2026-09-06"), remark: "预览链路演示生产单", ...by,
    },
  });
  const seqOps = [{ op: ops["大裁"], seq: 1 }, { op: ops["缝伞"], seq: 2 }, { op: ops["包装"], seq: 3 }];
  const prodOps = {};
  for (const so of seqOps) {
    prodOps[so.op.operationName] = await prisma.productionOrderOperation.create({ data: {
      productionOrderId: prod.id, operationCatalogId: so.op.id, operationNameSnapshot: so.op.operationName, unitId: unitGe.id, sequenceNo: so.seq, targetQuantity: "300", status: "active", ...by,
    } });
  }

  // ---------- 生产领料（已过账：伞布270码、伞骨300支、包装袋300个） ----------
  const movement = await prisma.rawMaterialMovement.create({ data: { movementNo: "DEMO-MV-260907", documentType: "issue", status: "posted", productionOrderId: prod.id, orderNo, businessDate: date("2026-09-06"), reason: "生产领料", remark: "演示领料单", idempotencyKey: "DEMO-IDEM-MV-1", ...by } });
  const mvDefs = [
    { material: mFabric, unitId: unitMa.id, qty: "270" },
    { material: mBone, unitId: unitGe.id, qty: "300" },
    { material: mBag, unitId: unitGe.id, qty: "300" },
  ];
  for (const d of mvDefs) {
    const line = await prisma.rawMaterialMovementLine.create({ data: { movementId: movement.id, materialId: d.material.id, unitId: d.unitId, quantity: d.qty, remark: "演示领料行", ...by } });
    await prisma.inventoryFact.create({ data: { materialId: d.material.id, inventoryCategory: "raw_material", quantityDelta: `-${d.qty}`, sourceType: "material_issue", sourceId: movement.id, orderNo, productionOrderId: prod.id, rawMaterialMovementLineId: line.id, unitId: d.unitId, createdBy: admin.id } });
  }

  // ---------- 日报（工序 + 员工，日期 2026-09-07；只做计件，便于口径一致） ----------
  // 工序日报：大裁300 / 缝伞280 / 包装250（与员工合计一致）
  const opReports = [
    { opName: "大裁", qty: "300" },
    { opName: "缝伞", qty: "280" },
    { opName: "包装", qty: "250" },
  ];
  for (const r of opReports) {
    await prisma.operationDailyReport.create({ data: {
      idempotencyKey: `DEMO-IDEM-OP-${r.opName}`, productionOrderId: prod.id, productionOrderOperationId: prodOps[r.opName].id, orderNo,
      productionOrderNoSnapshot: prodNo, operationNameSnapshot: r.opName, unitId: unitGe.id, reportDate: date("2026-09-07"), completedQuantity: r.qty, remark: "演示工序日报", ...by,
    } });
  }
  // 员工日报：大裁 李雨欣300×0.15=45；缝伞 李雨欣160×0.5=80 + 张强120×0.5=60；包装 张强250×0.2=50
  const empReports = [
    { opName: "大裁", emp: e1, qty: "300", price: "0.15" },
    { opName: "缝伞", emp: e1, qty: "160", price: "0.5" },
    { opName: "缝伞", emp: e2, qty: "120", price: "0.5" },
    { opName: "包装", emp: e2, qty: "250", price: "0.2" },
  ];
  for (let i = 0; i < empReports.length; i++) {
    const r = empReports[i];
    const amount = String(Math.round(Number(r.qty) * Number(r.price) * 100) / 100);
    await prisma.employeeDailyReport.create({ data: {
      idempotencyKey: `DEMO-IDEM-EMP-${i + 1}`, productionOrderId: prod.id, productionOrderOperationId: prodOps[r.opName].id, employeeId: r.emp.id, orderNo,
      productionOrderNoSnapshot: prodNo, operationNameSnapshot: r.opName, employeeNameSnapshot: r.emp.name, reportDate: date("2026-09-07"),
      wageMode: "piece_rate", quantity: r.qty, durationMinutes: "0", unitPrice: r.price, calculatedAmount: amount, remark: "演示员工日报", ...by,
    } });
  }

  console.log(JSON.stringify({
    ok: true, orderNo, productionOrderNo: prodNo, customer: customer.name, supplier: supplier.name,
    materials: [mFabric.materialCode, mBone.materialCode, mBag.materialCode], employees: [e1.employeeNo, e2.employeeNo],
    receipts: receipts.length, inspections: inspections.length, inbounds: inbounds.length, bomItems: bomItems.length, poItems: poItems.length,
    operations: opNames, note: "本地演示链路已写入，可直接在 Web 上查看", }, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());

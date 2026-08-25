import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const prisma = new PrismaClient();
const actor = process.env.MOCK_ACTOR_ID;
const now = new Date("2026-08-25T08:00:00.000Z");
const day = (value) => new Date(`${value}T00:00:00.000Z`);
const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const json = (value) => value;
const audit = (userId) => ({ createdBy: userId, updatedBy: userId });

async function put(model, key, data) {
  const client = prisma[model];
  if (!client) throw new Error(`Unknown Prisma model client: ${model}`);
  const update = { ...data };
  if (model !== "auditEvent") update.updatedAt = now;
  return client.upsert({ where: { id: key }, update, create: { id: key, ...data } });
}

async function putInventory(key, data) {
  const relation = {};
  for (const [field, model] of [["rawMaterialInboundId", "rawMaterialInbound"], ["materialId", "material"], ["productionOrderId", "productionOrder"], ["rawMaterialMovementLineId", "rawMaterialMovementLine"], ["finishedGoodsInboundId", "finishedGoodsInbound"], ["finishedGoodsDefectiveId", "finishedGoodsDefective"], ["finishedGoodsOutboundId", "finishedGoodsOutbound"], ["customerReturnId", "customerReturn"]]) {
    if (data[field]) { relation[model] = { connect: { id: data[field] } }; delete data[field]; }
  }
  if (data.unitId) { relation.unit = { connect: { id: data.unitId } }; delete data.unitId; }
  const existing = await prisma.inventoryFact.findUnique({ where: { id: key } });
  const payload = { ...data, ...relation };
  return existing ? prisma.inventoryFact.update({ where: { id: key }, data: payload }) : prisma.inventoryFact.create({ data: { id: key, ...payload } });
}

async function main() {
  const admin = actor ? await prisma.user.findUnique({ where: { id: actor } }) : await prisma.user.findFirst({ where: { username: "admin", deletedAt: null } });
  if (!admin) throw new Error("找不到管理员用户，请先执行 npm run db:seed --workspace=@dilee/api，或设置 MOCK_ACTOR_ID");
  const userId = admin.id;
  const a = audit(userId);
  const u = {
    打: "00000000-0000-4000-8000-000000000001",
    码: "00000000-0000-4000-8000-000000000002",
    个: "00000000-0000-4000-8000-000000000003",
    包: "00000000-0000-4000-8000-000000000004",
    捆: "00000000-0000-4000-8000-000000000005",
  };
  for (const [name, key] of Object.entries(u)) {
    const existing = await prisma.unit.findUnique({ where: { name } });
    if (existing) { u[name] = existing.id; await prisma.unit.update({ where: { id: existing.id }, data: { isActive: true, remark: "系统单位池", ...a } }); }
    else await put("unit", key, { name, isActive: true, remark: "系统单位池", ...a });
  }

  const customerA = id(101), customerB = id(102), contactA = id(103), contactB = id(104);
  await put("customer", customerA, { customerCode: "MOCK-C-001", name: "海风家居（模拟）", countryRegion: "美国", address: "Seattle", paymentTerms: "发货后30天", currency: "USD", remark: "全链路模拟客户", isActive: true, ...a });
  await put("customer", customerB, { customerCode: "MOCK-C-002", name: "远山贸易（模拟）", countryRegion: "德国", address: "Hamburg", paymentTerms: "预付50%", currency: "EUR", remark: "第二订单模拟客户", isActive: true, ...a });
  await put("customerContact", contactA, { customerId: customerA, name: "林晓", position: "采购经理", phone: "13800000001", email: "mock-a@example.test", isDefault: true, isActive: true, remark: "模拟联系人", ...a });
  await put("customerContact", contactB, { customerId: customerB, name: "周宁", position: "供应链主管", phone: "13800000002", email: "mock-b@example.test", isDefault: true, isActive: true, remark: "模拟联系人", ...a });

  const materialA = id(201), materialB = id(202), materialC = id(203), supplierA = id(204), supplierB = id(205);
  await put("material", materialA, { materialCode: "MOCK-M-001", name: "伞布-蓝色（模拟）", defaultUnitId: u.码, isActive: true, remark: "BOM 主料", ...a });
  await put("material", materialB, { materialCode: "MOCK-M-002", name: "伞骨-铝合金（模拟）", defaultUnitId: u.个, isActive: true, remark: "BOM 辅料", ...a });
  await put("material", materialC, { materialCode: "MOCK-M-003", name: "包装袋（模拟）", defaultUnitId: u.个, isActive: true, remark: "成品包装", ...a });
  await put("supplier", supplierA, { supplierCode: "MOCK-S-001", name: "宁波伞布供应商（模拟）", contactName: "赵工", phone: "13900000001", settlementInfo: json({ days: 30 }), isActive: true, remark: "原料供应商", ...a });
  await put("supplier", supplierB, { supplierCode: "MOCK-S-002", name: "苏州加工点（模拟）", contactName: "钱师傅", phone: "13900000002", settlementInfo: json({ days: 15 }), isActive: true, remark: "外加工点", ...a });

  const orderA = id(301), orderB = id(302), versionA = id(303), versionB = id(304);
  const customerSnapshotA = { id: customerA, customer_code: "MOCK-C-001", name: "海风家居（模拟）" };
  const customerSnapshotB = { id: customerB, customer_code: "MOCK-C-002", name: "远山贸易（模拟）" };
  await put("salesOrder", orderA, { orderNo: "MOCK-ORD-001", customerId: customerA, contactId: contactA, customerSnapshot: json(customerSnapshotA), contactSnapshot: json({ id: contactA, name: "林晓" }), customerPoNo: "PO-MOCK-001", externalContractNo: "OC-MOCK-001", orderDate: day("2026-08-20"), productName: "蓝色折叠伞", productSpec: "24骨/晴雨两用", quantity: "1000", unit: "个", deliveryDate: day("2026-09-20"), currency: "USD", unitPrice: "12.50", totalAmount: "12500", taxRate: "0", status: "confirmed", currentVersion: 1, extensionData: json({ source: "mock" }), ...a });
  await put("salesOrder", orderB, { orderNo: "MOCK-ORD-002", customerId: customerB, contactId: contactB, customerSnapshot: json(customerSnapshotB), contactSnapshot: json({ id: contactB, name: "周宁" }), customerPoNo: "PO-MOCK-002", externalContractNo: "OC-MOCK-002", orderDate: day("2026-08-21"), productName: "黑色直柄伞", productSpec: "16骨/自动开收", quantity: "600", unit: "个", deliveryDate: day("2026-09-30"), currency: "EUR", unitPrice: "10.00", totalAmount: "6000", taxRate: "0", status: "draft", currentVersion: 1, extensionData: json({ source: "mock" }), ...a });
  await put("salesOrderVersion", versionA, { salesOrderId: orderA, version: 1, snapshot: json({ order_no: "MOCK-ORD-001", product_name: "蓝色折叠伞", quantity: "1000" }), ...a });
  await put("salesOrderVersion", versionB, { salesOrderId: orderB, version: 1, snapshot: json({ order_no: "MOCK-ORD-002", product_name: "黑色直柄伞", quantity: "600" }), ...a });

  const bomA = id(401), bomB = id(402), bomItemA1 = id(403), bomItemA2 = id(404), bomItemA3 = id(405), bomItemB1 = id(406);
  await put("bom", bomA, { orderNo: "MOCK-ORD-001", salesOrderId: orderA, salesOrderVersionId: versionA, version: 1, status: "published", extensionData: json({ product_spec: "24骨/晴雨两用", mock: true }), ...a });
  await put("bom", bomB, { orderNo: "MOCK-ORD-002", salesOrderId: orderB, salesOrderVersionId: versionB, version: 1, status: "draft", extensionData: json({ product_spec: "16骨/自动开收", mock: true }), ...a });
  await put("bomItem", bomItemA1, { bomId: bomA, materialId: materialA, unitId: u.码, materialSnapshot: json({ code: "MOCK-M-001", name: "伞布-蓝色（模拟）" }), requiredQuantity: "1.2", unit: "码", lossQuantity: "0.05", lossRate: "0.04", extensionData: json({}), ...a });
  await put("bomItem", bomItemA2, { bomId: bomA, materialId: materialB, unitId: u.个, materialSnapshot: json({ code: "MOCK-M-002", name: "伞骨-铝合金（模拟）" }), requiredQuantity: "1", unit: "个", lossQuantity: "0", lossRate: "0", extensionData: json({}), ...a });
  await put("bomItem", bomItemA3, { bomId: bomA, materialId: materialC, unitId: u.个, materialSnapshot: json({ code: "MOCK-M-003", name: "包装袋（模拟）" }), requiredQuantity: "1", unit: "个", extensionData: json({}), ...a });
  await put("bomItem", bomItemB1, { bomId: bomB, materialId: materialA, unitId: u.码, materialSnapshot: json({ code: "MOCK-M-001", name: "伞布-蓝色（模拟）" }), requiredQuantity: "1.1", unit: "码", lossRate: "0.03", extensionData: json({}), ...a });

  const dept = id(501), position = id(502), employeeA = id(503), employeeB = id(504), locationIn = id(505), locationOut = id(506), opCut = id(507), opSew = id(508), opPack = id(509);
  await put("department", dept, { code: "MOCK-PROD", name: "模拟生产车间", isActive: true, remark: "全链路夹具", ...a });
  await put("position", position, { departmentId: dept, code: "MOCK-OP", name: "模拟操作员", isActive: true, remark: "全链路夹具", ...a });
  await put("employee", employeeA, { employeeNo: "MOCK-E-001", name: "陈师傅", departmentId: dept, positionId: position, employeeType: "worker", employmentStatus: "active", hiredOn: day("2025-01-10"), remark: "计件员工", ...a });
  await put("employee", employeeB, { employeeNo: "MOCK-E-002", name: "王师傅", departmentId: dept, positionId: position, employeeType: "worker", employmentStatus: "active", hiredOn: day("2025-02-10"), remark: "计时员工", ...a });
  await put("productionLocation", locationIn, { name: "模拟一车间", locationType: "workshop", contactName: "陈主管", contactPhone: "13700000001", address: "厂内A区", isActive: true, remark: "厂内生产", ...a });
  await put("productionLocation", locationOut, { name: "模拟外加工点", locationType: "outsource_site", contactName: "钱师傅", contactPhone: "13700000002", address: "江苏昆山", isActive: true, remark: "外加工交接", ...a });
  await put("operationCatalog", opCut, { operationCode: "MOCK-CUT", operationName: "裁剪（模拟）", defaultUnitId: u.个, isActive: true, remark: "工序池", ...a });
  await put("operationCatalog", opSew, { operationCode: "MOCK-SEW", operationName: "缝制（模拟）", defaultUnitId: u.个, isActive: true, remark: "工序池", ...a });
  await put("operationCatalog", opPack, { operationCode: "MOCK-PACK", operationName: "包装（模拟）", defaultUnitId: u.个, isActive: true, remark: "工序池", ...a });
  await put("operationRate", id(510), { employeeId: employeeA, operationId: opCut, wageMode: "piece_rate", unitPrice: "0.80", effectiveFrom: day("2026-01-01"), remark: "计件单价", ...a });
  await put("operationRate", id(511), { employeeId: employeeB, operationId: opSew, wageMode: "time_rate", unitPrice: "45", effectiveFrom: day("2026-01-01"), remark: "计时单价/小时", ...a });

  const prodA = id(601), prodB = id(602), poa1 = id(603), poa2 = id(604), pob1 = id(605);
  await put("productionOrder", prodA, { productionOrderNo: "MOCK-PROD-001", orderNo: "MOCK-ORD-001", salesOrderId: orderA, bomId: bomA, bomVersion: 1, bomSnapshot: json({ order_no: "MOCK-ORD-001", version: 1 }), productionOrderType: "standard", executionMode: "in_house", executionLocationId: locationIn, plannedQuantity: "1000", unitId: u.个, productSpecification: "24骨/晴雨两用", productionProcessNote: "正常生产", status: "in_progress", plannedStartedOn: day("2026-08-22"), deliveryDueOn: day("2026-09-15"), startedOn: day("2026-08-22"), actualCompletedQuantity: "420", remark: "厂内生产模拟单", ...a });
  await put("productionOrder", prodB, { productionOrderNo: "MOCK-PROD-002", orderNo: "MOCK-ORD-002", salesOrderId: orderB, bomId: bomB, bomVersion: 1, bomSnapshot: json({ order_no: "MOCK-ORD-002", version: 1 }), productionOrderType: "standard", executionMode: "outsource", executionLocationId: locationOut, plannedQuantity: "600", unitId: u.个, productSpecification: "16骨/自动开收", productionProcessNote: "外加工点执行", status: "in_progress", plannedStartedOn: day("2026-08-23"), deliveryDueOn: day("2026-09-25"), startedOn: day("2026-08-23"), actualCompletedQuantity: "180", remark: "外加工模拟单", ...a });
  await put("productionOrderOperation", poa1, { productionOrderId: prodA, operationCatalogId: opCut, operationNameSnapshot: "裁剪（模拟）", unitId: u.个, sequenceNo: 1, targetQuantity: "1000", status: "active", ...a });
  await put("productionOrderOperation", poa2, { productionOrderId: prodA, operationCatalogId: opSew, operationNameSnapshot: "缝制（模拟）", unitId: u.个, sequenceNo: 2, targetQuantity: "1000", status: "active", ...a });
  await put("productionOrderOperation", pob1, { productionOrderId: prodB, operationCatalogId: opPack, operationNameSnapshot: "包装（模拟）", unitId: u.个, sequenceNo: 1, targetQuantity: "600", status: "active", ...a });

  const purchaseA = id(701), purchaseB = id(702), itemA = id(703), itemB = id(704), receiptA1 = id(705), receiptA2 = id(706), inspA1 = id(707), inspA2 = id(708), inboundA1 = id(709), inboundA2 = id(710), payableSourceA = id(711), payableEntryA = id(712);
  await put("purchaseOrder", purchaseA, { purchaseOrderNo: "MOCK-PO-001", orderNo: "MOCK-ORD-001", salesOrderId: orderA, bomId: bomA, bomVersion: 1, bomSnapshot: json({ order_no: "MOCK-ORD-001", version: 1 }), supplierId: supplierA, supplierSnapshot: json({ code: "MOCK-S-001", name: "宁波伞布供应商（模拟）" }), purchaseDate: day("2026-08-21"), expectedDate: day("2026-08-28"), currency: "USD", status: "partially_arrived", totalAmount: "960", remark: "分批到货采购单", ...a });
  await put("purchaseOrder", purchaseB, { purchaseOrderNo: "MOCK-PO-002", orderNo: "MOCK-ORD-002", salesOrderId: orderB, bomId: bomB, bomVersion: 1, bomSnapshot: json({ order_no: "MOCK-ORD-002", version: 1 }), supplierId: supplierB, supplierSnapshot: json({ code: "MOCK-S-002", name: "苏州加工点（模拟）" }), purchaseDate: day("2026-08-22"), expectedDate: day("2026-09-01"), currency: "EUR", status: "ordered", totalAmount: "660", remark: "外加工物料直发", ...a });
  await put("purchaseOrderItem", itemA, { purchaseOrderId: purchaseA, materialId: materialA, materialSnapshot: json({ code: "MOCK-M-001", name: "伞布-蓝色（模拟）" }), unitId: u.码, unitSnapshot: json({ name: "码" }), bomItemId: bomItemA1, quantity: "1200", unitPrice: "0.80", taxRate: "0", extraFee: "0", amount: "960", extensionData: json({}), ...a });
  await put("purchaseOrderItem", itemB, { purchaseOrderId: purchaseB, materialId: materialA, materialSnapshot: json({ code: "MOCK-M-001", name: "伞布-蓝色（模拟）" }), unitId: u.码, unitSnapshot: json({ name: "码" }), bomItemId: bomItemB1, quantity: "660", unitPrice: "1", taxRate: "0", extraFee: "0", amount: "660", extensionData: json({}), ...a });
  await put("purchaseReceipt", receiptA1, { purchaseOrderId: purchaseA, purchaseOrderItemId: itemA, orderNo: "MOCK-ORD-001", receiptNo: "MOCK-REC-001", referenceNo: "TRUCK-001", receivedDate: day("2026-08-25"), quantity: "700", status: "received", remark: "首批到货", ...a });
  await put("purchaseReceipt", receiptA2, { purchaseOrderId: purchaseA, purchaseOrderItemId: itemA, orderNo: "MOCK-ORD-001", receiptNo: "MOCK-REC-002", referenceNo: "TRUCK-002", receivedDate: day("2026-08-27"), quantity: "500", status: "received", remark: "第二批到货", ...a });
  await put("incomingInspection", inspA1, { purchaseReceiptId: receiptA1, orderNo: "MOCK-ORD-001", inspectedQuantity: "700", acceptedQuantity: "680", conditionalQuantity: "10", rejectedQuantity: "10", status: "passed", extensionData: json({ defect_rate: "1.4%" }), remark: "首批来料 QC", ...a });
  await put("incomingInspection", inspA2, { purchaseReceiptId: receiptA2, orderNo: "MOCK-ORD-001", inspectedQuantity: "500", acceptedQuantity: "500", conditionalQuantity: "0", rejectedQuantity: "0", status: "passed", extensionData: json({}), remark: "第二批来料 QC", ...a });
  await put("rawMaterialInbound", inboundA1, { inboundNo: "MOCK-IN-001", orderNo: "MOCK-ORD-001", purchaseOrderId: purchaseA, purchaseOrderItemId: itemA, purchaseReceiptId: receiptA1, incomingInspectionId: inspA1, materialId: materialA, supplierId: supplierA, quantity: "680", inventoryCategory: "raw_material", status: "posted", idempotencyKey: "MOCK-IDEMP-IN-001", remark: "合格入库", unitId: u.码, ...a });
  await put("rawMaterialInbound", inboundA2, { inboundNo: "MOCK-IN-002", orderNo: "MOCK-ORD-001", purchaseOrderId: purchaseA, purchaseOrderItemId: itemA, purchaseReceiptId: receiptA2, incomingInspectionId: inspA2, materialId: materialA, supplierId: supplierA, quantity: "500", inventoryCategory: "raw_material", status: "posted", idempotencyKey: "MOCK-IDEMP-IN-002", remark: "第二批入库", unitId: u.码, ...a });
  await put("payableSource", payableSourceA, { rawMaterialInboundId: inboundA1, orderNo: "MOCK-ORD-001", purchaseOrderId: purchaseA, purchaseOrderItemId: itemA, supplierId: supplierA, quantity: "680", unitPrice: "0.8", currency: "USD", taxRate: "0", amount: "544", status: "pending_finance", idempotencyKey: "MOCK-IDEMP-PAY-001", ...a });
  await put("supplierPayableEntry", payableEntryA, { payableNo: "MOCK-AP-001", orderNo: "MOCK-ORD-001", supplierId: supplierA, sourceType: "raw_material_inbound", payableSourceId: payableSourceA, sourceNoSnapshot: "MOCK-IN-001", quantity: "680", unitPrice: "0.8", taxRate: "0", amount: "544", currency: "USD", confirmationDate: day("2026-08-25"), status: "confirmed", attachment: json([]), purchaseOrderId: purchaseA, purchaseOrderItemId: itemA, ...a });
  await putInventory(id(713), { rawMaterialInboundId: inboundA1, materialId: materialA, inventoryCategory: "raw_material", quantityDelta: "680", sourceType: "raw_material_inbound", sourceId: inboundA1, orderNo: "MOCK-ORD-001", unitId: u.码, createdBy: userId });
  await putInventory(id(714), { rawMaterialInboundId: inboundA2, materialId: materialA, inventoryCategory: "raw_material", quantityDelta: "500", sourceType: "raw_material_inbound", sourceId: inboundA2, orderNo: "MOCK-ORD-001", unitId: u.码, createdBy: userId });

  const movement = id(801), movementLine = id(802), returnMove = id(803), returnLine = id(804);
  await put("rawMaterialMovement", movement, { movementNo: "MOCK-MV-ISSUE-001", documentType: "issue", status: "posted", productionOrderId: prodA, orderNo: "MOCK-ORD-001", businessDate: day("2026-08-25"), reason: "生产领料", remark: "厂内首批领料", idempotencyKey: "MOCK-IDEMP-MV-001", ...a });
  await put("rawMaterialMovementLine", movementLine, { movementId: movement, materialId: materialA, unitId: u.码, quantity: "300", bomReferenceQuantity: "1200", remark: "首批领料", ...a });
  await put("rawMaterialMovement", returnMove, { movementNo: "MOCK-MV-RETURN-001", documentType: "return", status: "posted", productionOrderId: prodA, orderNo: "MOCK-ORD-001", businessDate: day("2026-08-25"), reason: "余料退回", remark: "退回余料", idempotencyKey: "MOCK-IDEMP-MV-002", ...a });
  await put("rawMaterialMovementLine", returnLine, { movementId: returnMove, materialId: materialA, unitId: u.码, quantity: "20", sourceIssueLineId: movementLine, remark: "余料回库", ...a });
  await putInventory(id(805), { materialId: materialA, inventoryCategory: "raw_material", quantityDelta: "-300", sourceType: "material_issue", sourceId: movement, orderNo: "MOCK-ORD-001", productionOrderId: prodA, rawMaterialMovementLineId: movementLine, unitId: u.码, createdBy: userId });
  await putInventory(id(806), { materialId: materialA, inventoryCategory: "raw_material", quantityDelta: "20", sourceType: "material_return", sourceId: returnMove, orderNo: "MOCK-ORD-001", productionOrderId: prodA, rawMaterialMovementLineId: returnLine, unitId: u.码, createdBy: userId });

  const reportA = id(901), reportB = id(902), empReportA = id(903), empReportB = id(904), alert = id(905);
  await put("operationDailyReport", reportA, { idempotencyKey: "MOCK-IDEMP-REPORT-001", productionOrderId: prodA, productionOrderOperationId: poa1, orderNo: "MOCK-ORD-001", productionOrderNoSnapshot: "MOCK-PROD-001", operationNameSnapshot: "裁剪（模拟）", unitId: u.个, reportDate: day("2026-08-25"), completedQuantity: "420", remark: "工序日报", ...a });
  await put("operationDailyReport", reportB, { idempotencyKey: "MOCK-IDEMP-REPORT-002", productionOrderId: prodA, productionOrderOperationId: poa2, orderNo: "MOCK-ORD-001", productionOrderNoSnapshot: "MOCK-PROD-001", operationNameSnapshot: "缝制（模拟）", unitId: u.个, reportDate: day("2026-08-25"), completedQuantity: "400", remark: "工序日报", ...a });
  await put("employeeDailyReport", empReportA, { idempotencyKey: "MOCK-IDEMP-EMP-001", productionOrderId: prodA, productionOrderOperationId: poa1, employeeId: employeeA, orderNo: "MOCK-ORD-001", productionOrderNoSnapshot: "MOCK-PROD-001", operationNameSnapshot: "裁剪（模拟）", employeeNameSnapshot: "陈师傅", reportDate: day("2026-08-25"), wageMode: "piece_rate", quantity: "420", durationMinutes: "0", unitPrice: "0.8", calculatedAmount: "336", remark: "计件日报", ...a });
  await put("employeeDailyReport", empReportB, { idempotencyKey: "MOCK-IDEMP-EMP-002", productionOrderId: prodA, productionOrderOperationId: poa2, employeeId: employeeB, orderNo: "MOCK-ORD-001", productionOrderNoSnapshot: "MOCK-PROD-001", operationNameSnapshot: "缝制（模拟）", employeeNameSnapshot: "王师傅", reportDate: day("2026-08-25"), wageMode: "time_rate", quantity: "400", durationMinutes: "480", unitPrice: "45", calculatedAmount: "360", remark: "计时日报，件数仅统计", ...a });
  await put("productionDailyAlert", alert, { alertType: "employee_operation_discrepancy", productionOrderId: prodA, productionOrderOperationId: poa2, orderNo: "MOCK-ORD-001", reportDate: day("2026-08-25"), status: "pending", targetQuantity: "1000", operationReportQuantity: "400", employeeReportQuantity: "400", discrepancyQuantity: "0", cumulativeQuantity: "400", overOrderQuantity: "0", ...a });
  await put("productionPayrollSource", id(906), { employeeId: employeeA, productionOrderId: prodA, orderNo: "MOCK-ORD-001", periodStart: day("2026-08-01"), periodEnd: day("2026-08-31"), wageMode: "piece_rate", quantity: "420", durationMinutes: "0", amount: "336", sourceSnapshot: json({ employee_daily_report_id: empReportA }), remark: "模拟工资来源", ...a });
  await put("productionPayrollSource", id(907), { employeeId: employeeB, productionOrderId: prodA, orderNo: "MOCK-ORD-001", periodStart: day("2026-08-01"), periodEnd: day("2026-08-31"), wageMode: "time_rate", quantity: "400", durationMinutes: "480", amount: "360", sourceSnapshot: json({ employee_daily_report_id: empReportB }), remark: "模拟工资来源", ...a });
  await put("attendanceRecord", id(908), { employeeId: employeeA, attendanceDate: day("2026-08-25"), attendanceType: "present", workHours: "8", overtimeHours: "0", remark: "模拟出勤", attachment: json([]), ...a });
  await put("performanceRecord", id(909), { employeeId: employeeA, periodStart: day("2026-08-01"), periodEnd: day("2026-08-31"), score: "96", grade: "A", rewardAmount: "100", comment: "模拟绩效", attachment: json([]), ...a });
  await put("payrollLedger", id(910), { ledgerNo: "MOCK-PAYROLL-001", employeeId: employeeA, periodStart: day("2026-08-01"), periodEnd: day("2026-08-31"), currency: "CNY", baseSalary: "5000", productionSourceAmount: "336", overtimeAmount: "0", attendanceDeduction: "0", performanceAmount: "100", allowanceAmount: "0", socialInsurance: "0", individualTax: "0", otherAdjustment: "0", sourceSnapshot: json({ order_no: "MOCK-ORD-001" }), status: "draft", attachment: json([]), remark: "模拟薪资台账", ...a });

  const batch = id(1001), outsourceReceipt = id(1002), outsourcePayable = id(1003), returnTransfer = id(1004), directShipment = id(1005);
  await put("outsourceLogisticsBatch", batch, { batchNo: "MOCK-OUT-001", orderNo: "MOCK-ORD-002", productionOrderId: prodB, outsourceLocationId: locationOut, purchaseOrderId: purchaseB, purchaseOrderItemId: itemB, materialId: materialA, unitId: u.码, plannedQuantity: "660", dispatchedQuantity: "660", dispatchDate: day("2026-08-24"), dispatchProofRemark: "物流单号 MOCK-LOG-001", status: "dispatched", remark: "外加工直发", ...a });
  await put("outsourceReceipt", outsourceReceipt, { logisticsBatchId: batch, orderNo: "MOCK-ORD-002", receiptDate: day("2026-08-25"), quantity: "660", receiverName: "钱师傅", proofRemark: "已签收", idempotencyKey: "MOCK-IDEMP-OUT-001", status: "received", reversalQuantity: "0", ...a });
  await put("outsourcePayableSource", outsourcePayable, { outsourceReceiptId: outsourceReceipt, logisticsBatchId: batch, orderNo: "MOCK-ORD-002", purchaseOrderId: purchaseB, purchaseOrderItemId: itemB, supplierId: supplierB, quantity: "660", unitPrice: "1", currency: "EUR", taxRate: "0", amount: "660", status: "pending_finance", ...a });
  await put("outsourceReturnTransfer", returnTransfer, { transferNo: "MOCK-RET-001", transferType: "finished_goods_return", orderNo: "MOCK-ORD-002", productionOrderId: prodB, unitId: u.个, productDescription: "黑色直柄伞", quantity: "180", transferDate: day("2026-08-25"), status: "received", finishedGoodsQcStatus: "pending", remark: "外加工成品回厂", ...a });
  await put("outsourceDirectShipment", directShipment, { shipmentNo: "MOCK-DIRECT-001", orderNo: "MOCK-ORD-002", productionOrderId: prodB, unitId: u.个, productDescription: "黑色直柄伞", quantity: "120", shipmentDate: day("2026-08-26"), logisticsReference: "柜号 MOCK-CAB-001", status: "dispatched", reversalQuantity: "0", remark: "外加工直装柜", ...a });

  const submission = id(1101), qc = id(1102), fgInbound = id(1103), defective = id(1104), outbound = id(1105), receivable = id(1106), customerPayment = id(1107), receivableAllocation = id(1108);
  await put("finishedGoodsInspectionSubmission", submission, { submissionNo: "MOCK-FG-QC-001", orderNo: "MOCK-ORD-001", productionOrderId: prodA, sourceType: "in_house_completion", sourceId: prodA, productionOrderNoSnapshot: "MOCK-PROD-001", productNameSnapshot: "蓝色折叠伞", productSpecificationSnapshot: "24骨/晴雨两用", unitId: u.个, unitNameSnapshot: "个", submittedQuantity: "420", submissionDate: day("2026-08-25"), status: "submitted", remark: "成品送检", version: 1, ...a });
  await put("finishedGoodsQcRecord", qc, { qcNo: "MOCK-FG-QC-REC-001", submissionId: submission, orderNo: "MOCK-ORD-001", productionOrderId: prodA, sourceType: "in_house_completion", sourceId: prodA, inspectionDate: day("2026-08-25"), inspectedQuantity: "420", qualifiedQuantity: "410", conditionalAcceptQuantity: "5", rejectedQuantity: "5", conclusion: "conditional_pass", status: "completed", rejectionReason: "5个伞骨划伤", version: 1, remark: "成品 QC", ...a });
  await put("finishedGoodsInbound", fgInbound, { inboundNo: "MOCK-FG-IN-001", orderNo: "MOCK-ORD-001", productionOrderId: prodA, qcRecordId: qc, submissionId: submission, unitId: u.个, productNameSnapshot: "蓝色折叠伞", productSpecificationSnapshot: "24骨/晴雨两用", quantity: "410", inventoryCategory: "finished_goods", status: "posted", idempotencyKey: "MOCK-IDEMP-FG-IN-001", remark: "成品合格入库", ...a });
  await put("finishedGoodsDefective", defective, { defectiveNo: "MOCK-FG-DEF-001", orderNo: "MOCK-ORD-001", productionOrderId: prodA, qcRecordId: qc, submissionId: submission, unitId: u.个, productNameSnapshot: "蓝色折叠伞", productSpecificationSnapshot: "24骨/晴雨两用", quantity: "5", inventoryCategory: "defective_goods", status: "recorded", disposition: "rework", idempotencyKey: "MOCK-IDEMP-FG-DEF-001", remark: "返工处理", ...a });
  await put("finishedGoodsOutbound", outbound, { outboundNo: "MOCK-FG-OUT-001", orderNo: "MOCK-ORD-001", salesOrderId: orderA, productionOrderId: prodA, unitId: u.个, productNameSnapshot: "蓝色折叠伞", productSpecificationSnapshot: "24骨/晴雨两用", quantity: "200", status: "signed", shipmentDate: day("2026-08-26"), carrier: "模拟物流", trackingNo: "MOCK-TRACK-001", packingListNo: "MOCK-PL-001", invoiceNo: "MOCK-IV-001", signedAt: day("2026-08-28"), signatureReference: "签收单 MOCK-SIGN-001", attachment: json([]), idempotencyKey: "MOCK-IDEMP-FG-OUT-001", remark: "分批成品出库", ...a });
  await putInventory(id(1109), { finishedGoodsInboundId: fgInbound, inventoryCategory: "finished_goods", quantityDelta: "410", sourceType: "finished_goods_inbound", sourceId: fgInbound, orderNo: "MOCK-ORD-001", productionOrderId: prodA, productNameSnapshot: "蓝色折叠伞", productSpecificationSnapshot: "24骨/晴雨两用", unitId: u.个, createdBy: userId });
  await putInventory(id(1110), { finishedGoodsDefectiveId: defective, inventoryCategory: "defective_goods", quantityDelta: "5", sourceType: "finished_goods_defective", sourceId: defective, orderNo: "MOCK-ORD-001", productionOrderId: prodA, productNameSnapshot: "蓝色折叠伞", productSpecificationSnapshot: "24骨/晴雨两用", unitId: u.个, createdBy: userId });
  await putInventory(id(1111), { finishedGoodsOutboundId: outbound, inventoryCategory: "finished_goods", quantityDelta: "-200", sourceType: "finished_goods_outbound", sourceId: outbound, orderNo: "MOCK-ORD-001", productionOrderId: prodA, productNameSnapshot: "蓝色折叠伞", productSpecificationSnapshot: "24骨/晴雨两用", unitId: u.个, createdBy: userId });
  await put("receivableSource", receivable, { sourceNo: "MOCK-AR-001", orderNo: "MOCK-ORD-001", salesOrderId: orderA, outboundId: outbound, customerId: customerA, quantity: "200", unit: "个", unitPrice: "12.5", taxRate: "0", amount: "2500", currency: "USD", status: "confirmed", dueDate: day("2026-09-27"), invoiceNo: "MOCK-IV-001", invoiceDate: day("2026-08-26"), signedAtSnapshot: day("2026-08-28"), attachment: json([]), remark: "成品出库应收", ...a });
  await put("customerPayment", customerPayment, { paymentNo: "MOCK-REC-PAY-001", customerId: customerA, orderNo: "MOCK-ORD-001", paymentDate: day("2026-08-29"), amount: "1250", currency: "USD", paymentMethod: "bank_transfer", bankReference: "MOCK-BANK-001", payerName: "海风家居（模拟）", status: "posted", attachment: json([]), remark: "分批收款", salesOrderId: orderA, ...a });
  await put("receivableAllocation", receivableAllocation, { paymentId: customerPayment, receivableSourceId: receivable, amount: "1250", currency: "USD", status: "active", remark: "部分核销", ...a });

  await put("supplierPayableEntry", id(1201), { payableNo: "MOCK-AP-OUT-001", orderNo: "MOCK-ORD-002", supplierId: supplierB, sourceType: "outsource_receipt", outsourcePayableSourceId: outsourcePayable, sourceNoSnapshot: "MOCK-OUT-001", quantity: "660", unitPrice: "1", taxRate: "0", amount: "660", currency: "EUR", confirmationDate: day("2026-08-25"), status: "confirmed", attachment: json([]), remark: "外加工应付", purchaseOrderId: purchaseB, purchaseOrderItemId: itemB, outsourceLogisticsBatchId: batch, ...a });
  await put("supplierPayment", id(1202), { paymentNo: "MOCK-SUP-PAY-001", supplierId: supplierA, orderNo: "MOCK-ORD-001", paymentDate: day("2026-08-30"), amount: "300", currency: "USD", paymentMethod: "bank_transfer", bankReference: "MOCK-BANK-002", payeeName: "宁波伞布供应商（模拟）", status: "draft", attachment: json([]), remark: "待核销付款", ...a });

  const events = [
    [id(1301), "sales_order.confirm", "sales_order", orderA, "MOCK-ORD-001", { from: "draft", to: "confirmed" }],
    [id(1302), "purchase_order.receive", "purchase_order", purchaseA, "MOCK-ORD-001", { receipt_no: "MOCK-REC-001", quantity: "700" }],
    [id(1303), "finished_goods_outbound.sign", "finished_goods_outbound", outbound, "MOCK-ORD-001", { quantity: "200" }],
    [id(1304), "production_daily_alert.create", "production_daily_alert", alert, "MOCK-ORD-001", { type: "employee_operation_discrepancy" }],
  ];
  for (const [eventId, action, entityType, entityId, orderNo, details] of events) await put("auditEvent", eventId, { action, entityType, entityId, actorId: userId, orderNo, details: json(details), createdAt: now });
  console.log(JSON.stringify({ ok: true, actor: userId, orders: ["MOCK-ORD-001", "MOCK-ORD-002"], productionOrders: ["MOCK-PROD-001", "MOCK-PROD-002"], note: "mock data upserted" }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());

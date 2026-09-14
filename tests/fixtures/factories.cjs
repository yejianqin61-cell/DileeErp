// 业务夹具工厂库。
//
// 解决什么问题（见 docs/test/01-test-master-plan.md §2.2 S3、§5.2）：
//   改造前，每条集成/E2E 用例都要手写 15-25 行 Prisma 播种 + 20-30 行按依赖逆序的
//   DELETE 清理（例如 apps/api/test/integration/raw-material-issues.test.cjs:19-30 与 :70-86）。
//   这既拖慢编写速度，也是"清理漏一张表 → 下一条用例被脏数据毒化"的根源。
//
// 设计要点：
//   1. 每个工厂方法返回**真实的 Prisma 行**，不是简化视图 —— 断言可以直接用。
//   2. 所有创建过的行都登记进清理注册表，cleanup() 按依赖逆序删除，
//      失败逐个收集后一次性抛出（不静默吞掉，沿用 test-context.cjs:15 的原则）。
//   3. 跨模块链路提供 chain 方法（salesChain / procurementChain），
//      把"合法初始状态"的业务顺序固化下来，而不是让每条用例自己拼。
//   4. 涉及状态机与关联的关键步骤走**真实 service**（例如入库通知的接收必须由
//      RawMaterialInboundNoticesService.acknowledge 完成，它会创建并关联草稿入库单；
//      手工插入 status="acknowledged" 的通知不会建立关联，过账时必然 422）。
//
// 用法：
//   const { createFactories } = require("../../fixtures/factories.cjs");
//   const fx = createFactories({ prisma, prefix: "procurement" });
//   try {
//     const chain = await fx.procurementChain();
//     await chain.inboundService.post(chain.inbound.id, fx.actor());
//     ...
//   } finally {
//     await fx.cleanup();
//   }
const { randomUUID } = require("node:crypto");
const { Prisma } = require("@prisma/client");
const { testRun } = require("../helpers/test-context.cjs");

const delegateOf = (modelName) => modelName.charAt(0).toLowerCase() + modelName.slice(1);

/**
 * 把 Prisma 的多行报错压成一行可读原因。
 * Prisma 的 message 前面是调用栈片段，真正有用的外键名在最后一行，
 * 直接截断前 180 字符会把原因切掉，因此优先抽取约束名。
 */
function summarizeDbError(error) {
  const message = String(error?.message ?? error);
  const foreignKey = /Foreign key constraint violated on the constraint: `([^`]+)`/.exec(message);
  if (foreignKey) return `foreign key violated -> ${foreignKey[1]}`;
  const constraint = /constraint: `([^`]+)`/.exec(message);
  if (constraint) return `constraint violated -> ${constraint[1]}`;
  const unique = /Unique constraint failed on the fields?: \(([^)]+)\)/.exec(message);
  if (unique) return `unique constraint -> ${unique[1]}`;
  return message.replace(/\s+/g, " ").trim().slice(-200);
}

// 带 order_no 的模型（业务单据）—— 由 Prisma DMMF 派生，schema 新增表时自动跟上。
// 关键价值：**service 自己创建的行也带 order_no**，因此这一轮清扫能覆盖工厂没有登记的行
// （例如 RawMaterialInboundsService.post 产生的 payable_source）。
const ORDER_NO_DELEGATES = Prisma.dmmf.datamodel.models
  .filter((model) => model.fields.some((field) => field.name === "orderNo"))
  .map((model) => delegateOf(model.name))
  .filter((delegate) => delegate !== "auditEvent"); // 审计事件单独处理，避免与业务删除交叉

/**
 * 不带 order_no、但可通过某个「指向带 order_no 模型」的单值关系间接定位的子表。
 *
 * 由 Prisma DMMF **运行时派生**，不手工维护：schema 新增一张挂在业务单据下的子表时自动跟上。
 * 例：ProductionOrderOperation 没有 order_no，但 productionOrder 有 —— 于是按
 * `{ productionOrder: { orderNo } }` 删除。SalesOrderVersion、BomItem、RawMaterialMovementLine
 * 等同理。
 *
 * 为什么必须覆盖这类表：它们由 service 创建、工厂拿不到句柄，又因缺 order_no 逃过
 * 阶段二的清扫，残留后会以外键阻塞父表，导致整条链清不掉（实测踩过两次）。
 */
function deriveChildScopes() {
  const models = Prisma.dmmf.datamodel.models;
  const byName = new Map(models.map((model) => [model.name, model]));
  const orderNoModels = new Set(models.filter((model) => model.fields.some((field) => field.name === "orderNo")).map((model) => model.name));
  const scopes = [];
  for (const model of models) {
    if (orderNoModels.has(model.name)) continue;
    // 找一个指向带 order_no 模型的「单值」对象关系即可（不带 order_no 的表没有唯一正确父表，
    // 命中任意一个带 order_no 的祖先都足以定位本次 run 的行）。
    const relation = model.fields.find((field) => field.kind === "object" && !field.isList && orderNoModels.has(field.type));
    if (!relation) continue;
    // 自引用（RawMaterialMovementLine.sourceIssueLine）不参与：它指向自身，自身也无 order_no。
    scopes.push({ delegate: delegateOf(model.name), relation: relation.name });
  }
  return scopes;
}

const CHILD_VIA_RELATION = deriveChildScopes();

/**
 * 创建一组绑定到 (prisma, run) 的工厂方法。
 *
 * @param {object} options
 * @param {object} options.prisma      绑定到测试库的 PrismaClient
 * @param {string} [options.prefix]    testRun 前缀，决定所有业务编号
 * @param {string} [options.actorId]   审计字段用的操作人 id（不要求真实存在 users 行）
 * @param {object} [options.services]  可选：注入真实 service 实例以驱动状态机步骤
 */
function createFactories({ prisma, prefix = "fix", actorId, services = {} } = {}) {
  if (!prisma) throw new Error("createFactories requires a prisma client");
  const run = testRun(prefix);
  const actor = { id: actorId ?? randomUUID(), username: "fixture", display_name: "夹具" };

  /** 审计字段。Prisma 行要求 createdBy/updatedBy 必填，且**不接受客户端覆盖为他人**。 */
  const audit = {
    create: () => ({ createdBy: actor.id, updatedBy: actor.id }),
    update: () => ({ updatedBy: actor.id }),
    softDelete: () => ({ deletedAt: new Date(), deletedBy: actor.id, updatedBy: actor.id }),
  };

  const tracked = new Map();
  function track(model, row) {
    if (!row || !row.id) return row;
    if (!tracked.has(model)) tracked.set(model, new Set());
    tracked.get(model).add(row.id);
    return row;
  }
  /** 手工登记外部创建的行（例如测试自己调用 service 产生的单据）。 */
  function trackExternal(model, row) {
    return track(model, row);
  }

  /** 带唯一后缀的编号，避免并行/重复运行时撞唯一约束。 */
  const code = (kind) => `${kind}-${run.id}`;

  // ---------- 主数据 ----------

  async function createUnit(overrides = {}) {
    return track("unit", await prisma.unit.create({ data: { name: `件-${run.id}`, ...audit.create(), ...overrides } }));
  }

  async function createMaterial(unit, overrides = {}) {
    return track(
      "material",
      await prisma.material.create({
        data: { materialCode: code("M"), name: `物料-${run.id}`, defaultUnitId: unit.id, materialType: "raw_material", ...audit.create(), ...overrides },
      }),
    );
  }

  /** 常用组合：一个单位 + 一个原料物料。 */
  async function createMaterialAndUnit(overrides = {}) {
    const unit = await createUnit(overrides.unit);
    const material = await createMaterial(unit, overrides.material);
    return { unit, material };
  }

  async function createCustomer(overrides = {}) {
    return track("customer", await prisma.customer.create({ data: { customerCode: code("C"), name: `客户-${run.id}`, ...audit.create(), ...overrides } }));
  }

  async function createSupplier(overrides = {}) {
    return track("supplier", await prisma.supplier.create({ data: { supplierCode: code("S"), name: `供应商-${run.id}`, ...audit.create(), ...overrides } }));
  }

  async function createProductionLocation(overrides = {}) {
    return track("productionLocation", await prisma.productionLocation.create({ data: { name: `车间-${run.id}`, locationType: "workshop", ...audit.create(), ...overrides } }));
  }

  async function createOutsourceSite(overrides = {}) {
    return track("productionLocation", await prisma.productionLocation.create({ data: { name: `外加工点-${run.id}`, locationType: "outsource_site", ...audit.create(), ...overrides } }));
  }

  async function createOperationCatalog(unit, overrides = {}) {
    return track(
      "operationCatalog",
      await prisma.operationCatalog.create({ data: { operationCode: code("OP"), operationName: `缝制-${run.id}`, defaultUnitId: unit.id, ...audit.create(), ...overrides } }),
    );
  }

  async function createDepartment(overrides = {}) {
    return track("department", await prisma.department.create({ data: { code: code("D"), name: `车间部-${run.id}`, ...audit.create(), ...overrides } }));
  }

  async function createPosition(department, overrides = {}) {
    return track("position", await prisma.position.create({ data: { departmentId: department.id, code: code("P"), name: `工人-${run.id}`, ...audit.create(), ...overrides } }));
  }

  async function createEmployee(department, position, overrides = {}) {
    return track(
      "employee",
      await prisma.employee.create({
        data: { employeeNo: code("E"), name: `员工-${run.id}`, departmentId: department.id, positionId: position.id, employeeType: "workshop", employmentStatus: "active", ...audit.create(), ...overrides },
      }),
    );
  }

  async function createOperationRate(employee, operation, overrides = {}) {
    const row = await prisma.operationRate.create({
      data: { employeeId: employee.id, operationId: operation.id, wageMode: "piece_rate", unitPrice: "2", effectiveFrom: new Date("2026-01-01"), ...audit.create(), ...overrides },
    });
    // operationRate 主键不是 id（见 schema），按 employeeId 组合清理，故登记到 employeeOperationRate 语义键。
    if (!tracked.has("operationRate")) tracked.set("operationRate", new Set());
    tracked.get("operationRate").add(row.id ?? `${employee.id}:${operation.id}:${row.wageMode}`);
    return row;
  }

  // ---------- 销售链 ----------

  /** 已确认销售单 + 版本。返回 { customer, salesOrder, version }。 */
  async function salesChain({ unit, customer } = {}) {
    const resolvedUnit = unit ?? (await createUnit());
    const resolvedCustomer = customer ?? (await createCustomer());
    const salesOrder = track(
      "salesOrder",
      await prisma.salesOrder.create({
        data: {
          orderNo: run.orderNo,
          customerId: resolvedCustomer.id,
          customerSnapshot: { name: resolvedCustomer.name },
          orderDate: new Date(),
          productName: "测试雨伞",
          quantity: "10",
          unit: resolvedUnit.name,
          currency: "USD",
          status: "confirmed",
          ...audit.create(),
        },
      }),
    );
    const version = track("salesOrderVersion", await prisma.salesOrderVersion.create({ data: { salesOrderId: salesOrder.id, version: 1, snapshot: {}, ...audit.create() } }));
    return { unit: resolvedUnit, customer: resolvedCustomer, salesOrder, version };
  }

  async function createPublishedBom({ salesOrder, version }, overrides = {}) {
    return track(
      "bom",
      await prisma.bom.create({ data: { orderNo: run.orderNo, salesOrderId: salesOrder.id, salesOrderVersionId: version.id, version: 1, status: "published", ...audit.create(), ...overrides } }),
    );
  }

  async function createBomItem(bom, material, unit, overrides = {}) {
    return track(
      "bomItem",
      await prisma.bomItem.create({
        data: { bomId: bom.id, materialId: material.id, materialName: material.name, unitId: unit.id, materialSnapshot: { name: material.name }, requiredQuantity: "10", unit: unit.name, ...audit.create(), ...overrides },
      }),
    );
  }

  // ---------- 采购链 ----------

  async function createPurchaseOrder({ salesOrder, bom, supplier }, overrides = {}) {
    return track(
      "purchaseOrder",
      await prisma.purchaseOrder.create({
        data: {
          purchaseOrderNo: code("PO"),
          orderNo: run.orderNo,
          salesOrderId: salesOrder.id,
          bomId: bom.id,
          bomVersion: 1,
          bomSnapshot: {},
          supplierId: supplier.id,
          supplierSnapshot: { name: supplier.name },
          purchaseDate: new Date(),
          currency: "USD",
          ...audit.create(),
          ...overrides,
        },
      }),
    );
  }

  async function createPurchaseOrderItem(purchaseOrder, { material, unit, bomItem, supplier }, overrides = {}) {
    return track(
      "purchaseOrderItem",
      await prisma.purchaseOrderItem.create({
        data: {
          purchaseOrderId: purchaseOrder.id,
          materialId: material.id,
          materialSnapshot: { name: material.name },
          unitId: unit.id,
          unitSnapshot: { name: unit.name },
          bomItemId: bomItem?.id,
          supplierId: supplier.id,
          supplierSnapshot: { name: supplier.name },
          expectedDate: new Date(),
          quantity: "10",
          unitPrice: "2",
          amount: "20",
          ...audit.create(),
          ...overrides,
        },
      }),
    );
  }

  async function createReceipt(purchaseOrder, item, overrides = {}) {
    return track(
      "purchaseReceipt",
      await prisma.purchaseReceipt.create({
        data: { purchaseOrderId: purchaseOrder.id, purchaseOrderItemId: item.id, orderNo: run.orderNo, receiptNo: code("GR"), receivedDate: new Date(), quantity: "10", ...audit.create(), ...overrides },
      }),
    );
  }

  async function createIncomingInspection(receipt, overrides = {}) {
    return track(
      "incomingInspection",
      await prisma.incomingInspection.create({
        data: { purchaseReceiptId: receipt.id, orderNo: run.orderNo, inspectedQuantity: "10", acceptedQuantity: "10", conditionalQuantity: "0", rejectedQuantity: "0", status: "accepted", qcResult: "accepted", ...audit.create(), ...overrides },
      }),
    );
  }

  /**
   * 完整采购链：客户 → 销售单 → BOM → 采购单 → 到货 → 来料 QC。
   * 返回全部句柄，供用例在其上继续走"入库通知 → 接收 → 入库 → 过账"。
   */
  async function procurementChain(overrides = {}) {
    const { unit, material } = await createMaterialAndUnit();
    const supplier = await createSupplier();
    const sales = await salesChain({ unit });
    const bom = await createPublishedBom(sales);
    const bomItem = await createBomItem(bom, material, unit);
    const purchaseOrder = await createPurchaseOrder({ ...sales, bom, supplier });
    const item = await createPurchaseOrderItem(purchaseOrder, { material, unit, bomItem, supplier });
    const receipt = await createReceipt(purchaseOrder, item, overrides.receipt);
    const inspection = await createIncomingInspection(receipt, overrides.inspection);
    return { ...sales, unit, material, supplier, bom, bomItem, purchaseOrder, item, receipt, inspection };
  }

  // ---------- 生产链 ----------

  async function createProductionOrder({ salesOrder, bom, location, unit }, overrides = {}) {
    return track(
      "productionOrder",
      await prisma.productionOrder.create({
        data: {
          productionOrderNo: code("MO"),
          orderNo: run.orderNo,
          salesOrderId: salesOrder.id,
          bomId: bom.id,
          bomVersion: 1,
          bomSnapshot: {},
          executionMode: "in_house",
          executionLocationId: location.id,
          plannedQuantity: "10",
          unitId: unit.id,
          status: "in_progress",
          ...audit.create(),
          ...overrides,
        },
      }),
    );
  }

  async function createProductionOperation(productionOrder, operation, unit, overrides = {}) {
    return track(
      "productionOrderOperation",
      await prisma.productionOrderOperation.create({
        data: { productionOrderId: productionOrder.id, operationCatalogId: operation.id, operationNameSnapshot: operation.operationName, unitId: unit.id, sequenceNo: 1, targetQuantity: "10", ...audit.create(), ...overrides },
      }),
    );
  }

  /**
   * 生产线所需的**上游主数据与前置单据**，但不创建生产单本身。
   *
   * 与 productionChain() 的区别很重要：一个销售订单只允许一张标准主生产单
   * （production-orders.service.ts:32），因此凡是要自己调用 ProductionOrdersService.create()
   * 的用例都必须用本方法取前置数据 —— 用 productionChain() 会先把主生产单建掉，
   * 再调用 create() 必然 409 PRODUCTION_ORDER_ALREADY_EXISTS。
   */
  async function productionPrerequisites(overrides = {}) {
    const { unit, material } = await createMaterialAndUnit();
    const sales = await salesChain({ unit });
    const bom = await createPublishedBom(sales);
    const bomItem = await createBomItem(bom, material, unit);
    const location = await createProductionLocation();
    const outsourceSite = await createOutsourceSite();
    const operation = await createOperationCatalog(unit, overrides.operation);
    return { ...sales, bom, bomItem, location, material, operation, outsourceSite, unit };
  }

  /** 生产线：车间、工序、生产单、工序行。 */
  async function productionChain(overrides = {}) {
    const prerequisites = await productionPrerequisites();
    const productionOrder = await createProductionOrder(prerequisites, overrides.productionOrder);
    const productionOperation = await createProductionOperation(productionOrder, prerequisites.operation, prerequisites.unit);
    return { ...prerequisites, productionOperation, productionOrder };
  }

  /** 期初库存：直接写动态事实，而不是改余额（余额由事实汇总得出）。 */
  async function seedInventoryFact({ material, unit, quantity = "10", category = "raw_material", sourceType = "fixture" }) {
    const row = await prisma.inventoryFact.create({
      data: { materialId: material.id, unitId: unit.id, inventoryCategory: category, quantityDelta: quantity, sourceType, sourceId: randomUUID(), orderNo: run.orderNo, createdBy: actor.id },
    });
    return track("inventoryFact", row);
  }

  // ---------- 清理 ----------

  /**
   * 彻底清理本次 run 产生的数据。
   *
   * 为什么不是"只删登记过的 id"：
   *   用例会调用真实 service，service 会创建工厂没有登记的行（例如 post() 生成的
   *   payable_source）。只删登记项会留下它们，进而因外键阻塞父表删除，最终整条链清不掉。
   *
   * 算法：每轮依次做「删登记项 → 按 order_no 清扫单据 → 删关系子表」，整轮重试，
   *   直到某一轮零失败。**无需人工维护拓扑顺序**：上一轮删掉的子表会让父表在下一轮可删。
   *   （实测：salesOrderVersion → bom → bomItem → salesOrder → customer → unit 这条链
   *     需要 3~4 轮收敛，因此上限取 8 留足余量。）
   *
   * 任何一步失败都会继续尝试其余步骤，最后一次性抛出汇总错误（不静默吞掉）。
   */
  async function cleanup({ attempts = 8 } = {}) {
    const failures = new Map();
    // 审计范围必须在删除业务数据**之前**算：tracked 会在下面被清空。
    const auditWhere = auditScope();
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      failures.clear();

      // 阶段一：删除全部**登记过 id** 的行。
      // 放最前面：登记项覆盖了 order_no 清扫触及不到的模型（例如 salesOrderVersion 没有 order_no），
      // 先删它们能让下一阶段的单据删除更容易成功。
      for (const [model, ids] of tracked) {
        if (!ids.size) continue;
        try {
          await prisma[model].deleteMany({ where: { id: { in: Array.from(ids) } } });
        } catch (error) {
          failures.set(`id:${model}`, error.message);
        }
      }

      // 阶段二：按 order_no 清扫业务单据（含 service 自行创建、工厂未登记的行）
      for (const delegate of ORDER_NO_DELEGATES) {
        try {
          await prisma[delegate].deleteMany({ where: { orderNo: run.orderNo } });
        } catch (error) {
          failures.set(`orderNo:${delegate}`, error.message);
        }
      }

      // 阶段三：挂在 order_no 父表下、自身无 order_no 的子表（由 DMMF 派生，见 CHILD_VIA_RELATION）
      for (const child of CHILD_VIA_RELATION) {
        try {
          await prisma[child.delegate].deleteMany({ where: { [child.relation]: { orderNo: run.orderNo } } });
        } catch (error) {
          failures.set(`child:${child.delegate}`, error.message);
        }
      }

      if (failures.size === 0) break;
    }

    // 审计事件最后清（不阻塞业务数据删除，也不受其失败影响）。
    // 口径见 auditScope()：必须同时覆盖 orderNo 列、details.order_no 与 entityId 三种关联方式。
    try {
      await prisma.auditEvent.deleteMany({ where: auditWhere });
    } catch (error) {
      failures.set("auditEvent", error.message);
    }

    tracked.clear();
    if (failures.size) {
      const detail = Array.from(failures.entries()).map(([step, message]) => `${step}: ${summarizeDbError(message)}`).join(" | ");
      throw new Error(`fixture cleanup failed for ${run.orderNo} -> ${detail}`);
    }
  }

  /**
   * 本次 run 的审计事件范围。
   *
   * 必须同时覆盖三种落库方式，缺一就会漏掉事件（进而让 audit_events 在测试间持续堆积）：
   *   1. `orderNo` 列        —— AuditService.recordWithOrderNo()（audit.service.ts:18）
   *   2. `details.order_no`  —— AuditService.record() 的常见调用方式（audit.service.ts:15）
   *   3. `entityId` 命中本次登记的任何实体
   *      —— 有些调用两者都没有，例如 raw-material-inbound-notices.service.ts:103 的接收事件
   *         只传 `{ status }`，既无 orderNo 列也无 details.order_no，只能靠实体 id 关联。
   */
  function auditScope() {
    const entityIds = Array.from(tracked.values()).flatMap((ids) => Array.from(ids));
    return {
      OR: [
        { orderNo: run.orderNo },
        { details: { path: ["order_no"], equals: run.orderNo } },
        ...(entityIds.length ? [{ entityId: { in: entityIds } }] : []),
      ],
    };
  }

  /** 只清理审计事件与指定模型，供需要保留主数据的特殊用例使用。 */
  async function cleanupAuditEvents() {
    await prisma.auditEvent.deleteMany({ where: auditScope() });
  }

  /**
   * 查询本次 run 的全部审计事件。
   * 口径与 cleanup 完全一致，避免"能查到却清不掉"或反之。
   */
  async function auditEvents() {
    return prisma.auditEvent.findMany({ where: auditScope(), orderBy: { createdAt: "asc" } });
  }

  /** 便捷访问器：让用例不用自己拼 service。 */
  const service = (name) => {
    if (!services[name]) throw new Error(`service "${name}" was not injected into createFactories()`);
    return services[name];
  };

  return {
    actor: () => actor,
    audit,
    auditEvents,
    cleanup,
    cleanupAuditEvents,
    code,
    prisma,
    run,
    service,
    track: trackExternal,
    // 业务方法
    createBomItem,
    createCustomer,
    createDepartment,
    createEmployee,
    createIncomingInspection,
    createMaterial,
    createMaterialAndUnit,
    createOperationCatalog,
    createOperationRate,
    createOutsourceSite,
    createPosition,
    createProductionLocation,
    createProductionOperation,
    createProductionOrder,
    createPublishedBom,
    createPurchaseOrder,
    createPurchaseOrderItem,
    createReceipt,
    createSupplier,
    createUnit,
    procurementChain,
    productionChain,
    productionPrerequisites,
    salesChain,
    seedInventoryFact,
  };
}

/**
 * 结算类断言常用的小数工具：业务金额一律以十进制字符串传输，
 * 禁止用 JS 浮点数参与比较（见 docs/design/global-api-contract.md:18）。
 */
const decimal = (value) => new Prisma.Decimal(value ?? 0);

module.exports = { CHILD_VIA_RELATION, ORDER_NO_DELEGATES, createFactories, decimal };

/**
 * B. 成品送检单列表 listSubmissions 新增字段独立探针（2026-11-07）。
 *
 * 不跑实现者的单测，直接 require `apps/api/dist` 的 FinishedGoodsQcService，用手写假 Prisma 重放：
 *   - inspectedQuantity = 该送检单下 status=active 的 QC 记录 inspectedQuantity 合计（corrected 不计）；
 *   - pendingQuantity = max(送检数量 − 已检, 0)，字符串十进制；
 *   - 空 qcRecords → 已检 0、待检 = 送检量；
 *   - 只加字段：原字段（orderNo/status/submittedQuantity/qcRecords/...）逐字段不变；
 *   - 数值是字符串、小数相加不出现浮点尾差、不写库。
 *
 * 运行：node .agent\verify\finished-goods-qc-submission-progress-probe.mjs
 * 产物：.agent/verify/finished-goods-qc-submission-progress-results.json
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DIST = path.join(REPO_ROOT, "apps", "api", "dist", "modules", "production");
const RESULTS_JSON = path.join(REPO_ROOT, ".agent", "verify", "finished-goods-qc-submission-progress-results.json");

const { Prisma } = require("@prisma/client");
const { FinishedGoodsQcService } = require(path.join(DIST, "finished-goods-qc.service.js"));

const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail: detail ?? null });
  return Boolean(condition);
}

const dec = (value) => new Prisma.Decimal(value);

/** 一条送检单（字段名与 Prisma model 一致；qcRecords 里 status 决定是否计入已检）。 */
function submission({ id, submissionNo, orderNo, status = "submitted", submittedQuantity, submissionDate = "2026-11-07", qcRecords = [], unitNameSnapshot = "把", productNameSnapshot = "自动雨伞" }) {
  return {
    id,
    submissionNo,
    orderNo,
    productionOrderId: "po-1",
    productionOrderNoSnapshot: "MO-20261107-0001",
    sourceType: "finished_goods_inbound_notice",
    sourceId: "src-1",
    submittedQuantity: dec(submittedQuantity),
    submissionDate: new Date(`${submissionDate}T00:00:00.000Z`),
    remark: null,
    version: 1,
    status,
    unitId: "u-1",
    unitNameSnapshot,
    productNameSnapshot,
    productSpecificationSnapshot: "22寸×8K",
    qcRecords,
    createdBy: "user-1",
    updatedBy: "user-2",
    createdAt: new Date("2026-11-07T01:00:00.000Z"),
    updatedAt: new Date("2026-11-07T02:00:00.000Z"),
    deletedAt: null
  };
}

const qc = (id, status, inspectedQuantity, deletedAt = null) => ({
  id,
  submissionId: "sub-1",
  status,
  inspectedQuantity: dec(inspectedQuantity),
  deletedAt,
  inspectionDate: new Date("2026-11-07T00:00:00.000Z")
});

const WRITE_OPS = ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"];

/** 深拷贝（Prisma.Decimal 不能 structuredClone：它带着函数属性会抛 DataCloneError）。 */
function cloneValue(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Prisma.Decimal) return new Prisma.Decimal(value.toString());
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
  return value;
}

/** 假 Prisma：只实现本方法用到的 findMany；写操作一调用就抛错。 */
function fakePrisma(rows) {
  const calls = [];
  const writes = [];
  const model = {
    findMany: async (args) => {
      calls.push(args);
      return rows
        .filter((row) => row.deletedAt === null)
        .filter((row) => (args?.where?.orderNo === undefined ? true : row.orderNo === args.where.orderNo))
        .map((row) => cloneValue(row));
    }
  };
  for (const op of WRITE_OPS) model[op] = async () => { writes.push(op); throw new Error(`列表查询不应写库：${op}`); };
  return { calls, writes, finishedGoodsInspectionSubmission: model };
}

const serviceWith = (rows) => {
  const prisma = fakePrisma(rows);
  return { prisma, service: new FinishedGoodsQcService(prisma, { record: async () => {} }) };
};

const pick = (row, keys) => Object.fromEntries(keys.map((key) => [key, row[key]]));

// ---------------------------------------------------------------------------
async function main() {
  // =========================================================================
  // 1) active 合计；corrected 不计
  // =========================================================================
  {
    const rowA = submission({ id: "sub-1", submissionNo: "FGIS-001", orderNo: "SO-1001", submittedQuantity: "100", qcRecords: [qc("qc-1", "active", "40"), qc("qc-2", "corrected", "60")] });
    const { prisma, service } = serviceWith([rowA]);
    const [result] = await service.listSubmissions();
    check("active 合计：一处 active 40 + 一处 corrected 60 → inspectedQuantity = 40（corrected 不计）", result.inspectedQuantity === "40", result.inspectedQuantity);
    check("pendingQuantity = 送检 100 − 已检 40 = 60", result.pendingQuantity === "60", result.pendingQuantity);
    check("已检/待检都是字符串十进制", typeof result.inspectedQuantity === "string" && typeof result.pendingQuantity === "string", { inspected: typeof result.inspectedQuantity, pending: typeof result.pendingQuantity });
    check("查询形状：只查未删除、带 qcRecords(未删除、inspectionDate asc) 与 unit，按 updatedAt desc", prisma.calls.length === 1 && prisma.calls[0].where.deletedAt === null && prisma.calls[0].include.qcRecords.where.deletedAt === null && prisma.calls[0].include.qcRecords.orderBy.inspectionDate === "asc" && prisma.calls[0].include.unit === true && prisma.calls[0].orderBy.updatedAt === "desc", prisma.calls[0]);
    check("没有写库操作", prisma.writes.length === 0, prisma.writes);
  }

  // =========================================================================
  // 2) corrected 独占：已检按 0、待检 = 送检量
  // =========================================================================
  {
    const rowB = submission({ id: "sub-2", submissionNo: "FGIS-002", orderNo: "SO-1002", submittedQuantity: "100", qcRecords: [qc("qc-3", "corrected", "60")] });
    const { service } = serviceWith([rowB]);
    const [result] = await service.listSubmissions();
    check("只有 corrected 记录时 inspectedQuantity = 0", result.inspectedQuantity === "0", result.inspectedQuantity);
    check("只有 corrected 记录时 pendingQuantity = 送检量 100", result.pendingQuantity === "100", result.pendingQuantity);
  }

  // =========================================================================
  // 3) pending 钳 0（历史数据已检 > 送检）
  // =========================================================================
  {
    const rowC = submission({ id: "sub-3", submissionNo: "FGIS-003", orderNo: "SO-1003", submittedQuantity: "100", qcRecords: [qc("qc-4", "active", "150")] });
    const { service } = serviceWith([rowC]);
    const [result] = await service.listSubmissions();
    check("已检 150 > 送检 100：inspectedQuantity 原样 150", result.inspectedQuantity === "150", result.inspectedQuantity);
    check("pendingQuantity 钳到 0（不是 -50）", result.pendingQuantity === "0", result.pendingQuantity);
  }

  // =========================================================================
  // 4) 空 qcRecords
  // =========================================================================
  {
    const rowD = submission({ id: "sub-4", submissionNo: "FGIS-004", orderNo: "SO-1004", submittedQuantity: "100", qcRecords: [] });
    const { service } = serviceWith([rowD]);
    const [result] = await service.listSubmissions();
    check("空 qcRecords：inspectedQuantity = 0", result.inspectedQuantity === "0", result.inspectedQuantity);
    check("空 qcRecords：pendingQuantity = 送检量 100", result.pendingQuantity === "100", result.pendingQuantity);
  }

  // =========================================================================
  // 5) 小数精度（Decimal 相加不出现浮点尾差）
  // =========================================================================
  {
    const rowE = submission({ id: "sub-5", submissionNo: "FGIS-005", orderNo: "SO-1005", submittedQuantity: "100", qcRecords: [qc("qc-5", "active", "0.1"), qc("qc-6", "active", "0.2")] });
    const { service } = serviceWith([rowE]);
    const [result] = await service.listSubmissions();
    check("active 0.1 + 0.2 = 0.3（不是 0.30000000000000004）", result.inspectedQuantity === "0.3", result.inspectedQuantity);
    check("待检 = 99.7（Decimal 减法不带浮点尾差）", result.pendingQuantity === "99.7", result.pendingQuantity);
  }

  // =========================================================================
  // 6) 原字段不变（只加两个字段，不改任何旧字段）
  // =========================================================================
  {
    const original = submission({ id: "sub-6", submissionNo: "FGIS-006", orderNo: "SO-1006", submittedQuantity: "100", qcRecords: [qc("qc-7", "active", "40"), qc("qc-8", "corrected", "10")] });
    const snapshot = cloneValue(original);
    const { service } = serviceWith([original]);
    const [result] = await service.listSubmissions();
    const existingKeys = Object.keys(snapshot);
    const changed = existingKeys.filter((key) => JSON.stringify(result[key]) !== JSON.stringify(snapshot[key]));
    check("原字段逐字段不变（orderNo/status/submittedQuantity/submissionDate/qcRecords/unit/... 一个都没改）", changed.length === 0, changed);
    check("qcRecords 原样带出（corrected 记录仍在，顺序未变，没有被前端/服务层过滤掉）", result.qcRecords.length === 2 && result.qcRecords[1].status === "corrected", result.qcRecords.map((record) => record.status));
    check("只新增了 inspectedQuantity / pendingQuantity 两个键（相对原行）", Object.keys(result).length === existingKeys.length + 2 && "inspectedQuantity" in result && "pendingQuantity" in result, { before: existingKeys.length, after: Object.keys(result).length });
    check("入参行对象没有被就地修改（原 qcRecords 仍是 2 条、原字段值未变）", JSON.stringify(original) === JSON.stringify(snapshot), "mutation detected");
  }

  // =========================================================================
  // 7) 多行 + orderNo 过滤 + 排序透传
  // =========================================================================
  {
    const rows = [
      submission({ id: "sub-a", submissionNo: "FGIS-A", orderNo: "SO-2001", submittedQuantity: "10", qcRecords: [qc("qc-a", "active", "4")] }),
      submission({ id: "sub-b", submissionNo: "FGIS-B", orderNo: "SO-2002", submittedQuantity: "20", qcRecords: [qc("qc-b", "active", "5"), qc("qc-b2", "active", "5")] }),
      submission({ id: "sub-c", submissionNo: "FGIS-C", orderNo: "SO-2001", submittedQuantity: "30", qcRecords: [] })
    ];
    const unfiltered = await serviceWith(rows).service.listSubmissions();
    check("多行各自独立计算（4/6、10/10、0/30）", JSON.stringify(unfiltered.map((row) => [row.inspectedQuantity, row.pendingQuantity])) === JSON.stringify([["4", "6"], ["10", "10"], ["0", "30"]]), unfiltered.map((row) => [row.inspectedQuantity, row.pendingQuantity]));
    const { prisma: filteredPrisma, service: filteredService } = serviceWith(rows);
    const filtered = await filteredService.listSubmissions("SO-2001");
    check("orderNo 过滤：查询 where 带 orderNo、结果只含该订单两行", filteredPrisma.calls[0].where.orderNo === "SO-2001" && filtered.length === 2 && filtered.every((row) => row.orderNo === "SO-2001"), { where: filteredPrisma.calls[0].where, orders: filtered.map((row) => row.orderNo) });
  }

  // =========================================================================
  // 8) 已删除送检单不进入列表
  // =========================================================================
  {
    const deleted = { ...submission({ id: "sub-del", submissionNo: "FGIS-DEL", orderNo: "SO-3001", submittedQuantity: "10" }), deletedAt: new Date() };
    const alive = submission({ id: "sub-alive", submissionNo: "FGIS-ALIVE", orderNo: "SO-3002", submittedQuantity: "10" });
    const { service } = serviceWith([deleted, alive]);
    const result = await service.listSubmissions();
    check("软删的送检单不出现在列表（where.deletedAt = null）", result.length === 1 && result[0].submissionNo === "FGIS-ALIVE", result.map((row) => row.submissionNo));
  }

  // =========================================================================
  const failed = checks.filter((item) => !item.ok);
  const result = {
    generatedAt: new Date().toISOString(),
    script: path.relative(REPO_ROOT, import.meta.filename),
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    checks
  };
  fs.mkdirSync(path.dirname(RESULTS_JSON), { recursive: true });
  fs.writeFileSync(RESULTS_JSON, JSON.stringify(result, null, 2), "utf8");
  for (const item of checks) console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.ok || item.detail === null ? "" : `  ${JSON.stringify(item.detail)}`}`);
  console.log(`\nB listSubmissions 新字段探针：${result.summary.passed}/${result.summary.total} 条断言通过`);
  console.log(`结果 JSON：${RESULTS_JSON}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

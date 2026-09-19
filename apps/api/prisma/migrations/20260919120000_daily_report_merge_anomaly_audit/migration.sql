-- 操作人与操作时间全站治理（第二十四轮）：日报合并异常补「谁解决的 / 最后改动时间」。
--
-- 背景：这张表会被更新（production-daily-alerts.service.ts 的 resolveMergeAnomaly 把 status 改成
-- resolved 并写 resolvedAt），但此前行上没有任何「谁改的、什么时候改的」——只在 audit_events 里。
-- 全站盘点认定它是数据层唯一的真缺口：
--   docs/design/operator-and-timestamp-governance-inventory-2026-09-16.md 第 3.1 节。
--
-- 为什么没有加 created_by：异常是系统按日报数据**自动归并**出来的，不存在「创建人」这个业务事实，
-- 需要的只是「谁解决的」。（对比之下，另外三张审计字段不全的表 AuditEvent / InventoryFact / UserRole
-- 是追加型账本与纯关联表语义，盘点结论是**不加**。）
--
-- updated_at 的回填**不是编造**，是可推导的：
--   * 已解决的 = resolved_at（最后一次写库就是那次解决）；
--   * 未解决的 = created_at（创建本身就是最后一次写库；Prisma 建行时 updatedAt 即等于此刻）。
--
-- updated_by 只对「已解决」的行回填，来源是 audit_events 里该对象的解决事件 actor_id——
-- 那是真实的操作人，不是猜测。其余行（从未被人解决的自动异常）确实无从得知，
-- 因此这一列**可空**，界面显示「—」；此后所有写路径都会带上它。
--
-- 说明：本迁移只加列与回填，不改任何业务数据语义；回填语句对空表/无匹配行均为无操作。
ALTER TABLE "daily_report_merge_anomalies" ADD COLUMN "updated_at" TIMESTAMP(3);
ALTER TABLE "daily_report_merge_anomalies" ADD COLUMN "updated_by" UUID;

UPDATE "daily_report_merge_anomalies"
SET "updated_at" = COALESCE("resolved_at", "created_at")
WHERE "updated_at" IS NULL;

UPDATE "daily_report_merge_anomalies" AS anomaly
SET "updated_by" = (
  SELECT event."actor_id"
  FROM "audit_events" AS event
  WHERE event."entity_type" = 'daily_report_merge_anomaly'
    AND event."entity_id" = anomaly."id"
    AND event."actor_id" IS NOT NULL
  ORDER BY event."created_at" DESC
  LIMIT 1
)
WHERE anomaly."status" = 'resolved'
  AND anomaly."updated_by" IS NULL;

ALTER TABLE "daily_report_merge_anomalies" ALTER COLUMN "updated_at" SET NOT NULL;

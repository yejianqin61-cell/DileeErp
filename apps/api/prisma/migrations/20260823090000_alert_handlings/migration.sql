CREATE TABLE "alert_handlings" (
  "id" UUID NOT NULL,
  "source_type" VARCHAR(50) NOT NULL,
  "source_id" UUID NOT NULL,
  "alert_type" VARCHAR(50) NOT NULL,
  "status" VARCHAR(30) NOT NULL DEFAULT 'acknowledged',
  "remark" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  CONSTRAINT "alert_handlings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "alert_handlings_source_type_source_id_alert_type_key" ON "alert_handlings"("source_type", "source_id", "alert_type");
CREATE INDEX "alert_handlings_status_updated_at_idx" ON "alert_handlings"("status", "updated_at");

CREATE TABLE "state_records" (
    "id" UUID NOT NULL,
    "machine_key" VARCHAR(80) NOT NULL,
    "entity_type" VARCHAR(80) NOT NULL,
    "entity_id" UUID NOT NULL,
    "current_state_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "state_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "state_changes" (
    "id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "from_state_id" UUID,
    "to_state_id" UUID NOT NULL,
    "remark" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    CONSTRAINT "state_changes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "state_records_machine_key_entity_type_entity_id_key" ON "state_records"("machine_key", "entity_type", "entity_id");
CREATE INDEX "state_changes_record_id_created_at_idx" ON "state_changes"("record_id", "created_at");
ALTER TABLE "state_records" ADD CONSTRAINT "state_records_current_state_id_fkey" FOREIGN KEY ("current_state_id") REFERENCES "state_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "state_changes" ADD CONSTRAINT "state_changes_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "state_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "agent_gap_candidates" (
  "id" UUID NOT NULL,
  "nearest_operation" VARCHAR(60) NOT NULL,
  "missing" VARCHAR(20) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'accumulating',
  "dispatched_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_gap_candidates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_gap_reports" (
  "id" UUID NOT NULL,
  "candidate_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "missing_detail" VARCHAR(200) NOT NULL,
  "missing_param" VARCHAR(20),
  "needed_fields" JSONB NOT NULL,
  "unverified_fields" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_gap_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_gap_candidates_nearest_operation_missing_key" ON "agent_gap_candidates"("nearest_operation", "missing");
CREATE UNIQUE INDEX "agent_gap_reports_candidate_id_run_id_key" ON "agent_gap_reports"("candidate_id", "run_id");

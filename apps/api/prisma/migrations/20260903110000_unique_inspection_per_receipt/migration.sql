CREATE TEMP TABLE incoming_inspection_ranked AS
  SELECT id, purchase_receipt_id,
         row_number() OVER (PARTITION BY purchase_receipt_id ORDER BY created_at, id) AS rn,
         sum(inspected_quantity) OVER (PARTITION BY purchase_receipt_id) AS inspected_total,
         sum(accepted_quantity) OVER (PARTITION BY purchase_receipt_id) AS accepted_total,
         sum(conditional_quantity) OVER (PARTITION BY purchase_receipt_id) AS conditional_total,
         sum(rejected_quantity) OVER (PARTITION BY purchase_receipt_id) AS rejected_total
  FROM incoming_inspections
  WHERE deleted_at IS NULL;

UPDATE incoming_inspections i
SET inspected_quantity = r.inspected_total,
    accepted_quantity = r.accepted_total,
    conditional_quantity = r.conditional_total,
    rejected_quantity = r.rejected_total,
    updated_at = now()
FROM incoming_inspection_ranked r
WHERE i.id = r.id AND r.rn = 1;

UPDATE incoming_inspections i
SET deleted_at = now(), updated_at = now()
WHERE i.id IN (SELECT id FROM incoming_inspection_ranked WHERE rn > 1);
DROP TABLE incoming_inspection_ranked;

CREATE UNIQUE INDEX IF NOT EXISTS incoming_inspections_active_receipt_key
  ON incoming_inspections (purchase_receipt_id)
  WHERE deleted_at IS NULL;

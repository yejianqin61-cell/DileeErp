-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(100) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_key" VARCHAR(80) NOT NULL,
    "module_key" VARCHAR(80) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_key","module_key")
);

-- CreateTable
CREATE TABLE "dictionary_types" (
    "id" UUID NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "dictionary_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dictionary_items" (
    "id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "dictionary_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_definitions" (
    "id" UUID NOT NULL,
    "machine_key" VARCHAR(80) NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "state_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
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

-- CreateTable
CREATE TABLE "state_transitions" (
    "id" UUID NOT NULL,
    "machine_key" VARCHAR(80) NOT NULL,
    "from_state_id" UUID NOT NULL,
    "to_state_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "state_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "storage_key" VARCHAR(500) NOT NULL,
    "mime_type" VARCHAR(150) NOT NULL,
    "file_size" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment_links" (
    "id" UUID NOT NULL,
    "attachment_id" UUID NOT NULL,
    "entity_type" VARCHAR(80) NOT NULL,
    "entity_id" UUID NOT NULL,
    "remark" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "attachment_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "entity_type" VARCHAR(80) NOT NULL,
    "entity_id" UUID,
    "actor_id" UUID,
    "order_no" VARCHAR(100),
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "customer_code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "country_region" VARCHAR(100),
    "address" VARCHAR(500),
    "payment_terms" VARCHAR(200),
    "currency" VARCHAR(10),
    "remark" VARCHAR(1000),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_contacts" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "position" VARCHAR(100),
    "phone" VARCHAR(50),
    "email" VARCHAR(200),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "remark" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_orders" (
    "id" UUID NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "customer_id" UUID NOT NULL,
    "contact_id" UUID,
    "customer_snapshot" JSONB NOT NULL,
    "contact_snapshot" JSONB,
    "customer_po_no" VARCHAR(100),
    "external_contract_no" VARCHAR(100),
    "order_date" TIMESTAMP(3) NOT NULL,
    "product_name" VARCHAR(200) NOT NULL,
    "product_spec" VARCHAR(1000),
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" VARCHAR(30) NOT NULL,
    "delivery_date" TIMESTAMP(3),
    "currency" VARCHAR(10) NOT NULL,
    "unit_price" DECIMAL(18,4),
    "total_amount" DECIMAL(18,4),
    "tax_rate" DECIMAL(8,4),
    "settlement_unit_price" DECIMAL(18,4),
    "receivable_amount" DECIMAL(18,4),
    "settlement_method" VARCHAR(30),
    "local_currency_amount" DECIMAL(18,4),
    "item_no" VARCHAR(100),
    "reorder_from_order_no" VARCHAR(100),
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "extension_data" JSONB NOT NULL DEFAULT '{}',
    "factory" VARCHAR(100),
    "completion_remark" VARCHAR(100),
    "attention_note" VARCHAR(2000),
    "shipping_mark_front" VARCHAR(2000),
    "shipping_mark_side" VARCHAR(2000),
    "fabric_usage_canopy" DECIMAL(18,4),
    "fabric_usage_strap" DECIMAL(18,4),
    "fabric_usage_wood_ear" DECIMAL(18,4),
    "fabric_usage_top" DECIMAL(18,4),
    "fabric_usage_bag" DECIMAL(18,4),
    "rib_spec" VARCHAR(1000),
    "canopy_spec" VARCHAR(1000),
    "handle_spec" VARCHAR(1000),
    "handle_strap_spec" VARCHAR(1000),
    "tail_spec" VARCHAR(1000),
    "runner_spec" VARCHAR(1000),
    "strap_spec" VARCHAR(1000),
    "strap_fastener_spec" VARCHAR(1000),
    "inner_label_spec" VARCHAR(1000),
    "woven_label_spec" VARCHAR(1000),
    "hang_tag_spec" VARCHAR(1000),
    "opp_spec" VARCHAR(1000),
    "bag_spec" VARCHAR(1000),
    "packaging_spec" VARCHAR(1000),
    "top_fabric_spec" VARCHAR(1000),
    "wood_ear_spec" VARCHAR(1000),
    "keychain_spec" VARCHAR(1000),
    "printing_spec" VARCHAR(1000),
    "sample_requirement" VARCHAR(1000),
    "cutting_requirement" VARCHAR(1000),
    "edge_requirement" VARCHAR(1000),
    "joining_requirement" VARCHAR(1000),
    "top_stitch_requirement" VARCHAR(1000),
    "sewing_requirement" VARCHAR(1000),
    "strap_requirement" VARCHAR(1000),
    "hang_tag_note" VARCHAR(1000),
    "qc_requirement" VARCHAR(1000),
    "spec_detail_labels" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_spec_details" (
    "id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "group_name" VARCHAR(100) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "color" VARCHAR(100),
    "barcode" VARCHAR(100),
    "quantity" DECIMAL(18,4),
    "unit" VARCHAR(30),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "sales_order_spec_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_material_refs" (
    "id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "spec_key" VARCHAR(50) NOT NULL,
    "material_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "sales_order_material_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_material_extras" (
    "id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "label" VARCHAR(50) NOT NULL,
    "content" VARCHAR(1000),
    "material_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "sales_order_material_extras_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_versions" (
    "id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "sales_order_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "boms" (
    "id" UUID NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "sales_order_version_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "form_definition_id" UUID,
    "extension_data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "boms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_definitions" (
    "id" UUID NOT NULL,
    "form_key" VARCHAR(80) NOT NULL,
    "version" INTEGER NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "form_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_fields" (
    "id" UUID NOT NULL,
    "form_definition_id" UUID NOT NULL,
    "field_key" VARCHAR(80) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "field_type" VARCHAR(30) NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "options" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "form_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bom_items" (
    "id" UUID NOT NULL,
    "bom_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "material_name" VARCHAR(200) NOT NULL,
    "model" VARCHAR(200),
    "specification_model" VARCHAR(200),
    "color" VARCHAR(100),
    "unit_id" UUID,
    "material_snapshot" JSONB NOT NULL,
    "required_quantity" DECIMAL(18,4) NOT NULL,
    "sequence" INTEGER,
    "production_batch_base" DECIMAL(18,4),
    "base_usage" DECIMAL(18,4),
    "approved_usage" DECIMAL(18,4),
    "unit" VARCHAR(30) NOT NULL,
    "loss_quantity" DECIMAL(18,4),
    "loss_rate" DECIMAL(8,4),
    "extension_data" JSONB NOT NULL DEFAULT '{}',
    "supplier_id" UUID,
    "supplier_snapshot" JSONB,
    "reference_unit_price" DECIMAL(18,4),
    "reference_currency" VARCHAR(10),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "bom_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "units" (
    "id" UUID NOT NULL,
    "name" VARCHAR(30) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "remark" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "materials" (
    "id" UUID NOT NULL,
    "material_code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "specification_model" VARCHAR(200) DEFAULT '',
    "color" VARCHAR(100) DEFAULT '',
    "default_unit_id" UUID NOT NULL,
    "material_type" VARCHAR(30) NOT NULL DEFAULT 'raw_material',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_images" (
    "id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "data" BYTEA NOT NULL,
    "mime_type" VARCHAR(50) NOT NULL DEFAULT 'image/webp',
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "material_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "supplier_code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "contact_name" VARCHAR(100),
    "phone" VARCHAR(50),
    "address" VARCHAR(300),
    "settlement_info" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "purchase_order_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "bom_id" UUID,
    "bom_version" INTEGER,
    "bom_snapshot" JSONB,
    "supplier_id" UUID,
    "supplier_snapshot" JSONB,
    "purchase_date" TIMESTAMP(3),
    "expected_date" TIMESTAMP(3),
    "currency" VARCHAR(10) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "total_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "extension_data" JSONB NOT NULL DEFAULT '{}',
    "remark" VARCHAR(1000),
    "payment_terms" VARCHAR(50),
    "delivery_terms" VARCHAR(1000),
    "delivery_address" VARCHAR(300),
    "supplier_reply" VARCHAR(1000),
    "supplier_signed" VARCHAR(200),
    "supervisor_signature" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "material_snapshot" JSONB NOT NULL,
    "unit_id" UUID NOT NULL,
    "unit_snapshot" JSONB NOT NULL,
    "bom_item_id" UUID,
    "supplier_id" UUID,
    "supplier_snapshot" JSONB,
    "model" VARCHAR(200),
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "tax_rate" DECIMAL(8,4),
    "extra_fee" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "amount" DECIMAL(18,4) NOT NULL,
    "expected_date" TIMESTAMP(3),
    "extension_data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_plans" (
    "id" UUID NOT NULL,
    "plan_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "bom_id" UUID NOT NULL,
    "bom_version" INTEGER,
    "bom_snapshot" JSONB,
    "extension_data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "purchase_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_plan_items" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "material_snapshot" JSONB NOT NULL,
    "unit_id" UUID NOT NULL,
    "unit_snapshot" JSONB NOT NULL,
    "bom_item_id" UUID,
    "supplier_id" UUID,
    "supplier_snapshot" JSONB,
    "model" VARCHAR(200),
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'CNY',
    "expected_date" TIMESTAMP(3),
    "purchase_order_item_id" UUID,
    "sequence" INTEGER,
    "extension_data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "purchase_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_receipts" (
    "id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "purchase_order_item_id" UUID NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "receipt_no" VARCHAR(100) NOT NULL,
    "reference_no" VARCHAR(100),
    "received_date" TIMESTAMP(3) NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'received',
    "extension_data" JSONB NOT NULL DEFAULT '{}',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "purchase_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incoming_inspections" (
    "id" UUID NOT NULL,
    "purchase_receipt_id" UUID NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "inspected_quantity" DECIMAL(18,4) NOT NULL,
    "accepted_quantity" DECIMAL(18,4) NOT NULL,
    "conditional_quantity" DECIMAL(18,4) NOT NULL,
    "rejected_quantity" DECIMAL(18,4) NOT NULL,
    "qc_result" VARCHAR(30),
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "extension_data" JSONB NOT NULL DEFAULT '{}',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "incoming_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_material_inbound_notices" (
    "id" UUID NOT NULL,
    "notice_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "purchase_order_item_id" UUID NOT NULL,
    "purchase_receipt_id" UUID NOT NULL,
    "incoming_inspection_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "notified_quantity" DECIMAL(18,4) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "notified_by" UUID NOT NULL,
    "notified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by" UUID,
    "received_at" TIMESTAMP(3),
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "raw_material_inbound_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_material_inbounds" (
    "id" UUID NOT NULL,
    "inbound_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "purchase_order_item_id" UUID NOT NULL,
    "purchase_receipt_id" UUID NOT NULL,
    "incoming_inspection_id" UUID NOT NULL,
    "inbound_notice_id" UUID,
    "material_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "settlement_unit_price" DECIMAL(18,4),
    "settlement_total_amount" DECIMAL(18,4),
    "settlement_amount_reason" VARCHAR(1000),
    "quantity" DECIMAL(18,4) NOT NULL,
    "inventory_category" VARCHAR(30) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "idempotency_key" VARCHAR(200) NOT NULL,
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    "unit_id" UUID NOT NULL,

    CONSTRAINT "raw_material_inbounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_facts" (
    "id" UUID NOT NULL,
    "raw_material_inbound_id" UUID,
    "material_id" UUID,
    "inventory_category" VARCHAR(30) NOT NULL,
    "quantity_delta" DECIMAL(18,4) NOT NULL,
    "source_type" VARCHAR(50),
    "source_id" UUID,
    "source_version" VARCHAR(50),
    "order_no" VARCHAR(100),
    "production_order_id" UUID,
    "raw_material_movement_line_id" UUID,
    "stocktake_line_id" UUID,
    "finished_goods_inbound_id" UUID,
    "finished_goods_defective_id" UUID,
    "finished_goods_outbound_id" UUID,
    "customer_return_id" UUID,
    "product_name_snapshot" VARCHAR(200),
    "product_specification_snapshot" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "unit_id" UUID NOT NULL,

    CONSTRAINT "inventory_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payable_sources" (
    "id" UUID NOT NULL,
    "raw_material_inbound_id" UUID,
    "purchase_receipt_id" UUID,
    "order_no" VARCHAR(100) NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "purchase_order_item_id" UUID NOT NULL,
    "material_id" UUID,
    "supplier_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "settlement_unit_price" DECIMAL(18,4),
    "settlement_total_amount" DECIMAL(18,4),
    "settlement_amount_reason" VARCHAR(1000),
    "qc_result" VARCHAR(30),
    "accepted_quantity" DECIMAL(18,4),
    "conditional_quantity" DECIMAL(18,4),
    "rejected_quantity" DECIMAL(18,4),
    "actual_inbound_quantity" DECIMAL(18,4),
    "unit_price" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "tax_rate" DECIMAL(8,4),
    "amount" DECIMAL(18,4) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending_finance',
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "payable_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outsource_logistics_batches" (
    "id" UUID NOT NULL,
    "batch_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "production_order_id" UUID NOT NULL,
    "outsource_location_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "purchase_order_item_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "planned_quantity" DECIMAL(18,4) NOT NULL,
    "dispatched_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "dispatch_date" DATE,
    "dispatch_proof_remark" VARCHAR(1000),
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "outsource_logistics_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outsource_receipts" (
    "id" UUID NOT NULL,
    "logistics_batch_id" UUID NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "receipt_date" DATE NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "receiver_name" VARCHAR(100),
    "proof_remark" VARCHAR(1000),
    "difference_reason" VARCHAR(1000),
    "idempotency_key" VARCHAR(200) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'received',
    "reversal_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "reversal_reason" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "outsource_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outsource_payable_sources" (
    "id" UUID NOT NULL,
    "outsource_receipt_id" UUID NOT NULL,
    "logistics_batch_id" UUID NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "purchase_order_item_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "tax_rate" DECIMAL(8,4),
    "amount" DECIMAL(18,4) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending_finance',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "outsource_payable_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payable_entries" (
    "id" UUID NOT NULL,
    "payable_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100),
    "supplier_id" UUID NOT NULL,
    "source_type" VARCHAR(40) NOT NULL,
    "payable_source_id" UUID,
    "outsource_payable_source_id" UUID,
    "source_no_snapshot" VARCHAR(100) NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "tax_rate" DECIMAL(8,4),
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "confirmation_date" DATE NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "subject_id" UUID,
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    "purchase_order_id" UUID,
    "purchase_order_item_id" UUID,
    "outsource_logistics_batch_id" UUID,

    CONSTRAINT "supplier_payable_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payments" (
    "id" UUID NOT NULL,
    "payment_no" VARCHAR(100) NOT NULL,
    "idempotency_key" VARCHAR(200),
    "supplier_id" UUID NOT NULL,
    "order_no" VARCHAR(100),
    "payment_date" DATE NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "payment_method" VARCHAR(50) NOT NULL,
    "bank_reference" VARCHAR(200),
    "payee_name" VARCHAR(200),
    "bank_id" UUID,
    "subject_id" UUID,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payment_allocations" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "payable_entry_id" UUID NOT NULL,
    "order_no" VARCHAR(100),
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'active',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "supplier_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outsource_return_transfers" (
    "id" UUID NOT NULL,
    "transfer_no" VARCHAR(100) NOT NULL,
    "transfer_type" VARCHAR(40) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "production_order_id" UUID NOT NULL,
    "logistics_batch_id" UUID,
    "material_id" UUID,
    "unit_id" UUID NOT NULL,
    "product_description" VARCHAR(500),
    "quantity" DECIMAL(18,4) NOT NULL,
    "transfer_date" DATE NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "finished_goods_qc_status" VARCHAR(30) NOT NULL DEFAULT 'not_submitted',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "outsource_return_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outsource_direct_shipments" (
    "id" UUID NOT NULL,
    "shipment_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "production_order_id" UUID NOT NULL,
    "product_description" VARCHAR(500) NOT NULL,
    "unit_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "shipment_date" DATE NOT NULL,
    "logistics_reference" VARCHAR(500),
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "reversal_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "reversal_reason" VARCHAR(1000),
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "outsource_direct_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_goods_inspection_submissions" (
    "id" UUID NOT NULL,
    "submission_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "production_order_id" UUID NOT NULL,
    "source_type" VARCHAR(40) NOT NULL,
    "source_id" UUID NOT NULL,
    "production_order_no_snapshot" VARCHAR(100) NOT NULL,
    "product_name_snapshot" VARCHAR(200),
    "product_specification_snapshot" VARCHAR(1000),
    "unit_id" UUID NOT NULL,
    "unit_name_snapshot" VARCHAR(30) NOT NULL,
    "submitted_quantity" DECIMAL(18,4) NOT NULL,
    "submission_date" DATE NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "remark" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "finished_goods_inspection_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_goods_qc_records" (
    "id" UUID NOT NULL,
    "qc_no" VARCHAR(100) NOT NULL,
    "submission_id" UUID NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "production_order_id" UUID NOT NULL,
    "source_type" VARCHAR(40) NOT NULL,
    "source_id" UUID NOT NULL,
    "inspection_date" DATE NOT NULL,
    "inspected_quantity" DECIMAL(18,4) NOT NULL,
    "qualified_quantity" DECIMAL(18,4) NOT NULL,
    "conditional_accept_quantity" DECIMAL(18,4) NOT NULL,
    "rejected_quantity" DECIMAL(18,4) NOT NULL,
    "conclusion" VARCHAR(30) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'active',
    "rejection_reason" VARCHAR(1000),
    "correction_reason" VARCHAR(1000),
    "corrected_at" TIMESTAMP(3),
    "remark" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "finished_goods_qc_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_goods_inbound_notices" (
    "id" UUID NOT NULL,
    "notice_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "production_order_id" UUID NOT NULL,
    "production_order_operation_id" UUID NOT NULL,
    "production_order_no_snapshot" VARCHAR(100) NOT NULL,
    "operation_name_snapshot" VARCHAR(150) NOT NULL,
    "product_name_snapshot" VARCHAR(200),
    "product_specification_snapshot" VARCHAR(1000),
    "unit_id" UUID NOT NULL,
    "unit_name_snapshot" VARCHAR(30) NOT NULL,
    "notice_quantity" DECIMAL(18,4) NOT NULL,
    "notice_date" DATE NOT NULL,
    "batch_no" VARCHAR(100),
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "remark" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "finished_goods_inbound_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_goods_inbounds" (
    "id" UUID NOT NULL,
    "inbound_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "production_order_id" UUID NOT NULL,
    "qc_record_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "product_name_snapshot" VARCHAR(200),
    "product_specification_snapshot" VARCHAR(1000),
    "quantity" DECIMAL(18,4) NOT NULL,
    "inventory_category" VARCHAR(30) NOT NULL DEFAULT 'finished_goods',
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "idempotency_key" VARCHAR(200) NOT NULL,
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "finished_goods_inbounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_goods_defectives" (
    "id" UUID NOT NULL,
    "defective_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "production_order_id" UUID NOT NULL,
    "qc_record_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "product_name_snapshot" VARCHAR(200),
    "product_specification_snapshot" VARCHAR(1000),
    "quantity" DECIMAL(18,4) NOT NULL,
    "inventory_category" VARCHAR(30) NOT NULL DEFAULT 'defective_goods',
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "disposition" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "idempotency_key" VARCHAR(200) NOT NULL,
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "finished_goods_defectives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_goods_outbounds" (
    "id" UUID NOT NULL,
    "outbound_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "production_order_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "product_name_snapshot" VARCHAR(200),
    "product_specification_snapshot" VARCHAR(1000),
    "quantity" DECIMAL(18,4) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "shipment_date" DATE,
    "carrier" VARCHAR(200),
    "tracking_no" VARCHAR(200),
    "packing_list_no" VARCHAR(100),
    "invoice_no" VARCHAR(100),
    "signed_at" TIMESTAMP(3),
    "signature_reference" VARCHAR(500),
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "idempotency_key" VARCHAR(200) NOT NULL,
    "risk_reason" VARCHAR(1000),
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    "outbound_notice_id" UUID,

    CONSTRAINT "finished_goods_outbounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_goods_outbound_notices" (
    "id" UUID NOT NULL,
    "notice_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "production_order_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "product_name_snapshot" VARCHAR(200),
    "product_specification_snapshot" VARCHAR(1000),
    "unit_id" UUID NOT NULL,
    "unit_name_snapshot" VARCHAR(30),
    "inbound_quantity" DECIMAL(18,4) NOT NULL,
    "outbound_quantity" DECIMAL(18,4) NOT NULL,
    "notice_quantity" DECIMAL(18,4) NOT NULL,
    "shipped_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "notified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notified_by" UUID NOT NULL,
    "remark" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "finished_goods_outbound_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_returns" (
    "id" UUID NOT NULL,
    "return_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "production_order_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "product_name_snapshot" VARCHAR(200),
    "product_specification_snapshot" VARCHAR(1000),
    "quantity" DECIMAL(18,4) NOT NULL,
    "return_date" DATE NOT NULL,
    "destination" VARCHAR(30) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "idempotency_key" VARCHAR(200) NOT NULL,
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "customer_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receivable_sources" (
    "id" UUID NOT NULL,
    "source_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "outbound_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" VARCHAR(30) NOT NULL,
    "unit_price" DECIMAL(18,4),
    "tax_rate" DECIMAL(8,4),
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "amount_reason" VARCHAR(1000),
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "due_date" DATE,
    "invoice_no" VARCHAR(100),
    "invoice_date" DATE,
    "signed_at_snapshot" TIMESTAMP(3),
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "receivable_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_payments" (
    "id" UUID NOT NULL,
    "payment_no" VARCHAR(100) NOT NULL,
    "idempotency_key" VARCHAR(200),
    "customer_id" UUID NOT NULL,
    "order_no" VARCHAR(100),
    "payment_date" DATE NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "payment_method" VARCHAR(50) NOT NULL,
    "bank_reference" VARCHAR(200),
    "payer_name" VARCHAR(200),
    "bank_id" UUID,
    "subject_id" UUID,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    "sales_order_id" UUID,

    CONSTRAINT "customer_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receivable_allocations" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "receivable_source_id" UUID NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'active',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "receivable_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receivable_adjustments" (
    "id" UUID NOT NULL,
    "adjustment_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "sales_order_id" UUID,
    "customer_id" UUID NOT NULL,
    "receivable_source_id" UUID,
    "adjustment_type" VARCHAR(30) NOT NULL,
    "effect" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "adjustment_date" DATE NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "receivable_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receivable_reconciliations" (
    "id" UUID NOT NULL,
    "reconciliation_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100),
    "sales_order_id" UUID,
    "customer_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "receivable_amount_snapshot" DECIMAL(18,4) NOT NULL,
    "payment_amount_snapshot" DECIMAL(18,4) NOT NULL,
    "adjustment_amount_snapshot" DECIMAL(18,4) NOT NULL,
    "system_balance" DECIMAL(18,4) NOT NULL,
    "external_balance" DECIMAL(18,4) NOT NULL,
    "difference" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "bank_id" UUID,
    "subject_id" UUID,
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "resolution_remark" VARCHAR(1000),
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "receivable_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payable_reconciliations" (
    "id" UUID NOT NULL,
    "reconciliation_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100),
    "purchase_order_id" UUID,
    "supplier_id" UUID NOT NULL,
    "bank_id" UUID,
    "subject_id" UUID,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "payable_amount_snapshot" DECIMAL(18,4) NOT NULL,
    "payment_amount_snapshot" DECIMAL(18,4) NOT NULL,
    "adjustment_amount_snapshot" DECIMAL(18,4) NOT NULL,
    "system_balance" DECIMAL(18,4) NOT NULL,
    "external_balance" DECIMAL(18,4) NOT NULL,
    "difference" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "resolution_remark" VARCHAR(1000),
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "supplier_payable_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_flow_entries" (
    "id" UUID NOT NULL,
    "entry_no" VARCHAR(100) NOT NULL,
    "entry_date" DATE NOT NULL,
    "counterparty_name" VARCHAR(200) NOT NULL,
    "direction" VARCHAR(10) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "exchange_rate" DECIMAL(18,6),
    "local_amount" DECIMAL(18,4),
    "subject_id" UUID NOT NULL,
    "settlement_method" VARCHAR(50),
    "settlement_account_id" UUID,
    "bank_id" UUID,
    "source_type" VARCHAR(40),
    "source_id" UUID,
    "payment_nature" VARCHAR(20),
    "order_no" VARCHAR(100),
    "status" VARCHAR(30) NOT NULL DEFAULT 'posted',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "cash_flow_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_subjects" (
    "id" UUID NOT NULL,
    "category" VARCHAR(30) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "balance_direction" VARCHAR(4),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "accounting_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vouchers" (
    "id" UUID NOT NULL,
    "voucher_no" VARCHAR(100) NOT NULL,
    "voucher_date" DATE NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "source_type" VARCHAR(40) NOT NULL,
    "source_id" UUID,
    "summary" VARCHAR(500) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "debit_total" DECIMAL(18,4) NOT NULL,
    "credit_total" DECIMAL(18,4) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_opening_balances" (
    "id" UUID NOT NULL,
    "as_of_date" DATE NOT NULL,
    "subject_key" VARCHAR(200) NOT NULL,
    "subject_label" VARCHAR(200) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "direction" VARCHAR(10) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "accounting_opening_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" UUID NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_lines" (
    "id" UUID NOT NULL,
    "voucher_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "direction" VARCHAR(10) NOT NULL,
    "subject_key" VARCHAR(200) NOT NULL,
    "subject_label" VARCHAR(200) NOT NULL,
    "summary" VARCHAR(500) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "cash_flow_entry_id" UUID,
    "bank_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "voucher_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_orders" (
    "id" UUID NOT NULL,
    "production_order_no" VARCHAR(100) NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "bom_id" UUID,
    "bom_version" INTEGER,
    "bom_snapshot" JSONB,
    "production_order_type" VARCHAR(30) NOT NULL DEFAULT 'standard',
    "parent_production_order_id" UUID,
    "execution_mode" VARCHAR(20) NOT NULL,
    "execution_location_id" UUID NOT NULL,
    "planned_quantity" DECIMAL(18,4) NOT NULL,
    "unit_id" UUID NOT NULL,
    "product_specification" VARCHAR(1000),
    "production_process_note" VARCHAR(2000),
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "planned_started_on" DATE,
    "delivery_due_on" DATE,
    "started_on" DATE,
    "completed_on" DATE,
    "actual_completed_quantity" DECIMAL(18,4),
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "production_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_material_movements" (
    "id" UUID NOT NULL,
    "movement_no" VARCHAR(100) NOT NULL,
    "document_type" VARCHAR(30) NOT NULL DEFAULT 'issue',
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "production_order_id" UUID NOT NULL,
    "production_order_operation_id" UUID,
    "order_no" VARCHAR(100) NOT NULL,
    "business_date" DATE NOT NULL,
    "reason" VARCHAR(1000),
    "remark" VARCHAR(1000),
    "submitted_at" TIMESTAMP(3),
    "idempotency_key" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "raw_material_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_material_movement_lines" (
    "id" UUID NOT NULL,
    "movement_id" UUID NOT NULL,
    "material_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "bom_reference_quantity" DECIMAL(18,4),
    "source_issue_line_id" UUID,
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "raw_material_movement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_material_movement_risks" (
    "id" UUID NOT NULL,
    "movement_id" UUID NOT NULL,
    "line_id" UUID,
    "risk_type" VARCHAR(50) NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "reason" VARCHAR(1000) NOT NULL,
    "confirmed_by" UUID NOT NULL,
    "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "raw_material_movement_risks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_order_operations" (
    "id" UUID NOT NULL,
    "production_order_id" UUID NOT NULL,
    "operation_catalog_id" UUID NOT NULL,
    "operation_name_snapshot" VARCHAR(150) NOT NULL,
    "unit_id" UUID NOT NULL,
    "sequence_no" INTEGER NOT NULL,
    "target_quantity" DECIMAL(18,4) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "cancellation_reason" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "production_order_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "remark" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "remark" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "employee_no" VARCHAR(80) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "department_id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "employee_type" VARCHAR(40) NOT NULL,
    "employment_status" VARCHAR(30) NOT NULL DEFAULT 'active',
    "user_id" UUID,
    "hired_on" DATE,
    "left_on" DATE,
    "remark" VARCHAR(500),
    "birth_date" DATE,
    "gender" VARCHAR(10),
    "ethnicity" VARCHAR(50),
    "id_card_no" VARCHAR(30),
    "education" VARCHAR(50),
    "blood_type" VARCHAR(10),
    "social_insurance" BOOLEAN,
    "commercial_insurance" BOOLEAN,
    "contract_start" DATE,
    "contract_end" DATE,
    "labor_contract_start" DATE,
    "labor_contract_end" DATE,
    "home_address" VARCHAR(500),
    "current_address" VARCHAR(500),
    "phone" VARCHAR(50),
    "emergency_contact" VARCHAR(100),
    "emergency_phone" VARCHAR(50),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_locations" (
    "id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "location_type" VARCHAR(30) NOT NULL,
    "contact_name" VARCHAR(100),
    "contact_phone" VARCHAR(50),
    "address" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "remark" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "production_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_catalogs" (
    "id" UUID NOT NULL,
    "operation_code" VARCHAR(80),
    "operation_name" VARCHAR(150) NOT NULL,
    "default_unit_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "remark" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "operation_catalogs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_rates" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "wage_mode" VARCHAR(20) NOT NULL,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "remark" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "operation_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_daily_reports" (
    "id" UUID NOT NULL,
    "idempotency_key" VARCHAR(200),
    "version" INTEGER NOT NULL DEFAULT 1,
    "production_order_id" UUID NOT NULL,
    "production_order_operation_id" UUID NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "production_order_no_snapshot" VARCHAR(100) NOT NULL,
    "operation_name_snapshot" VARCHAR(150) NOT NULL,
    "unit_id" UUID NOT NULL,
    "report_date" DATE NOT NULL,
    "completed_quantity" DECIMAL(18,4) NOT NULL,
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "operation_daily_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_daily_reports" (
    "id" UUID NOT NULL,
    "idempotency_key" VARCHAR(200),
    "version" INTEGER NOT NULL DEFAULT 1,
    "production_order_id" UUID NOT NULL,
    "production_order_operation_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "production_order_no_snapshot" VARCHAR(100) NOT NULL,
    "operation_name_snapshot" VARCHAR(150) NOT NULL,
    "employee_name_snapshot" VARCHAR(100) NOT NULL,
    "report_date" DATE NOT NULL,
    "wage_mode" VARCHAR(20) NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "duration_minutes" DECIMAL(18,4),
    "unit_price" DECIMAL(18,4) NOT NULL,
    "calculated_amount" DECIMAL(18,4) NOT NULL,
    "price_override_reason" VARCHAR(1000),
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "employee_daily_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_report_merge_anomalies" (
    "id" UUID NOT NULL,
    "report_kind" VARCHAR(30) NOT NULL,
    "production_order_operation_id" UUID NOT NULL,
    "employee_id" UUID,
    "report_date" DATE NOT NULL,
    "wage_modes" JSONB NOT NULL,
    "report_ids" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "daily_report_merge_anomalies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_daily_alerts" (
    "id" UUID NOT NULL,
    "alert_type" VARCHAR(40) NOT NULL,
    "production_order_id" UUID NOT NULL,
    "production_order_operation_id" UUID NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "report_date" DATE NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "target_quantity" DECIMAL(18,4),
    "operation_report_quantity" DECIMAL(18,4),
    "employee_report_quantity" DECIMAL(18,4),
    "discrepancy_quantity" DECIMAL(18,4),
    "cumulative_quantity" DECIMAL(18,4),
    "over_order_quantity" DECIMAL(18,4),
    "confirm_remark" VARCHAR(1000),
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMP(3),
    "recovered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "production_daily_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_payroll_sources" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "production_order_id" UUID,
    "order_no" VARCHAR(100),
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "wage_mode" VARCHAR(20) NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "duration_minutes" DECIMAL(18,4) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "source_snapshot" JSONB NOT NULL,
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "production_payroll_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "attendance_date" DATE NOT NULL,
    "attendance_type" VARCHAR(40) NOT NULL,
    "work_start_time" VARCHAR(5),
    "work_end_time" VARCHAR(5),
    "work_hours" DECIMAL(18,4),
    "overtime_hours" DECIMAL(18,4),
    "remark" VARCHAR(1000),
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_records" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "score" DECIMAL(8,4),
    "grade" VARCHAR(30),
    "reward_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "comment" VARCHAR(1000),
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "performance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_ledgers" (
    "id" UUID NOT NULL,
    "ledger_no" VARCHAR(100) NOT NULL,
    "employee_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "base_salary" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "production_source_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "overtime_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "attendance_deduction" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "late_deduction" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "absence_deduction" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "early_leave_deduction" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "performance_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "allowance_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "housing_allowance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "social_insurance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "individual_tax" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "other_adjustment" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "source_snapshot" JSONB NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "payroll_ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_payable_entries" (
    "id" UUID NOT NULL,
    "payable_no" VARCHAR(100) NOT NULL,
    "ledger_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "order_no" VARCHAR(100),
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "source_snapshot" JSONB NOT NULL,
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "payroll_payable_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_adjustments" (
    "id" UUID NOT NULL,
    "adjustment_no" VARCHAR(100) NOT NULL,
    "ledger_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "adjustment_type" VARCHAR(40) NOT NULL,
    "effect" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "payroll_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_payments" (
    "id" UUID NOT NULL,
    "payment_no" VARCHAR(100) NOT NULL,
    "payment_date" DATE NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "payment_method" VARCHAR(50) NOT NULL,
    "bank_reference" VARCHAR(200),
    "bank_id" UUID,
    "subject_id" UUID,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "attachment" JSONB NOT NULL DEFAULT '[]',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "salary_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_payment_allocations" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "ledger_id" UUID NOT NULL,
    "payroll_payable_id" UUID,
    "employee_id" UUID NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'active',
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "salary_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "banks" (
    "id" UUID NOT NULL,
    "bank_code" VARCHAR(80) NOT NULL,
    "bank_name" VARCHAR(200) NOT NULL,
    "account_name" VARCHAR(200) NOT NULL,
    "account_number" VARCHAR(100) NOT NULL,
    "currency" VARCHAR(10) NOT NULL,
    "opening_balance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "swift_code" VARCHAR(50),
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "banks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transfers" (
    "id" UUID NOT NULL,
    "transfer_no" VARCHAR(100) NOT NULL,
    "transfer_date" DATE NOT NULL,
    "from_bank_id" UUID NOT NULL,
    "from_currency" VARCHAR(10) NOT NULL,
    "to_bank_id" UUID NOT NULL,
    "to_currency" VARCHAR(10) NOT NULL,
    "from_amount" DECIMAL(18,4) NOT NULL,
    "to_amount" DECIMAL(18,4) NOT NULL,
    "exchange_rate" DECIMAL(18,6),
    "status" VARCHAR(30) NOT NULL DEFAULT 'posted',
    "reversal_reason" VARCHAR(500),
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "bank_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktakes" (
    "id" UUID NOT NULL,
    "stocktake_no" VARCHAR(100) NOT NULL,
    "period_month" VARCHAR(7) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "source_file_name" VARCHAR(300),
    "imported_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "confirmed_by" UUID,
    "reversed_at" TIMESTAMP(3),
    "reversed_by" UUID,
    "reversal_reason" VARCHAR(1000),
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "stocktakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktake_lines" (
    "id" UUID NOT NULL,
    "stocktake_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "material_id" UUID NOT NULL,
    "product_code_snapshot" VARCHAR(80) NOT NULL,
    "product_name_snapshot" VARCHAR(200) NOT NULL,
    "specification_snapshot" VARCHAR(200),
    "warehouse_zone" VARCHAR(100),
    "bin_location" VARCHAR(100),
    "unit_id" UUID NOT NULL,
    "actual_quantity" DECIMAL(18,4) NOT NULL,
    "book_quantity_snapshot" DECIMAL(18,4) NOT NULL,
    "difference_snapshot" DECIMAL(18,4) NOT NULL,
    "book_quantity_at_confirm" DECIMAL(18,4),
    "applied_quantity" DECIMAL(18,4),
    "difference_reason" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "stocktake_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overhead_allocations" (
    "id" UUID NOT NULL,
    "period" VARCHAR(7) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "unit" VARCHAR(30) NOT NULL,
    "quantity_override" DECIMAL(18,4),
    "remark" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "overhead_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_slips" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "slip_no" VARCHAR(100) NOT NULL,
    "slip_date" DATE NOT NULL,
    "slip_method" VARCHAR(50) NOT NULL,
    "counterparty_name" VARCHAR(200) NOT NULL,
    "currency" VARCHAR(10) NOT NULL DEFAULT 'CNY',
    "exchange_rate" DECIMAL(18,8),
    "amount_cny" DECIMAL(18,4),
    "our_bank_name" VARCHAR(200) NOT NULL DEFAULT '',
    "our_bank_account" VARCHAR(100) NOT NULL DEFAULT '',
    "counterparty_bank_name" VARCHAR(200) NOT NULL DEFAULT '',
    "counterparty_bank_account" VARCHAR(100) NOT NULL DEFAULT '',
    "attachment_count" INTEGER NOT NULL DEFAULT 1,
    "remark" VARCHAR(1000) NOT NULL DEFAULT '',
    "maker" VARCHAR(100) NOT NULL DEFAULT '',
    "source_entry_ids" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,

    CONSTRAINT "finance_slips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_slip_lines" (
    "id" UUID NOT NULL,
    "slip_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "summary" VARCHAR(500) NOT NULL DEFAULT '',
    "general_subject" VARCHAR(200) NOT NULL DEFAULT '',
    "detail_subject" VARCHAR(200) NOT NULL DEFAULT '',
    "debit" DECIMAL(18,4),
    "credit" DECIMAL(18,4),
    "remark" VARCHAR(500) NOT NULL DEFAULT '',

    CONSTRAINT "finance_slip_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "dictionary_types_key_key" ON "dictionary_types"("key");

-- CreateIndex
CREATE UNIQUE INDEX "dictionary_items_type_id_key_key" ON "dictionary_items"("type_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "state_definitions_machine_key_key_key" ON "state_definitions"("machine_key", "key");

-- CreateIndex
CREATE UNIQUE INDEX "state_records_machine_key_entity_type_entity_id_key" ON "state_records"("machine_key", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "state_changes_record_id_created_at_idx" ON "state_changes"("record_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "state_transitions_machine_key_from_state_id_to_state_id_key" ON "state_transitions"("machine_key", "from_state_id", "to_state_id");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_storage_key_key" ON "attachments"("storage_key");

-- CreateIndex
CREATE INDEX "attachment_links_entity_type_entity_id_idx" ON "attachment_links"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_events_entity_type_entity_id_created_at_idx" ON "audit_events"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_id_created_at_idx" ON "audit_events"("actor_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "customers_customer_code_key" ON "customers"("customer_code");

-- CreateIndex
CREATE UNIQUE INDEX "customers_name_key" ON "customers"("name");

-- CreateIndex
CREATE INDEX "customer_contacts_customer_id_is_active_idx" ON "customer_contacts"("customer_id", "is_active");

-- CreateIndex
CREATE INDEX "sales_orders_customer_id_status_idx" ON "sales_orders"("customer_id", "status");

-- CreateIndex
CREATE INDEX "sales_orders_order_date_idx" ON "sales_orders"("order_date");

-- CreateIndex
CREATE INDEX "sales_orders_item_no_order_date_idx" ON "sales_orders"("item_no", "order_date");

-- CreateIndex
CREATE INDEX "sales_orders_order_no_idx" ON "sales_orders"("order_no");

-- CreateIndex
CREATE INDEX "sales_order_spec_details_sales_order_id_sort_order_idx" ON "sales_order_spec_details"("sales_order_id", "sort_order");

-- CreateIndex
CREATE INDEX "sales_order_material_refs_material_id_idx" ON "sales_order_material_refs"("material_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_material_refs_sales_order_id_spec_key_key" ON "sales_order_material_refs"("sales_order_id", "spec_key");

-- CreateIndex
CREATE INDEX "sales_order_material_extras_sales_order_id_sort_order_idx" ON "sales_order_material_extras"("sales_order_id", "sort_order");

-- CreateIndex
CREATE INDEX "sales_order_material_extras_material_id_idx" ON "sales_order_material_extras"("material_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_versions_sales_order_id_version_key" ON "sales_order_versions"("sales_order_id", "version");

-- CreateIndex
CREATE INDEX "boms_sales_order_id_idx" ON "boms"("sales_order_id");

-- CreateIndex
CREATE INDEX "boms_order_no_idx" ON "boms"("order_no");

-- CreateIndex
CREATE INDEX "form_definitions_form_key_status_idx" ON "form_definitions"("form_key", "status");

-- CreateIndex
CREATE UNIQUE INDEX "form_definitions_form_key_version_key" ON "form_definitions"("form_key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "form_fields_form_definition_id_field_key_key" ON "form_fields"("form_definition_id", "field_key");

-- CreateIndex
CREATE INDEX "bom_items_bom_id_idx" ON "bom_items"("bom_id");

-- CreateIndex
CREATE INDEX "bom_items_material_id_idx" ON "bom_items"("material_id");

-- CreateIndex
CREATE INDEX "bom_items_supplier_id_idx" ON "bom_items"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "units_name_key" ON "units"("name");

-- CreateIndex
CREATE UNIQUE INDEX "materials_material_code_key" ON "materials"("material_code");

-- CreateIndex
CREATE INDEX "materials_default_unit_id_idx" ON "materials"("default_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "materials_name_specification_model_color_key" ON "materials"("name", "specification_model", "color");

-- CreateIndex
CREATE UNIQUE INDEX "material_images_material_id_key" ON "material_images"("material_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_supplier_code_key" ON "suppliers"("supplier_code");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_name_key" ON "suppliers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_purchase_order_no_key" ON "purchase_orders"("purchase_order_no");

-- CreateIndex
CREATE INDEX "purchase_orders_order_no_status_idx" ON "purchase_orders"("order_no", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_supplier_id_status_idx" ON "purchase_orders"("supplier_id", "status");

-- CreateIndex
CREATE INDEX "purchase_order_items_purchase_order_id_idx" ON "purchase_order_items"("purchase_order_id");

-- CreateIndex
CREATE INDEX "purchase_order_items_supplier_id_idx" ON "purchase_order_items"("supplier_id");

-- CreateIndex
CREATE INDEX "purchase_order_items_bom_item_id_idx" ON "purchase_order_items"("bom_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_plans_plan_no_key" ON "purchase_plans"("plan_no");

-- CreateIndex
CREATE INDEX "purchase_plans_order_no_idx" ON "purchase_plans"("order_no");

-- CreateIndex
CREATE INDEX "purchase_plans_bom_id_idx" ON "purchase_plans"("bom_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_plan_items_purchase_order_item_id_key" ON "purchase_plan_items"("purchase_order_item_id");

-- CreateIndex
CREATE INDEX "purchase_plan_items_plan_id_idx" ON "purchase_plan_items"("plan_id");

-- CreateIndex
CREATE INDEX "purchase_plan_items_supplier_id_idx" ON "purchase_plan_items"("supplier_id");

-- CreateIndex
CREATE INDEX "purchase_plan_items_bom_item_id_idx" ON "purchase_plan_items"("bom_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipts_receipt_no_key" ON "purchase_receipts"("receipt_no");

-- CreateIndex
CREATE INDEX "purchase_receipts_purchase_order_item_id_received_date_idx" ON "purchase_receipts"("purchase_order_item_id", "received_date");

-- CreateIndex
CREATE INDEX "purchase_receipts_order_no_idx" ON "purchase_receipts"("order_no");

-- CreateIndex
CREATE INDEX "incoming_inspections_purchase_receipt_id_idx" ON "incoming_inspections"("purchase_receipt_id");

-- CreateIndex
CREATE INDEX "incoming_inspections_order_no_idx" ON "incoming_inspections"("order_no");

-- CreateIndex
CREATE UNIQUE INDEX "raw_material_inbound_notices_notice_no_key" ON "raw_material_inbound_notices"("notice_no");

-- CreateIndex
CREATE INDEX "raw_material_inbound_notices_order_no_status_idx" ON "raw_material_inbound_notices"("order_no", "status");

-- CreateIndex
CREATE INDEX "raw_material_inbound_notices_purchase_order_id_status_idx" ON "raw_material_inbound_notices"("purchase_order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "raw_material_inbounds_inbound_no_key" ON "raw_material_inbounds"("inbound_no");

-- CreateIndex
CREATE UNIQUE INDEX "raw_material_inbounds_idempotency_key_key" ON "raw_material_inbounds"("idempotency_key");

-- CreateIndex
CREATE INDEX "raw_material_inbounds_order_no_idx" ON "raw_material_inbounds"("order_no");

-- CreateIndex
CREATE INDEX "inventory_facts_material_id_inventory_category_unit_id_idx" ON "inventory_facts"("material_id", "inventory_category", "unit_id");

-- CreateIndex
CREATE INDEX "inventory_facts_source_type_source_id_idx" ON "inventory_facts"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "inventory_facts_order_no_idx" ON "inventory_facts"("order_no");

-- CreateIndex
CREATE INDEX "inventory_facts_production_order_id_idx" ON "inventory_facts"("production_order_id");

-- CreateIndex
CREATE INDEX "inventory_facts_finished_goods_inbound_id_idx" ON "inventory_facts"("finished_goods_inbound_id");

-- CreateIndex
CREATE INDEX "inventory_facts_finished_goods_defective_id_idx" ON "inventory_facts"("finished_goods_defective_id");

-- CreateIndex
CREATE INDEX "inventory_facts_finished_goods_outbound_id_idx" ON "inventory_facts"("finished_goods_outbound_id");

-- CreateIndex
CREATE INDEX "inventory_facts_customer_return_id_idx" ON "inventory_facts"("customer_return_id");

-- CreateIndex
CREATE INDEX "inventory_facts_stocktake_line_id_idx" ON "inventory_facts"("stocktake_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "payable_sources_idempotency_key_key" ON "payable_sources"("idempotency_key");

-- CreateIndex
CREATE INDEX "payable_sources_purchase_receipt_id_idx" ON "payable_sources"("purchase_receipt_id");

-- CreateIndex
CREATE INDEX "payable_sources_order_no_idx" ON "payable_sources"("order_no");

-- CreateIndex
CREATE UNIQUE INDEX "payable_sources_raw_material_inbound_id_key" ON "payable_sources"("raw_material_inbound_id");

-- CreateIndex
CREATE UNIQUE INDEX "outsource_logistics_batches_batch_no_key" ON "outsource_logistics_batches"("batch_no");

-- CreateIndex
CREATE INDEX "outsource_logistics_batches_order_no_status_idx" ON "outsource_logistics_batches"("order_no", "status");

-- CreateIndex
CREATE INDEX "outsource_logistics_batches_production_order_id_status_idx" ON "outsource_logistics_batches"("production_order_id", "status");

-- CreateIndex
CREATE INDEX "outsource_logistics_batches_purchase_order_item_id_status_idx" ON "outsource_logistics_batches"("purchase_order_item_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "outsource_receipts_idempotency_key_key" ON "outsource_receipts"("idempotency_key");

-- CreateIndex
CREATE INDEX "outsource_receipts_logistics_batch_id_receipt_date_idx" ON "outsource_receipts"("logistics_batch_id", "receipt_date");

-- CreateIndex
CREATE INDEX "outsource_receipts_order_no_receipt_date_idx" ON "outsource_receipts"("order_no", "receipt_date");

-- CreateIndex
CREATE UNIQUE INDEX "outsource_payable_sources_outsource_receipt_id_key" ON "outsource_payable_sources"("outsource_receipt_id");

-- CreateIndex
CREATE INDEX "outsource_payable_sources_order_no_status_idx" ON "outsource_payable_sources"("order_no", "status");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payable_entries_payable_no_key" ON "supplier_payable_entries"("payable_no");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payable_entries_payable_source_id_key" ON "supplier_payable_entries"("payable_source_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payable_entries_outsource_payable_source_id_key" ON "supplier_payable_entries"("outsource_payable_source_id");

-- CreateIndex
CREATE INDEX "supplier_payable_entries_order_no_status_idx" ON "supplier_payable_entries"("order_no", "status");

-- CreateIndex
CREATE INDEX "supplier_payable_entries_supplier_id_status_idx" ON "supplier_payable_entries"("supplier_id", "status");

-- CreateIndex
CREATE INDEX "supplier_payable_entries_source_type_status_idx" ON "supplier_payable_entries"("source_type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_payment_no_key" ON "supplier_payments"("payment_no");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_idempotency_key_key" ON "supplier_payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "supplier_payments_supplier_id_status_idx" ON "supplier_payments"("supplier_id", "status");

-- CreateIndex
CREATE INDEX "supplier_payments_order_no_status_idx" ON "supplier_payments"("order_no", "status");

-- CreateIndex
CREATE INDEX "supplier_payment_allocations_payable_entry_id_status_idx" ON "supplier_payment_allocations"("payable_entry_id", "status");

-- CreateIndex
CREATE INDEX "supplier_payment_allocations_order_no_status_idx" ON "supplier_payment_allocations"("order_no", "status");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payment_allocations_payment_id_payable_entry_id_key" ON "supplier_payment_allocations"("payment_id", "payable_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "outsource_return_transfers_transfer_no_key" ON "outsource_return_transfers"("transfer_no");

-- CreateIndex
CREATE INDEX "outsource_return_transfers_order_no_transfer_type_status_idx" ON "outsource_return_transfers"("order_no", "transfer_type", "status");

-- CreateIndex
CREATE INDEX "outsource_return_transfers_production_order_id_status_idx" ON "outsource_return_transfers"("production_order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "outsource_direct_shipments_shipment_no_key" ON "outsource_direct_shipments"("shipment_no");

-- CreateIndex
CREATE INDEX "outsource_direct_shipments_order_no_status_idx" ON "outsource_direct_shipments"("order_no", "status");

-- CreateIndex
CREATE INDEX "outsource_direct_shipments_production_order_id_status_idx" ON "outsource_direct_shipments"("production_order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "finished_goods_inspection_submissions_submission_no_key" ON "finished_goods_inspection_submissions"("submission_no");

-- CreateIndex
CREATE INDEX "finished_goods_inspection_submissions_order_no_status_idx" ON "finished_goods_inspection_submissions"("order_no", "status");

-- CreateIndex
CREATE INDEX "finished_goods_inspection_submissions_production_order_id_s_idx" ON "finished_goods_inspection_submissions"("production_order_id", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "finished_goods_inspection_submissions_source_type_source_id_idx" ON "finished_goods_inspection_submissions"("source_type", "source_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "finished_goods_qc_records_qc_no_key" ON "finished_goods_qc_records"("qc_no");

-- CreateIndex
CREATE INDEX "finished_goods_qc_records_order_no_conclusion_idx" ON "finished_goods_qc_records"("order_no", "conclusion");

-- CreateIndex
CREATE INDEX "finished_goods_qc_records_submission_id_inspection_date_idx" ON "finished_goods_qc_records"("submission_id", "inspection_date");

-- CreateIndex
CREATE INDEX "finished_goods_qc_records_production_order_id_source_type_s_idx" ON "finished_goods_qc_records"("production_order_id", "source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "finished_goods_inbound_notices_notice_no_key" ON "finished_goods_inbound_notices"("notice_no");

-- CreateIndex
CREATE UNIQUE INDEX "finished_goods_inbound_notices_idempotency_key_key" ON "finished_goods_inbound_notices"("idempotency_key");

-- CreateIndex
CREATE INDEX "finished_goods_inbound_notices_order_no_status_idx" ON "finished_goods_inbound_notices"("order_no", "status");

-- CreateIndex
CREATE INDEX "finished_goods_inbound_notices_production_order_id_status_idx" ON "finished_goods_inbound_notices"("production_order_id", "status");

-- CreateIndex
CREATE INDEX "finished_goods_inbound_notices_production_order_operation_i_idx" ON "finished_goods_inbound_notices"("production_order_operation_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "finished_goods_inbounds_inbound_no_key" ON "finished_goods_inbounds"("inbound_no");

-- CreateIndex
CREATE UNIQUE INDEX "finished_goods_inbounds_idempotency_key_key" ON "finished_goods_inbounds"("idempotency_key");

-- CreateIndex
CREATE INDEX "finished_goods_inbounds_order_no_status_idx" ON "finished_goods_inbounds"("order_no", "status");

-- CreateIndex
CREATE INDEX "finished_goods_inbounds_qc_record_id_status_idx" ON "finished_goods_inbounds"("qc_record_id", "status");

-- CreateIndex
CREATE INDEX "finished_goods_inbounds_production_order_id_status_idx" ON "finished_goods_inbounds"("production_order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "finished_goods_defectives_defective_no_key" ON "finished_goods_defectives"("defective_no");

-- CreateIndex
CREATE UNIQUE INDEX "finished_goods_defectives_idempotency_key_key" ON "finished_goods_defectives"("idempotency_key");

-- CreateIndex
CREATE INDEX "finished_goods_defectives_order_no_status_idx" ON "finished_goods_defectives"("order_no", "status");

-- CreateIndex
CREATE INDEX "finished_goods_defectives_qc_record_id_status_idx" ON "finished_goods_defectives"("qc_record_id", "status");

-- CreateIndex
CREATE INDEX "finished_goods_defectives_production_order_id_status_idx" ON "finished_goods_defectives"("production_order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "finished_goods_outbounds_outbound_no_key" ON "finished_goods_outbounds"("outbound_no");

-- CreateIndex
CREATE UNIQUE INDEX "finished_goods_outbounds_idempotency_key_key" ON "finished_goods_outbounds"("idempotency_key");

-- CreateIndex
CREATE INDEX "finished_goods_outbounds_order_no_status_idx" ON "finished_goods_outbounds"("order_no", "status");

-- CreateIndex
CREATE INDEX "finished_goods_outbounds_sales_order_id_status_idx" ON "finished_goods_outbounds"("sales_order_id", "status");

-- CreateIndex
CREATE INDEX "finished_goods_outbounds_production_order_id_status_idx" ON "finished_goods_outbounds"("production_order_id", "status");

-- CreateIndex
CREATE INDEX "finished_goods_outbounds_outbound_notice_id_idx" ON "finished_goods_outbounds"("outbound_notice_id");

-- CreateIndex
CREATE UNIQUE INDEX "finished_goods_outbound_notices_notice_no_key" ON "finished_goods_outbound_notices"("notice_no");

-- CreateIndex
CREATE UNIQUE INDEX "finished_goods_outbound_notices_idempotency_key_key" ON "finished_goods_outbound_notices"("idempotency_key");

-- CreateIndex
CREATE INDEX "finished_goods_outbound_notices_order_no_status_idx" ON "finished_goods_outbound_notices"("order_no", "status");

-- CreateIndex
CREATE INDEX "finished_goods_outbound_notices_sales_order_id_status_idx" ON "finished_goods_outbound_notices"("sales_order_id", "status");

-- CreateIndex
CREATE INDEX "finished_goods_outbound_notices_production_order_id_status_idx" ON "finished_goods_outbound_notices"("production_order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "customer_returns_return_no_key" ON "customer_returns"("return_no");

-- CreateIndex
CREATE UNIQUE INDEX "customer_returns_idempotency_key_key" ON "customer_returns"("idempotency_key");

-- CreateIndex
CREATE INDEX "customer_returns_order_no_status_idx" ON "customer_returns"("order_no", "status");

-- CreateIndex
CREATE INDEX "customer_returns_sales_order_id_status_idx" ON "customer_returns"("sales_order_id", "status");

-- CreateIndex
CREATE INDEX "customer_returns_production_order_id_status_idx" ON "customer_returns"("production_order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_sources_source_no_key" ON "receivable_sources"("source_no");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_sources_outbound_id_key" ON "receivable_sources"("outbound_id");

-- CreateIndex
CREATE INDEX "receivable_sources_order_no_status_idx" ON "receivable_sources"("order_no", "status");

-- CreateIndex
CREATE INDEX "receivable_sources_customer_id_status_idx" ON "receivable_sources"("customer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "customer_payments_payment_no_key" ON "customer_payments"("payment_no");

-- CreateIndex
CREATE UNIQUE INDEX "customer_payments_idempotency_key_key" ON "customer_payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "customer_payments_customer_id_status_idx" ON "customer_payments"("customer_id", "status");

-- CreateIndex
CREATE INDEX "customer_payments_order_no_status_idx" ON "customer_payments"("order_no", "status");

-- CreateIndex
CREATE INDEX "receivable_allocations_receivable_source_id_status_idx" ON "receivable_allocations"("receivable_source_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_allocations_payment_id_receivable_source_id_key" ON "receivable_allocations"("payment_id", "receivable_source_id");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_adjustments_adjustment_no_key" ON "receivable_adjustments"("adjustment_no");

-- CreateIndex
CREATE INDEX "receivable_adjustments_order_no_status_idx" ON "receivable_adjustments"("order_no", "status");

-- CreateIndex
CREATE INDEX "receivable_adjustments_customer_id_status_idx" ON "receivable_adjustments"("customer_id", "status");

-- CreateIndex
CREATE INDEX "receivable_adjustments_receivable_source_id_status_idx" ON "receivable_adjustments"("receivable_source_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "receivable_reconciliations_reconciliation_no_key" ON "receivable_reconciliations"("reconciliation_no");

-- CreateIndex
CREATE INDEX "receivable_reconciliations_order_no_status_idx" ON "receivable_reconciliations"("order_no", "status");

-- CreateIndex
CREATE INDEX "receivable_reconciliations_customer_id_status_idx" ON "receivable_reconciliations"("customer_id", "status");

-- CreateIndex
CREATE INDEX "receivable_reconciliations_period_start_period_end_idx" ON "receivable_reconciliations"("period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payable_reconciliations_reconciliation_no_key" ON "supplier_payable_reconciliations"("reconciliation_no");

-- CreateIndex
CREATE INDEX "supplier_payable_reconciliations_supplier_id_status_idx" ON "supplier_payable_reconciliations"("supplier_id", "status");

-- CreateIndex
CREATE INDEX "supplier_payable_reconciliations_order_no_status_idx" ON "supplier_payable_reconciliations"("order_no", "status");

-- CreateIndex
CREATE INDEX "supplier_payable_reconciliations_period_start_period_end_idx" ON "supplier_payable_reconciliations"("period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "cash_flow_entries_entry_no_key" ON "cash_flow_entries"("entry_no");

-- CreateIndex
CREATE INDEX "cash_flow_entries_entry_date_currency_idx" ON "cash_flow_entries"("entry_date", "currency");

-- CreateIndex
CREATE INDEX "cash_flow_entries_subject_id_direction_idx" ON "cash_flow_entries"("subject_id", "direction");

-- CreateIndex
CREATE INDEX "cash_flow_entries_currency_status_idx" ON "cash_flow_entries"("currency", "status");

-- CreateIndex
CREATE INDEX "cash_flow_entries_bank_id_status_idx" ON "cash_flow_entries"("bank_id", "status");

-- CreateIndex
CREATE INDEX "cash_flow_entries_order_no_idx" ON "cash_flow_entries"("order_no");

-- CreateIndex
CREATE INDEX "accounting_subjects_category_sort_order_idx" ON "accounting_subjects"("category", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_subjects_category_name_key" ON "accounting_subjects"("category", "name");

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_voucher_no_key" ON "vouchers"("voucher_no");

-- CreateIndex
CREATE INDEX "vouchers_period_status_idx" ON "vouchers"("period", "status");

-- CreateIndex
CREATE INDEX "vouchers_voucher_date_idx" ON "vouchers"("voucher_date");

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_source_type_source_id_key" ON "vouchers"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "accounting_opening_balances_as_of_date_currency_idx" ON "accounting_opening_balances"("as_of_date", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_opening_balances_as_of_date_subject_key_currency_key" ON "accounting_opening_balances"("as_of_date", "subject_key", "currency");

-- CreateIndex
CREATE INDEX "exchange_rates_currency_period_idx" ON "exchange_rates"("currency", "period");

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_period_currency_key" ON "exchange_rates"("period", "currency");

-- CreateIndex
CREATE INDEX "voucher_lines_bank_id_idx" ON "voucher_lines"("bank_id");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_lines_voucher_id_line_no_key" ON "voucher_lines"("voucher_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_production_order_no_key" ON "production_orders"("production_order_no");

-- CreateIndex
CREATE INDEX "production_orders_order_no_status_idx" ON "production_orders"("order_no", "status");

-- CreateIndex
CREATE INDEX "production_orders_sales_order_id_production_order_type_idx" ON "production_orders"("sales_order_id", "production_order_type");

-- CreateIndex
CREATE UNIQUE INDEX "raw_material_movements_movement_no_key" ON "raw_material_movements"("movement_no");

-- CreateIndex
CREATE UNIQUE INDEX "raw_material_movements_idempotency_key_key" ON "raw_material_movements"("idempotency_key");

-- CreateIndex
CREATE INDEX "raw_material_movements_production_order_id_status_idx" ON "raw_material_movements"("production_order_id", "status");

-- CreateIndex
CREATE INDEX "raw_material_movements_production_order_operation_id_idx" ON "raw_material_movements"("production_order_operation_id");

-- CreateIndex
CREATE INDEX "raw_material_movements_order_no_business_date_idx" ON "raw_material_movements"("order_no", "business_date");

-- CreateIndex
CREATE INDEX "raw_material_movements_status_submitted_at_idx" ON "raw_material_movements"("status", "submitted_at");

-- CreateIndex
CREATE INDEX "raw_material_movement_lines_movement_id_idx" ON "raw_material_movement_lines"("movement_id");

-- CreateIndex
CREATE INDEX "raw_material_movement_lines_material_id_unit_id_idx" ON "raw_material_movement_lines"("material_id", "unit_id");

-- CreateIndex
CREATE INDEX "raw_material_movement_risks_movement_id_risk_type_idx" ON "raw_material_movement_risks"("movement_id", "risk_type");

-- CreateIndex
CREATE INDEX "production_order_operations_production_order_id_status_idx" ON "production_order_operations"("production_order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "production_order_operations_production_order_id_sequence_no_key" ON "production_order_operations"("production_order_id", "sequence_no");

-- CreateIndex
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- CreateIndex
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");

-- CreateIndex
CREATE INDEX "positions_department_id_is_active_idx" ON "positions"("department_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "positions_department_id_code_key" ON "positions"("department_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "employees_employee_no_key" ON "employees"("employee_no");

-- CreateIndex
CREATE INDEX "employees_department_id_employment_status_idx" ON "employees"("department_id", "employment_status");

-- CreateIndex
CREATE INDEX "employees_position_id_employment_status_idx" ON "employees"("position_id", "employment_status");

-- CreateIndex
CREATE INDEX "employees_id_card_no_idx" ON "employees"("id_card_no");

-- CreateIndex
CREATE INDEX "production_locations_location_type_is_active_idx" ON "production_locations"("location_type", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "production_locations_name_location_type_key" ON "production_locations"("name", "location_type");

-- CreateIndex
CREATE UNIQUE INDEX "operation_catalogs_operation_code_key" ON "operation_catalogs"("operation_code");

-- CreateIndex
CREATE INDEX "operation_rates_employee_id_operation_id_wage_mode_effectiv_idx" ON "operation_rates"("employee_id", "operation_id", "wage_mode", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "operation_daily_reports_idempotency_key_key" ON "operation_daily_reports"("idempotency_key");

-- CreateIndex
CREATE INDEX "operation_daily_reports_production_order_id_report_date_idx" ON "operation_daily_reports"("production_order_id", "report_date");

-- CreateIndex
CREATE INDEX "operation_daily_reports_production_order_operation_id_repor_idx" ON "operation_daily_reports"("production_order_operation_id", "report_date");

-- CreateIndex
CREATE INDEX "operation_daily_reports_order_no_report_date_idx" ON "operation_daily_reports"("order_no", "report_date");

-- CreateIndex
CREATE UNIQUE INDEX "employee_daily_reports_idempotency_key_key" ON "employee_daily_reports"("idempotency_key");

-- CreateIndex
CREATE INDEX "employee_daily_reports_production_order_id_report_date_idx" ON "employee_daily_reports"("production_order_id", "report_date");

-- CreateIndex
CREATE INDEX "employee_daily_reports_production_order_operation_id_report_idx" ON "employee_daily_reports"("production_order_operation_id", "report_date");

-- CreateIndex
CREATE INDEX "employee_daily_reports_employee_id_report_date_idx" ON "employee_daily_reports"("employee_id", "report_date");

-- CreateIndex
CREATE INDEX "employee_daily_reports_order_no_report_date_idx" ON "employee_daily_reports"("order_no", "report_date");

-- CreateIndex
CREATE INDEX "daily_report_merge_anomalies_status_report_date_idx" ON "daily_report_merge_anomalies"("status", "report_date");

-- CreateIndex
CREATE INDEX "production_daily_alerts_production_order_id_status_idx" ON "production_daily_alerts"("production_order_id", "status");

-- CreateIndex
CREATE INDEX "production_daily_alerts_order_no_report_date_idx" ON "production_daily_alerts"("order_no", "report_date");

-- CreateIndex
CREATE UNIQUE INDEX "production_daily_alerts_production_order_operation_id_repor_key" ON "production_daily_alerts"("production_order_operation_id", "report_date", "alert_type");

-- CreateIndex
CREATE INDEX "production_payroll_sources_employee_id_period_start_period__idx" ON "production_payroll_sources"("employee_id", "period_start", "period_end");

-- CreateIndex
CREATE INDEX "production_payroll_sources_order_no_period_start_period_end_idx" ON "production_payroll_sources"("order_no", "period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "production_payroll_sources_employee_id_production_order_id__key" ON "production_payroll_sources"("employee_id", "production_order_id", "period_start", "period_end", "wage_mode");

-- CreateIndex
CREATE INDEX "attendance_records_employee_id_attendance_date_idx" ON "attendance_records"("employee_id", "attendance_date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_employee_id_attendance_date_key" ON "attendance_records"("employee_id", "attendance_date");

-- CreateIndex
CREATE INDEX "performance_records_employee_id_period_start_period_end_idx" ON "performance_records"("employee_id", "period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "performance_records_employee_id_period_start_period_end_key" ON "performance_records"("employee_id", "period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_ledgers_ledger_no_key" ON "payroll_ledgers"("ledger_no");

-- CreateIndex
CREATE INDEX "payroll_ledgers_period_start_period_end_status_idx" ON "payroll_ledgers"("period_start", "period_end", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_ledgers_employee_id_period_start_period_end_key" ON "payroll_ledgers"("employee_id", "period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_payable_entries_payable_no_key" ON "payroll_payable_entries"("payable_no");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_payable_entries_ledger_id_key" ON "payroll_payable_entries"("ledger_id");

-- CreateIndex
CREATE INDEX "payroll_payable_entries_employee_id_status_idx" ON "payroll_payable_entries"("employee_id", "status");

-- CreateIndex
CREATE INDEX "payroll_payable_entries_order_no_status_idx" ON "payroll_payable_entries"("order_no", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_adjustments_adjustment_no_key" ON "payroll_adjustments"("adjustment_no");

-- CreateIndex
CREATE INDEX "payroll_adjustments_ledger_id_status_idx" ON "payroll_adjustments"("ledger_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "salary_payments_payment_no_key" ON "salary_payments"("payment_no");

-- CreateIndex
CREATE INDEX "salary_payment_allocations_payroll_payable_id_status_idx" ON "salary_payment_allocations"("payroll_payable_id", "status");

-- CreateIndex
CREATE INDEX "salary_payment_allocations_ledger_id_status_idx" ON "salary_payment_allocations"("ledger_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "salary_payment_allocations_payment_id_ledger_id_key" ON "salary_payment_allocations"("payment_id", "ledger_id");

-- CreateIndex
CREATE INDEX "alert_handlings_status_updated_at_idx" ON "alert_handlings"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "alert_handlings_source_type_source_id_alert_type_key" ON "alert_handlings"("source_type", "source_id", "alert_type");

-- CreateIndex
CREATE UNIQUE INDEX "banks_bank_code_key" ON "banks"("bank_code");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transfers_transfer_no_key" ON "bank_transfers"("transfer_no");

-- CreateIndex
CREATE INDEX "bank_transfers_transfer_date_status_idx" ON "bank_transfers"("transfer_date", "status");

-- CreateIndex
CREATE INDEX "bank_transfers_from_bank_id_status_idx" ON "bank_transfers"("from_bank_id", "status");

-- CreateIndex
CREATE INDEX "bank_transfers_to_bank_id_status_idx" ON "bank_transfers"("to_bank_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stocktakes_stocktake_no_key" ON "stocktakes"("stocktake_no");

-- CreateIndex
CREATE INDEX "stocktakes_period_month_status_idx" ON "stocktakes"("period_month", "status");

-- CreateIndex
CREATE INDEX "stocktake_lines_material_id_idx" ON "stocktake_lines"("material_id");

-- CreateIndex
CREATE INDEX "stocktake_lines_stocktake_id_idx" ON "stocktake_lines"("stocktake_id");

-- CreateIndex
CREATE UNIQUE INDEX "stocktake_lines_stocktake_id_line_no_key" ON "stocktake_lines"("stocktake_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "overhead_allocations_period_key" ON "overhead_allocations"("period");

-- CreateIndex
CREATE INDEX "finance_slips_kind_slip_date_idx" ON "finance_slips"("kind", "slip_date");

-- CreateIndex
CREATE UNIQUE INDEX "finance_slip_lines_slip_id_line_no_key" ON "finance_slip_lines"("slip_id", "line_no");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_key_fkey" FOREIGN KEY ("role_key") REFERENCES "roles"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dictionary_items" ADD CONSTRAINT "dictionary_items_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "dictionary_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_records" ADD CONSTRAINT "state_records_current_state_id_fkey" FOREIGN KEY ("current_state_id") REFERENCES "state_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_changes" ADD CONSTRAINT "state_changes_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "state_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_from_state_id_fkey" FOREIGN KEY ("from_state_id") REFERENCES "state_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_to_state_id_fkey" FOREIGN KEY ("to_state_id") REFERENCES "state_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment_links" ADD CONSTRAINT "attachment_links_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "customer_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_spec_details" ADD CONSTRAINT "sales_order_spec_details_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_material_refs" ADD CONSTRAINT "sales_order_material_refs_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_material_refs" ADD CONSTRAINT "sales_order_material_refs_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_material_extras" ADD CONSTRAINT "sales_order_material_extras_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_material_extras" ADD CONSTRAINT "sales_order_material_extras_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_versions" ADD CONSTRAINT "sales_order_versions_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "boms" ADD CONSTRAINT "boms_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "boms" ADD CONSTRAINT "boms_sales_order_version_id_fkey" FOREIGN KEY ("sales_order_version_id") REFERENCES "sales_order_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "boms" ADD CONSTRAINT "boms_form_definition_id_fkey" FOREIGN KEY ("form_definition_id") REFERENCES "form_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_form_definition_id_fkey" FOREIGN KEY ("form_definition_id") REFERENCES "form_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_bom_id_fkey" FOREIGN KEY ("bom_id") REFERENCES "boms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bom_items" ADD CONSTRAINT "bom_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_default_unit_id_fkey" FOREIGN KEY ("default_unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_images" ADD CONSTRAINT "material_images_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_bom_id_fkey" FOREIGN KEY ("bom_id") REFERENCES "boms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_bom_item_id_fkey" FOREIGN KEY ("bom_item_id") REFERENCES "bom_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_plans" ADD CONSTRAINT "purchase_plans_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_plans" ADD CONSTRAINT "purchase_plans_bom_id_fkey" FOREIGN KEY ("bom_id") REFERENCES "boms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_plan_items" ADD CONSTRAINT "purchase_plan_items_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "purchase_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_plan_items" ADD CONSTRAINT "purchase_plan_items_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_plan_items" ADD CONSTRAINT "purchase_plan_items_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_plan_items" ADD CONSTRAINT "purchase_plan_items_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_plan_items" ADD CONSTRAINT "purchase_plan_items_bom_item_id_fkey" FOREIGN KEY ("bom_item_id") REFERENCES "bom_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_plan_items" ADD CONSTRAINT "purchase_plan_items_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incoming_inspections" ADD CONSTRAINT "incoming_inspections_purchase_receipt_id_fkey" FOREIGN KEY ("purchase_receipt_id") REFERENCES "purchase_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_inbound_notices" ADD CONSTRAINT "raw_material_inbound_notices_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_inbound_notices" ADD CONSTRAINT "raw_material_inbound_notices_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_inbound_notices" ADD CONSTRAINT "raw_material_inbound_notices_purchase_receipt_id_fkey" FOREIGN KEY ("purchase_receipt_id") REFERENCES "purchase_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_inbound_notices" ADD CONSTRAINT "raw_material_inbound_notices_incoming_inspection_id_fkey" FOREIGN KEY ("incoming_inspection_id") REFERENCES "incoming_inspections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_inbound_notices" ADD CONSTRAINT "raw_material_inbound_notices_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_inbound_notices" ADD CONSTRAINT "raw_material_inbound_notices_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_inbounds" ADD CONSTRAINT "raw_material_inbounds_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_inbounds" ADD CONSTRAINT "raw_material_inbounds_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_inbounds" ADD CONSTRAINT "raw_material_inbounds_purchase_receipt_id_fkey" FOREIGN KEY ("purchase_receipt_id") REFERENCES "purchase_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_inbounds" ADD CONSTRAINT "raw_material_inbounds_incoming_inspection_id_fkey" FOREIGN KEY ("incoming_inspection_id") REFERENCES "incoming_inspections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_inbounds" ADD CONSTRAINT "raw_material_inbounds_inbound_notice_id_fkey" FOREIGN KEY ("inbound_notice_id") REFERENCES "raw_material_inbound_notices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_inbounds" ADD CONSTRAINT "raw_material_inbounds_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_inbounds" ADD CONSTRAINT "raw_material_inbounds_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_inbounds" ADD CONSTRAINT "raw_material_inbounds_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_facts" ADD CONSTRAINT "inventory_facts_raw_material_inbound_id_fkey" FOREIGN KEY ("raw_material_inbound_id") REFERENCES "raw_material_inbounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_facts" ADD CONSTRAINT "inventory_facts_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_facts" ADD CONSTRAINT "inventory_facts_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_facts" ADD CONSTRAINT "inventory_facts_raw_material_movement_line_id_fkey" FOREIGN KEY ("raw_material_movement_line_id") REFERENCES "raw_material_movement_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_facts" ADD CONSTRAINT "inventory_facts_stocktake_line_id_fkey" FOREIGN KEY ("stocktake_line_id") REFERENCES "stocktake_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_facts" ADD CONSTRAINT "inventory_facts_finished_goods_inbound_id_fkey" FOREIGN KEY ("finished_goods_inbound_id") REFERENCES "finished_goods_inbounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_facts" ADD CONSTRAINT "inventory_facts_finished_goods_defective_id_fkey" FOREIGN KEY ("finished_goods_defective_id") REFERENCES "finished_goods_defectives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_facts" ADD CONSTRAINT "inventory_facts_finished_goods_outbound_id_fkey" FOREIGN KEY ("finished_goods_outbound_id") REFERENCES "finished_goods_outbounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_facts" ADD CONSTRAINT "inventory_facts_customer_return_id_fkey" FOREIGN KEY ("customer_return_id") REFERENCES "customer_returns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_facts" ADD CONSTRAINT "inventory_facts_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payable_sources" ADD CONSTRAINT "payable_sources_raw_material_inbound_id_fkey" FOREIGN KEY ("raw_material_inbound_id") REFERENCES "raw_material_inbounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payable_sources" ADD CONSTRAINT "payable_sources_purchase_receipt_id_fkey" FOREIGN KEY ("purchase_receipt_id") REFERENCES "purchase_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payable_sources" ADD CONSTRAINT "payable_sources_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payable_sources" ADD CONSTRAINT "payable_sources_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payable_sources" ADD CONSTRAINT "payable_sources_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_logistics_batches" ADD CONSTRAINT "outsource_logistics_batches_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_logistics_batches" ADD CONSTRAINT "outsource_logistics_batches_outsource_location_id_fkey" FOREIGN KEY ("outsource_location_id") REFERENCES "production_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_logistics_batches" ADD CONSTRAINT "outsource_logistics_batches_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_logistics_batches" ADD CONSTRAINT "outsource_logistics_batches_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_logistics_batches" ADD CONSTRAINT "outsource_logistics_batches_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_logistics_batches" ADD CONSTRAINT "outsource_logistics_batches_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_receipts" ADD CONSTRAINT "outsource_receipts_logistics_batch_id_fkey" FOREIGN KEY ("logistics_batch_id") REFERENCES "outsource_logistics_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_payable_sources" ADD CONSTRAINT "outsource_payable_sources_outsource_receipt_id_fkey" FOREIGN KEY ("outsource_receipt_id") REFERENCES "outsource_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_payable_sources" ADD CONSTRAINT "outsource_payable_sources_logistics_batch_id_fkey" FOREIGN KEY ("logistics_batch_id") REFERENCES "outsource_logistics_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_payable_sources" ADD CONSTRAINT "outsource_payable_sources_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_payable_sources" ADD CONSTRAINT "outsource_payable_sources_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_payable_sources" ADD CONSTRAINT "outsource_payable_sources_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payable_entries" ADD CONSTRAINT "supplier_payable_entries_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payable_entries" ADD CONSTRAINT "supplier_payable_entries_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payable_entries" ADD CONSTRAINT "supplier_payable_entries_payable_source_id_fkey" FOREIGN KEY ("payable_source_id") REFERENCES "payable_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payable_entries" ADD CONSTRAINT "supplier_payable_entries_outsource_payable_source_id_fkey" FOREIGN KEY ("outsource_payable_source_id") REFERENCES "outsource_payable_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payable_entries" ADD CONSTRAINT "supplier_payable_entries_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payable_entries" ADD CONSTRAINT "supplier_payable_entries_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payable_entries" ADD CONSTRAINT "supplier_payable_entries_outsource_logistics_batch_id_fkey" FOREIGN KEY ("outsource_logistics_batch_id") REFERENCES "outsource_logistics_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "supplier_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_payable_entry_id_fkey" FOREIGN KEY ("payable_entry_id") REFERENCES "supplier_payable_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_return_transfers" ADD CONSTRAINT "outsource_return_transfers_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_return_transfers" ADD CONSTRAINT "outsource_return_transfers_logistics_batch_id_fkey" FOREIGN KEY ("logistics_batch_id") REFERENCES "outsource_logistics_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_return_transfers" ADD CONSTRAINT "outsource_return_transfers_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_return_transfers" ADD CONSTRAINT "outsource_return_transfers_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_direct_shipments" ADD CONSTRAINT "outsource_direct_shipments_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outsource_direct_shipments" ADD CONSTRAINT "outsource_direct_shipments_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_inspection_submissions" ADD CONSTRAINT "finished_goods_inspection_submissions_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_inspection_submissions" ADD CONSTRAINT "finished_goods_inspection_submissions_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_qc_records" ADD CONSTRAINT "finished_goods_qc_records_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "finished_goods_inspection_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_inbound_notices" ADD CONSTRAINT "finished_goods_inbound_notices_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_inbound_notices" ADD CONSTRAINT "finished_goods_inbound_notices_production_order_operation__fkey" FOREIGN KEY ("production_order_operation_id") REFERENCES "production_order_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_inbound_notices" ADD CONSTRAINT "finished_goods_inbound_notices_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_inbounds" ADD CONSTRAINT "finished_goods_inbounds_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_inbounds" ADD CONSTRAINT "finished_goods_inbounds_qc_record_id_fkey" FOREIGN KEY ("qc_record_id") REFERENCES "finished_goods_qc_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_inbounds" ADD CONSTRAINT "finished_goods_inbounds_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "finished_goods_inspection_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_inbounds" ADD CONSTRAINT "finished_goods_inbounds_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_defectives" ADD CONSTRAINT "finished_goods_defectives_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_defectives" ADD CONSTRAINT "finished_goods_defectives_qc_record_id_fkey" FOREIGN KEY ("qc_record_id") REFERENCES "finished_goods_qc_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_defectives" ADD CONSTRAINT "finished_goods_defectives_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "finished_goods_inspection_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_defectives" ADD CONSTRAINT "finished_goods_defectives_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_outbounds" ADD CONSTRAINT "finished_goods_outbounds_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_outbounds" ADD CONSTRAINT "finished_goods_outbounds_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_outbounds" ADD CONSTRAINT "finished_goods_outbounds_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_outbounds" ADD CONSTRAINT "finished_goods_outbounds_outbound_notice_id_fkey" FOREIGN KEY ("outbound_notice_id") REFERENCES "finished_goods_outbound_notices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_outbound_notices" ADD CONSTRAINT "finished_goods_outbound_notices_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_outbound_notices" ADD CONSTRAINT "finished_goods_outbound_notices_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_goods_outbound_notices" ADD CONSTRAINT "finished_goods_outbound_notices_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_returns" ADD CONSTRAINT "customer_returns_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_sources" ADD CONSTRAINT "receivable_sources_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_sources" ADD CONSTRAINT "receivable_sources_outbound_id_fkey" FOREIGN KEY ("outbound_id") REFERENCES "finished_goods_outbounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_sources" ADD CONSTRAINT "receivable_sources_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_allocations" ADD CONSTRAINT "receivable_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "customer_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_allocations" ADD CONSTRAINT "receivable_allocations_receivable_source_id_fkey" FOREIGN KEY ("receivable_source_id") REFERENCES "receivable_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_adjustments" ADD CONSTRAINT "receivable_adjustments_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_adjustments" ADD CONSTRAINT "receivable_adjustments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_adjustments" ADD CONSTRAINT "receivable_adjustments_receivable_source_id_fkey" FOREIGN KEY ("receivable_source_id") REFERENCES "receivable_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_reconciliations" ADD CONSTRAINT "receivable_reconciliations_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_reconciliations" ADD CONSTRAINT "receivable_reconciliations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_reconciliations" ADD CONSTRAINT "receivable_reconciliations_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receivable_reconciliations" ADD CONSTRAINT "receivable_reconciliations_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payable_reconciliations" ADD CONSTRAINT "supplier_payable_reconciliations_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payable_reconciliations" ADD CONSTRAINT "supplier_payable_reconciliations_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payable_reconciliations" ADD CONSTRAINT "supplier_payable_reconciliations_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payable_reconciliations" ADD CONSTRAINT "supplier_payable_reconciliations_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_flow_entries" ADD CONSTRAINT "cash_flow_entries_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_flow_entries" ADD CONSTRAINT "cash_flow_entries_settlement_account_id_fkey" FOREIGN KEY ("settlement_account_id") REFERENCES "dictionary_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_flow_entries" ADD CONSTRAINT "cash_flow_entries_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_lines" ADD CONSTRAINT "voucher_lines_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_lines" ADD CONSTRAINT "voucher_lines_cash_flow_entry_id_fkey" FOREIGN KEY ("cash_flow_entry_id") REFERENCES "cash_flow_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voucher_lines" ADD CONSTRAINT "voucher_lines_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_bom_id_fkey" FOREIGN KEY ("bom_id") REFERENCES "boms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_parent_production_order_id_fkey" FOREIGN KEY ("parent_production_order_id") REFERENCES "production_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_execution_location_id_fkey" FOREIGN KEY ("execution_location_id") REFERENCES "production_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_movements" ADD CONSTRAINT "raw_material_movements_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_movements" ADD CONSTRAINT "raw_material_movements_production_order_operation_id_fkey" FOREIGN KEY ("production_order_operation_id") REFERENCES "production_order_operations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_movement_lines" ADD CONSTRAINT "raw_material_movement_lines_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "raw_material_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_movement_lines" ADD CONSTRAINT "raw_material_movement_lines_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_movement_lines" ADD CONSTRAINT "raw_material_movement_lines_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_movement_lines" ADD CONSTRAINT "raw_material_movement_lines_source_issue_line_id_fkey" FOREIGN KEY ("source_issue_line_id") REFERENCES "raw_material_movement_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_movement_risks" ADD CONSTRAINT "raw_material_movement_risks_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "raw_material_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_movement_risks" ADD CONSTRAINT "raw_material_movement_risks_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "raw_material_movement_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order_operations" ADD CONSTRAINT "production_order_operations_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order_operations" ADD CONSTRAINT "production_order_operations_operation_catalog_id_fkey" FOREIGN KEY ("operation_catalog_id") REFERENCES "operation_catalogs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_order_operations" ADD CONSTRAINT "production_order_operations_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_catalogs" ADD CONSTRAINT "operation_catalogs_default_unit_id_fkey" FOREIGN KEY ("default_unit_id") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_rates" ADD CONSTRAINT "operation_rates_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_rates" ADD CONSTRAINT "operation_rates_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "operation_catalogs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_daily_reports" ADD CONSTRAINT "operation_daily_reports_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_daily_reports" ADD CONSTRAINT "operation_daily_reports_production_order_operation_id_fkey" FOREIGN KEY ("production_order_operation_id") REFERENCES "production_order_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_daily_reports" ADD CONSTRAINT "operation_daily_reports_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_daily_reports" ADD CONSTRAINT "employee_daily_reports_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_daily_reports" ADD CONSTRAINT "employee_daily_reports_production_order_operation_id_fkey" FOREIGN KEY ("production_order_operation_id") REFERENCES "production_order_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_daily_reports" ADD CONSTRAINT "employee_daily_reports_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_daily_alerts" ADD CONSTRAINT "production_daily_alerts_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_daily_alerts" ADD CONSTRAINT "production_daily_alerts_production_order_operation_id_fkey" FOREIGN KEY ("production_order_operation_id") REFERENCES "production_order_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_payroll_sources" ADD CONSTRAINT "production_payroll_sources_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_payroll_sources" ADD CONSTRAINT "production_payroll_sources_production_order_id_fkey" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_records" ADD CONSTRAINT "performance_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_ledgers" ADD CONSTRAINT "payroll_ledgers_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_payable_entries" ADD CONSTRAINT "payroll_payable_entries_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "payroll_ledgers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_payable_entries" ADD CONSTRAINT "payroll_payable_entries_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "payroll_ledgers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_payments" ADD CONSTRAINT "salary_payments_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_payments" ADD CONSTRAINT "salary_payments_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_payment_allocations" ADD CONSTRAINT "salary_payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "salary_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_payment_allocations" ADD CONSTRAINT "salary_payment_allocations_ledger_id_fkey" FOREIGN KEY ("ledger_id") REFERENCES "payroll_ledgers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_payment_allocations" ADD CONSTRAINT "salary_payment_allocations_payroll_payable_id_fkey" FOREIGN KEY ("payroll_payable_id") REFERENCES "payroll_payable_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_from_bank_id_fkey" FOREIGN KEY ("from_bank_id") REFERENCES "banks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_to_bank_id_fkey" FOREIGN KEY ("to_bank_id") REFERENCES "banks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_stocktake_id_fkey" FOREIGN KEY ("stocktake_id") REFERENCES "stocktakes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_slip_lines" ADD CONSTRAINT "finance_slip_lines_slip_id_fkey" FOREIGN KEY ("slip_id") REFERENCES "finance_slips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
node.exe : ┌─────────────────────────────────────────────────────────┐
At line:1 char:333
+ ... empty.sql"; & $node C:\Users\USER\Desktop\Dilee\node_modules\prisma\b ...
+                 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (┌──────────────...──────────────┐:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
│  Update available 6.19.3 -> 8.0.0-rc.22                 │
│                                                         │
│  This is a major update - please follow the guide at    │
│  https://pris.ly/d/major-version-upgrade                │
│                                                         │
│  Run the following to update                            │
│    npm i --save-dev prisma@latest                       │
│    npm i @prisma/client@latest                          │
└─────────────────────────────────────────────────────────┘


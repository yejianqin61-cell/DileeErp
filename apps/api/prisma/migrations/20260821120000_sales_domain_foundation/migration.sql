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
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "current_version" INTEGER NOT NULL DEFAULT 1,
    "extension_data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);
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
CREATE TABLE "boms" (
    "id" UUID NOT NULL,
    "order_no" VARCHAR(100) NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "sales_order_version_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(30) NOT NULL DEFAULT 'draft',
    "extension_data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" UUID,
    CONSTRAINT "boms_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "customers_customer_code_key" ON "customers"("customer_code");
CREATE UNIQUE INDEX "customers_name_key" ON "customers"("name");
CREATE UNIQUE INDEX "sales_orders_order_no_key" ON "sales_orders"("order_no");
CREATE UNIQUE INDEX "sales_order_versions_sales_order_id_version_key" ON "sales_order_versions"("sales_order_id", "version");
CREATE UNIQUE INDEX "boms_sales_order_id_version_key" ON "boms"("sales_order_id", "version");
CREATE INDEX "customer_contacts_customer_id_is_active_idx" ON "customer_contacts"("customer_id", "is_active");
CREATE INDEX "sales_orders_customer_id_status_idx" ON "sales_orders"("customer_id", "status");
CREATE INDEX "sales_orders_order_date_idx" ON "sales_orders"("order_date");
CREATE INDEX "boms_order_no_idx" ON "boms"("order_no");
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "customer_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_order_versions" ADD CONSTRAINT "sales_order_versions_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "boms" ADD CONSTRAINT "boms_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "boms" ADD CONSTRAINT "boms_sales_order_version_id_fkey" FOREIGN KEY ("sales_order_version_id") REFERENCES "sales_order_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

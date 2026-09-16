-- 工资付款的银行账户 + 原料出库的仓库确认（2026-09-16）。
--
-- 用户三条要求的前两条（设计见 docs/design/salary-bank-and-material-outbound-confirm-2026-09-16.md）：
--   1) 「工资支付那边也是全部要加上银行账户，因为发工资都是要用银行账户发放的工资」
--      → salary_payments.bank_id：工资付款也落到具体账户上，过账写流水时带上它，
--        这笔支出才会真的动银行余额（此前工资付款写的流水 bank_id 为空，银行余额恒定少一笔工资）。
--   2) 「生产领料单已确认，仓库那边不能直接原料出库，要有一个待确认的地方，确认过后才能原料出库」
--      → raw_material_movements.submitted_at：生产「确认提交」到仓库的时刻。
--        单据状态新增 pending_outbound（待仓库出库），**不需要改库结构**（status 是 VARCHAR(30)，
--        且这张表没有 status 的 CHECK 约束，见 20260822113000_raw_material_issue_movements）。
--        submitted_at 单独一列而不是复用 updated_at：updated_at 会被任何一次写入改动，
--        而「待出库通知」要显示的是这张单什么时候交过来的，两次提交之间不能漂移。
--
-- 核对方式：npx prisma migrate diff --from-empty --to-schema-datamodel apps/api/prisma/schema.prisma --script

-- AlterTable：工资付款的发放账户（可空列，仅为兼容升级前的历史单据；新建由服务层强制要求）
ALTER TABLE "salary_payments" ADD COLUMN "bank_id" UUID;

-- AlterTable：生产确认提交到仓库的时刻
ALTER TABLE "raw_material_movements" ADD COLUMN "submitted_at" TIMESTAMP(3);

-- AddForeignKey：可空关联 → Prisma 期望 ON DELETE SET NULL。
-- 写成 RESTRICT 会让 `migrate status` 认为库与 schema 有漂移（银行账户只软删除，不会真删）。
ALTER TABLE "salary_payments" ADD CONSTRAINT "salary_payments_bank_id_fkey" FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex：仓库的「待出库通知」按 (status, submitted_at) 查最新待出库单据，
-- 缺这条索引会让每次打开仓库页都全表扫原料流转单据。
CREATE INDEX "raw_material_movements_status_submitted_at_idx" ON "raw_material_movements"("status", "submitted_at");

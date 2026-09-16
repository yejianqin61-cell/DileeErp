-- 凭证的「银行存款」科目引用具体银行账户（用户要求：「凭证中的那个会计科目的银行存款，
-- 要引用的是具体的银行账户」）。
--
-- 为什么单独一列而不是把账户名拼进 subject_label 就算完：
--   拼字符串只能看，不能查。有了 bank_id 才能出「银行存款—某账户」的明细账、才能拿它与银行对账单
--   逐笔核对，也才能在账户改名/停用后仍然追得到是哪张卡。subject_label 同时带上账户名快照，
--   是为了让打印出来的纸质凭证自己就能说明是哪本账（历史凭证不会因为账户改名而变样）。
--
-- 可空 + ON DELETE SET NULL：库存现金分录、以及财务手工改成非资金类科目的分录本来就没有银行账户；
-- 账户被软删除（banks.deleted_at）后凭证仍要能打开，所以不设 NOT NULL、不用 RESTRICT。
ALTER TABLE "voucher_lines" ADD COLUMN "bank_id" UUID;

ALTER TABLE "voucher_lines"
  ADD CONSTRAINT "voucher_lines_bank_id_fkey"
  FOREIGN KEY ("bank_id") REFERENCES "banks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 按账户查凭证分录（银行存款明细账）走这条索引。
CREATE INDEX "voucher_lines_bank_id_idx" ON "voucher_lines"("bank_id");

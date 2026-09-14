-- 收支管理：收支项目 / 结算账户 两个可配置字典 + 收支流水表。
--
-- 需求来源：`example/财务/收支明细表.xls`、`收支汇总表.xls`（老系统导出的资金流水与项目汇总）。
-- 用户 R6 选定：**新建独立「收支管理」板块 —— 手工录入资金流水 + 可配置项目字典**。
--
-- 字典部分是幂等的（可安全重跑）：
--   1. 建立 dictionary_types.key = 'cash_flow_item' / 'settlement_account'；
--   2. 写入老表里的 37 个收支项目与 2 个银行账户（标签按老表原文照抄，见 cash-flow-catalog.ts）。
-- 没有用户（全新空库）时字典部分直接返回，由 `prisma/seed.ts` 负责初始化（与币种字典同一约定）。
-- 建表语句是普通 DDL，由 Prisma 按目录名顺序各执行一次（与既有迁移一致）。

DO $$
DECLARE
  actor_id uuid;
  items_type_id uuid;
  accounts_type_id uuid;
BEGIN
  SELECT "id" INTO actor_id FROM "users" ORDER BY "created_at" LIMIT 1;
  IF actor_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO "dictionary_types" ("id", "key", "name", "updated_at", "created_by", "updated_by")
  VALUES
    (gen_random_uuid(), 'cash_flow_item', '收支项目', CURRENT_TIMESTAMP, actor_id, actor_id),
    (gen_random_uuid(), 'settlement_account', '结算账户', CURRENT_TIMESTAMP, actor_id, actor_id)
  ON CONFLICT ("key") DO NOTHING;

  SELECT "id" INTO items_type_id FROM "dictionary_types" WHERE "key" = 'cash_flow_item' AND "deleted_at" IS NULL;
  SELECT "id" INTO accounts_type_id FROM "dictionary_types" WHERE "key" = 'settlement_account' AND "deleted_at" IS NULL;

  IF items_type_id IS NOT NULL THEN
    INSERT INTO "dictionary_items" ("id", "type_id", "key", "label", "sort_order", "is_active", "updated_at", "created_by", "updated_by")
    SELECT gen_random_uuid(), items_type_id, item.key, item.label, item.sort_order, true, CURRENT_TIMESTAMP, actor_id, actor_id
    FROM (VALUES
      ('备用金', '备用金', 10),
      ('货款', '货款', 20),
      ('美金转入', '美金转入', 30),
      ('原材料 成本', '原材料 成本', 40),
      ('外加工费 晋江大田工资', '外加工费 晋江大田工资', 50),
      ('成品外加工费', '成品外加工费', 60),
      ('房租支出', '房租支出', 70),
      ('会展费用', '会展费用', 80),
      ('销售费用', '销售费用', 90),
      ('货代费', '货代费', 100),
      ('水电费', '水电费', 110),
      ('国际快递费', '国际快递费', 120),
      ('机器折旧费用', '机器折旧费用', 130),
      ('辅料费', '辅料费', 140),
      ('制造费用-货拉拉', '制造费用-货拉拉', 150),
      ('制造费用-物流', '制造费用-物流', 160),
      ('销售费用-货拉拉', '销售费用-货拉拉', 170),
      ('生产用品、工具费用', '生产用品、工具费用', 180),
      ('管理费用', '管理费用', 190),
      ('销售样品费', '销售样品费', 200),
      ('销售知识产权费用', '销售知识产权费用', 210),
      ('顺丰快递费', '顺丰快递费', 220),
      ('办公费用', '办公费用', 230),
      ('差旅费', '差旅费', 240),
      ('验厂费', '验厂费', 250),
      ('杂费车间装修费', '杂费车间装修费', 260),
      ('财务费用-手续费', '财务费用-手续费', 270),
      ('财务费用-外账', '财务费用-外账', 280),
      ('银行费用利息', '银行费用利息', 290),
      ('电商费用', '电商费用', 300),
      ('机械维修费', '机械维修费', 310),
      ('员工福利费', '员工福利费', 320),
      ('员工餐费', '员工餐费', 330),
      ('国家退税', '国家退税', 340),
      ('人 工费', '人 工费', 350),
      ('加工费', '加工费', 360),
      ('中国银行 美元', '中国银行 美元', 370)
    ) AS item(key, label, sort_order)
    ON CONFLICT ("type_id", "key") DO NOTHING;
  END IF;

  IF accounts_type_id IS NOT NULL THEN
    INSERT INTO "dictionary_items" ("id", "type_id", "key", "label", "sort_order", "is_active", "updated_at", "created_by", "updated_by")
    SELECT gen_random_uuid(), accounts_type_id, item.key, item.label, item.sort_order, true, CURRENT_TIMESTAMP, actor_id, actor_id
    FROM (VALUES
      ('农业银行5706', '农业银行5706', 10),
      ('中国银行（美元）7624', '中国银行（美元）7624', 20)
    ) AS item(key, label, sort_order)
    ON CONFLICT ("type_id", "key") DO NOTHING;
  END IF;
END $$;

-- 收支流水（手工录入）。
--
-- 两个刻意的建模选择：
--   1. 金额恒为正数，收/支由 `direction` 决定 —— 老表的「收入 / 支出」两列是**报表版式**，
--      不是存储形态；存成有符号金额则「支出被填成负数」这类错误在库层无法拦住。
--   2. `source_type` / `source_id` 本期恒空，是为将来与收付款单联动预留（R6 选的是手工录入）。
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
  "item_id" UUID NOT NULL,
  "settlement_method" VARCHAR(50),
  "settlement_account_id" UUID,
  "source_type" VARCHAR(40),
  "source_id" UUID,
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
CREATE UNIQUE INDEX "cash_flow_entries_entry_no_key" ON "cash_flow_entries"("entry_no");
CREATE INDEX "cash_flow_entries_entry_date_currency_idx" ON "cash_flow_entries"("entry_date", "currency");
CREATE INDEX "cash_flow_entries_item_id_direction_idx" ON "cash_flow_entries"("item_id", "direction");
CREATE INDEX "cash_flow_entries_currency_status_idx" ON "cash_flow_entries"("currency", "status");
ALTER TABLE "cash_flow_entries" ADD CONSTRAINT "cash_flow_entries_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "dictionary_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- settlement_account_id 是可空关联（流水可以不选账户）→ 用 SET NULL，
-- 与 item_id 的 RESTRICT 不同。这里不是照抄上一行：Prisma 对可选关联生成的就是 SET NULL，
-- 写错会让 `migrate status` 认为库与 schema 有漂移（用 `prisma migrate diff` 逐列比对过）。
ALTER TABLE "cash_flow_entries" ADD CONSTRAINT "cash_flow_entries_settlement_account_id_fkey" FOREIGN KEY ("settlement_account_id") REFERENCES "dictionary_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 库层边界检查：即使有写入绕过 HTTP 服务，也不允许出现「方向不明 / 金额为零或负」的流水
-- （与 materials_material_type_check 等既有约束同一做法）。
ALTER TABLE "cash_flow_entries" ADD CONSTRAINT "cash_flow_entries_direction_check" CHECK ("direction" IN ('income', 'expense'));
ALTER TABLE "cash_flow_entries" ADD CONSTRAINT "cash_flow_entries_amount_positive_check" CHECK ("amount" > 0);
ALTER TABLE "cash_flow_entries" ADD CONSTRAINT "cash_flow_entries_status_check" CHECK ("status" IN ('posted', 'reversed'));

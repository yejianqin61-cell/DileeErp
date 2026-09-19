-- 会计科目（全站财务口径的唯一来源）：科目表 + 旧「收支项目」并入。
--
-- 需求来源：用户 2026-09-17 交付 `example/财务/科目表(2).xls`，口径原文
--   「那个编码的可以不管，分类就对应的是科目类别，项目就对应的是科目名称」，
-- 并选定「**彻底合并**：37 个旧项目并入 121 条科目，历史数据改指」，
-- 以及「收支项目维护和会计科目要合并成会计科目！合并成一个」。
-- 完整的 37→121 对照表见 docs/design/accounting-subject-chart-2026-09-17.md
-- 与 docs/memo/0917-收支项目并入会计科目对照表.md。
--
-- 本迁移做四件事：
--   1) 建 accounting_subjects（两级：分类 category + 项目 name；老表科目代码整列不采纳）；
--   2) 种入科目表 121 条。其中 32 条**沿用旧收支项目字典项的 id**（当该科目只对应一个旧项目时），
--      这样 5 张表里已有的 `item_id` / `cash_flow_item_id` 大部分**一个字节都不用改**：
--      历史流水的分类归属靠主键天然延续，改的只是它现在指向哪张表、显示成什么名字；
--      余下 5 条属于「两条旧项目并到同一科目」（如 `制造费用-货拉拉` 与 `制造费用-物流` → `货拉拉 物流费`），
--      科目只能沿用一个 id，另一条的历史引用由下面的「改指」补齐；
--   3) 旧 `cash_flow_item` 字典整体停用（软删，保留成历史快照，不物理删除）；
--   4) 5 张表的外键从 dictionary_items 换到 accounting_subjects，列名 item_id/cash_flow_item_id → subject_id。
--
-- 为什么尽量「沿用旧 id」而不是全量 UPDATE 改指：改指要按 5 张表各写一遍映射，
-- 任何一处写漏就是某类流水静默换了科目。沿用 id 让数据库自己保证一致性。
-- 合并组那几行必须改指（否则外键切换直接失败），所以改指逻辑是通用的、按临时映射表跑的，不漏表。
--
-- 空库（无 users）时科目种入与字典停用整段返回，由 `prisma/seed.ts` 负责初始化
-- —— 与币种字典、收支项目字典当年的约定一致。建表与外键切换是普通 DDL，照常执行。

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
CREATE UNIQUE INDEX "accounting_subjects_category_name_key" ON "accounting_subjects"("category", "name");
CREATE INDEX "accounting_subjects_category_sort_order_idx" ON "accounting_subjects"("category", "sort_order");

-- 旧收支项目 → 科目 的归属表。放进临时表而不是在 SQL 里抄三遍：
-- 37 行抄三遍，迟早有一遍改漏，而迁移守卫测试只盯得住常量文件、盯不住 SQL 里的重复块。
-- 不筛 deleted_at：已停用的旧字典项也可能被历史流水引用（外键不看 deleted_at），漏掉就是外键切换失败。
CREATE TEMP TABLE "_legacy_cash_flow_item_map" ("legacy_key" text PRIMARY KEY, "category" text NOT NULL, "name" text NOT NULL);
INSERT INTO "_legacy_cash_flow_item_map" ("legacy_key", "category", "name") VALUES
      ('备用金', '资产类', '库存现金（备用金）'),
      ('货款', '损益类', '主营业务收入'),
      ('美金转入', '资产类', '银行存款 中国银行（美元）'),
      ('原材料 成本', '损益类', '主营业务成本'),
      ('外加工费 晋江大田工资', '成本类', '临时工资'),
      ('成品外加工费', '成本类', '加工费'),
      ('房租支出', '成本类', '房租费'),
      ('会展费用', '损益类', '销售费 参展费'),
      ('销售费用', '损益类', '销售费用'),
      ('货代费', '损益类', '销售费 港杂费'),
      ('水电费', '成本类', '水电费'),
      ('国际快递费', '损益类', '销售费 国际快递费'),
      ('机器折旧费用', '资产类', '累计折旧'),
      ('辅料费', '成本类', '生产用品'),
      ('制造费用-货拉拉', '成本类', '货拉拉 物流费'),
      ('制造费用-物流', '成本类', '货拉拉 物流费'),
      ('销售费用-货拉拉', '损益类', '销售费 运费'),
      ('生产用品、工具费用', '成本类', '生产用品'),
      ('管理费用', '损益类', '管理费用'),
      ('销售样品费', '损益类', '销售费 样品费'),
      ('销售知识产权费用', '损益类', '销售费 专利费'),
      ('顺丰快递费', '成本类', '顺丰快递'),
      ('办公费用', '损益类', '管理费 办公用品'),
      ('差旅费', '损益类', '管理费 差旅费'),
      ('验厂费', '损益类', '管理 验厂费'),
      ('杂费车间装修费', '损益类', '管理费厂房装修费用'),
      ('财务费用-手续费', '损益类', '银行手续费'),
      ('财务费用-外账', '损益类', '外账财务费'),
      ('银行费用利息', '损益类', '银行手续费'),
      ('电商费用', '损益类', '销售费 推广费'),
      ('机械维修费', '成本类', '机台维修费'),
      ('员工福利费', '损益类', '管理费 福利费'),
      ('员工餐费', '损益类', '管理费 福利员工餐费'),
      ('国家退税', '损益类', '营业外收入'),
      ('人 工费', '成本类', '基本生产成本'),
      ('加工费', '成本类', '加工费'),
      ('中国银行 美元', '资产类', '银行存款 中国银行（美元）');

-- 先摘掉 5 张表的旧外键，再进 DO 块做「改指」。
--
-- 为什么必须这个顺序：下面 DO 块里的 UPDATE 会把历史引用改成**新建的科目 id**
-- （合并组那几条旧项目没有沿用到 id，只能给新 uuid），而此刻列还指着 dictionary_items ——
-- 带着旧外键往字典表里写科目 id，必然违约。实测报错：
--   insert or update on table "cash_flow_entries" violates foreign key constraint
--   "cash_flow_entries_item_id_fkey"
--   DETAIL: Key (item_id)=(0eb569dd-...) is not present in table "dictionary_items".
-- 所以拆成「摘外键 → 改指 → 重命名 → 挂新外键（指向 accounting_subjects）」四步；
-- 文件末尾原本的 DROP CONSTRAINT 已合并到这里，不要重复摘（重复摘会报 constraint does not exist）。
ALTER TABLE "cash_flow_entries" DROP CONSTRAINT "cash_flow_entries_item_id_fkey";
ALTER TABLE "customer_payments" DROP CONSTRAINT "customer_payments_cash_flow_item_id_fkey";
ALTER TABLE "supplier_payments" DROP CONSTRAINT "supplier_payments_cash_flow_item_id_fkey";
ALTER TABLE "receivable_reconciliations" DROP CONSTRAINT "receivable_reconciliations_cash_flow_item_id_fkey";
ALTER TABLE "supplier_payable_reconciliations" DROP CONSTRAINT "supplier_payable_reconciliations_cash_flow_item_id_fkey";

DO $$
DECLARE
  actor_id uuid;
  legacy_type_id uuid;
BEGIN
  SELECT "id" INTO actor_id FROM "users" ORDER BY "created_at" LIMIT 1;
  IF actor_id IS NULL THEN
    RETURN;
  END IF;

  SELECT "id" INTO legacy_type_id FROM "dictionary_types" WHERE "key" = 'cash_flow_item' AND "deleted_at" IS NULL;

  -- 科目表 121 条。命中「一对一」映射的科目沿用旧字典项 id（见文件头第 2 点）；
  -- 一对多的组（n > 1）不给 id，用新 uuid，历史引用交给下面的改指逻辑。
  INSERT INTO "accounting_subjects" ("id", "category", "name", "balance_direction", "sort_order", "is_active", "updated_at", "created_by", "updated_by")
  SELECT COALESCE(mapped.legacy_id, gen_random_uuid()), m.category, m.name, m.direction, m.sort_order, true, CURRENT_TIMESTAMP, actor_id, actor_id
  FROM (VALUES
      ('资产类', '库存现金（备用金）', '借', 10),
      ('资产类', '银行存款', '借', 20),
      ('资产类', '银行存款 中国银行（人民币）', '借', 30),
      ('资产类', '银行存款 中国银行（美元）', '借', 40),
      ('资产类', '银行存款 农业银行', '借', 50),
      ('资产类', '银行存款 阿里账户（美元）', '借', 60),
      ('资产类', '银行存款 刘总转入', '借', 70),
      ('资产类', '其他货币资金', '借', 80),
      ('资产类', '短期投资', '借', 90),
      ('资产类', '应收票据', '借', 100),
      ('资产类', '应收账款', '借', 110),
      ('资产类', '预付账款', '借', 120),
      ('资产类', '应收股利', '借', 130),
      ('资产类', '应收利息', '借', 140),
      ('资产类', '其他应收款', '借', 150),
      ('资产类', '材料采购', '借', 160),
      ('资产类', '在途物资', '借', 170),
      ('资产类', '原材料', '借', 180),
      ('资产类', '材料成本差异', '借', 190),
      ('资产类', '库存商品', '借', 200),
      ('资产类', '发出商品', '借', 210),
      ('资产类', '商品进销差价', '借', 220),
      ('资产类', '委托加工物资', '借', 230),
      ('资产类', '半成品', '借', 240),
      ('资产类', '周转材料', '借', 250),
      ('资产类', '消耗性生物资产', '借', 260),
      ('资产类', '长期债券投资', '借', 270),
      ('资产类', '长期股权投资', '借', 280),
      ('资产类', '固定资产', '借', 290),
      ('资产类', '累计折旧', '借', 300),
      ('资产类', '在建工程', '借', 310),
      ('资产类', '工程物资', '借', 320),
      ('资产类', '固定资产清理', '借', 330),
      ('资产类', '生产性生物资产', '借', 340),
      ('资产类', '生产性生物资产累计折旧', '借', 350),
      ('资产类', '无形资产', '借', 360),
      ('资产类', '累计摊销', '借', 370),
      ('资产类', '长期待摊费用', '借', 380),
      ('资产类', '待处理财产损益', '借', 390),
      ('负债类', '短期借款', '贷', 400),
      ('负债类', '应付票据', '贷', 410),
      ('负债类', '应付账款', '贷', 420),
      ('负债类', '预收账款', '贷', 430),
      ('负债类', '应付职工薪酬', '贷', 440),
      ('负债类', '应交税费', '贷', 450),
      ('负债类', '应付利息', '贷', 460),
      ('负债类', '应付利润', '贷', 470),
      ('负债类', '其他应付款', '贷', 480),
      ('负债类', '递延收益', '贷', 490),
      ('负债类', '长期借款', '贷', 500),
      ('负债类', '长期应付款', '贷', 510),
      ('负债类', '应交税费-进项税', '借', 520),
      ('负债类', '应交税费-进项税--祥恩线业', '借', 530),
      ('负债类', '应交税费-销项税', '借', 540),
      ('成本类', '生产成本', '借', 550),
      ('成本类', '劳务成本', '借', 560),
      ('成本类', '制造费用', '借', 570),
      ('成本类', '研发支出', '借', 580),
      ('成本类', '工程施工', '借', 590),
      ('成本类', '机械作业', '借', 600),
      ('成本类', '临时工资', '借', 610),
      ('成本类', '加工费', '借', 620),
      ('成本类', '水电费', '借', 630),
      ('成本类', '房租费', '借', 640),
      ('成本类', '生产用品', '借', 650),
      ('成本类', '机台维修费', '借', 660),
      ('成本类', '顺丰快递', '借', 670),
      ('成本类', '基本生产成本', '借', 680),
      ('成本类', '辅助生产成本', '借', 690),
      ('成本类', '货拉拉 物流费', '借', 700),
      ('成本类', '印刷费', '借', 710),
      ('所有者权益类', '实收资本', '贷', 720),
      ('所有者权益类', '资本公积', '贷', 730),
      ('所有者权益类', '盈余公积', '贷', 740),
      ('所有者权益类', '本年利润', '贷', 750),
      ('所有者权益类', '利润分配', '贷', 760),
      ('损益类', '主营业务收入', '借', 770),
      ('损益类', '其他业务收入', '借', 780),
      ('损益类', '投资收益', '借', 790),
      ('损益类', '营业外收入', '借', 800),
      ('损益类', '主营业务成本', '借', 810),
      ('损益类', '其他业务成本', '借', 820),
      ('损益类', '营业税金及附加', '借', 830),
      ('损益类', '销售费用', '借', 840),
      ('损益类', '销售费 运费', '借', 850),
      ('损益类', '销售费 推广费', '借', 860),
      ('损益类', '销售费 港杂费', '借', 870),
      ('损益类', '销售费 手续费', '借', 880),
      ('损益类', '销售费 样品费', '借', 890),
      ('损益类', '销售费 测试费用', '借', 900),
      ('损益类', '销售费 招待费', '借', 910),
      ('损益类', '销售费 参展费', '借', 920),
      ('损益类', '销售费 打车费', '借', 930),
      ('损益类', '销售费 差旅费', '借', 940),
      ('损益类', '销售费 礼品费', '借', 950),
      ('损益类', '销售- 办产地证', '借', 960),
      ('损益类', '销售费 专利费', '借', 970),
      ('损益类', '销售费 快递费', '借', 980),
      ('损益类', '销售费 国际快递费', '借', 990),
      ('损益类', '销售-装柜费', '借', 1000),
      ('损益类', '销售 -业务提成', '借', 1010),
      ('损益类', '销售 潘通色卡', '借', 1020),
      ('损益类', '管理费用', '借', 1030),
      ('损益类', '其他管理费用', '借', 1040),
      ('损益类', '管理费 办公用品', '借', 1050),
      ('损益类', '管理费 差旅费', '借', 1060),
      ('损益类', '管理费 质量问题', '借', 1070),
      ('损益类', '管理费 福利费', '借', 1080),
      ('损益类', '管理费 福利员工餐费', '借', 1090),
      ('损益类', '管理费厂房装修费用', '借', 1100),
      ('损益类', '管理费 培训费', '借', 1110),
      ('损益类', '管理费 福利费-保险费', '借', 1120),
      ('损益类', '管理 验厂费', '借', 1130),
      ('损益类', '管理 差旅', '借', 1140),
      ('损益类', '管理 车维修费', '借', 1150),
      ('损益类', '管理 -财产保险', '借', 1160),
      ('损益类', '财务费用', '借', 1170),
      ('损益类', '外账财务费', '借', 1180),
      ('损益类', '银行手续费', '借', 1190),
      ('损益类', '营业外支出', '借', 1200),
      ('损益类', '所得税费用', '借', 1210)
  ) AS m(category, name, direction, sort_order)
  LEFT JOIN (
    SELECT lm.category, lm.name, (array_agg(d."id"))[1] AS legacy_id, count(*) AS n
    FROM "_legacy_cash_flow_item_map" lm
    JOIN "dictionary_items" d ON d."key" = lm.legacy_key AND d."type_id" = legacy_type_id
    GROUP BY lm.category, lm.name
  ) AS mapped ON mapped.category = m.category AND mapped.name = m.name AND mapped.n = 1
  ON CONFLICT ("category", "name") DO NOTHING;

  -- 兜底：字典里存在、但不在 37 条对照表内的自定义收支项目（财务在界面上自己加过的那种）
  -- 不能因为「没写进对照表」就把已经记过账的分类丢掉。它们以原 id、原名字并入「未分类」，
  -- 由财务在「会计科目」页上重新归类。从未自定义过时这一句不插入任何行。
  INSERT INTO "accounting_subjects" ("id", "category", "name", "balance_direction", "sort_order", "is_active", "updated_at", "created_by", "updated_by")
  SELECT d."id", '未分类', d."label", NULL, 9000 + d."sort_order", true, CURRENT_TIMESTAMP, actor_id, actor_id
  FROM "dictionary_items" d
  WHERE d."type_id" = legacy_type_id
    AND NOT EXISTS (SELECT 1 FROM "_legacy_cash_flow_item_map" lm WHERE lm."legacy_key" = d."key")
  ON CONFLICT ("category", "name") DO NOTHING;

  -- 改指前的自检：每个旧字典项都必须有落点，否则外键切换会失败，
  -- 而外键报错只说「有行违反约束」，不会说是哪一条。
  IF legacy_type_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM "dictionary_items" d
    WHERE d."type_id" = legacy_type_id
      AND NOT EXISTS (
        SELECT 1 FROM "_legacy_cash_flow_item_map" lm
        JOIN "accounting_subjects" s ON s."category" = lm."category" AND s."name" = lm."name"
        WHERE lm."legacy_key" = d."key"
      )
      AND NOT EXISTS (SELECT 1 FROM "accounting_subjects" s2 WHERE s2."id" = d."id")
  ) THEN
    RAISE EXCEPTION '收支项目字典里存在无法并入会计科目的项：既不在对照表内，也没能作为「未分类」科目落库（多半是与已有科目同名）。请先在界面上改名后重跑迁移';
  END IF;

  -- 改指：合并组里没沿用到 id 的那条旧项目，其历史引用要改指到科目 id。
  -- 五张表逐一处理（列名此刻还是旧名，重命名在下面的 DDL 里做）。
  -- 只改真正需要改的行（subject 不同），并记下 updated_at/updated_by —— 这些行确实被这次合并改动过，
  -- 谎称「最后修改人还是当初录单的人」比改掉它更糟；原因与前后值另有审计事件留底。
  UPDATE "cash_flow_entries" e
  SET "item_id" = s."id", "updated_at" = CURRENT_TIMESTAMP, "updated_by" = actor_id
  FROM "_legacy_cash_flow_item_map" lm
  JOIN "dictionary_items" d ON d."key" = lm."legacy_key" AND d."type_id" = legacy_type_id
  JOIN "accounting_subjects" s ON s."category" = lm."category" AND s."name" = lm."name"
  WHERE e."item_id" = d."id" AND e."item_id" <> s."id";

  UPDATE "customer_payments" p
  SET "cash_flow_item_id" = s."id", "updated_at" = CURRENT_TIMESTAMP, "updated_by" = actor_id
  FROM "_legacy_cash_flow_item_map" lm
  JOIN "dictionary_items" d ON d."key" = lm."legacy_key" AND d."type_id" = legacy_type_id
  JOIN "accounting_subjects" s ON s."category" = lm."category" AND s."name" = lm."name"
  WHERE p."cash_flow_item_id" = d."id" AND p."cash_flow_item_id" <> s."id";

  UPDATE "supplier_payments" p
  SET "cash_flow_item_id" = s."id", "updated_at" = CURRENT_TIMESTAMP, "updated_by" = actor_id
  FROM "_legacy_cash_flow_item_map" lm
  JOIN "dictionary_items" d ON d."key" = lm."legacy_key" AND d."type_id" = legacy_type_id
  JOIN "accounting_subjects" s ON s."category" = lm."category" AND s."name" = lm."name"
  WHERE p."cash_flow_item_id" = d."id" AND p."cash_flow_item_id" <> s."id";

  UPDATE "receivable_reconciliations" r
  SET "cash_flow_item_id" = s."id", "updated_at" = CURRENT_TIMESTAMP, "updated_by" = actor_id
  FROM "_legacy_cash_flow_item_map" lm
  JOIN "dictionary_items" d ON d."key" = lm."legacy_key" AND d."type_id" = legacy_type_id
  JOIN "accounting_subjects" s ON s."category" = lm."category" AND s."name" = lm."name"
  WHERE r."cash_flow_item_id" = d."id" AND r."cash_flow_item_id" <> s."id";

  UPDATE "supplier_payable_reconciliations" r
  SET "cash_flow_item_id" = s."id", "updated_at" = CURRENT_TIMESTAMP, "updated_by" = actor_id
  FROM "_legacy_cash_flow_item_map" lm
  JOIN "dictionary_items" d ON d."key" = lm."legacy_key" AND d."type_id" = legacy_type_id
  JOIN "accounting_subjects" s ON s."category" = lm."category" AND s."name" = lm."name"
  WHERE r."cash_flow_item_id" = d."id" AND r."cash_flow_item_id" <> s."id";

  IF legacy_type_id IS NOT NULL THEN
    -- 落库记录：旧项目 → 科目 的对照表整体写进审计事件（操作人、时间、原因与前后值都在），
    -- 满足宪法《Reversible Business Changes》「保留原始事实、操作人、时间、原因与前后值」。
    INSERT INTO "audit_events" ("id", "action", "entity_type", "actor_id", "details")
    VALUES (
      gen_random_uuid(),
      'accounting_subject.merge_legacy_cash_flow_items',
      'accounting_subject',
      actor_id,
      jsonb_build_object(
        'reason', '用户 2026-09-17 选定：收支项目维护与会计科目合并成一个，37 个旧项目并入科目表 121 条',
        'source', 'example/财务/科目表(2).xls',
        'mapping', (SELECT jsonb_agg(jsonb_build_object('legacy_key', lm.legacy_key, 'category', lm.category, 'name', lm.name) ORDER BY lm.legacy_key) FROM "_legacy_cash_flow_item_map" lm)
      )
    );

    -- 旧字典整体停用（软删）：科目已经接管口径，留着可用的旧字典只会让人在两张表之间选错。
    UPDATE "dictionary_items"
    SET "deleted_at" = CURRENT_TIMESTAMP, "deleted_by" = actor_id, "updated_by" = actor_id, "updated_at" = CURRENT_TIMESTAMP
    WHERE "type_id" = legacy_type_id AND "deleted_at" IS NULL;
  END IF;

  UPDATE "dictionary_types"
  SET "deleted_at" = CURRENT_TIMESTAMP, "deleted_by" = actor_id, "updated_by" = actor_id, "updated_at" = CURRENT_TIMESTAMP
  WHERE "key" = 'cash_flow_item' AND "deleted_at" IS NULL;
END $$;

DROP TABLE IF EXISTS "_legacy_cash_flow_item_map";

-- 外键切换：dictionary_items → accounting_subjects，列名一并改成 subject_id
-- （列名留着 item_id 会让「这是收支项目」的旧口径在代码里阴魂不散，而它现在是会计科目）。
-- 旧外键在文件上方（DO 块之前）已经摘掉，这里只做重命名 + 挂新外键。
ALTER TABLE "cash_flow_entries" RENAME COLUMN "item_id" TO "subject_id";
DROP INDEX "cash_flow_entries_item_id_direction_idx";
CREATE INDEX "cash_flow_entries_subject_id_direction_idx" ON "cash_flow_entries"("subject_id", "direction");
ALTER TABLE "cash_flow_entries" ADD CONSTRAINT "cash_flow_entries_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "customer_payments" RENAME COLUMN "cash_flow_item_id" TO "subject_id";
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "supplier_payments" RENAME COLUMN "cash_flow_item_id" TO "subject_id";
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "receivable_reconciliations" RENAME COLUMN "cash_flow_item_id" TO "subject_id";
ALTER TABLE "receivable_reconciliations" ADD CONSTRAINT "receivable_reconciliations_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "supplier_payable_reconciliations" RENAME COLUMN "cash_flow_item_id" TO "subject_id";
ALTER TABLE "supplier_payable_reconciliations" ADD CONSTRAINT "supplier_payable_reconciliations_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "accounting_subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
